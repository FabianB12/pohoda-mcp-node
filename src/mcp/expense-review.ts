/**
 * Reviewed-XLSX expense flow: prepare (read-only) -> user edits workbook -> explicit
 * approved import. Preparation and inspection never call the importer, never write to
 * POHODA and never archive PDFs. Import re-reads the edited workbook and the current
 * POHODA state, binds to the stored accounting unit and delegates writes to
 * ExpenseImporter.run, whose per-document external IDs make retries safe.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExpenseImporter } from "./expense-import.js";
import { recordsIn } from "./expense-import.js";
import type { ReviewAction, ReviewRow, ReviewTool, ReviewWorkbook, ReviewWorkbookRead } from "./review-contract.js";
import type { ListRecordsBatchRequest, PohodaClient, WriteBatchOperation } from "../pohoda/client.js";
import type { TransportOptions } from "../pohoda/transport.js";
import { canonicalExpenseText, MAX_TEXT_LENGTH, projectExpensePolicy, resolveExpensePolicy } from "../pohoda/expense-policy.js";
import { czechPolicyNotice, REVIEW_TEXT, ReviewRowError, reviewIssueOf, type ReviewIssue } from "./review-messages.js";
import { moneyValue, sumHomeCurrency, toMinorUnits } from "../pohoda/money.js";
import * as workbookCodec from "./review-workbook.js";
import { companyKey, decideNonPayerTreatment, normalizeDic, normalizeIco } from "../registry/czech-registry.js";
import { checkPreviewDuplicates, duplicateReviewNote } from "./expense-duplicates.js";
import { isStandardPaymentMethod, PAYMENT_METHOD_LABELS, reconcilePaymentMethod } from "./payment-method.js";
import { describeRecord, OK_STATUSES, readAddressBook, resolveSupplier, supplierEvidence, supplierLabel, type SupplierResolution } from "./supplier-identity.js";

type Fields = Record<string, any>;

export type ReviewWorkbookCodec = {
  writeReviewWorkbook(input: ReviewWorkbook, filePath: string): Promise<unknown>;
  readReviewWorkbook(filePath: string, bytes?: Uint8Array): Promise<ReviewWorkbookRead>;
  updateReviewDuplicateChecks?(filePath: string, checks: Record<string, import("./expense-duplicates.js").PreviewDuplicateCheck>, expectedSha256: string): Promise<void>;
};

export type ExpenseReviewOptions = {
  client: Pick<PohodaClient, "listRecordsBatch">;
  importer: Pick<ExpenseImporter, "run">;
  directory?: string;
  /** Defaults to the peer XLSX codec module; injectable for tests. */
  codec?: ReviewWorkbookCodec;
  /** History look-back in months before the VAT period (default 12). */
  historyMonths?: number;
  /** Read-only supplier enrichment before review; no contact writes. */
  lookupSupplier?: (input: Fields) => Promise<Fields>;
};

export type PrepareDocument = { requestId?: string; tool: ReviewTool; data: Fields; reviewNotes?: string };

/**
 * Workbook columns that may change POHODA data. Everything else comes from the manifest.
 * The address-book ID is not one of them: preparation resolves it from the supplier facts
 * and verifies it in POHODA; the workbook shows it read-only (see SUPPLIER_ID_FIELD).
 */
export const REVIEW_EDITABLE_FIELDS = [
  "text", "note", "accounting", "classificationVAT", "classificationKVDPH", "centre", "activity", "contract",
  "paymentType", "cashAccount", "accountIds", "paymentAccountNumber", "paymentBankCode", "taxMode", "sourceChargesVat",
  "partnerName", "partnerIco", "partnerDic", "partnerStreet", "partnerCity", "partnerZip", "partnerCountry",
  "partnerVatStatus", "vatStatusEvidence",
  "sourceIssueDate", "sourceTaxDate", "sourcePaymentDate", "sourceDocumentNumber", "sourceSymVar", "sourceDueDate",
  "date", "dateTax", "dateAccounting", "dateKHDPH", "datePayment", "dateDue", "originalDocument", "symVar",
  "cardPayment", "total", "roundingAmount", "priceNone", "priceLow", "priceLowVAT", "priceLowSum",
  "priceHigh", "priceHighVAT", "priceHighSum", "price3", "price3VAT", "price3Sum",
  "currency", "currencyRate", "currencyAmount", "currencyPriceSum", "homePayableCZK",
  "sourcePdfPath", "sourcePages"
] as const;
const EDITABLE = new Set<string>(REVIEW_EDITABLE_FIELDS);
/** Read-only verified address-book ID column; a caller value is only a claim to verify. */
const SUPPLIER_ID_FIELD = "partnerId";
/** Editing any of these makes the resolved address-book ID stale. */
const SUPPLIER_IDENTITY_FIELDS = ["partnerIco", "partnerDic", "partnerName", "partnerCountry"];
/** Never sent to POHODA from a review row, whatever the workbook or caller contains. */
const REVIEW_ONLY_KEYS = ["rowId", "action", "reviewNotes", "requestId", "items", "databaseId", "dataPackId"];
const TOOLS: ReviewTool[] = ["create_invoice", "create_other_liability", "create_cash_voucher"];
const ACTIONS: ReviewAction[] = ["import", "review", "skip"];
const MONEY_FIELDS = new Set(["total", "roundingAmount", "priceNone", "priceLow", "priceLowVAT", "priceLowSum", "priceHigh", "priceHighVAT", "priceHighSum", "price3", "price3VAT", "price3Sum", "currencyPriceSum", "homePayableCZK"]);
const DATE_FIELDS = new Set(["sourceIssueDate", "sourceTaxDate", "sourcePaymentDate", "sourceDueDate", "date", "dateTax", "dateAccounting", "dateKHDPH", "datePayment", "dateDue"]);
const SOURCE_FACT_FIELDS = ["sourceIssueDate", "sourceTaxDate", "sourcePaymentDate", "sourceDueDate", "sourceDocumentNumber", "sourceSymVar", "taxMode", "total", "priceNone", "priceLow", "priceLowVAT", "priceHigh", "priceHighVAT", "price3", "price3VAT", "roundingAmount", "currency", "homePayableCZK", "text", "accounting", "paymentType", "cardPayment"];
const PREFERRED_TEXT_LENGTH = 60;
const HISTORY_COUNT = 50;
const EXAMPLES_PER_QUERY = 5;
const LIST_BATCH = 25;
const REVIEW_ID = /^rv-[0-9a-f]{16}$/;
const ROW_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const locks = new Map<string, Promise<unknown>>();

/** Protect already-created rows even when their supplier/source edits would change the import marker. */
function reviewRowIdentity(tool: ReviewTool, data: Fields): string {
  const ico = text(data.partnerIco).replace(/\s+/g, "");
  const dic = text(data.partnerDic).replace(/\s+/g, "").toUpperCase();
  const supplier = ico ? ["ico", text(data.partnerCountry).toUpperCase(), ico] : dic ? ["dic", dic] : Number(data.partnerId) > 0 ? ["id", Number(data.partnerId)] : ["name", companyKey(text(data.partnerName))];
  const pages = Array.isArray(data.sourcePages) ? [...new Set(data.sourcePages)].sort((a: any, b: any) => Number(a) - Number(b)) : text(data.sourcePages);
  return JSON.stringify([tool, supplier, text(data.sourceDocumentNumber || data.originalDocument), text(data.sourcePdfPath), pages]);
}

function priorWrittenIdentity(manifest: Fields, rowId: string, original: Fields): string | undefined {
  for (const entry of [...(manifest.imports ?? [])].reverse()) {
    const written = entry.result?.results?.find((row: Fields) => row.requestId === rowId && Number(row.id) > 0 && (row.created === true || row.state === "already_exists" || row.outcome === "conflict"));
    if (written) return entry.rowIdentities?.[rowId] ?? reviewRowIdentity(original.tool, original.data);
  }
  return undefined;
}
/**
 * Manifest marker: target cells of rows the import rejects show the policy projection.
 * Older workbooks left every target cell of such rows blank; those blanks are not edits.
 * Version 3: Datum splatnosti is a policy target (source due date, else the issue date);
 * before it was a plain cell, blank when the source had no due date.
 */
const TARGET_PROJECTION_VERSION = 3;
const DUE_DATE_TARGET_VERSION = 3;

const text = (v: unknown): string => v == null ? "" : String(v).trim();
const firstValue = (...values: unknown[]): string => values.map(text).find(Boolean) ?? "";
const sha256 = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
const empty = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export class ReviewImportError extends Error {
  constructor(message: string, public readonly details: Fields = {}) { super(message); this.name = "ReviewImportError"; }
}

export class ExpenseReviewService {
  private readonly client: ExpenseReviewOptions["client"];
  private readonly importer: ExpenseReviewOptions["importer"];
  private readonly directory: string;
  private readonly codecOverride: ReviewWorkbookCodec | undefined;
  private readonly historyMonths: number;
  private readonly lookupSupplier: ExpenseReviewOptions["lookupSupplier"];

  constructor(options: ExpenseReviewOptions) {
    this.client = options.client;
    this.importer = options.importer;
    this.directory = resolve(options.directory ?? (process.env.POHODA_REVIEW_DIR || join(process.cwd(), "var", "reviews")));
    this.codecOverride = options.codec;
    this.historyMonths = Math.max(1, Math.min(36, options.historyMonths ?? 12));
    this.lookupSupplier = options.lookupSupplier;
  }

  /** Read-only: lists similar POHODA documents and writes only the review workbook and manifest. */
  async prepare(input: { databaseId: string; vatPeriod: string; documents: PrepareDocument[]; target: TransportOptions }): Promise<Fields> {
    const databaseId = text(input.databaseId);
    const vatPeriod = text(input.vatPeriod);
    if (!databaseId) throw new Error("databaseId is required; discover units with list_accounting_units.");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(vatPeriod)) throw new Error("vatPeriod must be YYYY-MM.");
    const target = explicitTarget(input.target);
    if (!Array.isArray(input.documents) || input.documents.length === 0) throw new Error("At least one document is required.");
    if (input.documents.length > 500) throw new Error("A review workbook holds at most 500 documents; split the batch.");

    const seen = new Set<string>();
    const drafts = input.documents.map((doc, index) => {
      if (!TOOLS.includes(doc?.tool)) throw new Error(`Document ${index + 1}: tool must be one of ${TOOLS.join(", ")}.`);
      const rowId = text(doc.requestId) || `R${String(index + 1).padStart(3, "0")}`;
      if (!ROW_ID.test(rowId)) throw new Error(`Document ${index + 1}: requestId "${rowId}" must match ${ROW_ID}.`);
      if (seen.has(rowId)) throw new Error(`Duplicate requestId/rowId ${rowId}.`);
      seen.add(rowId);
      return { rowId, tool: doc.tool, ...draftData(doc.tool, doc.data ?? {}, vatPeriod), callerNotes: text(doc.reviewNotes), supplier: undefined as Fields | undefined };
    });

    const reviewId = `rv-${sha256(JSON.stringify({ duplicateCheckVersion: 1, databaseId, target, vatPeriod, rows: drafts.map(({ rowId, tool, data }) => ({ rowId, tool, data })) })).slice(0, 16)}`;
    const folder = join(this.directory, reviewId);
    const manifestPath = join(folder, "manifest.json");
    const existing = await readJson(manifestPath);
    if (existing) {
      // Re-check fresh POHODA state, but only update our result/action columns.
      // User-edited input cells and helper columns are kept exactly as edited.
      const codec = await this.codec();
      const bytes = await readFile(existing.workbookPath);
      const workbook = await codec.readReviewWorkbook(existing.workbookPath, bytes);
      if (workbook.reviewId !== reviewId || workbook.databaseId !== databaseId || workbook.vatPeriod !== vatPeriod) throw new ReviewImportError("Existing workbook metadata differs from its prepared review.");
      const originals = new Map<string, Fields>(existing.rows.map((row: Fields) => [row.rowId, row]));
      const current = workbook.rows.map((row) => {
        const original = originals.get(row.rowId);
        if (!original || original.tool !== row.tool) throw new ReviewImportError("Existing workbook contains an unknown or changed document row.");
        return { rowId: row.rowId, tool: row.tool, data: mergeReviewedRow(original.tool, original.data, row.data, row.targets, legacyTargets(existing)).data };
      });
      const { snapshot: _snapshot, ...checks } = await checkPreviewDuplicates(this.client, current, target);
      if (!codec.updateReviewDuplicateChecks) throw new ReviewImportError("This workbook codec cannot safely refresh duplicate checks.");
      await codec.updateReviewDuplicateChecks(existing.workbookPath, checks.byRow, sha256(bytes));
      existing.duplicateCheck = checks;
      for (const row of existing.rows) row.duplicateCheck = checks.byRow[row.rowId] ?? row.duplicateCheck;
      await writeJsonAtomic(manifestPath, existing);
      // Row review issues do not make successful workbook preparation a tool error.
      return { ...(await this.inspect({ reviewId })), ok: true, reused: true, nextAction: "deliver_workbook", message: "Deliver workbookPath as a linked XLSX for user review, including when all rows need review. Existing edits were preserved and duplicate checks refreshed. Wait for explicit import approval." };
    }

    // Resolve identity/VAT evidence while still read-only, so automatic PN appears
    // in the review itself instead of changing an already-approved row at import.
    if (this.lookupSupplier) {
      const lookups = new Map<string, Promise<Fields>>();
      for (const draft of drafts) {
        const h = draft.data;
        const input = { ico: h.partnerIco, dic: h.partnerDic, name: h.partnerName, street: h.partnerStreet, city: h.partnerCity, zip: h.partnerZip, country: h.partnerCountry };
        const key = JSON.stringify(input);
        let request = lookups.get(key);
        if (!request) { request = this.lookupSupplier(input); lookups.set(key, request); }
        const lookup = await request;
        if (lookup.status === "matched") {
          const s = lookup.supplier;
          if (h.partnerName && s.name && companyKey(h.partnerName) !== companyKey(s.name)) {
            draft.blocking = true; draft.notes.push(REVIEW_TEXT.supplierName(h.partnerName, s.name));
          }
          const filled: string[] = [];
          for (const [field, value] of Object.entries({ partnerName: s.name, partnerIco: s.ico, partnerDic: s.dic, partnerStreet: s.street, partnerCity: s.city, partnerZip: s.zip, partnerCountry: s.country })) if (empty(h[field]) && !empty(value)) { h[field] = value; filled.push(field); }
          h._registryFilled = filled;
          // A registry country found by IČO can disagree with a foreign VAT id on the
          // source (e.g. a non-Czech IČO). Neither is assumed correct; the reviewer decides.
          const vatId = normalizeDic(text(h.partnerDic));
          if (filled.includes("partnerCountry") && vatId?.isoCountry && vatId.vatPrefix !== "CZ" && vatId.isoCountry !== text(h.partnerCountry).toUpperCase()) {
            draft.blocking = true; draft.notes.push(REVIEW_TEXT.registryCountry(text(h.partnerCountry), vatId.isoCountry, vatId.normalized));
          }
          h._registryEvidence = { vat: lookup.vat, fetchedAt: lookup.fetchedAt };
          if (!h.taxMode || h.taxMode === "auto") {
            const hasVat = [h.priceLowVAT, h.priceHighVAT, h.price3VAT].some((v) => v !== undefined && Number(v) !== 0);
            const treatment = decideNonPayerTreatment({ evidence: lookup.vat, supplierCountry: h.partnerCountry, documentChargesVat: hasVat ? true : h.sourceChargesVat });
            if (treatment.pn === "auto" || treatment.pn === "standard") {
              h.partnerVatStatus = treatment.pn === "auto" ? "non-payer" : "payer";
              h.vatStatusEvidence = `ARES/ADIS ${lookup.vat.status}, checked ${lookup.fetchedAt}; current status, not historical`;
            } else { draft.blocking = true; draft.notes.push(REVIEW_TEXT.vatTreatment); draft.issues.push({ code: "VAT_TREATMENT_REVIEW", message: REVIEW_TEXT.vatTreatment, detail: treatment.reasons.join("; ") }); }
          }
        } else if (lookup.status === "ambiguous") {
          draft.blocking = true; draft.notes.push(REVIEW_TEXT.registryAmbiguous);
        } else if (lookup.status === "notFound" && h.partnerIco) {
          draft.blocking = true; draft.notes.push(REVIEW_TEXT.registryNotFound);
        } else if (lookup.status === "unavailable") { draft.notes.push(REVIEW_TEXT.registryUnavailable); draft.issues.push({ code: "REGISTRY_UNAVAILABLE", message: REVIEW_TEXT.registryUnavailable, detail: text(lookup.message) }); }
      }
    }
    // A caller's address-book ID is only a claim: verify it (and resolve IDs for the
    // other rows) against real POHODA records before duplicates/history use it.
    await this.resolveSuppliers(drafts, target);
    // History is read before any workbook is written, scoped to the explicit unit.
    // Duplicate detection has its own complete snapshot; recent examples are not
    // evidence of absence. This never archives PDFs or writes accounting data.
    const { snapshot, ...duplicateCheck } = await checkPreviewDuplicates(this.client, drafts, target);
    const history = await this.readHistory(drafts.map((d) => ({ rowId: d.rowId, tool: d.tool, data: d.data })), vatPeriod, target, snapshot);
    const rows: ReviewRow[] = [];
    const sources: Fields = {};
    const rowIssueCodes = new Map<string, Fields[]>();
    for (const draft of drafts) {
      const notes: string[] = [...draft.notes];
      let blocking = draft.blocking;
      const data = draft.data;
      const found = history.byRow.get(draft.rowId);
      const suggestions: Fields[] = [];
      const duplicates = duplicateCheck.byRow[draft.rowId]!;
      if (duplicates.status !== "clear") { blocking = true; notes.push(duplicateReviewNote(duplicates)); }
      if (found) {
        for (const field of ["accounting", "text", "classificationVAT"] as const) {
          if (!empty(data[field])) continue;
          if (field === "classificationVAT" && (data.taxMode === "nonTax" || data.partnerVatStatus === "non-payer")) continue;
          const values = [...new Set(found.records.map((r) => text(r[field])).filter(Boolean))];
          if (field === "classificationVAT" && values.some((value) => ["PN", "nonSubsume"].includes(value))) continue;
          if (values.length === 1) {
            const value = values[0]!;
            if (field === "text" && value.length > MAX_TEXT_LENGTH) { notes.push(REVIEW_TEXT.historyTextTooLong(MAX_TEXT_LENGTH)); continue; }
            data[field] = field === "text" ? canonicalExpenseText(value) : value;
            const fromIds = found.records.filter((r) => text(r[field]) === value).map((r) => r.id);
            suggestions.push({ field, value: data[field], fromIds, rule: "unanimous same-supplier POHODA history" });

          } else if (values.length > 1) {
            notes.push(REVIEW_TEXT.historyChoices(field, values.length, values.slice(0, 4)));
          }
        }
        if (draft.tool === "create_cash_voucher" && empty(data.cashAccount)) {
          const accounts = [...new Set(found.records.map((r) => text(r.cashAccount)).filter(Boolean))];
          if (accounts.length) notes.push(REVIEW_TEXT.historyCashAccounts(accounts));
        }
      } else if (history.skipped.has(draft.rowId)) {
        notes.push(REVIEW_TEXT.noSupplier);
      }
      // History or caller labels are shown as POHODA will store them (PD, PHM nafta, ...).
      for (const suggestion of normalizeWrittenLabels(draft.tool, data)) {
        const entry = suggestions.find((s) => s.field === suggestion.field);
        if (entry) entry.value = suggestion.value;
      }
      const textLength = text(data.text).length;
      if (textLength > PREFERRED_TEXT_LENGTH && textLength <= MAX_TEXT_LENGTH) notes.push(REVIEW_TEXT.textLength(textLength, PREFERRED_TEXT_LENGTH));
      // List every missing/invalid source fact at once (Czech for the reviewer, codes as metadata).
      const policyIssues = rowIssues(draft.tool, data);
      const issues = [...draft.issues, ...policyIssues];
      for (const issue of policyIssues) { blocking = true; if (!notes.includes(issue.message)) notes.push(issue.message); }
      if (data.sourcePdfPath && !(await fileExists(text(data.sourcePdfPath)))) {
        blocking = true; notes.push(REVIEW_TEXT.pdfNotFound(text(data.sourcePdfPath))); issues.push({ code: "SOURCE_PDF_NOT_FOUND", message: REVIEW_TEXT.pdfNotFound(text(data.sourcePdfPath)) });
      }
      const reviewNotes = [draft.callerNotes, ...notes].filter(Boolean).join("\n");
      rows.push({ rowId: draft.rowId, tool: draft.tool, data, action: blocking ? "review" : "import", reviewNotes, duplicateCheck: duplicates });
      rowIssueCodes.set(draft.rowId, issues.map(({ code, field, detail }) => ({ code, ...(field ? { field } : {}), ...(detail ? { detail } : {}) })));
      sources[draft.rowId] = { query: found?.key, exampleIds: found?.records.map((r) => r.id) ?? [], suggestions, registryFilled: data._registryFilled ?? [], ...(draft.supplier ? { supplier: draft.supplier } : {}) };
    }

    const workbookPath = join(folder, `${reviewId}.xlsx`);
    await mkdir(folder, { recursive: true });
    const codec = await this.codec();
    const tmpWorkbook = `${workbookPath}.${randomBytes(6).toString("hex")}.tmp.xlsx`;
    try {
      await codec.writeReviewWorkbook({ reviewId, databaseId, vatPeriod, rows, examples: history.examples }, tmpWorkbook);
      await rename(tmpWorkbook, workbookPath);
    } catch (error) { await unlink(tmpWorkbook).catch(() => {}); throw error; }
    const manifest: Fields = {
      version: 1, targetProjection: TARGET_PROJECTION_VERSION, reviewId, createdAt: new Date().toISOString(), databaseId, target, vatPeriod, workbookPath,
      preparedWorkbookSha256: sha256(await readFile(workbookPath)),
      rows: rows.map((row) => ({ rowId: row.rowId, tool: row.tool, data: row.data, action: row.action, reviewNotes: row.reviewNotes, issues: rowIssueCodes.get(row.rowId) ?? [], duplicateCheck: row.duplicateCheck })),
      sourcePdfPaths: [...new Set(rows.map((r) => text(r.data.sourcePdfPath)).filter(Boolean))],
      sources, history: { queries: history.queries, warnings: history.warnings, exampleCount: history.examples.length },
      duplicateCheck, imports: []
    };
    await writeJsonAtomic(manifestPath, manifest);
    const pending = rows.filter((r) => r.action === "review").map((r) => r.rowId);
    return {
      ok: true, status: pending.length ? "requiresReview" : "readyForReview", reviewId, databaseId, vatPeriod, workbookPath,
      manifestPath, rowCount: rows.length, requiresReview: pending, historyWarnings: history.warnings, exampleCount: history.examples.length,
      duplicateCheck: { complete: duplicateCheck.complete, checkedAt: duplicateCheck.checkedAt, scannedRecords: duplicateCheck.scannedRecords, warnings: duplicateCheck.warnings, matchedRowIds: rows.filter((row) => row.duplicateCheck!.matchCount > 0).map((row) => row.rowId) },
      rowsTruncated: rows.length > 20,
      rows: rows.slice(0, 20).map((row) => ({ rowId: row.rowId, tool: row.tool, action: row.action, reviewNotes: row.reviewNotes, issues: rowIssueCodes.get(row.rowId) ?? [], duplicateCheck: row.duplicateCheck, preview: preflight(row.tool, row.data).preview })),
      nextAction: "deliver_workbook",
      message: "Preparation succeeded. Deliver workbookPath as a linked XLSX, including when all rows are duplicates or need review. requiresReview describes the rows, not a failed preparation. A findings summary alone is not completion. No POHODA records were changed. Wait for explicit import approval."
    };
  }

  /** Read-only: re-reads the (edited) workbook and reports what an import would do. */
  async inspect(input: { reviewId: string; workbookPath?: string }): Promise<Fields> {
    const manifest = await this.loadManifest(input.reviewId);
    const evaluation = await this.evaluate(manifest, input.workbookPath);
    const previous = latestSuccess(manifest, evaluation.workbookSha256, evaluation.selected.map((r) => r.rowId));
    const blocked = evaluation.errors.length > 0 || evaluation.unresolved.length > 0 || evaluation.invalid.length > 0 || evaluation.selected.length === 0;
    return {
      ok: !blocked || Boolean(previous),
      status: previous ? "imported" : blocked ? "requiresReview" : "readyForReview",
      reviewId: manifest.reviewId, databaseId: manifest.databaseId, vatPeriod: manifest.vatPeriod,
      workbookPath: evaluation.workbookPath, workbookSha256: evaluation.workbookSha256,
      errors: evaluation.errors, unresolved: evaluation.unresolved, invalid: evaluation.invalid,
      importRowIds: evaluation.selected.map((r) => r.rowId), skippedRowIds: evaluation.skipped, omittedRowIds: evaluation.omitted,
      ignoredEdits: evaluation.ignored, rows: evaluation.report,
      duplicateCheck: manifest.duplicateCheck,
      previousImports: (manifest.imports as Fields[]).map(({ at, workbookSha256, rowIds, ok, state, dataPackId }) => ({ at, workbookSha256, rowIds, ok, state, dataPackId }))
    };
  }

  /** Writes only with approved === true, after re-reading the edited workbook and current POHODA state. */
  async importReviewed(input: { reviewId: string; workbookPath?: string; expectedWorkbookSha256?: string; approved: boolean; target: TransportOptions; databaseId: string }): Promise<Fields> {
    if (input.approved !== true) throw new ReviewImportError("Import requires approved=true from an explicit user instruction; nothing was written.");
    const reviewId = text(input.reviewId);
    return withLock(reviewId, async () => {
      const manifest = await this.loadManifest(reviewId);
      if (text(input.databaseId) !== manifest.databaseId) throw new ReviewImportError(`Review ${reviewId} belongs to databaseId ${manifest.databaseId}, not ${text(input.databaseId) || "(empty)"}; nothing was written.`);
      const caller = explicitTarget(input.target);
      if (caller.databaseOverride !== manifest.target.databaseOverride || caller.dataPackIco !== manifest.target.dataPackIco) {
        throw new ReviewImportError("Resolved target database/ICO differs from the prepared review; nothing was written.", { prepared: manifest.target, requested: caller });
      }
      const target: TransportOptions = { databaseOverride: manifest.target.databaseOverride, dataPackIco: manifest.target.dataPackIco };
      const evaluation = await this.evaluate(manifest, input.workbookPath);
      if (input.expectedWorkbookSha256 && input.expectedWorkbookSha256 !== evaluation.workbookSha256) throw new ReviewImportError("Workbook changed since inspection. Inspect the edited workbook again before approving this version; nothing was written.");
      if (manifest.imports.some((entry: Fields) => entry.result?.state === "write_uncertain" || entry.result?.results?.some((r: Fields) => r.created === "unknown"))) throw new ReviewImportError("A previous write has an uncertain result. Verify the reported external IDs in POHODA before preparing a reconciled review; this review cannot be blindly retried.");
      if (evaluation.errors.length) throw new ReviewImportError(`Workbook does not match review ${reviewId}: ${evaluation.errors.join("; ")}`, { errors: evaluation.errors });
      if (evaluation.unresolved.length) throw new ReviewImportError(`Rows still marked review: ${evaluation.unresolved.join(", ")}. Resolve them (import or skip); nothing was written.`, { unresolved: evaluation.unresolved });
      if (evaluation.invalid.length) throw new ReviewImportError(`Edited rows fail validation: ${evaluation.invalid.map((r) => `${r.rowId}: ${r.error}`).join("; ")}. Nothing was written.`, { invalid: evaluation.invalid });
      if (!evaluation.selected.length) throw new ReviewImportError("No rows are marked import; nothing was written.");
      const rowIds = evaluation.selected.map((r) => r.rowId);
      const previous = latestSuccess(manifest, evaluation.workbookSha256, rowIds);
      if (previous) return { ok: true, status: "imported", repeated: true, reviewId, databaseId: manifest.databaseId, workbookSha256: evaluation.workbookSha256, dataPackId: previous.dataPackId, importedRowIds: rowIds, result: previous.result, message: "This approved workbook was already imported; returning the recorded result without writing." };

      // Current POHODA state is re-read for audit; the importer does the authoritative duplicate/extId recovery.
      const current = await this.readHistory(evaluation.selected.map((r) => ({ rowId: r.rowId, tool: r.tool, data: r.data })), manifest.vatPeriod, target);
      const currentState = Object.fromEntries(evaluation.selected.map((row) => {
        const found = current.byRow.get(row.rowId);
        const number = text(row.data.sourceDocumentNumber || row.data.originalDocument);
        return [row.rowId, { sameSourceNumber: number ? (found?.records ?? []).filter((r) => text(r.originalDocument) === number).map((r) => ({ id: r.id, number: r.number })) : [] }];
      }));
      const dataPackId = `${reviewId}-${evaluation.workbookSha256.slice(0, 12)}`;
      const operations = evaluation.selected.map((row) => ({ requestId: row.rowId, tool: row.tool, header: toolHeader(row.tool, row.data), items: [] }) as WriteBatchOperation);
      const report: Fields = { at: new Date().toISOString(), workbookPath: evaluation.workbookPath, workbookSha256: evaluation.workbookSha256, dataPackId, rowIds, rowIdentities: Object.fromEntries(evaluation.selected.map(row => [row.rowId, reviewRowIdentity(row.tool, row.data)])), skippedRowIds: evaluation.skipped, omittedRowIds: evaluation.omitted, currentState, historyWarnings: current.warnings };
      let result: Fields;
      try {
        result = await this.importer.run(operations, dataPackId, target);
      } catch (error) {
        const supplierIssues: Fields[] | undefined = Array.isArray((error as Fields).issues) ? (error as Fields).issues : undefined;
        const writeAttempted = (error as Fields)?.writeAttempted !== false;
        const state = writeAttempted ? "import_failed" : "rejected_before_write";
        Object.assign(report, { ok: false, state, writeAttempted, error: (error as Error).message, ...(supplierIssues ? { supplierIssues } : {}) });
        manifest.imports.push(report);
        await writeJsonAtomic(join(this.directory, reviewId, "manifest.json"), manifest);
        return { ok: false, status: "requiresReview", state, writeAttempted, reviewId, databaseId: manifest.databaseId, dataPackId, workbookSha256: evaluation.workbookSha256, error: (error as Error).message, ...(supplierIssues ? { supplierIssues } : {}), currentState, message: writeAttempted
          ? "Import se zastavil po možném zápisu do POHODY. Ověřte chybu a aktuální stav dokladů i adresáře. Další import vyžaduje opravu, novou kontrolu sešitu a nový výslovný pokyn."
          : "Import se zastavil před zápisem. Do POHODY se nic nezapsalo. Opravte uvedené řádky, znovu zkontrolujte sešit a po novém výslovném pokynu použijte oficiální import; existující doklady se znovu ověří a nebudou vytvořeny podruhé." };
      }
      Object.assign(report, { ok: result.ok === true, state: result.state, result });
      manifest.imports.push(report);
      await writeJsonAtomic(join(this.directory, reviewId, "manifest.json"), manifest);
      return { ok: result.ok === true, status: result.ok === true ? "imported" : "requiresReview", reviewId, databaseId: manifest.databaseId, vatPeriod: manifest.vatPeriod, workbookSha256: evaluation.workbookSha256, dataPackId, importedRowIds: rowIds, skippedRowIds: evaluation.skipped, omittedRowIds: evaluation.omitted, currentState, result };
    });
  }

  private async codec(): Promise<ReviewWorkbookCodec> {
    if (this.codecOverride) return this.codecOverride;
    return workbookCodec;
  }

  private async loadManifest(reviewId: string): Promise<Fields> {
    const id = text(reviewId);
    if (!REVIEW_ID.test(id)) throw new ReviewImportError(`Invalid reviewId "${id}".`);
    const manifest = await readJson(join(this.directory, id, "manifest.json"));
    if (!manifest || manifest.reviewId !== id) throw new ReviewImportError(`Review ${id} was not found.`);
    manifest.imports ??= [];
    return manifest;
  }

  /** Re-reads the workbook and merges whitelisted edits onto the stored rows. No writes. */
  private async evaluate(manifest: Fields, workbookPathInput?: string) {
    const workbookPath = resolve(text(workbookPathInput) || manifest.workbookPath);
    const bytes = await readFile(workbookPath);
    const workbookSha256 = sha256(bytes);
    const read = await (await this.codec()).readReviewWorkbook(workbookPath, bytes);
    const errors: string[] = [];
    for (const key of ["reviewId", "databaseId", "vatPeriod"] as const) {
      if (text(read?.[key]) !== text(manifest[key])) errors.push(`${key} is "${text(read?.[key])}", expected "${manifest[key]}"`);
    }
    const originals = new Map<string, Fields>((manifest.rows as Fields[]).map((row) => [row.rowId, row]));
    const allowedPdfs = new Set<string>((manifest.sourcePdfPaths as string[]) ?? []);
    const seen = new Set<string>();
    const selected: Array<{ rowId: string; tool: ReviewTool; data: Fields }> = [];
    const unresolved: string[] = [], skipped: string[] = [], invalid: Fields[] = [], ignored: Fields[] = [], report: Fields[] = [];
    for (const row of Array.isArray(read?.rows) ? read.rows : []) {
      const rowId = text(row?.rowId);
      const original = originals.get(rowId);
      if (!rowId || !original) { errors.push(`row ${rowId || "(empty)"} is not part of this review`); continue; }
      if (seen.has(rowId)) { errors.push(`row ${rowId} appears more than once`); continue; }
      seen.add(rowId);
      if (text(row.tool) && row.tool !== original.tool) { errors.push(`row ${rowId} changed document kind ${original.tool} -> ${row.tool}; prepare a new review instead`); continue; }
      const action = text(row.action).toLowerCase() as ReviewAction;
      if (!ACTIONS.includes(action)) { errors.push(`row ${rowId} has action "${text(row.action)}" (use import, review or skip)`); continue; }
      const merged = mergeReviewedRow(original.tool, original.data, row.data ?? {}, row.targets, legacyTargets(manifest));
      ignored.push(...merged.ignored.map((field) => ({ rowId, field })));
      const pdf = text(merged.data.sourcePdfPath);
      if (pdf && pdf !== text(original.data.sourcePdfPath) && !allowedPdfs.has(pdf)) { errors.push(`row ${rowId} sourcePdfPath ${pdf} is not one of the prepared source PDFs`); continue; }
      if (action === "skip") { skipped.push(rowId); report.push({ rowId, action, changedFields: merged.changed }); continue; }
      if (action === "review") unresolved.push(rowId);
      let check = preflight(original.tool, merged.data);
      const writtenIdentity = priorWrittenIdentity(manifest, rowId, original);
      if (writtenIdentity !== undefined && writtenIdentity !== reviewRowIdentity(original.tool, merged.data)) {
        check = { ok: false, code: "CREATED_ROW_IDENTITY_CHANGED", error: "Tento řádek už má doklad v POHODĚ. Při opakování nelze změnit dodavatele, číslo zdrojového dokladu ani zdrojové stránky; ověřte a opravte existující doklad, nezakládejte jej znovu." };
      }
      if (!check.ok && action === "import") invalid.push({ rowId, error: check.error, errorCode: check.code });
      if (action === "import") selected.push({ rowId, tool: original.tool, data: merged.data });
      report.push({ rowId, tool: original.tool, action, valid: check.ok, error: check.error, ...(check.code ? { errorCode: check.code } : {}), changedFields: merged.changed, supplier: supplierLink(merged.data), preview: check.preview });
    }
    const omitted = [...originals.keys()].filter((id) => !seen.has(id));
    return { workbookPath, workbookSha256, errors, selected, unresolved, skipped, invalid, ignored, omitted, report };
  }

  /**
   * Read-only, one batched address-book read. Only a verified or uniquely resolved record
   * is shown as "ID adresy"; a wrong, missing or ambiguous caller ID blocks the row with
   * evidence and is never displayed as valid. Real duplicate contacts are never picked.
   */
  private async resolveSuppliers(drafts: Array<{ rowId: string; data: Fields; notes: string[]; issues: ReviewIssue[]; blocking: boolean; supplier?: Fields | undefined }>, target: TransportOptions): Promise<void> {
    const facts: Fields[] = drafts.map((draft) => ({ ...draft.data, partnerId: draft.data._claimedPartnerId }));
    if (!facts.some((f) => f.partnerId || !empty(f.partnerIco) || !empty(f.partnerDic) || !empty(f.partnerName))) return;
    let book: Awaited<ReturnType<typeof readAddressBook>>;
    try { book = await readAddressBook(this.client, facts, target, { allowNameMatch: true }); }
    catch (error) {
      for (const draft of drafts) {
        const claimed = draft.data._claimedPartnerId;
        if (!claimed) { draft.notes.push(SUPPLIER_TEXT.bookUnavailable); continue; }
        draft.blocking = true;
        draft.notes.push(SUPPLIER_TEXT.claimUnavailable(claimed));
        draft.issues.push({ code: "SUPPLIER_LOOKUP_UNAVAILABLE", message: SUPPLIER_TEXT.claimUnavailable(claimed), detail: text((error as Error).message) });
      }
      return;
    }
    drafts.forEach((draft, index) => {
      const data = draft.data, resolution = resolveSupplier(facts[index]!, book, { allowNameMatch: true });
      const link = (r: SupplierResolution) => {
        data.partnerId = r.record!.id;
        data._partnerIdSource = { via: r.via, checkedAt: book.checkedAt, record: { id: r.record!.id, company: r.record!.company || r.record!.name, ico: r.record!.ico, dic: r.record!.dic }, ...(data._claimedPartnerId ? { claimedId: data._claimedPartnerId } : {}) };
      };
      draft.supplier = supplierEvidence(draft.rowId, facts[index]!, resolution);
      if (resolution.status === "verified" || resolution.status === "resolved") {
        link(resolution);
        if (resolution.nameDiffers) draft.notes.push(SUPPLIER_TEXT.nameDiffers(resolution.record!.company || resolution.record!.name, text(data.partnerName)));
        return;
      }
      if (resolution.status === "new") return;
      draft.blocking = true;
      draft.notes.push(resolution.message);
      draft.issues.push({ code: resolution.code, message: resolution.message });
      // The document facts, not the rejected ID, decide the supplier; shown for review.
      const alternative = resolution.alternative;
      if (alternative && (alternative.status === "verified" || alternative.status === "resolved")) {
        link(alternative);
        draft.notes.push(SUPPLIER_TEXT.replaced(supplierLabel(alternative.via), describeRecord(alternative.record!)));
      } else if (alternative?.status === "new") draft.notes.push(SUPPLIER_TEXT.willCreate);
      else if (alternative && !OK_STATUSES.has(alternative.status) && alternative.message && alternative.message !== resolution.message) {
        draft.notes.push(alternative.message);
        draft.issues.push({ code: alternative.code, message: alternative.message });
      }
    });
  }

  /** Batched, deduplicated, bounded read of same-supplier documents on the explicit unit. */
  private async readHistory(rows: Array<{ rowId: string; tool: ReviewTool; data: Fields }>, vatPeriod: string, target: TransportOptions, snapshot?: Map<string, Fields[]>) {
    const year = Number(vatPeriod.slice(0, 4)), month = Number(vatPeriod.slice(5, 7));
    const dateFrom = new Date(Date.UTC(year, month - 1 - this.historyMonths, 1)).toISOString().slice(0, 10);
    const dateTill = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const queries = new Map<string, { request: ListRecordsBatchRequest; rowIds: string[]; voucher: boolean; partnerId: number }>();
    const rowKey = new Map<string, string>();
    const skipped = new Set<string>();
    for (const row of rows) {
      const ico = text(row.data.partnerIco).replace(/\s/g, "");
      const name = text(row.data.partnerName);
      const partnerId = Number(row.data.partnerId) || 0;
      if (!ico && !name && !(snapshot && partnerId)) { skipped.add(row.rowId); continue; }
      const voucher = row.tool === "create_cash_voucher";
      const subType = voucher ? "" : row.tool === "create_other_liability" ? "commitment" : text(row.data.type) || "receivedInvoice";
      const request: ListRecordsBatchRequest = { agenda: voucher ? "voucher" : "invoice", subType, filter: { ...(ico ? { ico } : { company: name }), dateFrom, dateTill }, options: { count: HISTORY_COUNT } };
      const key = JSON.stringify([request, !ico && !name ? partnerId : 0]);
      rowKey.set(row.rowId, key);
      const entry = queries.get(key) ?? { request, rowIds: [], voucher, partnerId };
      entry.rowIds.push(row.rowId);
      queries.set(key, entry);
    }
    const warnings: string[] = [];
    const results = new Map<string, Fields[]>();
    const list = [...queries.entries()];
    if (snapshot) for (const [key, q] of list) {
      const matches = (snapshot.get(`${q.request.agenda}|${q.request.subType}`) ?? []).filter((raw) => {
        const h = headerOf(raw), address = h.partnerIdentity?.address ?? {};
        if (q.voucher && h.voucherType && h.voucherType !== "expense") return false;
        const date = text(h.date);
        if (date && (date < dateFrom || date > dateTill)) return false;
        const filter = q.request.filter as Fields;
        if (filter.ico) return text(address.ico).replace(/\s/g, "") === filter.ico;
        if (filter.company) return companyKey(address.company) === companyKey(filter.company);
        return Number(h.partnerIdentity?.id) === q.partnerId;
      }).map((raw) => comparable(raw, q.request)).sort((a, b) => text(b.date).localeCompare(text(a.date)) || Number(b.id) - Number(a.id));
      results.set(key, matches);
    }
    for (let start = 0; !snapshot && start < list.length; start += LIST_BATCH) {
      const chunk = list.slice(start, start + LIST_BATCH);
      try {
        const response = await this.client.listRecordsBatch(chunk.map(([, q]) => q.request), "", { ...target });
        if (!response.isOk() || response.items.length !== chunk.length) { warnings.push("POHODA history lookup failed for some suppliers; no examples were invented."); continue; }
        chunk.forEach(([key, q], index) => {
          const records = recordsIn(response.items[index]!.data)
            .filter((raw) => !q.voucher || !text(headerOf(raw).voucherType) || text(headerOf(raw).voucherType) === "expense")
            .map((raw) => comparable(raw, q.request))
            .sort((a, b) => text(b.date).localeCompare(text(a.date)) || Number(b.id) - Number(a.id));
          if (records.length >= HISTORY_COUNT) warnings.push(`History for ${JSON.stringify(q.request.filter)} hit the ${HISTORY_COUNT}-record bound; examples may be incomplete.`);
          results.set(key, records);
        });
      } catch (error) { warnings.push(`POHODA history lookup failed: ${(error as Error).message}`); }
    }
    const byRow = new Map<string, { key: string; records: Fields[] }>();
    for (const [rowId, key] of rowKey) { const records = results.get(key); if (records?.length) byRow.set(rowId, { key, records: records.slice(0, 10) }); }
    const examples: Fields[] = [];
    for (const [key, q] of queries) {
      for (const record of (results.get(key) ?? []).slice(0, EXAMPLES_PER_QUERY)) examples.push({ rowIds: q.rowIds.join(", "), ...record });
    }
    return { byRow, examples, warnings, skipped, queries: [...queries.values()].map((q) => ({ ...q.request, rowIds: q.rowIds })) };
  }
}

/** Czech reviewer text for supplier identity (kept with the logic that decides it). */
const SUPPLIER_TEXT = {
  bookUnavailable: "Adresář POHODY nebyl dostupný; dodavatel se ověří při importu.",
  claimUnavailable: (id: number) => `ID adresy ${id} nelze ověřit: adresář POHODY nebyl dostupný. Zadané ID se nepoužije; připravte kontrolu znovu.`,
  invalidClaim: (value: string) => `ID adresy „${value}“ není platné číslo adresy a bylo ignorováno.`,
  nameDiffers: (stored: string, source: string) => `Název v adresáři POHODY („${stored}“) se liší od dokladu („${source}“); adresa odpovídá podle IČO/DIČ.`,
  replaced: (by: string, record: string) => `Podle ${by} z dokladu je dodavatel v adresáři POHODY jako ${record}; ve sloupci ID adresy je toto ověřené ID.`,
  willCreate: "Dodavatel z dokladu v adresáři POHODY není; při importu se založí nová adresa.",
  idEdited: (value: string) => `ID adresy v POHODĚ (${value}) se nezadává ručně; dohledá se z IČO, DIČ nebo názvu dodavatele. Buňku vraťte nebo vymažte a dodavatele opravte ve sloupcích Dodavatel, IČO, DIČ.`,
  identifierRequired: "Dodavatel nemá IČO ani DIČ a není propojen s ověřenou adresou v POHODĚ; doplňte IČO nebo DIČ z dokladu.",
  staleWithoutIdentifier: "Dodavatel byl změněn a nemá IČO ani DIČ, takže původní ID adresy už neplatí; doplňte IČO nebo DIČ z dokladu, nebo připravte novou kontrolu."
} as const;

/** What the import links: the verified ID (or none = resolve/create from IČO/DIČ at import). */
function supplierLink(data: Fields): Fields {
  return {
    partnerId: empty(data.partnerId) ? null : Number(data.partnerId),
    ...(data._partnerIdSource ? { verifiedBy: data._partnerIdSource.via, record: data._partnerIdSource.record, checkedAt: data._partnerIdSource.checkedAt } : {}),
    ...(data._stalePartnerId ? { staleId: data._stalePartnerId, note: "Supplier edited; the import resolves it again from IČO/DIČ." } : {})
  };
}

function explicitTarget(target: TransportOptions | undefined): { databaseOverride: string; dataPackIco: string } {
  const databaseOverride = text(target?.databaseOverride), dataPackIco = text(target?.dataPackIco);
  if (!databaseOverride || !dataPackIco) throw new ReviewImportError("An explicit target database and dataPack ICO are required for every review operation.");
  return { databaseOverride, dataPackIco };
}

function draftData(tool: ReviewTool, input: Fields, vatPeriod: string): { data: Fields; notes: string[]; issues: ReviewIssue[]; blocking: boolean } {
  const data: Fields = {};
  const notes: string[] = [];
  const issues: ReviewIssue[] = [];
  let blocking = false;
  for (const [key, value] of Object.entries(input ?? {})) {
    if (REVIEW_ONLY_KEYS.includes(key) || key.startsWith("_")) continue;
    if (key === SUPPLIER_ID_FIELD) {
      // Never shown or imported as given: resolveSuppliers verifies it against POHODA first.
      if (Number(value) > 0) data._claimedPartnerId = Number(value);
      else if (!empty(value) && Number(value) !== 0) notes.push(SUPPLIER_TEXT.invalidClaim(text(value)));
      continue;
    }
    if (!EDITABLE.has(key) && !["type", "sourceType", "vatPeriod", "intNote"].includes(key)) {
      if (!empty(value)) notes.push(REVIEW_TEXT.unsupportedField(key));
      continue;
    }
    if (!empty(value)) data[key] = value;
  }
  if (Array.isArray(input?.items) && input.items.length) { blocking = true; notes.push(REVIEW_TEXT.itemsDropped); }
  if (data.vatPeriod && text(data.vatPeriod) !== vatPeriod) { blocking = true; notes.push(REVIEW_TEXT.vatPeriodReplaced(text(data.vatPeriod), vatPeriod)); }
  data.vatPeriod = vatPeriod;
  data.sourceType = text(data.sourceType) === "manual" ? "manual" : "pdf";
  // Put legacy aliases in the visible source columns. A reviewer must be able to
  // see and correct the actual facts used by the policy, not hidden fallback data.
  for (const [field, aliases] of Object.entries({
    sourceIssueDate: ["date"], sourceTaxDate: ["dateKHDPH", "dateTax"],
    sourcePaymentDate: ["datePayment"], sourceDocumentNumber: ["originalDocument"], sourceSymVar: ["symVar"],
    sourceDueDate: ["dateDue"]
  })) if (empty(data[field])) {
    const value = aliases.map((alias) => data[alias]).find((v) => !empty(v));
    if (!empty(value)) data[field] = value;
  }
  if (empty(data.total) && !empty(data.currencyPriceSum)) data.total = data.currencyPriceSum;
  // These aliases are represented by their visible source columns; retaining a
  // second hidden value could undo a reviewer clearing or correcting a cell.
  for (const key of ["date", "dateTax", "dateKHDPH", "datePayment", "dateDue", "originalDocument", "symVar", "currencyPriceSum"]) delete data[key];
  if (tool === "create_other_liability") data.type = "commitment";
  if (tool === "create_cash_voucher") data.type = "expense";
  if (tool === "create_invoice" && !["receivedInvoice", "commitment"].includes(text(data.type))) {
    if (data.type) { blocking = true; notes.push(REVIEW_TEXT.notExpense(text(data.type))); }
    data.type = "receivedInvoice";
  }
  // Forma úhrady is the single reviewed payment fact; a card flag is only an input alias.
  const payment = reconcilePaymentMethod(tool, data, "cardPayment" in data ? coerce("cardPayment", data.cardPayment) : undefined);
  if (payment.conflict) { blocking = true; notes.push(payment.conflict); }
  if (payment.notes.length) { blocking = true; notes.push(...payment.notes); }
  // Text is shown exactly as written to POHODA (fuel -> PHM nafta / PHM benzín, also in a mixed text).
  if (!empty(payment.data.text)) payment.data.text = canonicalExpenseText(payment.data.text);
  return { data: payment.data, notes, issues, blocking };
}

const legacyTargets = (manifest: Fields): LegacyTargets => ({
  rejectedBlank: !(Number(manifest.targetProjection) >= 2),
  dueDateBlank: !(Number(manifest.targetProjection) >= DUE_DATE_TARGET_VERSION)
});
/** Blank target cells an older workbook wrote that are not reviewer edits (see mapTargetEdits). */
type LegacyTargets = { rejectedBlank: boolean; dueDateBlank: boolean };
const CURRENT_TARGETS: LegacyTargets = { rejectedBlank: false, dueDateBlank: false };

const kindOf = (tool: ReviewTool) => tool === "create_cash_voucher" ? "voucher" as const : "invoice" as const;
const policyInput = (tool: ReviewTool, data: Fields): Fields => {
  const header = toolHeader(tool, data);
  return { ...header, ...(header.cardPayment === true ? { cardSequence: 1 } : {}) };
};

/**
 * Stores text and Členění DPH as the policy writes them (known aliases only: fuel-only
 * text, PDzjed -> PD for a domestic taxable row), so a history or caller value is never
 * shown differently from the XML. Returns the changed fields.
 */
function normalizeWrittenLabels(tool: ReviewTool, data: Fields): Array<{ field: string; value: string }> {
  let result: Fields;
  try { result = projectExpensePolicy(policyInput(tool, data), kindOf(tool)).result; } catch { return []; }
  const changed: Array<{ field: string; value: string }> = [];
  for (const field of ["text", "classificationVAT"]) {
    if (field === "classificationVAT" && result._expensePolicy?.taxMode !== "taxable") continue;
    if (!empty(data[field]) && !empty(result[field]) && text(result[field]) !== text(data[field])) { data[field] = result[field]; changed.push({ field, value: result[field] }); }
  }
  return changed;
}

/** Every reason the import rejects the row, in Czech, with machine codes for metadata. */
function rowIssues(tool: ReviewTool, data: Fields): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const check = preflight(tool, data);
  try { issues.push(...projectExpensePolicy(policyInput(tool, data), kindOf(tool)).issues.map(reviewIssueOf)); }
  catch (error) { issues.push(reviewIssueOf(error)); }
  if (!check.ok && !issues.some((issue) => issue.code === check.code)) issues.unshift({ code: check.code ?? "REVIEW_ERROR", message: check.error! });
  return issues.filter((issue, index) => issues.findIndex((i) => i.message === issue.message) === index);
}

/** Visible POHODA target cell -> the source field an edit of it changes (see mapTargetEdits). */
const TARGET_SOURCE: Record<string, string> = {
  targetDocument: "sourceDocumentNumber", targetSymVar: "sourceSymVar",
  targetDate: "sourceIssueDate", targetDateTax: "sourceTaxDate", targetDateAccounting: "dateAccounting", targetDateKHDPH: "sourceTaxDate", targetDateDue: "sourceDueDate",
  targetPriceNone: "priceNone", targetPriceLow: "priceLow", targetPriceLowVAT: "priceLowVAT", targetPriceHigh: "priceHigh", targetPriceHighVAT: "priceHighVAT",
  targetPrice3: "price3", targetPrice3VAT: "price3VAT", targetRounding: "roundingAmount", targetTotal: "total"
};
const BUCKET_SUM: Record<string, string> = { priceLow: "priceLowSum", priceLowVAT: "priceLowSum", priceHigh: "priceHighSum", priceHighVAT: "priceHighSum", price3: "price3Sum", price3VAT: "price3Sum" };
const TARGET_LABELS = new Map(workbookCodec.REVIEW_COLUMNS.map((c) => [c.key, c.label]));

function sameTarget(key: string, a: unknown, b: unknown): boolean {
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  if (key.startsWith("targetPrice") || key === "targetRounding" || key === "targetTotal") {
    try { return toMinorUnits(a as string | number) === toMinorUnits(b as string | number); } catch { return false; }
  }
  return text(a) === text(b);
}

/**
 * mergeRow plus the two reviewed-preview contracts:
 * - Forma úhrady decides the card flag (PK numbering); an old "Platba kartou" column is
 *   still read and a contradiction blocks import.
 * - Visible cells show what POHODA receives. An edited target cell is mapped to its
 *   source field, the policy is re-run and the result must equal the edit; otherwise the
 *   row is invalid with an explanation. Unchanged target cells are never read as data, but
 *   every visible target cell must equal what is imported: a cell left stale by another
 *   edit blocks the row until the reviewer updates it (inspect lists the value to type).
 */
function mergeReviewedRow(tool: ReviewTool, original: Fields, decoded: Fields, targets?: Fields, legacy: LegacyTargets = CURRENT_TARGETS): { data: Fields; changed: string[]; ignored: string[] } {
  const vatPeriod = text(original.vatPeriod);
  const before = workbookCodec.computeReviewTargets({ tool, data: original }, vatPeriod);
  const edits: Fields = { ...(decoded ?? {}) };
  const legacyCard = "cardPayment" in edits ? coerce("cardPayment", edits.cardPayment) : undefined;
  delete edits.cardPayment;
  // Členění DPH shows the written value (PN for non-tax rows); PN on/off is the VAT mode.
  let taxSwitch: string | undefined;
  if ("classificationVAT" in edits) {
    const shown = text(before.classificationVAT ?? original.classificationVAT);
    const now = text(edits.classificationVAT);
    if (now === shown) edits.classificationVAT = original.classificationVAT ?? "";
    else if (now === "PN") taxSwitch = "nonTax";
    else if (now && (shown === "PN" || !before.classificationVAT)) taxSwitch = "taxable";
  }
  const merged = mergeRow(original, edits);
  if (taxSwitch && !merged.changed.includes("taxMode")) { merged.data.taxMode = taxSwitch; merged.changed.push("taxMode"); }
  const baseline = reconcilePaymentMethod(tool, original, original.cardPayment).data;
  const result = reconcilePaymentMethod(tool, merged.data, legacyCard);
  merged.data = result.data;
  delete merged.data._paymentReviewError;
  delete merged.data._targetReviewError;
  for (const key of ["paymentType", "cardPayment"]) {
    const differs = !sameValue(merged.data[key], baseline[key]);
    const at = merged.changed.indexOf(key);
    if (differs && at < 0) merged.changed.push(key);
    if (!differs && at >= 0) merged.changed.splice(at, 1);
  }
  const method = text(merged.data.paymentType);
  const editedUnknown = merged.changed.includes("paymentType") && method && !isStandardPaymentMethod(method);
  const error = result.conflict ?? (editedUnknown ? `Forma úhrady "${method}" není známá; použijte ${Object.values(PAYMENT_METHOD_LABELS).join(", ")}. Neznámou zkratku z POHODY nelze zadat v kontrole, připravte ji ve zdrojových datech.` : undefined);
  if (error) merged.data._paymentReviewError = error;
  delete merged.data._registryReviewError;
  // An older workbook left every target cell of a rejected row blank: those blanks are not edits.
  const rejectedBlank = legacy.rejectedBlank && Boolean(workbookCodec.reviewPolicyIssue({ tool, data: original }, vatPeriod));
  // An older workbook showed Datum splatnosti as the plain source value (blank when the
  // source had none): that unchanged cell is not an edit, but it is stale once importable.
  const oldDueDate = legacy.dueDateBlank ? firstValue(original.sourceDueDate, original.dateDue) : undefined;
  const priorLayout = ([key, value]: TargetCell): boolean => (rejectedBlank && empty(value) && !empty(before[key]))
    || (oldDueDate !== undefined && key === "targetDateDue" && sameTarget(key, value, oldDueDate) && !sameTarget(key, value, before[key]));
  const errors = [mapTargetEdits(tool, merged, original, before, targets ?? {}, vatPeriod, priorLayout), ...writtenLabelErrors(tool, merged.data, decoded ?? {}, vatPeriod)].filter(Boolean);
  if (errors.length) merged.data._targetReviewError = errors.join(" ");
  return merged;
}

/** Text and Členění DPH cells must show what the policy writes (no silent PDzjed -> PD). */
function writtenLabelErrors(tool: ReviewTool, data: Fields, decoded: Fields, vatPeriod: string): string[] {
  const errors: string[] = [];
  const shownText = text(data.text);
  const writtenText = canonicalExpenseText(shownText);
  if (shownText && writtenText !== shownText) errors.push(REVIEW_TEXT.writtenAs("Text dokladu", shownText, writtenText));
  if ("classificationVAT" in decoded) {
    const shown = text(decoded.classificationVAT);
    const written = text(workbookCodec.computeReviewTargets({ tool, data }, vatPeriod).classificationVAT);
    if (shown && written && shown !== written) errors.push(REVIEW_TEXT.writtenAs("Členění DPH", shown, written));
  }
  return errors;
}

type TargetCell = [string, unknown];

function mapTargetEdits(tool: ReviewTool, merged: { data: Fields; changed: string[] }, original: Fields, before: Fields, targets: Fields, vatPeriod: string, priorBlank: (cell: TargetCell) => boolean = () => false): string | undefined {
  const cells: TargetCell[] = Object.entries(targets).filter(([key]) => key in TARGET_SOURCE);
  const edited = cells.filter((cell) => !sameTarget(cell[0], cell[1], before[cell[0]]) && !priorBlank(cell));
  const label = (key: string) => TARGET_LABELS.get(key) ?? key;
  const shown = (v: unknown) => empty(v) ? "(prázdné)" : String(v);
  // Applies target edits to a copy; the targets are what the import would write.
  const trial = (mapped: TargetCell[]) => {
    const row = { data: structuredClone(merged.data), changed: [...merged.changed] };
    const errors = assignTargetEdits(row, mapped, edited, label);
    recheckRegistry(row, original);
    // A registry/VAT decision error is reported by preflight; targets cannot be judged before it.
    const after: Fields = row.data._registryReviewError ? {} : workbookCodec.computeReviewTargets({ tool, data: row.data }, vatPeriod);
    return { row, errors, after };
  };
  const matches = (after: Fields, [key, value]: TargetCell) => Object.keys(after).length > 0 && sameTarget(key, after[key], value);
  // A cell typed to the value other edits already produce (new rounding after a Celkem
  // edit, gross in Bez DPH / PN after switching to PN) is the reviewer bringing a dependent
  // cell up to date, not a new source fact. Only the remaining edits change source fields.
  const base = trial([]).after;
  let mapped = edited.filter((cell) => !matches(base, cell));
  for (const cell of [...mapped]) {
    const without = mapped.filter((c) => c !== cell);
    const attempt = trial(without);
    if (!attempt.errors.length && matches(attempt.after, cell) && without.every((c) => matches(attempt.after, c))) mapped = without;
  }
  const { row, errors, after } = trial(mapped);
  merged.data = row.data;
  merged.changed.splice(0, merged.changed.length, ...row.changed);
  if (Object.keys(after).length) {
    const policy = policyOf(tool, merged.data);
    for (const [key, value] of edited) {
      if (!sameTarget(key, after[key], value)) errors.push(`${label(key)}: ${shown(value)} nelze zapsat, podle pravidel importu bude ${shown(after[key])}${targetLockReason(key, policy, tool)}.`);
    }
    // The table must show what is imported: an unchanged cell made stale by another edit
    // (Členění DPH, Forma úhrady, Celkem, ...) blocks the row until the reviewer updates it.
    // A legacy cell is stale only once the row is importable (it must then show the values).
    const importable = !workbookCodec.reviewPolicyIssue({ tool, data: merged.data }, vatPeriod);
    const stale = cells.filter((cell) => !(priorBlank(cell) && !importable))
      .filter(([key, value]) => !edited.some(([k]) => k === key) && !sameTarget(key, after[key], value))
      .map(([key, value]) => `${label(key)} ${shown(value)} → ${empty(after[key]) ? "vymazat" : String(after[key])}`);
    if (stale.length) errors.push(`Po úpravách tabulka neukazuje importované hodnoty: ${stale.join("; ")}. Přepište tyto buňky (sbalené sloupce rozbalte).`);
  }
  return errors.length ? [...new Set(errors)].join(" ") : undefined;
}

/** Maps target edits onto source fields of `row` (mutated). Conflicting edits of one field are errors. */
function assignTargetEdits(row: { data: Fields; changed: string[] }, mapped: TargetCell[], edited: TargetCell[], label: (key: string) => string): string[] {
  const { data, changed } = row, errors: string[] = [];
  const assigned = new Map<string, unknown>();
  for (const [key, value] of mapped) {
    // Distinct Datum DPH and Datum KH edits: KH is the DUZP, Datum DPH a requested override.
    const field = key === "targetDateTax" && edited.some(([k, v]) => k === "targetDateKHDPH" && !sameTarget(key, v, value)) ? "dateTax" : TARGET_SOURCE[key]!;
    const previous = assigned.has(field) ? assigned.get(field) : changed.includes(field) ? data[field] : undefined;
    if ((assigned.has(field) || changed.includes(field)) && !sameValue(previous, value, field)) {
      errors.push(`${label(key)}: upraveno současně s jinou hodnotou téhož údaje; ponechte jednu úpravu.`);
      continue;
    }
    assigned.set(field, value);
  }
  for (const [field, value] of assigned) {
    if (empty(value)) delete data[field]; else data[field] = typeof value === "string" ? value.trim() : value;
    if (BUCKET_SUM[field]) delete data[BUCKET_SUM[field]!];
    if (!changed.includes(field)) changed.push(field);
  }
  if (assigned.has("sourceTaxDate") && !assigned.has("dateTax")) delete data.dateTax;
  if (assigned.has("sourceDueDate")) delete data.dateDue;
  // Edited VAT amounts are the reviewer's statement of whether the document charges VAT.
  if (["priceLowVAT", "priceHighVAT", "price3VAT"].some((field) => assigned.has(field))) {
    const chargesVat = ["priceLowVAT", "priceHighVAT", "price3VAT"].some((field) => !empty(data[field]) && Number(data[field]) !== 0);
    if (data.sourceChargesVat !== chargesVat) { data.sourceChargesVat = chargesVat; if (!changed.includes("sourceChargesVat")) changed.push("sourceChargesVat"); }
  }
  return errors;
}

function policyOf(tool: ReviewTool, data: Fields): Fields {
  try { const header = toolHeader(tool, data); return resolveExpensePolicy({ ...header, ...(header.cardPayment === true ? { cardSequence: 1 } : {}) }, [], tool === "create_cash_voucher" ? "voucher" : "invoice")._expensePolicy ?? {}; }
  catch { return {}; }
}

function targetLockReason(key: string, policy: Fields, tool: ReviewTool): string {
  if (key === "targetDateDue" && tool === "create_cash_voucher") return " (pokladní doklad nemá v POHODĚ datum splatnosti)";
  if (key === "targetDateDue" && policy.dueDateRule === "issue-date") return " (doklad bez splatnosti je splatný dnem vystavení)";
  if (key === "targetDateDue") return "";
  if (key.startsWith("targetDate") && policy.lateSource) return " (pozdní doklad: data jsou 1. den období DPH; původní data zůstávají v interní poznámce)";
  if (key === "targetDateKHDPH" && policy.taxMode === "nonTax") return " (PN nemá datum KH)";
  if (key === "targetDateAccounting" && tool === "create_cash_voucher") return " (pokladní doklad nemá účetní datum)";
  if ((key === "targetDocument" || key === "targetSymVar") && policy.originalDocumentRule === "card-sequence") return " (číslo přidělí import z řady PK)";
  if (key === "targetDocument" && policy.originalDocumentRule === "omitted-at-or-below-threshold") return " (hotovost do 10 000 Kč je bez čísla dokladu)";
  if (key.startsWith("targetPrice") && policy.taxMode === "nonTax") return " (PN: celá částka je v Bez DPH / PN)";
  return "";
}

/** Starts from the stored row; only whitelisted workbook columns can change it. */
function mergeRow(original: Fields, decoded: Fields): { data: Fields; changed: string[]; ignored: string[] } {
  const data: Fields = structuredClone(original);
  const changed: string[] = [], ignored: string[] = [];
  for (const [key, raw] of Object.entries(decoded ?? {})) {
    if (key === SUPPLIER_ID_FIELD) {
      // Read-only: clearing drops the link (the import resolves the supplier again);
      // a different number is never accepted as an identity.
      const value = coerce(key, raw);
      if (empty(value)) { if (!empty(data.partnerId)) { delete data.partnerId; delete data._partnerIdSource; changed.push(key); } }
      else if (!sameValue(value, original.partnerId, key)) data._partnerIdReviewError = SUPPLIER_TEXT.idEdited(text(value));
      continue;
    }
    if (!EDITABLE.has(key)) {
      if (!REVIEW_ONLY_KEYS.includes(key) && !sameValue(raw, original[key])) ignored.push(key);
      continue;
    }
    const value = coerce(key, raw);
    if (empty(value) || (Array.isArray(value) && !value.length)) {
      if (key in data) { delete data[key]; changed.push(key); }
    } else if (!sameValue(value, original[key], key)) {
      data[key] = value; changed.push(key);
    }
  }
  // Clearing or correcting a visible source cell must not resurrect its old
  // value through an invisible legacy alias preserved in the manifest.
  const aliases: Record<string, string[]> = {
    sourceIssueDate: ["date"], sourceTaxDate: ["dateTax", "dateKHDPH"],
    sourcePaymentDate: ["datePayment"], sourceDocumentNumber: ["originalDocument"], sourceSymVar: ["symVar"], sourceDueDate: ["dateDue"]
  };
  for (const field of changed) for (const alias of aliases[field] ?? []) delete data[alias];
  // The ID was resolved from the prepared supplier facts; an edited supplier is resolved
  // again at import from its edited IČO/DIČ, never linked through the old ID.
  if (changed.some((field) => SUPPLIER_IDENTITY_FIELDS.includes(field)) && !empty(data.partnerId)) {
    data._stalePartnerId = data.partnerId;
    delete data.partnerId;
    delete data._partnerIdSource;
    if (!changed.includes(SUPPLIER_ID_FIELD)) changed.push(SUPPLIER_ID_FIELD);
  }
  return { data, changed, ignored };
}

/** Registry/VAT evidence belongs to the reviewed identity and amounts; re-decided after all edits. */
function recheckRegistry(merged: { data: Fields; changed: string[] }, original: Fields): void {
  const { data, changed } = merged;
  const identityChanged = changed.some((field) => ["partnerIco", "partnerDic", "partnerCountry"].includes(field));
  if (identityChanged) {
    // Registry evidence belongs to the reviewed identity. It cannot automatically
    // establish the VAT status of a replacement supplier.
    for (const field of ["partnerVatStatus", "vatStatusEvidence"]) if (!changed.includes(field)) delete data[field];
    for (const field of original._registryFilled ?? []) if (!changed.includes(field)) delete data[field];
    delete data._registryEvidence;
    data._supplierChanged = true;
  } else if (data._registryEvidence && (!data.taxMode || data.taxMode === "auto")) {
    const hasVat = [data.priceLowVAT, data.priceHighVAT, data.price3VAT].some((v) => v !== undefined && Number(v) !== 0);
    const decision = decideNonPayerTreatment({ evidence: data._registryEvidence.vat, supplierCountry: data.partnerCountry, documentChargesVat: hasVat ? true : data.sourceChargesVat });
    if (decision.pn === "auto" || decision.pn === "standard") {
      data.partnerVatStatus = decision.pn === "auto" ? "non-payer" : "payer";
      data.vatStatusEvidence = `ARES/ADIS ${data._registryEvidence.vat.status}, checked ${data._registryEvidence.fetchedAt}; current status, not historical`;
    } else {
      delete data.partnerVatStatus;
      delete data.vatStatusEvidence;
      data._registryReviewError = REVIEW_TEXT.vatTreatment;
    }
  }
}

function coerce(key: string, value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Fields;
    if ("result" in v) return coerce(key, v.result);
    if ("text" in v) return coerce(key, v.text);
    if (Array.isArray(v.richText)) return v.richText.map((part: Fields) => text(part.text)).join("");
  }
  if (DATE_FIELDS.has(key) && typeof value === "string") return value.trim().slice(0, 10);
  if (key === "cardPayment" || key === "sourceChargesVat") {
    if (typeof value === "boolean") return value;
    const t = text(value).toLowerCase();
    return ["true", "1", "ano", "yes"].includes(t) ? true : ["false", "0", "ne", "no"].includes(t) ? false : t;
  }
  if (key === "sourcePages") {
    const list = Array.isArray(value) ? value : text(value).split(/[,;\s]+/).filter(Boolean);
    return list.map(Number);
  }
  if (key === "partnerId" || key === "currencyAmount") return empty(value) ? "" : Number(value);
  if (key === "currencyRate") return empty(value) ? "" : Number(value);
  if (MONEY_FIELDS.has(key) && typeof value === "string") return value.trim().replace(/\s/g, "").replace(",", ".");
  return typeof value === "string" ? value.trim() : value;
}

function sameValue(a: unknown, b: unknown, field?: string): boolean {
  if (field && MONEY_FIELDS.has(field) && !empty(a) && !empty(b)) {
    try { return toMinorUnits(a as string | number) === toMinorUnits(b as string | number); } catch { /* invalid input is handled by policy */ }
  }
  if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return true;
  return (a === null || typeof a !== "object") && (b === null || typeof b !== "object") && text(a) === text(b);
}

function toolHeader(tool: ReviewTool, data: Fields): Fields {
  const header: Fields = {};
  for (const [key, value] of Object.entries(data)) if (!REVIEW_ONLY_KEYS.includes(key) && !key.startsWith("_")) header[key] = value;
  if (tool === "create_other_liability") header.type = "commitment";
  if (tool === "create_cash_voucher") header.type = "expense";
  return header;
}

/**
 * Pure validation with the shared policy. Card numbering uses a private placeholder
 * sequence; the K-number/symVar it would produce is never shown because the importer
 * reserves the real PK number at import time.
 */
function preflight(tool: ReviewTool, data: Fields): { ok: boolean; error?: string; code?: string; preview?: Fields } {
  const reject = (code: string, message: string): never => { throw new ReviewRowError(code, message); };
  try {
    if (data._registryReviewError) reject("VAT_TREATMENT_REVIEW", data._registryReviewError);
    if (data._paymentReviewError) reject("PAYMENT_METHOD_REVIEW", data._paymentReviewError);
    if (data._targetReviewError) reject("TARGET_EDIT_REJECTED", data._targetReviewError);
    if (data._partnerIdReviewError) reject("SUPPLIER_ID_EDIT", data._partnerIdReviewError);
    if (data._supplierChanged && !data.partnerName) reject("SUPPLIER_CHANGED", REVIEW_TEXT.supplierChanged);
    if (empty(data.partnerId) && empty(data.partnerIco) && empty(data.partnerDic)) reject("SUPPLIER_IDENTIFIER_REQUIRED", data._stalePartnerId ? SUPPLIER_TEXT.staleWithoutIdentifier : SUPPLIER_TEXT.identifierRequired);
    if (data.partnerIco && (!data.partnerCountry || data.partnerCountry === "CZ") && !normalizeIco(data.partnerIco).ok) reject("PARTNER_ICO_INVALID", REVIEW_TEXT.invalidIco);
    const header = toolHeader(tool, data);
    if (tool === "create_invoice" && !["receivedInvoice", "commitment"].includes(text(header.type))) reject("INVOICE_TYPE_INVALID", REVIEW_TEXT.invoiceType);
    if (header.sourceType !== "manual" && !text(header.sourcePdfPath)) reject("SOURCE_PDF_REQUIRED", REVIEW_TEXT.sourcePdfRequired);
    if (header.sourceType !== "manual" || header.sourcePdfPath) {
      if (!Array.isArray(header.sourcePages) || !header.sourcePages.length || header.sourcePages.some((p: unknown) => !Number.isInteger(p) || Number(p) < 1)) reject("SOURCE_PAGES_REQUIRED", REVIEW_TEXT.sourcePagesRequired);
    }
    if (tool === "create_cash_voucher" && !text(header.cashAccount)) reject("CASH_ACCOUNT_REQUIRED", REVIEW_TEXT.cashAccountRequired);
    const kind = tool === "create_cash_voucher" ? "voucher" : "invoice";
    const resolved = resolveExpensePolicy({ ...header, ...(header.cardPayment === true ? { cardSequence: 1 } : {}) }, [], kind);
    const policy = resolved._expensePolicy ?? {};
    const cardNumbered = policy.originalDocumentRule === "card-sequence";
    const sourceFacts = Object.fromEntries(SOURCE_FACT_FIELDS.filter((f) => !empty(data[f])).map((f) => [f, data[f]]));
    const planned: Fields = {
      date: resolved.date, dateTax: resolved.dateTax, dateAccounting: resolved.dateAccounting, dateKHDPH: resolved.dateKHDPH, datePayment: resolved.datePayment,
      dateDue: resolved.dateDue, dueDateRule: policy.dueDateRule,
      classificationVAT: resolved.classificationVAT, taxMode: policy.taxMode, lateSource: policy.lateSource, payableCZK: policy.payableCZK,
      priceNone: resolved.priceNone, priceLow: resolved.priceLow, priceLowVAT: resolved.priceLowVAT, priceHigh: resolved.priceHigh, priceHighVAT: resolved.priceHighVAT,
      price3: resolved.price3, price3VAT: resolved.price3VAT, roundingAmount: resolved.roundingAmount, roundingRule: policy.roundingRule, total: resolved.total,
      paymentType: resolved.paymentType, sourceVatBreakdown: policy.sourceVatBreakdown,
      originalDocument: cardNumbered ? "assigned from the next PK number at import" : resolved.originalDocument,
      symVar: cardNumbered ? "assigned from the next PK number at import" : resolved.symVar,
      originalDocumentRule: policy.originalDocumentRule,
      // Distinguishes a VS copied from the source from one derived by policy, so a
      // derived value is never presented as a source fact.
      symVarRule: cardNumbered ? undefined : policy.symVarRule
    };
    const warnings = (policy.notices ?? []).map(czechPolicyNotice).filter(Boolean);
    return { ok: true, preview: { sourceFacts, planned: Object.fromEntries(Object.entries(planned).filter(([, v]) => v !== undefined && v !== "")), warnings, warningCodes: (policy.notices ?? []).map((n: Fields) => n.code) } };
  } catch (error) {
    const issue = reviewIssueOf(error);
    return { ok: false, error: issue.message, code: issue.code };
  }
}

function headerOf(raw: Fields): Fields { return raw.invoiceHeader ?? raw.voucherHeader ?? raw; }
function ids(v: unknown): string { const value = v && typeof v === "object" ? (v as Fields).ids ?? (v as Fields).paymentType ?? (v as Fields).classificationVATType ?? "" : v; return text(value); }

function comparable(raw: Fields, request: ListRecordsBatchRequest): Fields {
  const h = headerOf(raw);
  const summary = raw.invoiceSummary ?? raw.voucherSummary ?? {};
  let total: unknown;
  try { total = summary.foreignCurrency?.priceSum !== undefined ? moneyValue(summary.foreignCurrency.priceSum) : sumHomeCurrency(summary.homeCurrency ?? {}); } catch { total = ""; }
  const address = (h.partnerIdentity ?? {}).address ?? {};
  return {
    agenda: request.agenda, type: text(h.invoiceType ?? h.voucherType ?? request.subType),
    id: text(h.id), number: text(h.number?.numberRequested ?? h.number?.ids ?? h.number),
    date: text(h.date), dateTax: text(h.dateTax), dateAccounting: text(h.dateAccounting), dateKHDPH: text(h.dateKHDPH), datePayment: text(h.datePayment),
    originalDocument: text(h.originalDocument), text: text(h.text), accounting: ids(h.accounting), classificationVAT: ids(h.classificationVAT),
    cashAccount: ids(h.cashAccount), paymentType: ids(h.paymentType), total: total ?? "",
    currency: ids(summary.foreignCurrency?.currency), partnerName: text(address.company), partnerIco: text(address.ico)
  };
}

function latestSuccess(manifest: Fields, workbookSha256: string, rowIds: string[]): Fields | undefined {
  const wanted = JSON.stringify([...rowIds].sort());
  return [...(manifest.imports as Fields[])].reverse().find((entry) => entry.ok === true && entry.workbookSha256 === workbookSha256 && JSON.stringify([...(entry.rowIds ?? [])].sort()) === wanted);
}

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  try { return await run; } finally { if (locks.get(key) === tail) locks.delete(key); }
}

async function readJson(path: string): Promise<Fields | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try { await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); await rename(tmp, path); }
  catch (error) { await unlink(tmp).catch(() => {}); throw error; }
}

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
