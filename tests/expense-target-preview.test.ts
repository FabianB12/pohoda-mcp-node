/**
 * Target-only reviewed preview and Forma úhrady (synthetic MCPTEST data only).
 * Real XLSX: prepare -> (edit) -> inspect -> import (fake importer) -> shared XML builder.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { REVIEW_COLUMNS, REVIEW_LEGACY_COLUMNS } from "../src/mcp/review-workbook.js";
import { resolveExpensePolicy } from "../src/pohoda/expense-policy.js";
import { PohodaClient } from "../src/pohoda/client.js";
import type { CliXmlJobResult, XmlTransport } from "../src/pohoda/transport.js";

const PERIOD = "2026-10";
const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

type Tool = "create_invoice" | "create_other_liability" | "create_cash_voucher";
const base = { partnerIco: "25596641", partnerName: "MCPTEST Supplier s.r.o.", partnerCountry: "CZ", text: "MCPTEST materiál", accounting: "501" };
const taxable = (extra: Record<string, any> = {}) => ({ ...base, taxMode: "taxable", classificationVAT: "PD", priceHigh: 1000, priceHighVAT: 210, total: 1210, ...extra });

async function setup(docs: Array<{ requestId: string; tool: Tool; data: Record<string, any> }>) {
  const dir = await mkdtemp(join(tmpdir(), "target-preview-")); dirs.push(dir);
  const pdf = join(dir, "source.pdf"); await writeFile(pdf, "%PDF-1.4 MCPTEST");
  const runs: any[] = [];
  const client = { listRecordsBatch: async (requests: any[]) => ({ isOk: () => true, items: requests.map(() => ({ state: "ok", data: { invoice: [], voucher: [] } })) }) };
  const importer = { run: async (ops: any[], id: string) => {
    runs.push({ ops: structuredClone(ops), id });
    return { ok: true, state: "ok", results: ops.map((op, i) => ({ requestId: op.requestId, id: i + 1, created: true, verified: true })) };
  } };
  const service = new ExpenseReviewService({ client: client as any, importer, directory: dir });
  const prepared = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: PERIOD, documents: docs.map((d, i) => ({ ...d, data: { sourcePdfPath: pdf, sourcePages: [i + 1], ...d.data } })) });
  const path = prepared.workbookPath as string;
  const load = async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path); return { wb, ws: wb.getWorksheet("Doklady")! }; };
  const rowOf = (ws: ExcelJS.Worksheet, id: string) => { for (let r = 3; r <= ws.rowCount; r++) if (ws.getCell(r, 1).value === id) return r; throw new Error(id); };
  const colOf = (key: string) => { const i = REVIEW_COLUMNS.findIndex((c) => c.key === key); if (i < 0) throw new Error(key); return i + 1; };
  const cell = async (id: string, key: string) => { const { ws } = await load(); return ws.getCell(rowOf(ws, id), colOf(key)).value; };
  const edit = async (id: string, values: Record<string, unknown>) => {
    const { wb, ws } = await load();
    for (const [key, value] of Object.entries(values)) ws.getCell(rowOf(ws, id), colOf(key)).value = value as ExcelJS.CellValue;
    await wb.xlsx.writeFile(path);
  };
  /** Rewrites the sheet into an older layout: adds legacy columns after the last one. */
  const addLegacy = async (values: Record<string, Record<string, unknown>>) => {
    const { wb, ws } = await load();
    let column = ws.columnCount;
    for (const key of new Set(Object.values(values).flatMap((v) => Object.keys(v)))) {
      column++;
      ws.getCell(2, column).value = REVIEW_LEGACY_COLUMNS.find((c) => c.key === key)!.label;
      for (const [id, row] of Object.entries(values)) if (key in row) ws.getCell(rowOf(ws, id), column).value = row[key] as ExcelJS.CellValue;
    }
    await wb.xlsx.writeFile(path);
  };
  const importAll = async () => { const { wb, ws } = await load(); for (let r = 3; r <= ws.rowCount; r++) if (ws.getCell(r, 1).value) ws.getCell(r, colOf("action")).value = "Importovat"; await wb.xlsx.writeFile(path); };
  const submit = () => service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: target.databaseOverride, target });
  const inspect = () => service.inspect({ reviewId: prepared.reviewId });
  const header = (id: string, run = runs.at(-1)) => run.ops.find((op: any) => op.requestId === id).header;
  return { service, prepared, path, load, colOf, cell, edit, addLegacy, importAll, submit, inspect, runs, header };
}

/** Same normalization ExpenseImporter applies before writing; PK sequence 7 stands in for the live series. */
const written = (header: any, tool: Tool) => resolveExpensePolicy({ ...header, ...(header.cardPayment ? { cardSequence: 7 } : {}) }, [], tool === "create_cash_voucher" ? "voucher" : "invoice");
const iso = (v: unknown) => v instanceof Date ? v.toISOString().slice(0, 10) : v;

class FakeTransport implements XmlTransport {
  public calls: string[] = [];
  async exchange(xml: string, database: string): Promise<CliXmlJobResult> {
    this.calls.push(xml);
    return { xml: '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"/></rsp:responsePack>', jobId: "job", database, jobDir: "/tmp/job", queueWaitMs: 0, processSlotWaitMs: 0, durationMs: 1, exitCode: 0, jobRetained: false };
  }
  status(): Record<string, unknown> { return {}; }
}
async function xmlOf(op: any, tool: Tool): Promise<string> {
  const transport = new FakeTransport();
  await new PohodaClient({ transport, ico: target.dataPackIco, database: target.databaseOverride }).writeBatch([{ ...op, header: written(op.header, tool), items: [] }], `MCPTEST-${op.requestId}`);
  return transport.calls[0]!;
}

describe("target-only preview", () => {
  it("shows exactly the POHODA values: late dates on day one, current dates kept, PN gross without KH, cash payment date kept", async () => {
    const t = await setup([
      { requestId: "LATE", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-08-04", sourceTaxDate: "2026-08-04", sourceDocumentNumber: "MCPTEST-0804", dateDue: "2026-08-18" }) },
      { requestId: "CURRENT", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-10", sourceDocumentNumber: "MCPTEST-1012" }) },
      { requestId: "PN", tool: "create_invoice", data: { ...base, taxMode: "nonTax", sourceIssueDate: "2026-09-21", sourceDocumentNumber: "MCPTEST-0921", priceHigh: 100, priceHighVAT: 21, total: 121 } },
      { requestId: "CASH", tool: "create_cash_voucher", data: taxable({ sourceIssueDate: "2026-10-05", sourceTaxDate: "2026-10-05", sourcePaymentDate: "2026-10-06", sourceDocumentNumber: "MCPTEST-1005", cashAccount: "HP", priceHigh: 100, priceHighVAT: 21, total: 121, roundingAmount: 0 }) }
    ]);
    const { ws } = await t.load();
    const headers = (ws.getRow(2).values as unknown[]).map(String);
    expect(headers.filter((h) => /\(zdroj\)|Platba kartou/.test(h))).toEqual([]);
    const dates = async (id: string) => Promise.all(["targetDate", "targetDateTax", "targetDateAccounting", "targetDateKHDPH"].map(async (k) => iso(await t.cell(id, k)) ?? null));
    expect(await dates("LATE")).toEqual(["2026-10-01", "2026-10-01", "2026-10-01", "2026-10-01"]);
    expect(await dates("CURRENT")).toEqual(["2026-10-12", "2026-10-10", null, "2026-10-10"]);
    expect(await dates("PN")).toEqual(["2026-10-01", "2026-10-01", "2026-10-01", null]);
    expect(await dates("CASH")).toEqual(["2026-10-05", "2026-10-05", null, "2026-10-05"]);
    expect([await t.cell("PN", "targetPriceNone"), await t.cell("PN", "targetPriceHigh"), await t.cell("PN", "classificationVAT")]).toEqual([121, null, "PN"]);
    expect(await t.cell("CASH", "targetDocument")).toBeNull(); // cash <= 10 000 CZK has no Doklad
    expect(await t.cell("LATE", "targetDocument")).toBe("MCPTEST-0804");
    // Datum splatnosti: printed due date (kept on a late document), else the original issue
    // date; Pokladna has no due date in POHODA XML, so its cell stays blank.
    const due = async (id: string) => iso(await t.cell(id, "targetDateDue")) ?? null;
    expect([await due("LATE"), await due("CURRENT"), await due("PN"), await due("CASH")]).toEqual(["2026-08-18", "2026-10-12", "2026-09-21", null]);

    await t.importAll();
    expect((await t.submit()).ok).toBe(true);
    for (const id of ["LATE", "CURRENT", "PN", "CASH"]) {
      const tool: Tool = id === "CASH" ? "create_cash_voucher" : "create_invoice";
      const out = written(t.header(id), tool);
      expect([id, ...(await dates(id))]).toEqual([id, out.date ?? null, out.dateTax ?? null, tool === "create_cash_voucher" ? null : out.dateAccounting ?? null, out.dateKHDPH ?? null]);
      expect([id, await due(id)]).toEqual([id, out.dateDue ?? null]);
    }
    // Source facts reach the import unchanged even though no source column is shown.
    expect(t.header("LATE")).toMatchObject({ sourceIssueDate: "2026-08-04", sourceTaxDate: "2026-08-04", sourceDocumentNumber: "MCPTEST-0804" });
    expect(written(t.header("LATE"), "create_invoice").intNote).toContain("vystaveno 2026-08-04");
    expect(written(t.header("CASH"), "create_cash_voucher").datePayment).toBe("2026-10-06");
  });

  it("maps target edits to source fields, re-checks them, and rejects what the policy locks", async () => {
    const t = await setup([
      { requestId: "LATE", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-08-04", sourceTaxDate: "2026-08-04", sourceDocumentNumber: "MCPTEST-0804" }) },
      { requestId: "CURRENT", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-10", sourceDocumentNumber: "MCPTEST-1012" }) },
      { requestId: "PN", tool: "create_invoice", data: { ...base, taxMode: "nonTax", sourceIssueDate: "2026-10-02", sourceDocumentNumber: "MCPTEST-PN", priceHigh: 100, priceHighVAT: 21, total: 121 } }
    ]);
    await t.importAll();
    // The reviewer types the old source month into a late row: rejected with the reason, nothing written.
    await t.edit("LATE", { targetDate: "04.08.2026" });
    // An in-period date and an amount set stay possible and are recomputed.
    await t.edit("CURRENT", { targetDate: "2026-10-15", targetDocument: "MCPTEST-1015", targetPriceHigh: 2000, targetPriceHighVAT: 420, targetTotal: 2420 });
    // The VS derived from the old number would be stale: the reviewer brings it up to date.
    await t.edit("CURRENT", { targetSymVar: "1015" });
    // So would the issue-date default of Datum splatnosti (the source prints no due date).
    expect((await t.inspect()).rows.find((r: any) => r.rowId === "CURRENT")).toMatchObject({ valid: false, error: expect.stringContaining("Datum splatnosti 2026-10-12 → 2026-10-15") });
    await t.edit("CURRENT", { targetDateDue: "2026-10-15" });
    // PN keeps the whole gross in Bez DPH / PN; a VAT bucket cannot appear there.
    await t.edit("PN", { targetPriceHigh: 100 });
    const view = await t.inspect();
    const row = (id: string) => view.rows.find((r: any) => r.rowId === id);
    expect(row("LATE")).toMatchObject({ valid: false, error: expect.stringMatching(/Datum dokladu: 2026-08-04 nelze zapsat, podle pravidel importu bude 2026-10-01 \(pozdní doklad/) });
    expect(row("PN")).toMatchObject({ valid: false, error: expect.stringContaining("PN: celá částka") });
    expect(row("CURRENT")).toMatchObject({ valid: true, changedFields: expect.arrayContaining(["sourceIssueDate", "sourceDocumentNumber", "priceHigh", "priceHighVAT", "total"]) });
    expect(row("CURRENT").changedFields).not.toContain("sourceSymVar"); // updated dependent cell, not a new source fact
    expect(row("CURRENT").changedFields).not.toContain("sourceDueDate");
    expect(row("CURRENT").preview.planned).toMatchObject({ date: "2026-10-15", dateDue: "2026-10-15", dueDateRule: "issue-date", originalDocument: "MCPTEST-1015", priceHigh: 2000, total: 2420 });
    await expect(t.submit()).rejects.toThrow(/nelze zapsat/);
    expect(t.runs).toHaveLength(0);

    // Restoring the shown values clears the locks; only the deliberate edits are imported.
    await t.edit("LATE", { targetDate: new Date(Date.UTC(2026, 9, 1)) });
    await t.edit("PN", { targetPriceHigh: null });
    expect((await t.submit()).ok).toBe(true);
    expect(t.header("LATE").sourceIssueDate).toBe("2026-08-04");
    expect(written(t.header("CURRENT"), "create_invoice")).toMatchObject({ date: "2026-10-15", dateDue: "2026-10-15", originalDocument: "MCPTEST-1015", priceHigh: 2000, priceHighVAT: 420, total: 2420 });
  });

  it("blocks a Celkem edit until the derived rounding is visible, without making it a source fact", async () => {
    const t = await setup([{ requestId: "R", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourceDocumentNumber: "MCPTEST-R", priceHigh: 688, priceHighVAT: 144.48, total: 832.48 }) }]);
    expect([await t.cell("R", "targetRounding"), await t.cell("R", "targetTotal")]).toEqual([null, 832.48]);
    await t.importAll();
    await t.edit("R", { targetTotal: 832 });
    expect((await t.inspect()).rows[0]).toMatchObject({ valid: false, error: expect.stringContaining("Zaokrouhlení (prázdné) → -0.48") });
    await expect(t.submit()).rejects.toThrow(/neukazuje importované hodnoty/);
    await t.edit("R", { targetRounding: -0.48 });
    const row = (await t.inspect()).rows[0];
    expect(row).toMatchObject({ valid: true, changedFields: ["total"], preview: { planned: { roundingAmount: -0.48, roundingRule: "derived-from-payable", total: 832 } } });
    await t.submit();
    expect(t.header("R").roundingAmount).toBeUndefined();
    expect(written(t.header("R"), "create_invoice")).toMatchObject({ roundingAmount: -0.48, total: 832 });
  });

  it("turns PN on and off through Členění DPH", async () => {
    const t = await setup([{ requestId: "A", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourceDocumentNumber: "MCPTEST-A" }) }]);
    await t.importAll();
    await t.edit("A", { classificationVAT: "PN" });
    // The taxable cells still shown (KH date, VAT buckets, no PN gross) are not what PN imports.
    const stale = (await t.inspect()).rows[0];
    expect(stale).toMatchObject({ valid: false, error: expect.stringContaining("Datum KH DPH 2026-10-12 → vymazat; Bez DPH / PN (prázdné) → 1210; Základ 21 % 1000 → vymazat; DPH 21 % 210 → vymazat") });
    await expect(t.submit()).rejects.toThrow(/neukazuje importované hodnoty/);
    expect(t.runs).toHaveLength(0);
    await t.edit("A", { targetDateKHDPH: null, targetPriceNone: 1210, targetPriceHigh: null, targetPriceHighVAT: null });
    const fixed = (await t.inspect()).rows[0];
    expect(fixed.valid).toBe(true);
    expect([...fixed.changedFields].sort()).toEqual(["classificationVAT", "taxMode"]); // no price/date source edits
    await t.submit();
    expect(written(t.header("A"), "create_invoice")).toMatchObject({ classificationVAT: "PN", priceNone: 1210, taxMode: "nonTax" });
    expect(written(t.header("A"), "create_invoice").dateKHDPH).toBeUndefined();
    // Updating the visible cells did not overwrite the source VAT breakdown.
    expect(t.header("A")).toMatchObject({ priceHigh: 1000, priceHighVAT: 210, total: 1210 });
  });
});

describe("Forma úhrady", () => {
  const card = (extra: Record<string, any> = {}) => ({ ...base, taxMode: "nonTax", sourceIssueDate: "2026-10-03", sourceDocumentNumber: "MCPTEST-K1", priceNone: 250, total: 250, ...extra });

  it("shows source methods in Czech, with no card Ano/Ne column, for mixed invoice/card/cash rows", async () => {
    const t = await setup([
      { requestId: "INV", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourceDocumentNumber: "MCPTEST-I", paymentType: "draft" }) },
      { requestId: "DEL", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourceDocumentNumber: "MCPTEST-D", paymentType: "delivery" }) },
      { requestId: "CARD", tool: "create_other_liability", data: card({ cardPayment: true }) },
      { requestId: "CASH", tool: "create_cash_voucher", data: taxable({ sourceIssueDate: "2026-10-05", sourceTaxDate: "2026-10-05", sourcePaymentDate: "2026-10-05", cashAccount: "HP", priceHigh: 100, priceHighVAT: 21, total: 121, roundingAmount: 0 }) },
      { requestId: "UNKNOWN", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourceDocumentNumber: "MCPTEST-U" }) },
      { requestId: "ZAP", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourceDocumentNumber: "MCPTEST-Z", paymentType: "compensation" }) }
    ]);
    const labels = await Promise.all(["INV", "DEL", "CARD", "CASH", "UNKNOWN", "ZAP"].map((id) => t.cell(id, "paymentType")));
    expect(labels).toEqual(["Převodem", "Dobírkou", "Kartou", "Hotově", null, "Zápočtem"]);
    const { ws } = await t.load();
    expect(ws.getColumn(t.colOf("paymentType")).hidden).toBe(false);
    expect((ws.getRow(2).values as unknown[]).map(String)).not.toContain("Platba kartou");
    expect(ws.getCell(3, t.colOf("paymentType")).dataValidation).toMatchObject({ type: "list", errorStyle: "warning" });
    expect([await t.cell("CARD", "targetDocument"), await t.cell("CARD", "targetSymVar")]).toEqual(["Přidělí se z PK", "Přidělí se z PK"]);

    await t.importAll();
    await t.submit();
    expect(t.header("INV").paymentType).toBe("draft");
    expect(t.header("UNKNOWN").paymentType).toBeUndefined(); // unknown stays unknown, no default
    expect(t.header("CASH").paymentType).toBeUndefined(); // vch:voucherHeader has no paymentType
    expect(t.header("CARD")).toMatchObject({ paymentType: "creditcard", cardPayment: true });
    expect(written(t.header("CARD"), "create_other_liability")).toMatchObject({ originalDocument: "K7", symVar: "7", paymentType: "creditcard" });
    expect(t.header("ZAP").paymentType).toBe("compensation");
    const xml = await xmlOf(t.runs[0].ops.find((op: any) => op.requestId === "DEL"), "create_invoice");
    expect(xml).toContain("<typ:paymentType>delivery</typ:paymentType>");
    expect(xml).not.toContain("<typ:ids>delivery</typ:ids>");
    expect(await xmlOf(t.runs[0].ops.find((op: any) => op.requestId === "CARD"), "create_other_liability")).toContain("<typ:paymentType>creditcard</typ:paymentType>");
  });

  it("Kartou -> Převodem clears PK numbering and Převodem -> Kartou applies it before import", async () => {
    const t = await setup([
      { requestId: "K", tool: "create_other_liability", data: card({ paymentType: "card" }) },
      { requestId: "P", tool: "create_other_liability", data: card({ paymentType: "draft", sourceDocumentNumber: "MCPTEST-P1" }) }
    ]);
    await t.importAll();
    await t.edit("K", { paymentType: "Převodem" });
    await t.edit("P", { paymentType: "kartou" });
    const stale = await t.inspect();
    const error = (id: string) => stale.rows.find((r: any) => r.rowId === id).error;
    expect(error("K")).toContain("Doklad v POHODĚ Přidělí se z PK → MCPTEST-K1; VS v POHODĚ Přidělí se z PK → vymazat");
    expect(error("P")).toContain("Doklad v POHODĚ MCPTEST-P1 → Přidělí se z PK");
    await expect(t.submit()).rejects.toThrow(/neukazuje importované hodnoty/);
    await t.edit("K", { targetDocument: "MCPTEST-K1", targetSymVar: null });
    await t.edit("P", { targetDocument: "Přidělí se z PK", targetSymVar: "Přidělí se z PK" });
    const view = await t.inspect();
    const planned = (id: string) => view.rows.find((r: any) => r.rowId === id).preview.planned;
    expect(planned("K")).toMatchObject({ originalDocument: "MCPTEST-K1", originalDocumentRule: "source-document", paymentType: "draft" });
    expect(planned("P")).toMatchObject({ originalDocument: "assigned from the next PK number at import", originalDocumentRule: "card-sequence", paymentType: "creditcard" });
    await t.submit();
    expect(t.header("K").cardPayment).toBeUndefined();
    expect(t.header("K").paymentType).toBe("draft");
    expect(t.header("P")).toMatchObject({ cardPayment: true, paymentType: "creditcard" });
  });

  it("rejects a non-cash method on a cash voucher and an unknown typed method", async () => {
    const t = await setup([
      { requestId: "CASH", tool: "create_cash_voucher", data: taxable({ sourceIssueDate: "2026-10-05", sourceTaxDate: "2026-10-05", sourcePaymentDate: "2026-10-05", cashAccount: "HP", priceHigh: 100, priceHighVAT: 21, total: 121, roundingAmount: 0 }) },
      { requestId: "INV", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourceDocumentNumber: "MCPTEST-I" }) }
    ]);
    await t.importAll();
    await t.edit("CASH", { paymentType: "Kartou" });
    await t.edit("INV", { paymentType: "Bitcoin" });
    const view = await t.inspect();
    expect(view.rows.find((r: any) => r.rowId === "CASH")).toMatchObject({ valid: false, error: expect.stringContaining("Účtenka placená kartou patří do Ostatních závazků") });
    expect(view.rows.find((r: any) => r.rowId === "INV")).toMatchObject({ valid: false, error: expect.stringContaining('Forma úhrady "Bitcoin" není známá') });
    await expect(t.submit()).rejects.toThrow();
    expect(t.runs).toHaveLength(0);
  });

  it("holds contradictory or agenda-changing card inputs for review instead of choosing silently", async () => {
    const t = await setup([
      { requestId: "CONFLICT", tool: "create_other_liability", data: card({ cardPayment: true, paymentType: "cash" }) },
      { requestId: "RECEIVED", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourceDocumentNumber: "MCPTEST-R", cardPayment: true }) },
      { requestId: "NONCARD", tool: "create_other_liability", data: card({ cardPayment: false, partnerIco: "27082440", partnerName: "MCPTEST Other s.r.o.", sourceDocumentNumber: "MCPTEST-K3", priceNone: 260, total: 260 }) }
    ]);
    const row = (id: string) => t.prepared.rows.find((r: any) => r.rowId === id);
    expect(row("CONFLICT")).toMatchObject({ action: "review", reviewNotes: expect.stringContaining("Platba kartou = Ano, ale Forma úhrady = Hotově") });
    expect(row("RECEIVED")).toMatchObject({ action: "review", reviewNotes: expect.stringContaining("Přijaté faktury") });
    expect(row("NONCARD").action).toBe("import");
    expect(await t.cell("NONCARD", "paymentType")).toBeNull();
    await t.importAll();
    await t.submit();
    // The received invoice stays a received invoice; only the method is card. No PK numbering.
    expect(t.header("RECEIVED")).toMatchObject({ type: "receivedInvoice", paymentType: "creditcard" });
    expect(t.header("RECEIVED").cardPayment).toBeUndefined();
    expect(t.header("CONFLICT").paymentType).toBe("cash");
    expect(t.header("NONCARD").cardPayment).toBeUndefined();
    expect(t.header("NONCARD").paymentType).toBeUndefined();
  });

  it("routes a card receipt to Ostatní závazky: blocks it as Pokladna, keeps a real card-paid invoice", async () => {
    const receipt = taxable({ sourceIssueDate: "2026-10-05", sourceTaxDate: "2026-10-05", sourcePaymentDate: "2026-10-05", sourceDocumentNumber: "MCPTEST-UCT", priceHigh: 100, priceHighVAT: 21, total: 121, roundingAmount: 0, paymentType: "Kartou" });
    const t = await setup([
      { requestId: "CASHCARD", tool: "create_cash_voucher", data: { ...receipt, cashAccount: "HP" } },
      { requestId: "PK", tool: "create_other_liability", data: { ...receipt, partnerIco: "27082440", partnerName: "MCPTEST Other s.r.o." } },
      { requestId: "FP", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourceDocumentNumber: "MCPTEST-FPK", paymentType: "creditcard", dateDue: "2026-10-26" }) }
    ]);
    const row = (id: string) => t.prepared.rows.find((r: any) => r.rowId === id);
    // Wrong agenda: flagged before the preview is delivered, never switched silently.
    expect(row("CASHCARD")).toMatchObject({ action: "review", reviewNotes: expect.stringContaining("Účtenka placená kartou patří do Ostatních závazků") });
    expect(row("PK").action).toBe("import");
    expect([await t.cell("PK", "targetDocument"), iso(await t.cell("PK", "targetDateDue"))]).toEqual(["Přidělí se z PK", "2026-10-05"]);
    expect(row("FP").action).toBe("import");
    expect([await t.cell("FP", "paymentType"), await t.cell("FP", "targetDocument"), iso(await t.cell("FP", "targetDateDue"))]).toEqual(["Kartou", "MCPTEST-FPK", "2026-10-26"]);
    await t.importAll();
    await expect(t.submit()).rejects.toThrow(/Ostatních závazků/);
    await t.edit("CASHCARD", { action: "Vynechat" });
    await t.submit();
    expect(t.header("PK")).toMatchObject({ type: "commitment", cardPayment: true, paymentType: "creditcard" });
    expect(t.header("FP")).toMatchObject({ type: "receivedInvoice", paymentType: "creditcard" });
    expect(t.header("FP").cardPayment).toBeUndefined();
    expect(written(t.header("FP"), "create_invoice")).toMatchObject({ originalDocument: "MCPTEST-FPK", dateDue: "2026-10-26" });
  });

  it("reads an older workbook's Platba kartou column, and blocks a contradiction with Forma úhrady", async () => {
    const t = await setup([
      { requestId: "OLD", tool: "create_other_liability", data: card() },
      { requestId: "BAD", tool: "create_other_liability", data: card({ sourceDocumentNumber: "MCPTEST-K2", paymentType: "cash" }) }
    ]);
    await t.importAll();
    await t.addLegacy({ OLD: { cardPayment: "Ano" }, BAD: { cardPayment: "Ano" } });
    const view = await t.inspect();
    // The legacy card flag switches OLD to PK numbering, so its shown number is stale.
    expect(view.rows.find((r: any) => r.rowId === "OLD")).toMatchObject({ valid: false, error: expect.stringContaining("Doklad v POHODĚ MCPTEST-K1 → Přidělí se z PK") });
    expect(view.rows.find((r: any) => r.rowId === "BAD")).toMatchObject({ valid: false, error: expect.stringContaining("Platba kartou = Ano, ale Forma úhrady = Hotově") });
    await t.addLegacy({ BAD: { cardPayment: "Ne" } }); // a second legacy column is a duplicate header
    await expect(t.inspect()).rejects.toThrow(/DUPLICATE_COLUMN/);
  });

  it("keeps an older full-layout workbook (source columns, hidden Forma úhrady text) usable", async () => {
    const t = await setup([{ requestId: "FP", tool: "create_invoice", data: taxable({ sourceIssueDate: "2026-08-04", sourceTaxDate: "2026-08-04", sourceDocumentNumber: "MCPTEST-FA", paymentType: "delivery" }) }]);
    await t.importAll();
    const { wb, ws } = await t.load();
    ws.getCell(2, t.colOf("targetDocument")).value = "Doklad v POHODĚ (vypočteno)";
    ws.getCell(2, t.colOf("targetDateDue")).value = "Datum splatnosti (zdroj)";
    ws.getCell(3, t.colOf("paymentType")).value = "delivery"; // old layout wrote the raw enum
    await wb.xlsx.writeFile(t.path);
    await t.addLegacy({ FP: { cardPayment: "Ne", sourceIssueDate: "2026-08-04", sourceTaxDate: "2026-08-04", total: 1210 } });
    const view = await t.inspect();
    expect(view.errors).toEqual([]);
    expect(view.rows[0]).toMatchObject({ valid: true, changedFields: [] });
    await t.submit();
    expect(written(t.header("FP"), "create_invoice")).toMatchObject({ paymentType: "delivery", date: "2026-10-01", sourceIssueDate: "2026-08-04", dateDue: "2026-08-04" });
  });
});
