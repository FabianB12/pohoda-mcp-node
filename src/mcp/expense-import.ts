import { createHash } from "node:crypto";
import type { PohodaClient, WriteBatchOperation } from "../pohoda/client.js";
import type { TransportOptions } from "../pohoda/transport.js";
import { PdfArchive, PdfDocumentArchiver, normalizeSourcePages, shortcutTargetsMatch, verifyPdfAttachmentLink } from "../pohoda/pdf-archive.js";
import { resolveExpensePolicy } from "../pohoda/expense-policy.js";
import { toMinorUnits, sumHomeCurrency, moneyValue } from "../pohoda/money.js";
import { classifyExpenseWriteResponse } from "./expense-write-response.js";
import { readAddressBook, resolveSupplier, supplierEvidence, SupplierIdentityError, dicKey, type AddressBookLookup, type AddressRecord } from "./supplier-identity.js";
import { CzechRegistryClient, companyKey, classifyVat, mapAresAddress, matchSubjects, normalizeDic, normalizeIco, adisCandidates, decideNonPayerTreatment, type AresSubject } from "../registry/czech-registry.js";

type Fields = Record<string, any>;
type ExpenseOperation = Extract<WriteBatchOperation, { header: Fields }>;
const queues = new Map<string, Promise<void>>();
const text = (v: unknown): string => v == null ? "" : String(v);
const array = (v: any): any[] => v == null ? [] : Array.isArray(v) ? v : [v];

/**
 * Retry identity. POHODA 14302 ignores invoice extId list filters (returns the
 * whole agenda) and does not export invoice extId, and re-importing the same
 * extId creates a duplicate. The importer therefore writes a bounded,
 * deterministic marker line into intNote (which POHODA exports) and recognises
 * prior imports only by comparing markers locally. An exported extId is used as
 * an additional hint on versions that provide it; extId filters are never trusted.
 */
export const RETRY_MARKER_PREFIX = "MCP-ID:";
const MARKER_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const MARKER_PATTERN = /(?<![A-Za-z0-9._-])MCP-ID:([A-Za-z0-9._:-]{1,64})\|([A-Za-z0-9._:-]{1,64})(?![A-Za-z0-9._:|-])/g;
/** Page size and bound for the existing-document scan. Exceeding the bound fails closed. */
export const RETRY_SCAN_PAGE_SIZE = 500;
export const RETRY_SCAN_MAX_PAGES = 200;

export function retryMarker(extSystemName: string, extId: string): string {
  if (!MARKER_TOKEN.test(text(extSystemName)) || !MARKER_TOKEN.test(text(extId))) {
    throw new Error("extId and extSystemName must be 1-64 characters of A-Z, a-z, 0-9, '.', '_', ':' or '-' so the retry marker can be verified.");
  }
  return `${RETRY_MARKER_PREFIX}${extSystemName}|${extId}`;
}

/** All complete retry markers in a note; partial or overlong tokens never match. */
export function retryMarkersIn(note: unknown): string[] {
  return [...text(note).matchAll(MARKER_PATTERN)].map((m) => `${RETRY_MARKER_PREFIX}${m[1]}|${m[2]}`);
}

/** Append the marker as its own last line, preserving every other note line. */
export function withRetryMarker(intNote: unknown, marker: string): string {
  const lines = text(intNote).split(/\r?\n/);
  const foreign = [...new Set(lines.flatMap(retryMarkersIn))].filter((m) => m !== marker);
  if (foreign.length) throw new Error(`intNote already contains a different MCP retry marker (${foreign.join(", ")}); remove copied markers before import.`);
  const kept = lines.filter((line) => line.trim() !== "" && line.trim() !== marker);
  return [...kept, marker].join("\n");
}

const scalar = (v: unknown): string => v != null && typeof v === "object" ? text((v as Fields)["#text"] ?? "") : text(v);

/**
 * Classify POHODA importDetails. errno 603 on the exchange rate (XPath typ:rate,
 * note "Zmena kurzu ...") means POHODA substituted a rate and needs review. 603 on
 * accounting/paymentType is POHODA filling unit defaults and is informational;
 * read-back verification stays authoritative for every stored field.
 */
export function classifyImportDetails(data: Fields | undefined): { review: Fields[]; warnings: Fields[] } {
  const review: Fields[] = [], warnings: Fields[] = [];
  for (const detail of array(data?.importDetails?.detail)) {
    const entry = { state: scalar(detail.state), errno: scalar(detail.errno), note: scalar(detail.note), xpath: scalar(detail.XPath), valueRequested: scalar(detail.valueRequested) || undefined, valueProduced: scalar(detail.valueProduced) || undefined };
    if (entry.state === "error") continue;
    const field = entry.xpath.split("/").pop()!.replace(/\[\d+\]$/, "").replace(/^[A-Za-z]+:/, "");
    if (entry.errno === "603" && (field === "rate" || /kurz/i.test(entry.note))) review.push({ code: "FX_RATE_ADJUSTED", ...entry, message: "POHODA changed the exchange rate during import; confirm the rate before relying on the document." });
    else if (entry.errno === "631" && /attachments/.test(entry.xpath)) review.push({ code: "PDF_LINK_TARGET_MISSING", ...entry, message: "POHODA could not find the linked PDF file." });
    else warnings.push(entry);
  }
  return { review, warnings };
}

/** Retry found a document from before per-document PDFs that links the whole source PDF. */
export const PDF_LINK_FULL_SOURCE = "PDF_LINK_FULL_SOURCE";

/** Result summary of the linked document PDF and the preserved original. */
function pdfResult(header: Fields): Fields | undefined {
  if (!header.sourcePdfArchivePath) return undefined;
  const pdf = header._sourcePdf ?? {};
  return { path: header.sourcePdfArchivePath, sha256: pdf.sha256 ?? header.sourcePdfSha256, pages: header.sourcePages, pageRanges: pdf.pageRanges, pageCount: pdf.pageCount, wholeSource: pdf.wholeSource,
    source: { path: pdf.original?.path, sha256: header.sourcePdfSha256, bytes: header.sourcePdfBytes } };
}

export function isExpenseOperation(op: WriteBatchOperation): op is ExpenseOperation {
  return op.tool === "create_other_liability" ||
    (op.tool === "create_invoice" && ["receivedInvoice", "commitment"].includes(op.header.type)) ||
    (op.tool === "create_cash_voucher" && op.header.type === "expense");
}

export function recordsIn(data: Fields): Fields[] {
  if (!data || typeof data !== "object") return [];
  for (const key of ["invoice", "voucher", "addressbook", "numericalSeries", "bank", "bankAccount"]) {
    if (data[key]) return array(data[key]);
  }
  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      const found = Array.isArray(value) ? value.flatMap(recordsIn) : recordsIn(value);
      if (found.length) return found;
    }
  }
  return [];
}

export async function lookupSupplierRegistry(registry: CzechRegistryClient | null, input: Fields): Promise<Fields> {
  const dic = normalizeDic(text(input.dic));
  const country = text(input.country || dic?.isoCountry || (input.ico ? "CZ" : "")).toUpperCase();
  if (country && country !== "CZ") return { status: "foreign", supplier: input, message: "ARES covers Czech suppliers only; choose VAT treatment explicitly." };
  if (!registry) return { status: "unavailable", supplier: input, message: "Registry lookup is disabled." };
  try {
    let subject: AresSubject | undefined;
    let freshness: Fields | undefined;
    if (input.ico) {
      const response = await registry.getByIco(text(input.ico), input.maxAgeSeconds);
      subject = response.value ?? undefined;
      freshness = response;
    } else if (input.name) {
      const response = await registry.search({ name: text(input.name), street: text(input.street), city: text(input.city), zip: text(input.zip) }, input.maxAgeSeconds);
      const match = matchSubjects({ name: text(input.name), street: text(input.street), city: text(input.city), zip: text(input.zip) }, response.value.subjects, response.value.total);
      if (match.decision !== "unique") return { status: "ambiguous", match, supplier: input };
      subject = response.value.subjects.find((s) => s.ico === match.ico);
      freshness = response;
    }
    if (!subject) return { status: "notFound", supplier: input };
    const address = mapAresAddress(subject.sidlo);
    if (address?.overLength.length) return { status: "ambiguous", message: "Registry address exceeds POHODA field lengths", fields: address.overLength };
    if (input.name && companyKey(input.name) !== companyKey(subject.obchodniJmeno)) {
      return { status: "ambiguous", message: "Source supplier name differs from ARES identity", supplier: input, registryName: subject.obchodniJmeno };
    }
    if (input.dic && subject.dic && normalizeDic(text(input.dic))?.normalized !== normalizeDic(subject.dic)?.normalized) {
      return { status: "ambiguous", message: "Source DIČ differs from the ARES identity", supplier: input, registryDic: subject.dic };
    }
    const candidates = adisCandidates(subject);
    const ids = [...new Set([...candidates.published, ...candidates.probes])];
    let vat: Fields = { status: "unknown", reason: "No VAT registry evidence" };
    if (ids.length) {
      try {
        const status = await registry.vatStatus(ids, input.maxAgeSeconds);
        vat = classifyVat(subject, status.value, status.fetchedAt);
      } catch (error) { vat = { status: "unknown", reason: text((error as Error).message) }; }
    }
    return { status: "matched", supplier: { name: subject.obchodniJmeno, ico: subject.ico, dic: subject.dic ?? "", street: address?.street ?? "", city: address?.city ?? "", zip: address?.zip ?? "", country: address?.country || "CZ" }, vat,
      fetchedAt: freshness?.fetchedAt, fromCache: freshness?.fromCache, ageSeconds: freshness?.ageSeconds };
  } catch (error) { return { status: "unavailable", supplier: input, message: text((error as Error).message) }; }
}

function headerOf(raw: Fields): Fields { return raw.invoiceHeader ?? raw.voucherHeader ?? raw.addressbookHeader ?? raw.numericalSeriesHeader ?? raw.bankHeader ?? raw.bankAccountHeader ?? raw; }
function identityOf(raw: Fields): Fields { const h = headerOf(raw); return h.partnerIdentity ?? h.identity ?? {}; }
function addressOf(raw: Fields): Fields { return identityOf(raw).address ?? {}; }
function summaryOf(raw: Fields): Fields { return raw.invoiceSummary ?? raw.voucherSummary ?? {}; }

function replaceHeader(header: Fields, normalized: Fields): void {
  // Policy omission is meaningful (PN VAT buckets/KH, small cash reference). Keep
  // shared supplier-plan references while actually removing fields the policy clears.
  for (const key of Object.keys(header)) if (!(key in normalized)) delete header[key];
  Object.assign(header, normalized);
}

function assertSameSupplier(left: Fields, right: Fields): void {
  const ico = (v: unknown) => text(v).replace(/\s/g, "").padStart(8, "0");
  if (left.partnerIco && right.partnerIco && ico(left.partnerIco) !== ico(right.partnerIco)) throw new Error("Conflicting IČO values for the same supplier.");
  if (left.partnerDic && right.partnerDic && normalizeDic(left.partnerDic)?.normalized !== normalizeDic(right.partnerDic)?.normalized) throw new Error("Conflicting DIČ values for the same supplier.");
  if (Number(left.partnerId) > 0 && Number(right.partnerId) > 0 && Number(left.partnerId) !== Number(right.partnerId)) throw new Error("Two address-book IDs match the same supplier; review duplicates.");
}

/** Compare stored facts against the normalized request, never replace source facts with an import warning. */
export function verifyExpense(header: Fields, raw: Fields, kind: "invoice" | "voucher"): Fields[] {
  const stored = headerOf(raw), summary = summaryOf(raw), differences: Fields[] = [];
  const compare = (field: string, expected: unknown, actual: unknown) => {
    if (text(expected) !== text(actual)) differences.push({ field, expected: expected ?? "", actual: actual ?? "" });
  };
  for (const field of ["date", "dateTax", "dateKHDPH", ...(kind === "invoice" ? ["dateAccounting", "dateDue", "symVar"] : ["datePayment"]), "originalDocument", "text"]) {
    if (header[field] || field === "dateKHDPH" || field === "originalDocument" || (field === "symVar" && header.cardPayment)) compare(field, header[field], stored[field]);
  }
  if (header.number) compare("number", header.number, stored.number?.numberRequested ?? stored.number?.ids);
  const storedVat = text(stored.classificationVAT?.ids || stored.classificationVAT?.classificationVATType);
  if (header.taxMode === "nonTax") compare("classificationVAT", "PN", storedVat);
  else if (["PN", "nonSubsume"].includes(storedVat)) differences.push({ field: "classificationVAT", expected: "taxable classification", actual: storedVat });
  else if (header.classificationVAT && header.classificationVAT !== "inland") compare("classificationVAT", header.classificationVAT, storedVat);
  // POHODA versions that do not export extId are verified through the intNote marker.
  const marker = text(header._retryMarker);
  if (text(stored.extId?.ids)) {
    compare("extId", header.extId, stored.extId?.ids);
    compare("extSystemName", header.extSystemName, stored.extId?.exSystemName);
  }
  if (marker) {
    if (!retryMarkersIn(stored.intNote).includes(marker)) differences.push({ field: "retryMarker", expected: marker, actual: retryMarkersIn(stored.intNote) });
  } else if (!text(stored.extId?.ids)) differences.push({ field: "extId", expected: header.extId ?? "", actual: "" });
  if (text(header.intNote).includes("Zdroj:") && !text(stored.intNote).replace(/\r\n/g, "\n").includes(text(header.intNote).replace(/\r\n/g, "\n"))) differences.push({ field: "intNote", expected: header.intNote, actual: stored.intNote });
  for (const field of ["accounting", "classificationKVDPH", "centre", "activity", "contract"]) {
    if (header[field]) compare(field, header[field], stored[field]?.ids);
  }
  if (header.accountIds) compare("accountIds", header.accountIds, stored.account?.ids);
  if (header.paymentType) compare("paymentType", header.paymentType, stored.paymentType?.paymentType ?? stored.paymentType?.ids);
  if (header.paymentAccountNumber) compare("paymentAccountNumber", header.paymentAccountNumber, stored.paymentAccount?.accountNo);
  if (header.paymentBankCode) compare("paymentBankCode", header.paymentBankCode, stored.paymentAccount?.bankCode);
  if (header.sourcePdfArchivePath) {
    const linked = verifyPdfAttachmentLink(header.sourcePdfArchivePath, raw);
    if (!linked.linked) {
      // Imports before per-document PDFs linked the whole original; name that case explicitly.
      const original = text(header._sourcePdf?.original?.path);
      const legacy = original !== "" && !header._sourcePdf?.wholeSource && linked.targets.some((target) => shortcutTargetsMatch(original, target));
      differences.push({ field: "sourcePdfAttachment", expected: header.sourcePdfArchivePath, actual: linked.targets, ...(legacy ? { code: PDF_LINK_FULL_SOURCE } : {}) });
    }
  }
  const partnerId = Number(identityOf(raw).id || 0);
  if (!partnerId || partnerId !== Number(header.partnerId)) differences.push({ field: "partnerId", expected: header.partnerId, actual: partnerId });
  if (header.partnerIco) compare("partnerIco", header.partnerIco, addressOf(raw).ico);
  if (header.partnerDic) compare("partnerDic", header.partnerDic, addressOf(raw).dic);
  const money = (field: string, expected: any, actual: any) => {
    try { if (toMinorUnits((moneyValue(expected) ?? 0) as number | string) !== toMinorUnits((moneyValue(actual) ?? 0) as number | string)) differences.push({ field, expected: expected ?? 0, actual: actual ?? 0 }); }
    catch { differences.push({ field, expected, actual, reason: "Unreadable amount" }); }
  };
  if (header.currency) {
    const fx = summary.foreignCurrency ?? {};
    compare("currency", header.currency, fx.currency?.ids);
    money("foreignTotal", header.currencyPriceSum ?? header.total, fx.priceSum);
    if (!(Number(fx.rate) > 0) || (Number(fx.rate) === 1 && Number(header.currencyRate) !== 1)) differences.push({ field: "currencyRate", expected: "Valid POHODA rate, not a fallback of 1", actual: fx.rate });
    if (!(Number(fx.amount) >= 1)) differences.push({ field: "currencyAmount", expected: "Positive exchange-rate unit", actual: fx.amount });
    if (header.currencyRate > 0 && Number(fx.rate) !== Number(header.currencyRate)) differences.push({ field: "currencyRate", expected: header.currencyRate, actual: fx.rate });
    if (header.homePayableCZK !== undefined) {
      try { money("homePayableCZK", header.homePayableCZK, sumHomeCurrency(summary.homeCurrency ?? {})); }
      catch (error) { differences.push({ field: "homePayableCZK", reason: String(error) }); }
    }
  } else {
    const home = summary.homeCurrency ?? {};
    for (const field of ["priceNone", "priceLow", "priceLowVAT", "priceLowSum", "priceHigh", "priceHighVAT", "priceHighSum", "price3", "price3VAT", "price3Sum"]) money(field, header[field], home[field]);
    money("roundingAmount", header.roundingAmount, home.round?.priceRound);
    try { money("total", header.total, sumHomeCurrency(home)); }
    catch (error) { differences.push({ field: "total", reason: String(error) }); }
  }
  return differences;
}

/** One instance per server; the queue covers lookup, numbering and write/read-back, not just an XML process. */
export class ExpenseImporter {
  constructor(private readonly client: PohodaClient, private readonly registry: CzechRegistryClient | null, private readonly pdfArchive: Pick<PdfArchive, "archive"> = new PdfArchive()) {}

  async run(operations: WriteBatchOperation[], dataPackId: string, target: TransportOptions): Promise<Fields> {
    const key = text(target.databaseOverride || this.client.getDatabase());
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    queues.set(key, tail);
    await previous.catch(() => {});
    const progress = { writeAttempted: false };
    try { return await this.execute(operations, dataPackId, target, progress); }
    catch (error) {
      const failure = error instanceof Error && Object.isExtensible(error) ? error : new Error(String(error));
      if (!("writeAttempted" in failure)) Object.assign(failure, { writeAttempted: progress.writeAttempted });
      throw failure;
    }
    finally { release(); if (queues.get(key) === tail) queues.delete(key); }
  }

  private async execute(input: WriteBatchOperation[], dataPackId: string, target: TransportOptions, progress: { writeAttempted: boolean }): Promise<Fields> {
    const ops = structuredClone(input);
    const expenses = ops.filter(isExpenseOperation);
    for (const op of expenses) {
      if (op.items.length) throw new Error("Expense imports require summary amounts and no invoice items.");
      if (op.header.sourceType !== "manual" && !op.header.sourcePdfPath) throw new Error("PDF imports require sourcePdfPath so the source can be archived and linked. Set sourceType=manual only for documents not imported from a PDF.");
      if (op.header.sourceType !== "manual" || op.header.sourcePdfPath) {
        // Canonical order is the original's page order; the page range is checked against the PDF before archiving.
        try { op.header.sourcePages = normalizeSourcePages(op.header.sourcePages); }
        catch { throw new Error("PDF imports require non-empty positive sourcePages."); }
      }
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text(op.header.vatPeriod))) throw new Error("Expense imports require vatPeriod in YYYY-MM format.");
    }
    const warnings: Fields[] = [];
    const suppliedContacts = new Map<WriteBatchOperation, ExpenseOperation>();
    for (const op of expenses) {
      if (op.tool === "create_other_liability") op.header.type = "commitment";
      const h = op.header;
      if (h.partnerIco && (!h.partnerCountry || h.partnerCountry === "CZ")) {
        const checked = normalizeIco(h.partnerIco);
        if (!checked.ok) throw new Error(`Invalid Czech supplier IČO (${checked.reason}); review the source before import.`);
        h.partnerIco = checked.ico;
      }
      if (h.partnerDic) {
        const checked = normalizeDic(h.partnerDic);
        if (checked?.warnings.length) throw new Error(`Supplier DIČ requires review: ${checked.warnings.join("; ")}`);
        if (checked) h.partnerDic = checked.normalized;
      }
      // Reject arithmetic/date errors before any supplier writes; numbering is resolved below.
      const lookup = Number(h.partnerId) > 0 && ["taxable", "nonTax"].includes(h.taxMode)
        ? { status: "existing", supplier: {} } as Fields
        : await lookupSupplierRegistry(this.registry, { ico: h.partnerIco, dic: h.partnerDic, name: h.partnerName, street: h.partnerStreet, city: h.partnerCity, zip: h.partnerZip, country: h.partnerCountry });
      if (lookup.status === "ambiguous") throw new Error(`Supplier requires review: ${JSON.stringify(lookup)}`);
      if (lookup.status === "matched") {
        const s = lookup.supplier;
        for (const [field, value] of Object.entries({ partnerName: s.name, partnerIco: s.ico, partnerDic: s.dic, partnerStreet: s.street, partnerCity: s.city, partnerZip: s.zip, partnerCountry: s.country })) {
          if (!h[field]) h[field] = value;
        }
        const hasVat = [h.priceLowVAT, h.priceHighVAT, h.price3VAT].some((v) => v !== undefined && Number(v) !== 0);
        const sourceChargesVat = hasVat ? true : h.sourceChargesVat;
        const treatment = decideNonPayerTreatment({ evidence: lookup.vat, supplierCountry: h.partnerCountry, documentChargesVat: sourceChargesVat });
        if ((!h.taxMode || h.taxMode === "auto") && !h.partnerVatStatus) {
          if (treatment.pn === "review" || treatment.pn === "explicit-decision") throw new Error(`VAT treatment requires review: ${treatment.reasons.join("; ")}`);
          h.partnerVatStatus = treatment.pn === "auto" ? "non-payer" : "payer";
          h.vatStatusEvidence = `ARES/ADIS ${lookup.vat.status}, checked ${lookup.fetchedAt}; source VAT presence confirmed`;
        }
        h._registry = { vatStatus: lookup.vat.status, checkedAt: lookup.fetchedAt };
        if (lookup.vat.status === "unknown" || lookup.vat.formerVatRegistration || lookup.vat.unreliablePayer || lookup.vat.ceased) warnings.push({ requestId: op.requestId, registryStatus: lookup.vat.status, reasons: lookup.vat.reasons });
      } else if (lookup.status === "unavailable") warnings.push({ requestId: op.requestId, registry: lookup.message });
      for (const candidate of ops) {
        if (candidate.tool !== "create_address") continue;
        const sourceIco = normalizeIco(candidate.data.ico);
        const sameIco = h.partnerIco && sourceIco.ok && sourceIco.ico === h.partnerIco;
        const sameDic = h.partnerDic && normalizeDic(candidate.data.dic)?.normalized === h.partnerDic;
        if (!sameIco && !sameDic) continue;
        assertSameSupplier(h, { partnerIco: candidate.data.ico, partnerDic: candidate.data.dic });
        suppliedContacts.set(candidate, op);
        h._suppliedAddress = { ...(h._suppliedAddress ?? {}), ...candidate.data };
        for (const [field, value] of Object.entries({ partnerName: candidate.data.company, partnerDic: candidate.data.dic, partnerStreet: candidate.data.street, partnerCity: candidate.data.city, partnerZip: candidate.data.zip, partnerCountry: candidate.data.country })) if (!h[field]) h[field] = value;
      }
    }
    // Supplier identity, before any write: one batched address-book read for the whole
    // batch. A caller's partnerId is only a claim and must match the document's IČO/DIČ
    // (else exact name) on a real record; IČO/DIČ resolving to several records is never
    // picked. Every affected row is reported together; nothing is written.
    const contacts = new Map<string, Fields>();
    if (expenses.length) {
      let book: AddressBookLookup;
      try { book = await readAddressBook(this.client, expenses.map((op) => op.header), target); }
      catch { throw Object.assign(new Error("Supplier lookup failed; no records were created."), { writeAttempted: false }); }
      const issues: Fields[] = [];
      expenses.forEach((op, index) => {
        const h = op.header, rowId = text(op.requestId) || `#${index + 1}`;
        const resolution = resolveSupplier(h, book);
        if (resolution.status === "verified" || resolution.status === "resolved") {
          h._addressRecord = resolution.record;
          h.partnerId = resolution.record!.id;
        } else if (resolution.status === "new") {
          delete h.partnerId;
          if (h._requireExistingSupplier) issues.push({ ...supplierEvidence(rowId, h, resolution), code: "SUPPLIER_NOT_FOUND", message: "Dodavatel není v adresáři POHODY a zakládání adres je vypnuto (createAddress=false)." });
          else if (!h.partnerName) issues.push({ ...supplierEvidence(rowId, h, resolution), code: "SUPPLIER_NAME_REQUIRED", message: "Dodavatel není v adresáři POHODY a pro založení adresy chybí jeho název." });
        } else issues.push(supplierEvidence(rowId, h, resolution));
      });
      if (issues.length) throw new SupplierIdentityError(issues);
      for (const op of expenses) {
        const h = op.header;
        const contactKey = h._addressRecord ? `id:${h._addressRecord.id}` : h.partnerIco ? `ico:${h.partnerIco}` : `dic:${dicKey(h.partnerDic)}`;
        // New contacts sharing IČO or DIČ become one contact; existing records are keyed by their verified ID.
        const prior = contacts.get(contactKey) ?? (h._addressRecord ? undefined : [...contacts.values()].find((plan) => !plan.record
          && ((h.partnerIco && plan.header.partnerIco === h.partnerIco) || (h.partnerDic && dicKey(plan.header.partnerDic) === dicKey(h.partnerDic)))));
        if (prior) {
          assertSameSupplier(prior.header, h);
          for (const field of ["partnerIco", "partnerDic", "partnerName", "partnerStreet", "partnerCity", "partnerZip", "partnerCountry"]) {
            if (!prior.header[field] && h[field]) prior.header[field] = h[field];
            if (!h[field] && prior.header[field]) h[field] = prior.header[field];
          }
          h._contactKey = prior.key;
        } else {
          contacts.set(contactKey, { header: h, key: contactKey, record: h._addressRecord });
          h._contactKey = contactKey;
        }
      }
    }
    // A later row can bridge two earlier incomplete new identities (IČO-only and
    // DIČ-only). Merge the whole connected set before creating either contact.
    let merged = true;
    while (merged) {
      merged = false;
      const plans = [...contacts.values()].filter((plan) => !plan.record);
      for (let a = 0; a < plans.length && !merged; a++) for (let b = a + 1; b < plans.length; b++) {
        const left = plans[a]!, right = plans[b]!, x = left.header, y = right.header;
        if (!((x.partnerIco && x.partnerIco === y.partnerIco) || (x.partnerDic && dicKey(x.partnerDic) === dicKey(y.partnerDic)))) continue;
        assertSameSupplier(x, y);
        for (const field of ["partnerIco", "partnerDic", "partnerName", "partnerStreet", "partnerCity", "partnerZip", "partnerCountry"]) if (!x[field] && y[field]) x[field] = y[field];
        x._suppliedAddress = { ...(y._suppliedAddress ?? {}), ...(x._suppliedAddress ?? {}) };
        for (const op of expenses) if (op.header._contactKey === right.key) op.header._contactKey = left.key;
        contacts.delete(right.key);
        merged = true;
        break;
      }
    }
    const contactPlans = [...contacts.values()];
    for (const plan of contactPlans) {
      const record: AddressRecord | undefined = plan.record;
      if (!record) continue;
      const h = record.header, addr = (h.identity ?? {}).address ?? {}, expected = plan.header;
      const storedIco = normalizeIco(addr.ico);
      plan.storedHeader = h;
      plan.id = record.id; plan.isSupplier = record.isSupplier;
      plan.patch = plan.isSupplier ? {} : { p1: true };
      // Only empty fields of the verified record are completed; its identity is never overwritten.
      for (const [field, source] of Object.entries({ company: "partnerName", ico: "partnerIco", dic: "partnerDic", street: "partnerStreet", city: "partnerCity", zip: "partnerZip" })) {
        if (!addr[field] && expected[source]) plan.patch[field] = expected[source];
        if (!expected[source] && addr[field]) expected[source] = field === "ico" && storedIco.ok ? storedIco.ico : addr[field];
      }
      for (const field of ["phone", "email"]) {
        if (!h[field] && expected._suppliedAddress?.[field]) plan.patch[field] = expected._suppliedAddress[field];
      }
    }
    for (const op of expenses) {
      const plan = contacts.get(op.header._contactKey)!;
      for (const field of ["partnerIco", "partnerDic", "partnerName", "partnerStreet", "partnerCity", "partnerZip"]) if (!op.header[field] && plan.header[field]) op.header[field] = plan.header[field];
      op.header._supplierIdentity = op.header.partnerIco ? `ico:${op.header.partnerIco}` : op.header.partnerDic ? `dic:${normalizeDic(op.header.partnerDic)?.normalized || op.header.partnerDic}` : `id:${plan.id}`;
    }

    // Reconcile explicitly supplied contacts again after resolving IDs/ARES aliases.
    for (const candidate of ops) {
      if (candidate.tool !== "create_address" || suppliedContacts.has(candidate)) continue;
      const ico = normalizeIco(candidate.data.ico), dic = normalizeDic(candidate.data.dic)?.normalized;
      const expense = expenses.find((op) => (ico.ok && op.header.partnerIco === ico.ico) || (dic && normalizeDic(op.header.partnerDic)?.normalized === dic));
      if (expense) {
        assertSameSupplier(expense.header, { partnerIco: candidate.data.ico, partnerDic: candidate.data.dic });
        suppliedContacts.set(candidate, expense);
        expense.header._suppliedAddress = { ...(expense.header._suppliedAddress ?? {}), ...candidate.data };
        const plan = contacts.get(expense.header._contactKey);
        if (plan?.id) for (const field of ["phone", "email"]) {
          if (!plan.storedHeader?.[field] && candidate.data[field]) (plan.patch ??= {})[field] = candidate.data[field];
        }
      }
    }
    // Source arithmetic/date validation also precedes the filesystem archive write.
    for (const op of expenses) replaceHeader(op.header, resolveExpensePolicy({ ...op.header, ...(op.header.cardPayment ? { cardSequence: 1 } : {}) }, op.items, op.tool === "create_cash_voucher" ? "voucher" : "invoice"));
    // Each document links a PDF with only its sourcePages; the original is archived unchanged.
    // The retry identity stays the original hash + pages (sourcePdfSha256), independent of the subset bytes.
    const pdfOps = expenses.filter((op) => op.header.sourcePdfPath);
    if (pdfOps.length) {
      const pdfs = new PdfDocumentArchiver(this.pdfArchive);
      try {
        // All pages are checked against their PDFs before the first archive write.
        const archived = await pdfs.archiveDocuments(pdfOps.map((op) => ({ sourcePath: text(op.header.sourcePdfPath), pages: op.header.sourcePages,
          context: { database: text(target.databaseOverride || this.client.getDatabase()), ico: text(target.dataPackIco), year: text(op.header.vatPeriod).slice(0, 4) } })));
        pdfOps.forEach((op, index) => {
          const document = archived[index]!;
          op.header.sourcePages = document.pages;
          op.header.sourcePdfArchivePath = document.path;
          op.header.sourcePdfSha256 = document.original.sha256;
          op.header.sourcePdfBytes = document.original.bytes;
          op.header._sourcePdf = { sha256: document.sha256, bytes: document.bytes, reused: document.reused, pageRanges: document.pageRanges, pageCount: document.pageCount, wholeSource: document.wholeSource, original: document.original };
        });
      } finally { await pdfs.close(); }
    }
    for (const op of expenses) {
      const normalized = resolveExpensePolicy({ ...op.header, ...(op.header.cardPayment ? { cardSequence: 1 } : {}) }, op.items, op.tool === "create_cash_voucher" ? "voucher" : "invoice");
      replaceHeader(op.header, normalized);
      const sourceKey = op.header.sourceDocumentNumber || (!op.header.cardPayment ? op.header.originalDocument : "") || (op.header.sourcePdfSha256 ? `pdf:${op.header.sourcePdfSha256}:${JSON.stringify(op.header.sourcePages)}` : "");
      if (!sourceKey && !op.header.extId) throw new Error("A source document number, explicit external ID, or archived PDF/page identity is required for safe expense retries.");
      const plan = contacts.get(op.header._contactKey)!;
      const identity = expenseIdentityCandidates(op.header, plan.id);
      op.header.extId = identity.extId;
      op.header._externalIdCandidates = identity.candidates;
      op.header.extSystemName ||= "pohoda-mcp-expenses";
      // Validate early: every candidate must form a verifiable marker.
      for (const candidate of op.header._externalIdCandidates as string[]) retryMarker(op.header.extSystemName, candidate);
      withRetryMarker(op.header.intNote, retryMarker(op.header.extSystemName, op.header.extId));
    }

    const seenDocuments = new Set<string>();
    for (const op of expenses) {
      const key = `${op.header.extSystemName}|${op.header.extId}`;
      if (seenDocuments.has(key)) throw new Error(`Duplicate source document in the same batch: ${op.header.sourceDocumentNumber || op.header.extId}`);
      seenDocuments.add(key);
    }

    // Retry recovery is checked before contact mutation and before attempting the same document again.
    // Scan the whole agenda/type for the affected accounting years (paged by idFrom) and match
    // locally; extId filters and supplier filters are never trusted to narrow the result.
    const existing = new Map<WriteBatchOperation, Fields>();
    const matchedBy = new Map<WriteBatchOperation, string>();
    if (expenses.length) {
      const groupOf = (op: ExpenseOperation) => op.tool === "create_cash_voucher" ? { agenda: "voucher", subType: "" } : { agenda: "invoice", subType: text(op.header.type) };
      const years = expenses.flatMap((op) => ["date", "dateTax", "dateAccounting", "dateKHDPH", "datePayment", "sourceIssueDate", "sourceTaxDate", "sourcePaymentDate", "vatPeriod"]
        .map((field) => Number(text(op.header[field]).slice(0, 4))).filter((year) => year > 1900));
      const window = { dateFrom: `${Math.min(...years)}-01-01`, dateTill: `${Math.max(...years)}-12-31` };
      const scanned = new Map<string, Fields[]>();
      for (const op of expenses) {
        const group = groupOf(op), key = `${group.agenda}|${group.subType}`;
        if (!scanned.has(key)) scanned.set(key, await this.scanAgenda(group.agenda, group.subType, window, target));
      }
      const claimed = new Map<string, ExpenseOperation>();
      for (const op of expenses) {
        const group = groupOf(op), rows = scanned.get(`${group.agenda}|${group.subType}`)!;
        const system = text(op.header.extSystemName);
        const candidates = new Map((op.header._externalIdCandidates as string[]).map((extId) => [retryMarker(system, extId), extId]));
        const hits = new Map<number, { row: Fields; extId: string; via: string }>();
        for (const row of rows) {
          const h = headerOf(row), id = Number(h.id);
          const marker = retryMarkersIn(h.intNote).find((m) => candidates.has(m));
          if (marker) { hits.set(id, { row, extId: candidates.get(marker)!, via: "retryMarker" }); continue; }
          const exported = text(h.extId?.ids);
          if (exported && text(h.extId?.exSystemName) === system && [...candidates.values()].includes(exported)) hits.set(id, { row, extId: exported, via: "extId" });
        }
        if (hits.size > 1) throw new Error(`Several POHODA records (IDs ${[...hits.keys()].join(", ")}) carry the retry identity of ${op.header.sourceDocumentNumber || op.header.extId}; review duplicates. No records were created.`);
        let hit = [...hits.values()][0];
        if (!hit && op.header.sourceDocumentNumber) {
          // Documents entered manually (or by older imports) without a marker.
          const supplierId = Number(contacts.get(op.header._contactKey)?.id);
          const manual = rows.filter((row) => text(headerOf(row).originalDocument) === text(op.header.sourceDocumentNumber)
            && ((supplierId > 0 && Number(identityOf(row).id) === supplierId)
              || (op.header.partnerIco && text(addressOf(row).ico) === text(op.header.partnerIco))));
          if (manual.length > 1) throw new Error("Several existing documents have the same supplier and source number; review required.");
          if (manual[0]) hit = { row: manual[0], extId: text(op.header.extId), via: "sourceDocument" };
        }
        if (!hit) continue;
        const id = Number(headerOf(hit.row).id), claimKey = `${group.agenda}|${id}`, other = claimed.get(claimKey);
        if (other) throw new Error(`Two batch documents (${other.header.sourceDocumentNumber || other.header.extId}, ${op.header.sourceDocumentNumber || op.header.extId}) match the same POHODA record ${id}; review required.`);
        claimed.set(claimKey, op);
        existing.set(op, hit.row);
        matchedBy.set(op, hit.via);
        op.header.extId = hit.extId;
      }
    }

    // Resolve the actual POHODA series, including positions consumed by larger card purchases.
    const cards = expenses.filter((op) => op.header.cardPayment && !existing.has(op));
    if (cards.length) {
      const response = await this.client.listRecords("numericalSeries", {}, "", target);
      if (!response.isOk()) throw new Error("Cannot read card number series.");
      const series = response.items.flatMap((item) => recordsIn(item.data)).map(headerOf);
      const counters = new Map<string, { next: number; width: number; prefix: string; id: number }>();
      for (const op of cards) {
        const h = op.header, prefix = `PK${text(h.vatPeriod).slice(2, 4)}`;
        let counter = counters.get(prefix);
        if (!counter) {
          const matches = series.filter((row) => (!row.agenda || row.agenda === "ostatni_zavazky") && (h.numberSeriesId ? Number(row.id) === Number(h.numberSeriesId) : (h.numberSeries ? row.prefix === h.numberSeries : row.prefix === prefix || `${row.prefix}${row.number}`.startsWith(prefix))) && (!row.year || text(row.year) === text(h.vatPeriod).slice(0, 4)));
          if (matches.length !== 1) throw new Error(`Card series ${prefix} must exist exactly once in this accounting unit.`);
          const row = matches[0]!, top = text(row.topNumber);
          const fullConfigured = `${row.prefix}${row.number}`;
          const configured = fullConfigured.startsWith(prefix) ? fullConfigured.slice(prefix.length) : text(row.number);
          const tail = top.startsWith(prefix) ? top.slice(prefix.length) : top;
          if (!/^\d+$/.test(configured) || (tail && !/^\d+$/.test(tail))) throw new Error(`Cannot determine next number for ${prefix}; inspect the series.`);
          counter = { next: Math.max(Number(configured), tail ? Number(tail) + 1 : 1), width: Math.max(configured.length, tail.length), prefix, id: Number(row.id) };
          counters.set(prefix, counter);
        }
        h.cardSequence = counter.next++;
        const requested = `${counter.prefix}${text(h.cardSequence).padStart(counter.width, "0")}`;
        if (h.number && h.number !== requested) throw new Error(`Requested card number ${h.number} does not match next POHODA number ${requested}.`);
        h.number = requested; h.numberSeries = prefix;
        if (counter.id) h.numberSeriesId = counter.id;
      }
    }
    for (const op of expenses) {
      const old = existing.get(op);
      if (old && op.header.cardPayment) {
        const previousNumber = text(headerOf(old).number?.numberRequested);
        const prefix = `PK${text(op.header.vatPeriod).slice(2, 4)}`;
        const suffix = previousNumber.startsWith(prefix) ? previousNumber.slice(prefix.length) : "";
        if (!/^\d+$/.test(suffix)) throw new Error(`Existing card number ${previousNumber} does not match ${prefix}.`);
        if (op.header.number && op.header.number !== previousNumber) throw new Error("Requested card number differs from the existing source document.");
        op.header.number = previousNumber; op.header.cardSequence = Number(suffix);
      }
      replaceHeader(op.header, resolveExpensePolicy(op.header, op.items, op.tool === "create_cash_voucher" ? "voucher" : "invoice"));
      // Last step after policy: the marker is the retry identity written and verified in intNote.
      op.header._retryMarker = retryMarker(op.header.extSystemName, op.header.extId);
      op.header.intNote = withRetryMarker(op.header.intNote, op.header._retryMarker);
    }
    const setup: WriteBatchOperation[] = [];
    for (const plan of contactPlans) {
      if (plan.id) {
        if (Object.keys(plan.patch ?? {}).length) setup.push({ tool: "manage_address", action: "update", match: { id: plan.id }, data: plan.patch });
      } else {
        const h = plan.header;
        setup.push({ tool: "manage_address", action: "add", match: h.partnerIco ? { ico: h.partnerIco } : { dic: h.partnerDic }, data: { ...(h._suppliedAddress ?? {}), company: h.partnerName, ico: h.partnerIco, dic: h.partnerDic, street: h.partnerStreet, city: h.partnerCity, zip: h.partnerZip, country: h.partnerCountry, p1: true } });
      }
    }
    this.client.validateWriteBatch?.([...setup, ...ops.filter((op) => !existing.has(op) && !suppliedContacts.has(op))]);
    const stableId = dataPackId || `expense-${createHash("sha256").update(JSON.stringify(expenses.map((op) => op.header.extId))).digest("hex").slice(0, 32)}`;
    const subsetId = (kind: string, payload: unknown) => `${stableId.slice(0, 32)}-${kind}-${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16)}`;
    if (setup.length) {
      progress.writeAttempted = true;
      const response = await this.client.writeBatch(setup, subsetId("contacts", setup), target);
      if (!response.isOk()) return { ok: false, state: "supplier_failed", database: target.databaseOverride || this.client.getDatabase(), dataPackId: stableId, warnings, supplierResponse: response.toArray(), results: [], message: "Supplier setup failed; no expense documents were submitted." };
      const read = await this.client.listRecordsBatch(contactPlans.map(({ header: h }) => ({ agenda: "addressbook", filter: h.partnerId ? { id: h.partnerId } : h.partnerIco ? { ico: h.partnerIco } : { dic: h.partnerDic }, options: { count: 2 } })), "", target);
      if (!read.isOk() || read.items.length !== contactPlans.length) throw new Error("Supplier verification failed; documents were not submitted.");
      read.items.forEach((item, i) => {
        const rows = recordsIn(item.data), plan = contactPlans[i]!;
        if (rows.length !== 1 || text(headerOf(rows[0]!).p1) !== "true") throw new Error(`Supplier ${plan.key} is not uniquely present and marked as supplier; no documents submitted.`);
        plan.id = Number(headerOf(rows[0]!).id);
      });
    }
    for (const op of expenses) op.header.partnerId = contacts.get(op.header._contactKey)!.id;
    const pending = ops.filter((op) => !existing.has(op) && !suppliedContacts.has(op));
    const pendingPackId = subsetId("docs", pending.map((op) => isExpenseOperation(op) ? op.header.extId : op));
    let response;
    try {
      if (pending.length) progress.writeAttempted = true;
      response = pending.length ? await this.client.writeBatch(pending, pendingPackId, target) : undefined;
    } catch {
      return { ok: false, state: "write_uncertain", database: target.databaseOverride || this.client.getDatabase(), dataPackId: stableId, warnings,
        results: ops.map((op) => ({ requestId: op.requestId, tool: op.tool, ok: false, created: "unknown", doNotRetry: true,
          ...(isExpenseOperation(op) ? { extId: op.header.extId, extSystemName: op.header.extSystemName, retryMarker: op.header._retryMarker, knownId: existing.has(op) ? headerOf(existing.get(op)!).id : undefined } : {}) })),
        message: "POHODA did not return a complete write response. Inspect POHODA for these retry markers (intNote) before resubmitting; a resubmission of the same documents first scans for the markers and does not recreate documents it finds." };
    }
    const output = response?.toArray();
    const outcomes = classifyExpenseWriteResponse(response, pendingPackId, pending.length);
    const results: Fields[] = [];
    const verifyRequests: Array<{ op: ExpenseOperation; id: number; result: Fields }> = [];
    let offset = 0;
    for (const op of ops) {
      const supplied = suppliedContacts.get(op);
      if (supplied) { results.push({ requestId: op.requestId, tool: op.tool, ok: true, state: "supplier_resolved", id: supplied.header.partnerId, verified: true }); continue; }
      const old = existing.get(op);
      if (old && isExpenseOperation(op)) {
        const checked = verifyExpense(op.header, old, op.tool === "create_cash_voucher" ? "voucher" : "invoice");
        const diffs = checked.filter((diff) => diff.code !== PDF_LINK_FULL_SOURCE);
        const legacy = checked.filter((diff) => diff.code === PDF_LINK_FULL_SOURCE).map((diff) => ({ code: PDF_LINK_FULL_SOURCE, linked: diff.actual, documentPdf: diff.expected,
          message: "Existující doklad odkazuje na celé zdrojové PDF ze staršího importu. PDF pouze se stránkami dokladu je uložené v documentPdf; opravte odkaz v POHODĚ na záložce Dokumenty. Doklad znovu neimportujte." }));
        results.push({ requestId: op.requestId, tool: op.tool, registry: op.header._registry, pdf: pdfResult(op.header), ok: diffs.length === 0 && legacy.length === 0, state: "already_exists", created: false, id: headerOf(old).id, matchedBy: matchedBy.get(op), retryMarker: op.header._retryMarker, verified: diffs.length === 0, differences: diffs, ...(legacy.length ? { reviewRequired: legacy } : {}), doNotRetry: true });
        continue;
      }
      const outcome = outcomes[offset++]!;
      const item = outcome.item;
      const result: Fields = { requestId: op.requestId, tool: op.tool, ...(isExpenseOperation(op) ? { registry: op.header._registry, pdf: pdfResult(op.header) } : {}), ok: outcome.outcome === "created", outcome: outcome.outcome, responseItemId: outcome.expectedItemId, state: item?.state ?? (outcome.outcome === "rejected" ? "error" : "missing"), producedDetails: item?.data.producedDetails, importDetails: item?.data.importDetails };
      results.push(result);
      if (isExpenseOperation(op)) {
        const id = outcome.id;
        const rejected = outcome.outcome === "rejected";
        result.created = id ? true : rejected ? false : "unknown"; result.id = id; result.doNotRetry = !rejected; result.retryMarker = op.header._retryMarker;
        const details = classifyImportDetails(item?.data);
        if (details.warnings.length) result.importWarnings = details.warnings;
        if (details.review.length) { result.reviewRequired = details.review; result.ok = false; }
        if (id) verifyRequests.push({ op, id, result });
        else { result.ok = false; result.verified = false; result.message = rejected
          ? "POHODA doklad odmítla a nevrátila ID. Po opravě, nové kontrole sešitu a novém výslovném pokynu lze zopakovat oficiální import."
          : "POHODA nevrátila použitelný výsledek pro tento doklad. Mohl vzniknout; nejprve ověřte retryMarker, zápis neopakujte naslepo."; }
      }
    }
    if (verifyRequests.length) {
      try {
        const verified = await this.client.listRecordsBatch(verifyRequests.map(({ op, id }) => ({ agenda: op.tool === "create_cash_voucher" ? "voucher" : "invoice", subType: op.tool === "create_cash_voucher" ? "" : op.header.type, filter: { id }, options: { restrictions: { "lst:attachments": true } } })), "", target);
        verifyRequests.forEach(({ op, id, result }, index) => {
          // Never trust a list filter blindly: keep only the record with the created ID.
          const rows = recordsIn(verified.items[index]?.data ?? {}).filter((row) => Number(headerOf(row).id) === id);
          const diffs = verified.isOk() && rows.length === 1 ? verifyExpense(op.header, rows[0]!, op.tool === "create_cash_voucher" ? "voucher" : "invoice") : [{ field: "readBack", expected: "one record", actual: rows.length }];
          result.verified = diffs.length === 0; result.differences = diffs; result.ok = result.ok && result.verified;
          if (diffs.length) result.message = "Document was created but differs from source. Review the differences; do not re-import.";
          else if (result.reviewRequired) result.message = "Document was created and matches the source fields, but POHODA reported an adjustment that needs review (see reviewRequired); do not re-import.";
          if (op.header.currency && rows[0]) result.appliedCurrency = summaryOf(rows[0]).foreignCurrency;
        });
      } catch (error) { for (const { result } of verifyRequests) { result.ok = false; result.verified = false; result.message = `Created; verification failed: ${(error as Error).message}. Do not re-import.`; } }
    }
    return { ok: results.every((r) => r.ok), state: results.some((r) => r.created === "unknown") ? "write_uncertain" : results.every((r) => r.ok) ? "ok" : "needs_review", database: target.databaseOverride || this.client.getDatabase(), dataPackId: stableId, operationCount: ops.length, transport: output?.transport, warnings, results };
  }

  /**
   * Read every record of one agenda/type in the date window, paged by idFrom.
   * Fails closed (throws before any write) when absence cannot be proven: a page
   * that ignores idFrom, repeats IDs, is not in ascending ID order when full, lacks
   * numeric IDs, or the scan exceeds the page bound. A server that ignores the
   * count limit simply returns a superset, which is still matched locally.
   */
  private async scanAgenda(agenda: string, subType: string, window: { dateFrom: string; dateTill: string }, target: TransportOptions): Promise<Fields[]> {
    return (await scanExpenseAgendas(this.client, [{ agenda, subType }], window, target, true)).get(`${agenda}|${subType}`)!;
  }
}


/** Stable identity shared by preview duplicate checks and the actual importer. */
export function expenseIdentityCandidates(header: Fields, partnerId?: number): { extId: string; candidates: string[] } {
  const sourceKey = header.sourceDocumentNumber || (!header.cardPayment ? header.originalDocument : "")
    || (header.sourcePdfSha256 ? `pdf:${header.sourcePdfSha256}:${JSON.stringify(header.sourcePages)}` : "");
  if (header.extId) return { extId: text(header.extId), candidates: [text(header.extId)] };
  const identities = [...new Set([
    header.partnerIco ? `ico:${header.partnerIco}` : "",
    header.partnerDic ? `dic:${normalizeDic(header.partnerDic)?.normalized || header.partnerDic}` : "",
    Number(partnerId ?? header.partnerId) > 0 ? `id:${partnerId ?? header.partnerId}` : ""
  ].filter(Boolean))];
  const hash = (identity: string, key = sourceKey) => createHash("sha256").update(JSON.stringify([identity, header.type, key])).digest("hex").slice(0, 32);
  const primary = header.sourcePdfSha256 ? hash("pdf", `${header.sourcePdfSha256}:${header.sourcePages.join(",")}`) : hash(identities[0] ?? "");
  return { extId: primary, candidates: [...new Set([primary, ...identities.map((identity) => hash(identity))])] };
}

/** Complete paged scan; all active agendas share a single XML read per page round. */
export async function scanExpenseAgendas(
  client: Pick<PohodaClient, "listRecordsBatch">,
  groups: Array<{ agenda: string; subType: string }>,
  filter: Fields,
  target: TransportOptions,
  attachments = false,
  pageSize = RETRY_SCAN_PAGE_SIZE
): Promise<Map<string, Fields[]>> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5_000) throw new Error("Invalid duplicate scan page size.");
  const states = [...new Map(groups.map((group) => [`${group.agenda}|${group.subType}`, {
    ...group, key: `${group.agenda}|${group.subType}`, rows: [] as Fields[], seen: new Set<number>(), idFrom: 0, pages: 0, done: false
  }])).values()];
  while (states.some((state) => !state.done)) {
    const active = states.filter((state) => !state.done);
    for (const state of active) if (state.pages >= RETRY_SCAN_MAX_PAGES) throw new Error(`Duplicate scan of ${state.key} exceeded its limit; cannot prove absence.`);
    const response = await client.listRecordsBatch(active.map((state) => ({
      agenda: state.agenda, subType: state.subType, filter,
      options: { count: pageSize, ...(state.idFrom ? { idFrom: state.idFrom } : {}), ...(attachments ? { restrictions: { "lst:attachments": true } } : {}) }
    })), "", target);
    if (!response.isOk() || response.items.length !== active.length) throw new Error("Duplicate scan failed or returned incomplete results; cannot prove absence.");
    active.forEach((state, index) => {
      const item = response.items[index]!;
      if (item.state && item.state !== "ok") throw new Error(`Duplicate scan of ${state.key} failed; cannot prove absence.`);
      const page = recordsIn(item.data);
      let last = 0, ascending = true;
      for (const row of page) {
        const id = Number(headerOf(row).id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Duplicate scan of ${state.key} returned a record without a numeric ID.`);
        if (state.seen.has(id) || (state.idFrom && id < state.idFrom)) throw new Error(`POHODA ignored idFrom paging while scanning ${state.key}; cannot prove absence.`);
        if (id <= last) ascending = false;
        last = id; state.seen.add(id); state.rows.push(row);
      }
      state.pages++;
      if (state.rows.length > RETRY_SCAN_PAGE_SIZE * RETRY_SCAN_MAX_PAGES) throw new Error(`Duplicate scan of ${state.key} exceeded its record limit.`);
      state.done = page.length < pageSize;
      if (!state.done && !ascending) throw new Error(`POHODA returned an unordered full page while scanning ${state.key}; cannot page safely.`);
      state.idFrom = last + 1;
    });
  }
  return new Map(states.map((state) => [state.key, state.rows]));
}
