import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExpenseImporter, RETRY_SCAN_PAGE_SIZE, classifyImportDetails, retryMarker, retryMarkersIn, withRetryMarker } from "../src/mcp/expense-import.js";
import { PdfArchive } from "../src/pohoda/pdf-archive.js";
import { fixturePages, sha256, writePagedPdf } from "./support/pdf-fixtures.js";

let work: string;
beforeEach(async () => { work = await mkdtemp(path.join(tmpdir(), "expense-import-")); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

/** Real archive in a temporary root that records every stored source. */
function recordingArchive() {
  const real = new PdfArchive({ rootDir: path.join(work, "archive") });
  const calls: string[] = [];
  return { calls, root: real.rootDir, archive: async (source: string, context: any) => { calls.push(source); return real.archive(source, context); } };
}
async function archivedFiles(root: string): Promise<string[]> {
  try { return (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort(); }
  catch { return []; }
}
const linkOf = (doc: any): string => doc.attachments?.shortcut?.target;

const result = (items: any[]) => ({ isOk: () => true, items, toArray: () => ({ state: "ok", items }) });
const docHeader = (doc: any) => doc.invoiceHeader ?? doc.voucherHeader;
const item = (data: any) => ({ state: "ok", data, isOk: () => true });
const base = (extra = {}) => ({ sourceType: "manual", type: "receivedInvoice", taxMode: "taxable", classificationVAT: "PD", vatPeriod: "2026-11", date: "2026-10-23", dateTax: "2026-10-23", sourceDocumentNumber: "SOURCE-1", originalDocument: "SOURCE-1", partnerId: 7, partnerName: "Supplier", text: "Office expenses", priceHigh: "1000.00", priceHighVAT: "210.00", priceHighSum: "1210.00", total: "1210.00", ...extra });

class FakeClient {
  documents: any[] = [];
  writes: any[][] = [];
  alteredVAT = false;
  wrappedVAT = false;
  omitPdfLink = false;
  failOnceSource = "";
  writeIds: string[] = [];
  /** POHODA 14302 behaviour by default: extId list filter ignored, extId not exported. */
  exportExtId = false;
  ignoreIdFrom = false;
  ignoreCount = false;
  importDetails: any = undefined;
  lists: any[] = [];
  contact: any = { addressbookHeader: { id: "7", p1: "true", identity: { address: { company: "Supplier", ico: "25596641", dic: "CZ25596641" } } } };
  getDatabase() { return "12345678_2026.mdb"; }
  async listRecords(agenda: string) {
    if (agenda === "addressbook") return result([item({ addressbook: this.contact ? [this.contact] : [] })]);
    expect(agenda).toBe("numericalSeries");
    return result([item({ numericalSeries: { numericalSeriesHeader: { id: "20", prefix: "PK26", number: "001", topNumber: `PK26${String(Math.max(2, ...this.documents.map((d) => Number(String(docHeader(d).number.numberRequested || "").slice(4)) || 0))).padStart(3, "0")}`, year: "2026", agenda: "ostatni_zavazky" } } })]);
  }
  async listRecordsBatch(requests: any[]) {
    return result(requests.map((request) => {
      if (request.agenda === "addressbook") return item({ addressbook: this.contact ? [this.contact] : [] });
      this.lists.push(structuredClone(request));
      const agendaKey = request.agenda === "voucher" ? "voucher" : "invoice";
      const agendaDocs = this.documents.filter((doc) => agendaKey === "voucher" ? !!doc.voucherHeader : !!doc.invoiceHeader);
      if (request.filter?.id) return item({ [agendaKey]: agendaDocs.filter((doc) => Number(docHeader(doc).id) === request.filter.id).map((doc) => this.exported(doc)) });
      // extId and any other non-ID filter are ignored, as observed live; type is honoured.
      let found = agendaDocs.filter((doc) => !request.subType || docHeader(doc).type === request.subType);
      if (!this.ignoreIdFrom && request.options?.idFrom) found = found.filter((doc) => Number(docHeader(doc).id) >= request.options.idFrom);
      if (!this.ignoreCount && request.options?.count) found = found.slice(0, request.options.count);
      return item({ [agendaKey]: found.map((doc) => this.exported(doc)) });
    }));
  }
  exported(doc: any) {
    const copy = structuredClone(doc);
    if (!this.exportExtId) delete docHeader(copy).extId;
    return copy;
  }
  seed(header: any) {
    const id = this.documents.length + 1;
    this.documents.push({ invoiceHeader: { type: "receivedInvoice", number: { numberRequested: `2611${String(id).padStart(5, "0")}` }, partnerIdentity: { id: 99, address: { company: "Other", ico: "27082440" } }, ...header, id }, invoiceSummary: { homeCurrency: { priceNone: 1 } } });
  }
  async writeBatch(operations: any[], packId = "") {
    this.writes.push(structuredClone(operations));
    this.writeIds.push(packId);
    return result(operations.map((op) => {
      if (op.tool === "manage_address") {
        this.contact ??= { addressbookHeader: { id: "7", identity: { address: { company: op.data.company, ico: op.data.ico, dic: op.data.dic } } } };
        this.contact.addressbookHeader.p1 = "true";
        return item({ producedDetails: { id: "7" } });
      }
      if (this.failOnceSource === op.header.sourceDocumentNumber) { this.failOnceSource = ""; return { state: "error", data: {}, isOk: () => false }; }
      const h = op.header, voucher = op.tool === "create_cash_voucher", id = this.documents.filter((d) => voucher ? !!d.voucherHeader : !!d.invoiceHeader).length + 1;
      const home: any = {};
      for (const key of ["priceNone", "priceLow", "priceLowVAT", "priceLowSum", "priceHigh", "priceHighVAT", "priceHighSum", "price3", "price3VAT", "price3Sum"]) if (h[key] !== undefined) home[key] = h[key];
      if (h.roundingAmount) home.round = { priceRound: h.roundingAmount };
      if (this.alteredVAT) home.priceHighVAT = "210.01";
      if (this.wrappedVAT) home.priceHighVAT = { "#text": home.priceHighVAT, rate: "21" };
      this.documents.push({ [voucher ? "voucherHeader" : "invoiceHeader"]: { ...h, id, number: { numberRequested: h.number }, extId: { ids: h.extId, exSystemName: h.extSystemName }, partnerIdentity: { id: h.partnerId, address: this.contact.addressbookHeader.identity.address }, classificationVAT: { ids: h.classificationVAT }, paymentType: h.paymentType ? { paymentType: h.paymentType } : undefined }, [voucher ? "voucherSummary" : "invoiceSummary"]: { homeCurrency: home }, attachments: !this.omitPdfLink && h.sourcePdfArchivePath ? { shortcut: { target: h.sourcePdfArchivePath } } : undefined });
      return item({ producedDetails: { id: String(id) }, ...(this.importDetails ? { importDetails: this.importDetails } : {}) });
    }));
  }
}

describe("Expense import orchestration", () => {
  it("normalizes a late invoice and verifies the stored result", async () => {
    const client = new FakeClient();
    const importer = new ExpenseImporter(client as any, null);
    const output = await importer.run([{ tool: "create_invoice", header: base(), items: [] }], "test-1", { databaseOverride: client.getDatabase() });
    expect(output.ok).toBe(true);
    expect(client.documents[0].invoiceHeader.dateKHDPH).toBe("2026-11-01");
    expect(client.documents[0].invoiceHeader.dateAccounting).toBe("2026-11-01");
    expect(client.documents[0].invoiceHeader.intNote).toContain("2026-10-23");
  });

  it("rejects inconsistent source totals before any write", async () => {
    const client = new FakeClient();
    await expect(new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base({ total: "1211.00" }), items: [] }], "bad-total", {})).rejects.toThrow();
    expect(client.writes).toHaveLength(0);
  });

  it("reports a changed stored VAT amount without retrying or hiding the created ID", async () => {
    const client = new FakeClient(); client.alteredVAT = true;
    const output = await new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "changed", {});
    expect(output.ok).toBe(false);
    expect(output.results[0]).toMatchObject({ created: true, id: 1, verified: false, doNotRetry: true });
    expect(output.results[0].differences).toContainEqual({ field: "priceHighVAT", expected: expect.anything(), actual: "210.01" });
    expect(client.writes).toHaveLength(1);
  });

  it("finds a previous import by stable external ID instead of creating it twice", async () => {
    const client = new FakeClient(); const importer = new ExpenseImporter(client as any, null);
    const op: any = { tool: "create_invoice", header: base(), items: [] };
    await importer.run([op], "retry", {});
    const output = await importer.run([op], "retry", {});
    expect(output.ok).toBe(true);
    expect(output.results[0].state).toBe("already_exists");
    expect(client.documents).toHaveLength(1);
  });

  it("keeps invoice and voucher IDs in separate agendas when retrying a mixed batch", async () => {
    const client = new FakeClient(); const importer = new ExpenseImporter(client as any, null);
    const ops: any[] = [
      { tool: "create_invoice", header: base({ sourceDocumentNumber: "INV-A" }), items: [] },
      { tool: "create_cash_voucher", header: base({ type: "expense", sourceDocumentNumber: "CASH-A", cashAccount: "HP", datePayment: "2026-10-25" }), items: [] }
    ];
    expect((await importer.run(ops, "mixed-1", {})).ok).toBe(true);
    const second = await importer.run(ops, "mixed-2", {});
    expect(second.ok).toBe(true);
    expect(second.results.map((r: any) => [r.state, Number(r.id)])).toEqual([["already_exists", 1], ["already_exists", 1]]);
    expect(client.documents).toHaveLength(2);
    const cash = client.documents.find((d) => d.voucherHeader)!.voucherHeader;
    expect(cash.originalDocument).toBeUndefined();
    expect(cash.datePayment).toBe("2026-10-25");
    expect(cash.dateAccounting).toBeUndefined();
  });

  it("does not duplicate an existing source document when its extracted amount changes", async () => {
    const client = new FakeClient(); const importer = new ExpenseImporter(client as any, null);
    await importer.run([{ tool: "create_invoice", header: base(), items: [] }], "original", {});
    const output = await importer.run([{ tool: "create_invoice", header: base({ priceHigh: "2000", priceHighVAT: "420", priceHighSum: "2420", total: "2420" }), items: [] }], "corrected", {});
    expect(output.ok).toBe(false);
    expect(output.results[0]).toMatchObject({ state: "already_exists", created: false, id: 1, verified: false });
    expect(client.documents).toHaveLength(1);
  });

  it("rejects the same source twice in one batch before writing", async () => {
    const client = new FakeClient(); const importer = new ExpenseImporter(client as any, null);
    const op: any = { tool: "create_invoice", header: base(), items: [] };
    await expect(importer.run([op, op], "duplicate-batch", {})).rejects.toThrow(/Duplicate source document/);
    expect(client.writes).toHaveLength(0);
  });

  it("retries only failed cards without skipping their number or reusing a changed pack ID", async () => {
    const client = new FakeClient(); client.failOnceSource = "B";
    const importer = new ExpenseImporter(client as any, null);
    const cards: any[] = ["A", "B"].map((sourceDocumentNumber) => ({ tool: "create_other_liability", header: base({ type: "commitment", cardPayment: true, sourceDocumentNumber }), items: [] }));
    const first = await importer.run(cards, "partial", {});
    expect(first.ok).toBe(false);
    const second = await importer.run(cards, "partial", {});
    expect(second.ok).toBe(true);
    expect(client.documents.map((d) => d.invoiceHeader.number.numberRequested)).toEqual(["PK26003", "PK26004"]);
    expect(client.writeIds[0]).not.toBe(client.writeIds[1]);
  });

  it("accepts exported VAT amounts with rate attributes", async () => {
    const client = new FakeClient(); client.wrappedVAT = true;
    const output = await new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "wrapped", {});
    expect(output.ok).toBe(true);
  });

  it("uses the same source identity whether the supplier is given by ID or IČO", async () => {
    const client = new FakeClient(); const importer = new ExpenseImporter(client as any, null);
    await importer.run([{ tool: "create_invoice", header: base(), items: [] }], "by-id", {});
    const output = await importer.run([{ tool: "create_invoice", header: base({ partnerId: 0, partnerIco: "25 596 641" }), items: [] }], "by-ico", {});
    expect(output.ok).toBe(true);
    expect(client.documents).toHaveLength(1);
  });

  it("merges an explicit contact operation after supplier identifier normalization", async () => {
    const client = new FakeClient();
    const output = await new ExpenseImporter(client as any, null).run([
      { tool: "create_address", data: { company: "Supplier", ico: "25 596 641", email: "a@example.test" } },
      { tool: "create_invoice", header: base(), items: [] }
    ], "merged-contact", {});
    expect(output.ok).toBe(true);
    expect(output.results[0].state).toBe("supplier_resolved");
    expect(client.writes.flat().filter((op) => op.tool === "create_address")).toHaveLength(0);
    expect(client.documents).toHaveLength(1);
  });

  it("does not use current payer status to guess treatment of a document without VAT", async () => {
    const client = new FakeClient();
    const registry: any = {
      getByIco: async () => ({ value: { ico: "25596641", obchodniJmeno: "Supplier", dic: "CZ25596641", sidlo: { kodStatu: "CZ" }, seznamRegistraci: { stavZdrojeDph: "AKTIVNI" } }, fetchedAt: "2026-11-14T12:00:00Z" }),
      vatStatus: async () => ({ value: [{ dic: "25596641", typSubjektu: "PLATCE_DPH", nespolehlivyPlatce: "NE" }], fetchedAt: "2026-11-14T12:00:00Z" })
    };
    await expect(new ExpenseImporter(client as any, registry).run([{ tool: "create_invoice", header: base({ taxMode: "auto", partnerCountry: "CZ", partnerIco: "25596641", sourceChargesVat: false, priceHigh: undefined, priceHighVAT: undefined, priceHighSum: undefined, priceNone: 100, total: 100 }), items: [] }], "tax-review", {})).rejects.toThrow(/VAT treatment requires review/);
    expect(client.writes).toHaveLength(0);
  });

  it("requires the original PDF for PDF imports before any accounting write", async () => {
    const client = new FakeClient();
    await expect(new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base({ sourceType: "pdf" }), items: [] }], "missing-pdf", {})).rejects.toThrow(/sourcePdfPath/);
    expect(client.writes).toHaveLength(0);
  });

  it("links each document of a multi-document PDF to a PDF with only its own pages and keeps the original", async () => {
    const client = new FakeClient();
    const source = path.join(work, "in", "batch.pdf");
    const original = await writePagedPdf(source, 5, "batch");
    const archive = recordingArchive();
    const importer = new ExpenseImporter(client as any, null, archive);
    const docs = [[1], [2, 4, 3], [5]];
    const output = await importer.run(docs.map((pages, i) => ({ tool: "create_invoice" as const, header: base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: pages, sourceDocumentNumber: `DOC-${i}` }), items: [] })), "with-pdf", {});
    expect(output.ok).toBe(true);
    const links = client.documents.map(linkOf);
    expect(new Set(links).size).toBe(3);
    expect(await Promise.all(links.map(fixturePages))).toEqual([[1], [2, 3, 4], [5]]);
    expect(output.results.map((row: any) => row.pdf.pageRanges)).toEqual(["1", "2-4", "5"]);
    expect(output.results.every((row: any) => row.differences.length === 0 && row.pdf.source.sha256 === sha256(original))).toBe(true);
    // The original is archived exactly once, byte-identical, beside the three subsets; the source is untouched.
    const originalPath = output.results[0].pdf.source.path;
    expect(archive.calls.filter((call) => call === source)).toHaveLength(1);
    expect((await readFile(originalPath)).equals(original)).toBe(true);
    expect((await readFile(source)).equals(original)).toBe(true);
    expect(links).not.toContain(originalPath);
    expect(await archivedFiles(archive.root)).toEqual([originalPath, ...links].sort());
  });

  it("links the original itself when a document covers every page", async () => {
    const client = new FakeClient();
    const source = path.join(work, "in", "single.pdf");
    const original = await writePagedPdf(source, 2, "single");
    const archive = recordingArchive();
    const output = await new ExpenseImporter(client as any, null, archive).run([{ tool: "create_invoice", header: base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: [2, 1] }), items: [] }], "whole", {});
    expect(output.ok).toBe(true);
    expect(output.results[0].pdf).toMatchObject({ wholeSource: true, pages: [1, 2], sha256: sha256(original) });
    expect(linkOf(client.documents[0])).toBe(output.results[0].pdf.source.path);
    expect(await archivedFiles(archive.root)).toEqual([output.results[0].pdf.source.path]);
  });

  it("stops before any archive or POHODA write when a document's pages exceed the source", async () => {
    const client = new FakeClient();
    const source = path.join(work, "in", "short.pdf");
    await writePagedPdf(source, 3);
    const archive = recordingArchive();
    await expect(new ExpenseImporter(client as any, null, archive).run([
      { tool: "create_invoice", header: base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: [1], sourceDocumentNumber: "OK-1" }), items: [] },
      { tool: "create_invoice", header: base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: [3, 4], sourceDocumentNumber: "BAD-2" }), items: [] }
    ], "out-of-range", {})).rejects.toMatchObject({ code: "PAGES_OUT_OF_RANGE", message: expect.stringMatching(/sourcePages 4 .*3 pages/) });
    expect(archive.calls).toEqual([]);
    expect(await archivedFiles(archive.root)).toEqual([]);
    expect(client.writes).toHaveLength(0);
  });

  it("rejects an unreadable PDF before any archive or POHODA write", async () => {
    const client = new FakeClient();
    const source = path.join(work, "broken.pdf");
    await import("node:fs/promises").then((fs) => fs.writeFile(source, "%PDF-1.7\nnot really a pdf"));
    const archive = recordingArchive();
    await expect(new ExpenseImporter(client as any, null, archive).run([{ tool: "create_invoice", header: base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: [1] }), items: [] }], "broken", {}))
      .rejects.toMatchObject({ code: "SOURCE_UNREADABLE" });
    expect(archive.calls).toEqual([]);
    expect(client.writes).toHaveLength(0);
  });

  it("reports a created document as incomplete when its PDF link was not stored", async () => {
    const client = new FakeClient(); client.omitPdfLink = true;
    const source = path.join(work, "a.pdf"); await writePagedPdf(source, 2);
    const output = await new ExpenseImporter(client as any, null, recordingArchive()).run([{ tool: "create_invoice", header: base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: [1] }), items: [] }], "missing-link", {});
    expect(output.results[0]).toMatchObject({ created: true, verified: false, doNotRetry: true });
    expect(output.results[0].differences.some((diff: any) => diff.field === "sourcePdfAttachment")).toBe(true);
  });

  it("does not create accounting records when copying the PDF fails", async () => {
    const client = new FakeClient();
    const source = path.join(work, "a.pdf"); await writePagedPdf(source, 2);
    const archive = { archive: async () => { throw new Error("disk full"); } };
    await expect(new ExpenseImporter(client as any, null, archive).run([{ tool: "create_invoice", header: base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: [1] }), items: [] }], "copy-fail", {})).rejects.toThrow("disk full");
    expect(client.writes).toHaveLength(0);
  });

  it("continues K and variable symbols across a larger card purchase", async () => {
    const client = new FakeClient();
    const headers = [
      base({ type: "commitment", cardPayment: true, sourceDocumentNumber: "a" }),
      base({ type: "commitment", cardPayment: true, sourceDocumentNumber: "b", originalDocument: "BIG-1", symVar: "991", priceHigh: "10000", priceHighVAT: "2100", priceHighSum: "12100", total: "12100" }),
      base({ type: "commitment", cardPayment: true, sourceDocumentNumber: "c" })
    ];
    const output = await new ExpenseImporter(client as any, null).run(headers.map((header) => ({ tool: "create_other_liability", header, items: [] })), "cards", {});
    expect(output.ok).toBe(true);
    expect(client.documents.map((d) => [d.invoiceHeader.number.numberRequested, d.invoiceHeader.originalDocument, d.invoiceHeader.symVar])).toEqual([
      ["PK26003", "K3", "3"], ["PK26004", "b", "991"], ["PK26005", "K5", "5"]
    ]);
  });

  it("marks an existing contact as supplier without overwriting its identity", async () => {
    const client = new FakeClient(); client.contact.addressbookHeader.p1 = "false";
    const output = await new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "supplier", {});
    expect(output.ok).toBe(true);
    expect(client.writes[0]).toEqual([{ tool: "manage_address", action: "update", match: { id: 7 }, data: { p1: true } }]);
  });

  it("keeps PDF identity stable when supplier IČO becomes known later", async () => {
    const client = new FakeClient();
    delete client.contact.addressbookHeader.identity.address.ico;
    const source = path.join(work, "a.pdf"); await writePagedPdf(source, 3);
    const importer = new ExpenseImporter(client as any, null, recordingArchive());
    const header = base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: [2, 1, 2], taxMode: "nonTax", classificationVAT: "", sourceDocumentNumber: "", originalDocument: "", partnerDic: "CZ25596641" });
    const first = await importer.run([{ tool: "create_invoice", header, items: [] }], "no-ico", {});
    expect(first.ok).toBe(true);
    expect(client.documents[0].invoiceSummary.homeCurrency).toEqual({ priceNone: 1210 });
    expect(client.documents[0].invoiceHeader.dateKHDPH).toBeUndefined();
    client.contact.addressbookHeader.identity.address.ico = "25596641";
    const second = await importer.run([{ tool: "create_invoice", header: { ...header, sourcePages: [1, 2] }, items: [] }], "ico-known", {});
    expect(second.ok).toBe(true);
    expect(second.results[0].state).toBe("already_exists");
    expect(client.documents).toHaveLength(1);
  });

  it("coalesces new supplier plans that share a DIČ before creating contacts", async () => {
    const client = new FakeClient(); client.contact = null;
    const importer = new ExpenseImporter(client as any, null);
    const output = await importer.run([
      { tool: "create_invoice", header: base({ partnerId: 0, partnerDic: "CZ25596641", sourceDocumentNumber: "A" }), items: [] },
      { tool: "create_invoice", header: base({ partnerId: 0, partnerDic: "CZ25596641", partnerIco: "25596641", sourceDocumentNumber: "B" }), items: [] }
    ], "merged-plans", {});
    expect(output.ok).toBe(true);
    const contacts = client.writes.flat().filter((op) => op.tool === "manage_address");
    expect(contacts).toHaveLength(1);
    expect(contacts[0].data).toMatchObject({ ico: "25596641", dic: "CZ25596641", p1: true });
    expect(client.documents).toHaveLength(2);
  });

  it("rejects explicit contact identifier conflicts instead of dropping the contact", async () => {
    const client = new FakeClient();
    await expect(new ExpenseImporter(client as any, null).run([
      { tool: "create_address", data: { company: "Other supplier", ico: "27082440", dic: "CZ25596641" } },
      { tool: "create_invoice", header: base({ partnerId: 0, partnerIco: "25596641", partnerDic: "CZ25596641" }), items: [] }
    ], "conflict", {})).rejects.toThrow(/Conflicting IČO/);
    expect(client.writes).toHaveLength(0);
  });

  it("merges an IČO-only and DIČ-only plan when a later row connects them", async () => {
    const client = new FakeClient(); client.contact = null;
    const output = await new ExpenseImporter(client as any, null).run([
      { tool: "create_invoice", header: base({ partnerId: 0, partnerIco: "25596641", sourceDocumentNumber: "A" }), items: [] },
      { tool: "create_invoice", header: base({ partnerId: 0, partnerDic: "CZ25596641", sourceDocumentNumber: "B" }), items: [] },
      { tool: "create_invoice", header: base({ partnerId: 0, partnerIco: "25596641", partnerDic: "CZ25596641", sourceDocumentNumber: "C" }), items: [] }
    ], "bridged-plans", {});
    expect(output.ok).toBe(true);
    expect(client.writes.flat().filter((op) => op.tool === "manage_address")).toHaveLength(1);
    expect(client.documents).toHaveLength(3);
  });

  it("requires page identity before a PDF can be archived or imported", async () => {
    const client = new FakeClient(); let copies = 0;
    const archive = { archive: async () => { copies++; throw new Error("must not archive"); } };
    await expect(new ExpenseImporter(client as any, null, archive).run([
      { tool: "create_invoice", header: base({ sourceType: "pdf", sourcePdfPath: "/input/a.pdf", sourcePages: [] }), items: [] }
    ], "missing-pages", {})).rejects.toThrow(/sourcePages/);
    expect(copies).toBe(0);
    expect(client.writes).toHaveLength(0);
  });

  describe("retry identity without trusted extId filters", () => {
    const markerOf = (output: any) => output.results.find((row: any) => row.retryMarker)?.retryMarker as string;

    it("writes a marker into intNote, preserves provenance and never sends extId list filters", async () => {
      const client = new FakeClient(); const importer = new ExpenseImporter(client as any, null);
      const output = await importer.run([{ tool: "create_invoice", header: base({ intNote: "Uživatel: kontrola" }), items: [] }], "marker", {});
      expect(output.ok).toBe(true);
      const note: string = client.documents[0].invoiceHeader.intNote;
      const lines = note.split("\n");
      expect(lines[0]).toBe("Uživatel: kontrola");
      expect(lines.some((line) => line.includes("2026-10-23"))).toBe(true);
      expect(lines.at(-1)).toBe(markerOf(output));
      expect(markerOf(output)).toMatch(/^MCP-ID:pohoda-mcp-expenses\|[0-9a-f]{32}$/);
      expect(output.results[0].differences).toEqual([]);
      expect(client.lists.some((request) => request.filter?.extId)).toBe(false);
    });

    it("does not duplicate on a same-source retry when POHODA ignores extId filters and does not export extId", async () => {
      const client = new FakeClient(); const importer = new ExpenseImporter(client as any, null);
      client.seed({ originalDocument: "OTHER", intNote: "manual" });
      const op: any = { tool: "create_invoice", header: base(), items: [] };
      await importer.run([op], "retry-a", {});
      const second = await importer.run([op], "retry-b", {});
      expect(second.ok).toBe(true);
      expect(second.results[0]).toMatchObject({ state: "already_exists", created: false, matchedBy: "retryMarker", id: 2, verified: true });
      expect(client.documents).toHaveLength(2);
      expect(client.writes.filter((batch) => batch.some((op: any) => op.tool === "create_invoice"))).toHaveLength(1);
    });

    it("does not duplicate a retried PDF import identified only by file hash and pages", async () => {
      const client = new FakeClient();
      const source = path.join(work, "in", "scan.pdf"), renamed = path.join(work, "elsewhere", "renamed.pdf");
      await writePagedPdf(source, 4, "scan");
      await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(renamed), { recursive: true }));
      await copyFile(source, renamed);
      const archive = recordingArchive();
      const importer = new ExpenseImporter(client as any, null, archive);
      const header = base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: [3, 2], sourceDocumentNumber: "", originalDocument: "", taxMode: "nonTax", classificationVAT: "" });
      const first = await importer.run([{ tool: "create_invoice", header, items: [] }], "pdf-1", {});
      const stored = await archivedFiles(archive.root);
      const second = await importer.run([{ tool: "create_invoice", header: { ...header, sourcePdfPath: renamed }, items: [] }], "pdf-2", {});
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.results[0]).toMatchObject({ state: "already_exists", matchedBy: "retryMarker", retryMarker: markerOf(first), verified: true, differences: [] });
      // Same original hash + pages: same marker, same deterministic subset, nothing new archived.
      expect(second.results[0].pdf.path).toBe(first.results[0].pdf.path);
      expect(await fixturePages(second.results[0].pdf.path)).toEqual([2, 3]);
      expect(await archivedFiles(archive.root)).toEqual(stored);
      expect(client.documents).toHaveLength(1);
    });

    it("recognizes an earlier import that linked the whole source PDF without creating a duplicate", async () => {
      const client = new FakeClient();
      const source = path.join(work, "legacy.pdf");
      await writePagedPdf(source, 3, "legacy");
      const importer = new ExpenseImporter(client as any, null, recordingArchive());
      const header = base({ sourceType: "pdf", sourcePdfPath: source, sourcePages: [2] });
      const first = await importer.run([{ tool: "create_invoice", header, items: [] }], "legacy-1", {});
      // Imports before per-document PDFs stored the same marker but linked the whole original.
      client.documents[0].attachments.shortcut.target = first.results[0].pdf.source.path;
      const second = await importer.run([{ tool: "create_invoice", header, items: [] }], "legacy-2", {});
      expect(client.documents).toHaveLength(1);
      expect(second.results[0]).toMatchObject({ state: "already_exists", created: false, verified: true, ok: false, differences: [], doNotRetry: true,
        reviewRequired: [{ code: "PDF_LINK_FULL_SOURCE", documentPdf: first.results[0].pdf.path, linked: [first.results[0].pdf.source.path] }] });
      expect(second.state).toBe("needs_review");
    });

    it("ignores unrelated records with near-miss markers, foreign systems or other suppliers", async () => {
      const probe = new FakeClient();
      const marker = markerOf(await new ExpenseImporter(probe as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "probe", {}));
      const [system, extId] = marker.slice("MCP-ID:".length).split("|") as [string, string];
      const client = new FakeClient(); client.exportExtId = true;
      client.seed({ intNote: `${marker}0` });
      client.seed({ intNote: `MCP-ID:${system}|${extId.slice(0, 31)}` });
      client.seed({ intNote: `XMCP-ID:${system}|${extId}` });
      client.seed({ intNote: `MCP-ID:other-system|${extId}` });
      client.seed({ extId: { ids: extId, exSystemName: "other-system" } });
      client.seed({ type: "commitment", intNote: marker.replace(/.$/, "0") });
      client.seed({ originalDocument: "SOURCE-1", intNote: "same number, different supplier" });
      const output = await new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "unrelated", {});
      expect(output.ok).toBe(true);
      expect(output.results[0]).toMatchObject({ created: true, id: 8 });
      expect(client.documents).toHaveLength(8);
    });

    it("pages past the count limit instead of treating a truncated page as absence", async () => {
      const client = new FakeClient(); const importer = new ExpenseImporter(client as any, null);
      for (let i = 0; i < RETRY_SCAN_PAGE_SIZE * 2 + 10; i++) client.seed({ intNote: `unrelated ${i}` });
      const op: any = { tool: "create_invoice", header: base(), items: [] };
      await importer.run([op], "paged-1", {});
      client.lists = [];
      const second = await importer.run([op], "paged-2", {});
      expect(second.results[0]).toMatchObject({ state: "already_exists", id: RETRY_SCAN_PAGE_SIZE * 2 + 11 });
      expect(client.lists.filter((request) => !request.filter?.id && request.agenda === "invoice").map((request) => request.options.idFrom ?? 0)).toEqual([0, RETRY_SCAN_PAGE_SIZE + 1, RETRY_SCAN_PAGE_SIZE * 2 + 1]);
      expect(client.documents).toHaveLength(RETRY_SCAN_PAGE_SIZE * 2 + 11);
    });

    it("still finds the marker when the count limit is ignored", async () => {
      const client = new FakeClient(); client.ignoreCount = true; const importer = new ExpenseImporter(client as any, null);
      for (let i = 0; i < RETRY_SCAN_PAGE_SIZE + 5; i++) client.seed({ intNote: `unrelated ${i}` });
      const op: any = { tool: "create_invoice", header: base(), items: [] };
      await importer.run([op], "nocount-1", {});
      const second = await importer.run([op], "nocount-2", {});
      expect(second.results[0].state).toBe("already_exists");
      expect(client.documents).toHaveLength(RETRY_SCAN_PAGE_SIZE + 6);
    });

    it("fails closed before any write when POHODA ignores idFrom paging", async () => {
      const client = new FakeClient(); client.ignoreIdFrom = true;
      for (let i = 0; i < RETRY_SCAN_PAGE_SIZE + 5; i++) client.seed({ intNote: `unrelated ${i}` });
      await expect(new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "noidfrom", {})).rejects.toThrow(/cannot prove/);
      expect(client.writes).toHaveLength(0);
    });

    it("uses an exported extId as an additional hint when the marker line was removed", async () => {
      const client = new FakeClient(); client.exportExtId = true; const importer = new ExpenseImporter(client as any, null);
      const op: any = { tool: "create_invoice", header: base(), items: [] };
      await importer.run([op], "hint-1", {});
      client.documents[0].invoiceHeader.intNote = "edited by user";
      const second = await importer.run([op], "hint-2", {});
      expect(second.results[0]).toMatchObject({ state: "already_exists", matchedBy: "extId", verified: false });
      expect(second.results[0].differences.map((d: any) => d.field)).toContain("retryMarker");
      expect(client.documents).toHaveLength(1);
    });

    it("finds a manually entered document by supplier and source number without a marker", async () => {
      const client = new FakeClient();
      client.seed({ originalDocument: "SOURCE-1", partnerIdentity: { id: 7, address: { company: "Supplier", ico: "25596641" } }, intNote: "entered by hand" });
      const output = await new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "manual", {});
      expect(output.results[0]).toMatchObject({ state: "already_exists", matchedBy: "sourceDocument", id: 1, ok: false });
      expect(client.documents).toHaveLength(1);
    });

    it("rejects two POHODA records carrying the same marker before any write", async () => {
      const probe = new FakeClient();
      const marker = markerOf(await new ExpenseImporter(probe as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "probe", {}));
      const client = new FakeClient();
      client.seed({ intNote: marker }); client.seed({ intNote: `note\n${marker}` });
      await expect(new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "twice", {})).rejects.toThrow(/Several POHODA records/);
      expect(client.writes).toHaveLength(0);
    });

    it("rejects a copied foreign marker in the source intNote", async () => {
      const client = new FakeClient();
      await expect(new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base({ intNote: `copied\nMCP-ID:pohoda-mcp-expenses|${"e".repeat(32)}` }), items: [] }], "foreign", {})).rejects.toThrow(/different MCP retry marker/);
      expect(client.writes).toHaveLength(0);
    });

    it("keeps VAT differences visible on a marker-matched retry", async () => {
      const client = new FakeClient(); client.alteredVAT = true; const importer = new ExpenseImporter(client as any, null);
      const op: any = { tool: "create_invoice", header: base(), items: [] };
      await importer.run([op], "vat-1", {});
      const second = await importer.run([op], "vat-2", {});
      expect(second.results[0]).toMatchObject({ state: "already_exists", matchedBy: "retryMarker", verified: false });
      expect(second.results[0].differences).toContainEqual({ field: "priceHighVAT", expected: expect.anything(), actual: "210.01" });
      expect(client.documents).toHaveLength(1);
    });

    it("keeps created card numbers on retry and gives only the failed card the next free series number", async () => {
      const client = new FakeClient(); client.failOnceSource = "B";
      const importer = new ExpenseImporter(client as any, null);
      const cards: any[] = ["A", "B", "C"].map((sourceDocumentNumber) => ({ tool: "create_other_liability", header: base({ type: "commitment", cardPayment: true, sourceDocumentNumber }), items: [] }));
      const first = await importer.run(cards, "cards-partial", {});
      expect(first.results.map((r: any) => r.created)).toEqual([true, false, true]);
      const second = await importer.run(cards, "cards-partial", {});
      expect(second.ok).toBe(true);
      expect(second.results.map((r: any) => r.state)).toEqual(["already_exists", "ok", "already_exists"]);
      expect(client.documents.map((d) => d.invoiceHeader.number.numberRequested)).toEqual(["PK26003", "PK26005", "PK26006"]);
      expect(client.writes.flat().filter((op: any) => op.tool === "create_other_liability").map((op: any) => op.header.sourceDocumentNumber)).toEqual(["A", "B", "C", "B"]);
    });
  });

  describe("POHODA import adjustments", () => {
    const rateWarning = { state: "warning", errno: "603", note: "Zmena kurzu CM", XPath: "typ:rate", valueProduced: "1" };
    const accountingDefault = { state: "warning", errno: "603", note: "Hodnota prvku musela být upravena.", XPath: "/dat:dataPack/dat:dataPackItem[1]/inv:invoice[1]/inv:invoiceHeader[1]/inv:accounting", valueProduced: "1Fp" };

    it("treats an exchange-rate 603 as needs_review while retaining the created ID", async () => {
      const client = new FakeClient(); client.importDetails = { detail: [accountingDefault, rateWarning] };
      const output = await new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "rate", {});
      expect(output).toMatchObject({ ok: false, state: "needs_review" });
      expect(output.results[0]).toMatchObject({ created: true, id: 1, verified: true, ok: false, doNotRetry: true });
      expect(output.results[0].reviewRequired).toEqual([expect.objectContaining({ code: "FX_RATE_ADJUSTED", xpath: "typ:rate", valueProduced: "1" })]);
    });

    it("keeps default accounting/payment 603 warnings informational", async () => {
      const client = new FakeClient(); client.importDetails = { detail: accountingDefault };
      const output = await new ExpenseImporter(client as any, null).run([{ tool: "create_invoice", header: base(), items: [] }], "defaults", {});
      expect(output.ok).toBe(true);
      expect(output.results[0].importWarnings).toEqual([expect.objectContaining({ errno: "603", valueProduced: "1Fp" })]);
      expect(output.results[0].reviewRequired).toBeUndefined();
    });

    it("classifies rate adjustments by XPath or note only", () => {
      expect(classifyImportDetails({ importDetails: { detail: { ...rateWarning, XPath: "/dat:dataPack/inv:invoiceSummary[1]/inv:foreignCurrency[1]/typ:rate[1]", note: "x" } } }).review).toHaveLength(1);
      expect(classifyImportDetails({ importDetails: { detail: { ...accountingDefault, XPath: "/x/inv:paymentType" } } }).review).toHaveLength(0);
      expect(classifyImportDetails({ importDetails: { detail: { state: "warning", errno: "631", note: "Nenalezený soubor", XPath: "/x/inv:attachments[1]/typ:shortcut[1]/typ:target" } } }).review[0].code).toBe("PDF_LINK_TARGET_MISSING");
    });
  });

  describe("retry markers", () => {
    it("parses only complete markers and appends exactly one", () => {
      const marker = retryMarker("pohoda-mcp-expenses", "a".repeat(32));
      expect(retryMarkersIn(`x ${marker}\r\n${marker}b MCP-ID:sys|${"a".repeat(65)}`)).toEqual([marker, `${marker}b`]);
      expect(withRetryMarker(`keep\r\n${marker}\n\nZdroj: x`, marker)).toBe(`keep\nZdroj: x\n${marker}`);
      expect(() => retryMarker("bad system", "id")).toThrow(/extId and extSystemName/);
    });
  });
});
