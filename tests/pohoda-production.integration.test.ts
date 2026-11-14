/**
 * Live production-path test: reviewed XLSX -> ExpenseReviewService -> ExpenseImporter -> PohodaClient
 * -> Pohoda.exe /XML inside a local Parallels Windows VM (the isolated MCPTEST demo unit only).
 *
 * Gates (all opt-in, see tests/pohoda-parallels.integration.test.ts for the shared variables):
 *   POHODA_PRL_VM, POHODA_PRL_DEMO_DATABASE, POHODA_PRL_DEMO_ICO   required
 *   POHODA_PRL_ALLOW_WRITES=1   without it only the read-only prepare/paging checks run
 *   POHODA_PRL_RUN=<tag>        makes source numbers/PDF bytes unique per run (default p1)
 *   POHODA_PRL_VAT_PERIOD       default 2026-10 (the demo has a CNB EUR rate list for 2026-10-01)
 *   POHODA_PRL_EUR_RATE         expected configured EUR rate (CNB list #189 of 01.10.2026: 24.465)
 *   POHODA_PRL_REPORT / POHODA_PRL_EVIDENCE_DIR   evidence output
 *
 * The only test doubles are the transport (Parallels instead of a local Pohoda.exe) and a cross-host
 * PDF archive adapter: the MCP server runs on macOS here, so the archive copy is performed inside the
 * Windows guest under the production root and the returned path is the guest path POHODA links.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExpenseImporter, recordsIn, retryMarkersIn } from "../src/mcp/expense-import.js";
import { ExpenseReviewService } from "../src/mcp/expense-review.js";
import { REVIEW_COLUMNS } from "../src/mcp/review-workbook.js";
import { PohodaClient } from "../src/pohoda/client.js";
import { DEFAULT_PDF_ARCHIVE_ROOT, planPdfArchiveTarget, type PdfArchive, type PdfArchiveContext, type PdfArchiveResult } from "../src/pohoda/pdf-archive.js";
import type { TransportOptions } from "../src/pohoda/transport.js";
import {
  discoverPohodaInstall,
  ensureVmRunning,
  extractLiveUnits,
  guestPowerShell,
  HarnessXmlClient,
  parallelsOptionsFromEnv,
  ParallelsPohodaTransport,
  selectVerifiedDemoUnit,
  type LiveUnit,
  type ParallelsPohodaOptions
} from "./support/parallels-pohoda.js";

type Fields = Record<string, any>;
const options = parallelsOptionsFromEnv();
const run = options && options.demoDatabase ? describe.sequential : describe.skip;
const RUN = (process.env.POHODA_PRL_RUN ?? "p1").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
const PERIOD = process.env.POHODA_PRL_VAT_PERIOD ?? "2026-10";
const EUR_RATE = Number(process.env.POHODA_PRL_EUR_RATE ?? "24.465");
const PDF_ROOT = process.env.POHODA_PRL_PDF_ROOT ?? DEFAULT_PDF_ARCHIVE_ROOT;
const reportPath = process.env.POHODA_PRL_REPORT ?? join(tmpdir(), "pohoda-production-report.json");
const evidence: Array<{ name: string; facts: unknown }> = [];
const record = (name: string, facts: unknown) => { evidence.push({ name, facts }); };
const headerOf = (row: Fields): Fields => row.invoiceHeader ?? row.voucherHeader ?? row.addressbookHeader ?? row;
const summaryOf = (row: Fields): Fields => row.invoiceSummary ?? row.voucherSummary ?? {};
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
/** Stable numeric suffix derived from the run tag, for numeric variable symbols. */
const runDigits = String(parseInt(createHash("sha256").update(RUN).digest("hex").slice(0, 8), 16) % 100000).padStart(5, "0");

/**
 * Archive adapter for a macOS MCP host and a Windows POHODA guest. Mirrors PdfArchive semantics:
 * content-addressed <root>/<ico>/<database>/<year>/<sha256>.pdf, never overwrites, verifies bytes.
 * Paths travel base64-encoded (UTF-8) so Czech characters do not depend on console code pages.
 */
class GuestPdfArchive implements Pick<PdfArchive, "archive"> {
  public readonly archived: PdfArchiveResult[] = [];
  public constructor(private readonly vm: Pick<ParallelsPohodaOptions, "prlctl" | "vm" | "currentUser">, private readonly root: string) {}

  public async archive(sourcePath: string, context: PdfArchiveContext): Promise<PdfArchiveResult> {
    const bytes = await readFile(sourcePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const plan = planPdfArchiveTarget(this.root, sha256, context, "win32");
    const script = String.raw`
$job = [Console]::In.ReadToEnd() | ConvertFrom-Json
$dir = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($job.dir))
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($job.path))
$data = [Convert]::FromBase64String($job.data)
[IO.Directory]::CreateDirectory($dir) | Out-Null
$sha = [Security.Cryptography.SHA256]::Create()
$reused = $false
if (Test-Path -LiteralPath $path) {
  $existing = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path))).Replace('-','').ToLower()
  if ($existing -ne $job.sha) { '@@ARC@@CONFLICT'; exit 0 }
  $reused = $true
} else {
  $fs = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try { $fs.Write($data, 0, $data.Length); $fs.Flush($true) } finally { $fs.Close() }
}
$final = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path))).Replace('-','').ToLower()
'@@ARC@@' + $final + '|' + (Get-Item -LiteralPath $path).Length + '|' + $reused
`;
    const result = await guestPowerShell(this.vm, script, JSON.stringify({ dir: b64(plan.directory), path: b64(plan.path), data: bytes.toString("base64"), sha: sha256 }), 120_000);
    const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith("@@ARC@@"));
    if (!line || line === "@@ARC@@CONFLICT") throw new Error(`Guest PDF archive failed for ${plan.path}: ${line ?? result.stderr.slice(0, 400)}`);
    const [finalSha, length, reused] = line.slice(7).split("|");
    if (finalSha !== sha256 || Number(length) !== bytes.length) throw new Error(`Guest PDF archive verification failed for ${plan.path}.`);
    const archived = { path: plan.path, sha256, bytes: bytes.length, reused: reused === "True" };
    this.archived.push(archived);
    return archived;
  }
}

/** Reads a guest file by its exact (Czech) path: existence, size and SHA-256. */
async function guestFileFacts(vm: Pick<ParallelsPohodaOptions, "prlctl" | "vm" | "currentUser">, path: string): Promise<{ exists: boolean; sha256?: string; bytes?: number }> {
  const script = String.raw`
$job = [Console]::In.ReadToEnd() | ConvertFrom-Json
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($job.path))
if (-not (Test-Path -LiteralPath $path)) { '@@FILE@@0'; exit 0 }
$sha = [Security.Cryptography.SHA256]::Create()
'@@FILE@@1|' + [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path))).Replace('-','').ToLower() + '|' + (Get-Item -LiteralPath $path).Length
`;
  const result = await guestPowerShell(vm, script, JSON.stringify({ path: b64(path) }), 60_000);
  const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith("@@FILE@@"));
  if (!line) throw new Error(`Guest file check failed: ${result.stderr.slice(0, 300)}`);
  const [flag, sha256, bytes] = line.slice(8).split("|");
  return flag === "1" ? { exists: true, sha256: sha256!, bytes: Number(bytes) } : { exists: false };
}

/** Minimal single-page PDF whose bytes are unique per run (so the archive copy is fresh). */
function minimalPdf(label: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${label}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

run("POHODA production expense import (Parallels demo unit)", () => {
  let transport: ParallelsPohodaTransport;
  let client: PohodaClient;
  let demo: LiveUnit;
  let target: TransportOptions;
  let archive: GuestPdfArchive;
  let workDir: string;
  let pdfPath: string;
  const writes = () => options!.allowWrites;
  const step = (label: string) => { transport.label = label; };
  const prev = (day: number) => { const [y, m] = PERIOD.split("-").map(Number); const d = new Date(Date.UTC(y!, m! - 2, day)); return d.toISOString().slice(0, 10); };
  const inPeriod = (day: number) => `${PERIOD}-${String(day).padStart(2, "0")}`;
  const NEW_SUPPLIER_ICO = "99000016";
  // Pre-existing demo contact "MCPTEST Linked Supplier" (p1). Its IČO 87654321 fails the checksum, so link by ID.
  const LINKED_SUPPLIER_ID = Number(process.env.POHODA_PRL_LINKED_SUPPLIER_ID ?? 2);

  // Source documents (manual/PDF extraction stand-ins). Values are the exact source facts.
  const documents = (suffix: string): Array<{ requestId: string; tool: any; data: Fields }> => [
    { requestId: `A${suffix}`, tool: "create_invoice", data: {
      type: "receivedInvoice", taxMode: "taxable", classificationVAT: "PD", sourcePdfPath: pdfPath, sourcePages: [1],
      partnerIco: NEW_SUPPLIER_ICO, partnerDic: `CZ${NEW_SUPPLIER_ICO}`, partnerName: "MCPTEST Účetní služby s.r.o.",
      partnerStreet: "Žitná 1", partnerCity: "Plzeň", partnerZip: "30100", partnerCountry: "CZ",
      sourceIssueDate: prev(18), sourceTaxDate: prev(17), dateDue: inPeriod(20),
      sourceDocumentNumber: `MCPTEST-${RUN}-A`, sourceSymVar: `9${runDigits}1`,
      text: "MCPTEST služby září",
      priceLow: 100, priceLowVAT: 12, priceLowSum: 112,
      priceHigh: 101.12, priceHighVAT: 21.24, priceHighSum: 122.36,
      roundingAmount: -0.36, total: 234
    } },
    { requestId: `B${suffix}`, tool: "create_other_liability", data: {
      taxMode: "nonTax", sourceType: "manual", partnerId: LINKED_SUPPLIER_ID,
      sourceIssueDate: prev(10), sourceTaxDate: prev(10),
      sourceDocumentNumber: `MCPTEST-${RUN}-B`, sourceSymVar: `9${runDigits}2`,
      text: "MCPTEST nedaňový výdaj",
      priceHigh: 1000, priceHighVAT: 210, priceHighSum: 1210, total: 1210
    } },
    { requestId: `C${suffix}`, tool: "create_other_liability", data: {
      taxMode: "taxable", classificationVAT: "PD", sourceType: "manual", cardPayment: true, partnerId: LINKED_SUPPLIER_ID,
      sourceIssueDate: inPeriod(5), sourceTaxDate: inPeriod(5), sourceDocumentNumber: `MCPTEST-${RUN}-C`,
      text: "MCPTEST platba kartou",
      priceHigh: 500, priceHighVAT: 105, priceHighSum: 605, total: 605
    } },
    { requestId: `D${suffix}`, tool: "create_other_liability", data: {
      taxMode: "nonTax", sourceType: "manual", partnerDic: "DE999000016", partnerName: "MCPTEST EU Lieferant GmbH",
      partnerCity: "Berlin", partnerCountry: "DE",
      sourceIssueDate: `${PERIOD}-01`, sourceDocumentNumber: `MCPTEST-${RUN}-D`,
      text: "MCPTEST EUR bez kurzu", currency: "EUR", priceNone: 100, total: 100
    } },
    { requestId: `E${suffix}`, tool: "create_other_liability", data: {
      taxMode: "nonTax", sourceType: "manual", partnerDic: "DE999000016", partnerName: "MCPTEST EU Lieferant GmbH",
      partnerCity: "Berlin", partnerCountry: "DE",
      sourceIssueDate: `${PERIOD}-01`, sourceDocumentNumber: `MCPTEST-${RUN}-E`,
      text: "MCPTEST USD bez kurzu", currency: "USD", priceNone: 100, total: 100
    } }
  ];

  const reviewService = (importer: ExpenseImporter) => new ExpenseReviewService({ client, importer, directory: join(workDir, "reviews") });

  async function approveAll(workbookPath: string, rows: number): Promise<void> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(workbookPath);
    const sheet = wb.getWorksheet("Doklady")!;
    const col = REVIEW_COLUMNS.findIndex((c) => c.key === "action") + 1;
    for (let r = 0; r < rows; r++) sheet.getCell(3 + r, col).value = "Importovat";
    await wb.xlsx.writeFile(workbookPath);
  }

  async function scan(agenda: "invoice" | "voucher", subType: string): Promise<Fields[]> {
    step(`scan-${subType || agenda}`);
    const response = await client.listRecordsBatch([{ agenda, subType, filter: {}, options: { restrictions: { "lst:attachments": true } } }], "", target);
    expect(response.isOk()).toBe(true);
    return recordsIn(response.items[0]!.data);
  }

  async function readOne(agenda: "invoice" | "addressbook", subType: string, filter: Fields): Promise<Fields[]> {
    step(`read-${agenda}-${JSON.stringify(filter).replace(/\W+/g, "")}`);
    const response = await client.listRecordsBatch([{ agenda, subType, filter, options: agenda === "addressbook" ? {} : { restrictions: { "lst:attachments": true } } }], "", target);
    expect(response.isOk()).toBe(true);
    return recordsIn(response.items[0]!.data);
  }

  beforeAll(async () => {
    if (options!.startVm) await ensureVmRunning(options!);
    let exePath = options!.exePath;
    if (!exePath) exePath = (await discoverPohodaInstall(options!)).exePaths[0] ?? "";
    if (!exePath) throw new Error(`POHODA is not installed in Parallels VM '${options!.vm}'.`);
    transport = new ParallelsPohodaTransport({ ...options!, exePath });
    const harness = new HarnessXmlClient(transport, options!.bootstrapIco);
    const units = extractLiveUnits((await harness.listAccountingUnits()).toArray());
    const selection = selectVerifiedDemoUnit(units, options!.demoDatabase, options!.demoIco);
    record("demoSelection", selection);
    if (!selection.ok) throw new Error(`Refusing to run: ${selection.reason}`);
    if (!options!.demoIco) throw new Error("POHODA_PRL_DEMO_ICO is required for production writes.");
    demo = selection.unit;
    client = new PohodaClient({ transport, ico: demo.ico!, database: demo.database, application: "MCPTEST production" });
    target = { databaseOverride: demo.database, dataPackIco: demo.ico! };
    archive = new GuestPdfArchive(options!, PDF_ROOT);
    workDir = await mkdtemp(join(tmpdir(), "pohoda-prod-"));
    pdfPath = join(workDir, `MCPTEST-${RUN}-A.pdf`);
    await writeFile(pdfPath, minimalPdf(`MCPTEST ${RUN} A ${PERIOD}`));
  }, 600_000);

  afterAll(async () => {
    await transport?.cleanup();
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ vm: options!.vm, run: RUN, period: PERIOD, demo, evidence, exchanges: transport?.results.map((r) => ({ requestPath: r.requestPath, responsePath: r.responsePath })) }, null, 2));
  });

  it("confirms list paging semantics used by the retry scan (read-only)", async () => {
    const page = async (opts: Fields, filter: Fields = {}) => {
      step(`paging-${JSON.stringify({ ...opts, ...filter }).replace(/\W+/g, "")}`);
      const response = await client.listRecordsBatch([{ agenda: "invoice", subType: "commitment", filter, options: opts }], "", target);
      expect(response.isOk()).toBe(true);
      return recordsIn(response.items[0]!.data).map((row) => ({ id: Number(headerOf(row).id), date: headerOf(row).date }));
    };
    const all = await page({});
    expect(all.length).toBeGreaterThan(3);
    const first = await page({ count: 2 });
    const pivot = all[2]!.id;
    const fromPivot = await page({ count: 2, idFrom: pivot });
    const outside = await page({}, { dateFrom: "1999-01-01", dateTill: "1999-12-31" });
    record("paging", { all: all.map((r) => r.id), countTwo: first.map((r) => r.id), idFromPivot: { pivot, ids: fromPivot.map((r) => r.id) }, dateWindow1999: outside.length });
    expect(first.map((r) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));
    expect(fromPivot.map((r) => r.id)).toEqual(all.slice(2, 4).map((r) => r.id)); // idFrom is inclusive, ascending
    expect(outside).toHaveLength(0); // dateFrom/dateTill filter on the document date
  }, 600_000);

  it("prepares the review workbook without writing to POHODA (read-only)", async () => {
    const before = transport.results.length;
    const service = reviewService(new ExpenseImporter(client, null, archive));
    const prepared = await service.prepare({ databaseId: demo.database, vatPeriod: PERIOD, documents: documents(""), target });
    record("prepare", { status: prepared.status, rows: prepared.rows, pending: prepared.pendingReview });
    expect(prepared.reviewId).toMatch(/^rv-/);
    expect(archive.archived).toHaveLength(0);
    const requests = transport.results.slice(before).map((r) => r.request);
    expect(requests.every((xml) => !/<(inv:invoice |adb:addressbook |vch:voucher )/.test(xml))).toBe(true);
  }, 600_000);

  describe.sequential("MCPTEST writes (verified demo unit only)", () => {
    let first: Fields;
    let firstIds: Record<string, number> = {};
    let countsBefore = { receivedInvoice: 0, commitment: 0 };
    let countsAfterFirst = { receivedInvoice: 0, commitment: 0 };

    it("imports the approved workbook and verifies every stored fact", async () => {
      if (!writes()) return record("writes", "POHODA_PRL_ALLOW_WRITES not set");
      countsBefore = { receivedInvoice: (await scan("invoice", "receivedInvoice")).length, commitment: (await scan("invoice", "commitment")).length };
      const importer = new ExpenseImporter(client, null, archive);
      const service = reviewService(importer);
      const prepared = await service.prepare({ databaseId: demo.database, vatPeriod: PERIOD, documents: documents(""), target });
      await approveAll(prepared.workbookPath, 5);
      step("import");
      first = await service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: demo.database, target });
      record("import.first", first);
      countsAfterFirst = { receivedInvoice: (await scan("invoice", "receivedInvoice")).length, commitment: (await scan("invoice", "commitment")).length };
      const results: Fields[] = first.result?.results ?? [];
      for (const r of results) if (r.id) firstIds[r.requestId] = Number(r.id);
      expect(results.filter((r) => r.created === true)).toHaveLength(5);
      for (const id of ["A", "B", "C", "D"]) {
        const r = results.find((x) => x.requestId === id)!;
        expect({ id, verified: r.verified, differences: r.differences, review: r.reviewRequired }).toMatchObject({ id, verified: true, differences: [] });
      }
    }, 900_000);

    it("A: exact VAT buckets, exact source rounding, four late dates, supplier p1 link, Czech PDF link", async () => {
      if (!writes() || !firstIds.A) return;
      const [row] = (await readOne("invoice", "receivedInvoice", { id: firstIds.A })).filter((r) => Number(headerOf(r).id) === firstIds.A);
      const h = headerOf(row!), home = summaryOf(row!).homeCurrency ?? {};
      const linkTarget = archive.archived[0]?.path ?? "";
      const file = await guestFileFacts(options!, linkTarget);
      const facts = {
        dates: { date: h.date, dateTax: h.dateTax, dateAccounting: h.dateAccounting, dateKHDPH: h.dateKHDPH, dateDue: h.dateDue },
        summary: summaryOf(row!), intNote: h.intNote, markers: retryMarkersIn(h.intNote), partner: h.partnerIdentity, text: h.text,
        linkTarget, exportedAttachments: row!.attachments ?? h.attachments, guestFile: file, archived: archive.archived
      };
      record("A.readback", facts);
      expect.soft(facts.dates).toMatchObject({ date: `${PERIOD}-01`, dateTax: `${PERIOD}-01`, dateAccounting: `${PERIOD}-01`, dateKHDPH: `${PERIOD}-01` });
      expect.soft(String(h.intNote)).toContain(prev(18));
      expect.soft(String(h.intNote)).toContain(prev(17));
      expect.soft(facts.markers).toHaveLength(1);
      expect.soft([home.priceLow, String(home.priceLowVAT?.["#text"] ?? home.priceLowVAT), home.priceHigh, String(home.priceHighVAT?.["#text"] ?? home.priceHighVAT)].map(Number)).toEqual([100, 12, 101.12, 21.24]);
      expect.soft(Number(home.round?.priceRound)).toBe(-0.36);
      expect.soft(h.text).toBe("MCPTEST služby září");
      expect.soft(h.partnerIdentity?.address?.company).toBe("MCPTEST Účetní služby s.r.o.");
      expect.soft(linkTarget.startsWith(PDF_ROOT)).toBe(true);
      expect.soft(JSON.stringify(facts.exportedAttachments ?? row)).toContain(linkTarget.replace(/\\/g, "\\\\"));
      expect.soft(file).toMatchObject({ exists: true, sha256: archive.archived[0]!.sha256 });
      const [supplier] = await readOne("addressbook", "", { ico: NEW_SUPPLIER_ICO });
      record("A.supplier", headerOf(supplier!));
      expect.soft(String(headerOf(supplier!).p1)).toBe("true");
      expect.soft(Number(h.partnerIdentity?.id)).toBe(Number(headerOf(supplier!).id));
    }, 600_000);

    it("B: PN holds the full source gross in priceNone and has no KH date", async () => {
      if (!writes() || !firstIds.B) return;
      const [row] = (await readOne("invoice", "commitment", { id: firstIds.B })).filter((r) => Number(headerOf(r).id) === firstIds.B);
      const h = headerOf(row!), home = summaryOf(row!).homeCurrency ?? {};
      record("B.readback", { header: h, summary: summaryOf(row!) });
      expect(h.classificationVAT?.ids ?? h.classificationVAT?.classificationVATType).toMatch(/^(PN|nonSubsume)$/);
      expect(Number(home.priceNone)).toBe(1210);
      expect(Number(home.priceHigh ?? 0)).toBe(0);
      expect(h.dateKHDPH ?? "").toBe("");
      expect(h.date).toBe(`${PERIOD}-01`);
      expect(Number(h.partnerIdentity?.id)).toBeGreaterThan(0);
    }, 600_000);

    it("C: card liability gets the exact requested PK number, Doklad K<n> and VS <n>", async () => {
      if (!writes() || !firstIds.C) return;
      const [row] = (await readOne("invoice", "commitment", { id: firstIds.C })).filter((r) => Number(headerOf(r).id) === firstIds.C);
      const h = headerOf(row!);
      const requested = String(h.number?.numberRequested ?? "");
      const n = Number(requested.replace(/^PK\d{2}/, ""));
      record("C.readback", { number: h.number, originalDocument: h.originalDocument, symVar: h.symVar, paymentType: h.paymentType });
      expect(requested).toMatch(new RegExp(`^PK${PERIOD.slice(2, 4)}\\d+$`));
      expect(h.originalDocument).toBe(`K${n}`);
      expect(String(h.symVar)).toBe(String(n));
    }, 600_000);

    it("D/E: omitted FX rate uses the configured CNB rate; a currency without a real rate needs review", async () => {
      if (!writes() || !firstIds.D) return;
      const results: Fields[] = first.result.results;
      const d = results.find((r) => r.requestId === "D")!, e = results.find((r) => r.requestId === "E")!;
      record("FX", { D: { verified: d.verified, applied: d.appliedCurrency, differences: d.differences, review: d.reviewRequired }, E: { ok: e.ok, verified: e.verified, applied: e.appliedCurrency, differences: e.differences, review: e.reviewRequired, id: e.id } });
      expect(Number(d.appliedCurrency?.rate)).toBe(EUR_RATE);
      expect(d.ok).toBe(true);
      expect(e.ok).toBe(false);
      expect(e.id).toBeGreaterThan(0); // created ID is reported, never silently retried
      expect(first.result.state).toBe("needs_review");
    }, 600_000);

    it("retrying the same PDF/source documents in a fresh review creates no new records", async () => {
      if (!writes() || !first) return;
      const importer = new ExpenseImporter(client, null, archive);
      const service = reviewService(importer);
      const prepared = await service.prepare({ databaseId: demo.database, vatPeriod: PERIOD, documents: documents("r"), target });
      await approveAll(prepared.workbookPath, 5);
      step("retry");
      const retried = await service.importReviewed({ reviewId: prepared.reviewId, approved: true, databaseId: demo.database, target });
      record("import.retry", retried);
      const results: Fields[] = retried.result?.results ?? [];
      const countsAfter = { receivedInvoice: (await scan("invoice", "receivedInvoice")).length, commitment: (await scan("invoice", "commitment")).length };
      record("counts", { before: countsBefore, afterFirst: countsAfterFirst, afterRetry: countsAfter });
      expect(countsAfter).toEqual(countsAfterFirst); // the retry itself never adds a record
      for (const r of results) {
        expect.soft({ id: r.requestId, created: r.created, state: r.state }).toMatchObject({ created: false, state: "already_exists" });
        expect.soft(Number(r.id)).toBe(firstIds[r.requestId.replace(/r$/, "")]);
      }
      expect(countsAfter).toEqual({ receivedInvoice: countsBefore.receivedInvoice + 1, commitment: countsBefore.commitment + 4 });
    }, 900_000);

    it("cash threshold and a large card followed by a small card preserve their references", async () => {
      if (!writes()) return;
      const common = { sourceType: "manual", taxMode: "nonTax", partnerId: LINKED_SUPPLIER_ID, sourceIssueDate: prev(15), sourcePaymentDate: prev(15), text: "MCPTEST hranice a karty" };
      const rows = [
        { requestId: "big", tool: "create_other_liability" as const, data: { ...common, cardPayment: true, sourceDocumentNumber: `MCPTEST-${RUN}-BIG`, sourceSymVar: "777", priceNone: 12100, total: 12100 } },
        { requestId: "small", tool: "create_other_liability" as const, data: { ...common, cardPayment: true, sourceDocumentNumber: `MCPTEST-${RUN}-SMALL`, priceNone: 100, total: 100 } },
        { requestId: "cashAt", tool: "create_cash_voucher" as const, data: { ...common, cashAccount: "HP", sourceDocumentNumber: `MCPTEST-${RUN}-AT`, priceNone: 10000.4, roundingAmount: -0.4, total: 10000 } },
        { requestId: "cashAbove", tool: "create_cash_voucher" as const, data: { ...common, cashAccount: "HP", sourceDocumentNumber: `MCPTEST-${RUN}-ABOVE`, priceNone: 10000.01, total: 10000.01 } }
      ];
      const service = reviewService(new ExpenseImporter(client, null, archive));
      const prepared = await service.prepare({ databaseId: demo.database, vatPeriod: PERIOD, documents: rows, target });
      await approveAll(prepared.workbookPath, rows.length);
      const inspected = await service.inspect({ reviewId: prepared.reviewId });
      step("edge-import");
      const imported = await service.importReviewed({ reviewId: prepared.reviewId, approved: true, expectedWorkbookSha256: inspected.workbookSha256, databaseId: demo.database, target });
      record("edges.import", imported);
      expect(imported.ok).toBe(true);
      const results: Fields[] = imported.result.results;
      const stored = await client.listRecordsBatch(results.map((r) => ({ agenda: r.tool === "create_cash_voucher" ? "voucher" : "invoice", subType: r.tool === "create_cash_voucher" ? "" : "commitment", filter: { id: Number(r.id) } })), "", target);
      const headers = stored.items.map((entry, i) => headerOf(recordsIn(entry.data).find((r) => Number(headerOf(r).id) === Number(results[i]!.id))!));
      const [big, small, at, above] = headers;
      record("edges.headers", headers);
      const bigN = Number(String(big!.number.numberRequested).replace(/^PK\d{2}/, ""));
      const smallN = Number(String(small!.number.numberRequested).replace(/^PK\d{2}/, ""));
      expect(smallN).toBe(bigN + 1);
      expect(big!.originalDocument).toBe(`MCPTEST-${RUN}-BIG`);
      expect(String(big!.symVar)).toBe("777");
      expect(small!.originalDocument).toBe(`K${smallN}`);
      expect(String(small!.symVar)).toBe(String(smallN));
      expect(at!.originalDocument ?? "").toBe("");
      expect(above!.originalDocument).toBe(`MCPTEST-${RUN}-ABOVE`);
      expect(at!.datePayment).toBe(prev(15));
      expect(above!.datePayment).toBe(prev(15));
    }, 900_000);
  });
});
