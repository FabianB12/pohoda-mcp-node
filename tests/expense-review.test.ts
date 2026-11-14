import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExpenseReviewService, type ReviewWorkbookCodec } from "../src/mcp/expense-review.js";
import type { ReviewWorkbook, ReviewWorkbookRead } from "../src/mcp/review-contract.js";

const TARGET = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const DB = "demo-unit";
const ok = (items: any[]) => ({ isOk: () => true, items, toArray: () => ({ state: "ok", items }) });
const item = (data: any) => ({ state: "ok", data, isOk: () => true });

/** JSON-backed stand-in for the XLSX codec; edits go through the same read/write contract. */
class FakeCodec implements ReviewWorkbookCodec {
  constructor(private readonly events: string[]) {}
  written: ReviewWorkbook[] = [];
  async writeReviewWorkbook(input: ReviewWorkbook, filePath: string) {
    this.events.push("writeWorkbook");
    this.written.push(structuredClone(input));
    await writeFile(filePath, JSON.stringify(input));
  }
  async updateReviewDuplicateChecks(filePath: string, checks: Record<string, any>) {
    const workbook = JSON.parse(await readFile(filePath, "utf8"));
    for (const row of workbook.rows) {
      row.duplicateCheck = checks[row.rowId];
      if (row.action === "import" && row.duplicateCheck?.status !== "clear") row.action = "review";
    }
    await writeFile(filePath, JSON.stringify(workbook));
  }
  async readReviewWorkbook(filePath: string): Promise<ReviewWorkbookRead> {
    const { reviewId, databaseId, vatPeriod, rows } = JSON.parse(await readFile(filePath, "utf8"));
    return { reviewId, databaseId, vatPeriod, rows };
  }
}

class FakeClient {
  calls: any[] = [];
  writes = 0;
  history: any[] = [];
  constructor(private readonly events: string[]) {}
  async listRecordsBatch(requests: any[], _pack: string, options: any) {
    this.events.push("list");
    this.calls.push({ requests, options });
    return ok(requests.map((r) => {
      const key = r.agenda === "voucher" ? "voucher" : "invoice";
      let records = this.history.filter((h) => key === "voucher" ? !!h.voucherHeader : !!h.invoiceHeader && h.invoiceHeader.invoiceType === r.subType);
      if (r.filter.ico) records = records.filter((h) => (h.invoiceHeader ?? h.voucherHeader).partnerIdentity.address.ico === r.filter.ico);
      if (r.options?.idFrom) records = records.filter((h) => Number((h.invoiceHeader ?? h.voucherHeader).id) >= r.options.idFrom);
      return item({ [key]: records.slice(0, r.options?.count ?? records.length) });
    }));
  }
  async writeBatch() { this.writes++; throw new Error("no writes allowed in tests"); }
}

class FakeImporter {
  runs: Array<{ ops: any[]; dataPackId: string; target: any }> = [];
  next: any = (ops: any[]) => ({ ok: true, state: "ok", results: ops.map((op, i) => ({ requestId: op.requestId, ok: true, id: i + 1, created: true })) });
  async run(ops: any[], dataPackId: string, target: any) {
    this.runs.push({ ops: structuredClone(ops), dataPackId, target });
    return typeof this.next === "function" ? this.next(ops) : this.next;
  }
}

const historyInvoice = (id: number, extra: any = {}) => ({ invoiceHeader: { id: String(id), invoiceType: "receivedInvoice", number: { numberRequested: `FP26${id}` }, date: `2026-0${id}-10`, dateTax: `2026-0${id}-10`, originalDocument: `OLD-${id}`, text: "Materiál", accounting: { ids: "501/321" }, classificationVAT: { ids: "PD" }, paymentType: { paymentType: "draft" }, partnerIdentity: { id: "7", address: { company: "Supplier s.r.o.", ico: "25596641" } }, ...extra }, invoiceSummary: { homeCurrency: { priceHigh: "100", priceHighVAT: "21" } } });

let dir: string, pdfA: string, pdfB: string, events: string[], codec: FakeCodec, client: FakeClient, importer: FakeImporter, service: ExpenseReviewService;

const doc = ({ requestId, ...extra }: any = {}) => ({ ...(requestId ? { requestId } : {}), tool: "create_invoice" as const, data: { type: "receivedInvoice", taxMode: "taxable", classificationVAT: "PD", sourcePdfPath: pdfA, sourcePages: [1], sourceIssueDate: "2026-10-20", sourceTaxDate: "2026-10-20", sourceDocumentNumber: "FV-1", partnerIco: "25596641", partnerName: "Supplier s.r.o.", text: "Materiál", priceHigh: "1000.00", priceHighVAT: "210.00", total: "1210.00", intNote: "Zdroj: scan p.1", ...extra } });

async function edit(path: string, mutate: (wb: any) => void) {
  const wb = JSON.parse(await readFile(path, "utf8"));
  mutate(wb);
  await writeFile(path, JSON.stringify(wb));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "expense-review-"));
  pdfA = join(dir, "a.pdf"); pdfB = join(dir, "b.pdf");
  await writeFile(pdfA, "%PDF-1.4 a"); await writeFile(pdfB, "%PDF-1.4 b");
  events = []; codec = new FakeCodec(events); client = new FakeClient(events); importer = new FakeImporter();
  service = new ExpenseReviewService({ client: client as any, importer, directory: join(dir, "reviews"), codec });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ExpenseReviewService.prepare", () => {
  it("lists similar documents on the explicit unit before writing the workbook and never writes to POHODA", async () => {
    client.history = [historyInvoice(3), historyInvoice(4)];
    const out = await service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [doc({ requestId: "A", accounting: undefined }), { ...doc({ sourceDocumentNumber: "FV-2", sourcePdfPath: pdfB }), requestId: "B" }] });
    expect(events).toEqual(["list", "writeWorkbook"]);
    expect(importer.runs).toHaveLength(0);
    expect(client.writes).toBe(0);
    // One batched snapshot for duplicates and history, on the explicit unit.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].options).toEqual(TARGET);
    expect(client.calls[0].requests).toEqual([
      { agenda: "invoice", subType: "receivedInvoice", filter: {}, options: { count: 2000 } },
      { agenda: "invoice", subType: "commitment", filter: {}, options: { count: 2000 } },
      { agenda: "voucher", subType: "", filter: {}, options: { count: 2000 } }
    ]);
    expect(out.status).toBe("readyForReview");
    expect(out.reviewId).toMatch(/^rv-[0-9a-f]{16}$/);
    const wb = codec.written[0]!;
    expect(wb.examples.map((e) => e.id)).toEqual(["4", "3"]);
    expect(wb.examples[0]).toMatchObject({ number: "FP264", text: "Materiál", accounting: "501/321", classificationVAT: "PD", paymentType: "draft", total: 121, rowIds: "A, B" });
    expect(wb.rows[0]).toMatchObject({ rowId: "A", action: "import", data: { accounting: "501/321", total: "1210.00", vatPeriod: "2026-11", sourceType: "pdf" } });
    expect(wb.rows[0]!.reviewNotes).toBe("");
    const manifest = JSON.parse(await readFile(join(dir, "reviews", out.reviewId, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ databaseId: DB, target: TARGET, vatPeriod: "2026-11", sourcePdfPaths: [pdfA, pdfB], imports: [] });
    expect(manifest.sources.A.suggestions).toEqual([{ field: "accounting", value: "501/321", fromIds: ["4", "3"], rule: "unanimous same-supplier POHODA history" }]);
  });

  it("does not invent history, keeps source amounts, and marks incomplete drafts for review instead of refusing", async () => {
    client.history = [historyInvoice(3, { originalDocument: "FV-1" })];
    const out = await service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [
      doc({ requestId: "dup" }),
      { tool: "create_invoice", requestId: "nohist", data: { type: "receivedInvoice", taxMode: "taxable", classificationVAT: "PD", sourcePdfPath: pdfB, sourcePages: [1], partnerIco: "27082440", text: "x".repeat(80), sourceIssueDate: "2026-11-02", sourceTaxDate: "2026-11-02", sourceDocumentNumber: "Z1", priceHigh: "100", priceHighVAT: "21", total: "999" } }
    ] });
    expect(out.status).toBe("requiresReview");
    const [dup, nohist] = codec.written[0]!.rows;
    expect(dup!.action).toBe("review");
    expect(dup!.reviewNotes).toContain("Duplicita: FP263 (#3)");
    expect(nohist!.action).toBe("review");
    expect(nohist!.data.total).toBe("999");
    expect(nohist!.reviewNotes).toContain("stačí krátký popis do 60 znaků");
    expect(nohist!.reviewNotes).toMatch(/Součet .* neodpovídá částce Celkem|Celkem je/);
    expect(codec.written[0]!.examples.every((e) => e.rowIds.includes("dup"))).toBe(true);
    expect(importer.runs).toHaveLength(0);
  });

  it("requires an explicit target database and ICO", async () => {
    await expect(service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: { databaseOverride: TARGET.databaseOverride }, documents: [doc()] })).rejects.toThrow(/explicit target/);
    expect(events).toEqual([]);
  });

  it("enriches a Czech non-payer before preview and shares one lookup across supplier rows", async () => {
    let lookups = 0;
    const enriched = new ExpenseReviewService({ client: client as any, importer, directory: join(dir, "registry-reviews"), codec,
      lookupSupplier: async () => {
        lookups++;
        return { status: "matched", fetchedAt: "2026-11-14T12:00:00Z", supplier: { name: "Supplier s.r.o.", ico: "25596641", dic: "CZ25596641", country: "CZ" }, vat: { status: "registry-non-payer", formerVatRegistration: false, unreliablePayer: false } };
      }
    });
    const source = { taxMode: "auto", classificationVAT: "", sourceChargesVat: false, partnerCountry: "CZ", priceHigh: undefined, priceHighVAT: undefined, priceNone: 121, total: 121 };
    const out = await enriched.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [doc({ ...source, requestId: "A" }), doc({ ...source, requestId: "B", sourcePdfPath: pdfB, sourceDocumentNumber: "OTHER" })] });
    expect(lookups).toBe(1);
    expect(out.status).toBe("readyForReview");
    expect(codec.written[0]!.rows[0]!.data).toMatchObject({ partnerDic: "CZ25596641", partnerVatStatus: "non-payer" });
    expect(out.rows[0].preview.planned.classificationVAT).toBe("PN");
    expect(importer.runs).toHaveLength(0);
    await edit(out.workbookPath, (wb) => { wb.rows[0].data.partnerIco = "27082440"; });
    await expect(enriched.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB })).rejects.toMatchObject({ details: { invalid: [expect.objectContaining({ errorCode: expect.stringMatching(/VAT_STATUS|TAX_MODE/) })] } });
    expect(importer.runs).toHaveLength(0);
  });

  it("previews card liabilities without inventing the final PK number and separates source facts from planned dates", async () => {
    const out = await service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [{ tool: "create_other_liability", data: { taxMode: "taxable", classificationVAT: "PD", cardPayment: true, sourcePdfPath: pdfA, sourcePages: [1], partnerIco: "25596641", text: "Materiál", sourceIssueDate: "2026-10-05", sourceTaxDate: "2026-10-05", priceHigh: "100", priceHighVAT: "21", total: "121" } }] });
    const preview = out.rows[0].preview;
    expect(preview.sourceFacts).toMatchObject({ sourceIssueDate: "2026-10-05", sourceTaxDate: "2026-10-05", total: "121" });
    expect(preview.planned).toMatchObject({ date: "2026-11-01", dateKHDPH: "2026-11-01", lateSource: true, originalDocument: "assigned from the next PK number at import", symVar: "assigned from the next PK number at import" });
    expect(JSON.stringify(out)).not.toMatch(/"K1"/);
  });

  it("keeps an existing (possibly edited) workbook when the same review is prepared again", async () => {
    const first = await service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [doc()] });
    await edit(first.workbookPath, (wb) => { wb.rows[0].data.text = "Edited"; });
    const again = await service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [doc()] });
    expect(again).toMatchObject({ reused: true, reviewId: first.reviewId });
    expect(codec.written).toHaveLength(1);
    expect((await codec.readReviewWorkbook(first.workbookPath)).rows[0]!.data.text).toBe("Edited");
  });
});

describe("ExpenseReviewService inspect/import", () => {
  const prepareTwo = () => service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [doc({ requestId: "A" }), { ...doc({ sourceDocumentNumber: "FV-2", sourcePdfPath: pdfB }), requestId: "B" }] });

  it("inspect re-reads the edited workbook without any write", async () => {
    const out = await prepareTwo();
    await edit(out.workbookPath, (wb) => { wb.rows[0].data.text = "Kancelářské potřeby"; wb.rows[1].action = "skip"; });
    const callsBefore = client.calls.length;
    const view = await service.inspect({ reviewId: out.reviewId });
    expect(view).toMatchObject({ status: "readyForReview", importRowIds: ["A"], skippedRowIds: ["B"] });
    expect(view.rows[0].changedFields).toEqual(["text"]);
    expect(client.calls.length).toBe(callsBefore);
    expect(importer.runs).toHaveLength(0);
  });

  it("requires approved exactly true", async () => {
    const out = await prepareTwo();
    for (const approved of [false, "true", 1, undefined] as any[]) {
      await expect(service.importReviewed({ reviewId: out.reviewId, approved, target: TARGET, databaseId: DB })).rejects.toThrow(/approved=true/);
    }
    expect(importer.runs).toHaveLength(0);
  });

  it("binds the import to the prepared unit and ICO", async () => {
    const out = await prepareTwo();
    await expect(service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: "other-unit" })).rejects.toThrow(/belongs to databaseId/);
    await expect(service.importReviewed({ reviewId: out.reviewId, approved: true, target: { ...TARGET, dataPackIco: "87654321" }, databaseId: DB })).rejects.toThrow(/differs from the prepared review/);
    await expect(service.importReviewed({ reviewId: out.reviewId, approved: true, target: { ...TARGET, databaseOverride: "other.mdb" }, databaseId: DB })).rejects.toThrow(/differs/);
    expect(importer.runs).toHaveLength(0);
    await service.importReviewed({ reviewId: out.reviewId, approved: true, target: { ...TARGET, timeoutSeconds: 5 }, databaseId: DB });
    expect(importer.runs[0]!.target).toEqual(TARGET);
  });

  it("imports the user's edited total and text, excludes review columns and protected edits, keeps original intNote", async () => {
    const out = await prepareTwo();
    await edit(out.workbookPath, (wb) => {
      const a = wb.rows[0];
      Object.assign(a.data, { text: "Materiál na opravu", priceHigh: "2000.00", priceHighVAT: "420.00", total: "2420.00", extId: "hijack", intNote: "edited note", sourceType: "manual" });
      a.reviewNotes = "REVIEWER-ONLY note";
      wb.rows[1].action = "skip";
    });
    const res = await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    expect(res).toMatchObject({ ok: true, status: "imported", importedRowIds: ["A"], skippedRowIds: ["B"] });
    const [op] = importer.runs[0]!.ops;
    expect(importer.runs[0]!.ops).toHaveLength(1);
    expect(op).toMatchObject({ requestId: "A", tool: "create_invoice", items: [], header: { text: "Materiál na opravu", total: "2420.00", priceHigh: "2000.00", intNote: "Zdroj: scan p.1", sourceType: "pdf", sourcePdfPath: pdfA, sourcePages: [1], vatPeriod: "2026-11" } });
    expect(op.header.extId).toBeUndefined();
    expect(JSON.stringify(importer.runs[0]!.ops)).not.toContain("REVIEWER-ONLY");
    expect(op.header).not.toHaveProperty("reviewNotes");
    expect(op.header).not.toHaveProperty("action");
    expect(importer.runs[0]!.dataPackId).toBe(`${out.reviewId}-${res.workbookSha256.slice(0, 12)}`);
    // Current POHODA state is re-read on the stored unit before the importer runs.
    expect(client.calls.at(-1)!.options).toEqual(TARGET);
  });

  it("rejects unknown, duplicate and foreign-PDF rows; allows deleted and reordered rows", async () => {
    const out = await prepareTwo();
    const original = await readFile(out.workbookPath, "utf8");
    const attempt = async (mutate: (wb: any) => void) => {
      await writeFile(out.workbookPath, original);
      await edit(out.workbookPath, mutate);
      return service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    };
    await expect(attempt((wb) => { wb.rows.push({ ...wb.rows[0], rowId: "NEW" }); })).rejects.toThrow(/NEW is not part of this review/);
    await expect(attempt((wb) => { wb.rows.push(structuredClone(wb.rows[0])); })).rejects.toThrow(/appears more than once/);
    await expect(attempt((wb) => { wb.rows[0].data.sourcePdfPath = join(dir, "other.pdf"); })).rejects.toThrow(/not one of the prepared source PDFs/);
    await expect(attempt((wb) => { wb.vatPeriod = "2026-12"; })).rejects.toThrow(/vatPeriod/);
    await expect(attempt((wb) => { wb.rows[0].tool = "create_cash_voucher"; })).rejects.toThrow(/changed document kind/);
    expect(importer.runs).toHaveLength(0);
    const res = await attempt((wb) => { wb.rows = [wb.rows[1]]; wb.rows[0].data.sourcePdfPath = pdfA; });
    expect(res.omittedRowIds).toEqual(["A"]);
    expect(importer.runs[0]!.ops.map((op) => [op.requestId, op.header.sourcePdfPath])).toEqual([["B", pdfA]]);
  });

  it("fails before any import while a non-skipped row is still marked review", async () => {
    const out = await service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [doc({ requestId: "A" }), { ...doc({ sourceDocumentNumber: "FV-2", sourcePdfPath: pdfB, total: "1" }), requestId: "B" }] });
    await expect(service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB })).rejects.toThrow(/Rows still marked review: B/);
    expect((await service.inspect({ reviewId: out.reviewId })).status).toBe("requiresReview");
    await edit(out.workbookPath, (wb) => { wb.rows[1].action = "skip"; });
    await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    expect(importer.runs[0]!.ops.map((op) => op.requestId)).toEqual(["A"]);
  });

  it("preflights every edited row so malformed values stop the whole batch", async () => {
    const out = await prepareTwo();
    await edit(out.workbookPath, (wb) => { wb.rows[1].data.total = "1300.00"; });
    await expect(service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB })).rejects.toMatchObject({ message: expect.stringMatching(/B: Součet/), details: { invalid: expect.arrayContaining([expect.objectContaining({ rowId: "B", errorCode: "SUMMARY_MISMATCH" })]) } });
    await edit(out.workbookPath, (wb) => { wb.rows[1].data.total = "1210.00"; wb.rows[0].data.text = "y".repeat(241); });
    await expect(service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB })).rejects.toMatchObject({ message: expect.stringMatching(/A: Text dokladu má \d+ znaků/), details: { invalid: expect.arrayContaining([expect.objectContaining({ rowId: "A", errorCode: "TEXT_TOO_LONG" })]) } });
    expect(importer.runs).toHaveLength(0);
  });

  it("blocks blind retries after an uncertain write, including a changed workbook", async () => {
    const out = await prepareTwo();
    importer.next = { ok: false, state: "write_uncertain", results: [{ requestId: "A", created: "unknown", doNotRetry: true, extId: "pending-source" }] };
    await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    await edit(out.workbookPath, (wb) => { wb.rows[0].data.text = "Changed"; });
    await expect(service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB })).rejects.toThrow(/uncertain result/);
    expect(importer.runs).toHaveLength(1);
  });

  it("does not pass unreviewed XML fragments or caller external IDs through the manifest", async () => {
    const out = await service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [doc({ extraHeader: { "inv:text": "Hidden override" }, extId: "caller-id", number: "hidden-number" })] });
    await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    const header = importer.runs[0]!.ops[0].header;
    for (const key of ["extraHeader", "extId", "number"]) expect(header[key]).toBeUndefined();
    expect(codec.written[0]!.rows[0]!.reviewNotes).toContain("Pole extraHeader není součástí kontroly a bylo ignorováno.");
  });

  it("returns the recorded result for an identical successful rerun and retries failed imports", async () => {
    const out = await prepareTwo();
    const first = await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    const second = await service.importReviewed({ reviewId: out.reviewId, approved: true, target: TARGET, databaseId: DB });
    expect(importer.runs).toHaveLength(1);
    expect(second).toMatchObject({ ok: true, status: "imported", repeated: true, dataPackId: first.dataPackId, result: first.result });
    expect((await service.inspect({ reviewId: out.reviewId })).status).toBe("imported");

    const failing = await service.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [doc({ requestId: "C", sourceDocumentNumber: "FV-9" })] });
    importer.next = { ok: false, state: "needs_review", results: [{ requestId: "C", ok: false, created: false, doNotRetry: false }] };
    expect(await service.importReviewed({ reviewId: failing.reviewId, approved: true, target: TARGET, databaseId: DB })).toMatchObject({ ok: false, status: "requiresReview" });
    importer.next = () => { throw new Error("transport down"); };
    expect(await service.importReviewed({ reviewId: failing.reviewId, approved: true, target: TARGET, databaseId: DB })).toMatchObject({ ok: false, error: "transport down" });
    importer.next = { ok: true, state: "ok", results: [{ requestId: "C", ok: true, state: "already_exists" }] };
    expect(await service.importReviewed({ reviewId: failing.reviewId, approved: true, target: TARGET, databaseId: DB })).toMatchObject({ ok: true, status: "imported" });
    const runs = importer.runs.slice(1);
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((r) => r.dataPackId)).size).toBe(1);
    const manifest = JSON.parse(await readFile(join(dir, "reviews", failing.reviewId, "manifest.json"), "utf8"));
    expect(manifest.imports.map((i: any) => [i.ok, i.state])).toEqual([[false, "needs_review"], [false, "import_failed"], [true, "ok"]]);
    expect(manifest.imports[2]).toMatchObject({ rowIds: ["C"], workbookSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("rejects malformed review IDs without touching the filesystem outside the review root", async () => {
    await expect(service.inspect({ reviewId: "../etc" })).rejects.toThrow(/Invalid reviewId/);
  });
});
