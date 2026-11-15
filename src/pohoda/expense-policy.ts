/**
 * Shared normalization and validation for summary-only expense documents:
 * received invoices, other liabilities (commitment, including card purchases) and
 * cash voucher expenses. Everything here runs before any XML transport.
 */
import { formatMinorUnits, fromMinorUnits, isMoneyInput, MoneyError, toMinorUnits, vatBuckets } from "./money.js";
import { normalizeDic } from "../registry/czech-registry.js";

export type ExpenseKind = "invoice" | "voucher";
export type TaxMode = "taxable" | "nonTax";

export class ExpensePolicyError extends Error {
  public readonly code: string;
  public readonly needsReview: boolean;
  public readonly field: string | undefined;
  /** Structured values for localized messages (amounts are formatted strings). */
  public readonly params: Record<string, string>;

  public constructor(code: string, message: string, options: { needsReview?: boolean; field?: string; params?: Record<string, string> } = {}) {
    super(`${code}: ${message}`);
    this.name = "ExpensePolicyError";
    this.code = code;
    this.needsReview = options.needsReview ?? false;
    this.field = options.field;
    this.params = options.params ?? {};
  }
}

/** Machine-readable policy warning; `warnings` keeps the English text for logs and tools. */
export type ExpensePolicyNotice = { code: string; params: Record<string, string> };

/**
 * Collects review-level failures instead of throwing, so a review preview can still show
 * every field the policy can determine (see projectExpensePolicy). An unknown tax mode,
 * an invalid date or amount only makes the values that depend on it unknown. Structural
 * failures (VAT period, items, card numbering) always throw.
 */
type Collector = ExpensePolicyError[] | undefined;

/** Threshold in minor units: originalDocument rules apply only ABOVE 10 000 CZK. */
export const ORIGINAL_DOCUMENT_THRESHOLD_MINOR = 1_000_000;
export const EXPENSE_INVOICE_TYPES = ["receivedInvoice", "commitment"] as const;
export const SOURCE_NOTE_PREFIX = "Zdroj:";

const NON_TAX_CLASSIFICATION = "PN";
export const MAX_TEXT_LENGTH = 240;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CONFLICTING_CARD_PAYMENT_TYPES = ["cash", "draft", "compensation"];
const HOME_CURRENCY = "CZK";

/**
 * Client convention: an ordinary domestic taxable expense uses Členění DPH PD. PDzjed is a
 * known alias of it here; other codes (reverse charge, custom codes) are never rewritten.
 */
const DOMESTIC_TAXABLE_CLASSIFICATION_ALIASES: Readonly<Record<string, string>> = { pdzjed: "PD" };

/**
 * Fuel texts and their canonical POHODA text, classified from the fuel printed on the
 * receipt (never from the supplier name). A bare "PHM" or an unknown text stays as given.
 */
export const FUEL_TEXT_NAFTA = "PHM nafta";
export const FUEL_TEXT_BENZIN = "PHM benzín";
const FUEL_TEXT_ALIASES: ReadonlyMap<string, string> = new Map([
  ...["nafta", "diesel", "motorova nafta", "nafta motorova", "phm nafta", "phm diesel", "nafta phm", "diesel phm",
    "pohonne hmoty nafta", "pohonne hmoty diesel"].map((key) => [key, FUEL_TEXT_NAFTA] as const),
  ...["benzin", "natural", "natural 95", "natural 98", "natural95", "natural98", "ba 95", "ba 98", "phm benzin",
    "phm natural", "phm natural 95", "phm natural 98", "benzin natural 95", "benzin natural 98", "pohonne hmoty benzin"].map((key) => [key, FUEL_TEXT_BENZIN] as const)
]);
/**
 * Separators of a mixed description ("Natural 95 + olej", "Nafta, kapalina do ostřikovačů",
 * "Diesel a AdBlue"). Only whole components are compared; "/" and "-" are not separators.
 */
const TEXT_COMPONENT_SEPARATOR = /(\s*[+,;&]\s*|\s+a\s+)/i;

const foldText = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[\s_\-\u2013\u2014:,]+/g, " ").replace(/[.\s]+$/, "").trim();

/**
 * Canonical expense header text: an unambiguous fuel text (Diesel, Nafta, Natural 95,
 * Benzín, ...) becomes exactly "PHM nafta" / "PHM benzín". In a mixed description each
 * fuel component is canonicalized and every other component and separator is kept as
 * given ("Natural 95 + olej" -> "PHM benzín + olej"). A bare "PHM", a supplier name or
 * a text without a recognizable fuel component is returned unchanged. Idempotent.
 */
export function canonicalExpenseText(value: unknown): string {
  const raw = text(value).normalize("NFC");
  const whole = FUEL_TEXT_ALIASES.get(foldText(raw));
  if (whole !== undefined) return whole;
  const parts = raw.split(TEXT_COMPONENT_SEPARATOR);
  if (parts.length < 3) return text(value);
  let changed = false;
  // Odd indexes are the captured separators; they are kept exactly.
  const result = parts.map((part, index) => {
    if (index % 2 === 1) return part;
    const fuel = FUEL_TEXT_ALIASES.get(foldText(part));
    if (fuel === undefined) return part;
    if (fuel !== part) changed = true;
    return fuel;
  });
  return changed ? result.join("") : text(value);
}

/** True for a CZK document from a supplier identified as Czech (country CZ, or no country and a CZ DIČ). */
function isDomesticCzech(header: Record<string, any>): boolean {
  if (isForeignCurrency(header)) return false;
  const country = text(header.partnerCountry).toUpperCase();
  if (country !== "") return country === "CZ";
  return normalizeDic(text(header.partnerDic))?.vatPrefix === "CZ";
}

/** Členění DPH written for a resolved tax mode (known domestic alias only; see above). */
export function canonicalClassificationVAT(classification: unknown, header: Record<string, any>, taxMode: TaxMode | undefined): string {
  const value = text(classification);
  if (taxMode !== "taxable" || !isDomesticCzech(header)) return value;
  return DOMESTIC_TAXABLE_CLASSIFICATION_ALIASES[value.toLowerCase()] ?? value;
}

export function isExpenseDocument(header: Record<string, any>, kind: ExpenseKind = "invoice"): boolean {
  if (kind === "voucher") {
    return String(header.type ?? header.voucherType ?? "") === "expense";
  }
  return (EXPENSE_INVOICE_TYPES as readonly string[]).includes(String(header.type ?? ""));
}

export function isForeignCurrency(header: Record<string, any>): boolean {
  const currency = text(header.currency).toUpperCase();
  return currency !== "" && currency !== HOME_CURRENCY;
}

/**
 * Validates and normalizes an expense header. Returns a NEW header (input is not mutated)
 * with resolved dates, originalDocument/symVar, intNote, normalized amounts, the immutable
 * source facts (sourceIssueDate/sourceTaxDate/sourceDocumentNumber/sourcePaymentDate/
 * sourceSymVar) and an `_expensePolicy` descriptor. Idempotent: calling it again on its
 * own output (for example after the card sequence changed) yields a consistent result.
 * Received invoices and commitments always get dateDue: the source due date (sourceDueDate
 * or dateDue), otherwise the original issue date.
 * Non-expense headers are returned as a shallow copy without changes.
 */
export function resolveExpensePolicy(header: Record<string, any>, items: Record<string, any>[] = [], kind: ExpenseKind = "invoice"): Record<string, any> {
  return resolve(header, items, kind, undefined);
}

/**
 * Review projection with the same rules: returns every value the policy can determine and
 * the review issues that make the row not importable yet. Source amounts are kept exactly
 * as given (never reconciled, no VAT recalculated, no rounding invented); a value that
 * depends on a missing, invalid or contradictory fact (an unknown tax mode: PN collapse,
 * KH date, Členění DPH) is left out. Throws only on structural failures that leave the
 * targets undeterminable (VAT period, items). Never use the result for a write;
 * resolveExpensePolicy is the import gate and still rejects every collected issue.
 */
export function projectExpensePolicy(header: Record<string, any>, kind: ExpenseKind = "invoice"): { result: Record<string, any>; issues: ExpensePolicyError[] } {
  const issues: ExpensePolicyError[] = [];
  const result = resolve(header, [], kind, issues);
  return { result, issues };
}

function resolve(header: Record<string, any>, items: Record<string, any>[], kind: ExpenseKind, collect: Collector): Record<string, any> {
  if (!isExpenseDocument(header, kind)) {
    return { ...header };
  }
  const result: Record<string, any> = { ...header };
  const applied = header._expensePolicy !== undefined && header._expensePolicy !== null;
  const warnings: string[] = [];
  const notices: ExpensePolicyNotice[] = [];
  const warn = (code: string, params: Record<string, string>, message: string) => { warnings.push(message); notices.push({ code, params }); };
  const soft = (code: string, message: string, field: string, needsReview: boolean, params: Record<string, string> = {}): void => {
    const error = new ExpensePolicyError(code, message, { needsReview, field, params });
    if (!collect) throw error;
    collect.push(error);
  };

  if (Array.isArray(items) && items.length > 0) {
    fail("ITEMS_NOT_ALLOWED", "Expense documents are summary-only; pass VAT buckets and total instead of items.", "items");
  }
  const headerText = canonicalExpenseText(header.text);
  if (headerText === "") {
    soft("TEXT_REQUIRED", "Header text is required for expense documents.", "text", false);
  } else if (headerText.length > MAX_TEXT_LENGTH) {
    soft("TEXT_TOO_LONG", `Header text has ${headerText.length} characters; POHODA allows ${MAX_TEXT_LENGTH}. Shorten it (move detail to note/intNote) instead of truncating.`, "text", true, { length: String(headerText.length), max: String(MAX_TEXT_LENGTH) });
  }
  if (headerText !== "") result.text = headerText;
  const vatPeriod = text(header.vatPeriod);
  if (vatPeriod === "") {
    fail("VAT_PERIOD_REQUIRED", "vatPeriod (YYYY-MM) is required for expense documents.", "vatPeriod");
  }
  if (!PERIOD_PATTERN.test(vatPeriod)) {
    fail("VAT_PERIOD_INVALID", `vatPeriod must be YYYY-MM, got "${vatPeriod}".`, "vatPeriod");
  }
  const periodStart = `${vatPeriod}-01`;

  // Immutable source facts. On the first application they come from source* fields or the
  // raw date/originalDocument fields; afterwards only the persisted source* fields are used.
  // A projection collects an invalid date and treats that one fact as unknown.
  const invalidDates = new Set<string>();
  const date = (value: string, field: string): string => {
    try { return optionalDate(value, field); } catch (error) {
      if (!collect) throw error;
      collect.push(error as ExpensePolicyError);
      invalidDates.add(field);
      return "";
    }
  };
  const sourceIssueDate = date(firstText(header.sourceIssueDate, applied ? "" : header.date), "sourceIssueDate");
  const sourceTaxDate = date(firstText(header.sourceTaxDate, applied ? "" : header.dateKHDPH, applied ? "" : header.dateTax), "sourceTaxDate");
  const sourceDocumentNumber = firstText(header.sourceDocumentNumber, applied ? "" : header.originalDocument);
  const sourcePaymentDate = date(firstText(header.sourcePaymentDate, applied ? "" : header.datePayment), "sourcePaymentDate");
  const sourceSymVar = firstText(header.sourceSymVar, applied ? "" : header.symVar);
  const sourceDueDate = date(firstText(header.sourceDueDate, applied ? "" : header.dateDue), "sourceDueDate");
  const requestedDateTax = applied ? "" : date(text(header.dateTax), "dateTax");
  const requestedDateAccounting = applied ? "" : date(text(header.dateAccounting), "dateAccounting");

  if (sourceIssueDate === "" && !invalidDates.has("sourceIssueDate")) {
    soft("SOURCE_ISSUE_DATE_REQUIRED", "sourceIssueDate (or date) is required.", "sourceIssueDate", true);
  }

  // Projection only: an undeterminable or contradicted tax mode is collected and left
  // unknown (undefined); values that depend on it (PN collapse, KH date, Členění DPH,
  // a required DUZP) are then left out, while mode-independent facts stay.
  let taxMode: TaxMode | undefined;
  try { taxMode = resolveTaxMode(header); } catch (error) {
    if (!collect || !(error instanceof ExpensePolicyError)) throw error;
    collect.push(error);
  }
  const foreign = isForeignCurrency(header);
  const isCard = header.cardPayment === true;
  const type = kind === "voucher" ? "expense" : String(header.type);
  if (kind === "voucher" && (isCard || ["creditcard", "card"].includes(text(header.paymentType)))) {
    // Client convention: a receipt paid by card is an Ostatní závazek (commitment with
    // paymentType creditcard, PK numbering), never a Pokladna cash expense. The agenda
    // is not switched here; the caller prepares the document again as a commitment.
    soft("CARD_RECEIPT_IN_CASH", "A receipt paid by card belongs in Ostatni zavazky (commitment, paymentType creditcard), not in Pokladna as a cash expense; prepare it as a commitment.", "paymentType", true);
  }

  if (taxMode === "taxable" && sourceTaxDate === "" && !invalidDates.has("sourceTaxDate")) {
    soft("SOURCE_TAX_DATE_REQUIRED", "Taxable expense requires the source DUZP/DPPD (sourceTaxDate or dateKHDPH); it is never derived from the issue date.", "sourceTaxDate", true);
  }

  // Classification consistency.
  const classification = canonicalClassificationVAT(header.classificationVAT, header, taxMode);
  if (taxMode === "nonTax") {
    if (classification !== "" && classification !== NON_TAX_CLASSIFICATION) {
      soft("TAX_MODE_CONFLICT", `Non-tax expenses must use classificationVAT PN; got "${classification}".`, "classificationVAT", false);
      taxMode = undefined;
    } else {
      result.classificationVAT = NON_TAX_CLASSIFICATION;
    }
  } else if (taxMode === "taxable") {
    if (classification === NON_TAX_CLASSIFICATION) {
      soft("TAX_MODE_CONFLICT", "classificationVAT PN contradicts taxMode taxable.", "classificationVAT", false);
      taxMode = undefined;
    } else if (!classification) {
      soft("VAT_CLASSIFICATION_REQUIRED", "Taxable expenses require an explicit classificationVAT from this client's codebook; POHODA's default can be PN.", "classificationVAT", true);
    } else {
      result.classificationVAT = classification;
    }
  }
  // Projection only: the written Členění DPH depends on the unknown tax mode.
  if (taxMode === undefined) delete result.classificationVAT;

  // Amounts.
  const amounts = validateSummary(header, taxMode, foreign, warn, soft, collect);
  for (const [key, value] of Object.entries(amounts.normalized)) {
    if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  const sourceVatBreakdown = amounts.sourceVatBreakdown.length > 0
    ? amounts.sourceVatBreakdown
    : (applied && Array.isArray(header.sourceVatBreakdown) ? header.sourceVatBreakdown as SourceVatBucket[] : []);
  const collapsedVat = taxMode === "nonTax" && sourceVatBreakdown.length > 0;

  // Lateness. With an unknown tax mode the reference is known only when both modes agree
  // (a stated DUZP); an invalid source date leaves the dates that depend on it unknown.
  const referenceDate = taxMode === "taxable" || taxMode === undefined || invalidDates.has("sourceTaxDate") ? sourceTaxDate : (sourceTaxDate || sourceIssueDate);
  const referencePeriod = referenceDate.slice(0, 7);
  let beforeSource = false;
  if (referenceDate !== "" && referencePeriod > vatPeriod) {
    soft("VAT_PERIOD_BEFORE_SOURCE", `vatPeriod ${vatPeriod} is before the source ${taxMode === "taxable" ? "DUZP" : "date"} ${referenceDate}.`, "vatPeriod", true);
    beforeSource = true;
  }
  const late = referenceDate !== "" && referencePeriod < vatPeriod;

  if (referenceDate === "" || beforeSource) {
    // Only reachable in a projection: dates that depend on the missing source date are unknown.
    for (const key of ["date", "dateTax", "dateAccounting", "dateKHDPH"]) delete result[key];
  } else if (late) {
    result.date = periodStart;
    result.dateTax = periodStart;
    if (kind === "invoice") {
      result.dateAccounting = periodStart;
    }
    if (taxMode === "taxable") {
      result.dateKHDPH = periodStart;
    }
  } else {
    setOrDelete(result, "date", sourceIssueDate);
    let dateTax = requestedDateTax || (applied ? text(header.dateTax) : "") || referenceDate;
    if (dateTax.slice(0, 7) !== vatPeriod) {
      soft("DATE_PERIOD_MISMATCH", `dateTax ${dateTax} is outside vatPeriod ${vatPeriod}.`, "dateTax", false, { dateTax, vatPeriod });
      dateTax = "";
    } else if (dateTax < referenceDate) {
      soft("DATE_PERIOD_MISMATCH", `dateTax ${dateTax} precedes the source date ${referenceDate}.`, "dateTax", false, { dateTax, referenceDate });
      dateTax = "";
    }
    setOrDelete(result, "dateTax", invalidDates.has("dateTax") ? "" : dateTax);
    if (kind === "invoice") {
      const dateAccounting = requestedDateAccounting || (applied ? text(header.dateAccounting) : "");
      if (dateAccounting !== "") {
        result.dateAccounting = dateAccounting;
      } else {
        delete result.dateAccounting;
      }
    }
    if (taxMode === "taxable") {
      result.dateKHDPH = sourceTaxDate;
    }
  }
  if (taxMode !== "taxable") {
    delete result.dateKHDPH;
  }
  if (kind === "voucher") {
    delete result.dateAccounting;
    // The actual cash payment date is a source fact; it is never taken from the
    // receipt, due or tax date. A missing date is a review issue (expenseSourceIssues).
    setOrDelete(result, "datePayment", sourcePaymentDate);
  }
  // Datum splatnosti: the source due date; a source without one is due on its original
  // issue date (client convention), also for a late document. vch:voucherHeader has no
  // due-date element, so a cash expense never sends one.
  let dueDateRule: "source" | "issue-date" | "unknown" | "not-supported";
  if (kind === "invoice") {
    const dueDate = sourceDueDate || (invalidDates.has("sourceDueDate") ? "" : sourceIssueDate);
    setOrDelete(result, "dateDue", dueDate);
    dueDateRule = sourceDueDate !== "" ? "source" : dueDate !== "" ? "issue-date" : "unknown";
  } else {
    delete result.dateDue;
    dueDateRule = "not-supported";
  }
  // A CZK cash payable with haléře and no stated rounding is a source-evidence issue
  // (see expenseSourceIssues: CASH_ROUNDING_UNCONFIRMED); an explicit rounding, even 0,
  // records that the printed final payable was read.

  // originalDocument / symVar / payment type rules.
  const payableMinor = amounts.payableCzkMinor;
  const aboveThreshold = payableMinor !== undefined && payableMinor > ORIGINAL_DOCUMENT_THRESHOLD_MINOR;
  let originalDocumentRule: string;
  let symVarRule = sourceSymVar !== "" ? "source" : "none";
  if (isCard) {
    if (kind !== "invoice" || type !== "commitment") {
      fail("CARD_NOT_COMMITMENT", "cardPayment is supported only for commitment (other liability) documents.", "cardPayment");
    }
    const sequence = Number(header.cardSequence);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      fail("CARD_SEQUENCE_REQUIRED", "cardPayment requires a positive integer cardSequence from the PK number series.", "cardSequence");
    }
    const paymentType = text(header.paymentType);
    if (paymentType === "" || paymentType === "card") {
      result.paymentType = "creditcard";
    } else if (CONFLICTING_CARD_PAYMENT_TYPES.includes(paymentType)) {
      fail("CARD_PAYMENT_TYPE_CONFLICT", `cardPayment conflicts with paymentType "${paymentType}".`, "paymentType");
    }
    if (!thresholdKnown(payableMinor, foreign, soft)) {
      delete result.originalDocument;
      delete result.symVar;
      originalDocumentRule = "unknown";
    } else if (aboveThreshold) {
      requireSourceNumber(sourceDocumentNumber, "Card purchase above 10 000 CZK", soft);
      setOrDelete(result, "originalDocument", sourceDocumentNumber);
      if (sourceSymVar !== "") {
        result.symVar = sourceSymVar;
      } else if (/^\d{1,20}$/.test(sourceDocumentNumber)) {
        result.symVar = sourceDocumentNumber;
      } else {
        delete result.symVar;
        if (sourceDocumentNumber !== "") warn("SYMVAR_NOT_NUMERIC", {}, "No numeric variable symbol on the source document; symVar left empty.");
      }
      originalDocumentRule = "card-source-document";
    } else {
      result.originalDocument = `K${sequence}`;
      result.symVar = String(sequence);
      originalDocumentRule = "card-sequence";
    }
  } else if (kind === "voucher") {
    if (!thresholdKnown(payableMinor, foreign, soft)) {
      delete result.originalDocument;
      originalDocumentRule = "unknown";
    } else if (aboveThreshold) {
      requireSourceNumber(sourceDocumentNumber, "Cash expense above 10 000 CZK", soft);
      setOrDelete(result, "originalDocument", sourceDocumentNumber);
      originalDocumentRule = "source-document";
    } else {
      delete result.originalDocument;
      originalDocumentRule = "omitted-at-or-below-threshold";
    }
  } else {
    if (sourceDocumentNumber !== "") {
      result.originalDocument = sourceDocumentNumber;
    } else if (taxMode === "taxable") {
      soft("SOURCE_DOCUMENT_NUMBER_REQUIRED", "Taxable received documents require the supplier document number (sourceDocumentNumber/originalDocument).", "sourceDocumentNumber", true);
      delete result.originalDocument;
    } else {
      delete result.originalDocument;
      warn("SOURCE_DOCUMENT_NUMBER_MISSING", {}, "Source document number missing.");
    }
    if (sourceSymVar !== "") {
      result.symVar = sourceSymVar;
      symVarRule = "source";
    } else if (type === "receivedInvoice") {
      // Received invoices only: a missing VS comes from the supplier's own document
      // number (never internal FP/PK numbering), ASCII digits only, leading zeros kept.
      const derived = deriveSymVarFromDocumentNumber(sourceDocumentNumber);
      if (derived.symVar !== undefined) {
        result.symVar = derived.symVar;
        symVarRule = "derived-from-source-document";
      } else {
        delete result.symVar;
        symVarRule = derived.reason;
      }
      if (derived.warning) warn(derived.reason === "derived-from-source-document" ? "SYMVAR_DERIVED" : "SYMVAR_NOT_DERIVED", { symVar: derived.symVar ?? "", documentNumber: sourceDocumentNumber }, derived.warning);
    }
    originalDocumentRule = sourceDocumentNumber !== "" ? "source-document" : "none";
  }

  // Preserve the original facts in intNote whenever POHODA fields no longer show them.
  const originalShown = text(result.originalDocument) === sourceDocumentNumber;
  if (late || (!originalShown && originalDocumentRule !== "unknown") || collapsedVat) {
    result.intNote = appendSourceNote(text(header.intNote), {
      documentNumber: sourceDocumentNumber,
      issueDate: sourceIssueDate,
      taxDate: sourceTaxDate,
      paymentDate: kind === "voucher" ? result.datePayment : sourcePaymentDate,
      vatBreakdown: collapsedVat ? sourceVatBreakdown : undefined
    });
  }
  if (collapsedVat) {
    result.sourceVatBreakdown = sourceVatBreakdown;
  } else {
    delete result.sourceVatBreakdown;
  }

  if (taxMode === undefined) delete result.taxMode; else result.taxMode = taxMode;
  // Live POHODA recomputes priceRound from the mode. Select a mode only if it
  // reproduces the source payable exactly; arbitrary adjustments need review.
  const amountsProven = !amounts.unproven && !collect?.some((error) => error.code === "SUMMARY_MISMATCH" || error.code === "SUMMARY_INCOMPLETE");
  const rounding = result.total === undefined || !amountsProven ? undefined : roundingMode(result.total, result.roundingAmount, soft);
  if (rounding === undefined) delete result.roundingDocument; else result.roundingDocument = rounding;
  result.roundingVAT = "none";
  result.calculateVAT = false;
  setOrDelete(result, "sourceIssueDate", sourceIssueDate);
  setOrDelete(result, "sourceTaxDate", sourceTaxDate);
  setOrDelete(result, "sourceDocumentNumber", sourceDocumentNumber);
  setOrDelete(result, "sourcePaymentDate", sourcePaymentDate);
  setOrDelete(result, "sourceSymVar", sourceSymVar);
  setOrDelete(result, "sourceDueDate", sourceDueDate);
  if (!foreign) {
    delete result.currency;
    delete result.currencyRate;
    delete result.currencyAmount;
    delete result.currencyPriceSum;
  }
  const identity = partnerIdentityWarning(header);
  if (identity) warn("PARTNER_VAT_COUNTRY_DIFFERS", identity.params, identity.message);
  // Source-evidence review issues are checked last so that earlier, more specific
  // data errors are reported first; prepare_expense_review lists all of them at once.
  for (const issue of expenseSourceIssues(header, kind)) soft(issue.code, issue.message, issue.field, true, issue.params);
  result._expensePolicy = {
    kind,
    type,
    vatPeriod,
    taxMode,
    lateSource: late,
    foreign,
    card: isCard,
    payableCZK: payableMinor === undefined ? undefined : fromMinorUnits(payableMinor),
    originalDocumentRule,
    symVarRule,
    dueDateRule,
    roundingRule: amounts.roundingRule,
    sourceVatBreakdown: collapsedVat ? sourceVatBreakdown : undefined,
    notices,
    original: {
      issueDate: sourceIssueDate,
      taxDate: sourceTaxDate || undefined,
      documentNumber: sourceDocumentNumber || undefined,
      paymentDate: sourcePaymentDate || undefined,
      symVar: sourceSymVar || undefined,
      dueDate: sourceDueDate || undefined
    },
    warnings
  };
  return result;
}

function resolveTaxMode(header: Record<string, any>): TaxMode {
  const requested = text(header.taxMode);
  if (requested === "taxable" || requested === "nonTax") {
    return requested;
  }
  if (requested !== "" && requested !== "auto") {
    fail("TAX_MODE_INVALID", `taxMode must be taxable, nonTax or auto, got "${requested}".`, "taxMode");
  }
  const country = text(header.partnerCountry).toUpperCase();
  const czech = country === "CZ";
  const status = text(header.partnerVatStatus);
  const evidence = text(header.vatStatusEvidence);
  if (!czech) {
    fail("TAX_MODE_REQUIRED", country === ""
      ? "Supplier country is unknown; automatic tax mode needs partnerCountry CZ, otherwise pass an explicit taxMode decision."
      : `Supplier country ${country} requires an explicit taxMode decision (taxable or nonTax).`, "taxMode", true);
  }
  if (status === "non-payer" || status === "payer") {
    if (evidence === "") {
      fail("VAT_STATUS_EVIDENCE_REQUIRED", `partnerVatStatus ${status} needs vatStatusEvidence before taxMode can be derived.`, "vatStatusEvidence", true);
    }
    return status === "payer" ? "taxable" : "nonTax";
  }
  fail("TAX_MODE_REQUIRED", "taxMode is required unless a confirmed Czech partnerVatStatus (payer/non-payer) with vatStatusEvidence is supplied.", "taxMode", true);
}

export type SourceVatBucket = { bucket: "low" | "high" | "third"; base: number; vat: number };

type SummaryResult = {
  normalized: Record<string, number | undefined>;
  /** Projection only: an amount was invalid or unreadable, so the summary is not proven. */
  unproven: boolean;
  payableCzkMinor: number | undefined;
  sourceVatBreakdown: SourceVatBucket[];
  roundingRule: RoundingRule;
};

type Warn = (code: string, params: Record<string, string>, message: string) => void;
type Soft = (code: string, message: string, field: string, needsReview: boolean, params?: Record<string, string>) => void;

/**
 * `taxMode` undefined (projection only) keeps the source buckets as given: neither the PN
 * collapse nor a taxable-only rule is applied. In a projection an invalid amount is
 * collected and only that amount is unknown; nothing is reconciled against it.
 */
function validateSummary(header: Record<string, any>, taxMode: TaxMode | undefined, foreign: boolean, warn: Warn, soft: Soft, collect: Collector): SummaryResult {
  const normalized: Record<string, number | undefined> = {};
  const invalid = new Set<string>();
  const minor = (key: string): number | undefined => {
    if (!isMoneyInput(header[key])) {
      return undefined;
    }
    try {
      const value = toMinorUnits(header[key], key);
      normalized[key] = fromMinorUnits(value);
      return value;
    } catch (error) {
      if (error instanceof MoneyError) {
        if (collect) {
          collect.push(new ExpensePolicyError("AMOUNT_PRECISION", error.message, { field: key }));
          invalid.add(key);
          normalized[key] = undefined; // the invalid input is not shown as a target
          return undefined;
        }
        fail("AMOUNT_PRECISION", error.message, key);
      }
      throw error;
    }
  };

  const total = minor("total");
  if (total === undefined && !invalid.has("total")) {
    if (collect) collect.push(new ExpensePolicyError("TOTAL_REQUIRED", "total (final payable amount after rounding) is required.", { field: "total" }));
    else fail("TOTAL_REQUIRED", "total (final payable amount after rounding) is required.", "total");
  }
  let sum = 0;
  let anyBucket = false;
  const none = minor("priceNone");
  if (none !== undefined) {
    anyBucket = true;
    sum += none;
  }
  if (invalid.has("priceNone")) anyBucket = true;
  let vatPresent = false;
  let bucketGross = 0;
  // Projection only: a bucket whose gross is not proven by the source (incomplete or
  // contradicting its printed sum). The total is then not reconciled and PN gross is unknown.
  let unprovenBucket = false;
  const breakdown: SourceVatBucket[] = [];
  for (const bucket of vatBuckets) {
    const base = minor(bucket.base);
    const vat = minor(bucket.vat);
    const gross = minor(bucket.sum);
    const unreadable = [bucket.base, bucket.vat, bucket.sum].some((key) => invalid.has(key));
    if (base === undefined && vat === undefined && gross === undefined && !unreadable) {
      continue;
    }
    anyBucket = true;
    if (unreadable) {
      // Projection only: the valid amounts of this bucket stay; its gross is not proven.
      unprovenBucket = true;
      if (base !== 0 && base !== undefined || vat !== 0 && vat !== undefined) vatPresent = true;
      delete normalized[bucket.sum];
      continue;
    }
    if (base === undefined || vat === undefined) {
      soft("SUMMARY_INCOMPLETE", `${bucket.base} and ${bucket.vat} must both be given from the source document; VAT is never recalculated.`, base === undefined ? bucket.base : bucket.vat, false, { bucket: bucket.name });
      unprovenBucket = true;
      if (base !== 0 && base !== undefined || vat !== 0 && vat !== undefined) vatPresent = true;
      delete normalized[bucket.sum];
      continue;
    }
    if (gross !== undefined && gross !== base + vat) {
      soft("SUMMARY_MISMATCH", `${bucket.base} ${formatMinorUnits(base)} + ${bucket.vat} ${formatMinorUnits(vat)} != ${bucket.sum} ${formatMinorUnits(gross)}.`, bucket.sum, false,
        { bucket: bucket.name, base: formatMinorUnits(base), vat: formatMinorUnits(vat), gross: formatMinorUnits(gross) });
      unprovenBucket = true;
    }
    if (base !== 0 || vat !== 0) {
      vatPresent = true;
      breakdown.push({ bucket: bucket.name, base: fromMinorUnits(base), vat: fromMinorUnits(vat) });
    }
    plausibilityWarning(bucket.name, base, vat, warn);
    normalized[bucket.sum] = fromMinorUnits(base + vat);
    sum += base + vat;
    bucketGross += base + vat;
  }
  if (!anyBucket) {
    if (collect) collect.push(new ExpensePolicyError("SUMMARY_REQUIRED", "At least one summary amount (priceNone or a VAT bucket) is required.", { field: "priceNone" }));
    else fail("SUMMARY_REQUIRED", "At least one summary amount (priceNone or a VAT bucket) is required.", "priceNone");
  }
  if (invalid.has("priceNone")) unprovenBucket = true;
  let rounding = minor("roundingAmount");
  const roundingUnknown = invalid.has("roundingAmount");
  let roundingRule: RoundingRule = rounding === undefined ? "none" : "source";
  // A second policy pass receives the normalized rounding as an explicit field.
  // Keep its provenance only while the current source amounts still prove it.
  // Nothing is derived from an unproven bucket, an unknown total or an unreadable rounding.
  const derived = foreign || total === undefined || unprovenBucket || roundingUnknown ? undefined : derivedCrownRounding(sum, total);
  if (rounding !== undefined && derived === rounding && header._expensePolicy?.roundingRule === "derived-from-payable") {
    roundingRule = "derived-from-payable";
  }
  if (rounding === undefined && !foreign) {
    // `total` is the printed final payable (CELKEM K ÚHRADĚ). When it differs from the
    // explicit source buckets only by whole-crown mathematical rounding, the rounding is
    // fully determined by these two source facts. Anything else stays a mismatch: never
    // absorb a larger difference, a non-crown payable or a possible misread as rounding.
    if (derived !== undefined) {
      rounding = derived;
      roundingRule = "derived-from-payable";
      normalized.roundingAmount = fromMinorUnits(derived);
    }
  }
  if (roundingRule === "derived-from-payable") {
    warn("ROUNDING_DERIVED", { rounding: formatMinorUnits(rounding!), total: formatMinorUnits(total!), sum: formatMinorUnits(sum) },
      `Rounding ${formatMinorUnits(rounding!)} derived from the stated final payable ${formatMinorUnits(total!)} and source amounts ${formatMinorUnits(sum)}; verify it against the printed final payable.`);
  }
  const bucketsAndNone = sum;
  if (rounding !== undefined) {
    sum += rounding;
  }
  if (total !== undefined && !roundingUnknown && sum !== total && !unprovenBucket) {
    soft("SUMMARY_MISMATCH", `Summary amounts plus rounding (${formatMinorUnits(sum)}) do not equal total ${formatMinorUnits(total)}.`, "total", false, {
      sum: formatMinorUnits(sum), total: formatMinorUnits(total), buckets: formatMinorUnits(bucketsAndNone),
      ...(rounding !== undefined ? { rounding: formatMinorUnits(rounding) } : {})
    });
  }

  if (taxMode === undefined) {
    // Projection only: the buckets stay exactly as the source states them.
  } else if (taxMode === "nonTax") {
    // PN: the whole source gross (including any supplier VAT) is expensed as priceNone.
    // The source VAT breakdown is preserved as metadata and in intNote, never lost.
    if (unprovenBucket) {
      // Projection only: the PN gross is not known from the source.
      for (const key of ["priceNone", ...vatBuckets.flatMap((b) => [b.base, b.vat, b.sum])]) normalized[key] = undefined;
    } else if (vatPresent) {
      normalized.priceNone = fromMinorUnits((none ?? 0) + bucketGross);
      for (const bucket of vatBuckets) {
        normalized[bucket.base] = undefined;
        normalized[bucket.vat] = undefined;
        normalized[bucket.sum] = undefined;
      }
      warn("PN_COLLAPSED", {}, "Non-tax (PN): source VAT buckets were collapsed into priceNone; original breakdown kept in sourceVatBreakdown/intNote.");
    }
    vatPresent = false;
  }

  let payableCzkMinor: number | undefined = total;
  if (foreign) {
    // With an unknown tax mode (projection) the buckets may still collapse to PN, so a
    // foreign VAT split is only a taxable-mode problem.
    if (vatPresent && taxMode !== undefined) {
      soft("FOREIGN_TAXABLE_SPLIT_UNSUPPORTED", "Foreign-currency documents with VAT buckets cannot be expressed exactly in summary-only POHODA XML (no foreign VAT buckets); needs review.", "currency", true);
    }
    if (rounding !== undefined && rounding !== 0) {
      soft("FOREIGN_ROUNDING_UNSUPPORTED", "Foreign-currency summary cannot carry a separate rounding amount; needs review.", "roundingAmount", true);
    }
    const priceSum = minor("currencyPriceSum");
    if (priceSum !== undefined && total !== undefined && priceSum !== total) {
      soft("SUMMARY_MISMATCH", `currencyPriceSum ${formatMinorUnits(priceSum)} != total ${formatMinorUnits(total)}.`, "currencyPriceSum", false, { sum: formatMinorUnits(priceSum), total: formatMinorUnits(total) });
    }
    normalized.currencyPriceSum = total === undefined ? undefined : fromMinorUnits(total);
    const rate = Number(header.currencyRate ?? 0);
    if (!Number.isFinite(rate) || rate < 0) {
      soft("CURRENCY_RATE_INVALID", "currencyRate must be positive, or 0/absent to use the POHODA configured rate.", "currencyRate", false);
    }
    const amount = Number(header.currencyAmount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) {
      soft("CURRENCY_AMOUNT_INVALID", "currencyAmount must be positive or absent.", "currencyAmount", false);
    }
    payableCzkMinor = minor("homePayableCZK");
    if (payableCzkMinor === undefined && !invalid.has("homePayableCZK")) {
      warn("FOREIGN_RATE_UNKNOWN", {}, "Foreign currency: CZK payable unknown before import; POHODA applies its configured rate.");
    }
  } else if (isMoneyInput(header.homePayableCZK)) {
    const explicit = minor("homePayableCZK");
    if (explicit !== undefined && total !== undefined && explicit !== total) {
      soft("SUMMARY_MISMATCH", `homePayableCZK ${formatMinorUnits(explicit!)} != total ${formatMinorUnits(total)} for a CZK document.`, "homePayableCZK", false, { sum: formatMinorUnits(explicit!), total: formatMinorUnits(total) });
    }
  }
  if (!foreign && invalid.has("homePayableCZK")) payableCzkMinor = undefined;
  return { normalized, unproven: invalid.size > 0 || total === undefined, payableCzkMinor, sourceVatBreakdown: breakdown, roundingRule };
}

export type RoundingRule = "source" | "derived-from-payable" | "none";

/** Rounding implied by a whole-crown final payable that is the mathematical crown rounding of the buckets. */
function derivedCrownRounding(bucketSumMinor: number, payableMinor: number): number | undefined {
  if (payableMinor === bucketSumMinor || payableMinor % 100 !== 0) return undefined;
  const rounded = Math.sign(bucketSumMinor) * Math.round(Math.abs(bucketSumMinor) / 100) * 100;
  return rounded === payableMinor ? payableMinor - bucketSumMinor : undefined;
}

const PLAUSIBLE_RATES: Record<string, number[]> = { low: [12, 10, 15], high: [21], third: [10] };

function plausibilityWarning(name: string, base: number, vat: number, warn: Warn): void {
  if (base === 0) {
    if (vat !== 0) {
      warn("VAT_WITHOUT_BASE", { bucket: name, vat: formatMinorUnits(vat) }, `${name} VAT ${formatMinorUnits(vat)} with zero base; kept as source states.`);
    }
    return;
  }
  const rates = PLAUSIBLE_RATES[name] ?? [];
  const tolerance = Math.max(100, Math.abs(base) / 100);
  if (!rates.some((rate) => Math.abs(base * rate / 100 - vat) <= tolerance)) {
    warn("VAT_RATE_UNUSUAL", { bucket: name, vat: formatMinorUnits(vat), base: formatMinorUnits(base), rates: rates.join("/") },
      `${name} VAT ${formatMinorUnits(vat)} is not near ${rates.join("/")}% of base ${formatMinorUnits(base)}; kept as source states (not corrected).`);
  }
}

/** Whether the 10 000 CZK rule can be decided; an unknown payable is a review issue. */
function thresholdKnown(payableMinor: number | undefined, foreign: boolean, soft: Soft): boolean {
  if (payableMinor !== undefined) return true;
  if (foreign) {
    soft("FOREIGN_THRESHOLD_NEEDS_CZK", "The 10 000 CZK originalDocument rule needs an explicit verified homePayableCZK for foreign-currency documents.", "homePayableCZK", true);
  }
  // A CZK payable is unknown only in a projection (total collected as missing/invalid).
  return false;
}

function requireSourceNumber(value: string, label: string, soft: Soft): void {
  if (value === "") {
    soft("SOURCE_DOCUMENT_NUMBER_REQUIRED", `${label} requires the source document number.`, "sourceDocumentNumber", true, { threshold: "above" });
  }
}

export type ExpenseSourceIssue = { code: string; field: string; message: string; params?: Record<string, string> };

/**
 * Source evidence that must be supplied or corrected by a reviewer before any write.
 * Never guesses a value: no country from a VAT prefix, no digits stripped from an
 * explicit VS, no cash payment date from the issue/due/tax date. Shared by the
 * policy (fails on the first) and prepare_expense_review (lists all as notes).
 */
export function expenseSourceIssues(header: Record<string, any>, kind: ExpenseKind = "invoice"): ExpenseSourceIssue[] {
  if (!isExpenseDocument(header, kind)) return [];
  const applied = header._expensePolicy !== undefined && header._expensePolicy !== null;
  const issues: ExpenseSourceIssue[] = [];
  const dic = foreignVatId(header);
  // An existing address-book contact (partnerId) carries its own country in POHODA.
  if (dic && text(header.partnerCountry) === "" && !(Number(header.partnerId) > 0)) {
    issues.push({
      code: "PARTNER_COUNTRY_REQUIRED",
      field: "partnerCountry",
      params: { dic: dic.normalized },
      message: `Supplier DIČ ${dic.normalized} is a foreign VAT registration but partnerCountry is empty. Enter the supplier's country from the source document or a registry; a VAT registration alone does not prove the country of establishment, so it is not guessed.`
    });
  }
  const symVar = firstText(header.sourceSymVar, applied ? "" : header.symVar);
  if (symVar !== "" && !/^\d+$/.test(symVar)) {
    issues.push({
      code: "SYMVAR_INVALID",
      field: "sourceSymVar",
      params: { symVar },
      message: `Source VS "${symVar}" is not numeric; a variable symbol has digits only (it may be another identifier such as a DIČ). Enter the digits-only VS printed on the source, or clear it if the source has none; it is never rewritten automatically.`
    });
  }
  const cashRounding = unconfirmedCashRounding(header, kind);
  if (cashRounding) issues.push(cashRounding);
  if (kind === "voucher" && firstText(header.sourcePaymentDate, applied ? "" : header.datePayment) === "") {
    issues.push({
      code: "SOURCE_PAYMENT_DATE_REQUIRED",
      field: "sourcePaymentDate",
      message: "Cash expense has no actual payment date from the source. Correct the extracted source data (sourcePaymentDate) and prepare a new review; it is never taken from the issue, due or tax date."
    });
  }
  return issues;
}

/**
 * A CZK cash payable with haléře is unusual (cash is settled in whole crowns), and the
 * typical extraction error is copying the "Celkem vč. DPH" sum instead of the printed
 * "CELKEM K ÚHRADĚ". Without an explicit roundingAmount (0 allowed) it needs review.
 */
function unconfirmedCashRounding(header: Record<string, any>, kind: ExpenseKind): ExpenseSourceIssue | undefined {
  const cash = kind === "voucher" || text(header.paymentType) === "cash";
  if (!cash || isForeignCurrency(header) || isMoneyInput(header.roundingAmount) || !isMoneyInput(header.total)) return undefined;
  let total: number;
  try { total = toMinorUnits(header.total, "total"); } catch { return undefined; }
  if (total % 100 === 0) return undefined;
  return {
    code: "CASH_ROUNDING_UNCONFIRMED",
    field: "roundingAmount",
    params: { total: formatMinorUnits(total) },
    message: `CZK cash payable ${formatMinorUnits(total)} has haléře and no rounding is stated. Re-read the printed final payable (CELKEM K ÚHRADĚ) and rounding line: if it differs from the VAT-inclusive sum, enter that printed payable as total (whole-crown rounding is then derived) or the printed roundingAmount; if the source really asks for ${formatMinorUnits(total)}, enter roundingAmount 0. Never substitute the bucket sum for the printed payable.`
  };
}

function foreignVatId(header: Record<string, any>) {
  const parts = normalizeDic(text(header.partnerDic));
  return parts && parts.vatPrefix !== "CZ" ? parts : undefined;
}

/** A VAT registration can differ from the establishment country; never blocks or corrects. */
function partnerIdentityWarning(header: Record<string, any>): { message: string; params: Record<string, string> } | undefined {
  const parts = normalizeDic(text(header.partnerDic));
  const country = text(header.partnerCountry).toUpperCase();
  if (!parts || !parts.isoCountry || country === "" || parts.isoCountry === country) return undefined;
  return { params: { dic: parts.normalized, dicCountry: parts.isoCountry, country }, message: `Supplier DIČ ${parts.normalized} is a ${parts.isoCountry} VAT registration while partnerCountry is ${country}; kept as stated. Confirm the establishment country and VAT treatment from the source.` };
}

/** POHODA typ:symVarType is xsd:string maxLength 20 (Stormware type.xsd). */
export const SYMVAR_MAX_LENGTH = 20;
/** Czech domestic payment orders carry at most 10 digits of variable symbol. */
export const BANK_SYMVAR_MAX_LENGTH = 10;

export type DerivedSymVar = {
  symVar?: string;
  reason: "derived-from-source-document" | "none" | "missing-no-digits" | "missing-too-long";
  warning?: string;
};

/**
 * Derives a variable symbol from a supplier document number by keeping ASCII digits
 * only, in order, with leading zeros (FV-2026/0007 -> 20260007). Never truncates or
 * invents: no digits or more than SYMVAR_MAX_LENGTH digits yields no symbol.
 */
export function deriveSymVarFromDocumentNumber(documentNumber: string): DerivedSymVar {
  const source = text(documentNumber);
  if (source === "") {
    return { reason: "none" };
  }
  const digits = source.replace(/[^0-9]/g, "");
  if (digits === "") {
    return { reason: "missing-no-digits", warning: `No variable symbol on the source and supplier document number "${source}" has no digits; symVar left empty for review.` };
  }
  if (digits.length > SYMVAR_MAX_LENGTH) {
    return { reason: "missing-too-long", warning: `No variable symbol on the source; digits of supplier document number "${source}" (${digits.length}) exceed the POHODA limit of ${SYMVAR_MAX_LENGTH}; symVar left empty for review, not truncated.` };
  }
  const derived = `Variable symbol ${digits} derived from supplier document number "${source}" (source has no VS).`;
  return {
    symVar: digits,
    reason: "derived-from-source-document",
    warning: digits.length > BANK_SYMVAR_MAX_LENGTH
      ? `${derived} It has ${digits.length} digits; Czech bank payments accept at most ${BANK_SYMVAR_MAX_LENGTH}, so verify before paying.`
      : derived
  };
}

export type SourceNoteFacts = {
  documentNumber?: string;
  issueDate?: string;
  taxDate?: string;
  paymentDate?: string;
  vatBreakdown?: SourceVatBucket[] | undefined;
};

const BUCKET_LABELS: Record<string, string> = { low: "snizena", high: "zakladni", third: "druha snizena" };

export function buildSourceNote(facts: SourceNoteFacts): string {
  const vat = (facts.vatBreakdown ?? [])
    .map((entry) => `${BUCKET_LABELS[entry.bucket] ?? entry.bucket} zaklad ${formatMinorUnits(toMinorUnits(entry.base))} DPH ${formatMinorUnits(toMinorUnits(entry.vat))}`)
    .join(", ");
  const parts = [
    facts.documentNumber ? `doklad ${facts.documentNumber}` : "",
    facts.issueDate ? `vystaveno ${facts.issueDate}` : "",
    facts.taxDate ? `DUZP ${facts.taxDate}` : "",
    facts.paymentDate ? `uhrazeno ${facts.paymentDate}` : "",
    vat !== "" ? `DPH dle dokladu: ${vat}` : ""
  ].filter(Boolean);
  return `${SOURCE_NOTE_PREFIX} ${parts.join("; ")}`;
}

/** Appends the source line once; replaces an older generated source line instead of duplicating. */
export function appendSourceNote(intNote: string, facts: SourceNoteFacts): string {
  const line = buildSourceNote(facts);
  let replaced = false;
  const kept: string[] = [];
  for (const existing of intNote.split(/\r?\n/)) {
    if (!existing.trim()) continue;
    if (existing.startsWith(`${SOURCE_NOTE_PREFIX} `)) {
      if (!replaced) { kept.push(line); replaced = true; }
    } else kept.push(existing);
  }
  if (!replaced) kept.push(line);
  return kept.join("\n");
}

function roundingMode(total: number | string, adjustment: number | string | undefined, soft: Soft): string | undefined {
  const delta = toMinorUnits(adjustment ?? 0);
  if (delta === 0) return "none";
  const payable = toMinorUnits(total), before = payable - delta;
  const steps: Array<[number, string]> = [[100, "one"], [50, "half"], [10, "tenth"]];
  const math = (step: number) => Math.sign(before) * Math.round(Math.abs(before) / step) * step;
  for (const [step, suffix] of steps) if (math(step) === payable) return `math2${suffix}`;
  if (math(5) === payable) return "math5cent";
  for (const [step, suffix] of steps) {
    if (Math.ceil(before / step) * step === payable) return `up2${suffix}`;
    if (Math.floor(before / step) * step === payable) return `down2${suffix}`;
  }
  soft("SOURCE_ROUNDING_UNSUPPORTED", "No POHODA rounding mode reproduces this source rounding exactly; review the document without changing its amounts.", "roundingAmount", true);
  return undefined;
}

function optionalDate(value: string, field: string): string {
  if (value === "") {
    return "";
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    fail("DATE_INVALID", `${field} must be YYYY-MM-DD, got "${value}".`, field);
  }
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
    fail("DATE_INVALID", `${field} is not a valid calendar date: "${value}".`, field);
  }
  return value;
}

function setOrDelete(target: Record<string, any>, key: string, value: string): void {
  if (value === "") {
    delete target[key];
  } else {
    target[key] = value;
  }
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate !== "") {
      return candidate;
    }
  }
  return "";
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function fail(code: string, message: string, field?: string, needsReview = false): never {
  throw new ExpensePolicyError(code, message, { needsReview, ...(field ? { field } : {}) });
}
