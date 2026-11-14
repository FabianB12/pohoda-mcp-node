/**
 * Live POHODA /XML experiments in a local Parallels Windows VM.
 *
 * Gates (all opt-in):
 *   POHODA_PRL_VM=<vm name>                 enables discovery + read-only checks
 *   POHODA_PRL_PASSWORD / _USERNAME         POHODA login (env only, never logged; blank Admin by default)
 *   POHODA_PRL_DEMO_DATABASE=<file.mdb>     explicit demo unit (required for any write)
 *   POHODA_PRL_DEMO_ICO=<ico>               optional extra identity check
 *   POHODA_PRL_ALLOW_WRITES=1               enables MCPTEST write experiments in the verified demo unit
 *   POHODA_PRL_VAT_PERIOD=YYYY-MM           selected VAT month (default: <unit year>-10)
 *   POHODA_PRL_RUN=<tag>                    suffix for MCPTEST external IDs (default: r1); change it to re-run
 *   POHODA_PRL_REPORT=<path.json>           evidence summary JSON
 *   POHODA_PRL_EVIDENCE_DIR=<dir>           one request/response XML pair per exchange
 *   POHODA_PRL_PDF_ROOT=<dir>               override the source-PDF archive root for E8
 *
 * Experiments use raw XML through the harness client (same envelope as PohodaClient.sendRawXml) so they
 * record POHODA behaviour independently of the production builders and their import guards.
 * POHODA Start without registration limits each agenda to ~10 records; keep the write set small.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PohodaResponse } from "../src/pohoda/response.js";
import {
  discoverPohodaInstall,
  ensureVmRunning,
  extractLiveUnits,
  guestPowerShell,
  HarnessXmlClient,
  listedRecords,
  mcptestId,
  NMS_NS,
  producedId,
  parallelsOptionsFromEnv,
  ParallelsPohodaTransport,
  rawList,
  selectVerifiedDemoUnit,
  type LiveUnit
} from "./support/parallels-pohoda.js";

const options = parallelsOptionsFromEnv();
const run = options ? describe.sequential : describe.skip;
const EXT = "MCPTEST";
const RUN = (process.env.POHODA_PRL_RUN ?? "r1").replace(/[^A-Za-z0-9]/g, "");
const reportPath = process.env.POHODA_PRL_REPORT ?? join(tmpdir(), "pohoda-parallels-report.json");
// Requested production root. Live finding: on a guest whose ANSI code page is 1252 (en-US system locale)
// POHODA degrades č/Ů in typ:target (warning 631, file not found); use a cs-CZ (1250) guest or override
// with POHODA_PRL_PDF_ROOT for an ASCII control run.
const PDF_ROOT = process.env.POHODA_PRL_PDF_ROOT ?? "C:\\Účetnictví\\PDF DOKLADY KLIENTŮ Z POHODY";

type Evidence = { name: string; outcome: string; requestPath?: string | undefined; responsePath?: string | undefined; facts?: unknown };
const evidence: Evidence[] = [];

run("POHODA Parallels integration", () => {
  let transport: ParallelsPohodaTransport;
  let client: HarnessXmlClient;
  let demo: LiveUnit | undefined;
  let demoReason = "";
  let period = "";
  const writesEnabled = () => Boolean(demo) && options!.allowWrites;
  const d1 = () => `${period}-01`;
  // Source dates deliberately earlier than the selected VAT month (policy moves them to d1).
  const late = () => `${period.slice(0, 4)}-${String(Number(period.slice(5, 7)) - 1).padStart(2, "0")}-15`;
  const id = (name: string) => mcptestId(RUN, name);

  beforeAll(async () => {
    if (options!.startVm) {
      await ensureVmRunning(options!);
    }
    let exePath = options!.exePath;
    if (!exePath) {
      const found = await discoverPohodaInstall(options!);
      record("discovery", found.exePaths.length > 0 ? "found" : "missing", undefined, found);
      exePath = found.exePaths[0] ?? "";
    }
    if (!exePath) {
      throw new Error(`POHODA is not installed in Parallels VM '${options!.vm}' (no Pohoda.exe found).`);
    }
    transport = new ParallelsPohodaTransport({ ...options!, exePath });
    client = new HarnessXmlClient(transport, options!.bootstrapIco);
  }, 600_000);

  afterAll(async () => {
    await transport?.cleanup();
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ vm: options!.vm, demo, demoReason, period, run: RUN, evidence }, null, 2));
  });

  it("discovers live accounting units and verifies an explicit demo unit", async () => {
    const response = await client.listAccountingUnits();
    record("listAccountingUnits", response.state, response);
    expect(response.isOk()).toBe(true);
    const units = extractLiveUnits(response.toArray());
    expect(units.length).toBeGreaterThan(0);
    const selection = selectVerifiedDemoUnit(units, options!.demoDatabase, options!.demoIco);
    if (selection.ok) {
      demo = selection.unit;
      client.setContext(demo.database, demo.ico ?? options!.bootstrapIco);
      period = process.env.POHODA_PRL_VAT_PERIOD ?? `${demo.year ?? new Date().getFullYear()}-10`;
    } else {
      demoReason = selection.reason;
    }
    record("demoSelection", selection.ok ? "verified" : "refused", undefined,
      selection.ok ? { unit: selection.unit, evidence: selection.evidence } : { reason: selection.reason, candidates: selection.candidates });
  }, 300_000);

  it("reads numericalSeries and classificationVAT shapes (read-only)", async () => {
    if (!demo) return note("readOnly", demoReason);
    const series = await client.list(rawList.numericalSeries(), "numericalSeries-before");
    record("numericalSeries.before", series.state, series, seriesFacts(series));
    const vat = await client.list(rawList.classificationVAT(), "classificationVAT");
    const codes = listedRecords(vat).map((r) => r.classificationVATHeader).filter((h) => /^(PN|PD|PDB2|UN)$/.test(String(h?.code)));
    record("classificationVAT", vat.state, vat, codes.map((h) => ({ id: h.id, code: h.code, name: h.name, line: h.lineInVATReturn, kh: h.sectionInVATLedgerStatement })));
    expect(series.isOk() && vat.isOk()).toBe(true);
  }, 300_000);

  describe.sequential("MCPTEST write experiments (demo unit only)", () => {
    it("E1 receivedInvoice: summary-only multi-rate home VAT, source-rounded VAT, explicit priceRound", async () => {
      if (!writesEnabled()) return note("E1", demoReason || "writes disabled");
      const ext = id("e1");
      // 50 none + 100/12/112 + 1000/210.01/1210.01 (source VAT deliberately not 210.00) + round -0.01 = 1372.00
      const xml = invoice(header({
        ext, type: "receivedInvoice", symVar: "2026101", originalDocument: "FV-2026-101",
        date: d1(), dateTax: d1(), dateAccounting: d1(), dateKHDPH: d1(), dateDue: d1(), classificationVAT: "PD",
        text: "MCPTEST E1 souhrnna prijata faktura", partner: address("MCPTEST Dodavatel E1"),
        intNote: `MCPTEST source dates ${late()}`
      }), `<inv:invoiceSummary><inv:roundingDocument>none</inv:roundingDocument><inv:roundingVAT>none</inv:roundingVAT>`
        + `<inv:homeCurrency><typ:priceNone>50</typ:priceNone><typ:priceLow>100</typ:priceLow><typ:priceLowVAT>12</typ:priceLowVAT><typ:priceLowSum>112</typ:priceLowSum>`
        + `<typ:priceHigh>1000</typ:priceHigh><typ:priceHighVAT>210.01</typ:priceHighVAT><typ:priceHighSum>1210.01</typ:priceHighSum>`
        + `<typ:round><typ:priceRound>-0.01</typ:priceRound></typ:round></inv:homeCurrency></inv:invoiceSummary>`);
      await writeAndRead("E1", ext, "receivedInvoice", xml);
    }, 600_000);

    it("E1b receivedInvoice: same buckets with roundingDocument math2one and stated priceRound", async () => {
      if (!writesEnabled()) return note("E1b", demoReason || "writes disabled");
      const ext = id("e1b");
      const xml = invoice(header({
        ext, type: "receivedInvoice", symVar: "2026109", originalDocument: "FV-2026-109",
        date: d1(), dateTax: d1(), dateAccounting: d1(), dateKHDPH: d1(), dateDue: d1(), classificationVAT: "PD",
        text: "MCPTEST E1b zaokrouhleni math2one", partner: address("MCPTEST Dodavatel E1"), intNote: "MCPTEST E1b"
      }), `<inv:invoiceSummary><inv:roundingDocument>math2one</inv:roundingDocument><inv:roundingVAT>none</inv:roundingVAT>`
        + `<inv:homeCurrency><typ:priceNone>50</typ:priceNone><typ:priceLow>100</typ:priceLow><typ:priceLowVAT>12</typ:priceLowVAT><typ:priceLowSum>112</typ:priceLowSum>`
        + `<typ:priceHigh>1000</typ:priceHigh><typ:priceHighVAT>210.01</typ:priceHighVAT><typ:priceHighSum>1210.01</typ:priceHighSum>`
        + `<typ:round><typ:priceRound>-0.01</typ:priceRound></typ:round></inv:homeCurrency></inv:invoiceSummary>`);
      await writeAndRead("E1b", ext, "receivedInvoice", xml);
    }, 600_000);

    it("E2 commitment PN: full gross in priceNone, no dateKHDPH", async () => {
      if (!writesEnabled()) return note("E2", demoReason || "writes disabled");
      const ext = id("e2");
      const xml = invoice(header({
        ext, type: "commitment", symVar: "2026102", originalDocument: "NP-2026-102",
        date: d1(), dateTax: d1(), dateAccounting: d1(), dateDue: d1(), classificationVAT: "PN",
        text: "MCPTEST E2 neplatce bez KH", partner: address("MCPTEST Neplatce E2"), intNote: "MCPTEST E2"
      }), `<inv:invoiceSummary><inv:homeCurrency><typ:priceNone>605</typ:priceNone></inv:homeCurrency></inv:invoiceSummary>`);
      await writeAndRead("E2", ext, "commitment", xml);
    }, 600_000);

    it("E3 supplier: p1 address add, duplicate add attempt, invoice linked by partner id", async () => {
      if (!writesEnabled()) return note("E3", demoReason || "writes disabled");
      const addrExt = id("e3-addr");
      const lookup = async (label: string) => {
        const r = await client.list(rawList.addressbook({ extId: { ids: addrExt, exSystemName: EXT } }), label);
        const rows = listedRecords(r, /^addressbook$/);
        record(`E3.${label}`, `${r.state} count=${rows.length}`, r, rows.map((row) => ({ id: row.addressbookHeader?.id, p1: row.addressbookHeader?.p1, company: row.addressbookHeader?.identity?.address?.company })));
        return rows;
      };
      const addXml = `<adb:addressbook version="2.0"><adb:addressbookHeader><adb:identity><typ:extId><typ:ids>${addrExt}</typ:ids><typ:exSystemName>${EXT}</typ:exSystemName></typ:extId>`
        + `<typ:address><typ:company>MCPTEST Linked Supplier</typ:company><typ:city>MCPTEST Mesto</typ:city><typ:street>Testovaci 3</typ:street><typ:zip>10000</typ:zip><typ:ico>87654321</typ:ico><typ:dic>CZ87654321</typ:dic></typ:address></adb:identity>`
        + `<adb:p1>true</adb:p1></adb:addressbookHeader></adb:addressbook>`;
      if ((await lookup("lookupBefore")).length === 0) {
        const add = await client.sendRawXml(addXml, "E3-add", "", { checkDuplicity: true });
        record("E3.add", itemSummary(add), add, { request: addXml });
      }
      // Deliberate second add with the same extId: does POHODA reject or create a duplicate?
      const again = await client.sendRawXml(addXml, "E3-add-again", "", { checkDuplicity: true });
      record("E3.addAgain", itemSummary(again), again);
      const rows = await lookup("lookupAfter");
      const partnerId = Number(rows[0]?.addressbookHeader?.id ?? 0);
      expect(partnerId).toBeGreaterThan(0);
      const ext = id("e3");
      const xml = invoice(header({
        ext, type: "receivedInvoice", symVar: "2026103", originalDocument: "FV-2026-103",
        date: d1(), dateTax: d1(), dateAccounting: d1(), dateKHDPH: d1(), dateDue: d1(), classificationVAT: "PD",
        text: "MCPTEST E3 linked supplier", partner: `<typ:id>${partnerId}</typ:id>`, intNote: "MCPTEST E3"
      }), `<inv:invoiceSummary><inv:homeCurrency><typ:priceHigh>100</typ:priceHigh><typ:priceHighVAT>21</typ:priceHighVAT><typ:priceHighSum>121</typ:priceHighSum></inv:homeCurrency></inv:invoiceSummary>`);
      await writeAndRead("E3", ext, "receivedInvoice", xml);
    }, 900_000);

    it("E4 foreign summary EUR with rate/amount omitted", async () => {
      if (!writesEnabled()) return note("E4", demoReason || "writes disabled");
      const ext = id("e4");
      const xml = invoice(header({
        ext, type: "commitment", symVar: "2026104", originalDocument: "EU-2026-104",
        date: d1(), dateTax: d1(), dateAccounting: d1(), dateDue: d1(), classificationVAT: "UN",
        text: "MCPTEST E4 EUR bez kurzu", partner: address("MCPTEST EU Supplier"), intNote: "MCPTEST E4"
      }), `<inv:invoiceSummary><inv:foreignCurrency><typ:currency><typ:ids>EUR</typ:ids></typ:currency><typ:priceSum>100</typ:priceSum></inv:foreignCurrency></inv:invoiceSummary>`);
      await writeAndRead("E4", ext, "commitment", xml, { tolerateError: true });
    }, 600_000);

    it("E5a foreign VAT buckets inside foreignCurrency (not in typeCurrencyForeign schema)", async () => {
      if (!writesEnabled()) return note("E5a", demoReason || "writes disabled");
      const ext = id("e5a");
      const xml = invoice(header({
        ext, type: "commitment", symVar: "2026105", originalDocument: "EU-2026-105",
        date: d1(), dateTax: d1(), dateAccounting: d1(), dateKHDPH: d1(), dateDue: d1(), classificationVAT: "PD",
        text: "MCPTEST E5a EUR VAT buckets", partner: address("MCPTEST EU Supplier"), intNote: "MCPTEST E5a"
      }), `<inv:invoiceSummary><inv:foreignCurrency><typ:currency><typ:ids>EUR</typ:ids></typ:currency><typ:rate>25</typ:rate><typ:amount>1</typ:amount>`
        + `<typ:priceHigh>100</typ:priceHigh><typ:priceHighVAT>21</typ:priceHighVAT><typ:priceSum>121</typ:priceSum></inv:foreignCurrency></inv:invoiceSummary>`);
      await writeAndRead("E5a", ext, "commitment", xml, { tolerateError: true });
    }, 600_000);

    it("E5b foreign total with home-currency VAT buckets side by side (no items)", async () => {
      if (!writesEnabled()) return note("E5b", demoReason || "writes disabled");
      const ext = id("e5b");
      const xml = invoice(header({
        ext, type: "commitment", symVar: "2026106", originalDocument: "EU-2026-106",
        date: d1(), dateTax: d1(), dateAccounting: d1(), dateKHDPH: d1(), dateDue: d1(), classificationVAT: "PD",
        text: "MCPTEST E5b EUR total + CZK buckets", partner: address("MCPTEST EU Supplier"), intNote: "MCPTEST E5b"
      }), `<inv:invoiceSummary><inv:homeCurrency><typ:priceHigh>2500</typ:priceHigh><typ:priceHighVAT>525</typ:priceHighVAT><typ:priceHighSum>3025</typ:priceHighSum></inv:homeCurrency>`
        + `<inv:foreignCurrency><typ:currency><typ:ids>EUR</typ:ids></typ:currency><typ:rate>25</typ:rate><typ:amount>1</typ:amount><typ:priceSum>121</typ:priceSum></inv:foreignCurrency></inv:invoiceSummary>`);
      await writeAndRead("E5b", ext, "commitment", xml, { tolerateError: true });
    }, 600_000);

    it("E6 PK series: create MCPTEST series, auto number, numberRequested consumption and duplicate", async () => {
      if (!writesEnabled()) return note("E6", demoReason || "writes disabled");
      const year = period.slice(0, 4);
      const prefix = `PK${year.slice(2)}`;
      const seriesBefore = seriesFacts(await client.list(rawList.numericalSeries(), "E6-series-before"));
      if (!seriesBefore.some((s) => s.prefix === prefix && s.agenda === "ostatni_zavazky")) {
        const create = `<nms:numericalSeries xmlns:nms="${NMS_NS}" version="2.0"><nms:numericalSeriesHeader><nms:prefix>${prefix}</nms:prefix><nms:number>001</nms:number>`
          + `<nms:name>MCPTEST karty ${RUN}</nms:name><nms:agenda>ostatni_zavazky</nms:agenda><nms:period>yearlong</nms:period><nms:year>${year}</nms:year></nms:numericalSeriesHeader></nms:numericalSeries>`;
        const r = await client.sendRawXml(create, "E6-series-create", "", { checkDuplicity: true });
        record("E6.seriesCreate", itemSummary(r), r, { request: create });
      }
      const card = async (name: string, number: string, requested: string) => {
        const ext = id(`e6-${name}`);
        const numberXml = requested
          ? `<inv:number><typ:ids>${prefix}</typ:ids><typ:numberRequested>${requested}</typ:numberRequested></inv:number>`
          : `<inv:number><typ:ids>${prefix}</typ:ids></inv:number>`;
        const xml = invoice(header({
          ext, type: "commitment", numberXml, symVar: number, originalDocument: number,
          date: d1(), dateTax: d1(), dateAccounting: d1(), dateKHDPH: d1(), dateDue: d1(), classificationVAT: "PD", paymentType: "creditcard",
          text: `MCPTEST E6 ${name}`, partner: address("MCPTEST Card Merchant"), intNote: "MCPTEST E6"
        }), `<inv:invoiceSummary><inv:homeCurrency><typ:priceHigh>10</typ:priceHigh><typ:priceHighVAT>2.1</typ:priceHighVAT><typ:priceHighSum>12.1</typ:priceHighSum></inv:homeCurrency></inv:invoiceSummary>`);
        await writeAndRead(`E6.${name}`, ext, "commitment", xml, { tolerateError: true });
        record(`E6.${name}.series`, "read", undefined, seriesFacts(await client.list(rawList.numericalSeries(), `E6-series-after-${name}`)).filter((s) => s.prefix === prefix));
      };
      await card("auto", "", "");
      await card("requested", "KN", `${prefix}005`);
      await card("duplicate", "KN", `${prefix}005`);
      await card("autoAfter", "", "");
    }, 1_200_000);

    it("E6b numberRequested without series ids: honoured?, counter effect, duplicate rejection", async () => {
      if (!writesEnabled()) return note("E6b", demoReason || "writes disabled");
      const prefix = `PK${period.slice(2, 4)}`;
      const step = async (name: string, numberXml: string) => {
        const ext = id(`e6b-${name}`);
        const xml = invoice(header({
          ext, type: "commitment", numberXml, symVar: "KN", originalDocument: "KN",
          date: d1(), dateTax: d1(), dateAccounting: d1(), dateKHDPH: d1(), dateDue: d1(), classificationVAT: "PD", paymentType: "creditcard",
          text: `MCPTEST E6b ${name}`, partner: address("MCPTEST Card Merchant"), intNote: "MCPTEST E6b"
        }), `<inv:invoiceSummary><inv:homeCurrency><typ:priceHigh>10</typ:priceHigh><typ:priceHighVAT>2.1</typ:priceHighVAT><typ:priceHighSum>12.1</typ:priceHighSum></inv:homeCurrency></inv:invoiceSummary>`);
        await writeAndRead(`E6b.${name}`, ext, "commitment", xml, { tolerateError: true });
        record(`E6b.${name}.series`, "read", undefined, seriesFacts(await client.list(rawList.numericalSeries(), `E6b-series-after-${name}`)).filter((s) => s.prefix === prefix));
      };
      await step("requestedOnly", `<inv:number><typ:numberRequested>${prefix}007</typ:numberRequested></inv:number>`);
      await step("requestedOnlyDuplicate", `<inv:number><typ:numberRequested>${prefix}007</typ:numberRequested></inv:number>`);
      await step("autoAfterRequested", `<inv:number><typ:ids>${prefix}</typ:ids></inv:number>`);
    }, 1_200_000);

    it("E6c production number shape: series id (+ids) with numberRequested checkDuplicity", async () => {
      if (!writesEnabled()) return note("E6c", demoReason || "writes disabled");
      const prefix = `PK${period.slice(2, 4)}`;
      const series = seriesFacts(await client.list(rawList.numericalSeries(), "E6c-series-before")).find((s) => s.prefix === prefix);
      if (!series?.id) return note("E6c", `series ${prefix} missing`);
      const step = async (name: string, numberXml: string) => {
        const ext = id(`e6c-${name}`);
        const xml = invoice(header({
          ext, type: "commitment", numberXml, symVar: "KN", originalDocument: "KN",
          date: d1(), dateTax: d1(), dateAccounting: d1(), dateKHDPH: d1(), dateDue: d1(), classificationVAT: "PD", paymentType: "creditcard",
          text: `MCPTEST E6c ${name}`, partner: address("MCPTEST Card Merchant"), intNote: "MCPTEST E6c"
        }), `<inv:invoiceSummary><inv:homeCurrency><typ:priceHigh>10</typ:priceHigh><typ:priceHighVAT>2.1</typ:priceHighVAT><typ:priceHighSum>12.1</typ:priceHighSum></inv:homeCurrency></inv:invoiceSummary>`);
        await writeAndRead(`E6c.${name}`, ext, "commitment", xml, { tolerateError: true });
        record(`E6c.${name}.series`, "read", undefined, seriesFacts(await client.list(rawList.numericalSeries(), `E6c-series-after-${name}`)).filter((s) => s.prefix === prefix));
      };
      await step("idIdsRequested", `<inv:number><typ:id>${series.id}</typ:id><typ:ids>${prefix}</typ:ids><typ:numberRequested checkDuplicity="true">${prefix}009</typ:numberRequested></inv:number>`);
      await step("idRequested", `<inv:number><typ:id>${series.id}</typ:id><typ:numberRequested checkDuplicity="true">${prefix}010</typ:numberRequested></inv:number>`);
    }, 1_200_000);

    it("E7 cash expense voucher: actual payment date vs moved dateTax, originalDocument export", async () => {
      if (!writesEnabled()) return note("E7", demoReason || "writes disabled");
      const ext = id("e7");
      const xml = `<vch:voucher version="2.0"><vch:voucherHeader><vch:extId><typ:ids>${ext}</typ:ids><typ:exSystemName>${EXT}</typ:exSystemName></vch:extId>`
        + `<vch:voucherType>expense</vch:voucherType><vch:cashAccount><typ:ids>HP</typ:ids></vch:cashAccount><vch:originalDocument>UCT-2026-107</vch:originalDocument>`
        + `<vch:date>${late()}</vch:date><vch:datePayment>${late()}</vch:datePayment><vch:dateTax>${d1()}</vch:dateTax><vch:dateKHDPH>${d1()}</vch:dateKHDPH>`
        + `<vch:classificationVAT><typ:ids>PD</typ:ids></vch:classificationVAT><vch:text>MCPTEST E7 hotovostni vydej</vch:text>${`<vch:partnerIdentity>${address("MCPTEST Obchod E7")}</vch:partnerIdentity>`}`
        + `<vch:intNote>MCPTEST E7</vch:intNote></vch:voucherHeader>`
        + `<vch:voucherSummary><vch:roundingDocument>math2one</vch:roundingDocument><vch:homeCurrency><typ:priceHigh>1000</typ:priceHigh><typ:priceHighVAT>210</typ:priceHighVAT><typ:priceHighSum>1210</typ:priceHighSum></vch:homeCurrency></vch:voucherSummary></vch:voucher>`;
      const write = await client.sendRawXml(xml, "E7-write", "", { checkDuplicity: true });
      record("E7.write", itemSummary(write), write, { request: xml });
      const vid = producedId(write);
      const read = await client.list(rawList.voucher({ id: vid || -1 }, true, EXT), "E7-readback");
      record("E7.readback", `${read.state} count=${listedRecords(read, /^voucher$/).length}`, read, listedRecords(read, /^voucher$/).map(voucherFacts));
    }, 600_000);

    it("E8 PDF archive: saved PDF under requested root, invoice shortcut attachment, read back with attachments", async () => {
      if (!writesEnabled()) return note("E8", demoReason || "writes disabled");
      const target = `${PDF_ROOT}\\MCPTEST\\${demo!.ico}\\MCPTEST-${RUN}-e8.pdf`;
      const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
      const save = await guestPowerShell(options!,
        `$t=[Console]::In.ReadLine(); $b=[Convert]::FromBase64String([Console]::In.ReadLine()); New-Item -ItemType Directory -Force (Split-Path $t) | Out-Null; if (-not (Test-Path -LiteralPath $t)) { [IO.File]::WriteAllBytes($t,$b) }; $f=Get-Item -LiteralPath $t; 'SAVED|' + $f.FullName + '|' + $f.Length`,
        `${target}\n${Buffer.from(pdf).toString("base64")}\n`, 60_000);
      record("E8.savePdf", save.stdout.includes("SAVED|") ? "saved" : `failed exit=${save.exitCode}`, undefined, { stdout: save.stdout.split(/\r?\n/).find((l) => l.startsWith("SAVED|")), stderr: save.stderr.slice(0, 300) });
      const ext = id("e8");
      const xml = invoice(header({
        ext, type: "receivedInvoice", symVar: "2026108", originalDocument: "FV-2026-108",
        date: d1(), dateTax: d1(), dateAccounting: d1(), dateKHDPH: d1(), dateDue: d1(), classificationVAT: "PD",
        text: "MCPTEST E8 PDF shortcut", partner: address("MCPTEST Dodavatel E8"), intNote: "MCPTEST E8"
      }), `<inv:invoiceSummary><inv:homeCurrency><typ:priceHigh>100</typ:priceHigh><typ:priceHighVAT>21</typ:priceHighVAT><typ:priceHighSum>121</typ:priceHighSum></inv:homeCurrency></inv:invoiceSummary>`,
      `<inv:attachments><typ:shortcut><typ:target>${target}</typ:target></typ:shortcut></inv:attachments>`);
      const facts = await writeAndRead("E8", ext, "receivedInvoice", xml, { attachments: true });
      record("E8.targetSurvives", JSON.stringify(facts?.attachments ?? null).includes(JSON.stringify(target).slice(1, -1)) ? "exact" : "changed", undefined, { expected: target, actual: facts?.attachments });
    }, 600_000);
  });

  async function writeAndRead(name: string, extId: string, type: string, xml: string, opts: { tolerateError?: boolean; attachments?: boolean } = {}) {
    const write = await client.sendRawXml(xml, `${name}-write`, "", { checkDuplicity: true });
    record(`${name}.write`, itemSummary(write), write);
    if (!opts.tolerateError) {
      expect(write.isOk(), itemSummary(write)).toBe(true);
    }
    // extId filters are ignored by POHODA for invoices, so read back by the produced numeric id.
    const createdId = producedId(write);
    if (!createdId) {
      record(`${name}.readback`, "not created (no produced id)", undefined, { extId });
      return undefined;
    }
    const read = await client.list(rawList.invoice(type, { id: createdId }, opts.attachments ?? false, EXT), `${name}-readback`);
    const rows = listedRecords(read, /^invoice$/);
    const facts = rows.map(invoiceFacts);
    record(`${name}.readback`, `${read.state} count=${rows.length} id=${createdId}`, read, facts);
    expect(rows.length).toBe(1);
    return facts[0];
  }

  function note(name: string, reason: string) {
    record(name, "skipped", undefined, reason);
  }
});

// ---------------------------------------------------------------------------

function header(h: Record<string, string>): string {
  const el = (tag: string, value?: string) => (value ? `<inv:${tag}>${value}</inv:${tag}>` : "");
  // invoice.xsd invoiceHeaderType is an ordered sequence.
  return `<inv:invoiceHeader><inv:extId><typ:ids>${h.ext}</typ:ids><typ:exSystemName>${EXT}</typ:exSystemName></inv:extId>`
    + el("invoiceType", h.type) + (h.numberXml ?? "")
    + el("symVar", h.symVar) + el("originalDocument", h.originalDocument)
    + el("date", h.date) + el("dateTax", h.dateTax) + el("dateAccounting", h.dateAccounting) + el("dateKHDPH", h.dateKHDPH) + el("dateDue", h.dateDue)
    + (h.classificationVAT ? `<inv:classificationVAT><typ:ids>${h.classificationVAT}</typ:ids></inv:classificationVAT>` : "")
    + el("text", h.text) + `<inv:partnerIdentity>${h.partner}</inv:partnerIdentity>`
    + (h.paymentType ? `<inv:paymentType><typ:paymentType>${h.paymentType}</typ:paymentType></inv:paymentType>` : "")
    + el("intNote", h.intNote) + `</inv:invoiceHeader>`;
}

function address(company: string): string {
  return `<typ:address><typ:company>${company}</typ:company><typ:city>MCPTEST Mesto</typ:city></typ:address>`;
}

function invoice(header: string, summary: string, tail = ""): string {
  return `<inv:invoice version="2.0">${header}${summary}${tail}</inv:invoice>`;
}

function record(name: string, outcome: string, response?: PohodaResponse, facts?: unknown) {
  const t = response?.transport as { requestPath?: string; responsePath?: string } | undefined;
  evidence.push({ name, outcome, requestPath: t?.requestPath, responsePath: t?.responsePath, facts });
}

function itemSummary(response: PohodaResponse): string {
  return [response.state, ...response.items.map((item) => {
    const d = item.data ?? {};
    const detail = JSON.stringify(d).match(/"(?:note|state)":"[^"]{0,200}/g)?.slice(0, 4).join(";") ?? "";
    return `${item.state}${item.attributes.note ? `:${item.attributes.note}` : ""}${detail ? ` ${detail}` : ""}`;
  })].join(" | ");
}

function pick(obj: any, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
}

function invoiceFacts(row: any) {
  const h = row?.invoiceHeader ?? {};
  const s = row?.invoiceSummary ?? {};
  return {
    id: h.id, extId: h.extId, number: h.number, symVar: h.symVar, originalDocument: h.originalDocument,
    ...pick(h, ["date", "dateTax", "dateAccounting", "dateKHDPH", "dateDue", "text"]),
    classificationVAT: h.classificationVAT, paymentType: h.paymentType, partnerIdentity: h.partnerIdentity,
    summary: pick(s, ["roundingDocument", "roundingVAT", "typeCalculateVATInclusivePrice", "homeCurrency", "foreignCurrency"]),
    attachments: row?.attachments
  };
}

function voucherFacts(row: any) {
  const h = row?.voucherHeader ?? {};
  return { ...pick(h, ["id", "extId", "number", "originalDocument", "date", "datePayment", "dateTax", "dateKHDPH", "dateAccounting", "classificationVAT", "text"]), summary: row?.voucherSummary };
}

function seriesFacts(response: PohodaResponse): Array<Record<string, any>> {
  return listedRecords(response, /^numericalSeries$/).map((r) => pick(r.numericalSeriesHeader ?? {}, ["id", "prefix", "number", "topNumber", "name", "agenda", "year"]));
}
