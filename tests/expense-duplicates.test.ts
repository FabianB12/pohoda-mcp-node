import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { checkPreviewDuplicates, PREVIEW_DUPLICATE_PAGE_SIZE } from "../src/mcp/expense-duplicates.js";
import { expenseIdentityCandidates, retryMarker } from "../src/mcp/expense-import.js";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { updateReviewDuplicateChecks, REVIEW_COLUMNS } from "../src/mcp/review-workbook.js";

const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const input = (rowId = "A", extra: Record<string, any> = {}) => ({ rowId, tool: "create_invoice" as const, data: {
  type: "receivedInvoice", sourceType: "manual", vatPeriod: "2026-11", sourceIssueDate: "2026-10-20", sourceTaxDate: "2026-10-20",
  sourceDocumentNumber: "INV-1", partnerIco: "25596641", partnerName: "Supplier s.r.o.", taxMode: "taxable", classificationVAT: "PD",
  text: "Materiál", priceHigh: 100, priceHighVAT: 21, total: 121, ...extra
} });
const record = (id = 1, header: Record<string, any> = {}, total = 121) => ({ invoiceHeader: {
  id, invoiceType: "receivedInvoice", number: { numberRequested: `FP-${id}` }, date: "2026-10-20", originalDocument: "INV-1",
  partnerIdentity: { id: 7, address: { ico: "25596641", dic: "CZ25596641", company: "Supplier s.r.o." } }, ...header
}, invoiceSummary: { homeCurrency: { priceNone: total } } });
class Client {
  rows: any[] = []; calls: any[] = []; fail = false; ignorePaging = false;
  async listRecordsBatch(requests: any[], _id: string, options: any) {
    this.calls.push({ requests, options });
    return { isOk: () => !this.fail, items: requests.map((r) => {
      const key = r.agenda === "voucher" ? "voucher" : "invoice";
      let rows = this.rows.filter((raw) => key === "voucher" ? !!raw.voucherHeader : raw.invoiceHeader?.invoiceType === r.subType);
      if (!this.ignorePaging && r.options.idFrom) rows = rows.filter((raw) => (raw.invoiceHeader ?? raw.voucherHeader).id >= r.options.idFrom);
      return { state: "ok", data: { [key]: rows.slice(0, r.options.count) } };
    }) };
  }
}
async function check(client: Client, rows = [input()]) { return checkPreviewDuplicates(client as any, rows, target); }

describe("Read-only preview duplicate checks", () => {
  it("finds older manually entered invoices beyond the recent examples, including changed totals", async () => {
    const client = new Client();
    client.rows = Array.from({ length: 80 }, (_, i) => record(i + 1, { originalDocument: i ? `OTHER-${i}` : " inv-1 ", date: "2025-01-02" }, i ? 121 : 999));
    const result = await check(client);
    expect(result.byRow.A).toMatchObject({ status: "possible", matchCount: 1 });
    expect(result.byRow.A!.matches[0]).toMatchObject({ id: "1", number: "FP-1", reason: "reference", date: "2025-01-02", total: 999 });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].requests).toHaveLength(3);
    expect(client.calls[0].options).toEqual(target);
  });

  it("finds an already imported PDF after it is renamed, without an invoice number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duplicate-pdf-")); directories.push(dir);
    const path = join(dir, "renamed.pdf"), bytes = Buffer.from("%PDF-1.4 source"); await writeFile(path, bytes);
    const row = input("A", { sourceType: "pdf", sourcePdfPath: path, sourcePages: [2, 1, 2], sourceDocumentNumber: "" });
    const identity = expenseIdentityCandidates({ ...row.data, sourcePages: [1, 2], sourcePdfSha256: createHash("sha256").update(bytes).digest("hex") });
    const client = new Client(); client.rows = [record(5, { originalDocument: "", intNote: retryMarker("pohoda-mcp-expenses", identity.extId) })];
    const result = await check(client, [row]);
    expect(result.byRow.A!.matches[0]).toMatchObject({ id: "5", reason: "identity" });
    expect(await readFile(path)).toEqual(bytes);
  });

  it("flags a card or cash receipt without a source reference by supplier, amount, currency and original date", async () => {
    const client = new Client(); client.rows = [record(4, { invoiceType: "commitment", originalDocument: "K4", date: "2026-11-01", intNote: "Zdroj: vystaveno 2026-10-20; DUZP 2026-10-20" })];
    const result = await check(client, [input("A", { sourceDocumentNumber: "" })]);
    expect(result.byRow.A!.matches[0]).toMatchObject({ id: "4", type: "commitment", reason: "amount_date" });
  });

  it("does not match another supplier, another currency or distinct numbered invoices", async () => {
    const client = new Client(); client.rows = [
      record(1, { partnerIdentity: { address: { ico: "27082440", company: "Other" } } }),
      { ...record(2, { originalDocument: "" }), invoiceSummary: { foreignCurrency: { currency: { ids: "EUR" }, priceSum: 121 } } },
      record(3, { originalDocument: "INV-DIFFERENT" })
    ];
    expect((await check(client)).byRow.A!.status).toBe("clear");
  });

  it("matches suppliers specified only by address-book ID or foreign DIČ", async () => {
    const client = new Client(); client.rows = [record(7)];
    expect((await check(client, [input("ID", { partnerIco: "", partnerName: "", partnerId: 7 })])).byRow.ID!.status).toBe("possible");
    client.rows = [record(8, { partnerIdentity: { address: { dic: "DE123456789", company: "Foreign supplier" } } })];
    expect((await check(client, [input("DIC", { partnerIco: "", partnerName: "", partnerDic: "DE123456789" })])).byRow.DIC!.status).toBe("possible");
  });

  it("checks an entire page boundary and rejects ignored pagination", async () => {
    const client = new Client();
    client.rows = Array.from({ length: PREVIEW_DUPLICATE_PAGE_SIZE + 1 }, (_, i) => record(i + 1, { originalDocument: `OTHER-${i}` }));
    client.rows[PREVIEW_DUPLICATE_PAGE_SIZE]!.invoiceHeader.originalDocument = "INV-1";
    const result = await check(client);
    expect(result.byRow.A!.matches[0]!.id).toBe(String(PREVIEW_DUPLICATE_PAGE_SIZE + 1));
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1].requests).toHaveLength(1);
    expect(client.calls[1].requests[0].options.idFrom).toBe(PREVIEW_DUPLICATE_PAGE_SIZE + 1);
    client.ignorePaging = true;
    expect((await check(client)).byRow.A!.status).toBe("incomplete");
  });

  it("reports failed checks as incomplete, never clear", async () => {
    const client = new Client(); client.fail = true;
    const result = await check(client);
    expect(result.complete).toBe(false);
    expect(result.byRow.A).toMatchObject({ status: "incomplete" });
    expect(result.byRow.A!.message).toContain("Neověřeno");
  });

  it("flags duplicates within the new batch without choosing which copy to import", async () => {
    const result = await check(new Client(), [input("A"), input("B")]);
    expect(result.byRow.A!.matches[0]).toMatchObject({ location: "batch", rowId: "B" });
    expect(result.byRow.B!.matches[0]).toMatchObject({ location: "batch", rowId: "A" });
  });

  it("recognizes older card purchases whose K reference replaces the supplier receipt number", async () => {
    const client = new Client();
    client.rows = [record(15, { invoiceType: "commitment", originalDocument: "K7", number: { numberRequested: "PK26007" } })];
    const result = await check(client, [{ ...input(), tool: "create_other_liability" }]);
    expect(result.byRow.A!.matches).toEqual([expect.objectContaining({ id: "15", reason: "amount_date" })]);
  });

  it("handles 500 documents with one shared batched POHODA read", async () => {
    const client = new Client();
    const result = await check(client, Array.from({ length: 500 }, (_, i) => input(`R${i}`, { sourceDocumentNumber: `SOURCE-${i}` })));
    expect(client.calls).toHaveLength(1);
    expect(Object.values(result.byRow).every((r) => r.status === "clear")).toBe(true);
  });

  it("refreshes a reused workbook against fresh POHODA data without losing edits or helper columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duplicate-refresh-")); directories.push(dir);
    const client = new Client();
    const service = new ExpenseReviewService({ client: client as any, directory: dir, importer: { run: async () => { throw new Error("No imports"); } } });
    const row = input();
    const args = { databaseId: target.databaseOverride, target, vatPeriod: "2026-11", documents: [{ requestId: row.rowId, tool: row.tool, data: row.data }] };
    const first = await service.prepare(args);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(first.workbookPath);
    const sheet = wb.getWorksheet("Doklady")!;
    const textColumn = REVIEW_COLUMNS.findIndex((c) => c.key === "text") + 1;
    sheet.getCell(3, textColumn).value = "Opravený text";
    const extra = sheet.columnCount + 1;
    sheet.getCell(2, extra).value = "Moje pomocná poznámka";
    sheet.getCell(3, extra).value = "Zachovat";
    await wb.xlsx.writeFile(first.workbookPath);
    client.rows = [record(72)];
    const again = await service.prepare(args);
    expect(again).toMatchObject({ reused: true, status: "requiresReview" });
    // First prepare: supplier address-book read + duplicate snapshot; the refresh re-reads only the snapshot.
    expect(client.calls).toHaveLength(3);
    const refreshed = new ExcelJS.Workbook(); await refreshed.xlsx.readFile(first.workbookPath);
    const updated = refreshed.getWorksheet("Doklady")!;
    expect(updated.getCell(3, textColumn).text).toBe("Opravený text");
    expect(updated.getCell(3, extra).text).toBe("Zachovat");
    expect((updated.getCell(3, textColumn).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFF1F2");
    expect(updated.getCell(3, REVIEW_COLUMNS.findIndex((c) => c.key === "reviewNotes") + 1).text).toContain("#72");
    expect(updated.getCell(3, REVIEW_COLUMNS.findIndex((c) => c.key === "action") + 1).text).toBe("Prověřit");
    const before = await readFile(first.workbookPath);
    await expect(updateReviewDuplicateChecks(first.workbookPath, {}, "stale-hash")).rejects.toThrow(/changed/);
    expect(await readFile(first.workbookPath)).toEqual(before);
  });

  it("delivers all 88 source documents when every document already exists and some amounts are unresolved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "all-duplicates-preview-")); directories.push(dir);
    const pdf = join(dir, "sources.pdf"); await writeFile(pdf, "%PDF-1.4 synthetic review batch");
    const client = new Client();
    const documents = Array.from({ length: 88 }, (_, i) => {
      const row = input(`R${i + 1}`, { sourceType: "pdf", sourcePdfPath: pdf, sourcePages: [i + 1], sourceDocumentNumber: `SOURCE-${i + 1}`, ...(i === 0 ? { total: 121.48 } : {}) });
      const tool = i < 51 ? "create_cash_voucher" as const : i < 76 ? "create_other_liability" as const : "create_invoice" as const;
      const type = tool === "create_cash_voucher" ? "expense" : tool === "create_other_liability" ? "commitment" : "receivedInvoice";
      const stored = record(i + 1, { invoiceType: type, originalDocument: row.data.sourceDocumentNumber });
      client.rows.push(tool === "create_cash_voucher"
        ? { voucherHeader: { ...stored.invoiceHeader, voucherType: "expense" }, voucherSummary: stored.invoiceSummary }
        : stored);
      return { requestId: row.rowId, tool, data: { ...row.data, type, ...(tool === "create_cash_voucher" ? { cashAccount: "HP", sourcePaymentDate: "2026-10-20" } : {}) } };
    });
    const service = new ExpenseReviewService({ client: client as any, directory: dir, importer: { run: async () => { throw new Error("Preparation must never import"); } } });
    const result = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: "2026-11", documents });
    expect(result).toMatchObject({ ok: true, status: "requiresReview", rowCount: 88, nextAction: "deliver_workbook" });
    expect(result.requiresReview).toHaveLength(88);
    expect(result.message).toContain("all rows are duplicates");
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(result.workbookPath);
    const sheet = wb.getWorksheet("Doklady")!;
    expect(sheet.rowCount).toBe(90);
    const actionColumn = REVIEW_COLUMNS.findIndex((c) => c.key === "action") + 1;
    const totalColumn = REVIEW_COLUMNS.findIndex((c) => c.key === "targetTotal") + 1;
    const notesColumn = REVIEW_COLUMNS.findIndex((c) => c.key === "reviewNotes") + 1;
    for (let row = 3; row <= 90; row++) expect(sheet.getCell(row, actionColumn).text).toBe("Prověřit");
    // The source discrepancy is preserved and named, never replaced by a computed POHODA total.
    expect(sheet.getCell(3, totalColumn).value).toBe(121.48);
    expect(sheet.getCell(3, notesColumn).text).toContain("121,48");
    // One batched supplier address-book read and one duplicate snapshot for all 88 rows.
    expect(client.calls).toHaveLength(2);
    const again = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: "2026-11", documents });
    expect(again).toMatchObject({ ok: true, status: "requiresReview", reused: true, nextAction: "deliver_workbook", workbookPath: result.workbookPath });
  });

  it("puts results in the real workbook, blocks unresolved rows and never imports duplicate metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duplicate-review-")); directories.push(dir);
    const client = new Client(); client.rows = [record(91)]; let imports: any[] = [];
    const service = new ExpenseReviewService({ client: client as any, directory: dir, importer: { run: async (ops) => { imports = ops; return { ok: true }; } } });
    const row = input(); const prepared = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: "2026-11", documents: [{ requestId: row.rowId, tool: row.tool, data: row.data }] });
    expect(prepared.status).toBe("requiresReview");
    expect(imports).toHaveLength(0);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(prepared.workbookPath);
    const sheet = wb.getWorksheet("Doklady")!;
    expect(sheet.getCell(3, REVIEW_COLUMNS.findIndex((c) => c.key === "reviewNotes") + 1).text).toContain("#91");
    await expect(service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: target.databaseOverride, target })).rejects.toThrow(/still marked review/);
    sheet.getCell(3, REVIEW_COLUMNS.findIndex((c) => c.key === "action") + 1).value = "Importovat";
    await wb.xlsx.writeFile(prepared.workbookPath);
    await service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: target.databaseOverride, target });
    expect(JSON.stringify(imports)).not.toContain("duplicateCheck");
    expect(JSON.stringify(imports)).not.toContain("Možná duplicita");
  });
});
