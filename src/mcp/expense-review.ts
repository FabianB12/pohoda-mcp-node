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
import { MAX_TEXT_LENGTH, resolveExpensePolicy } from "../pohoda/expense-policy.js";
import { moneyValue, sumHomeCurrency, toMinorUnits } from "../pohoda/money.js";
import * as workbookCodec from "./review-workbook.js";
import { companyKey, decideNonPayerTreatment, normalizeIco } from "../registry/czech-registry.js";

type Fields = Record<string, any>;

export type ReviewWorkbookCodec = {
  writeReviewWorkbook(input: ReviewWorkbook, filePath: string): Promise<unknown>;
  readReviewWorkbook(filePath: string, bytes?: Uint8Array): Promise<ReviewWorkbookRead>;
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

/** Workbook columns that may change POHODA data. Everything else comes from the manifest. */
export const REVIEW_EDITABLE_FIELDS = [
  "text", "note", "accounting", "classificationVAT", "classificationKVDPH", "centre", "activity", "contract",
  "paymentType", "cashAccount", "accountIds", "paymentAccountNumber", "paymentBankCode", "taxMode", "sourceChargesVat",
  "partnerId", "partnerName", "partnerIco", "partnerDic", "partnerStreet", "partnerCity", "partnerZip", "partnerCountry",
  "partnerVatStatus", "vatStatusEvidence",
  "sourceIssueDate", "sourceTaxDate", "sourcePaymentDate", "sourceDocumentNumber", "sourceSymVar",
  "date", "dateTax", "dateAccounting", "dateKHDPH", "datePayment", "dateDue", "originalDocument", "symVar",
  "cardPayment", "total", "roundingAmount", "priceNone", "priceLow", "priceLowVAT", "priceLowSum",
  "priceHigh", "priceHighVAT", "priceHighSum", "price3", "price3VAT", "price3Sum",
  "currency", "currencyRate", "currencyAmount", "currencyPriceSum", "homePayableCZK",
  "sourcePdfPath", "sourcePages"
] as const;
const EDITABLE = new Set<string>(REVIEW_EDITABLE_FIELDS);
/** Never sent to POHODA from a review row, whatever the workbook or caller contains. */
const REVIEW_ONLY_KEYS = ["rowId", "action", "reviewNotes", "requestId", "items", "databaseId", "dataPackId"];
const TOOLS: ReviewTool[] = ["create_invoice", "create_other_liability", "create_cash_voucher"];
const ACTIONS: ReviewAction[] = ["import", "review", "skip"];
const MONEY_FIELDS = new Set(["total", "roundingAmount", "priceNone", "priceLow", "priceLowVAT", "priceLowSum", "priceHigh", "priceHighVAT", "priceHighSum", "price3", "price3VAT", "price3Sum", "currencyPriceSum", "homePayableCZK"]);
const DATE_FIELDS = new Set(["sourceIssueDate", "sourceTaxDate", "sourcePaymentDate", "date", "dateTax", "dateAccounting", "dateKHDPH", "datePayment", "dateDue"]);
const SOURCE_FACT_FIELDS = ["sourceIssueDate", "sourceTaxDate", "sourcePaymentDate", "sourceDocumentNumber", "sourceSymVar", "taxMode", "total", "priceNone", "priceLow", "priceLowVAT", "priceHigh", "priceHighVAT", "price3", "price3VAT", "roundingAmount", "currency", "homePayableCZK", "text", "accounting", "cardPayment"];
const PREFERRED_TEXT_LENGTH = 60;
const HISTORY_COUNT = 50;
const EXAMPLES_PER_QUERY = 5;
const LIST_BATCH = 25;
const REVIEW_ID = /^rv-[0-9a-f]{16}$/;
const ROW_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const locks = new Map<string, Promise<unknown>>();

const text = (v: unknown): string => v == null ? "" : String(v).trim();
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
      return { rowId, tool: doc.tool, ...draftData(doc.tool, doc.data ?? {}, vatPeriod), callerNotes: text(doc.reviewNotes) };
    });

    const reviewId = `rv-${sha256(JSON.stringify({ databaseId, target, vatPeriod, rows: drafts.map(({ rowId, tool, data }) => ({ rowId, tool, data })) })).slice(0, 16)}`;
    const folder = join(this.directory, reviewId);
    const manifestPath = join(folder, "manifest.json");
    const existing = await readJson(manifestPath);
    if (existing) {
      // Never overwrite a workbook the user may already be editing.
      return { ...(await this.inspect({ reviewId })), reused: true, message: "This review was already prepared; the existing workbook was kept." };
    }

    // Resolve identity/VAT evidence while still read-only, so automatic PN appears
    // in the review itself instead of changing an already-approved row at import.
    if (this.lookupSupplier) {
      const lookups = new Map<string, Promise<Fields>>();
      for (const draft of drafts) {
        const h = draft.data;
        if (Number(h.partnerId) > 0 && ["taxable", "nonTax"].includes(h.taxMode)) continue;
        const input = { ico: h.partnerIco, dic: h.partnerDic, name: h.partnerName, street: h.partnerStreet, city: h.partnerCity, zip: h.partnerZip, country: h.partnerCountry };
        const key = JSON.stringify(input);
        let request = lookups.get(key);
        if (!request) { request = this.lookupSupplier(input); lookups.set(key, request); }
        const lookup = await request;
        if (lookup.status === "matched") {
          const s = lookup.supplier;
          if (h.partnerName && s.name && companyKey(h.partnerName) !== companyKey(s.name)) {
            draft.blocking = true; draft.notes.push(`Supplier name does not match ARES: source ${h.partnerName}; registry ${s.name}. Verify IČO before import.`);
          }
          const filled: string[] = [];
          for (const [field, value] of Object.entries({ partnerName: s.name, partnerIco: s.ico, partnerDic: s.dic, partnerStreet: s.street, partnerCity: s.city, partnerZip: s.zip, partnerCountry: s.country })) if (empty(h[field]) && !empty(value)) { h[field] = value; filled.push(field); }
          h._registryFilled = filled;
          h._registryEvidence = { vat: lookup.vat, fetchedAt: lookup.fetchedAt };
          if (!h.taxMode || h.taxMode === "auto") {
            const hasVat = [h.priceLowVAT, h.priceHighVAT, h.price3VAT].some((v) => v !== undefined && Number(v) !== 0);
            const treatment = decideNonPayerTreatment({ evidence: lookup.vat, supplierCountry: h.partnerCountry, documentChargesVat: hasVat ? true : h.sourceChargesVat });
            if (treatment.pn === "auto" || treatment.pn === "standard") {
              h.partnerVatStatus = treatment.pn === "auto" ? "non-payer" : "payer";
              h.vatStatusEvidence = `ARES/ADIS ${lookup.vat.status}, checked ${lookup.fetchedAt}; current status, not historical`;
            } else { draft.blocking = true; draft.notes.push(`VAT treatment requires review: ${treatment.reasons.join("; ")}`); }
          }
        } else if (lookup.status === "ambiguous") {
          draft.blocking = true; draft.notes.push("Supplier registry match is ambiguous; resolve the supplier before import.");
        } else if (lookup.status === "notFound" && h.partnerIco) {
          draft.blocking = true; draft.notes.push("IČO was not found in ARES. Verify the source identifier before import.");
        } else if (lookup.status === "unavailable") draft.notes.push(`Registry unavailable: ${lookup.message}`);
      }
    }
    // History is read before any workbook is written, scoped to the explicit unit.
    const history = await this.readHistory(drafts.map((d) => ({ rowId: d.rowId, tool: d.tool, data: d.data })), vatPeriod, target);
    const rows: ReviewRow[] = [];
    const sources: Fields = {};
    for (const draft of drafts) {
      const notes: string[] = [...draft.notes];
      let blocking = draft.blocking;
      const data = draft.data;
      const found = history.byRow.get(draft.rowId);
      const suggestions: Fields[] = [];
      if (found) {
        for (const field of ["accounting", "text", "classificationVAT"] as const) {
          if (!empty(data[field])) continue;
          if (field === "classificationVAT" && (data.taxMode === "nonTax" || data.partnerVatStatus === "non-payer")) continue;
          const values = [...new Set(found.records.map((r) => text(r[field])).filter(Boolean))];
          if (field === "classificationVAT" && values.some((value) => ["PN", "nonSubsume"].includes(value))) continue;
          if (values.length === 1) {
            const value = values[0]!;
            if (field === "text" && value.length > MAX_TEXT_LENGTH) { notes.push(`History text exceeds ${MAX_TEXT_LENGTH} characters and was not used; enter a brief text.`); continue; }
            data[field] = value;
            const fromIds = found.records.filter((r) => text(r[field]) === value).map((r) => r.id);
            suggestions.push({ field, value, fromIds, rule: "unanimous same-supplier POHODA history" });
            notes.push(`${field} "${value}" suggested from POHODA history (${fromIds.map((id) => `#${id}`).join(", ")}); confirm.`);
          } else if (values.length > 1) {
            notes.push(`History has ${values.length} different ${field} values (${values.slice(0, 4).join(" | ")}); choose one.`);
          }
        }
        const sourceNumber = text(data.sourceDocumentNumber || data.originalDocument);
        const duplicates = sourceNumber ? found.records.filter((r) => text(r.originalDocument) === sourceNumber) : [];
        if (duplicates.length) {
          blocking = true;
          notes.push(`Possible duplicate: POHODA ${duplicates.map((r) => `#${r.id} ${r.number}`).join(", ")} has source document ${sourceNumber}; skip it or confirm.`);
        }
        if (draft.tool === "create_cash_voucher" && empty(data.cashAccount)) {
          const accounts = [...new Set(found.records.map((r) => text(r.cashAccount)).filter(Boolean))];
          if (accounts.length) notes.push(`History cash accounts: ${accounts.join(", ")}.`);
        }
      } else if (history.skipped.has(draft.rowId)) {
        notes.push("No supplier IČO or name; no POHODA history was searched.");
      }
      if (draft.tool === "create_cash_voucher" && empty(data.cashAccount)) { blocking = true; notes.push("cashAccount is required for a cash expense."); }
      const textLength = text(data.text).length;
      if (textLength > PREFERRED_TEXT_LENGTH && textLength <= MAX_TEXT_LENGTH) notes.push(`Text has ${textLength} characters; prefer a brief description up to ${PREFERRED_TEXT_LENGTH} (e.g. "Materiál").`);
      const check = preflight(draft.tool, data);
      if (!check.ok) { blocking = true; notes.push(`Needs data: ${check.error}`); }
      if (data.sourcePdfPath && !(await fileExists(text(data.sourcePdfPath)))) { blocking = true; notes.push(`Source PDF not found: ${data.sourcePdfPath}`); }
      const reviewNotes = [draft.callerNotes, ...notes].filter(Boolean).join("\n");
      rows.push({ rowId: draft.rowId, tool: draft.tool, data, action: blocking ? "review" : "import", reviewNotes });
      sources[draft.rowId] = { query: found?.key, exampleIds: found?.records.map((r) => r.id) ?? [], suggestions, registryFilled: data._registryFilled ?? [] };
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
      version: 1, reviewId, createdAt: new Date().toISOString(), databaseId, target, vatPeriod, workbookPath,
      preparedWorkbookSha256: sha256(await readFile(workbookPath)),
      rows: rows.map((row) => ({ rowId: row.rowId, tool: row.tool, data: row.data, action: row.action, reviewNotes: row.reviewNotes })),
      sourcePdfPaths: [...new Set(rows.map((r) => text(r.data.sourcePdfPath)).filter(Boolean))],
      sources, history: { queries: history.queries, warnings: history.warnings, exampleCount: history.examples.length },
      imports: []
    };
    await writeJsonAtomic(manifestPath, manifest);
    const pending = rows.filter((r) => r.action === "review").map((r) => r.rowId);
    return {
      ok: true, status: pending.length ? "requiresReview" : "readyForReview", reviewId, databaseId, vatPeriod, workbookPath,
      manifestPath, rowCount: rows.length, requiresReview: pending, historyWarnings: history.warnings, exampleCount: history.examples.length,
      rows: rows.map((row) => ({ rowId: row.rowId, tool: row.tool, action: row.action, reviewNotes: row.reviewNotes, preview: preflight(row.tool, row.data).preview })),
      message: "Workbook prepared without POHODA writes. Ask the user to review/edit it; import only on the user's explicit instruction."
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
      const report: Fields = { at: new Date().toISOString(), workbookPath: evaluation.workbookPath, workbookSha256: evaluation.workbookSha256, dataPackId, rowIds, skippedRowIds: evaluation.skipped, omittedRowIds: evaluation.omitted, currentState, historyWarnings: current.warnings };
      let result: Fields;
      try {
        result = await this.importer.run(operations, dataPackId, target);
      } catch (error) {
        Object.assign(report, { ok: false, state: "import_failed", error: (error as Error).message });
        manifest.imports.push(report);
        await writeJsonAtomic(join(this.directory, reviewId, "manifest.json"), manifest);
        return { ok: false, status: "requiresReview", reviewId, databaseId: manifest.databaseId, dataPackId, workbookSha256: evaluation.workbookSha256, error: (error as Error).message, currentState, message: "Import stopped; inspect the error. A retry re-checks existing documents by external ID." };
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
      const merged = mergeRow(original.data, row.data ?? {});
      ignored.push(...merged.ignored.map((field) => ({ rowId, field })));
      const pdf = text(merged.data.sourcePdfPath);
      if (pdf && pdf !== text(original.data.sourcePdfPath) && !allowedPdfs.has(pdf)) { errors.push(`row ${rowId} sourcePdfPath ${pdf} is not one of the prepared source PDFs`); continue; }
      if (action === "skip") { skipped.push(rowId); report.push({ rowId, action, changedFields: merged.changed }); continue; }
      if (action === "review") unresolved.push(rowId);
      const check = preflight(original.tool, merged.data);
      if (!check.ok && action === "import") invalid.push({ rowId, error: check.error });
      if (action === "import") selected.push({ rowId, tool: original.tool, data: merged.data });
      report.push({ rowId, tool: original.tool, action, valid: check.ok, error: check.error, changedFields: merged.changed, preview: check.preview });
    }
    const omitted = [...originals.keys()].filter((id) => !seen.has(id));
    return { workbookPath, workbookSha256, errors, selected, unresolved, skipped, invalid, ignored, omitted, report };
  }

  /** Batched, deduplicated, bounded read of same-supplier documents on the explicit unit. */
  private async readHistory(rows: Array<{ rowId: string; tool: ReviewTool; data: Fields }>, vatPeriod: string, target: TransportOptions) {
    const year = Number(vatPeriod.slice(0, 4)), month = Number(vatPeriod.slice(5, 7));
    const dateFrom = new Date(Date.UTC(year, month - 1 - this.historyMonths, 1)).toISOString().slice(0, 10);
    const dateTill = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const queries = new Map<string, { request: ListRecordsBatchRequest; rowIds: string[]; voucher: boolean }>();
    const rowKey = new Map<string, string>();
    const skipped = new Set<string>();
    for (const row of rows) {
      const ico = text(row.data.partnerIco).replace(/\s/g, "");
      const name = text(row.data.partnerName);
      if (!ico && !name) { skipped.add(row.rowId); continue; }
      const voucher = row.tool === "create_cash_voucher";
      const subType = voucher ? "" : row.tool === "create_other_liability" ? "commitment" : text(row.data.type) || "receivedInvoice";
      const request: ListRecordsBatchRequest = { agenda: voucher ? "voucher" : "invoice", subType, filter: { ...(ico ? { ico } : { company: name }), dateFrom, dateTill }, options: { count: HISTORY_COUNT } };
      const key = JSON.stringify(request);
      rowKey.set(row.rowId, key);
      const entry = queries.get(key) ?? { request, rowIds: [], voucher };
      entry.rowIds.push(row.rowId);
      queries.set(key, entry);
    }
    const warnings: string[] = [];
    const results = new Map<string, Fields[]>();
    const list = [...queries.entries()];
    for (let start = 0; start < list.length; start += LIST_BATCH) {
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

function explicitTarget(target: TransportOptions | undefined): { databaseOverride: string; dataPackIco: string } {
  const databaseOverride = text(target?.databaseOverride), dataPackIco = text(target?.dataPackIco);
  if (!databaseOverride || !dataPackIco) throw new ReviewImportError("An explicit target database and dataPack ICO are required for every review operation.");
  return { databaseOverride, dataPackIco };
}

function draftData(tool: ReviewTool, input: Fields, vatPeriod: string): { data: Fields; notes: string[]; blocking: boolean } {
  const data: Fields = {};
  const notes: string[] = [];
  let blocking = false;
  for (const [key, value] of Object.entries(input ?? {})) {
    if (REVIEW_ONLY_KEYS.includes(key) || key.startsWith("_")) continue;
    if (!EDITABLE.has(key) && !["type", "sourceType", "vatPeriod", "intNote"].includes(key)) {
      if (!empty(value)) notes.push(`Unsupported preview field ${key} was ignored; only reviewed document fields may be imported.`);
      continue;
    }
    if (!empty(value)) data[key] = value;
  }
  if (Array.isArray(input?.items) && input.items.length) { blocking = true; notes.push("Items were dropped; expenses use exact summary amounts only."); }
  if (data.vatPeriod && text(data.vatPeriod) !== vatPeriod) { blocking = true; notes.push(`Document vatPeriod ${data.vatPeriod} replaced by the review period ${vatPeriod}; confirm.`); }
  data.vatPeriod = vatPeriod;
  data.sourceType = text(data.sourceType) === "manual" ? "manual" : "pdf";
  // Put legacy aliases in the visible source columns. A reviewer must be able to
  // see and correct the actual facts used by the policy, not hidden fallback data.
  for (const [field, aliases] of Object.entries({
    sourceIssueDate: ["date"], sourceTaxDate: ["dateKHDPH", "dateTax"],
    sourcePaymentDate: ["datePayment"], sourceDocumentNumber: ["originalDocument"], sourceSymVar: ["symVar"]
  })) if (empty(data[field])) {
    const value = aliases.map((alias) => data[alias]).find((v) => !empty(v));
    if (!empty(value)) data[field] = value;
  }
  if (empty(data.total) && !empty(data.currencyPriceSum)) data.total = data.currencyPriceSum;
  // These aliases are represented by their visible source columns; retaining a
  // second hidden value could undo a reviewer clearing or correcting a cell.
  for (const key of ["date", "dateTax", "dateKHDPH", "datePayment", "originalDocument", "symVar", "currencyPriceSum"]) delete data[key];
  if (tool === "create_other_liability") data.type = "commitment";
  if (tool === "create_cash_voucher") data.type = "expense";
  if (tool === "create_invoice" && !["receivedInvoice", "commitment"].includes(text(data.type))) {
    if (data.type) { blocking = true; notes.push(`Invoice type ${data.type} is not an expense; set receivedInvoice or commitment in a new review.`); }
    data.type = "receivedInvoice";
  }
  return { data, notes, blocking };
}

/** Starts from the stored row; only whitelisted workbook columns can change it. */
function mergeRow(original: Fields, decoded: Fields): { data: Fields; changed: string[]; ignored: string[] } {
  const data: Fields = structuredClone(original);
  const changed: string[] = [], ignored: string[] = [];
  for (const [key, raw] of Object.entries(decoded ?? {})) {
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
    sourcePaymentDate: ["datePayment"], sourceDocumentNumber: ["originalDocument"], sourceSymVar: ["symVar"]
  };
  for (const field of changed) for (const alias of aliases[field] ?? []) delete data[alias];
  const identityChanged = changed.some((field) => ["partnerIco", "partnerDic", "partnerId", "partnerCountry"].includes(field));
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
      data._registryReviewError = `VAT treatment requires review: ${decision.reasons.join("; ")}`;
    }
  }
  return { data, changed, ignored };
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
function preflight(tool: ReviewTool, data: Fields): { ok: boolean; error?: string; preview?: Fields } {
  try {
    if (data._registryReviewError) throw new Error(data._registryReviewError);
    if (data._supplierChanged && !data.partnerName) throw new Error("Supplier identity changed; confirm the new supplier name/address or prepare a refreshed preview.");
    if (data.partnerIco && (!data.partnerCountry || data.partnerCountry === "CZ") && !normalizeIco(data.partnerIco).ok) throw new Error("Invalid Czech supplier IČO; review the source identifier.");
    const header = toolHeader(tool, data);
    if (tool === "create_invoice" && !["receivedInvoice", "commitment"].includes(text(header.type))) throw new Error("create_invoice must be receivedInvoice or commitment.");
    if (header.sourceType !== "manual" && !text(header.sourcePdfPath)) throw new Error("sourcePdfPath is required for PDF imports.");
    if (header.sourceType !== "manual" || header.sourcePdfPath) {
      if (!Array.isArray(header.sourcePages) || !header.sourcePages.length || header.sourcePages.some((p: unknown) => !Number.isInteger(p) || Number(p) < 1)) throw new Error("sourcePages must identify at least one positive PDF page.");
    }
    if (tool === "create_cash_voucher" && !text(header.cashAccount)) throw new Error("cashAccount is required for a cash expense.");
    const kind = tool === "create_cash_voucher" ? "voucher" : "invoice";
    const resolved = resolveExpensePolicy({ ...header, ...(header.cardPayment === true ? { cardSequence: 1 } : {}) }, [], kind);
    const policy = resolved._expensePolicy ?? {};
    const cardNumbered = policy.originalDocumentRule === "card-sequence";
    const sourceFacts = Object.fromEntries(SOURCE_FACT_FIELDS.filter((f) => !empty(data[f])).map((f) => [f, data[f]]));
    const planned: Fields = {
      date: resolved.date, dateTax: resolved.dateTax, dateAccounting: resolved.dateAccounting, dateKHDPH: resolved.dateKHDPH, datePayment: resolved.datePayment,
      classificationVAT: resolved.classificationVAT, taxMode: policy.taxMode, lateSource: policy.lateSource, payableCZK: policy.payableCZK,
      priceNone: resolved.priceNone, sourceVatBreakdown: policy.sourceVatBreakdown,
      originalDocument: cardNumbered ? "assigned from the next PK number at import" : resolved.originalDocument,
      symVar: cardNumbered ? "assigned from the next PK number at import" : resolved.symVar,
      originalDocumentRule: policy.originalDocumentRule
    };
    return { ok: true, preview: { sourceFacts, planned: Object.fromEntries(Object.entries(planned).filter(([, v]) => v !== undefined && v !== "")), warnings: policy.warnings ?? [] } };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
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
