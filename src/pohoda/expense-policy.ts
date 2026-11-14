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

  public constructor(code: string, message: string, options: { needsReview?: boolean; field?: string } = {}) {
    super(`${code}: ${message}`);
    this.name = "ExpensePolicyError";
    this.code = code;
    this.needsReview = options.needsReview ?? false;
    this.field = options.field;
  }
}

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
 * Non-expense headers are returned as a shallow copy without changes.
 */
export function resolveExpensePolicy(header: Record<string, any>, items: Record<string, any>[] = [], kind: ExpenseKind = "invoice"): Record<string, any> {
  if (!isExpenseDocument(header, kind)) {
    return { ...header };
  }
  const result: Record<string, any> = { ...header };
  const applied = header._expensePolicy !== undefined && header._expensePolicy !== null;
  const warnings: string[] = [];

  if (Array.isArray(items) && items.length > 0) {
    fail("ITEMS_NOT_ALLOWED", "Expense documents are summary-only; pass VAT buckets and total instead of items.", "items");
  }
  if (text(header.text) === "") {
    fail("TEXT_REQUIRED", "Header text is required for expense documents.", "text");
  }
  if (text(header.text).length > MAX_TEXT_LENGTH) {
    fail("TEXT_TOO_LONG", `Header text has ${text(header.text).length} characters; POHODA allows ${MAX_TEXT_LENGTH}. Shorten it (move detail to note/intNote) instead of truncating.`, "text", true);
  }
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
  const sourceIssueDate = optionalDate(firstText(header.sourceIssueDate, applied ? "" : header.date), "sourceIssueDate");
  const sourceTaxDate = optionalDate(firstText(header.sourceTaxDate, applied ? "" : header.dateKHDPH, applied ? "" : header.dateTax), "sourceTaxDate");
  const sourceDocumentNumber = firstText(header.sourceDocumentNumber, applied ? "" : header.originalDocument);
  const sourcePaymentDate = optionalDate(firstText(header.sourcePaymentDate, applied ? "" : header.datePayment), "sourcePaymentDate");
  const sourceSymVar = firstText(header.sourceSymVar, applied ? "" : header.symVar);
  const requestedDateTax = applied ? "" : optionalDate(text(header.dateTax), "dateTax");
  const requestedDateAccounting = applied ? "" : optionalDate(text(header.dateAccounting), "dateAccounting");

  if (sourceIssueDate === "") {
    fail("SOURCE_ISSUE_DATE_REQUIRED", "sourceIssueDate (or date) is required.", "sourceIssueDate", true);
  }

  const taxMode = resolveTaxMode(header);
  const foreign = isForeignCurrency(header);
  const isCard = header.cardPayment === true;
  const type = kind === "voucher" ? "expense" : String(header.type);

  if (taxMode === "taxable" && sourceTaxDate === "") {
    fail("SOURCE_TAX_DATE_REQUIRED", "Taxable expense requires the source DUZP/DPPD (sourceTaxDate or dateKHDPH); it is never derived from the issue date.", "sourceTaxDate", true);
  }

  // Classification consistency.
  const classification = text(header.classificationVAT);
  if (taxMode === "nonTax") {
    if (classification !== "" && classification !== NON_TAX_CLASSIFICATION) {
      fail("TAX_MODE_CONFLICT", `Non-tax expenses must use classificationVAT PN; got "${classification}".`, "classificationVAT");
    }
    result.classificationVAT = NON_TAX_CLASSIFICATION;
  } else if (classification === NON_TAX_CLASSIFICATION) {
    fail("TAX_MODE_CONFLICT", "classificationVAT PN contradicts taxMode taxable.", "classificationVAT");
  } else if (!classification) {
    fail("VAT_CLASSIFICATION_REQUIRED", "Taxable expenses require an explicit classificationVAT from this client's codebook; POHODA's default can be PN.", "classificationVAT", true);
  }

  // Amounts.
  const amounts = validateSummary(header, taxMode, foreign, warnings);
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

  // Lateness.
  const referenceDate = taxMode === "taxable" ? sourceTaxDate : (sourceTaxDate || sourceIssueDate);
  const referencePeriod = referenceDate.slice(0, 7);
  if (referencePeriod > vatPeriod) {
    fail("VAT_PERIOD_BEFORE_SOURCE", `vatPeriod ${vatPeriod} is before the source ${taxMode === "taxable" ? "DUZP" : "date"} ${referenceDate}.`, "vatPeriod", true);
  }
  const late = referencePeriod < vatPeriod;

  if (late) {
    result.date = periodStart;
    result.dateTax = periodStart;
    if (kind === "invoice") {
      result.dateAccounting = periodStart;
    }
    if (taxMode === "taxable") {
      result.dateKHDPH = periodStart;
    }
  } else {
    result.date = sourceIssueDate;
    let dateTax = requestedDateTax || (applied ? text(header.dateTax) : "") || referenceDate;
    if (dateTax.slice(0, 7) !== vatPeriod) {
      fail("DATE_PERIOD_MISMATCH", `dateTax ${dateTax} is outside vatPeriod ${vatPeriod}.`, "dateTax");
    }
    if (dateTax < referenceDate) {
      fail("DATE_PERIOD_MISMATCH", `dateTax ${dateTax} precedes the source date ${referenceDate}.`, "dateTax");
    }
    result.dateTax = dateTax;
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
  if (taxMode === "nonTax") {
    delete result.dateKHDPH;
  }
  if (kind === "voucher") {
    delete result.dateAccounting;
    // The actual cash payment date is a source fact; it is never taken from the
    // receipt, due or tax date. A missing date is a review issue (expenseSourceIssues).
    setOrDelete(result, "datePayment", sourcePaymentDate);
  }
  const cash = kind === "voucher" || text(header.paymentType) === "cash";
  if (cash && !foreign && amounts.payableCzkMinor !== undefined && amounts.payableCzkMinor % 100 !== 0) {
    warnings.push(`Cash payable ${formatMinorUnits(amounts.payableCzkMinor)} CZK has haléře; CZK cash is normally settled in whole crowns. Verify the payment method and rounding on the source; amounts are kept as the source states.`);
  }

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
    requireThresholdAmount(payableMinor, foreign);
    if (aboveThreshold) {
      requireSourceNumber(sourceDocumentNumber, "Card purchase above 10 000 CZK");
      result.originalDocument = sourceDocumentNumber;
      if (sourceSymVar !== "") {
        result.symVar = sourceSymVar;
      } else if (/^\d{1,20}$/.test(sourceDocumentNumber)) {
        result.symVar = sourceDocumentNumber;
      } else {
        delete result.symVar;
        warnings.push("No numeric variable symbol on the source document; symVar left empty.");
      }
      originalDocumentRule = "card-source-document";
    } else {
      result.originalDocument = `K${sequence}`;
      result.symVar = String(sequence);
      originalDocumentRule = "card-sequence";
    }
  } else if (kind === "voucher") {
    requireThresholdAmount(payableMinor, foreign);
    if (aboveThreshold) {
      requireSourceNumber(sourceDocumentNumber, "Cash expense above 10 000 CZK");
      result.originalDocument = sourceDocumentNumber;
      originalDocumentRule = "source-document";
    } else {
      delete result.originalDocument;
      originalDocumentRule = "omitted-at-or-below-threshold";
    }
  } else {
    if (sourceDocumentNumber !== "") {
      result.originalDocument = sourceDocumentNumber;
    } else if (taxMode === "taxable") {
      fail("SOURCE_DOCUMENT_NUMBER_REQUIRED", "Taxable received documents require the supplier document number (sourceDocumentNumber/originalDocument).", "sourceDocumentNumber", true);
    } else {
      delete result.originalDocument;
      warnings.push("Source document number missing.");
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
      if (derived.warning) warnings.push(derived.warning);
    }
    originalDocumentRule = sourceDocumentNumber !== "" ? "source-document" : "none";
  }

  // Preserve the original facts in intNote whenever POHODA fields no longer show them.
  const originalShown = text(result.originalDocument) === sourceDocumentNumber;
  if (late || !originalShown || collapsedVat) {
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

  result.taxMode = taxMode;
  // Live POHODA recomputes priceRound from the mode. Select a mode only if it
  // reproduces the source payable exactly; arbitrary adjustments need review.
  result.roundingDocument = roundingMode(result.total, result.roundingAmount);
  result.roundingVAT = "none";
  result.calculateVAT = false;
  setOrDelete(result, "sourceIssueDate", sourceIssueDate);
  setOrDelete(result, "sourceTaxDate", sourceTaxDate);
  setOrDelete(result, "sourceDocumentNumber", sourceDocumentNumber);
  setOrDelete(result, "sourcePaymentDate", sourcePaymentDate);
  setOrDelete(result, "sourceSymVar", sourceSymVar);
  if (!foreign) {
    delete result.currency;
    delete result.currencyRate;
    delete result.currencyAmount;
    delete result.currencyPriceSum;
  }
  const identity = partnerIdentityWarning(header);
  if (identity) warnings.push(identity);
  // Source-evidence review issues are checked last so that earlier, more specific
  // data errors are reported first; prepare_expense_review lists all of them at once.
  const issue = expenseSourceIssues(header, kind)[0];
  if (issue) fail(issue.code, issue.message, issue.field, true);
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
    sourceVatBreakdown: collapsedVat ? sourceVatBreakdown : undefined,
    original: {
      issueDate: sourceIssueDate,
      taxDate: sourceTaxDate || undefined,
      documentNumber: sourceDocumentNumber || undefined,
      paymentDate: sourcePaymentDate || undefined,
      symVar: sourceSymVar || undefined
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
  payableCzkMinor: number | undefined;
  sourceVatBreakdown: SourceVatBucket[];
};

function validateSummary(header: Record<string, any>, taxMode: TaxMode, foreign: boolean, warnings: string[]): SummaryResult {
  const normalized: Record<string, number | undefined> = {};
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
        fail("AMOUNT_PRECISION", error.message, key);
      }
      throw error;
    }
  };

  const total = minor("total");
  if (total === undefined) {
    fail("TOTAL_REQUIRED", "total (final payable amount after rounding) is required.", "total");
  }
  let sum = 0;
  let anyBucket = false;
  const none = minor("priceNone");
  if (none !== undefined) {
    anyBucket = true;
    sum += none;
  }
  let vatPresent = false;
  let bucketGross = 0;
  const breakdown: SourceVatBucket[] = [];
  for (const bucket of vatBuckets) {
    const base = minor(bucket.base);
    const vat = minor(bucket.vat);
    const gross = minor(bucket.sum);
    if (base === undefined && vat === undefined && gross === undefined) {
      continue;
    }
    anyBucket = true;
    if (base === undefined || vat === undefined) {
      fail("SUMMARY_INCOMPLETE", `${bucket.base} and ${bucket.vat} must both be given from the source document; VAT is never recalculated.`, base === undefined ? bucket.base : bucket.vat);
    }
    if (gross !== undefined && gross !== base + vat) {
      fail("SUMMARY_MISMATCH", `${bucket.base} ${formatMinorUnits(base)} + ${bucket.vat} ${formatMinorUnits(vat)} != ${bucket.sum} ${formatMinorUnits(gross)}.`, bucket.sum);
    }
    if (base !== 0 || vat !== 0) {
      vatPresent = true;
      breakdown.push({ bucket: bucket.name, base: fromMinorUnits(base), vat: fromMinorUnits(vat) });
    }
    plausibilityWarning(bucket.name, base, vat, warnings);
    normalized[bucket.sum] = fromMinorUnits(base + vat);
    sum += base + vat;
    bucketGross += base + vat;
  }
  if (!anyBucket) {
    fail("SUMMARY_REQUIRED", "At least one summary amount (priceNone or a VAT bucket) is required.", "priceNone");
  }
  const rounding = minor("roundingAmount");
  if (rounding !== undefined) {
    sum += rounding;
  }
  if (sum !== total) {
    fail("SUMMARY_MISMATCH", `Summary amounts plus rounding (${formatMinorUnits(sum)}) do not equal total ${formatMinorUnits(total)}.`, "total");
  }

  if (taxMode === "nonTax") {
    // PN: the whole source gross (including any supplier VAT) is expensed as priceNone.
    // The source VAT breakdown is preserved as metadata and in intNote, never lost.
    if (vatPresent) {
      normalized.priceNone = fromMinorUnits((none ?? 0) + bucketGross);
      for (const bucket of vatBuckets) {
        normalized[bucket.base] = undefined;
        normalized[bucket.vat] = undefined;
        normalized[bucket.sum] = undefined;
      }
      warnings.push("Non-tax (PN): source VAT buckets were collapsed into priceNone; original breakdown kept in sourceVatBreakdown/intNote.");
    }
    vatPresent = false;
  }

  let payableCzkMinor: number | undefined = total;
  if (foreign) {
    if (vatPresent) {
      fail("FOREIGN_TAXABLE_SPLIT_UNSUPPORTED", "Foreign-currency documents with VAT buckets cannot be expressed exactly in summary-only POHODA XML (no foreign VAT buckets); needs review.", "currency", true);
    }
    if (rounding !== undefined && rounding !== 0) {
      fail("FOREIGN_ROUNDING_UNSUPPORTED", "Foreign-currency summary cannot carry a separate rounding amount; needs review.", "roundingAmount", true);
    }
    const priceSum = minor("currencyPriceSum");
    if (priceSum !== undefined && priceSum !== total) {
      fail("SUMMARY_MISMATCH", `currencyPriceSum ${formatMinorUnits(priceSum)} != total ${formatMinorUnits(total)}.`, "currencyPriceSum");
    }
    normalized.currencyPriceSum = fromMinorUnits(total);
    const rate = Number(header.currencyRate ?? 0);
    if (!Number.isFinite(rate) || rate < 0) {
      fail("CURRENCY_RATE_INVALID", "currencyRate must be positive, or 0/absent to use the POHODA configured rate.", "currencyRate");
    }
    const amount = Number(header.currencyAmount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) {
      fail("CURRENCY_AMOUNT_INVALID", "currencyAmount must be positive or absent.", "currencyAmount");
    }
    payableCzkMinor = minor("homePayableCZK");
    if (payableCzkMinor === undefined) {
      warnings.push("Foreign currency: CZK payable unknown before import; POHODA applies its configured rate.");
    }
  } else if (isMoneyInput(header.homePayableCZK)) {
    const explicit = minor("homePayableCZK");
    if (explicit !== total) {
      fail("SUMMARY_MISMATCH", `homePayableCZK ${formatMinorUnits(explicit!)} != total ${formatMinorUnits(total)} for a CZK document.`, "homePayableCZK");
    }
  }
  return { normalized, payableCzkMinor, sourceVatBreakdown: breakdown };
}

const PLAUSIBLE_RATES: Record<string, number[]> = { low: [12, 10, 15], high: [21], third: [10] };

function plausibilityWarning(name: string, base: number, vat: number, warnings: string[]): void {
  if (base === 0) {
    if (vat !== 0) {
      warnings.push(`${name} VAT ${formatMinorUnits(vat)} with zero base; kept as source states.`);
    }
    return;
  }
  const rates = PLAUSIBLE_RATES[name] ?? [];
  const tolerance = Math.max(100, Math.abs(base) / 100);
  if (!rates.some((rate) => Math.abs(base * rate / 100 - vat) <= tolerance)) {
    warnings.push(`${name} VAT ${formatMinorUnits(vat)} is not near ${rates.join("/")}% of base ${formatMinorUnits(base)}; kept as source states (not corrected).`);
  }
}

function requireThresholdAmount(payableMinor: number | undefined, foreign: boolean): void {
  if (payableMinor === undefined && foreign) {
    fail("FOREIGN_THRESHOLD_NEEDS_CZK", "The 10 000 CZK originalDocument rule needs an explicit verified homePayableCZK for foreign-currency documents.", "homePayableCZK", true);
  }
}

function requireSourceNumber(value: string, label: string): void {
  if (value === "") {
    fail("SOURCE_DOCUMENT_NUMBER_REQUIRED", `${label} requires the source document number.`, "sourceDocumentNumber", true);
  }
}

export type ExpenseSourceIssue = { code: string; field: string; message: string };

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
      message: `Supplier DIČ ${dic.normalized} is a foreign VAT registration but partnerCountry is empty. Enter the supplier's country from the source document or a registry; a VAT registration alone does not prove the country of establishment, so it is not guessed.`
    });
  }
  const symVar = firstText(header.sourceSymVar, applied ? "" : header.symVar);
  if (symVar !== "" && !/^\d+$/.test(symVar)) {
    issues.push({
      code: "SYMVAR_INVALID",
      field: "sourceSymVar",
      message: `Source VS "${symVar}" is not numeric; a variable symbol has digits only (it may be another identifier such as a DIČ). Enter the digits-only VS printed on the source, or clear it if the source has none; it is never rewritten automatically.`
    });
  }
  if (kind === "voucher" && firstText(header.sourcePaymentDate, applied ? "" : header.datePayment) === "") {
    issues.push({
      code: "SOURCE_PAYMENT_DATE_REQUIRED",
      field: "sourcePaymentDate",
      message: "Cash expense has no actual payment date from the source. Correct the extracted source data (sourcePaymentDate) and prepare a new review; it is never taken from the issue, due or tax date."
    });
  }
  return issues;
}

function foreignVatId(header: Record<string, any>) {
  const parts = normalizeDic(text(header.partnerDic));
  return parts && parts.vatPrefix !== "CZ" ? parts : undefined;
}

/** A VAT registration can differ from the establishment country; never blocks or corrects. */
function partnerIdentityWarning(header: Record<string, any>): string | undefined {
  const parts = normalizeDic(text(header.partnerDic));
  const country = text(header.partnerCountry).toUpperCase();
  if (!parts || !parts.isoCountry || country === "" || parts.isoCountry === country) return undefined;
  return `Supplier DIČ ${parts.normalized} is a ${parts.isoCountry} VAT registration while partnerCountry is ${country}; kept as stated. Confirm the establishment country and VAT treatment from the source.`;
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

function roundingMode(total: number | string, adjustment: number | string | undefined): string {
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
  fail("SOURCE_ROUNDING_UNSUPPORTED", "No POHODA rounding mode reproduces this source rounding exactly; review the document without changing its amounts.", "roundingAmount", true);
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
