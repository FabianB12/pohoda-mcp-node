import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { extractAccountingUnits, registerPohodaTools } from "../src/mcp/tools.js";
import { ExportStore } from "../src/mcp/export-store.js";
import { PohodaClient } from "../src/pohoda/client.js";
import { XmlDatabaseRegistry } from "../src/pohoda/database-registry.js";
import type { CliXmlJobResult, XmlTransport } from "../src/pohoda/transport.js";

class FakeTransport implements XmlTransport {
  public calls: Array<{ xml: string; database: string }> = [];

  public async exchange(xml: string, database: string): Promise<CliXmlJobResult> {
    this.calls.push({ xml, database });
    const responseXml = xml.includes("listAccountingUnitRequest")
      ? '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"><acu:listAccountingUnit><acu:itemAccountingUnit><acu:year>2026</acu:year><acu:dateFrom>2026-01-01</acu:dateFrom><acu:dateTo>2026-12-31</acu:dateTo><acu:unitType>doubleEntry</acu:unitType><acu:stateType>naturalPerson</acu:stateType><acu:accountingUnitIdentity><typ:address><typ:company>Novák</typ:company><typ:name>Jan</typ:name><typ:city>Jihlava</typ:city><typ:ico>12345678</typ:ico><typ:dic>CZ12345678</typ:dic></typ:address></acu:accountingUnitIdentity><acu:dataFile>12345678_2026.mdb</acu:dataFile></acu:itemAccountingUnit><acu:itemAccountingUnit><acu:year>2025</acu:year><acu:dateFrom>2025-01-01</acu:dateFrom><acu:dateTo>2025-12-31</acu:dateTo><acu:unitType>doubleEntry</acu:unitType><acu:stateType>legalPerson</acu:stateType><acu:accountingUnitIdentity><typ:address><typ:company>Acme Stores</typ:company><typ:city>Praha</typ:city><typ:ico>87654321</typ:ico><typ:dic>CZ87654321</typ:dic></typ:address></acu:accountingUnitIdentity><acu:dataFile>87654321_2025.mdb</acu:dataFile></acu:itemAccountingUnit></acu:listAccountingUnit></rsp:responsePackItem></rsp:responsePack>'
      : xml.includes("listInvoiceRequest") && xml.includes("listStockRequest")
        ? '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="batch-1" state="ok"><lst:listInvoice><lst:invoice><inv:invoiceHeader><inv:id>10</inv:id><inv:number><typ:numberRequested>FV001</typ:numberRequested></inv:number></inv:invoiceHeader></lst:invoice></lst:listInvoice></rsp:responsePackItem><rsp:responsePackItem id="batch-2" state="ok"><lStk:listStock><lStk:stock><stk:id>1</stk:id></lStk:stock></lStk:listStock></rsp:responsePackItem></rsp:responsePack>'
      : xml.includes("listInvoiceRequest")
        ? '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"><lst:listInvoice><lst:invoice><inv:invoiceHeader><inv:id>10</inv:id><inv:number><typ:numberRequested>FV001</typ:numberRequested></inv:number><inv:date>2026-07-02</inv:date><inv:partnerIdentity><typ:address><typ:company>Acme</typ:company><typ:ico>123</typ:ico></typ:address></inv:partnerIdentity><inv:text>Work</inv:text></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceSum>1210</typ:priceSum></inv:homeCurrency></inv:invoiceSummary></lst:invoice><lst:invoice><inv:invoiceHeader><inv:id>11</inv:id><inv:number><typ:numberRequested>FV002</typ:numberRequested></inv:number><inv:date>2026-07-03</inv:date><inv:partnerIdentity><typ:address><typ:company>Beta</typ:company><typ:ico>456</typ:ico></typ:address></inv:partnerIdentity><inv:text>More work</inv:text></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceSum>2420</typ:priceSum></inv:homeCurrency></inv:invoiceSummary></lst:invoice></lst:listInvoice></rsp:responsePackItem></rsp:responsePack>'
        : '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"><lStk:listStock><lStk:stock><stk:id>1</stk:id></lStk:stock></lStk:listStock></rsp:responsePackItem></rsp:responsePack>';
    return {
      xml: responseXml,
      jobId: "job",
      database,
      jobDir: "/tmp/job",
      queueWaitMs: 0,
      processSlotWaitMs: 0,
      durationMs: 1,
      exitCode: 0,
      jobRetained: false
    };
  }

  public status(database = ""): Record<string, unknown> {
    return { transport: "fake", database };
  }
}

class HandlerTransport implements XmlTransport {
  public calls: Array<{ xml: string; database: string }> = [];

  public constructor(private readonly handler: (xml: string, database: string, callIndex: number) => string) {}

  public async exchange(xml: string, database: string): Promise<CliXmlJobResult> {
    const callIndex = this.calls.length;
    this.calls.push({ xml, database });
    return {
      xml: this.handler(xml, database, callIndex),
      jobId: `job-${callIndex + 1}`,
      database,
      jobDir: "/tmp/job",
      queueWaitMs: 0,
      processSlotWaitMs: 0,
      durationMs: 1,
      exitCode: 0,
      jobRetained: false
    };
  }

  public status(database = ""): Record<string, unknown> {
    return { transport: "handler", database };
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MCP tool helpers", () => {
  it("uses the exact accounting-unit dataFile as the XML database selector", () => {
    const units = extractAccountingUnits({
      items: [{
        data: {
          itemAccountingUnit: {
            year: "2026",
            dataFile: "C:\\ProgramData\\STORMWARE\\POHODA\\Data\\12345678_2026.mdb",
            accountingUnitIdentity: {
              address: {
                company: "Novák",
                ico: "12345678"
              }
            }
          }
        }
      }]
    }, 100);

    expect(units[0]?.database).toBe("12345678_2026.mdb");
    expect(units[0]?.id).toBe("12345678_2026.mdb");
    expect(units[0]?.name).toBe("Novák");
  });

  it("registers the expected MCP tools, resources, and safe database helpers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-mcp-tools-"));
    tempDirs.push(dir);
    const registryPath = join(dir, "databases.json");
    await writeFile(registryPath, JSON.stringify([
      { id: "demo", name: "Demo", database: "12345678_2026.mdb", ico: "12345678" }
    ]));

    const fakeServer = new CapturingServer();
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "00000000", database: "" });
    const registry = new XmlDatabaseRegistry({ registryPath });
    const exportStore = new ExportStore(join(dir, "exports"));
    registerPohodaTools(fakeServer as any, { client, databaseRegistry: registry, exportStore });

    expect([...fakeServer.tools.keys()]).toEqual([
      "status", "list_xml_databases", "current_database", "list_accounting_units",
      "list_documents", "list_stock", "list_contacts", "list_export_agenda", "batch_list_records", "list_balance", "create_invoice",
      "create_other_liability", "create_other_receivable", "create_address", "create_cash_voucher", "manage_activity",
      "batch_create_invoices", "batch_write", "create_stock", "create_order", "manage_address", "manage_stock",
      "create_bank_document", "create_internal_document", "create_stock_receipt", "create_stock_issue", "create_stock_transfer",
      "create_production_document", "create_sales_receipt", "create_offer", "create_enquiry", "manage_contract",
      "manage_centre", "manage_store", "manage_storage", "manage_bank_account", "manage_group_stock",
      "manage_parameter_definition", "print", "raw_xml", "raw_xml_batch",
      "create_data_export", "create_data_export_bundle", "read_export_page", "summarize_export", "cleanup_export"
    ]);
    expect([...fakeServer.resources.keys()]).toContain("guide");
    expect(fakeServer.tools.get("list_export_agenda")?.config.inputSchema.agenda.options).not.toContain("userAgenda");
    expect(fakeServer.tools.get("list_export_agenda")?.config.inputSchema.agenda.options).not.toContain("measureUnit");
    expect(fakeServer.tools.has("select_database")).toBe(false);

    const current = await fakeServer.call("current_database", { includeStatus: true });
    expect(JSON.parse(current.content[0].text).database).toBe("");

    await expect(fakeServer.call("list_documents", { agenda: "invoice", invoiceType: "", documentType: "", limit: 1 }))
      .rejects.toThrow(/invoiceType is required/);
    await expect(fakeServer.call("list_stock", { limit: 1, databaseId: "" }))
      .rejects.toThrow(/databaseId is required/);
    await fakeServer.call("list_stock", { limit: 1, databaseId: "demo" });
    expect(transport.calls.at(-1)?.database).toBe("12345678_2026.mdb");
    expect(transport.calls.at(-1)?.xml).toContain('ico="12345678"');
    expect(transport.calls.at(-1)?.xml).not.toContain('ico="00000000"');
    await fakeServer.call("list_documents", { agenda: "invoice", invoiceType: "commitment", documentType: "", limit: 1, databaseId: "demo" });
    expect(transport.calls.at(-1)?.xml).toContain('invoiceType="commitment"');

    const units = await fakeServer.call("list_accounting_units", {
      query: "novak",
      limit: 1,
      cursor: "",
      includeRaw: false,
      ico: "",
      dic: "",
      year: 0,
      database: "",
      city: ""
    });
    expect(units.structuredContent.total).toBe(1);
    expect(units.structuredContent.units[0].name).toBe("Novák");
    expect(units.structuredContent.units[0].personName).toBe("Jan");
    expect(units.structuredContent.units[0].city).toBe("Jihlava");

    const typoUnits = await fakeServer.call("list_accounting_units", {
      query: "nvoak",
      limit: 10,
      cursor: "",
      includeRaw: false,
      ico: "",
      dic: "",
      year: 0,
      database: "",
      city: ""
    });
    expect(typoUnits.structuredContent.units[0].name).toBe("Novák");

    const filteredUnits = await fakeServer.call("list_accounting_units", {
      query: "",
      limit: 10,
      cursor: "",
      includeRaw: false,
      ico: "87654321",
      dic: "",
      year: 2025,
      database: "",
      city: "praha"
    });
    expect(filteredUnits.structuredContent.total).toBe(1);
    expect(filteredUnits.structuredContent.units[0].name).toBe("Acme Stores");

    const batchDefaults = {
      requestId: "",
      documentType: "",
      id: 0,
      extId: "",
      extSystemName: "",
      dateFrom: "",
      dateTill: "",
      company: "",
      ico: "",
      number: "",
      code: "",
      name: "",
      city: "",
      street: "",
      zip: "",
      dic: "",
      EAN: "",
      PLU: 0,
      storage: "",
      store: "",
      lastChanges: "",
      userFilterName: "",
      queryFilter: "",
      idFrom: 0,
      count: 0,
      limit: 5
    };
    const batched = await fakeServer.call("batch_list_records", {
      databaseId: "demo",
      dataPackId: "batch-read",
      operations: [
        { ...batchDefaults, requestId: "invoices", tool: "list_documents", agenda: "invoice", invoiceType: "issuedInvoice" },
        { ...batchDefaults, requestId: "stock", tool: "list_stock", agenda: "stock", invoiceType: "" }
      ]
    });
    expect(batched.structuredContent.ok).toBe(true);
    expect(batched.structuredContent.operationCount).toBe(2);
    expect(batched.structuredContent.results.map((result: any) => result.requestId)).toEqual(["invoices", "stock"]);
    expect(transport.calls.at(-1)?.database).toBe("12345678_2026.mdb");
    expect(transport.calls.at(-1)?.xml).toContain('id="batch-read-1"');
    expect(transport.calls.at(-1)?.xml).toContain('id="batch-read-2"');

    const invoiceBatch = await fakeServer.call("batch_create_invoices", {
      databaseId: "demo",
      dataPackId: "batch-create",
      invoices: [
        {
          requestId: "alpha",
          createAddress: true,
          address: { company: "Alpha", ico: "111", dic: "", street: "Main 1", city: "Praha", zip: "11000", phone: "", email: "alpha@example.test" },
          invoice: invoiceInputDefaults({ type: "issuedInvoice", partnerName: "Alpha", partnerIco: "111", date: "2026-07-02", items: [{ text: "Work", quantity: 1, unit: "ks", unitPrice: 100, vatRate: "high", stockCode: "" }] })
        },
        {
          requestId: "beta",
          createAddress: false,
          address: { company: "", ico: "", dic: "", street: "", city: "", zip: "", phone: "", email: "" },
          invoice: invoiceInputDefaults({ type: "issuedInvoice", partnerName: "Beta", partnerIco: "222", date: "2026-07-03", items: [{ text: "More work", quantity: 1, unit: "ks", unitPrice: 200, vatRate: "high", stockCode: "" }] })
        }
      ]
    });
    expect(invoiceBatch.structuredContent.ok).toBe(false);
    expect(invoiceBatch.structuredContent.invoiceCount).toBe(2);
    expect(invoiceBatch.structuredContent.results.map((result: any) => result.requestId)).toEqual(["alpha", "beta"]);
    expect(transport.calls.at(-1)?.database).toBe("12345678_2026.mdb");
    expect(transport.calls.at(-1)?.xml).toContain('id="batch-create-1"');
    expect(transport.calls.at(-1)?.xml).toContain('note="alpha:address"');
    expect(transport.calls.at(-1)?.xml).toContain('id="batch-create-2"');
    expect(transport.calls.at(-1)?.xml).toContain('note="alpha:invoice"');
    expect(transport.calls.at(-1)?.xml).toContain('id="batch-create-3"');
    expect(transport.calls.at(-1)?.xml).toContain('note="beta:invoice"');

    const firstPage = await fakeServer.call("list_accounting_units", {
      query: "",
      limit: 1,
      cursor: "",
      includeRaw: false,
      ico: "",
      dic: "",
      year: 0,
      database: "",
      city: ""
    });
    expect(firstPage.structuredContent.returned).toBe(1);
    expect(firstPage.structuredContent.nextCursor).not.toBe("");
    const secondPage = await fakeServer.call("list_accounting_units", {
      query: "",
      limit: 1,
      cursor: firstPage.structuredContent.nextCursor,
      includeRaw: false,
      ico: "",
      dic: "",
      year: 0,
      database: "",
      city: ""
    });
    expect(secondPage.structuredContent.units[0].name).toBe("Novák");

    const created = await fakeServer.call("create_data_export", {
      kind: "documents",
      agenda: "invoice",
      invoiceType: "issuedInvoice",
      documentType: "",
      pageSize: 10,
      maxRecords: 10,
      previewLimit: 1,
      databaseId: "demo"
    });
    expect(created.structuredContent.count).toBe(2);
    expect(created.structuredContent.preview).toHaveLength(1);
    expect(created.structuredContent.summary.total).toBe(3630);
    expect(transport.calls.at(-1)?.database).toBe("12345678_2026.mdb");
    expect(transport.calls.at(-1)?.xml).toContain('ico="12345678"');
    expect(created.content.some((item: any) => item.type === "resource_link")).toBe(true);

    const exportDefaults = {
      requestId: "",
      invoiceType: "",
      documentType: "",
      id: 0,
      dateFrom: "",
      dateTill: "",
      company: "",
      ico: "",
      number: "",
      lastChanges: "",
      queryFilter: "",
      userFilterName: "",
      pageSize: 5,
      maxRecords: 5,
      previewLimit: 1
    };
    const bundle = await fakeServer.call("create_data_export_bundle", {
      databaseId: "demo",
      dataPackId: "bundle-read",
      exports: [
        { ...exportDefaults, requestId: "issued", kind: "documents", agenda: "invoice", invoiceType: "issuedInvoice" },
        { ...exportDefaults, requestId: "stock", kind: "stock", agenda: "stock" }
      ]
    });
    expect(bundle.structuredContent.ok).toBe(true);
    expect(bundle.structuredContent.exportCount).toBe(2);
    expect(bundle.structuredContent.exports.map((item: any) => item.requestId)).toEqual(["issued", "stock"]);
    expect(bundle.structuredContent.exports[0].resources.recordsNdjson).toContain("records.ndjson");

    const page = await fakeServer.call("read_export_page", {
      exportId: created.structuredContent.exportId,
      limit: 1
    });
    expect(page.structuredContent.records).toHaveLength(1);
    expect(page.structuredContent.nextCursor).not.toBe("");

    const summary = await fakeServer.call("summarize_export", { exportId: created.structuredContent.exportId });
    expect(summary.structuredContent.summary.byPartner.Acme.total).toBe(1210);

    const resource = fakeServer.resources.get("export-file") as any;
    const recordsResource = await resource.handler(new URL(created.structuredContent.resources.recordsNdjson), {
      exportId: created.structuredContent.exportId,
      file: "records.ndjson"
    });
    expect(recordsResource.contents[0].text).toContain("FV001");
  });

  it("infers dataPack ICO from direct database names when no registry is configured", async () => {
    const fakeServer = new CapturingServer();
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "00000000", database: "" });
    registerPohodaTools(fakeServer as any, { client });

    await fakeServer.call("list_stock", {
      limit: 1,
      databaseId: "StwPh_87654321_2026.mdb"
    });

    expect(transport.calls.at(-1)?.database).toBe("StwPh_87654321_2026.mdb");
    expect(transport.calls.at(-1)?.xml).toContain('ico="87654321"');
    expect(transport.calls.at(-1)?.xml).not.toContain('ico="00000000"');
  });

  it("does not use the default ICO for explicit databases whose ICO is unknown", async () => {
    const fakeServer = new CapturingServer();
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "00000000", database: "" });
    registerPohodaTools(fakeServer as any, { client });

    await expect(fakeServer.call("list_stock", {
      limit: 1,
      databaseId: "UnknownCompany.mdb"
    })).rejects.toThrow(/ICO is unknown/);

    expect(transport.calls.at(-1)?.xml).toContain("listAccountingUnitRequest");
    expect(transport.calls.some((call) => call.database === "UnknownCompany.mdb")).toBe(false);
  });

  it("keeps invoice export home and foreign currency totals separate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-mcp-currency-export-"));
    tempDirs.push(dir);
    const fakeServer = new CapturingServer();
    const transport = new HandlerTransport(() =>
      '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"><lst:listInvoice><lst:invoice><inv:invoiceHeader><inv:id>20</inv:id><inv:number><typ:numberRequested>FV-EUR-1</typ:numberRequested></inv:number><inv:date>2026-01-15</inv:date><inv:partnerIdentity><typ:address><typ:company>Martin Bolf</typ:company><typ:ico>999</typ:ico></typ:address></inv:partnerIdentity><inv:text>Foreign invoice</inv:text></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceSum>711723.60</typ:priceSum></inv:homeCurrency><inv:foreignCurrency><typ:currency><typ:ids>EUR</typ:ids></typ:currency><typ:priceSum>29232</typ:priceSum></inv:foreignCurrency></inv:invoiceSummary></lst:invoice><lst:invoice><inv:invoiceHeader><inv:id>21</inv:id><inv:number><typ:numberRequested>FV-EUR-2</typ:numberRequested></inv:number><inv:date>2026-01-20</inv:date><inv:partnerIdentity><typ:address><typ:company>Martin Bolf</typ:company><typ:ico>999</typ:ico></typ:address></inv:partnerIdentity><inv:text>Liquidation fallback</inv:text></inv:invoiceHeader><inv:invoiceSummary><inv:foreignCurrency><typ:currency><typ:ids>EUR</typ:ids></typ:currency></inv:foreignCurrency></inv:invoiceSummary><inv:liquidations><typ:liquidation><typ:amountHome>100</typ:amountHome><typ:amountForeign>4</typ:amountForeign></typ:liquidation></inv:liquidations></lst:invoice></lst:listInvoice></rsp:responsePackItem></rsp:responsePack>'
    );
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    registerPohodaTools(fakeServer as any, { client, exportStore: new ExportStore(join(dir, "exports")) });

    const created = await fakeServer.call("create_data_export", {
      kind: "documents",
      agenda: "invoice",
      invoiceType: "issuedInvoice",
      documentType: "",
      pageSize: 10,
      maxRecords: 10,
      previewLimit: 1,
      databaseId: ""
    });

    expect(created.structuredContent.summary.count).toBe(2);
    expect(created.structuredContent.summary.total).toBe(711823.6);
    expect(created.structuredContent.summary.byCurrency.CZK).toEqual({ count: 2, total: 711823.6 });
    expect(created.structuredContent.summary.homeCurrency).toEqual({ currency: "CZK", total: 711823.6 });
    expect(created.structuredContent.summary.foreignCurrency.EUR).toEqual({ count: 2, total: 29236 });
    expect(created.structuredContent.preview[0].currency).toBe("CZK");
    expect(created.structuredContent.preview[0].homeCurrency).toEqual({ currency: "CZK", total: 711723.6 });
    expect(created.structuredContent.preview[0].foreignCurrency).toEqual({ currency: "EUR", total: 29232 });

    const page = await fakeServer.call("read_export_page", {
      exportId: created.structuredContent.exportId,
      limit: 10
    });
    expect(page.structuredContent.records[0].currency).toBe("CZK");
    expect(page.structuredContent.records[0].foreignCurrency).toEqual({ currency: "EUR", total: 29232 });
    expect(page.structuredContent.records[1].homeCurrency).toEqual({ currency: "CZK", total: 100 });
    expect(page.structuredContent.records[1].foreignCurrency).toEqual({ currency: "EUR", total: 4 });

    const summary = await fakeServer.call("summarize_export", { exportId: created.structuredContent.exportId });
    expect(summary.structuredContent.summary.homeCurrency).toEqual({ currency: "CZK", total: 711823.6 });
    expect(summary.structuredContent.summary.foreignCurrency.EUR).toEqual({ count: 2, total: 29236 });
  });

  it("refreshes XML database discovery without restarting the MCP server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-mcp-refresh-"));
    tempDirs.push(dir);
    const dataDir = join(dir, "Data");
    await mkdir(dataDir);
    await writeFile(join(dataDir, "StwPh_11111111_2026.mdb"), "");

    const fakeServer = new CapturingServer();
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "00000000", database: "" });
    registerPohodaTools(fakeServer as any, {
      client,
      databaseRegistry: new XmlDatabaseRegistry({ dataDir }),
      exportStore: new ExportStore(join(dir, "exports"))
    });

    const first = await fakeServer.call("list_xml_databases", { includeLive: false, liveLimit: 100 });
    expect(JSON.parse(first.content[0].text).databases.map((item: any) => item.database)).toEqual(["StwPh_11111111_2026.mdb"]);

    await writeFile(join(dataDir, "StwPh_22222222_2026.mdb"), "");
    const second = await fakeServer.call("list_xml_databases", { includeLive: false, liveLimit: 100 });
    expect(JSON.parse(second.content[0].text).databases.map((item: any) => item.database).sort()).toEqual([
      "StwPh_11111111_2026.mdb",
      "StwPh_22222222_2026.mdb"
    ]);
  });

  it("hardens batch read validation, partial failures, missing items, and truncation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-mcp-batch-edge-"));
    tempDirs.push(dir);
    const fakeServer = new CapturingServer();
    const transport = new HandlerTransport((xml) => {
      if (xml.includes("missing-response")) {
        return '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="only-one" state="ok"><lStk:listStock><lStk:stock><stk:id>1</stk:id></lStk:stock></lStk:listStock></rsp:responsePackItem></rsp:responsePack>';
      }
      if (xml.includes("truncate-response")) {
        return '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="many" state="ok"><lst:listInvoice><lst:invoice><inv:invoiceHeader><inv:id>1</inv:id></inv:invoiceHeader></lst:invoice><lst:invoice><inv:invoiceHeader><inv:id>2</inv:id></inv:invoiceHeader></lst:invoice></lst:listInvoice></rsp:responsePackItem></rsp:responsePack>';
      }
      return '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="ok" state="ok"><lStk:listStock><lStk:stock><stk:id>1</stk:id></lStk:stock></lStk:listStock></rsp:responsePackItem><rsp:responsePackItem id="bad" state="error"><rsp:importDetails><rsp:detail><rsp:state>error</rsp:state><rsp:note>Rejected by POHODA</rsp:note></rsp:detail></rsp:importDetails></rsp:responsePackItem></rsp:responsePack>';
    });
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    registerPohodaTools(fakeServer as any, { client, exportStore: new ExportStore(join(dir, "exports")) });

    await expect(fakeServer.call("batch_list_records", {
      databaseId: "",
      dataPackId: "bad-invoice",
      operations: [
        { ...batchOperationDefaults(), requestId: "bad", tool: "list_documents", agenda: "invoice", invoiceType: "" }
      ]
    })).rejects.toThrow(/invoiceType is required/);
    expect(transport.calls).toHaveLength(0);

    await expect(fakeServer.call("batch_list_records", {
      databaseId: "",
      dataPackId: "bad-ext",
      operations: [
        { ...batchOperationDefaults(), requestId: "bad-ext", tool: "list_stock", agenda: "stock", extId: "abc" }
      ]
    })).rejects.toThrow(/extSystemName is required/);
    expect(transport.calls).toHaveLength(0);

    const partial = await fakeServer.call("batch_list_records", {
      databaseId: "",
      dataPackId: "partial-response",
      operations: [
        { ...batchOperationDefaults(), requestId: "ok-stock", tool: "list_stock", agenda: "stock", limit: 1 },
        { ...batchOperationDefaults(), requestId: "bad-contacts", tool: "list_contacts", agenda: "addressbook", limit: 1 }
      ]
    });
    expect(partial.structuredContent.ok).toBe(false);
    expect(partial.structuredContent.results.map((result: any) => result.state)).toEqual(["ok", "error"]);
    expect(partial.structuredContent.results[0].data.stock.id).toBe("1");

    const missing = await fakeServer.call("batch_list_records", {
      databaseId: "",
      dataPackId: "missing-response",
      operations: [
        { ...batchOperationDefaults(), requestId: "stock", tool: "list_stock", agenda: "stock", limit: 1 },
        { ...batchOperationDefaults(), requestId: "contacts", tool: "list_contacts", agenda: "addressbook", limit: 1 }
      ]
    });
    expect(missing.structuredContent.ok).toBe(false);
    expect(missing.structuredContent.results[1].state).toBe("missing");

    const truncated = await fakeServer.call("batch_list_records", {
      databaseId: "",
      dataPackId: "truncate-response",
      operations: [
        { ...batchOperationDefaults(), requestId: "issued", tool: "list_documents", agenda: "invoice", invoiceType: "issuedInvoice", limit: 1, count: 2 }
      ]
    });
    expect(truncated.structuredContent.results[0].data.invoice).toHaveLength(1);
    expect(truncated.structuredContent.results[0].truncated).toMatch(/Showing first 1 of 2/);
  });

  it("maps typed batch invoice create responses and validates address derivation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-mcp-batch-create-"));
    tempDirs.push(dir);
    const registryPath = join(dir, "databases.json");
    await writeFile(registryPath, JSON.stringify([
      { id: "demo", name: "Demo", database: "12345678_2026.mdb", ico: "12345678" }
    ]));

    const fakeServer = new CapturingServer();
    const transport = new HandlerTransport(() =>
      '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="create-1" state="ok"><adb:addressbookResponse><rdc:producedDetails><rdc:id>501</rdc:id><rdc:actionType>add</rdc:actionType></rdc:producedDetails></adb:addressbookResponse></rsp:responsePackItem><rsp:responsePackItem id="create-2" state="ok"><inv:invoiceResponse><rdc:producedDetails><rdc:id>601</rdc:id><rdc:number>260100001</rdc:number><rdc:actionType>add</rdc:actionType></rdc:producedDetails></inv:invoiceResponse></rsp:responsePackItem><rsp:responsePackItem id="create-3" state="ok"><adb:addressbookResponse><rdc:producedDetails><rdc:id>502</rdc:id><rdc:actionType>add</rdc:actionType></rdc:producedDetails></adb:addressbookResponse></rsp:responsePackItem><rsp:responsePackItem id="create-4" state="ok"><inv:invoiceResponse><rdc:producedDetails><rdc:id>602</rdc:id><rdc:number>260100002</rdc:number><rdc:actionType>add</rdc:actionType></rdc:producedDetails></inv:invoiceResponse></rsp:responsePackItem></rsp:responsePack>'
    );
    const client = new PohodaClient({ transport, ico: "00000000", database: "" });
    const registry = new XmlDatabaseRegistry({ registryPath });
    registerPohodaTools(fakeServer as any, { client, databaseRegistry: registry });

    const result = await fakeServer.call("batch_create_invoices", {
      databaseId: "demo",
      dataPackId: "create",
      invoices: [
        {
          requestId: "alpha",
          createAddress: true,
          address: { company: "", ico: "", dic: "", street: "", city: "", zip: "", phone: "", email: "" },
          invoice: invoiceInputDefaults({ type: "issuedInvoice", partnerName: "Alpha", partnerIco: "111", partnerStreet: "Main 1", partnerCity: "Praha", partnerZip: "11000", date: "2026-07-02", items: [{ text: "Work", quantity: 1, unit: "ks", unitPrice: 100, vatRate: "high", stockCode: "" }] })
        },
        {
          requestId: "beta",
          createAddress: true,
          address: { company: "Beta Billing", ico: "222", dic: "", street: "Side 2", city: "Brno", zip: "60200", phone: "", email: "" },
          invoice: invoiceInputDefaults({ type: "issuedInvoice", partnerName: "Beta", partnerIco: "222", date: "2026-07-03", items: [{ text: "More work", quantity: 1, unit: "ks", unitPrice: 200, vatRate: "high", stockCode: "" }] })
        }
      ]
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.invoiceCount).toBe(2);
    expect(result.structuredContent.dataPackItemCount).toBe(4);
    expect(result.structuredContent.results.map((row: any) => row.ok)).toEqual([true, true]);
    expect(result.structuredContent.results[0].invoice.producedDetails.number).toBe("260100001");
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.database).toBe("12345678_2026.mdb");
    expect(transport.calls[0]?.xml).toContain('id="create-1"');
    expect(transport.calls[0]?.xml).toContain('note="alpha:address"');
    expect(transport.calls[0]?.xml).toContain("<typ:company>Alpha</typ:company>");
    expect(transport.calls[0]?.xml).toContain('id="create-4"');
    expect(transport.calls[0]?.xml).toContain('note="beta:invoice"');

    await expect(fakeServer.call("batch_create_invoices", {
      databaseId: "demo",
      dataPackId: "bad",
      invoices: [{
        requestId: "missing-partner",
        createAddress: true,
        address: { company: "", ico: "", dic: "", street: "", city: "", zip: "", phone: "", email: "" },
        invoice: invoiceInputDefaults({ type: "issuedInvoice", items: [{ text: "Work", quantity: 1, unit: "ks", unitPrice: 100, vatRate: "high", stockCode: "" }] })
      }]
    })).rejects.toThrow(/address.company or invoice.partnerName is required/);
  });

  it("maps universal batch_write responses for mixed typed operations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-mcp-batch-write-"));
    tempDirs.push(dir);
    const registryPath = join(dir, "databases.json");
    await writeFile(registryPath, JSON.stringify([
      { id: "demo", name: "Demo", database: "12345678_2026.mdb", ico: "12345678" }
    ]));

    const fakeServer = new CapturingServer();
    const transport = new HandlerTransport(() =>
      '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="write-1" state="ok"><adb:addressbookResponse><rdc:producedDetails><rdc:id>701</rdc:id><rdc:actionType>add</rdc:actionType></rdc:producedDetails></adb:addressbookResponse></rsp:responsePackItem><rsp:responsePackItem id="write-2" state="ok"><stk:stockResponse><rdc:producedDetails><rdc:id>801</rdc:id><rdc:actionType>add</rdc:actionType></rdc:producedDetails></stk:stockResponse></rsp:responsePackItem><rsp:responsePackItem id="write-3" state="ok"><ord:orderResponse><rdc:producedDetails><rdc:id>901</rdc:id><rdc:number>OBJ001</rdc:number><rdc:actionType>add</rdc:actionType></rdc:producedDetails></ord:orderResponse></rsp:responsePackItem></rsp:responsePack>'
    );
    const client = new PohodaClient({ transport, ico: "00000000", database: "" });
    const registry = new XmlDatabaseRegistry({ registryPath });
    registerPohodaTools(fakeServer as any, { client, databaseRegistry: registry });

    const result = await fakeServer.call("batch_write", {
      databaseId: "demo",
      dataPackId: "write",
      operations: [
        { requestId: "addr", tool: "create_address", data: { company: "Alpha", ico: "111", dic: "", street: "", city: "", zip: "", phone: "", email: "" } },
        { requestId: "stock", tool: "create_stock", data: { code: "S-1", name: "Service", sellingPrice: 500, unit: "ks", storage: "", vatRate: "high", purchasingPrice: 0, EAN: "", PLU: 0, isSales: true, isInternet: false, description: "", description2: "", limitMin: 0, limitMax: 0, mass: 0, supplierId: 0, guarantee: 0, guaranteeType: "year", shortName: "", nameComplement: "", note: "" } },
        { requestId: "order", tool: "create_order", data: { type: "issuedOrder", partnerName: "Alpha", date: "2026-07-02", partnerIco: "111", items: [{ text: "Work", quantity: 1, unit: "ks", unitPrice: 100, vatRate: "high", stockCode: "" }] } }
      ]
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.operationCount).toBe(3);
    expect(result.structuredContent.results.map((row: any) => row.tool)).toEqual(["create_address", "create_stock", "create_order"]);
    expect(result.structuredContent.results[2].producedDetails.number).toBe("OBJ001");
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.database).toBe("12345678_2026.mdb");
    expect(transport.calls[0]?.xml).toContain('id="write-1"');
    expect(transport.calls[0]?.xml).toContain('note="addr:create_address"');
    expect(transport.calls[0]?.xml).toContain("<adb:addressbook");
    expect(transport.calls[0]?.xml).toContain('id="write-2"');
    expect(transport.calls[0]?.xml).toContain('note="stock:create_stock"');
    expect(transport.calls[0]?.xml).toContain("<stk:stock");
    expect(transport.calls[0]?.xml).toContain('id="write-3"');
    expect(transport.calls[0]?.xml).toContain('note="order:create_order"');
    expect(transport.calls[0]?.xml).toContain("<ord:order");
  });

  it("maps batch_write responses for cash vouchers, other documents, and activities", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-mcp-new-batch-write-"));
    tempDirs.push(dir);
    const registryPath = join(dir, "databases.json");
    await writeFile(registryPath, JSON.stringify([
      { id: "demo", name: "Demo", database: "12345678_2026.mdb", ico: "12345678" }
    ]));

    const fakeServer = new CapturingServer();
    const transport = new HandlerTransport(() =>
      '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="write-1" state="ok"><vch:voucherResponse><rdc:producedDetails><rdc:id>1001</rdc:id><rdc:actionType>add</rdc:actionType></rdc:producedDetails></vch:voucherResponse></rsp:responsePackItem><rsp:responsePackItem id="write-2" state="ok"><inv:invoiceResponse><rdc:producedDetails><rdc:id>1002</rdc:id><rdc:actionType>add</rdc:actionType></rdc:producedDetails></inv:invoiceResponse></rsp:responsePackItem><rsp:responsePackItem id="write-3" state="ok"><inv:invoiceResponse><rdc:producedDetails><rdc:id>1003</rdc:id><rdc:actionType>add</rdc:actionType></rdc:producedDetails></inv:invoiceResponse></rsp:responsePackItem><rsp:responsePackItem id="write-4" state="ok"><acv:activityResponse><rdc:producedDetails><rdc:id>1004</rdc:id><rdc:actionType>add</rdc:actionType></rdc:producedDetails></acv:activityResponse></rsp:responsePackItem></rsp:responsePack>'
    );
    const client = new PohodaClient({ transport, ico: "00000000", database: "" });
    const registry = new XmlDatabaseRegistry({ registryPath });
    registerPohodaTools(fakeServer as any, { client, databaseRegistry: registry });

    const result = await fakeServer.call("batch_write", {
      databaseId: "demo",
      dataPackId: "write-new",
      operations: [
        {
          requestId: "voucher",
          tool: "create_cash_voucher",
          data: { type: "receipt", cashAccount: "HLAVNI", date: "2026-07-02", text: "Cash receipt", items: [{ text: "Paid", quantity: 1, unit: "ks", unitPrice: 121, vatRate: "high", stockCode: "" }] }
        },
        {
          requestId: "liability",
          tool: "create_other_liability",
          data: { partnerName: "Supplier", date: "2026-07-02", text: "Other liability", sphereType: "business", paymentAccountNumber: "123456", paymentBankCode: "0100", items: [{ text: "Fee", quantity: 1, unit: "ks", unitPrice: 200, vatRate: "none", stockCode: "" }] }
        },
        {
          requestId: "receivable",
          tool: "create_other_receivable",
          data: { partnerName: "Customer", date: "2026-07-02", text: "Other receivable", sphereType: "business", items: [{ text: "Charge", quantity: 1, unit: "ks", unitPrice: 300, vatRate: "none", stockCode: "" }] }
        },
        {
          requestId: "activity",
          tool: "manage_activity",
          data: { action: "add", id: 0, matchId: 0, code: "CONSULT", name: "Consulting", taxType: "", note: "" }
        }
      ]
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.operationCount).toBe(4);
    expect(result.structuredContent.results.map((row: any) => row.tool)).toEqual(["create_cash_voucher", "create_other_liability", "create_other_receivable", "manage_activity"]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.database).toBe("12345678_2026.mdb");
    expect(transport.calls[0]?.xml).toContain('ico="12345678"');
    expect(transport.calls[0]?.xml).toContain('note="voucher:create_cash_voucher"');
    expect(transport.calls[0]?.xml).toContain("<vch:voucher");
    expect(transport.calls[0]?.xml).toContain("<vch:voucherType>receipt</vch:voucherType>");
    expect(transport.calls[0]?.xml).toContain('note="liability:create_other_liability"');
    expect(transport.calls[0]?.xml).toContain("<inv:invoiceType>commitment</inv:invoiceType>");
    expect(transport.calls[0]?.xml).toContain("<typ:accountNo>123456</typ:accountNo>");
    expect(transport.calls[0]?.xml).toContain('note="receivable:create_other_receivable"');
    expect(transport.calls[0]?.xml).toContain("<inv:invoiceType>receivable</inv:invoiceType>");
    expect(transport.calls[0]?.xml).toContain('note="activity:manage_activity"');
    expect(transport.calls[0]?.xml).toContain("<acv:activity");
    expect(transport.calls[0]?.xml).toContain("<acv:code>CONSULT</acv:code>");
  });

  it("batches export bundle page rounds and preserves independent snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-mcp-bundle-edge-"));
    tempDirs.push(dir);
    const fakeServer = new CapturingServer();
    const transport = new HandlerTransport((xml, _database, callIndex) => {
      const invoiceId = callIndex === 0 ? 10 : 11;
      const stockId = callIndex === 0 ? 20 : 21;
      return `<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="invoice-${callIndex}" state="ok"><lst:listInvoice><lst:invoice><inv:invoiceHeader><inv:id>${invoiceId}</inv:id><inv:number><typ:numberRequested>FV${invoiceId}</typ:numberRequested></inv:number><inv:date>2026-07-0${callIndex + 1}</inv:date><inv:partnerIdentity><typ:address><typ:company>Partner ${invoiceId}</typ:company></typ:address></inv:partnerIdentity></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceSum>${invoiceId * 10}</typ:priceSum></inv:homeCurrency></inv:invoiceSummary></lst:invoice></lst:listInvoice></rsp:responsePackItem><rsp:responsePackItem id="stock-${callIndex}" state="ok"><lStk:listStock><lStk:stock><stk:stockHeader><stk:id>${stockId}</stk:id><stk:code>S${stockId}</stk:code><stk:name>Stock ${stockId}</stk:name><stk:sellingPrice>${stockId * 5}</stk:sellingPrice></stk:stockHeader></lStk:stock></lStk:listStock></rsp:responsePackItem></rsp:responsePack>`;
    });
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    registerPohodaTools(fakeServer as any, { client, exportStore: new ExportStore(join(dir, "exports")) });

    const bundle = await fakeServer.call("create_data_export_bundle", {
      databaseId: "",
      dataPackId: "x".repeat(64),
      exports: [
        { ...exportSpecDefaults(), requestId: "issued", kind: "documents", agenda: "invoice", invoiceType: "issuedInvoice", pageSize: 1, maxRecords: 2, previewLimit: 2 },
        { ...exportSpecDefaults(), requestId: "stock", kind: "stock", agenda: "stock", pageSize: 1, maxRecords: 2, previewLimit: 2 }
      ]
    });

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.xml).toContain(`${"x".repeat(61)}-r1-1`);
    expect(transport.calls[0]?.xml).toContain(`${"x".repeat(61)}-r1-2`);
    expect(transport.calls[1]?.xml).toContain("<ftr:idFrom>11</ftr:idFrom>");
    expect(transport.calls[1]?.xml).toContain("<ftr:idFrom>21</ftr:idFrom>");
    expect(bundle.structuredContent.exportCount).toBe(2);
    expect(bundle.structuredContent.exports[0].count).toBe(2);
    expect(bundle.structuredContent.exports[1].count).toBe(2);
    expect(bundle.structuredContent.exports[0].summary.total).toBe(210);
    expect(bundle.structuredContent.exports[1].summary.total).toBe(205);

    const issuedPage = await fakeServer.call("read_export_page", {
      exportId: bundle.structuredContent.exports[0].exportId,
      limit: 10
    });
    const stockPage = await fakeServer.call("read_export_page", {
      exportId: bundle.structuredContent.exports[1].exportId,
      limit: 10
    });
    expect(issuedPage.structuredContent.records.map((record: any) => record.id)).toEqual([10, 11]);
    expect(stockPage.structuredContent.records.map((record: any) => record.id)).toEqual([20, 21]);
  });
});

function batchOperationDefaults(): Record<string, unknown> {
  return {
    requestId: "",
    invoiceType: "",
    documentType: "",
    id: 0,
    extId: "",
    extSystemName: "",
    dateFrom: "",
    dateTill: "",
    company: "",
    ico: "",
    number: "",
    code: "",
    name: "",
    city: "",
    street: "",
    zip: "",
    dic: "",
    EAN: "",
    PLU: 0,
    storage: "",
    store: "",
    lastChanges: "",
    userFilterName: "",
    queryFilter: "",
    idFrom: 0,
    count: 0,
    limit: 5
  };
}

function exportSpecDefaults(): Record<string, unknown> {
  return {
    requestId: "",
    invoiceType: "",
    documentType: "",
    id: 0,
    dateFrom: "",
    dateTill: "",
    company: "",
    ico: "",
    number: "",
    lastChanges: "",
    queryFilter: "",
    userFilterName: "",
    pageSize: 5,
    maxRecords: 5,
    previewLimit: 1
  };
}

function invoiceInputDefaults(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "issuedInvoice",
    items: [],
    number: "",
    partnerName: "",
    date: "",
    partnerIco: "",
    partnerStreet: "",
    partnerCity: "",
    partnerZip: "",
    partnerId: 0,
    text: "",
    symVar: "",
    dateDue: "",
    dateTax: "",
    dateAccounting: "",
    paymentType: "",
    accountIds: "",
    accounting: "",
    classificationVAT: "",
    centre: "",
    activity: "",
    contract: "",
    currency: "",
    currencyRate: 0,
    note: "",
    intNote: "",
    ...overrides
  };
}

class CapturingServer {
  public readonly tools = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
  public readonly resources = new Map<string, { uri: unknown; config: any; handler: (uri: URL, variables?: any) => Promise<any> }>();

  public registerTool(name: string, config: any, handler: (args: any) => Promise<any>): void {
    this.tools.set(name, { config, handler });
  }

  public registerResource(name: string, uri: unknown, config: any, handler: any): void {
    this.resources.set(name, { uri, config, handler });
  }

  public async call(name: string, args: Record<string, unknown>): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Missing tool ${name}`);
    }
    return tool.handler(args);
  }
}
