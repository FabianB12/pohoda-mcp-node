import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentAgendas, exportAgendas } from "../src/pohoda/constants.js";
import { PohodaClient } from "../src/pohoda/client.js";
import type { PohodaResponse } from "../src/pohoda/response.js";
import { CliXmlTransport } from "../src/pohoda/transport.js";
import { assertOk, extractAccountingUnits, registerPohodaTools } from "../src/mcp/tools.js";
import { ExportStore } from "../src/mcp/export-store.js";
import { createUtmProcessRunner, optionsFromEnv, UtmPohodaTransport } from "./support/utm-pohoda.js";

const options = optionsFromEnv();
const runIfConfigured = options ? describe : describe.skip;
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

  it("runs all read-only MCP-backed list methods against the real POHODA demo database", async () => {
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

  it("runs safe raw_xml and raw_xml_batch read requests against the real database", async () => {
    await ensureDatabase();
    const stockXml = '<lStk:listStockRequest version="2.0" stockVersion="2.0"><lStk:limit><ftr:count>1</ftr:count></lStk:limit><lStk:requestStock/></lStk:listStockRequest>';
    const contactsXml = '<lAdb:listAddressBookRequest version="2.0" addressBookVersion="2.0"><lAdb:limit><ftr:count>1</ftr:count></lAdb:limit><lAdb:requestAddressBook/></lAdb:listAddressBookRequest>';

    expect((await client.sendRawXml(stockXml, "raw stock", "utm-raw-stock", { databaseOverride: database, checkDuplicity: false })).isOk()).toBe(true);
    expect((await client.sendRawXmlBatch([stockXml, contactsXml], "raw batch", "utm-raw-batch", { databaseOverride: database, checkDuplicity: false })).isOk()).toBe(true);
  }, 240_000);

  it("creates a compact persisted invoice export and reads pages/resources", async () => {
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

  it("serializes same-database requests at the transport boundary", async () => {
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
  }, 180_000);

  afterAll(async () => {
    await transport?.cleanup();
  });

  it("creates demo-marked address, stock, order, and invoice records", async () => {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const marker = `MCPTEST-${stamp}`;
    const failures: string[] = [];

    await check("create_address", () => client.createAddress({
      company: `${marker} Contact`,
      ico: `77${stamp.slice(-6)}`,
      street: "Testovaci 1",
      city: "Praha",
      zip: "11000",
      email: "mcp-test@example.invalid"
    }, `${marker}-address`, database));
    await check("create_stock", () => client.createStock({
      code: marker.slice(0, 20),
      name: `${marker} Stock`,
      sellingPrice: 123,
      unit: "ks",
      note: "Created by automated MCP /XML integration test."
    }, `${marker}-stock`, database));
    await check("create_order", () => client.createOrder({
      type: "receivedOrder",
      partnerName: `${marker} Partner`,
      date: today()
    }, [{ text: `${marker} order item`, quantity: 1, unit: "ks", unitPrice: 123, vatRate: "high" }], `${marker}-order`, database));
    await check("create_invoice", () => client.createInvoice({
      type: "issuedInvoice",
      partnerName: `${marker} Partner`,
      date: today(),
      dateTax: today(),
      dateAccounting: today(),
      dateDue: today(),
      text: `${marker} invoice`
    }, [{ text: `${marker} invoice item`, quantity: 1, unit: "ks", unitPrice: 123, vatRate: "high" }], `${marker}-invoice`, database));

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
  }, 420_000);
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
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
