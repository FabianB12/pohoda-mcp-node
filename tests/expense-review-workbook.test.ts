import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { REVIEW_COLUMNS } from "../src/mcp/review-workbook.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };

async function setup(overrides: Record<string, any> = {}, lookupSupplier?: (input: any) => Promise<any>) {
  const dir = await mkdtemp(join(tmpdir(), "real-review-")); dirs.push(dir);
  const pdf = join(dir, "source.pdf"); await writeFile(pdf, "%PDF-1.4 test");
  const runs: any[] = [], reads: any[] = [];
  const client = { listRecordsBatch: async (requests: any[]) => {
    reads.push(requests);
    return { isOk: () => true, items: requests.map(() => ({ state: "ok", data: { invoice: [] } })) };
  } };
  const importer = { run: async (ops: any[], id: string, options: any) => {
    runs.push({ ops, id, options }); return { ok: true, state: "ok", results: ops.map((op, i) => ({ requestId: op.requestId, id: i + 1, created: true, verified: true })) };
  } };
  const service = new ExpenseReviewService({ client: client as any, importer, directory: dir, ...(lookupSupplier ? { lookupSupplier } : {}) });
  const prepared = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: "2026-11", documents: [{ requestId: "A", tool: "create_invoice", reviewNotes: "Ověřit u klienta", data: {
    sourcePdfPath: pdf, sourcePages: [1], taxMode: "taxable", classificationVAT: "PD", partnerIco: "25596641", partnerName: "Test supplier",
    // Legacy aliases must appear visibly and must not undo a user's cleared source cell.
    date: "2026-10-10", dateTax: "2026-10-10", originalDocument: "000123", symVar: "00123",
    text: "Materiál", priceHigh: 100, priceHighVAT: 21, total: 121,
    dateDue: "2026-11-25", accounting: "501", intNote: "Source provenance", ...overrides
  } }] });
  const edit = async (values: Record<string, any>) => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(prepared.workbookPath);
    const sheet = wb.getWorksheet("Doklady")!;
    for (const [key, value] of Object.entries(values)) sheet.getCell(3, REVIEW_COLUMNS.findIndex((c) => c.key === key) + 1).value = value;
    await wb.xlsx.writeFile(prepared.workbookPath);
  };
  const submit = () => service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: target.databaseOverride, target });
  return { service, prepared, edit, submit, runs, reads };
}

describe("Real XLSX reviewed-import integration", () => {
  it("reads edits and cleared cells from Excel, preserving IDs and excluding review notes", async () => {
    const { prepared, edit, submit, runs, reads } = await setup();
    expect(prepared.status).toBe("readyForReview");
    expect(runs).toHaveLength(0);
    expect(reads).toHaveLength(1);
    await edit({ text: "Oprava", priceHigh: "200,00", priceHighVAT: 42, total: 242, accounting: null, dateDue: null, sourceSymVar: null, reviewNotes: "PRIVATE REVIEW NOTE", action: "Importovat" });
    expect((await submit()).ok).toBe(true);
    expect(runs).toHaveLength(1);
    const header = runs[0].ops[0].header;
    expect(header).toMatchObject({ text: "Oprava", priceHigh: "200.00", priceHighVAT: 42, total: 242, sourceDocumentNumber: "000123", sourceIssueDate: "2026-10-10", intNote: "Source provenance" });
    for (const field of ["accounting", "dateDue", "sourceSymVar", "symVar"]) expect(header[field]).toBeUndefined();
    expect(JSON.stringify(runs)).not.toContain("PRIVATE REVIEW NOTE");
    expect((await submit()).repeated).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("does not resurrect a cleared source document number through the originalDocument alias", async () => {
    const { edit, submit, runs } = await setup();
    await edit({ sourceDocumentNumber: null });
    await expect(submit()).rejects.toThrow(/SOURCE_DOCUMENT_NUMBER_REQUIRED/);
    expect(runs).toHaveLength(0);
  });

  it("blocks formulas, even with a plausible cached result, before importing", async () => {
    const { edit, submit, runs } = await setup();
    await edit({ total: { formula: "100+21", result: 121 } });
    await expect(submit()).rejects.toThrow(/FORMULA/);
    expect(runs).toHaveLength(0);
  });

  it("requires a decision for a row marked Prověřit even when its amounts are valid", async () => {
    const { edit, submit, runs } = await setup();
    await edit({ action: "Prověřit" });
    await expect(submit()).rejects.toThrow(/still marked review/);
    expect(runs).toHaveLength(0);
  });

  it("rechecks automatic PN when the reviewer adds VAT that extraction missed", async () => {
    const lookup = async () => ({ status: "matched", fetchedAt: "2026-11-14", supplier: { name: "Test supplier", ico: "25596641", country: "CZ" }, vat: { status: "registry-non-payer" } });
    const { edit, submit, runs } = await setup({ taxMode: "auto", classificationVAT: "", sourceChargesVat: false, priceHigh: undefined, priceHighVAT: undefined, priceNone: 121 }, lookup);
    await edit({ priceNone: null, priceHigh: 100, priceHighVAT: 21, sourceChargesVat: "Ano" });
    await expect(submit()).rejects.toThrow(/Document charges VAT but registry status/);
    expect(runs).toHaveLength(0);
    await edit({ sourceChargesVat: "Ne" });
    await expect(submit()).rejects.toThrow(/Document charges VAT but registry status/);
    expect(runs).toHaveLength(0);
  });

  it("rechecks a payer decision when the reviewer removes VAT", async () => {
    const lookup = async () => ({ status: "matched", fetchedAt: "2026-11-14", supplier: { name: "Test supplier", ico: "25596641", country: "CZ" }, vat: { status: "payer" } });
    const { edit, submit, runs } = await setup({ taxMode: "auto", sourceChargesVat: true }, lookup);
    await edit({ priceHigh: null, priceHighVAT: null, priceNone: 121, sourceChargesVat: "Ne" });
    await expect(submit()).rejects.toThrow(/Document shows no VAT but registry status/);
    expect(runs).toHaveLength(0);
  });

  it("does not carry registry-filled identity into a replacement supplier", async () => {
    const lookup = async () => ({ status: "matched", fetchedAt: "2026-11-14", supplier: { name: "Old Supplier", ico: "25596641", street: "Old address 1", country: "CZ" }, vat: { status: "payer" } });
    const { edit, submit, runs } = await setup({ partnerName: "" }, lookup);
    await edit({ partnerIco: "27082440" });
    await expect(submit()).rejects.toThrow(/Supplier identity changed/);
    expect(runs).toHaveLength(0);
    await edit({ partnerName: "New Supplier" });
    await submit();
    expect(runs[0].ops[0].header.partnerName).toBe("New Supplier");
    expect(runs[0].ops[0].header.partnerStreet).toBeUndefined();
  });

  it("rejects a workbook changed after inspection", async () => {
    const { prepared, service, edit, runs } = await setup();
    const inspected = await service.inspect({ reviewId: prepared.reviewId });
    await edit({ text: "New version" });
    await expect(service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: target.databaseOverride, target, expectedWorkbookSha256: inspected.workbookSha256 })).rejects.toThrow(/changed since inspection/);
    expect(runs).toHaveLength(0);
  });

  it("rejects hidden or filtered document rows instead of importing unseen rows", async () => {
    const { prepared, submit, runs } = await setup();
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(prepared.workbookPath);
    wb.getWorksheet("Doklady")!.getRow(3).hidden = true;
    await wb.xlsx.writeFile(prepared.workbookPath);
    await expect(submit()).rejects.toThrow(/HIDDEN_ROW/);
    expect(runs).toHaveLength(0);
  });
});
