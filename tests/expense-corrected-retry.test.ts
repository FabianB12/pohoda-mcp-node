import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExpenseImporter } from "../src/mcp/expense-import.js";
import { ExpenseReviewService, type ReviewWorkbookCodec } from "../src/mcp/expense-review.js";
import type { ReviewWorkbook, ReviewWorkbookRead } from "../src/mcp/review-contract.js";

/**
 * Corrected retry after a failed expense import.
 *
 * - A failure before any POHODA write (validation, supplier conflict) or an explicit
 *   POHODA rejection is not a permanent ban: after correction, a fresh inspect hash and a
 *   fresh explicit approval, the official import may run again and writes only rows
 *   that are not already present (MCP-ID marker / supplier + source number scan).
 * - A write with no usable response stays write_uncertain and keeps the review locked.
 */

const result = (items: any[], state = "ok", transport: any = {}) => ({ state, transport, isOk: () => state === "ok" && items.every((i) => i.isOk()), items, toArray: () => ({ state, items }) });
const item = (data: any) => ({ state: "ok", data, isOk: () => true });
const docHeader = (doc: any) => doc.invoiceHeader ?? doc.voucherHeader;
const base = (extra: any = {}) => ({ sourceType: "manual", type: "receivedInvoice", taxMode: "taxable", classificationVAT: "PD", vatPeriod: "2026-11", date: "2026-10-23", dateTax: "2026-10-23", sourceDocumentNumber: "SOURCE-1", originalDocument: "SOURCE-1", partnerId: 7, partnerName: "Supplier", text: "Office expenses", priceHigh: "1000.00", priceHighVAT: "210.00", priceHighSum: "1210.00", total: "1210.00", ...extra });

/** Minimal POHODA 14302 stand-in: extId filters ignored and not exported; markers live in intNote. */
class ImportClient {
  documents: any[] = [];
  writes: any[][] = [];
  calls = 0;
  rejectSource = "";
  dropResponseFor = "";
  rejectPack = false;
  hideContactAfterWrite = false;
  contact: any = { addressbookHeader: { id: "7", p1: "true", identity: { address: { company: "Supplier", ico: "25596641" } } } };
  getDatabase() { return "12345678_2026.mdb"; }
  async listRecords() { this.calls++; return result([item({ addressbook: this.contact ? [this.contact] : [] })]); }
  async listRecordsBatch(requests: any[]) {
    this.calls++;
    return result(requests.map((request) => {
      if (request.agenda === "addressbook") return item({ addressbook: this.contact && !(this.hideContactAfterWrite && this.writes.length) ? [this.contact] : [] });
      const docs = this.documents.filter((doc) => !!doc.invoiceHeader && (!request.subType || docHeader(doc).type === request.subType));
      if (request.filter?.id) return item({ invoice: docs.filter((doc) => Number(docHeader(doc).id) === request.filter.id) });
      return item({ invoice: docs.filter((doc) => !request.options?.idFrom || Number(docHeader(doc).id) >= request.options.idFrom) });
    }));
  }
  async writeBatch(operations: any[], packId: string) {
    this.calls++;
    this.writes.push(structuredClone(operations));
    if (this.rejectPack) { this.rejectPack = false; return result([], "error", { responseOutcome: "rejected" }); }
    const items = operations.flatMap((op, index) => {
      const withId = (value: any) => ({ ...value, id: `${packId}-${index + 1}` });
      if (op.tool === "manage_address") {
        this.contact ??= { addressbookHeader: { id: "7", identity: { address: { company: op.data.company, ico: op.data.ico } } } };
        this.contact.addressbookHeader.p1 = "true";
        return [withId(item({ producedDetails: { id: "7" } }))];
      }
      const h = op.header;
      if (this.rejectSource === h.sourceDocumentNumber) { this.rejectSource = ""; return [withId({ state: "error", data: {}, isOk: () => false })]; }
      const id = this.documents.length + 1;
      this.documents.push({ invoiceHeader: { ...h, id, number: { numberRequested: h.number }, partnerIdentity: { id: h.partnerId, address: this.contact.addressbookHeader.identity.address }, classificationVAT: { ids: h.classificationVAT } }, invoiceSummary: { homeCurrency: { priceHigh: h.priceHigh, priceHighVAT: h.priceHighVAT, priceHighSum: h.priceHighSum } } });
      // The document is stored, but its response item is lost (uncertain outcome).
      if (this.dropResponseFor === h.sourceDocumentNumber) { this.dropResponseFor = ""; return []; }
      return [withId(item({ producedDetails: { id: String(id) } }))];
    });
    return result(items);
  }
}

const invoice = (extra: any = {}) => ({ tool: "create_invoice" as const, header: base(extra), items: [] });
const docWrites = (client: ImportClient) => client.writes.flat().filter((op: any) => op.tool === "create_invoice").map((op: any) => op.header.sourceDocumentNumber);

describe("ExpenseImporter: corrected retry after a definite failure", () => {
  it("rejects conflicting address-book IDs before any POHODA write, then imports the corrected batch", async () => {
    const client = new ImportClient(); const importer = new ExpenseImporter(client as any, null);
    const conflicting = [invoice({ partnerIco: "25596641" }), invoice({ sourceDocumentNumber: "SOURCE-2", originalDocument: "SOURCE-2", partnerIco: "25596641", partnerId: 8 })];
    await expect(importer.run(conflicting, "conflict", {})).rejects.toThrow(/ID adresy|dodavatel/i);
    expect(client.calls).toBeGreaterThan(0);
    expect(client.writes).toHaveLength(0);

    const corrected = [invoice({ partnerIco: "25596641" }), invoice({ sourceDocumentNumber: "SOURCE-2", originalDocument: "SOURCE-2", partnerIco: "25596641", partnerId: 7 })];
    const output = await importer.run(corrected, "corrected", {});
    expect(output).toMatchObject({ ok: true, state: "ok" });
    expect(docWrites(client)).toEqual(["SOURCE-1", "SOURCE-2"]);
  });

  // PROPOSED: thrown errors say whether any POHODA write was attempted.
  it("marks a pre-write failure as writeAttempted=false", async () => {
    const client = new ImportClient(); const importer = new ExpenseImporter(client as any, null);
    const error: any = await importer.run([invoice({ partnerIco: "25596641" }), invoice({ sourceDocumentNumber: "SOURCE-2", originalDocument: "SOURCE-2", partnerIco: "25596641", partnerId: 8 })], "conflict", {}).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.writeAttempted).toBe(false);
  });

  // PROPOSED: a failure after supplier setup was submitted is not reported as "nothing written".
  it("marks a failure after supplier setup as writeAttempted=true", async () => {
    const client = new ImportClient(); client.contact = null; client.hideContactAfterWrite = true;
    const importer = new ExpenseImporter(client as any, null);
    const error: any = await importer.run([invoice({ partnerId: 0, partnerIco: "25596641" })], "contact", {}).catch((e) => e);
    expect(error.message).toMatch(/not uniquely present/);
    expect(client.writes.flat().map((op: any) => op.tool)).toEqual(["manage_address"]);
    expect(error.writeAttempted).toBe(true);
  });

  it("writes only the POHODA-rejected row on a corrected retry and verifies the created row", async () => {
    const client = new ImportClient(); client.rejectSource = "SOURCE-2";
    const importer = new ExpenseImporter(client as any, null);
    const first = await importer.run([invoice(), invoice({ sourceDocumentNumber: "SOURCE-2", originalDocument: "SOURCE-2" })], "attempt-1", {});
    expect(first.ok).toBe(false);
    expect(first.results.map((r: any) => r.created)).toEqual([true, false]);

    const retry = await importer.run([invoice(), invoice({ sourceDocumentNumber: "SOURCE-2", originalDocument: "SOURCE-2", text: "Corrected" })], "attempt-2", {});
    expect(retry).toMatchObject({ ok: true, state: "ok" });
    expect(retry.results.map((r: any) => [r.state, r.created, r.verified])).toEqual([["already_exists", false, true], ["ok", true, true]]);
    expect(docWrites(client)).toEqual(["SOURCE-1", "SOURCE-2", "SOURCE-2"]);
    expect(client.documents).toHaveLength(2);
  });

  // PROPOSED: an explicit POHODA rejection is retryable after correction; doNotRetry stays for created/uncertain rows.
  it("labels an explicit POHODA rejection as rejected and not doNotRetry", async () => {
    const client = new ImportClient(); client.rejectSource = "SOURCE-2";
    const importer = new ExpenseImporter(client as any, null);
    const first = await importer.run([invoice(), invoice({ sourceDocumentNumber: "SOURCE-2", originalDocument: "SOURCE-2" })], "attempt-1", {});
    expect(first.results[0]).toMatchObject({ created: true, doNotRetry: true });
    expect(first.results[1]).toMatchObject({ created: false, outcome: "rejected", doNotRetry: false });
    expect(first.state).toBe("needs_review");
  });

  // PROPOSED: a whole-pack rejection (parsed responsePack state=error, no items) is a definite rejection.
  it("labels a parsed whole-pack rejection as rejected, not uncertain", async () => {
    const client = new ImportClient(); client.rejectPack = true;
    const importer = new ExpenseImporter(client as any, null);
    const first = await importer.run([invoice()], "pack-rejected", {});
    expect(first.results[0]).toMatchObject({ created: false, outcome: "rejected", doNotRetry: false });
    expect(first.state).not.toBe("write_uncertain");
  });

  // PROPOSED: a missing response item is uncertain (the record may exist), never "created: false".
  it("reports a missing response item as write_uncertain with created=unknown", async () => {
    const client = new ImportClient(); client.dropResponseFor = "SOURCE-2";
    const importer = new ExpenseImporter(client as any, null);
    const first = await importer.run([invoice(), invoice({ sourceDocumentNumber: "SOURCE-2", originalDocument: "SOURCE-2" })], "lost-item", {});
    expect(first.state).toBe("write_uncertain");
    expect(first.results[1]).toMatchObject({ created: "unknown", outcome: "missing", doNotRetry: true });
    // The retry marker scan still prevents a duplicate if someone reruns it.
    const again = await importer.run([invoice(), invoice({ sourceDocumentNumber: "SOURCE-2", originalDocument: "SOURCE-2" })], "lost-item-2", {});
    expect(again.results.map((r: any) => r.state)).toEqual(["already_exists", "already_exists"]);
    expect(client.documents).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Review service: the lock covers uncertain writes only.

const TARGET = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const DB = "demo-unit";

class JsonCodec implements ReviewWorkbookCodec {
  async writeReviewWorkbook(input: ReviewWorkbook, filePath: string) { await writeFile(filePath, JSON.stringify(input)); }
  async updateReviewDuplicateChecks(filePath: string, checks: Record<string, any>) {
    const wb = JSON.parse(await readFile(filePath, "utf8"));
    for (const row of wb.rows) row.duplicateCheck = checks[row.rowId];
    await writeFile(filePath, JSON.stringify(wb));
  }
  async readReviewWorkbook(filePath: string): Promise<ReviewWorkbookRead> {
    const { reviewId, databaseId, vatPeriod, rows } = JSON.parse(await readFile(filePath, "utf8"));
    return { reviewId, databaseId, vatPeriod, rows };
  }
}
class ReadOnlyClient {
  writes = 0;
  async listRecordsBatch(requests: any[]) { return result(requests.map((r) => item({ [r.agenda === "voucher" ? "voucher" : "invoice"]: [] }))); }
  async writeBatch() { this.writes++; throw new Error("the review service never writes directly"); }
}
class ScriptedImporter {
  runs: Array<{ ops: any[]; dataPackId: string }> = [];
  script: Array<(ops: any[]) => any> = [];
  async run(ops: any[], dataPackId: string) {
    this.runs.push({ ops: structuredClone(ops), dataPackId });
    const step = this.script.shift();
    if (!step) throw new Error("unexpected import run");
    return step(ops);
  }
}
const prewriteError = () => Object.assign(new Error("Two address-book IDs match the same supplier; review duplicates."), { writeAttempted: false });

let dir: string, pdfA: string, pdfB: string, importer: ScriptedImporter, service: ExpenseReviewService;
const doc = (rowId: string, extra: any = {}) => ({ requestId: rowId, tool: "create_invoice" as const, data: { type: "receivedInvoice", taxMode: "taxable", classificationVAT: "PD", sourcePdfPath: pdfA, sourcePages: [1], sourceIssueDate: "2026-10-20", sourceTaxDate: "2026-10-20", sourceDocumentNumber: `FV-${rowId}`, partnerIco: "25596641", partnerName: "Supplier s.r.o.", text: "Materiál", priceHigh: "1000.00", priceHighVAT: "210.00", total: "1210.00", ...extra } });
const edit = async (path: string, mutate: (wb: any) => void) => { const wb = JSON.parse(await readFile(path, "utf8")); mutate(wb); await writeFile(path, JSON.stringify(wb)); };
const manifestOf = async (reviewId: string) => JSON.parse(await readFile(join(dir, "reviews", reviewId, "manifest.json"), "utf8"));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "expense-corrected-retry-"));
  pdfA = join(dir, "a.pdf"); pdfB = join(dir, "b.pdf");
  await writeFile(pdfA, "%PDF-1.4 a"); await writeFile(pdfB, "%PDF-1.4 b");
  importer = new ScriptedImporter();
  service = new ExpenseReviewService({ client: new ReadOnlyClient() as any, importer, directory: join(dir, "reviews"), codec: new JsonCodec() });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ExpenseReviewService: corrected retry", () => {
  const prepare = () => service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [doc("A"), doc("B", { sourcePdfPath: pdfB })] });

  it("re-runs the official import after a pre-write failure, a corrected workbook and a fresh approval of its hash", async () => {
    const out = await prepare();
    const firstHash = (await service.inspect({ reviewId: out.reviewId })).workbookSha256;
    importer.script.push(() => { throw prewriteError(); });
    const failed = await service.importReviewed({ reviewId: out.reviewId, expectedWorkbookSha256: firstHash, approved: true, target: TARGET, databaseId: DB });
    expect(failed).toMatchObject({ ok: false, status: "requiresReview" });

    await edit(out.workbookPath, (wb) => { wb.rows[1].data.text = "Opraveno"; });
    // The previously approved hash no longer matches the corrected file.
    await expect(service.importReviewed({ reviewId: out.reviewId, expectedWorkbookSha256: firstHash, approved: true, target: TARGET, databaseId: DB })).rejects.toThrow(/Workbook changed since inspection/);
    const inspected = await service.inspect({ reviewId: out.reviewId });
    expect(inspected).toMatchObject({ status: "readyForReview", importRowIds: ["A", "B"] });
    expect(inspected.workbookSha256).not.toBe(firstHash);

    importer.script.push((ops) => ({ ok: true, state: "ok", results: ops.map((op: any, i: number) => ({ requestId: op.requestId, ok: true, created: true, id: i + 1 })) }));
    const retried = await service.importReviewed({ reviewId: out.reviewId, expectedWorkbookSha256: inspected.workbookSha256, approved: true, target: TARGET, databaseId: DB });
    expect(retried).toMatchObject({ ok: true, status: "imported", importedRowIds: ["A", "B"] });
    expect(importer.runs).toHaveLength(2);
    expect(importer.runs[1]!.ops.find((op) => op.requestId === "B").header.text).toBe("Opraveno");
    expect(importer.runs[1]!.dataPackId).not.toBe(importer.runs[0]!.dataPackId);
  });

  it("re-runs the official import after an explicit POHODA rejection; the importer skips already-created rows", async () => {
    const out = await prepare();
    importer.script.push(() => ({ ok: false, state: "needs_review", results: [{ requestId: "A", ok: true, created: true, id: 1, doNotRetry: true }, { requestId: "B", ok: false, created: false, outcome: "rejected", doNotRetry: false }] }));
    await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    await edit(out.workbookPath, (wb) => { wb.rows[1].data.text = "Opraveno"; });
    const inspected = await service.inspect({ reviewId: out.reviewId });
    importer.script.push(() => ({ ok: true, state: "ok", results: [{ requestId: "A", ok: true, state: "already_exists", created: false, verified: true, id: 1 }, { requestId: "B", ok: true, state: "ok", created: true, verified: true, id: 2 }] }));
    const retried = await service.importReviewed({ reviewId: out.reviewId, expectedWorkbookSha256: inspected.workbookSha256, approved: true, target: TARGET, databaseId: DB });
    expect(retried).toMatchObject({ ok: true, status: "imported" });
    expect(importer.runs).toHaveLength(2);
  });

  it("keeps the review locked after an uncertain write even with a corrected workbook and fresh approval", async () => {
    const out = await prepare();
    importer.script.push(() => ({ ok: false, state: "write_uncertain", results: [{ requestId: "A", created: "unknown", doNotRetry: true }, { requestId: "B", created: "unknown", doNotRetry: true }] }));
    await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    await edit(out.workbookPath, (wb) => { wb.rows[1].data.text = "Opraveno"; });
    const inspected = await service.inspect({ reviewId: out.reviewId });
    await expect(service.importReviewed({ reviewId: out.reviewId, expectedWorkbookSha256: inspected.workbookSha256, approved: true, target: TARGET, databaseId: DB })).rejects.toThrow(/uncertain result/);
    expect(importer.runs).toHaveLength(1);
  });

  it("does not turn a previously created row into a new document by editing its source identity", async () => {
    const out = await prepare();
    importer.script.push(() => ({ ok: false, state: "needs_review", results: [
      { requestId: "A", created: true, id: 1, ok: true },
      { requestId: "B", created: false, outcome: "rejected", ok: false }
    ] }));
    await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    await edit(out.workbookPath, wb => { wb.rows[0].data.sourceDocumentNumber = "DIFFERENT-DOCUMENT"; });
    const inspected = await service.inspect({ reviewId: out.reviewId });
    expect(inspected.invalid).toEqual(expect.arrayContaining([expect.objectContaining({ rowId: "A", errorCode: "CREATED_ROW_IDENTITY_CHANGED" })]));
    await expect(service.importReviewed({ reviewId: out.reviewId, expectedWorkbookSha256: inspected.workbookSha256, approved: true, target: TARGET, databaseId: DB })).rejects.toThrow(/nelze změnit/);
    expect(importer.runs).toHaveLength(1);
  });

  // PROPOSED: the service records and reports that nothing was written, separately from post-write failures.
  it("records a pre-write failure as rejected_before_write with writeAttempted=false", async () => {
    const out = await prepare();
    importer.script.push(() => { throw prewriteError(); });
    const failed = await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    expect(failed).toMatchObject({ ok: false, status: "requiresReview", state: "rejected_before_write", writeAttempted: false });
    expect(failed.message).toMatch(/Do POHODY se nic nezapsalo/);
    expect((await manifestOf(out.reviewId)).imports.at(-1)).toMatchObject({ ok: false, state: "rejected_before_write", writeAttempted: false });
    expect((await service.inspect({ reviewId: out.reviewId })).previousImports.at(-1)).toMatchObject({ state: "rejected_before_write" });
  });

  // PROPOSED: an unclassified thrown error is conservatively treated as "a write may have been attempted".
  it("does not claim nothing was written for an unclassified importer error", async () => {
    const out = await prepare();
    importer.script.push(() => { throw new Error("transport down"); });
    const failed = await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    expect(failed).toMatchObject({ ok: false, state: "import_failed", writeAttempted: true });
    expect(failed.message).not.toMatch(/Do POHODY se nic nezapsalo/);
  });
});
