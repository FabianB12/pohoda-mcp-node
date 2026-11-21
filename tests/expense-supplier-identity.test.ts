import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExpenseImporter } from "../src/mcp/expense-import.js";
import { ExpenseReviewService, type ReviewWorkbookCodec } from "../src/mcp/expense-review.js";
import type { ReviewWorkbook, ReviewWorkbookRead } from "../src/mcp/review-contract.js";
import { readAddressBook, resolveSupplier, SupplierIdentityError } from "../src/mcp/supplier-identity.js";

/**
 * Incident: a preview showed "ID adresy v POHODĚ" 64 next to supplier Aleš Chvojka while
 * ID 64 is MANUTAN (also 174 Vavroušková vs Lišková, 234 Klimeš vs MND). The IDs came
 * from the agent, prepare never checked them, and the import stopped with a generic
 * "Two address-book IDs match the same supplier". These tests pin the fixed contract.
 */

const TARGET = { databaseOverride: "12345678_2026.mdb", dataPackIco: "12345678" };
const OTHER = { databaseOverride: "87654321_2026.mdb", dataPackIco: "87654321" };
const DB = "demo-unit";
const ok = (items: any[]) => ({ isOk: () => items.every((i) => i.isOk()), items, toArray: () => ({ state: "ok", items }) });
const item = (data: any) => ({ state: "ok", data, isOk: () => true });
const contact = (id: number, company: string, ico = "", dic = "", p1 = true) => ({ addressbookHeader: { id: String(id), p1: String(p1), identity: { address: { company, ...(ico ? { ico } : {}), ...(dic ? { dic } : {}) } } } });
const docHeader = (doc: any) => doc.invoiceHeader ?? doc.voucherHeader;

// Valid-checksum IČOs.
const CHVOJKA = "12345601", MANUTAN = "12424790", LISKOVA = "12503983", VAVROUSKOVA = "12583171", MND = "12662364", KLIMES = "12741558", SUPPLIER = "25596641";

/** POHODA stand-in per database: address book with real filters, invoices, writes. */
class PohodaFake {
  books = new Map<string, any[]>([[TARGET.databaseOverride, []], [OTHER.databaseOverride, []]]);
  documents: any[] = [];
  calls: Array<{ requests: any[]; options: any }> = [];
  writes: any[][] = [];
  /** Simulates a filter POHODA ignores: returns the whole agenda (the helper must re-check). */
  ignoreAddressFilters = false;
  getDatabase() { return TARGET.databaseOverride; }
  book(options: any) { return this.books.get(options?.databaseOverride || TARGET.databaseOverride) ?? []; }
  async listRecords() { throw new Error("unexpected listRecords"); }
  async listRecordsBatch(requests: any[], _pack: string, options: any) {
    this.calls.push({ requests: structuredClone(requests), options });
    return ok(requests.map((r) => {
      if (r.agenda === "addressbook") {
        const all = this.book(options);
        const f = r.filter ?? {};
        const rows = this.ignoreAddressFilters ? all : all.filter((c) => {
          const h = c.addressbookHeader, a = h.identity.address;
          if (f.id) return Number(h.id) === Number(f.id);
          if (f.ico) return a.ico === f.ico;
          if (f.dic) return a.dic === f.dic;
          if (f.company) return String(a.company ?? "").toLowerCase().includes(String(f.company).toLowerCase());
          return true;
        });
        return item({ addressbook: rows.slice(0, r.options?.count ?? rows.length) });
      }
      const key = r.agenda === "voucher" ? "voucher" : "invoice";
      let docs = this.documents.filter((d) => key === "voucher" ? !!d.voucherHeader : !!d.invoiceHeader);
      if (r.filter?.id) return item({ [key]: docs.filter((d) => Number(docHeader(d).id) === r.filter.id) });
      if (r.subType) docs = docs.filter((d) => docHeader(d).type === r.subType || docHeader(d).invoiceType === r.subType);
      if (r.options?.idFrom) docs = docs.filter((d) => Number(docHeader(d).id) >= r.options.idFrom);
      return item({ [key]: docs.slice(0, r.options?.count ?? docs.length) });
    }));
  }
  async writeBatch(operations: any[], packId: string) {
    this.writes.push(structuredClone(operations));
    return ok(operations.map((op) => {
      if (op.tool === "manage_address") throw new Error("test does not expect contact writes");
      const h = op.header, id = this.documents.length + 1;
      const c = this.book(TARGET).find((x) => Number(x.addressbookHeader.id) === Number(h.partnerId));
      const home: any = {};
      for (const k of ["priceNone", "priceLow", "priceLowVAT", "priceLowSum", "priceHigh", "priceHighVAT", "priceHighSum", "price3", "price3VAT", "price3Sum"]) if (h[k] !== undefined) home[k] = h[k];
      this.documents.push({ invoiceHeader: { ...h, id, number: { numberRequested: h.number }, partnerIdentity: { id: h.partnerId, address: c?.addressbookHeader.identity.address ?? {} }, classificationVAT: { ids: h.classificationVAT } }, invoiceSummary: { homeCurrency: home } });
      return item({ producedDetails: { id: String(id) } });
    }).map((response, index) => ({ ...response, id: `${packId}-${index + 1}` })));
  }
  addressCalls() { return this.calls.filter((c) => c.requests.some((r) => r.agenda === "addressbook")); }
}

class JsonCodec implements ReviewWorkbookCodec {
  written: ReviewWorkbook[] = [];
  async writeReviewWorkbook(input: ReviewWorkbook, filePath: string) { this.written.push(structuredClone(input)); await writeFile(filePath, JSON.stringify(input)); }
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

const source = (rowId: string, extra: any = {}) => ({ requestId: rowId, tool: "create_invoice" as const, data: {
  type: "receivedInvoice", sourceType: "manual", taxMode: "taxable", classificationVAT: "PD", sourceIssueDate: "2026-11-03", sourceTaxDate: "2026-11-03",
  sourceDocumentNumber: `FV-${rowId}`, text: "Materiál", priceHigh: "1000.00", priceHighVAT: "210.00", total: "1210.00", ...extra } });

let dir: string, client: PohodaFake, codec: JsonCodec;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "supplier-identity-"));
  client = new PohodaFake(); codec = new JsonCodec();
  client.books.set(TARGET.databaseOverride, [
    contact(64, "MANUTAN s.r.o.", MANUTAN, `CZ${MANUTAN}`),
    contact(174, "Jana Vavroušková", VAVROUSKOVA),
    contact(234, "Petr Klimeš", KLIMES),
    contact(12, "Aleš Chvojka", CHVOJKA),
    contact(300, "Eva Lišková", LISKOVA),
    contact(7, "Supplier s.r.o.", SUPPLIER, `CZ${SUPPLIER}`)
  ]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const service = (importer: any = new ExpenseImporter(client as any, null)) => new ExpenseReviewService({ client: client as any, importer, directory: join(dir, "reviews"), codec });
const rowsOf = async (path: string) => JSON.parse(await readFile(path, "utf8")).rows as any[];
const edit = async (path: string, mutate: (rows: any[]) => void) => { const wb = JSON.parse(await readFile(path, "utf8")); mutate(wb.rows); await writeFile(path, JSON.stringify(wb)); };
const approve = async (svc: ExpenseReviewService, reviewId: string) => {
  const inspected = await svc.inspect({ reviewId });
  return { inspected, result: await svc.importReviewed({ reviewId, approved: true, expectedWorkbookSha256: inspected.workbookSha256, databaseId: DB, target: TARGET }) };
};

describe("supplier identity resolution (pure)", () => {
  const book = async (facts: any[], options = {}) => readAddressBook(client as any, facts, TARGET, options);

  it("verifies a claimed ID only by IČO/DIČ or exact name of the same record", async () => {
    const facts = [
      { partnerId: 12, partnerIco: CHVOJKA, partnerName: "Ales Chvojka" },
      { partnerId: 12, partnerName: "Aleš Chvojka" },
      { partnerId: 64, partnerIco: CHVOJKA, partnerName: "Aleš Chvojka" },
      { partnerId: 64, partnerName: "Aleš Chvojka" },
      { partnerId: 999, partnerIco: CHVOJKA },
      { partnerId: 64 }
    ];
    const b = await book(facts);
    const r = facts.map((f) => resolveSupplier(f, b));
    expect(r.map((x) => [x.status, x.via ?? null, x.record?.id ?? null])).toEqual([
      ["verified", "ico", 12], ["verified", "name", 12], ["idConflict", null, 64], ["idConflict", null, 64], ["idNotFound", null, null], ["idUnverifiable", null, 64]
    ]);
    expect(r[2]!.message).toContain("ID adresy 64 patří jinému subjektu (ID 64 MANUTAN s.r.o.");
    expect(r[2]!.alternative).toMatchObject({ status: "resolved", via: "ico", record: { id: 12 } });
    expect(r[4]!.alternative).toMatchObject({ status: "resolved", record: { id: 12 } });
  });

  it("rejects an ID whose record lacks the IČO when another record has it", async () => {
    client.books.get(TARGET.databaseOverride)!.push(contact(80, "Aleš Chvojka", ""));
    const b = await book([{ partnerId: 80, partnerIco: CHVOJKA, partnerName: "Aleš Chvojka" }]);
    const r = resolveSupplier({ partnerId: 80, partnerIco: CHVOJKA, partnerName: "Aleš Chvojka" }, b);
    expect(r.status).toBe("idConflict");
    expect(r.message).toContain(`IČO ${CHVOJKA} má adresa ID 12 Aleš Chvojka`);
  });

  it("re-checks filter results locally and scopes IČO by country", async () => {
    client.ignoreAddressFilters = true;
    client.books.get(TARGET.databaseOverride)!.push({ addressbookHeader: { id: "90", p1: "true", identity: { address: { company: "Slovak Co", ico: CHVOJKA, country: { ids: "SK" } } } } });
    const b = await book([{ partnerIco: CHVOJKA }, { partnerIco: CHVOJKA, partnerCountry: "SK" }]);
    expect(resolveSupplier({ partnerIco: CHVOJKA }, b)).toMatchObject({ status: "resolved", record: { id: 12 } });
    expect(resolveSupplier({ partnerIco: CHVOJKA, partnerCountry: "SK" }, b)).toMatchObject({ status: "resolved", record: { id: 90 } });
  });

  it("never picks between genuine duplicate contacts, even with a matching claimed ID", async () => {
    client.books.get(TARGET.databaseOverride)!.push(contact(301, "Eva Lišková", LISKOVA));
    const b = await book([{ partnerId: 300, partnerIco: LISKOVA }]);
    for (const facts of [{ partnerIco: LISKOVA }, { partnerId: 300, partnerIco: LISKOVA }]) {
      const r = resolveSupplier(facts, b);
      expect(r.status).toBe("duplicate");
      expect(r.candidates.map((c) => c.id)).toEqual([300, 301]);
      expect(r.message).toContain("import mezi nimi nevybírá");
    }
  });

  it("reports IČO and DIČ that point to different records", async () => {
    const facts = { partnerIco: CHVOJKA, partnerDic: `CZ${MANUTAN}` };
    expect(resolveSupplier(facts, await book([facts])).status).toBe("identifierConflict");
  });

  it("fails closed when an identifier lookup hits its bound", async () => {
    client.ignoreAddressFilters = true;
    client.books.set(TARGET.databaseOverride, Array.from({ length: 120 }, (_, i) => contact(1000 + i, `Firma ${i}`)));
    const facts = { partnerIco: CHVOJKA };
    expect(resolveSupplier(facts, await book([facts])).status).toBe("incomplete");
  });
});

describe("prepare: caller address-book IDs are claims, verified in one batched read", () => {
  it("reproduces the incident: mixed wrong IDs are never shown as valid; rows explain and use the document supplier", async () => {
    const svc = service();
    const out = await svc.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [
      source("R001", { partnerId: 64, partnerName: "Aleš Chvojka", partnerIco: CHVOJKA }),
      source("R002", { partnerId: 174, partnerName: "Eva Lišková", partnerIco: LISKOVA }),
      source("R003", { partnerId: 234, partnerName: "MND a.s." }),
      source("R004", { partnerId: 7, partnerName: "Supplier s.r.o.", partnerIco: SUPPLIER }),
      source("R005", { partnerName: "Aleš Chvojka", partnerIco: CHVOJKA }),
      source("R006", { partnerName: "MND a.s.", partnerIco: MND })
    ] });
    // One batched read of distinct ID/IČO/name filters, on the explicit unit.
    expect(client.addressCalls()).toHaveLength(1);
    expect(client.addressCalls()[0]!.options).toEqual(TARGET);
    const rows = codec.written[0]!.rows;
    const byId = Object.fromEntries(rows.map((r) => [r.rowId, r]));
    expect(rows.map((r) => [r.rowId, r.data.partnerId ?? null, r.action])).toEqual([
      ["R001", 12, "review"], ["R002", 300, "review"], ["R003", null, "review"], ["R004", 7, "import"], ["R005", 12, "import"], ["R006", null, "import"]
    ]);
    expect(byId.R001!.reviewNotes).toContain("ID adresy 64 patří jinému subjektu (ID 64 MANUTAN s.r.o.");
    expect(byId.R001!.reviewNotes).toContain("Podle IČO z dokladu je dodavatel v adresáři POHODY jako ID 12 Aleš Chvojka");
    expect(byId.R002!.reviewNotes).toContain("ID adresy 174 patří jinému subjektu (ID 174 Jana Vavroušková");
    expect(byId.R003!.reviewNotes).toContain("ID adresy 234 patří jinému subjektu (ID 234 Petr Klimeš");
    // MND (no IČO, not in the book): the wrong ID is dropped, nothing invented.
    expect(byId.R003!.reviewNotes).toContain("nemá IČO ani DIČ");
    expect(byId.R006!.reviewNotes).toBe("");
    const manifest = JSON.parse(await readFile(out.manifestPath, "utf8"));
    const codes = Object.fromEntries(manifest.rows.map((r: any) => [r.rowId, r.issues.map((i: any) => i.code)]));
    expect(codes.R001).toContain("SUPPLIER_ID_CONFLICT");
    expect(codes.R003).toEqual(expect.arrayContaining(["SUPPLIER_ID_CONFLICT", "SUPPLIER_IDENTIFIER_REQUIRED"]));
    expect(manifest.sources.R001.supplier).toMatchObject({ code: "SUPPLIER_ID_CONFLICT", claimedId: 64, record: { id: 64, company: "MANUTAN s.r.o." }, resolvedByFacts: { id: 12, via: "ico" } });
    expect(manifest.rows[0].data).toMatchObject({ partnerId: 12, _claimedPartnerId: 64, _partnerIdSource: { via: "ico", claimedId: 64 } });
    expect(client.writes).toHaveLength(0);
  });

  it("verifies against the selected unit only: an ID valid in another client is a conflict here", async () => {
    client.books.set(OTHER.databaseOverride, [contact(64, "Aleš Chvojka", CHVOJKA)]);
    await service().prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [source("A", { partnerId: 64, partnerName: "Aleš Chvojka", partnerIco: CHVOJKA })] });
    expect(client.addressCalls().every((c) => c.options.databaseOverride === TARGET.databaseOverride)).toBe(true);
    const [row] = codec.written[0]!.rows;
    expect(row!.data.partnerId).toBe(12);
    expect(row!.action).toBe("review");
    expect(row!.reviewNotes).toContain("MANUTAN");
  });

  it("marks genuine duplicate contacts for review without choosing one", async () => {
    client.books.get(TARGET.databaseOverride)!.push(contact(301, "Eva Lišková", LISKOVA));
    await service().prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [source("A", { partnerName: "Eva Lišková", partnerIco: LISKOVA })] });
    const [row] = codec.written[0]!.rows;
    expect(row!.data.partnerId).toBeUndefined();
    expect(row!.action).toBe("review");
    expect(row!.reviewNotes).toContain("ID 300 Eva Lišková");
    expect(row!.reviewNotes).toContain("ID 301 Eva Lišková");
  });
});

describe("reviewed workbook: the ID is read-only and follows the edited supplier", () => {
  it("drops a stale ID when the supplier is edited, keeps edited amounts, and resolves the new supplier at import", async () => {
    const svc = service();
    const out = await svc.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [source("A", { partnerName: "Aleš Chvojka", partnerIco: CHVOJKA }), source("B", { partnerName: "Supplier s.r.o.", partnerIco: SUPPLIER })] });
    expect((await rowsOf(out.workbookPath)).map((r) => r.data.partnerId)).toEqual([12, 7]);
    await edit(out.workbookPath, (rows) => {
      // Reviewer corrects the supplier from the PDF; the old ID 12 stays in its cell.
      Object.assign(rows[0].data, { partnerName: "MANUTAN s.r.o.", partnerIco: MANUTAN });
      rows[0].targets = { ...rows[0].targets, targetPriceHigh: 2000, targetPriceHighVAT: 420, targetTotal: 2420 };
      rows[1].action = "skip";
    });
    const { inspected, result } = await approve(svc, out.reviewId);
    expect(inspected.rows[0]).toMatchObject({ valid: true, supplier: { partnerId: null, staleId: 12 } });
    expect(inspected.rows[0].changedFields).toEqual(expect.arrayContaining(["partnerName", "partnerIco", "partnerId"]));
    expect(result).toMatchObject({ ok: true, importedRowIds: ["A"], skippedRowIds: ["B"] });
    const written = client.writes.flat();
    expect(written).toHaveLength(1);
    expect(written[0].header).toMatchObject({ partnerId: 64, partnerIco: MANUTAN, priceHigh: 2000, priceHighVAT: 420, total: 2420 });
  });

  it("rejects a typed ID and lets a cleared ID re-resolve from IČO", async () => {
    const svc = service();
    const out = await svc.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [source("A", { partnerName: "Aleš Chvojka", partnerIco: CHVOJKA })] });
    await edit(out.workbookPath, (rows) => { rows[0].data.partnerId = 64; });
    const typed = await svc.inspect({ reviewId: out.reviewId });
    expect(typed.invalid).toEqual([expect.objectContaining({ rowId: "A", errorCode: "SUPPLIER_ID_EDIT" })]);
    expect(typed.invalid[0].error).toContain("se nezadává ručně");
    await expect(svc.importReviewed({ reviewId: out.reviewId, approved: true, databaseId: DB, target: TARGET })).rejects.toThrow(/fail validation/);
    expect(client.writes).toHaveLength(0);
    await edit(out.workbookPath, (rows) => { rows[0].data.partnerId = null; });
    const { inspected, result } = await approve(svc, out.reviewId);
    expect(inspected.rows[0].supplier).toEqual({ partnerId: null });
    expect(result.ok).toBe(true);
    expect(client.writes.flat()[0].header.partnerId).toBe(12);
  });
});

describe("import: every supplier is validated before any write", () => {
  it("returns row-level Czech evidence for all conflicting rows and writes nothing (legacy unverified IDs)", async () => {
    const svc = service();
    const out = await svc.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [
      source("R001", { partnerName: "Aleš Chvojka", partnerIco: CHVOJKA }),
      source("R002", { partnerName: "Eva Lišková", partnerIco: LISKOVA }),
      source("R003", { partnerName: "Supplier s.r.o.", partnerIco: SUPPLIER })
    ] });
    // A review prepared before this fix stored the agent's IDs unverified in the manifest.
    const manifestPath = out.manifestPath;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.rows[0].data.partnerId = 64; manifest.rows[1].data.partnerId = 174;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await edit(out.workbookPath, (rows) => { rows[0].data.partnerId = 64; rows[1].data.partnerId = 174; rows[2].targets = { ...rows[2].targets, targetPriceHigh: 500, targetPriceHighVAT: 105, targetTotal: 605 }; });
    const before = await readFile(out.workbookPath);
    const { result } = await approve(svc, out.reviewId);
    expect(result).toMatchObject({ ok: false, status: "requiresReview", writeAttempted: false });
    expect(result.supplierIssues.map((i: any) => [i.rowId, i.code])).toEqual([["R001", "SUPPLIER_ID_CONFLICT"], ["R002", "SUPPLIER_ID_CONFLICT"]]);
    expect(result.supplierIssues[0]).toMatchObject({ claimedId: 64, record: { id: 64, company: "MANUTAN s.r.o." }, resolvedByFacts: { id: 12 } });
    expect(result.error).toContain("R002: ID adresy 174 patří jinému subjektu");
    expect(client.writes).toHaveLength(0);
    // The reviewed workbook (edited amounts, IDs) is untouched; the failure is recorded.
    expect(await readFile(out.workbookPath)).toEqual(before);
    const saved = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(saved.imports.at(-1)).toMatchObject({ ok: false, state: "rejected_before_write", writeAttempted: false });

    // Correction: clear the wrong IDs; the import links by IČO and keeps the edited amounts.
    await edit(out.workbookPath, (rows) => { rows[0].data.partnerId = null; rows[1].data.partnerId = null; });
    const retry = await approve(svc, out.reviewId);
    expect(retry.result.ok).toBe(true);
    const headers = client.writes.flat().map((op) => op.header);
    expect(headers.map((h) => [h.sourceDocumentNumber, h.partnerId])).toEqual([["FV-R001", 12], ["FV-R002", 300], ["FV-R003", 7]]);
    expect(headers[2]).toMatchObject({ priceHigh: 500, priceHighVAT: 105, total: 605 });
  });

  it("stops on a duplicate contact created after preview, with zero writes and both candidates", async () => {
    const svc = service();
    const out = await svc.prepare({ databaseId: DB, vatPeriod: "2026-11", target: TARGET, documents: [source("A", { partnerName: "Eva Lišková", partnerIco: LISKOVA })] });
    client.books.get(TARGET.databaseOverride)!.push(contact(301, "Eva Lišková", LISKOVA));
    await edit(out.workbookPath, (rows) => { rows[0].action = "import"; });
    const { result } = await approve(svc, out.reviewId);
    expect(result.ok).toBe(false);
    expect(result.supplierIssues[0]).toMatchObject({ rowId: "A", code: "SUPPLIER_DUPLICATE_CONTACTS", candidates: [{ id: 300 }, { id: 301 }] });
    expect(client.writes).toHaveLength(0);
  });

  it("importer: replaces the generic two-ID error with evidence for each row", async () => {
    const importer = new ExpenseImporter(client as any, null);
    const header = (extra: any) => ({ sourceType: "manual", type: "receivedInvoice", taxMode: "taxable", classificationVAT: "PD", vatPeriod: "2026-11", date: "2026-11-03", dateTax: "2026-11-03", text: "Materiál", priceHigh: "1000.00", priceHighVAT: "210.00", priceHighSum: "1210.00", total: "1210.00", ...extra });
    const error: any = await importer.run([
      { requestId: "A", tool: "create_invoice", header: header({ sourceDocumentNumber: "A", originalDocument: "A", partnerId: 12, partnerName: "Aleš Chvojka", partnerIco: CHVOJKA }), items: [] },
      { requestId: "B", tool: "create_invoice", header: header({ sourceDocumentNumber: "B", originalDocument: "B", partnerId: 64, partnerName: "Aleš Chvojka", partnerIco: CHVOJKA }), items: [] },
      { requestId: "C", tool: "create_invoice", header: header({ sourceDocumentNumber: "C", originalDocument: "C", partnerId: 64, partnerName: "Aleš Chvojka" }), items: [] }
    ], "two-ids", TARGET).catch((e) => e);
    expect(error).toBeInstanceOf(SupplierIdentityError);
    expect(error.writeAttempted).toBe(false);
    // Without the fix, row C (no IČO) would have been linked to MANUTAN silently.
    expect(error.issues.map((i: any) => [i.rowId, i.code])).toEqual([["B", "SUPPLIER_ID_CONFLICT"], ["C", "SUPPLIER_ID_CONFLICT"]]);
    expect(client.addressCalls()).toHaveLength(1);
    expect(client.writes).toHaveLength(0);
  });
});
