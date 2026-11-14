import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { REVIEW_COLUMNS } from "../src/mcp/review-workbook.js";
import { resolveExpensePolicy } from "../src/pohoda/expense-policy.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };

async function setup(overrides: Record<string, any> = {}, lookupSupplier?: (input: any) => Promise<any>, tool = "create_invoice") {
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
  const prepared = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: "2026-11", documents: [{ requestId: "A", tool, reviewNotes: "Ověřit u klienta", data: {
    sourcePdfPath: pdf, sourcePages: [1], taxMode: "taxable", classificationVAT: "PD", partnerIco: "25596641", partnerName: "Test supplier",
    // Legacy aliases must appear visibly and must not undo a user's cleared source cell.
    date: "2026-10-10", dateTax: "2026-10-10", originalDocument: "000123", symVar: "00123",
    text: "Materiál", priceHigh: 100, priceHighVAT: 21, total: 121,
    dateDue: "2026-11-25", accounting: "501", intNote: "Source provenance", ...overrides
  } }] });
  const edit = async (values: Record<string, any>) => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(prepared.workbookPath);
    const sheet = wb.getWorksheet("Doklady")!;
    for (const [key, value] of Object.entries(values)) {
      const index = REVIEW_COLUMNS.findIndex((c) => c.key === key);
      if (index < 0) throw new Error(`no workbook column ${key}`);
      sheet.getCell(3, index + 1).value = value;
    }
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
    await edit({ text: "Oprava", targetPriceHigh: "200,00", targetPriceHighVAT: 42, targetTotal: 242, accounting: null, dateDue: null, reviewNotes: "PRIVATE REVIEW NOTE", action: "Importovat" });
    expect((await submit()).ok).toBe(true);
    expect(runs).toHaveLength(1);
    const header = runs[0].ops[0].header;
    // Target amount edits become the source amounts the policy uses; other source facts stay.
    expect(header).toMatchObject({ text: "Oprava", priceHigh: "200.00", priceHighVAT: 42, total: 242, sourceDocumentNumber: "000123", sourceSymVar: "00123", sourceIssueDate: "2026-10-10", intNote: "Source provenance" });
    for (const field of ["accounting", "dateDue", "symVar"]) expect(header[field]).toBeUndefined();
    expect(JSON.stringify(runs)).not.toContain("PRIVATE REVIEW NOTE");
    expect((await submit()).repeated).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("keeps an unused receipt due date out of view without losing a reviewer-entered value", async () => {
    const { prepared, edit, submit, runs } = await setup({ paymentType: "cash", dateDue: undefined });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(prepared.workbookPath);
    const sheet = wb.getWorksheet("Doklady")!;
    const dueColumn = REVIEW_COLUMNS.findIndex((c) => c.key === "dateDue") + 1;
    expect(sheet.getColumn(dueColumn).hidden).toBe(true);
    await edit({ dateDue: "2026-11-25" });
    await submit();
    expect(runs[0].ops[0].header.dateDue).toBe("2026-11-25");
  });

  it("does not resurrect a cleared source document number through the originalDocument alias", async () => {
    const { edit, submit, runs } = await setup();
    await edit({ targetDocument: null });
    await expect(submit()).rejects.toMatchObject({ details: { invalid: [expect.objectContaining({ errorCode: "SOURCE_DOCUMENT_NUMBER_REQUIRED", error: "Chybí číslo dokladu dodavatele." })] } });
    expect(runs).toHaveLength(0);
  });

  it("blocks formulas, even with a plausible cached result, before importing", async () => {
    const { edit, submit, runs } = await setup();
    await edit({ targetTotal: { formula: "100+21", result: 121 } });
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
    await edit({ targetPriceNone: null, targetPriceHigh: 100, targetPriceHighVAT: 21 });
    await expect(submit()).rejects.toThrow(/Režim DPH dodavatele nelze z registru jednoznačně určit/);
    expect(runs).toHaveLength(0);
  });

  it("rechecks a payer decision when the reviewer removes VAT", async () => {
    const lookup = async () => ({ status: "matched", fetchedAt: "2026-11-14", supplier: { name: "Test supplier", ico: "25596641", country: "CZ" }, vat: { status: "payer" } });
    const { edit, submit, runs } = await setup({ taxMode: "auto", sourceChargesVat: true }, lookup);
    await edit({ targetPriceHigh: null, targetPriceHighVAT: null, targetPriceNone: 121 });
    await expect(submit()).rejects.toThrow(/Režim DPH dodavatele nelze z registru jednoznačně určit/);
    expect(runs).toHaveLength(0);
  });

  it("does not carry registry-filled identity into a replacement supplier", async () => {
    const lookup = async () => ({ status: "matched", fetchedAt: "2026-11-14", supplier: { name: "Old Supplier", ico: "25596641", street: "Old address 1", country: "CZ" }, vat: { status: "payer" } });
    const { edit, submit, runs } = await setup({ partnerName: "" }, lookup);
    await edit({ partnerIco: "27082440" });
    await expect(submit()).rejects.toThrow(/Dodavatel byl změněn/);
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

  describe("computed POHODA Doklad/VS columns match what the import writes", () => {
    const cell = async (path: string, key: string) => {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path);
      const sheet = wb.getWorksheet("Doklady")!, column = REVIEW_COLUMNS.findIndex((c) => c.key === key) + 1;
      return { value: sheet.getCell(3, column).value, hidden: sheet.getColumn(column).hidden };
    };
    // The importer runs the same policy on the submitted header; card numbers come from the PK series.
    const imported = (header: any, tool: string, cardSequence = 7) =>
      resolveExpensePolicy({ ...header, ...(header.cardPayment ? { cardSequence } : {}) }, [], tool === "create_cash_voucher" ? "voucher" : "invoice");
    const pn = (total: number, rounding?: number) => ({
      taxMode: "nonTax", classificationVAT: "", sourceChargesVat: false, priceHigh: undefined, priceHighVAT: undefined, dateDue: undefined,
      priceNone: rounding === undefined ? total : Math.round((total - rounding) * 100) / 100, total, ...(rounding === undefined ? {} : { roundingAmount: rounding }),
      originalDocument: "UCT-4711", symVar: undefined
    });
    const cases: Array<[string, number, number | undefined, boolean]> = [
      ["9 999.99", 9999.99, undefined, false],
      ["10 000.00", 10000, undefined, false],
      ["10 000.01", 10000.01, undefined, true],
      ["rounded down to 10 000 (source buckets 10 000.49)", 10000, -0.49, false],
      ["rounded up to 10 001 (source buckets 10 000.50)", 10001, 0.5, true]
    ];

    it.each(cases)("cash receipt %s", async (_label, total, rounding, above) => {
      const { prepared, submit, runs } = await setup({ ...pn(total, rounding ?? 0), cashAccount: "HP", sourcePaymentDate: "2026-10-10" }, undefined, "create_cash_voucher");
      const doc = await cell(prepared.workbookPath, "targetDocument");
      expect(doc.hidden).toBe(false);
      expect(doc.value).toBe(above ? "UCT-4711" : null);
      await submit();
      const header = runs[0].ops[0].header;
      expect(header.sourceDocumentNumber).toBe("UCT-4711");
      // Datum úhrady is not in the XLSX; the prepared actual payment date still reaches import.
      expect(header.sourcePaymentDate).toBe("2026-10-10");
      const result = imported(header, "create_cash_voucher");
      expect(result.datePayment).toBe("2026-10-10");
      expect(result.originalDocument ?? null).toBe(doc.value);
      if (!above) expect(result.intNote).toContain("UCT-4711"); // source number kept for provenance
    });

    it.each(cases)("card commitment %s", async (_label, total, rounding, above) => {
      const { prepared, submit, runs } = await setup({ ...pn(total, rounding), cardPayment: true }, undefined, "create_other_liability");
      const doc = await cell(prepared.workbookPath, "targetDocument"), vs = await cell(prepared.workbookPath, "targetSymVar");
      expect(doc.value).toBe(above ? "UCT-4711" : "Přidělí se z PK");
      expect(vs.value).toBe(above ? null : "Přidělí se z PK");
      await submit();
      const result = imported(runs[0].ops[0].header, "create_other_liability");
      expect(result.originalDocument).toBe(above ? "UCT-4711" : "K7");
      expect(result.symVar ?? null).toBe(above ? null : "7");
    });

    it("shows the received-invoice VS derived from the supplier number without inventing a source VS", async () => {
      const { prepared, submit, runs } = await setup({ symVar: undefined, originalDocument: "FV-2026/0007" });
      expect((await cell(prepared.workbookPath, "targetSymVar")).value).toBe("20260007");
      expect((await cell(prepared.workbookPath, "targetDocument")).value).toBe("FV-2026/0007");
      await submit();
      const header = runs[0].ops[0].header;
      expect(header.sourceSymVar).toBeUndefined();
      // An unpaid invoice gets no payment date from its issue, due or tax date.
      expect(header.sourcePaymentDate).toBeUndefined();
      expect(imported(header, "create_invoice").datePayment).toBeUndefined();
      expect(imported(header, "create_invoice")).toMatchObject({ originalDocument: "FV-2026/0007", symVar: "20260007" });
    });
  });
});
