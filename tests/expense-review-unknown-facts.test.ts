/**
 * A row the import rejects still previews every independent source fact: an unknown tax
 * mode, a payment-method conflict, one invalid date or amount, or a totals mismatch
 * blanks only the values that depend on it. The strict import policy is unchanged
 * (synthetic MCPTEST data only; fake transport, no POHODA writes).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { computeReviewTargets, REVIEW_COLUMNS, reviewPolicyIssue } from "../src/mcp/review-workbook.js";
import { ExpensePolicyError, projectExpensePolicy, resolveExpensePolicy } from "../src/pohoda/expense-policy.js";

const PERIOD = "2026-10";
const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

/** German supplier invoiced in CZK with Czech VAT; no tax-mode decision yet. */
const foreignUnknown = {
  text: "MCPTEST Licence", partnerName: "MCPTEST GmbH", partnerCountry: "DE", partnerDic: "DE123456789", accounting: "518",
  sourceIssueDate: "2026-10-03", sourceTaxDate: "2026-10-03", sourceDocumentNumber: "MCPTEST-DE-1", priceHigh: 1000, priceHighVAT: 210, total: 1210
};
const domesticTaxable = {
  text: "MCPTEST Materiál", partnerName: "MCPTEST s.r.o.", partnerCountry: "CZ", partnerDic: "CZ25596641", accounting: "501", taxMode: "taxable", classificationVAT: "PD",
  sourceIssueDate: "2026-10-02", sourceTaxDate: "2026-10-04", sourceDocumentNumber: "MCPTEST-FV-2", priceHigh: 1000, priceHighVAT: 210, total: 1210
};
const header = (data: Record<string, any>, type = "receivedInvoice") => ({ ...data, type, vatPeriod: PERIOD });
const codes = (issues: ExpensePolicyError[]) => issues.map((i) => i.code);

describe("policy projection keeps independent facts", () => {
  it("a card receipt routed to cash remains blocked but retains its known amounts and dates", () => {
    const input = { ...header(domesticTaxable, "expense"), paymentType: "creditcard", sourcePaymentDate: "2026-10-04", roundingAmount: 0 };
    expect(() => resolveExpensePolicy(input, [], "voucher")).toThrow(/CARD_RECEIPT_IN_CASH/);
    const { result, issues } = projectExpensePolicy(input, "voucher");
    expect(codes(issues)).toContain("CARD_RECEIPT_IN_CASH");
    expect(result).toMatchObject({ priceHigh: 1000, priceHighVAT: 210, total: 1210, date: "2026-10-02", datePayment: "2026-10-04" });
    const shown = computeReviewTargets({ tool: "create_cash_voucher", data: input }, PERIOD);
    expect(shown).toMatchObject({ targetPriceHigh: 1000, targetPriceHighVAT: 210, targetTotal: 1210, targetDate: "2026-10-02" });
  });
  it("unknown foreign tax mode: base, VAT, total, issue/tax dates and Doklad stay; KH, Členění DPH and PN do not", () => {
    expect(() => resolveExpensePolicy(header(foreignUnknown))).toThrow(/TAX_MODE_REQUIRED/);
    const { result, issues } = projectExpensePolicy(header(foreignUnknown));
    expect(codes(issues)).toEqual(["TAX_MODE_REQUIRED"]);
    expect(result).toMatchObject({ priceHigh: 1000, priceHighVAT: 210, total: 1210, date: "2026-10-03", dateTax: "2026-10-03", originalDocument: "MCPTEST-DE-1" });
    for (const key of ["dateKHDPH", "classificationVAT", "taxMode", "priceNone", "sourceVatBreakdown"]) expect(result[key]).toBeUndefined();
    expect(result._expensePolicy.taxMode).toBeUndefined();
  });

  it("unknown tax mode in foreign currency keeps the source buckets without a taxable-only issue", () => {
    const { result, issues } = projectExpensePolicy(header({ ...foreignUnknown, currency: "EUR", total: 1210 }));
    expect(codes(issues)).toEqual(["TAX_MODE_REQUIRED"]);
    expect(result).toMatchObject({ priceHigh: 1000, priceHighVAT: 210, total: 1210, currencyPriceSum: 1210, currency: "EUR" });
  });

  it("a PN classification contradicting taxable keeps amounts and dates, not the mode-dependent values", () => {
    expect(() => resolveExpensePolicy(header({ ...domesticTaxable, classificationVAT: "PN" }))).toThrow(/TAX_MODE_CONFLICT/);
    const { result, issues } = projectExpensePolicy(header({ ...domesticTaxable, classificationVAT: "PN" }));
    expect(codes(issues)).toEqual(["TAX_MODE_CONFLICT"]);
    expect(result).toMatchObject({ priceHigh: 1000, priceHighVAT: 210, total: 1210, date: "2026-10-02", dateTax: "2026-10-04" });
    expect(result.dateKHDPH).toBeUndefined();
    expect(result.classificationVAT).toBeUndefined();
  });

  it("totals mismatch with an unknown tax mode keeps every printed amount, no rounding invented", () => {
    const { result, issues } = projectExpensePolicy(header({ ...foreignUnknown, total: 1215.5 }));
    expect(codes(issues)).toEqual(["TAX_MODE_REQUIRED", "SUMMARY_MISMATCH"]);
    expect(result).toMatchObject({ priceHigh: 1000, priceHighVAT: 210, total: 1215.5, date: "2026-10-03" });
    expect(result.roundingAmount).toBeUndefined();
    expect(result.roundingDocument).toBeUndefined();
  });

  it("one invalid date leaves the other dates known and is reported once", () => {
    const badIssue = header({ ...domesticTaxable, sourceIssueDate: "2026-13-40" });
    expect(() => resolveExpensePolicy(badIssue)).toThrow(/DATE_INVALID/);
    const issue = projectExpensePolicy(badIssue);
    expect(codes(issue.issues)).toEqual(["DATE_INVALID"]);
    expect(issue.result).toMatchObject({ dateTax: "2026-10-04", dateKHDPH: "2026-10-04", priceHigh: 1000, total: 1210, classificationVAT: "PD", originalDocument: "MCPTEST-FV-2" });
    expect(issue.result.date).toBeUndefined();

    const badAccounting = projectExpensePolicy(header({ ...domesticTaxable, dateAccounting: "31.10.2026" }));
    expect(codes(badAccounting.issues)).toEqual(["DATE_INVALID"]);
    expect(badAccounting.result).toMatchObject({ date: "2026-10-02", dateTax: "2026-10-04", dateKHDPH: "2026-10-04" });
    expect(badAccounting.result.dateAccounting).toBeUndefined();

    // An invalid requested Datum DPH is unknown, never silently replaced by the DUZP.
    const badDateTax = projectExpensePolicy(header({ ...domesticTaxable, dateTax: "2026-10-99" }));
    expect(codes(badDateTax.issues)).toEqual(["DATE_INVALID"]);
    expect(badDateTax.result.dateTax).toBeUndefined();
    expect(badDateTax.result).toMatchObject({ date: "2026-10-02", dateKHDPH: "2026-10-04" });

    const badTaxDate = projectExpensePolicy(header({ ...domesticTaxable, sourceTaxDate: "2026-02-30" }));
    expect(codes(badTaxDate.issues)).toEqual(["DATE_INVALID"]);
    expect(badTaxDate.result).toMatchObject({ priceHigh: 1000, priceHighVAT: 210, total: 1210, originalDocument: "MCPTEST-FV-2" });
    expect(badTaxDate.result.dateKHDPH).toBeUndefined();
  });

  it("one invalid amount leaves the other amounts and dates known without reconciling", () => {
    const bad = header({ ...domesticTaxable, total: 1210.555 });
    expect(() => resolveExpensePolicy(bad)).toThrow(/AMOUNT_PRECISION/);
    const { result, issues } = projectExpensePolicy(bad);
    expect(codes(issues)).toEqual(["AMOUNT_PRECISION"]);
    expect(result).toMatchObject({ priceHigh: 1000, priceHighVAT: 210, priceHighSum: 1210, date: "2026-10-02", dateKHDPH: "2026-10-04" });
    expect(result.total).toBeUndefined();
    expect(result.roundingAmount).toBeUndefined();
    expect(result.roundingDocument).toBeUndefined();
  });

  it("the strict policy is unchanged for a valid row", () => {
    const strict = resolveExpensePolicy(header(domesticTaxable));
    expect(projectExpensePolicy(header(domesticTaxable))).toEqual({ result: strict, issues: [] });
  });
});

describe("review targets with a payment-method conflict", () => {
  const conflict = { ...domesticTaxable, paymentType: "cash", cardPayment: true, roundingAmount: 0, vatPeriod: PERIOD };

  it("keeps amounts and dates under the visible method, blanks Doklad/VS that the card flag would change, and stays blocked", () => {
    const targets = computeReviewTargets({ tool: "create_other_liability", data: conflict }, PERIOD);
    expect(targets).toMatchObject({ targetDate: "2026-10-02", targetDateTax: "2026-10-04", targetDateKHDPH: "2026-10-04", targetPriceHigh: 1000, targetPriceHighVAT: 210, targetTotal: 1210, classificationVAT: "PD",
      targetDocument: null, targetSymVar: null });
    expect(reviewPolicyIssue({ tool: "create_other_liability", data: conflict }, PERIOD)).toMatchObject({ code: "PAYMENT_METHOD_CONFLICT", field: "paymentType" });
  });

  it("keeps Doklad/VS when both interpretations agree (received invoice: no PK numbering)", () => {
    const targets = computeReviewTargets({ tool: "create_invoice", data: conflict }, PERIOD);
    expect(targets).toMatchObject({ targetDocument: "MCPTEST-FV-2", targetTotal: 1210, targetDate: "2026-10-02" });
    expect(reviewPolicyIssue({ tool: "create_invoice", data: conflict }, PERIOD)?.code).toBe("PAYMENT_METHOD_CONFLICT");
  });
});

describe("reviewed workbook recovers an unknown tax mode", () => {
  async function setup(docs: Array<{ requestId: string; tool: "create_invoice"; data: Record<string, any> }>) {
    const dir = await mkdtemp(join(tmpdir(), "review-unknown-")); dirs.push(dir);
    const pdf = join(dir, "source.pdf"); await writeFile(pdf, "%PDF-1.4 MCPTEST");
    const runs: any[] = [];
    const client = { listRecordsBatch: async (requests: any[]) => ({ isOk: () => true, items: requests.map((r: any) => ({ state: "ok", data: r.agenda === "invoice" ? { invoice: [] } : { voucher: [] } })) }) };
    const importer = { run: async (ops: any[], id: string) => {
      runs.push({ ops: structuredClone(ops), id });
      return { ok: true, state: "ok", results: ops.map((op, i) => ({ requestId: op.requestId, id: i + 1, created: true, verified: true })) };
    } };
    const service = new ExpenseReviewService({ client: client as any, importer, directory: dir });
    const prepared = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: PERIOD, documents: docs.map((d, i) => ({ ...d, data: { sourcePdfPath: pdf, sourcePages: [i + 1], ...d.data } })) });
    const path = prepared.workbookPath as string;
    const load = async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path); return { wb, ws: wb.getWorksheet("Doklady")! }; };
    const rowOf = (ws: ExcelJS.Worksheet, id: string) => { for (let r = 3; r <= ws.rowCount; r++) if (ws.getCell(r, 1).value === id) return r; throw new Error(id); };
    const colOf = (key: string) => REVIEW_COLUMNS.findIndex((c) => c.key === key) + 1;
    const cells = async (id: string) => { const { ws } = await load(); const r = rowOf(ws, id); return Object.fromEntries(REVIEW_COLUMNS.map((c, i) => { const v = ws.getCell(r, i + 1).value; return [c.key, v instanceof Date ? v.toISOString().slice(0, 10) : v]; })); };
    const edit = async (id: string, values: Record<string, unknown>) => {
      const { wb, ws } = await load();
      for (const [key, value] of Object.entries(values)) ws.getCell(rowOf(ws, id), colOf(key)).value = value as ExcelJS.CellValue;
      await wb.xlsx.writeFile(path);
    };
    const submit = () => service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: target.databaseOverride, target });
    return { prepared, cells, edit, submit, inspect: () => service.inspect({ reviewId: prepared.reviewId }), runs };
  }

  it("lets the reviewer explicitly confirm taxable treatment through the visible classification", async () => {
    const { cells, edit, submit, inspect, runs } = await setup([{ requestId: "DE1", tool: "create_invoice", data: foreignUnknown }]);
    expect((await cells("DE1")).classificationVAT).toBeNull();
    await edit("DE1", { action: "Importovat", classificationVAT: "PD" });
    expect((await inspect()).invalid).toEqual([expect.objectContaining({ errorCode: "TARGET_EDIT_REJECTED" })]);
    // The user also acknowledges the newly determined KH date in the same table.
    await edit("DE1", { targetDateKHDPH: "2026-10-03" });
    expect((await inspect()).invalid).toEqual([]);
    expect((await submit()).ok).toBe(true);
    expect(runs[0].ops[0].header).toMatchObject({ taxMode: "taxable", classificationVAT: "PD" });
  });

  it("shows known amounts and dates, blocks import, and imports after the reviewer decides PN", async () => {
    const { prepared, cells, edit, submit, inspect, runs } = await setup([{ requestId: "DE1", tool: "create_invoice", data: { ...foreignUnknown, classificationVAT: "PDdovoz" } }]);
    expect(prepared.requiresReview).toEqual(["DE1"]);
    const shown = await cells("DE1");
    expect(shown).toMatchObject({ targetDate: "2026-10-03", targetDateTax: "2026-10-03", targetDateKHDPH: null, targetDocument: "MCPTEST-DE-1",
      targetPriceHigh: 1000, targetPriceHighVAT: 210, targetTotal: 1210, targetPriceNone: null });
    expect(String(shown.reviewNotes)).toContain("Režim DPH nelze určit automaticky");
    expect(String(shown.reviewNotes)).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}/);

    await edit("DE1", { action: "Importovat" });
    const blocked = await inspect();
    expect(blocked.invalid).toEqual([expect.objectContaining({ rowId: "DE1", errorCode: "TAX_MODE_REQUIRED" })]);
    await expect(submit()).rejects.toThrow();
    expect(runs).toHaveLength(0);

    // Deciding PN (Členění DPH) alone leaves the shown buckets stale: still blocked, with the values to type.
    await edit("DE1", { classificationVAT: "PN" });
    const stale = await inspect();
    expect(stale.invalid).toEqual([expect.objectContaining({ rowId: "DE1", errorCode: "TARGET_EDIT_REJECTED", error: expect.stringContaining("(prázdné) → 1210") })]);
    await expect(submit()).rejects.toThrow();
    expect(runs).toHaveLength(0);

    await edit("DE1", { targetPriceHigh: null, targetPriceHighVAT: null, targetPriceNone: 1210 });
    const fixed = await inspect();
    expect(fixed.invalid).toEqual([]);
    const result = await submit();
    expect(result.ok).toBe(true);
    const written = runs[0].ops[0].header;
    expect(written).toMatchObject({ taxMode: "nonTax", priceHigh: 1000, priceHighVAT: 210, total: 1210, sourceIssueDate: "2026-10-03", sourceTaxDate: "2026-10-03" });
    // The importer's own policy pass collapses the source buckets into PN.
    expect(resolveExpensePolicy({ ...written, vatPeriod: PERIOD })).toMatchObject({ priceNone: 1210, classificationVAT: "PN", total: 1210 });
  });
});
