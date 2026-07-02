import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentAgendas, exportAgendas } from "../src/pohoda/constants.js";
import { PohodaClient, type WriteBatchOperation } from "../src/pohoda/client.js";
import type { PohodaResponse } from "../src/pohoda/response.js";
import { CliXmlTransport } from "../src/pohoda/transport.js";
import { assertOk, extractAccountingUnits, registerPohodaTools } from "../src/mcp/tools.js";
import { ExportStore } from "../src/mcp/export-store.js";
import { createUtmProcessRunner, optionsFromEnv, UtmPohodaTransport } from "./support/utm-pohoda.js";

const options = optionsFromEnv();
const runIfConfigured = options ? describe : describe.skip;
const fullLiveSuite = /^(1|true|yes|on)$/i.test(process.env.POHODA_UTM_FULL ?? "");
const runMutatingIfEnabled = options && /^(1|true|yes|on)$/i.test(process.env.POHODA_UTM_MUTATION ?? "") ? describe : describe.skip;

runIfConfigured("POHODA UTM integration", () => {
  let transport: UtmPohodaTransport;
  let client: PohodaClient;
  let database = "";

  beforeAll(async () => {
    transport = new UtmPohodaTransport(options!);
    client = new PohodaClient({ transport, ico: options!.ico, database: options!.database });
  });

  afterAll(async () => {
    await transport?.cleanup();
  });

  it("discovers accounting units and selects a real demo database", async () => {
    const accounting = assertOk(await client.listAccountingUnits());
    const units = extractAccountingUnits(accounting, 100);
    database = options!.database || units[0]?.database || "";
    expect(units.length).toBeGreaterThan(0);
    expect(database).toMatch(/\.mdb$/i);
    client.setContext(database, units.find((unit) => unit.database === database)?.ico ?? options!.ico);

    const fakeServer = new CapturingServer();
    registerPohodaTools(fakeServer as any, { client });
    const firstPage = await fakeServer.call("list_accounting_units", {
      query: "",
      ico: "",
      dic: "",
      year: 0,
      database: "",
      city: "",
      cursor: "",
      limit: 1,
      includeRaw: false
    });
    expect(firstPage.structuredContent.returned).toBe(1);
    expect(firstPage.structuredContent.units[0].database).toMatch(/\.mdb$/i);

    const discovered = units.find((unit) => unit.database === database) ?? units[0]!;
    const filtered = await fakeServer.call("list_accounting_units", {
      query: discovered.name.toLowerCase(),
      ico: discovered.ico ?? "",
      dic: "",
      year: discovered.year ?? 0,
      database: "",
      city: "",
      cursor: "",
      limit: 5,
      includeRaw: false
    });
    expect(filtered.structuredContent.total).toBeGreaterThan(0);
    expect(filtered.structuredContent.units.some((unit: any) => unit.database === discovered.database)).toBe(true);
  }, 180_000);

  it("runs a lightweight core read/export smoke against the real POHODA demo database", async () => {
    await ensureDatabase();
    const stock = await client.listRecords("stock", {}, "", { count: 1 });
    expectPohodaOk(stock);

    const workDir = await mkdtemp(join(tmpdir(), "pohoda-utm-smoke-"));
    const fakeServer = new CapturingServer();
    try {
      registerPohodaTools(fakeServer as any, {
        client,
        exportStore: new ExportStore(join(workDir, "exports"))
      });
      const batchDefaults = {
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
        limit: 1
      };
      const batched = await fakeServer.call("batch_list_records", {
        databaseId: database,
        dataPackId: "utm-smoke-batch-read",
        operations: [
          { ...batchDefaults, requestId: "stock", tool: "list_stock", agenda: "stock" },
          { ...batchDefaults, requestId: "contacts", tool: "list_contacts", agenda: "addressbook" }
        ]
      });
      expect(batched.structuredContent.ok).toBe(true);
      expect(batched.structuredContent.results).toHaveLength(2);

      const created = await fakeServer.call("create_data_export", {
        kind: "documents",
        agenda: "invoice",
        invoiceType: "issuedInvoice",
        documentType: "",
        pageSize: 2,
        maxRecords: 2,
        previewLimit: 1,
        databaseId: database
      });
      expect(created.structuredContent.count).toBeGreaterThan(0);
      expect(created.structuredContent.preview.length).toBeGreaterThan(0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 240_000);

  it.runIf(fullLiveSuite)("runs all read-only MCP-backed list methods against the real POHODA demo database", async () => {
    await ensureDatabase();
    const failures: string[] = [];

    await check("list_stock", () => client.listRecords("stock", {}, "", { count: 2 }));
    await check("list_contacts", () => client.listRecords("addressbook", {}, "", { count: 2 }));

    for (const agenda of documentAgendas) {
      const subtype = agenda === "invoice" ? "issuedInvoice" : agenda === "order" ? "receivedOrder" : "";
      await check(`list_documents:${agenda}`, () => client.listRecords(agenda, {}, subtype, { count: 1 }));
    }

    for (const agenda of exportAgendas) {
      await check(`list_export_agenda:${agenda}`, () => client.listRecords(agenda, {}, "", { count: 1 }));
    }

    expect(failures).toEqual([]);

    async function check(name: string, fn: () => Promise<PohodaResponse>): Promise<void> {
      try {
        const response = await fn();
        if (!response.isOk()) {
          failures.push(`${name}: ${JSON.stringify(response.toArray())}`);
        }
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, 900_000);

  it.runIf(fullLiveSuite)("runs safe raw_xml and raw_xml_batch read requests against the real database", async () => {
    await ensureDatabase();
    const stockXml = '<lStk:listStockRequest version="2.0" stockVersion="2.0"><lStk:limit><ftr:count>1</ftr:count></lStk:limit><lStk:requestStock/></lStk:listStockRequest>';
    const contactsXml = '<lAdb:listAddressBookRequest version="2.0" addressBookVersion="2.0"><lAdb:limit><ftr:count>1</ftr:count></lAdb:limit><lAdb:requestAddressBook/></lAdb:listAddressBookRequest>';

    expect((await client.sendRawXml(stockXml, "raw stock", "utm-raw-stock", { databaseOverride: database, checkDuplicity: false })).isOk()).toBe(true);
    expect((await client.sendRawXmlBatch([stockXml, contactsXml], "raw batch", "utm-raw-batch", { databaseOverride: database, checkDuplicity: false })).isOk()).toBe(true);
  }, 240_000);

  it.runIf(fullLiveSuite)("creates a compact persisted invoice export and reads pages/resources", async () => {
    await ensureDatabase();
    const workDir = await mkdtemp(join(tmpdir(), "pohoda-utm-export-"));
    try {
      const fakeServer = new CapturingServer();
      registerPohodaTools(fakeServer as any, {
        client,
        exportStore: new ExportStore(join(workDir, "exports"))
      });
      const batchDefaults = {
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
        limit: 1
      };
      const batched = await fakeServer.call("batch_list_records", {
        databaseId: database,
        dataPackId: "utm-batch-read",
        operations: [
          { ...batchDefaults, requestId: "stock", tool: "list_stock", agenda: "stock" },
          { ...batchDefaults, requestId: "contacts", tool: "list_contacts", agenda: "addressbook" }
        ]
      });
      expect(batched.structuredContent.ok).toBe(true);
      expect(batched.structuredContent.results).toHaveLength(2);

      const created = await fakeServer.call("create_data_export", {
        kind: "documents",
        agenda: "invoice",
        invoiceType: "issuedInvoice",
        documentType: "",
        pageSize: 10,
        maxRecords: 10,
        previewLimit: 2,
        databaseId: database
      });
      expect(created.structuredContent.count).toBeGreaterThan(0);
      expect(created.structuredContent.preview.length).toBeGreaterThan(0);
      expect(created.structuredContent.resources.recordsNdjson).toContain("records.ndjson");

      const page = await fakeServer.call("read_export_page", {
        exportId: created.structuredContent.exportId,
        limit: 2
      });
      expect(page.structuredContent.records.length).toBeGreaterThan(0);

      const summary = await fakeServer.call("summarize_export", {
        exportId: created.structuredContent.exportId
      });
      expect(summary.structuredContent.count).toBe(created.structuredContent.count);

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
        pageSize: 2,
        maxRecords: 2,
        previewLimit: 1
      };
      const bundle = await fakeServer.call("create_data_export_bundle", {
        databaseId: database,
        dataPackId: "utm-export-bundle",
        exports: [
          { ...exportDefaults, requestId: "issued", kind: "documents", agenda: "invoice", invoiceType: "issuedInvoice" },
          { ...exportDefaults, requestId: "stock", kind: "stock", agenda: "stock" }
        ]
      });
      expect(bundle.structuredContent.ok).toBe(true);
      expect(bundle.structuredContent.exportCount).toBe(2);
      expect(bundle.structuredContent.exports.every((item: any) => item.count > 0)).toBe(true);

      const resource = fakeServer.resources.get("export-file");
      const ndjson = await resource?.handler(new URL(created.structuredContent.resources.recordsNdjson), {
        exportId: created.structuredContent.exportId,
        file: "records.ndjson"
      });
      expect(ndjson?.contents[0]?.text).toContain("\"raw\"");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 240_000);

  it.runIf(fullLiveSuite)("serializes same-database requests at the transport boundary", async () => {
    await ensureDatabase();
    const workDir = await mkdtemp(join(tmpdir(), "pohoda-utm-queue-"));
    const runner = createUtmProcessRunner(options!);
    const queuedTransport = new CliXmlTransport({
      exePath: options!.exePath,
      username: options!.username,
      password: options!.password,
      workDir,
      checkDuplicity: false,
      maxParallelProcesses: 2,
      processRunner: runner
    });
    const queuedClient = new PohodaClient({ transport: queuedTransport, ico: options!.ico, database });
    const started = performance.now();
    try {
      const results = await Promise.all([
        queuedClient.listRecords("stock", {}, "", { count: 1 }),
        queuedClient.listRecords("stock", {}, "", { count: 1 })
      ]);
      expect(results.every((response) => response.isOk())).toBe(true);
      const queueWaits = results.map((response) => Number(response.transport.queueWaitMs ?? 0));
      expect(Math.max(...queueWaits)).toBeGreaterThan(0);
      expect(performance.now() - started).toBeGreaterThan(Math.max(...results.map((response) => Number(response.transport.durationMs ?? 0))) * 0.8);
    } finally {
      await runner.cleanup();
      await rm(workDir, { recursive: true, force: true });
    }
  }, 300_000);

  async function ensureDatabase(): Promise<void> {
    if (database === "") {
      const accounting = assertOk(await client.listAccountingUnits());
      const units = extractAccountingUnits(accounting, 100);
      database = options!.database || units[0]?.database || "";
      client.setContext(database, units.find((unit) => unit.database === database)?.ico ?? options!.ico);
    }
  }
});

runMutatingIfEnabled("POHODA UTM mutating integration", () => {
  let transport: UtmPohodaTransport;
  let client: PohodaClient;
  let database = "";

  beforeAll(async () => {
    transport = new UtmPohodaTransport(options!);
    client = new PohodaClient({ transport, ico: options!.ico, database: options!.database });
    const units = extractAccountingUnits(assertOk(await client.listAccountingUnits()), 100);
    database = options!.database || units[0]?.database || "";
    client.setContext(database, units.find((unit) => unit.database === database)?.ico ?? options!.ico);
    (globalThis as any).__pohodaUtmClient = client;
  }, 180_000);

  afterAll(async () => {
    delete (globalThis as any).__pohodaUtmClient;
    await transport?.cleanup();
  });

  it("creates demo-marked address, stock, order, and invoice records", async () => {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const marker = `MCPTEST-${stamp}`;
    const stockDefaults = await firstStockDefaults();

    const response = await client.writeBatch([
      {
        requestId: "address",
        tool: "create_address",
        data: {
          company: `${marker} Contact`,
          ico: `77${stamp.slice(-6)}`,
          street: "Testovaci 1",
          city: "Praha",
          zip: "11000",
          email: "mcp-test@example.invalid"
        }
      },
      {
        requestId: "stock",
        tool: "create_stock",
        data: {
          code: marker.slice(0, 20),
          name: `${marker} Stock`,
          sellingPrice: 123,
          unit: "ks",
          storage: stockDefaults.storage,
          typePrice: stockDefaults.typePrice,
          note: "Created by automated MCP /XML integration test."
        }
      },
      {
        requestId: "order",
        tool: "create_order",
        header: {
          type: "receivedOrder",
          partnerName: `${marker} Partner`,
          date: today()
        },
        items: [{ text: `${marker} order item`, quantity: 1, unit: "ks", unitPrice: 123, vatRate: "high" }]
      },
      {
        requestId: "invoice",
        tool: "create_invoice",
        header: {
          type: "issuedInvoice",
          partnerName: `${marker} Partner`,
          date: today(),
          dateTax: today(),
          dateAccounting: today(),
          dateDue: today(),
          text: `${marker} invoice`
        },
        items: [{ text: `${marker} invoice item`, quantity: 1, unit: "ks", unitPrice: 123, vatRate: "high" }]
      }
    ], `${marker}-smoke-batch`, database);

    expectPohodaOk(response);
    expect(response.items).toHaveLength(4);
  }, 420_000);

  it.runIf(fullLiveSuite)("creates demo-marked broad native records through batch_write", async () => {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const marker = `MCPBROAD-${stamp}`;
    const partnerIco = `88${stamp.slice(-6)}`;
    const item = { text: `${marker} item`, quantity: 1, unit: "ks", unitPrice: 100, vatRate: "none" };
    const partnerHeader = {
      partnerName: `${marker} Partner`,
      partnerIco,
      partnerStreet: "Testovaci 2",
      partnerCity: "Praha",
      partnerZip: "11000",
      date: today(),
      dateTax: today(),
      dateAccounting: today(),
      dateDue: today()
    };
    const operations: WriteBatchOperation[] = [
      {
        requestId: "other-liability",
        tool: "create_other_liability",
        header: { ...partnerHeader, type: "commitment", text: `${marker} other liability` },
        items: [{ ...item, text: `${marker} liability item`, unitPrice: 101 }]
      },
      {
        requestId: "other-receivable",
        tool: "create_other_receivable",
        header: { ...partnerHeader, type: "receivable", text: `${marker} other receivable` },
        items: [{ ...item, text: `${marker} receivable item`, unitPrice: 102 }]
      },
      {
        requestId: "internal",
        tool: "create_internal_document",
        header: { date: today(), dateTax: today(), dateAccounting: today(), text: `${marker} internal document` },
        items: [{ ...item, text: `${marker} internal item`, unitPrice: 103 }]
      },
      {
        requestId: "offer",
        tool: "create_offer",
        header: { ...partnerHeader, type: "issuedOffer", text: `${marker} offer` },
        items: [{ ...item, text: `${marker} offer item`, unitPrice: 104 }]
      },
      {
        requestId: "enquiry",
        tool: "create_enquiry",
        header: { ...partnerHeader, type: "issuedEnquiry", text: `${marker} enquiry` },
        items: [{ ...item, text: `${marker} enquiry item`, unitPrice: 105 }]
      },
      {
        requestId: "contract",
        tool: "manage_contract",
        data: {
          text: `${marker} contract`,
          partnerName: `${marker} Partner`,
          partnerIco,
          datePlanStart: today(),
          note: "Created by automated MCP /XML integration test."
        },
        planItems: [{ date: today(), title: `${marker} plan item`, quantity: 1, unit: "ks", price: 106 }]
      },
      {
        requestId: "centre",
        tool: "manage_centre",
        action: "add",
        data: { code: `C${stamp.slice(-8)}`, name: `${marker} Centre`, note: "Created by automated MCP /XML integration test." }
      },
      {
        requestId: "activity",
        tool: "manage_activity",
        action: "add",
        data: { code: `A${stamp.slice(-8)}`, name: `${marker} Activity`, note: "Created by automated MCP /XML integration test." }
      }
    ];

    const response = await client.writeBatch(operations, `${marker}-batch`, database);
    const result = response.toArray();
    expect(response.isOk(), JSON.stringify(result)).toBe(true);
    expect(result.items).toHaveLength(operations.length);
    expect(result.items.every((item: any) => item.state === "ok")).toBe(true);
  }, 420_000);

  it.runIf(fullLiveSuite)("creates demo-marked setup records through batch_write", async () => {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const short = stamp.slice(-6);
    const marker = `MCPSET-${stamp}`;
    const storeA = `A${short}`;
    const storeB = `B${short}`;
    const stockCode = `STK-${short}`;
    const groupCode = `GRP-${short}`;
    const bankIds = `B${stamp.slice(-3)}`;
    const storageCode = `CLS-${short}`;
    const stockDefaults = await firstStockDefaults();

    const setup = await client.writeBatch([
      {
        requestId: "store-a",
        tool: "manage_store",
        data: {
          name: storeA,
          text: `${marker} Source store`.slice(0, 32),
          allowNegInvBalance: true,
          usePLU: true,
          lowerLimit: 1,
          upperLimit: 999
        }
      },
      {
        requestId: "store-b",
        tool: "manage_store",
        data: {
          name: storeB,
          text: `${marker} Target store`.slice(0, 32),
          allowNegInvBalance: true
        }
      },
      {
        requestId: "bank-account",
        tool: "manage_bank_account",
        action: "add",
        data: {
          ids: bankIds,
          numberAccount: `123456${short}`,
          codeBank: "0100",
          nameBank: "Test bank",
          note: "Created by automated MCP /XML integration test."
        }
      }
    ], `${marker}-setup`, database);
    expectPohodaOk(setup);
    const storeAId = Number(produced(setup, "id"));
    expect(storeAId).toBeGreaterThan(0);

    const storage = await client.manageStorage({
      code: storageCode,
      idStore: storeAId,
      name: `${marker} classification`,
      note: "Created by automated MCP /XML integration test.",
      subStorages: [{ code: `${storageCode}A`, idStore: storeAId, name: "Child classification" }]
    }, `${marker}-storage`, database);
    expectPohodaOk(storage);

    const stockAndLinks = await client.writeBatch([
      {
        requestId: "stock",
        tool: "create_stock",
        data: {
          code: stockCode,
          name: `${marker} Stock`,
          sellingPrice: 123,
          purchasingPrice: 80,
          unit: "ks",
          storage: storeA,
          typePrice: stockDefaults.typePrice,
          note: "Created by automated MCP /XML integration test."
        }
      },
      {
        requestId: "group-stock",
        tool: "manage_group_stock",
        action: "add",
        data: {
          code: groupCode,
          name: `${marker} group`,
          description: "Created by automated MCP /XML integration test."
        },
        variants: [{ stockCode, name: `${marker} variant`, quantity: 1 }]
      }
    ], `${marker}-stock-links`, database);
    expectPohodaOk(stockAndLinks);

    const parameter = await client.manageParameterDefinition({
      idsAgenda: "adresar",
      formParameters: [{
        label: `${marker} parameter`.slice(0, 30),
        name: `MCP${short}`,
        type: "text",
        length: 32
      }]
    }, `${marker}-parameter-permission-check`, database);
    expect(parameter.isOk()).toBe(false);
    expect(JSON.stringify(parameter.toArray())).toContain("Volitelné parametry");
  }, 420_000);

  it.runIf(fullLiveSuite)("creates demo-marked operational documents and PDF print output", async () => {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const short = stamp.slice(-6);
    const marker = `MCPOPS-${stamp}`;
    const storeA = `C${short}`;
    const storeB = `D${short}`;
    const stockCode = `OPS-${short}`;
    const bankIds = `C${stamp.slice(-3)}`;
    const cashAccount = await firstCodebookIds("cashRegister", ["cashRegister"]);
    const productStock = await firstProductStock();
    const stockDefaults = await firstStockDefaults();

    const setup = await client.writeBatch([
      {
        requestId: "store-source",
        tool: "manage_store",
        data: {
          name: storeA,
          text: `${marker} Source store`.slice(0, 32),
          allowNegInvBalance: true
        }
      },
      {
        requestId: "store-target",
        tool: "manage_store",
        data: {
          name: storeB,
          text: `${marker} Target store`.slice(0, 32),
          allowNegInvBalance: true
        }
      },
      {
        requestId: "bank-account",
        tool: "manage_bank_account",
        action: "add",
        data: {
          ids: bankIds,
          numberAccount: `654321${short}`,
          codeBank: "0100",
          nameBank: "Operational test bank"
        }
      }
    ], `${marker}-setup`, database);
    expectPohodaOk(setup);

    const stock = await client.createStock({
      code: stockCode,
      name: `${marker} Stock`,
      sellingPrice: 150,
      purchasingPrice: 90,
      unit: "ks",
      storage: storeA,
      typePrice: stockDefaults.typePrice
    }, `${marker}-stock`, database);
    expectPohodaOk(stock);

    const operations: WriteBatchOperation[] = [
      {
        requestId: "cash-voucher",
        tool: "create_cash_voucher",
        header: {
          type: "receipt",
          cashAccount,
          date: today(),
          text: `${marker} cash voucher`,
          partnerName: `${marker} Partner`
        },
        items: [{ text: `${marker} cash item`, quantity: 1, unit: "ks", unitPrice: 111, vatRate: "none" }]
      },
      {
        requestId: "bank-document",
        tool: "create_bank_document",
        header: {
          type: "receipt",
          account: bankIds,
          dateStatement: today(),
          datePayment: today(),
          text: `${marker} bank document`,
          partnerName: `${marker} Partner`
        },
        items: [{ text: `${marker} bank item`, quantity: 1, unit: "ks", unitPrice: 112, vatRate: "none" }]
      },
      {
        requestId: "stock-receipt",
        tool: "create_stock_receipt",
        header: { date: today(), text: `${marker} stock receipt`, store: storeA },
        items: [{ stockCode, quantity: 5, unitPrice: 90, vatRate: "none", store: storeA }]
      },
      {
        requestId: "stock-issue",
        tool: "create_stock_issue",
        header: { date: today(), text: `${marker} stock issue`, store: storeA },
        items: [{ stockCode, quantity: 1, unitPrice: 90, vatRate: "none", store: storeA }]
      },
      {
        requestId: "stock-transfer",
        tool: "create_stock_transfer",
        header: { date: today(), text: `${marker} stock transfer`, store: storeB },
        items: [{ stockCode, quantity: 1, store: storeA, note: "Transfer one item" }]
      },
      {
        requestId: "production",
        tool: "create_production_document",
        header: { date: today(), text: `${marker} production` },
        items: [{ stockId: productStock.id, stockCode: productStock.code, store: productStock.storage, quantity: 1, note: "Produce one item" }]
      },
      {
        requestId: "sales-receipt",
        tool: "create_sales_receipt",
        header: {
          date: today(),
          text: `${marker} sales receipt`,
          partnerName: `${marker} Partner`,
          kasa: cashAccount,
          store: storeA
        },
        items: [{ stockCode, text: `${marker} sold item`, quantity: 1, unit: "ks", unitPrice: 150, vatRate: "none" }],
        payments: [{ paymentType: "cash", received: 150, text: "Cash payment" }]
      }
    ];
    const documents = await client.writeBatch(operations, `${marker}-documents`, database);
    expectPohodaOk(documents);

    const invoice = await client.createInvoice({
      type: "issuedInvoice",
      partnerName: `${marker} Print Partner`,
      date: today(),
      dateTax: today(),
      dateAccounting: today(),
      dateDue: today(),
      text: `${marker} print invoice`
    }, [{ text: `${marker} print item`, quantity: 1, unit: "ks", unitPrice: 121, vatRate: "none" }], `${marker}-print-invoice`, database);
    expectPohodaOk(invoice);
    const invoiceId = Number(produced(invoice, "id"));
    expect(invoiceId).toBeGreaterThan(0);

    const reportId = await firstWorkingInvoiceReportId(client, invoiceId, marker, database);
    if (reportId > 0) {
      const printed = await client.printRecord({
        agenda: "vydane_faktury",
        reportId,
        recordId: invoiceId,
        pdfPath: `C:\\Users\\Public\\${marker}.pdf`,
        pdfBase64: true,
        removeFile: true,
        databaseOverride: database
      });
      expectPohodaOk(printed);
    } else {
      const printed = await client.printRecord({
        agenda: "vydane_faktury",
        reportId: 1,
        recordId: invoiceId,
        pdfPath: `C:\\Users\\Public\\${marker}-invalid-report.pdf`,
        databaseOverride: database
      });
      expect(printed.isOk()).toBe(false);
      expect(JSON.stringify(printed.toArray())).toContain("Agenda neobsahuje zadanou sestavu");
    }
  }, 540_000);
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function firstWorkingInvoiceReportId(client: PohodaClient, invoiceId: number, marker: string, database: string): Promise<number> {
  const configured = Number(process.env.POHODA_UTM_PRINT_REPORT_ID ?? 0);
  if (configured > 0) {
    return configured;
  }
  const candidates = Array.from({ length: 40 }, (_, index) => index + 1);
  for (let offset = 0; offset < candidates.length; offset += 10) {
    const chunk = candidates.slice(offset, offset + 10);
    const response = await client.writeBatch(chunk.map((reportId) => ({
      requestId: `report-${reportId}`,
      tool: "print",
      options: {
        agenda: "vydane_faktury",
        reportId,
        recordId: invoiceId,
        pdfPath: `C:\\Users\\Public\\${marker}-probe-${reportId}.pdf`,
        databaseOverride: database
      }
    })), `${marker}-print-probe-${offset}`, database);
    const acceptedIndex = response.items.findIndex((item) => item.isOk());
    if (acceptedIndex >= 0) {
      return chunk[acceptedIndex] ?? 0;
    }
  }
  return 0;
}

async function firstCodebookIds(agenda: string, candidateKeys: string[]): Promise<string> {
  const record = await firstCodebookRecord(agenda, candidateKeys);
  const value = pickString(record, ["ids", "code", "name", "id"]);
  if (value !== "") {
    return value;
  }
  throw new Error(`No usable ${agenda} record found in POHODA demo data.`);
}

async function firstStockDefaults(): Promise<{ storage: string; typePrice: string }> {
  const stock = await firstCodebookRecord("stock", ["stock"]);
  const storage = findValueByKey(stock, "storage");
  const typePrice = findValueByKey(stock, "typePrice");
  if (storage === "" || typePrice === "") {
    throw new Error(`No usable stock storage/typePrice defaults found: ${JSON.stringify(stock)}`);
  }
  return { storage, typePrice };
}

async function firstProductStock(): Promise<{ id: number; code: string; storage: { id: number } }> {
  const response = assertOk(await activeClient().listRecords("stock", {}, "", { count: 100 }));
  const stocks: Record<string, any>[] = [];
  for (const item of response.items) {
    collectRecords(item.data, ["stockHeader"], stocks);
  }
  for (const stock of stocks) {
    if (String(stock.stockType ?? "").trim() !== "product") {
      continue;
    }
    const id = Number(stock.id ?? 0);
    const code = String(stock.code ?? "").trim();
    const storageId = Number(findValueByKey(stock.storage, "id") || 0);
    if (id > 0 && code !== "" && storageId > 0) {
      return { id, code, storage: { id: storageId } };
    }
  }
  throw new Error(`No product stock item found in POHODA demo data: ${JSON.stringify(stocks.map((stock) => ({
    id: stock.id,
    code: stock.code,
    stockType: stock.stockType
  })))}`);
}

async function firstCodebookRecord(agenda: string, candidateKeys: string[]): Promise<Record<string, any>> {
  const response = assertOk(await activeClient().listRecords(agenda, {}, "", { count: 10 }));
  for (const item of response.items) {
    const found = findFirstRecord(item.data, candidateKeys);
    if (found) {
      return found;
    }
  }
  throw new Error(`No usable ${agenda} record found in POHODA demo data.`);
}

function activeClient(): PohodaClient {
  const current = (globalThis as any).__pohodaUtmClient as PohodaClient | undefined;
  if (!current) {
    throw new Error("POHODA UTM client is not initialized.");
  }
  return current;
}

function findFirstRecord(value: unknown, candidateKeys: string[]): Record<string, any> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstRecord(item, candidateKeys);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  const object = value as Record<string, any>;
  for (const key of candidateKeys) {
    const child = object[key];
    if (Array.isArray(child)) {
      return child.find((item) => item && typeof item === "object") as Record<string, any> | undefined;
    }
    if (child && typeof child === "object") {
      return child as Record<string, any>;
    }
  }
  for (const child of Object.values(object)) {
    const found = findFirstRecord(child, candidateKeys);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function collectRecords(value: unknown, candidateKeys: string[], target: Record<string, any>[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRecords(item, candidateKeys, target);
    }
    return;
  }
  const object = value as Record<string, any>;
  for (const key of candidateKeys) {
    const child = object[key];
    if (Array.isArray(child)) {
      target.push(...child.filter((item) => item && typeof item === "object") as Record<string, any>[]);
    } else if (child && typeof child === "object") {
      target.push(child as Record<string, any>);
    }
  }
  for (const child of Object.values(object)) {
    collectRecords(child, candidateKeys, target);
  }
}

function pickString(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const object = value as Record<string, any>;
  for (const key of keys) {
    const raw = object[key] ?? object[`${key}s`];
    if (raw && typeof raw === "object") {
      const nested = pickString(raw, ["ids", "code", "name", "id"]);
      if (nested !== "") {
        return nested;
      }
    }
    const text = String(raw ?? "").trim();
    if (text !== "") {
      return text;
    }
  }
  for (const child of Object.values(object)) {
    const nested = pickString(child, keys);
    if (nested !== "") {
      return nested;
    }
  }
  return "";
}

function findValueByKey(value: unknown, key: string): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValueByKey(item, key);
      if (found !== "") {
        return found;
      }
    }
    return "";
  }
  const object = value as Record<string, any>;
  if (key in object) {
    const direct = object[key];
    const text = typeof direct === "object" ? pickString(direct, ["ids", "code", "name", "id"]) : String(direct ?? "").trim();
    if (text !== "") {
      return text;
    }
  }
  for (const child of Object.values(object)) {
    const found = findValueByKey(child, key);
    if (found !== "") {
      return found;
    }
  }
  return "";
}

function produced(response: PohodaResponse, key: string): string {
  for (const item of response.items) {
    const found = pickString(item.data?.producedDetails, [key]);
    if (found !== "") {
      return found;
    }
  }
  return "";
}

function expectPohodaOk(response: PohodaResponse): void {
  expect(response.isOk(), JSON.stringify(response.toArray())).toBe(true);
}

class CapturingServer {
  public readonly tools = new Map<string, { handler: (args: any) => Promise<any> }>();
  public readonly resources = new Map<string, { handler: (uri: URL, variables?: any) => Promise<any> }>();

  public registerTool(name: string, _config: any, handler: (args: any) => Promise<any>): void {
    this.tools.set(name, { handler });
  }

  public registerResource(name: string, _uri: unknown, _config: any, handler: any): void {
    this.resources.set(name, { handler });
  }

  public async call(name: string, args: Record<string, unknown>): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Missing tool ${name}`);
    }
    return tool.handler(args);
  }
}
