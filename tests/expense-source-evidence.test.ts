import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { PohodaClient } from "../src/pohoda/client.js";
import { ExpensePolicyError, expenseSourceIssues, resolveExpensePolicy } from "../src/pohoda/expense-policy.js";
import type { CliXmlJobResult, XmlTransport } from "../src/pohoda/transport.js";
import { decideNonPayerTreatment } from "../src/registry/czech-registry.js";

/** Source evidence that must come from the document: supplier country, VS format, cash payment date. */

// Mirrors audited workbook row R009 (no source PDF available; values only as extracted).
const r009 = {
  type: "receivedInvoice", partnerName: "Trivolt", partnerIco: "47104210", partnerDic: "SK2023737089",
  taxMode: "taxable", vatPeriod: "2026-11", text: "Materiál",
  sourceIssueDate: "2026-11-03", sourceTaxDate: "2026-11-03", sourceDocumentNumber: "FV-2026/0042",
  sourceSymVar: "CZ10260279", priceHigh: 100, priceHighVAT: 21, total: 121
};
const cash = {
  type: "expense", cashAccount: "HP", taxMode: "taxable", classificationVAT: "PD", vatPeriod: "2026-11", text: "Materiál",
  sourceIssueDate: "2026-11-03", sourceTaxDate: "2026-11-03", priceHigh: 100, priceHighVAT: 21, total: 121
};

function code(run: () => unknown): string {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(ExpensePolicyError);
    expect((error as ExpensePolicyError).needsReview).toBe(true);
    return (error as ExpensePolicyError).code;
  }
  return "ok";
}
const codes = (header: Record<string, any>, kind: "invoice" | "voucher" = "invoice") => expenseSourceIssues(header, kind).map((i) => i.code);

describe("supplier country evidence", () => {
  it("keeps the R009 row blocked until classification, country and a valid VS are supplied", () => {
    expect(codes(r009)).toEqual(["PARTNER_COUNTRY_REQUIRED", "SYMVAR_INVALID"]);
    expect(code(() => resolveExpensePolicy(r009, [], "invoice"))).toBe("VAT_CLASSIFICATION_REQUIRED");
    const classified = { ...r009, classificationVAT: "PD" };
    expect(code(() => resolveExpensePolicy(classified, [], "invoice"))).toBe("PARTNER_COUNTRY_REQUIRED");
    expect(code(() => resolveExpensePolicy({ ...classified, partnerCountry: "SK" }, [], "invoice"))).toBe("SYMVAR_INVALID");
    const ready = resolveExpensePolicy({ ...classified, partnerCountry: "SK", sourceSymVar: "20260042" }, [], "invoice");
    expect(ready.symVar).toBe("20260042");
    expect(ready.partnerCountry).toBe("SK");
    expect(ready.classificationVAT).toBe("PD");
  });

  it("never fills the country from the VAT prefix and only warns on an explicit differing country", () => {
    const issues = expenseSourceIssues({ ...r009, sourceSymVar: "" });
    expect(issues[0]!.message).toContain("not guessed");
    const czech = resolveExpensePolicy({ ...r009, classificationVAT: "PD", sourceSymVar: "", partnerCountry: "CZ" }, [], "invoice");
    expect(czech.partnerCountry).toBe("CZ");
    expect(czech._expensePolicy.warnings.join(" ")).toContain("SK VAT registration while partnerCountry is CZ");
    // Czech DIČ and existing address-book contacts need no country here.
    expect(codes({ ...r009, sourceSymVar: "", partnerDic: "CZ25596641" })).toEqual([]);
    expect(codes({ ...r009, sourceSymVar: "", partnerId: 7 })).toEqual([]);
  });

  it("never derives PN from a foreign/EU country", () => {
    const eu = { ...r009, sourceSymVar: "", partnerCountry: "SK", taxMode: "", classificationVAT: "", priceHigh: undefined, priceHighVAT: undefined, priceNone: 100, total: 100 };
    expect(code(() => resolveExpensePolicy({ ...eu, partnerVatStatus: "non-payer", vatStatusEvidence: "registry" }, [], "invoice"))).toBe("TAX_MODE_REQUIRED");
    const decision = decideNonPayerTreatment({ evidence: { status: "registry-non-payer" } as any, supplierCountry: "SK", documentChargesVat: false });
    expect(decision.pn).toBe("explicit-decision");
  });
});

describe("variable symbol format", () => {
  it("does not strip or rewrite an explicit non-numeric VS, and keeps valid explicit values", () => {
    const header = { ...r009, classificationVAT: "PD", partnerCountry: "SK" };
    expect(code(() => resolveExpensePolicy(header, [], "invoice"))).toBe("SYMVAR_INVALID");
    expect(code(() => resolveExpensePolicy({ ...header, sourceSymVar: "", symVar: "VS-01" }, [], "invoice"))).toBe("SYMVAR_INVALID");
    for (const vs of ["0042", "9".repeat(20)]) expect(resolveExpensePolicy({ ...header, sourceSymVar: vs }, [], "invoice").symVar).toBe(vs);
    // Missing VS derivation is unchanged.
    expect(resolveExpensePolicy({ ...header, sourceSymVar: "" }, [], "invoice").symVar).toBe("20260042");
  });
});

describe("actual payment dates", () => {
  it("blocks a cash expense with no source payment date instead of using issue, due or tax dates", () => {
    const missing = { ...cash, dateDue: "2026-11-10", dateTax: "2026-11-03" };
    expect(code(() => resolveExpensePolicy(missing, [], "voucher"))).toBe("SOURCE_PAYMENT_DATE_REQUIRED");
    expect(expenseSourceIssues(missing, "voucher")[0]!.message).toContain("prepare a new review");
  });

  it("preserves an exact source or legacy datePayment and stays idempotent", () => {
    const explicit = resolveExpensePolicy({ ...cash, sourcePaymentDate: "2026-11-05" }, [], "voucher");
    expect(explicit.datePayment).toBe("2026-11-05");
    const legacy = resolveExpensePolicy({ ...cash, datePayment: "2026-11-06" }, [], "voucher");
    expect(legacy.datePayment).toBe("2026-11-06");
    expect(legacy.sourcePaymentDate).toBe("2026-11-06");
    expect(resolveExpensePolicy(legacy, [], "voucher").datePayment).toBe("2026-11-06");
  });

  it("requires a stated rounding for a CZK cash payable with haléře, never changing amounts", () => {
    const halere = { ...cash, sourcePaymentDate: "2026-11-03", priceHigh: 100.5, priceHighVAT: 21.11, total: 121.61 };
    expect(code(() => resolveExpensePolicy(halere, [], "voucher"))).toBe("CASH_ROUNDING_UNCONFIRMED");
    expect(codes({ ...halere, type: "receivedInvoice", paymentType: "cash" })).toEqual(["CASH_ROUNDING_UNCONFIRMED"]);
    expect(codes({ ...halere, type: "receivedInvoice", paymentType: "draft" })).toEqual([]);
    const result = resolveExpensePolicy({ ...halere, roundingAmount: 0 }, [], "voucher");
    expect(result.total).toBe(121.61);
    expect(result.roundingDocument).toBe("none");
    expect(result._expensePolicy.roundingRule).toBe("source");
    const whole = resolveExpensePolicy({ ...cash, sourcePaymentDate: "2026-11-03" }, [], "voucher");
    expect(whole._expensePolicy.warnings.join(" ")).not.toContain("haléře");
  });

  it("sends no datePayment for a received invoice and invents no payment fact", async () => {
    const calls: string[] = [];
    const transport: XmlTransport = {
      async exchange(xml: string, database: string): Promise<CliXmlJobResult> {
        calls.push(xml);
        return { xml: '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"/></rsp:responsePack>', jobId: "job", database, jobDir: "/tmp/job", queueWaitMs: 0, processSlotWaitMs: 0, durationMs: 1, exitCode: 0, jobRetained: false };
      },
      status: () => ({ transport: "fake" })
    };
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    const invoice = { ...r009, partnerCountry: "SK", classificationVAT: "PD", sourceSymVar: "20260042", dateDue: "2026-11-20" };
    await client.createInvoice({ ...invoice, datePayment: "2026-11-15" }, []);
    expect(calls[0]).not.toContain("datePayment");
    const resolved = resolveExpensePolicy(invoice, [], "invoice");
    expect(resolved.sourcePaymentDate).toBeUndefined();
    expect(resolved.datePayment).toBeUndefined();
  });
});

describe("review preview", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

  it("still delivers a workbook when every row needs review, listing all source issues", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-evidence-")); dirs.push(dir);
    const pdf = join(dir, "source.pdf"); await writeFile(pdf, "%PDF-1.4 test");
    const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
    const client = { listRecordsBatch: async (requests: any[]) => ({ isOk: () => true, items: requests.map(() => ({ state: "ok", data: { invoice: [] } })) }) };
    let runs = 0;
    const importer = { run: async () => { runs++; return { ok: true }; } };
    const service = new ExpenseReviewService({ client: client as any, importer: importer as any, directory: dir });
    const source = { sourcePdfPath: pdf, sourcePages: [1] };
    const prepared = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: "2026-11", documents: [
      { requestId: "R009", tool: "create_invoice", data: { ...r009, ...source } },
      { requestId: "R010", tool: "create_cash_voucher", data: { ...cash, ...source } }
    ] });
    expect(prepared.workbookPath).toMatch(/\.xlsx$/);
    expect(prepared.nextAction).toBe("deliver_workbook");
    const [invoiceRow, cashRow] = prepared.rows;
    expect(invoiceRow.action).toBe("review");
    expect(invoiceRow.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(["PARTNER_COUNTRY_REQUIRED", "SYMVAR_INVALID", "VAT_CLASSIFICATION_REQUIRED"]));
    for (const expected of ["chybí země dodavatele", "není číselný", "Chybí Členění DPH"]) expect(invoiceRow.reviewNotes).toContain(expected);
    expect(invoiceRow.reviewNotes).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}|Needs data/);
    expect(cashRow.action).toBe("review");
    expect(cashRow.issues.filter((i: any) => i.code === "SOURCE_PAYMENT_DATE_REQUIRED")).toHaveLength(1);
    expect(cashRow.reviewNotes.match(/Chybí skutečné datum úhrady/g)).toHaveLength(1);
    expect(runs).toBe(0);
  });
});
