/**
 * Invalid rows keep every determinable POHODA value, Czech-only reviewer texts, client
 * conventions PDzjed -> PD and fuel text -> PHM nafta / PHM benzín
 * (synthetic MCPTEST data only; real XLSX + shared XML builder, fake transport).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { computeReviewTargets, REVIEW_COLUMNS } from "../src/mcp/review-workbook.js";
import { canonicalClassificationVAT, canonicalExpenseText, ExpensePolicyError, FUEL_TEXT_BENZIN, projectExpensePolicy, resolveExpensePolicy } from "../src/pohoda/expense-policy.js";
import { PohodaClient } from "../src/pohoda/client.js";
import type { CliXmlJobResult, XmlTransport } from "../src/pohoda/transport.js";

const PERIOD = "2026-10";
const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

type Tool = "create_invoice" | "create_other_liability" | "create_cash_voucher";
const supplier = { partnerIco: "25596641", partnerName: "MCPTEST Čerpací stanice s.r.o.", partnerCountry: "CZ", partnerDic: "CZ25596641", accounting: "7Vost", taxMode: "taxable", classificationVAT: "PDzjed" };
/** Cash fuel receipt whose printed rounding contradicts its buckets (base + VAT already 2 400,00). */
const cashMismatch = { ...supplier, text: "Diesel", cashAccount: "HP", sourceIssueDate: "2026-10-12", sourceTaxDate: "2026-10-12", sourcePaymentDate: "2026-10-12", priceHigh: 1983.47, priceHighVAT: 416.53, roundingAmount: -0.3, total: 2400 };
/** Card fuel receipt: buckets 2 126,39, printed payable 2 126,40, no rounding line read. */
const cardMismatch = { ...supplier, text: "Natural 95", paymentType: "creditcard", sourceIssueDate: "2026-10-05", sourceTaxDate: "2026-10-05", sourceDocumentNumber: "MCPTEST-PK-1", priceHigh: 1757.35, priceHighVAT: 369.04, total: 2126.4 };
const invoiceOk = { ...supplier, text: "nafta", sourceIssueDate: "2026-10-02", sourceTaxDate: "2026-10-02", sourceDocumentNumber: "MCPTEST-FV-1", priceHigh: 1000, priceHighVAT: 210, total: 1210 };

class FakeTransport implements XmlTransport {
  public calls: string[] = [];
  async exchange(xml: string, database: string): Promise<CliXmlJobResult> {
    this.calls.push(xml);
    return { xml: '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"/></rsp:responsePack>', jobId: "job", database, jobDir: "/tmp/job", queueWaitMs: 0, processSlotWaitMs: 0, durationMs: 1, exitCode: 0, jobRetained: false };
  }
  status(): Record<string, unknown> { return {}; }
}
const newClient = () => { const transport = new FakeTransport(); return { transport, client: new PohodaClient({ transport, ico: target.dataPackIco, database: target.databaseOverride }) }; };
const kindOf = (tool: Tool) => tool === "create_cash_voucher" ? "voucher" as const : "invoice" as const;
const written = (header: any, tool: Tool) => resolveExpensePolicy({ ...header, ...(header.cardPayment ? { cardSequence: 7 } : {}) }, [], kindOf(tool));
async function xmlOf(op: any, tool: Tool): Promise<string> {
  const { transport, client } = newClient();
  await client.writeBatch([{ ...op, header: written(op.header, tool), items: [] }], `MCPTEST-${op.requestId}`);
  return transport.calls[0]!;
}
const textOf = (xml: string) => /<(?:inv|vch):text>([^<]*)</.exec(xml)?.[1];
const classificationOf = (xml: string) => /<(?:inv|vch):classificationVAT>\s*<typ:ids>([^<]*)</.exec(xml)?.[1];
const codesIn = /[A-Z]{3,}_[A-Z_]{3,}|Needs data|Summary amounts|Rounding \d/;

async function setup(docs: Array<{ requestId: string; tool: Tool; data: Record<string, any> }>, history: any[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "review-projection-")); dirs.push(dir);
  const pdf = join(dir, "source.pdf"); await writeFile(pdf, "%PDF-1.4 MCPTEST");
  const runs: any[] = [];
  const client = { listRecordsBatch: async (requests: any[]) => ({ isOk: () => true, items: requests.map((r: any) => ({ state: "ok", data: r.agenda === "invoice" ? { invoice: history } : { voucher: [] } })) }) };
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
  const inspect = () => service.inspect({ reviewId: prepared.reviewId });
  const manifestPath = join(dir, prepared.reviewId, "manifest.json");
  return { service, prepared, path, load, cells, edit, submit, inspect, runs, manifestPath, colOf, rowOf };
}

describe("policy projection of a row the import rejects", () => {
  const cash = { ...cashMismatch, type: "expense", vatPeriod: PERIOD };

  it("keeps dates, exact source buckets, printed rounding and total; the strict policy still rejects", () => {
    expect(() => resolveExpensePolicy(cash, [], "voucher")).toThrow(ExpensePolicyError);
    const { result, issues } = projectExpensePolicy(cash, "voucher");
    expect(issues.map((i) => i.code)).toEqual(["SUMMARY_MISMATCH"]);
    expect(issues[0]!.params).toEqual({ sum: "2399.70", total: "2400.00", buckets: "2400.00", rounding: "-0.30" });
    expect(result).toMatchObject({ date: "2026-10-12", dateTax: "2026-10-12", dateKHDPH: "2026-10-12", datePayment: "2026-10-12", priceHigh: 1983.47, priceHighVAT: 416.53, roundingAmount: -0.3, total: 2400, classificationVAT: "PD", text: "PHM nafta" });
    expect(result.originalDocument).toBeUndefined();
    expect(result.roundingDocument).toBeUndefined();
  });

  it("uses day one of the VAT period for a late row instead of the source DUZP", () => {
    const { result } = projectExpensePolicy({ ...cash, sourceIssueDate: "2026-09-29", sourceTaxDate: "2026-09-29", sourcePaymentDate: "2026-09-29" }, "voucher");
    expect(result).toMatchObject({ date: "2026-10-01", dateTax: "2026-10-01", dateKHDPH: "2026-10-01", datePayment: "2026-09-29", total: 2400 });
  });

  it("PN: gross only when proven by the source, never a KH date", () => {
    const pn = { ...cash, taxMode: "nonTax", classificationVAT: "" };
    const proven = projectExpensePolicy(pn, "voucher").result;
    expect(proven).toMatchObject({ priceNone: 2400, classificationVAT: "PN", total: 2400 });
    expect(proven.dateKHDPH).toBeUndefined();
    expect(proven.priceHigh).toBeUndefined();
    const unproven = projectExpensePolicy({ ...pn, priceHighSum: 2399 }, "voucher");
    expect(unproven.issues.map((i) => i.code)).toContain("SUMMARY_MISMATCH");
    expect(unproven.result.priceNone).toBeUndefined();
    expect(unproven.result.total).toBe(2400);
  });

  it("leaves only the values that depend on a missing fact blank", () => {
    const { result, issues } = projectExpensePolicy({ ...cash, sourceTaxDate: "", roundingAmount: 0 }, "voucher");
    expect(issues.map((i) => i.code)).toEqual(["SOURCE_TAX_DATE_REQUIRED"]);
    expect(result.date).toBeUndefined();
    expect(result.dateKHDPH).toBeUndefined();
    expect(result).toMatchObject({ priceHigh: 1983.47, priceHighVAT: 416.53, total: 2400, datePayment: "2026-10-12" });
    // An unknown tax mode blanks only its dependants (Členění DPH, KH); see expense-review-unknown-facts.test.ts.
    expect(computeReviewTargets({ tool: "create_cash_voucher", data: { ...cashMismatch, taxMode: "", partnerVatStatus: "" , vatPeriod: PERIOD } }, PERIOD))
      .toMatchObject({ targetDate: "2026-10-12", targetPriceHigh: 1983.47, targetTotal: 2400, targetDateKHDPH: null, classificationVAT: null });
  });
});

describe("reviewed preview of invalid cash and card rows", () => {
  it("shows every known POHODA value, Czech notes only, and rejects import until the row reconciles", async () => {
    const { prepared, cells, edit, submit, inspect, runs, manifestPath } = await setup([
      { requestId: "VD1", tool: "create_cash_voucher", data: cashMismatch },
      { requestId: "PK1", tool: "create_other_liability", data: cardMismatch }
    ]);
    expect(prepared.requiresReview).toEqual(["VD1", "PK1"]);
    const cash = await cells("VD1");
    expect(cash).toMatchObject({ action: "Prověřit", text: "PHM nafta", classificationVAT: "PD", targetDate: "2026-10-12", targetDateTax: "2026-10-12", targetDateKHDPH: "2026-10-12",
      targetPriceHigh: 1983.47, targetPriceHighVAT: 416.53, targetRounding: -0.3, targetTotal: 2400, targetDocument: null, targetPriceLow: null, targetPriceNone: null });
    expect(cash.reviewNotes).toBe("Součet základů a DPH 2 400,00 se zaokrouhlením -0,30 dává 2 399,70, ale Celkem je 2 400,00; ověřte zaokrouhlení a částku k úhradě na dokladu.");
    expect(String(cash.plannedImport)).toMatch(/^Import zatím nelze – důvod je v poznámce\.\nDatum 12\.10\.2026, DPH 12\.10\.2026, KH 12\.10\.2026, úhrada 12\.10\.2026/);
    const card = await cells("PK1");
    expect(card).toMatchObject({ text: "PHM benzín", classificationVAT: "PD", targetDate: "2026-10-05", targetDocument: "Přidělí se z PK", targetSymVar: "Přidělí se z PK",
      targetPriceHigh: 1757.35, targetPriceHighVAT: 369.04, targetRounding: null, targetTotal: 2126.4 });
    expect(card.reviewNotes).toBe("Součet částek 2 126,39 neodpovídá částce Celkem 2 126,40; ověřte částky na dokladu.");
    for (const row of [cash, card]) for (const key of ["reviewNotes", "plannedImport"]) expect(String(row[key])).not.toMatch(codesIn);
    // Machine codes stay in structured metadata.
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.targetProjection).toBe(3);
    expect(manifest.rows.map((r: any) => r.issues.map((i: any) => i.code))).toEqual([["SUMMARY_MISMATCH"], ["SUMMARY_MISMATCH"]]);
    expect(manifest.rows[0].data).toMatchObject({ priceHigh: 1983.47, priceHighVAT: 416.53, roundingAmount: -0.3, total: 2400, classificationVAT: "PD", text: "PHM nafta" });

    // Unchanged cells are not edits; forcing import is rejected with the Czech reason.
    await edit("VD1", { action: "Importovat" }); await edit("PK1", { action: "Importovat" });
    const forced = await inspect();
    expect(forced.ignoredEdits).toEqual([]);
    expect(forced.invalid).toEqual([
      { rowId: "VD1", error: cash.reviewNotes, errorCode: "SUMMARY_MISMATCH" },
      { rowId: "PK1", error: card.reviewNotes, errorCode: "SUMMARY_MISMATCH" }
    ]);
    await expect(submit()).rejects.toThrow(/nedávají|neodpovídá/);
    expect(runs).toHaveLength(0);

    // The reviewer corrects the source facts in the visible cells after checking the receipt.
    await edit("VD1", { targetRounding: null });
    await edit("PK1", { targetRounding: 0.01 });
    const fixed = await inspect();
    expect(fixed.invalid).toEqual([]);
    expect(fixed.status).toBe("readyForReview");
    const result = await submit();
    expect(result.ok).toBe(true);
    const [vd, pk] = runs[0].ops;
    expect(vd.header).toMatchObject({ priceHigh: 1983.47, priceHighVAT: 416.53, total: 2400, classificationVAT: "PD", text: "PHM nafta" });
    expect(vd.header.roundingAmount).toBeUndefined();
    expect(pk.header).toMatchObject({ priceHigh: 1757.35, priceHighVAT: 369.04, roundingAmount: 0.01, total: 2126.4 });
    for (const [op, tool] of [[vd, "create_cash_voucher"], [pk, "create_other_liability"]] as const) {
      const xml = await xmlOf(op, tool);
      expect(classificationOf(xml)).toBe("PD");
      expect(textOf(xml)).toBe(op.header.text);
    }
  });

  it("reads an older workbook whose rejected rows have blank POHODA cells", async () => {
    const { edit, inspect, manifestPath, colOf } = await setup([
      { requestId: "VD1", tool: "create_cash_voucher", data: cashMismatch },
      { requestId: "FP1", tool: "create_invoice", data: invoiceOk }
    ]);
    // Simulate the previous layout: no projection marker, every target cell of VD1 blank.
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.targetProjection;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const targetKeys = REVIEW_COLUMNS.filter((c) => c.kind.startsWith("target")).map((c) => c.key);
    await edit("VD1", Object.fromEntries(targetKeys.map((key) => [key, null])));
    expect(colOf("targetTotal")).toBeGreaterThan(0);
    const legacy = await inspect();
    expect(legacy.rows.find((r: any) => r.rowId === "VD1")).toMatchObject({ valid: false, errorCode: "SUMMARY_MISMATCH", changedFields: [] });
    expect(legacy.rows.find((r: any) => r.rowId === "FP1")).toMatchObject({ valid: true });
    // Once corrected (the receipt shows no rounding), the blank cells must show the imported values before import.
    await edit("VD1", { targetRounding: 0 });
    const corrected = await inspect();
    expect(corrected.rows.find((r: any) => r.rowId === "VD1")).toMatchObject({ valid: false, errorCode: "TARGET_EDIT_REJECTED", error: expect.stringMatching(/^Po úpravách tabulka neukazuje importované hodnoty: Datum dokladu \(prázdné\) → 2026-10-12/) });
  });
});

describe("Členění DPH PD for domestic taxable expenses", () => {
  const base = { ...invoiceOk, vatPeriod: PERIOD };

  it("normalizes the known PDzjed alias for received invoices, commitments and cash vouchers only", () => {
    expect(resolveExpensePolicy({ ...base, type: "receivedInvoice" }).classificationVAT).toBe("PD");
    expect(resolveExpensePolicy({ ...base, type: "commitment", classificationVAT: "pdzjed" }).classificationVAT).toBe("PD");
    expect(resolveExpensePolicy({ ...base, type: "expense", cashAccount: "HP", sourcePaymentDate: "2026-10-02", roundingAmount: 0 }, [], "voucher").classificationVAT).toBe("PD");
    // Other codes, PN and foreign suppliers are never rewritten automatically.
    expect(resolveExpensePolicy({ ...base, type: "receivedInvoice", classificationVAT: "PDpr" }).classificationVAT).toBe("PDpr");
    expect(resolveExpensePolicy({ ...base, type: "receivedInvoice", taxMode: "nonTax", classificationVAT: "PN" }).classificationVAT).toBe("PN");
    expect(canonicalClassificationVAT("PDzjed", { partnerCountry: "DE" }, "taxable")).toBe("PDzjed");
    expect(canonicalClassificationVAT("PDzjed", { partnerCountry: "CZ", currency: "EUR" }, "taxable")).toBe("PDzjed");
    expect(canonicalClassificationVAT("PDzjed", { partnerCountry: "CZ" }, "nonTax")).toBe("PDzjed");
    expect(canonicalClassificationVAT("PDzjed", { partnerDic: "CZ25596641" }, "taxable")).toBe("PD");
  });

  it("writes PD in single and batch XML", async () => {
    const single = newClient();
    await single.client.createInvoice({ ...base, type: "commitment" }, [], "MCPTEST-PD-1");
    const batch = newClient();
    await batch.client.writeBatch([
      { requestId: "a", tool: "create_invoice", header: { ...base, type: "receivedInvoice" }, items: [] },
      { requestId: "b", tool: "create_cash_voucher", header: { ...base, type: "expense", cashAccount: "HP", sourcePaymentDate: "2026-10-02", roundingAmount: 0 }, items: [] }
    ] as any, "MCPTEST-PD-2");
    const xml = [...single.transport.calls, ...batch.transport.calls].join("\n");
    expect(xml).not.toContain("PDzjed");
    expect(xml.match(/<typ:ids>PD<\/typ:ids>/g)).toHaveLength(3);
  });

  it("shows PD for a PDzjed history suggestion and rejects a PDzjed cell that would import as PD", async () => {
    const history = [{ invoiceHeader: { id: 41, invoiceType: "commitment", date: "2026-09-02", text: "Diesel", accounting: { ids: "7Vost" }, classificationVAT: { ids: "PDzjed" }, partnerIdentity: { address: { company: supplier.partnerName, ico: supplier.partnerIco } } }, invoiceSummary: {} }];
    const { prepared, cells, edit, inspect, manifestPath } = await setup([{ requestId: "PK1", tool: "create_other_liability", data: { ...cardMismatch, classificationVAT: "", text: "", roundingAmount: 0.01 } }], history);
    expect(prepared.requiresReview).toEqual([]);
    expect(await cells("PK1")).toMatchObject({ classificationVAT: "PD", text: "PHM nafta" });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.rows[0].data).toMatchObject({ classificationVAT: "PD", text: "PHM nafta" });
    expect(manifest.sources.PK1.suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ field: "classificationVAT", value: "PD" }), expect.objectContaining({ field: "text", value: "PHM nafta" })]));
    await edit("PK1", { action: "Importovat", classificationVAT: "PDzjed", text: "Diesel" });
    const rejected = await inspect();
    expect(rejected.invalid[0]).toMatchObject({ rowId: "PK1", errorCode: "TARGET_EDIT_REJECTED" });
    expect(rejected.invalid[0].error).toContain("Text dokladu „Diesel“ se do POHODY zapíše jako „PHM nafta“; přepište buňku na „PHM nafta“.");
    expect(rejected.invalid[0].error).toContain("Členění DPH „PDzjed“ se do POHODY zapíše jako „PD“; přepište buňku na „PD“.");
    await edit("PK1", { classificationVAT: "PD", text: "PHM nafta" });
    expect((await inspect()).invalid).toEqual([]);
  });
});

describe("fuel text PHM nafta / PHM benzín", () => {
  it("maps unambiguous fuel texts to the canonical text, idempotently", () => {
    for (const value of ["Diesel", "DIESEL", " nafta ", "Nafta motorová", "Motorová nafta", "PHM - nafta", "phm diesel", "PHM nafta"]) expect(canonicalExpenseText(value)).toBe("PHM nafta");
    for (const value of ["Natural 95", "natural95", "Benzín", "BENZIN", "Natural 98", "PHM benzín", "PHM benzin", "PHM benzi\u0301n"]) expect(canonicalExpenseText(value)).toBe("PHM benzín");
    expect(FUEL_TEXT_BENZIN).toBe("PHM benz\u00edn"); // long í, precomposed (cp1250-safe)
    expect(canonicalExpenseText(canonicalExpenseText("Diesel"))).toBe("PHM nafta");
    expect(canonicalExpenseText(canonicalExpenseText("Natural 95"))).toBe("PHM benzín");
  });

  it("keeps the non-fuel part of a mixed text while canonicalizing its fuel component", () => {
    const mixed: Array<[string, string]> = [
      ["Natural 95 + olej", "PHM benzín + olej"],
      ["Benzín + olej", "PHM benzín + olej"],
      ["PHM benzin + olej", "PHM benzín + olej"],
      ["Diesel + kapalina do ostřikovačů", "PHM nafta + kapalina do ostřikovačů"],
      ["Diesel a voda do ostřikovačů", "PHM nafta a voda do ostřikovačů"],
      ["Nafta, myčka", "PHM nafta, myčka"],
      ["olej + Natural 98", "olej + PHM benzín"],
      ["Nafta + AdBlue", "PHM nafta + AdBlue"]
    ];
    for (const [given, written] of mixed) {
      expect(canonicalExpenseText(given), given).toBe(written);
      expect(canonicalExpenseText(written), written).toBe(written);
    }
  });

  it("never infers fuel from a supplier, a bare PHM or an unrecognized component", () => {
    for (const value of ["PHM", "PHM + olej", "Pohonné hmoty", "Globus", "ORLEN", "Shell", "AdBlue", "Materiál", "Nafta 45,3 l", "Natural 95 olej", "Mytí + olej"]) expect(canonicalExpenseText(value)).toBe(value);
  });

  it("previews the canonical text for every expense agenda and writes the same text to XML", async () => {
    const docs = [
      { requestId: "FP1", tool: "create_invoice" as const, data: { ...invoiceOk, text: "Diesel" } },
      { requestId: "PK1", tool: "create_other_liability" as const, data: { ...cardMismatch, roundingAmount: 0.01, text: "Benzín" } },
      { requestId: "VD1", tool: "create_cash_voucher" as const, data: { ...cashMismatch, roundingAmount: undefined, text: "nafta + olej" } }
    ];
    const { cells, edit, submit, runs } = await setup(docs);
    const expected: Record<string, string> = { FP1: "PHM nafta", PK1: "PHM benzín", VD1: "PHM nafta + olej" };
    for (const doc of docs) { expect((await cells(doc.requestId)).text).toBe(expected[doc.requestId]); await edit(doc.requestId, { action: "Importovat" }); }
    await submit();
    for (const op of runs[0].ops) {
      const xml = await xmlOf(op, docs.find((d) => d.requestId === op.requestId)!.tool);
      expect(textOf(xml)).toBe(expected[op.requestId]);
      expect(classificationOf(xml)).toBe("PD");
    }
  });
});
