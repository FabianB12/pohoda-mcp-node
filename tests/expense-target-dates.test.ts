/**
 * Target-date regression for the reviewed expense workflow (synthetic data only).
 *
 * A late source document (issue/DUZP in an earlier month than the selected vatPeriod)
 * must be written to POHODA with the target dates on day one of vatPeriod, while the
 * supplier's original dates survive only as internal source facts (sourceIssueDate,
 * sourceTaxDate, intNote). Whatever the workbook DISPLAYS as the planned/target values
 * must equal what the import builder actually writes, and editing any read-only
 * target/plan cell must never change the written values.
 *
 * Deliberately layout-agnostic: columns are found by their header label from
 * REVIEW_COLUMNS at test time, and the tests do not assume that visible source-date
 * or payment-method columns exist.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { REVIEW_COLUMNS } from "../src/mcp/review-workbook.js";
import { resolveExpensePolicy } from "../src/pohoda/expense-policy.js";
import { PohodaClient } from "../src/pohoda/client.js";
import type { CliXmlJobResult, XmlTransport } from "../src/pohoda/transport.js";

const VAT_PERIOD = "2026-10";
const PERIOD_START = "2026-10-01";
const TARGET_DATE_FIELDS = ["date", "dateTax", "dateAccounting", "dateKHDPH", "datePayment"] as const;
const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

type Tool = "create_invoice" | "create_other_liability" | "create_cash_voucher";
type Doc = { requestId: string; tool: Tool; data: Record<string, any> };

// Synthetic suppliers/numbers; no client data.
const common = { partnerIco: "25596641", partnerName: "Test Supplier s.r.o.", partnerCountry: "CZ", text: "MCPTEST materiál", accounting: "501" };
const taxable = (extra: Record<string, any> = {}) => ({ ...common, taxMode: "taxable", classificationVAT: "PD", sourceChargesVat: true, priceHigh: 1000, priceHighVAT: 210, total: 1210, ...extra });

const DOCS: Record<string, Doc> = {
  // Late taxable invoice: source August, review period October.
  late: { requestId: "LATE", tool: "create_invoice", data: taxable({ date: "2026-08-04", dateTax: "2026-08-04", originalDocument: "MCPTEST-0804", dateDue: "2026-08-18" }) },
  // Same month as vatPeriod: source dates are kept.
  current: { requestId: "CURRENT", tool: "create_invoice", data: taxable({ date: "2026-10-12", dateTax: "2026-10-10", originalDocument: "MCPTEST-1012" }) },
  // Late non-tax (PN): target dates move, no KH date at all.
  latePn: { requestId: "LATEPN", tool: "create_invoice", data: { ...common, taxMode: "nonTax", classificationVAT: "PN", sourceChargesVat: false, date: "2026-09-21", originalDocument: "MCPTEST-0921", priceNone: 500, total: 500 } },
  // Late cash expense: document dates move, the actual payment date is a source fact and stays.
  lateCash: { requestId: "LATECASH", tool: "create_cash_voucher", data: taxable({ date: "2026-09-20", dateTax: "2026-09-20", sourcePaymentDate: "2026-09-22", originalDocument: "MCPTEST-0920", cashAccount: "HP", priceHigh: 100, priceHighVAT: 21, total: 121 }) }
};

/** Original source facts the policy must preserve (taken from the synthetic inputs above). */
const SOURCE: Record<string, { issue: string; tax?: string; payment?: string }> = {
  LATE: { issue: "2026-08-04", tax: "2026-08-04" },
  CURRENT: { issue: "2026-10-12", tax: "2026-10-10" },
  LATEPN: { issue: "2026-09-21" },
  LATECASH: { issue: "2026-09-20", tax: "2026-09-20", payment: "2026-09-22" }
};

/** Exact POHODA target dates expected to be written (undefined = must be absent). */
const EXPECTED: Record<string, Partial<Record<(typeof TARGET_DATE_FIELDS)[number], string | undefined>>> = {
  LATE: { date: PERIOD_START, dateTax: PERIOD_START, dateAccounting: PERIOD_START, dateKHDPH: PERIOD_START, datePayment: undefined },
  CURRENT: { date: "2026-10-12", dateTax: "2026-10-10", dateKHDPH: "2026-10-10", datePayment: undefined },
  LATEPN: { date: PERIOD_START, dateTax: PERIOD_START, dateAccounting: PERIOD_START, dateKHDPH: undefined, datePayment: undefined },
  LATECASH: { date: PERIOD_START, dateTax: PERIOD_START, dateAccounting: undefined, dateKHDPH: PERIOD_START, datePayment: "2026-09-22" }
};

async function setup(docs: Doc[]) {
  const dir = await mkdtemp(join(tmpdir(), "target-dates-")); dirs.push(dir);
  const pdf = join(dir, "source.pdf"); await writeFile(pdf, "%PDF-1.4 MCPTEST");
  const runs: any[] = [];
  const client = { listRecordsBatch: async (requests: any[]) => ({ isOk: () => true, items: requests.map(() => ({ state: "ok", data: { invoice: [], voucher: [] } })) }) };
  const importer = { run: async (ops: any[], id: string, options: any) => {
    runs.push({ ops: structuredClone(ops), id, options });
    return { ok: true, state: "ok", results: ops.map((op, i) => ({ requestId: op.requestId, id: i + 1, created: true, verified: true })) };
  } };
  const service = new ExpenseReviewService({ client: client as any, importer, directory: dir });
  const prepared = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: VAT_PERIOD, documents: docs.map((d) => ({ ...d, data: { sourcePdfPath: pdf, sourcePages: [1], ...structuredClone(d.data) } })) });
  const submit = () => service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: target.databaseOverride, target });
  return { service, prepared, submit, runs };
}

/** Same normalization ExpenseImporter.run applies before writing (src/mcp/expense-import.ts). */
const imported = (op: any) => resolveExpensePolicy({ ...op.header, ...(op.header.cardPayment ? { cardSequence: 1 } : {}) }, op.items ?? [], op.tool === "create_cash_voucher" ? "voucher" : "invoice");

/** Read-only display columns: planned import, computed POHODA values, trace. Found by label. */
const READ_ONLY = REVIEW_COLUMNS.filter((c) => c.kind === "plan" || c.kind === "display" || c.group === "plan" || c.group === "target");
const TARGET_DISPLAY = REVIEW_COLUMNS.filter((c) => c.kind === "plan" || c.group === "plan" || c.group === "target");

async function sheetOf(path: string) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet("Doklady")!;
  const byLabel = new Map<string, number>();
  ws.getRow(2).eachCell((cell, col) => byLabel.set(String(cell.value ?? "").trim(), col));
  const rowOf = (rowId: string) => {
    for (let r = 3; r <= ws.rowCount; r++) if (String(ws.getRow(r).getCell(1).value ?? "") === rowId) return r;
    throw new Error(`row ${rowId} not found`);
  };
  return { wb, ws, byLabel, rowOf };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const cz = (value: string) => { const [y, m, d] = value.split("-"); return `${d}.${m}.${y}`; };

/** Every date the target/plan display shows for a row, as ISO strings. */
async function displayedTargetDates(path: string, rowId: string): Promise<{ dates: Set<string>; text: string; cells: Record<string, unknown> }> {
  const { ws, byLabel, rowOf } = await sheetOf(path);
  const row = ws.getRow(rowOf(rowId));
  const dates = new Set<string>(); const texts: string[] = []; const cells: Record<string, unknown> = {};
  for (const column of TARGET_DISPLAY) {
    const col = byLabel.get(column.label); if (!col) continue;
    const value = row.getCell(col).value; cells[column.key] = value;
    if (value instanceof Date) dates.add(iso(value));
    else if (typeof value === "string") {
      texts.push(value);
      for (const m of value.matchAll(/\b(\d{2})\.(\d{2})\.(\d{4})\b/g)) dates.add(`${m[3]}-${m[2]}-${m[1]}`);
      for (const m of value.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) dates.add(m[1]!);
    }
  }
  return { dates, text: texts.join("\n"), cells };
}

class FakeTransport implements XmlTransport {
  public calls: string[] = [];
  async exchange(xml: string, database: string): Promise<CliXmlJobResult> {
    this.calls.push(xml);
    return { xml: '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"/></rsp:responsePack>', jobId: "job", database, jobDir: "/tmp/job", queueWaitMs: 0, processSlotWaitMs: 0, durationMs: 1, exitCode: 0, jobRetained: false };
  }
  status(database = ""): Record<string, unknown> { return { transport: "fake", database }; }
}
const xmlValue = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

describe("expense target dates: prepare → inspect → import → XML", () => {
  const all = Object.values(DOCS);

  it("writes day one of vatPeriod for late documents and keeps current-month and cash payment dates", async () => {
    const { prepared, submit, runs } = await setup(all);
    for (const d of all) {
      const row = prepared.rows?.find?.((r: any) => r.rowId === d.requestId) ?? null;
      if (row) expect(row.valid ?? true).not.toBe(false);
    }
    await markAll(prepared.workbookPath, "Importovat");
    const result = await submit();
    expect(result.ok).toBe(true);
    const ops = runs[0].ops as any[];
    expect(ops.map((op) => op.requestId).sort()).toEqual(all.map((d) => d.requestId).sort());
    for (const op of ops) {
      const written = imported(op);
      for (const [field, value] of Object.entries(EXPECTED[op.requestId]!)) {
        expect([op.requestId, field, written[field]]).toEqual([op.requestId, field, value]);
      }
      const source = SOURCE[op.requestId]!;
      // Source facts are preserved internally, never rewritten to the target dates.
      expect(written.sourceIssueDate).toBe(source.issue);
      if (source.tax) expect(written.sourceTaxDate).toBe(source.tax);
      if (source.payment) expect(written.sourcePaymentDate).toBe(source.payment);
      expect(written._expensePolicy.original.issueDate).toBe(source.issue);
      const late = op.requestId !== "CURRENT";
      expect(written._expensePolicy.lateSource).toBe(late);
      if (late) {
        expect(written.intNote).toContain(`vystaveno ${source.issue}`);
        if (source.tax) expect(written.intNote).toContain(`DUZP ${source.tax}`);
      }
      // The submitted header (pre-policy) still carries the original facts, not October.
      expect(op.header.sourceIssueDate ?? op.header.date).toBe(source.issue);
    }
  });

  it("PN never gets a KH date and keeps its classification", async () => {
    const { prepared, submit, runs } = await setup([DOCS.latePn!]);
    await markAll(prepared.workbookPath, "Importovat");
    await submit();
    const written = imported(runs[0].ops[0]);
    expect(written.classificationVAT).toBe("PN");
    expect(written.dateKHDPH).toBeUndefined();
    expect(written.date).toBe(PERIOD_START);
  });

  it("the shared XML builder emits exactly the target dates and keeps sources in intNote", async () => {
    const { prepared, submit, runs } = await setup(all);
    await markAll(prepared.workbookPath, "Importovat");
    await submit();
    for (const op of runs[0].ops as any[]) {
      const transport = new FakeTransport();
      const client = new PohodaClient({ transport, ico: target.dataPackIco, database: target.databaseOverride });
      await client.writeBatch([{ ...op, header: imported(op), items: [] }], `MCPTEST-${op.requestId}`);
      const xml = transport.calls[0]!;
      const prefix = op.tool === "create_cash_voucher" ? "vch" : "inv";
      for (const [field, value] of Object.entries(EXPECTED[op.requestId]!)) {
        expect([op.requestId, field, xmlValue(xml, `${prefix}:${field}`)]).toEqual([op.requestId, field, value]);
      }
      if (op.requestId !== "CURRENT") expect(xmlValue(xml, `${prefix}:intNote`)).toContain(`vystaveno ${SOURCE[op.requestId]!.issue}`);
    }
  });

  it("the source data passed to the policy is never mutated, and re-applying the policy is stable", () => {
    for (const d of all) {
      const header = { ...structuredClone(d.data), type: d.tool === "create_cash_voucher" ? "expense" : "receivedInvoice", vatPeriod: VAT_PERIOD };
      const before = structuredClone(header);
      const kind = d.tool === "create_cash_voucher" ? "voucher" : "invoice";
      const once = resolveExpensePolicy(header, [], kind);
      expect(header).toEqual(before);
      const twice = resolveExpensePolicy(once, [], kind);
      for (const field of [...TARGET_DATE_FIELDS, "sourceIssueDate", "sourceTaxDate", "sourcePaymentDate", "intNote"]) expect([d.requestId, field, twice[field]]).toEqual([d.requestId, field, once[field]]);
    }
  });

  it("whatever the workbook shows as target/plan dates is exactly what the import writes", async () => {
    const { prepared, submit, runs } = await setup(all);
    const shown = new Map<string, Awaited<ReturnType<typeof displayedTargetDates>>>();
    for (const d of all) shown.set(d.requestId, await displayedTargetDates(prepared.workbookPath, d.requestId));
    await markAll(prepared.workbookPath, "Importovat");
    await submit();
    for (const op of runs[0].ops as any[]) {
      const written = imported(op);
      // dateDue is also written to POHODA and shown in the target-only preview.
      const writtenDates = new Set([...TARGET_DATE_FIELDS, "dateDue"].map((f) => written[f]).filter(Boolean) as string[]);
      const display = shown.get(op.requestId)!;
      // At least one display (plan text or target columns) must show the written dates…
      for (const date of writtenDates) expect([op.requestId, date, display.dates.has(date)]).toEqual([op.requestId, date, true]);
      // …and no target/plan display may show a date that is not written (e.g. the source date).
      for (const date of display.dates) expect([op.requestId, date, writtenDates.has(date)]).toEqual([op.requestId, date, true]);
      // Computed Doklad/VS columns (when present) equal the written values.
      if ("targetDocument" in display.cells) expect(display.cells.targetDocument ?? null).toBe(written.originalDocument ?? null);
      if ("targetSymVar" in display.cells) expect(display.cells.targetSymVar ?? null).toBe(written.symVar ?? null);
      if (op.requestId === "LATEPN") expect(display.text).not.toMatch(/KH \d{2}\.\d{2}\.\d{4}/);
    }
  });

  it("tampering read-only target/plan cells is rejected or ignored, never written", async () => {
    const baseline = await setup(all);
    await markAll(baseline.prepared.workbookPath, "Importovat");
    await baseline.submit();
    const expected = new Map((baseline.runs[0].ops as any[]).map((op) => [op.requestId, imported(op)]));

    const { service, prepared, submit, runs } = await setup(all);
    await markAll(prepared.workbookPath, "Importovat");
    const { wb, ws, byLabel } = await sheetOf(prepared.workbookPath);
    let tampered = 0;
    for (let r = 3; r <= ws.rowCount; r++) {
      for (const column of READ_ONLY) {
        const col = byLabel.get(column.label); if (!col) continue;
        const cell = ws.getRow(r).getCell(col);
        const value = cell.value;
        // Put the wrong (source-month) date or a bogus reference into every read-only cell.
        cell.value = value instanceof Date ? new Date(Date.UTC(2026, 7, 4)) : column.kind === "plan" ? `Datum ${cz("2026-08-04")}, DPH ${cz("2026-08-04")}, KH ${cz("2026-08-04")}` : "MCPTEST-TAMPER";
        tampered++;
      }
    }
    expect(tampered).toBeGreaterThan(0);
    await wb.xlsx.writeFile(prepared.workbookPath);

    const inspected = await service.inspect({ reviewId: prepared.reviewId }).catch((error: Error) => ({ rejected: error.message }));
    let outcome: any;
    try { outcome = await submit(); } catch (error) { outcome = { rejected: (error as Error).message }; }
    if (outcome.rejected) {
      expect(runs).toHaveLength(0); // rejected before any write
      return;
    }
    // Accepted: the read-only edits must not reach POHODA; the plan is recomputed from source facts.
    expect(inspected).toBeDefined();
    for (const op of runs[0].ops as any[]) {
      const written = imported(op), base = expected.get(op.requestId)!;
      for (const field of [...TARGET_DATE_FIELDS, "originalDocument", "symVar", "intNote", "sourceIssueDate", "sourceTaxDate", "sourcePaymentDate"]) {
        expect([op.requestId, field, written[field]]).toEqual([op.requestId, field, base[field]]);
      }
      expect(JSON.stringify(op.header)).not.toContain("MCPTEST-TAMPER");
    }
  });
});

/** Sets the Akce cell of every document row (column found by label). */
async function markAll(path: string, label: string) {
  const { wb, ws, byLabel } = await sheetOf(path);
  const col = byLabel.get(REVIEW_COLUMNS.find((c) => c.key === "action")!.label)!;
  for (let r = 3; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(1).value) ws.getRow(r).getCell(col).value = label;
  await wb.xlsx.writeFile(path);
}
