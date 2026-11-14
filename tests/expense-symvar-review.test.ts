import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { REVIEW_COLUMNS } from "../src/mcp/review-workbook.js";
import { resolveExpensePolicy } from "../src/pohoda/expense-policy.js";

/** Received-invoice VS derivation through the real XLSX preview -> inspect -> import path. */
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const target = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const colOf = (key: string) => REVIEW_COLUMNS.findIndex((c) => c.key === key) + 1;

async function setup(data: Record<string, any>) {
  const dir = await mkdtemp(join(tmpdir(), "symvar-review-")); dirs.push(dir);
  const pdf = join(dir, "source.pdf"); await writeFile(pdf, "%PDF-1.4 test");
  const runs: any[] = [];
  const client = { listRecordsBatch: async (requests: any[]) => ({ isOk: () => true, items: requests.map(() => ({ state: "ok", data: { invoice: [] } })) }) };
  const importer = { run: async (ops: any[], id: string, options: any) => {
    runs.push({ ops, id, options }); return { ok: true, state: "ok", results: ops.map((op, i) => ({ requestId: op.requestId, id: i + 1, created: true, verified: true })) };
  } };
  const service = new ExpenseReviewService({ client: client as any, importer, directory: dir });
  const prepared = await service.prepare({ databaseId: target.databaseOverride, target, vatPeriod: "2026-11", documents: [{ requestId: "A", tool: "create_invoice", data: {
    type: "receivedInvoice", sourcePdfPath: pdf, sourcePages: [1], taxMode: "taxable", classificationVAT: "PD", partnerIco: "25596641", partnerName: "Test supplier",
    sourceIssueDate: "2026-11-10", sourceTaxDate: "2026-11-10", sourceDocumentNumber: "FV-2026/0007",
    text: "Materiál", priceHigh: 100, priceHighVAT: 21, total: 121, ...data
  } }] });
  const sheet = async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(prepared.workbookPath); return { wb, ws: wb.getWorksheet("Doklady")! }; };
  const edit = async (values: Record<string, any>) => {
    const { wb, ws } = await sheet();
    for (const [key, value] of Object.entries(values)) ws.getCell(3, colOf(key)).value = value;
    await wb.xlsx.writeFile(prepared.workbookPath);
  };
  const submit = () => service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: target.databaseOverride, target });
  /** What the importer will actually send: the same shared policy on the reviewed header. */
  const finalSymVar = (run = runs.at(-1)) => resolveExpensePolicy(run.ops[0].header, [], "invoice").symVar;
  return { service, prepared, sheet, edit, submit, runs, finalSymVar };
}

describe("received invoice VS in reviewed imports", () => {
  it("previews the derived VS as planned output, not as a source fact, and imports the same value", async () => {
    const { service, prepared, sheet, submit, runs, finalSymVar } = await setup({});
    const preview = prepared.rows[0].preview;
    expect(preview.planned).toMatchObject({ symVar: "20260007", symVarRule: "derived-from-source-document", originalDocument: "FV-2026/0007" });
    expect(preview.sourceFacts.sourceSymVar).toBeUndefined();
    expect(preview.warnings.join(" ")).toContain("derived from supplier document number");
    const { ws } = await sheet();
    expect(ws.getCell(3, colOf("targetSymVar")).value).toBe("20260007");
    expect(String(ws.getCell(3, colOf("plannedImport")).value)).toContain("20260007");
    expect((await service.inspect({ reviewId: prepared.reviewId })).rows[0].preview.planned.symVar).toBe("20260007");
    await submit();
    expect(runs[0].ops[0].header.sourceDocumentNumber).toBe("FV-2026/0007");
    expect(runs[0].ops[0].header.sourceSymVar).toBeUndefined();
    expect(finalSymVar()).toBe("20260007");
  });

  it("keeps a reviewer-entered VS and rejects clearing a VS the policy would derive", async () => {
    const { service, prepared, edit, submit, runs, finalSymVar } = await setup({ sourceSymVar: "0042026" });
    expect(prepared.rows[0].preview.planned).toMatchObject({ symVar: "0042026", symVarRule: "source" });
    await edit({ targetSymVar: "00777" });
    expect((await service.inspect({ reviewId: prepared.reviewId })).rows[0].preview.planned).toMatchObject({ symVar: "00777", symVarRule: "source" });
    await submit();
    expect(finalSymVar()).toBe("00777");

    // A blank VS cannot be imported: the policy derives one from the supplier number.
    await edit({ targetSymVar: null });
    const view = await service.inspect({ reviewId: prepared.reviewId });
    expect(view.rows[0]).toMatchObject({ valid: false, error: expect.stringContaining("VS v POHODĚ: (prázdné) nelze zapsat, podle pravidel importu bude 20260007") });
    await expect(submit()).rejects.toThrow(/nelze zapsat/);
    expect(runs).toHaveLength(1);
  });

  it("follows an edited supplier document number and shows no VS when it has no digits", async () => {
    const { service, prepared, edit, submit, finalSymVar } = await setup({});
    await edit({ targetDocument: "FA-ABC" });
    // The derived VS shown for the old number is no longer imported: blocked until updated.
    const stale = (await service.inspect({ reviewId: prepared.reviewId })).rows[0];
    expect(stale).toMatchObject({ valid: false, error: expect.stringMatching(/neukazuje importované hodnoty: VS v POHODĚ \S+ → vymazat/) });
    await expect(submit()).rejects.toThrow(/neukazuje importované hodnoty/);
    await edit({ targetSymVar: null });
    const planned = (await service.inspect({ reviewId: prepared.reviewId })).rows[0].preview;
    expect(planned.planned.symVar).toBeUndefined();
    expect(planned.planned.symVarRule).toBe("missing-no-digits");
    await submit();
    expect(finalSymVar()).toBeUndefined();
  });

  it("does not derive a VS for other liabilities", async () => {
    const { prepared } = await setup({ type: "commitment" });
    expect(prepared.rows[0].preview.planned.symVar).toBeUndefined();
    expect(prepared.rows[0].preview.planned.symVarRule).toBe("none");
  });
});
