/**
 * Cash rounding regression (synthetic data, no client POHODA writes).
 *
 * Mirrors a scanned "Daňový doklad – faktura za hotové": base 688.00, VAT 21 % 144.48,
 * "Celkem v Kč vč. DPH" 832.48, "CELKEM K ÚHRADĚ" 832.00. The printed final payable is
 * a source fact; the VAT-inclusive sum must never replace it. The rounding -0.48 must
 * survive preview → reviewed workbook → import → XML through the one shared policy.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { REVIEW_COLUMNS, REVIEW_LEGACY_COLUMNS, computeReviewTargets } from "../src/mcp/review-workbook.js";
import { PohodaClient } from "../src/pohoda/client.js";
import { ExpensePolicyError, expenseSourceIssues, resolveExpensePolicy } from "../src/pohoda/expense-policy.js";
import type { CliXmlJobResult, XmlTransport } from "../src/pohoda/transport.js";

const VAT_PERIOD = "2026-09";
const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const source = {
  partnerIco: "25596641", partnerName: "MCPTEST Betonárna s.r.o.", partnerCountry: "CZ", text: "MCPTEST materiál", accounting: "501",
  taxMode: "taxable", classificationVAT: "PD", sourceChargesVat: true, paymentType: "cash",
  date: "2026-09-03", dateTax: "2026-09-03", originalDocument: "MCPTEST-33560348",
  priceHigh: 688, priceHighVAT: 144.48
};
const header = (extra: Record<string, any>) => ({ ...source, type: "receivedInvoice", vatPeriod: VAT_PERIOD, ...extra });

function policyError(run: () => unknown): ExpensePolicyError {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(ExpensePolicyError); return error as ExpensePolicyError; }
  throw new Error("expected an ExpensePolicyError");
}

describe("cash rounding: policy", () => {
  it("derives -0.48 from the printed payable 832 and the explicit buckets 688 + 144.48", () => {
    const input = header({ total: 832 });
    const before = structuredClone(input);
    const result = resolveExpensePolicy(input, [], "invoice");
    expect(input).toEqual(before);
    expect(result).toMatchObject({ priceHigh: 688, priceHighVAT: 144.48, roundingAmount: -0.48, total: 832, roundingDocument: "math2one" });
    expect(result._expensePolicy.roundingRule).toBe("derived-from-payable");
    expect(result._expensePolicy.payableCZK).toBe(832);
    expect(result._expensePolicy.warnings.join(" ")).toContain("Rounding -0.48 derived from the stated final payable 832.00");
    const again = resolveExpensePolicy(result, [], "invoice");
    expect(again).toMatchObject({ roundingAmount: -0.48, total: 832, roundingDocument: "math2one", priceHighVAT: 144.48 });
    expect(again._expensePolicy.roundingRule).toBe("derived-from-payable");
    expect(again._expensePolicy.warnings).toEqual(result._expensePolicy.warnings);
  });

  it("an explicit printed rounding gives the same result, recorded as a source fact", () => {
    const result = resolveExpensePolicy(header({ total: 832, roundingAmount: -0.48 }), [], "invoice");
    expect(result).toMatchObject({ roundingAmount: -0.48, total: 832, roundingDocument: "math2one" });
    expect(result._expensePolicy.roundingRule).toBe("source");
  });

  it("covers the second Roxit case 717.75 + 150.73 = 868.48 → 868", () => {
    const result = resolveExpensePolicy(header({ priceHigh: 717.75, priceHighVAT: 150.73, total: 868 }), [], "invoice");
    expect(result).toMatchObject({ roundingAmount: -0.48, total: 868, roundingDocument: "math2one" });
  });

  it("the substituted VAT-inclusive sum 832.48 on a cash document is a review issue, not silently accepted", () => {
    const sumSubstituted = header({ total: 832.48 });
    const error = policyError(() => resolveExpensePolicy(sumSubstituted, [], "invoice"));
    expect(error.code).toBe("CASH_ROUNDING_UNCONFIRMED");
    expect(error.needsReview).toBe(true);
    expect(error.message).toContain("CELKEM K ÚHRADĚ");
    expect(expenseSourceIssues(sumSubstituted, "invoice").map((i) => i.code)).toEqual(["CASH_ROUNDING_UNCONFIRMED"]);
    // A cash expense voucher follows the same rule.
    const voucher = { ...sumSubstituted, type: "expense", cashAccount: "HP", sourcePaymentDate: "2026-09-03" };
    expect(policyError(() => resolveExpensePolicy(voucher, [], "voucher")).code).toBe("CASH_ROUNDING_UNCONFIRMED");
    // Only an explicit statement that the source asks for the haléř amount keeps it.
    const confirmed = resolveExpensePolicy(header({ total: 832.48, roundingAmount: 0 }), [], "invoice");
    expect(confirmed).toMatchObject({ total: 832.48, roundingAmount: 0, roundingDocument: "none" });
  });

  it("never rounds a non-cash or whole-crown payable automatically", () => {
    // Transfer invoice with an exact haléř payable: unchanged, no rounding invented.
    const transfer = resolveExpensePolicy(header({ paymentType: "draft", total: 832.48 }), [], "invoice");
    expect(transfer.total).toBe(832.48);
    expect(transfer.roundingAmount).toBeUndefined();
    expect(transfer._expensePolicy.roundingRule).toBe("none");
    // Cash with whole-crown buckets: nothing to confirm or derive.
    const whole = resolveExpensePolicy(header({ priceHigh: 1000, priceHighVAT: 210, total: 1210 }), [], "invoice");
    expect(whole.roundingAmount).toBeUndefined();
    expect(whole.roundingDocument).toBe("none");
  });

  it("derives only exact whole-crown mathematical rounding; other differences stay mismatches", () => {
    const mismatch = (extra: Record<string, any>) => policyError(() => resolveExpensePolicy(header(extra), [], "invoice")).code;
    expect(mismatch({ total: 831 })).toBe("SUMMARY_MISMATCH"); // more than crown rounding (possible misread)
    expect(mismatch({ total: 833 })).toBe("SUMMARY_MISMATCH"); // rounding up is not inferred
    expect(mismatch({ total: 832.5 })).toBe("SUMMARY_MISMATCH"); // non-crown payable
    expect(mismatch({ total: 832.4 })).toBe("SUMMARY_MISMATCH");
    // Rounding up is accepted when the source states it.
    expect(resolveExpensePolicy(header({ total: 833, roundingAmount: 0.52 }), [], "invoice")).toMatchObject({ roundingAmount: 0.52, roundingDocument: "up2one" });
    // An explicit rounding that contradicts the payable is never "fixed".
    expect(mismatch({ total: 832, roundingAmount: -0.5 })).toBe("SUMMARY_MISMATCH");
    // Half-crown tie rounds away from zero, like POHODA math2one.
    expect(resolveExpensePolicy(header({ priceHigh: 717.77, priceHighVAT: 150.73, total: 869 }), [], "invoice")).toMatchObject({ roundingAmount: 0.5, roundingDocument: "math2one" });
  });

  it("PN keeps the derived rounding beside the collapsed gross", () => {
    const result = resolveExpensePolicy(header({ taxMode: "nonTax", classificationVAT: "PN", total: 832 }), [], "invoice");
    expect(result).toMatchObject({ priceNone: 832.48, roundingAmount: -0.48, total: 832, roundingDocument: "math2one" });
    expect(result.priceHigh).toBeUndefined();
  });

  it("foreign currency never derives a rounding", () => {
    const foreign = { ...header({ priceHigh: undefined, priceHighVAT: undefined, taxMode: "nonTax", classificationVAT: "PN", priceNone: 100.4, total: 100 }), currency: "EUR", homePayableCZK: 2500 };
    expect(policyError(() => resolveExpensePolicy(foreign, [], "invoice")).code).toBe("SUMMARY_MISMATCH");
  });
});

class FakeTransport implements XmlTransport {
  public calls: string[] = [];
  async exchange(xml: string, database: string): Promise<CliXmlJobResult> {
    this.calls.push(xml);
    return { xml: '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"/></rsp:responsePack>', jobId: "job", database, jobDir: "/tmp/job", queueWaitMs: 0, processSlotWaitMs: 0, durationMs: 1, exitCode: 0, jobRetained: false };
  }
  status(database = ""): Record<string, unknown> { return { transport: "fake", database }; }
}
const xmlValue = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
/** Same normalization ExpenseImporter.run applies before writing (src/mcp/expense-import.ts). */
const imported = (op: any) => resolveExpensePolicy({ ...op.header }, op.items ?? [], op.tool === "create_cash_voucher" ? "voucher" : "invoice");

async function setup(data: Record<string, any>) {
  const dir = await mkdtemp(join(tmpdir(), "cash-rounding-")); dirs.push(dir);
  const pdf = join(dir, "source.pdf"); await writeFile(pdf, "%PDF-1.4 MCPTEST");
  const runs: any[] = [];
  const client = { listRecordsBatch: async (requests: any[]) => ({ isOk: () => true, items: requests.map(() => ({ state: "ok", data: { invoice: [], voucher: [] } })) }) };
  const importer = { run: async (ops: any[], id: string, options: any) => {
    runs.push({ ops: structuredClone(ops), id, options });
    return { ok: true, state: "ok", results: ops.map((op, i) => ({ requestId: op.requestId, id: i + 1, created: true, verified: true })) };
  } };
  const service = new ExpenseReviewService({ client: client as any, importer, directory: dir });
  const prepared = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: VAT_PERIOD, documents: [{ requestId: "FP26113", tool: "create_invoice", data: { sourcePdfPath: pdf, sourcePages: [3], type: "receivedInvoice", ...structuredClone(data) } }] });
  const submit = () => service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: target.databaseOverride, target });
  return { service, prepared, submit, runs };
}

/** Layout-agnostic edit by column label; returns false when the sheet has no such column. */
async function editRow(path: string, values: Record<string, unknown>): Promise<boolean> {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet("Doklady")!;
  const byLabel = new Map<string, number>();
  ws.getRow(2).eachCell((cell, col) => byLabel.set(String(cell.value ?? "").trim(), col));
  for (const [key, value] of Object.entries(values)) {
    const label = [...REVIEW_COLUMNS, ...REVIEW_LEGACY_COLUMNS].find((c) => c.key === key)?.label;
    const col = label === undefined ? undefined : byLabel.get(label);
    if (col === undefined) return false;
    ws.getRow(3).getCell(col).value = value as ExcelJS.CellValue;
  }
  await wb.xlsx.writeFile(path);
  return true;
}

async function writtenXml(op: any): Promise<string> {
  const transport = new FakeTransport();
  const client = new PohodaClient({ transport, ico: target.dataPackIco, database: target.databaseOverride });
  await client.writeBatch([{ ...op, header: imported(op), items: [] }], `MCPTEST-${op.requestId}`);
  return transport.calls[0]!;
}

describe("cash rounding: preview → workbook → import → XML", () => {
  it("the printed payable 832 reaches POHODA XML with priceRound -0.48 and unchanged VAT", async () => {
    const { prepared, submit, runs } = await setup({ ...source, total: 832 });
    const preview = computeReviewTargets({ tool: "create_invoice", data: { ...source, type: "receivedInvoice", total: 832 } } as any, VAT_PERIOD);
    expect(preview).toMatchObject({ targetPriceHigh: 688, targetPriceHighVAT: 144.48, targetRounding: -0.48, targetTotal: 832 });
    await editRow(prepared.workbookPath, { action: "Importovat" });
    expect((await submit()).ok).toBe(true);
    const op = runs[0].ops[0];
    const written = imported(op);
    expect(written).toMatchObject({ priceHigh: 688, priceHighVAT: 144.48, roundingAmount: -0.48, total: 832, roundingDocument: "math2one" });
    // What the preview shows is what the import writes.
    expect(preview).toMatchObject({ targetRounding: written.roundingAmount, targetTotal: written.total });
    const xml = await writtenXml(op);
    expect(xmlValue(xml, "typ:priceHigh")).toBe("688");
    expect(xmlValue(xml, "typ:priceHighVAT")).toBe("144.48");
    expect(xmlValue(xml, "typ:priceRound")).toBe("-0.48");
    expect(xmlValue(xml, "inv:roundingDocument")).toBe("math2one");
  });

  it("a sum-substituted payable is held for review and recovers when the reviewer enters the printed payable", async () => {
    const { service, prepared, submit, runs } = await setup({ ...source, total: 832.48 });
    const row = prepared.rows?.find?.((r: any) => r.rowId === "FP26113");
    expect(row?.action).toBe("review");
    expect(String(row?.reviewNotes)).toContain("Hotovost 832,48 má haléře a doklad neuvádí zaokrouhlení");
    expect(row?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CASH_ROUNDING_UNCONFIRMED", field: "roundingAmount" })]));
    // Forcing import without resolving it is rejected before any write.
    await editRow(prepared.workbookPath, { action: "Importovat" });
    await expect(submit()).rejects.toMatchObject({ details: { invalid: [expect.objectContaining({ errorCode: "CASH_ROUNDING_UNCONFIRMED" })] } });
    expect(runs).toHaveLength(0);
    // Reviewer enters the printed CELKEM K ÚHRADĚ in the visible POHODA Celkem cell; nothing is re-prepared.
    expect(await editRow(prepared.workbookPath, { targetTotal: 832 })).toBe(true);
    // The derived rounding is not shown yet; the table must show it before import.
    const pending = await service.inspect({ reviewId: prepared.reviewId });
    expect(pending.rows[0]).toMatchObject({ valid: false, error: expect.stringContaining("Zaokrouhlení (prázdné) → -0.48") });
    await expect(submit()).rejects.toThrow(/neukazuje importované hodnoty/);
    expect(runs).toHaveLength(0);
    const shown = pending.rows[0].error.match(/hodnoty: (.*)\. Přepište/)[1].split("; ").map((part: string) => part.split(" → "));
    const keyOf = (label: string) => REVIEW_COLUMNS.find((c) => label.startsWith(`${c.label} `))!.key;
    expect(await editRow(prepared.workbookPath, Object.fromEntries(shown.map(([cell, value]: string[]) => [keyOf(cell!), value === "vymazat" ? null : /^-?\d+(\.\d+)?$/.test(value!) ? Number(value) : value])))).toBe(true);
    const inspected = await service.inspect({ reviewId: prepared.reviewId });
    expect(JSON.stringify(inspected)).not.toContain("CASH_ROUNDING_UNCONFIRMED");
    expect(inspected.rows[0]).toMatchObject({ valid: true, changedFields: expect.arrayContaining(["total"]) });
    expect(inspected.rows[0].preview.planned).toMatchObject({ priceHigh: 688, priceHighVAT: 144.48, roundingAmount: -0.48, roundingRule: "derived-from-payable", total: 832 });
    const fixed = { submit, runs };
    expect((await fixed.submit()).ok).toBe(true);
    expect(imported(fixed.runs[0].ops[0])).toMatchObject({ priceHigh: 688, priceHighVAT: 144.48, roundingAmount: -0.48, total: 832 });
    const xml = await writtenXml(fixed.runs[0].ops[0]);
    expect(xmlValue(xml, "typ:priceRound")).toBe("-0.48");
    expect(xmlValue(xml, "typ:priceHighVAT")).toBe("144.48");
  });
});
