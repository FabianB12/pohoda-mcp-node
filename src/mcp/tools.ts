import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  defaultListLimit,
  documentAgendas,
  exportAgendas,
  exportAgendasWithLastChanges,
  exportAgendasWithoutFilters,
  exportAgendasWithoutServerLimit,
  printAgendas,
  vatRates
} from "../pohoda/constants.js";
import type { PohodaClient } from "../pohoda/client.js";
import type { XmlDatabase, XmlDatabaseRegistry } from "../pohoda/database-registry.js";
import type { PohodaResponse } from "../pohoda/response.js";
import { ExportStore, type CurrencyTotal, type ExportRecord, type ExportSnapshot, summarizeRecords } from "./export-store.js";

export type PohodaServerContext = {
  client: PohodaClient;
  databaseRegistry?: XmlDatabaseRegistry | undefined;
  exportStore?: ExportStore | undefined;
};

const itemSchema = z.object({
  text: z.string(),
  quantity: z.number().default(1),
  unit: z.string().default("ks"),
  unitPrice: z.number(),
  vatRate: z.enum(vatRates).default("high"),
  stockCode: z.string().default("")
});

const invoiceCreateSchema = z.object({
  type: z.enum(["issuedInvoice", "receivedInvoice"]),
  items: z.array(itemSchema).min(1),
  number: z.string().default(""),
  partnerName: z.string().default(""),
  date: z.string().default(""),
  partnerIco: z.string().default(""),
  partnerStreet: z.string().default(""),
  partnerCity: z.string().default(""),
  partnerZip: z.string().default(""),
  partnerId: z.number().int().default(0),
  text: z.string().default(""),
  symVar: z.string().default(""),
  dateDue: z.string().default(""),
  dateTax: z.string().default(""),
  dateAccounting: z.string().default(""),
  paymentType: z.string().default(""),
  accountIds: z.string().default(""),
  accounting: z.string().default(""),
  classificationVAT: z.string().default(""),
  centre: z.string().default(""),
  activity: z.string().default(""),
  contract: z.string().default(""),
  currency: z.string().default(""),
  currencyRate: z.number().default(0),
  note: z.string().default(""),
  intNote: z.string().default("")
});

const emptyAddressInput = {
  company: "",
  ico: "",
  dic: "",
  street: "",
  city: "",
  zip: "",
  phone: "",
  email: ""
};

const addressCreateSchema = z.object({
  company: z.string().default(""),
  ico: z.string().default(""),
  dic: z.string().default(""),
  street: z.string().default(""),
  city: z.string().default(""),
  zip: z.string().default(""),
  phone: z.string().default(""),
  email: z.string().default("")
});

const batchInvoiceCreateSchema = z.object({
  requestId: z.string().default(""),
  createAddress: z.boolean().default(true),
  address: addressCreateSchema.default(emptyAddressInput),
  invoice: invoiceCreateSchema
});

const stockCreateSchema = z.object({
  code: z.string(),
  name: z.string(),
  sellingPrice: z.number(),
  unit: z.string().default("ks"),
  storage: z.string().default(""),
  vatRate: z.enum(vatRates).default("high"),
  purchasingPrice: z.number().default(0),
  EAN: z.string().default(""),
  PLU: z.number().int().default(0),
  isSales: z.boolean().default(true),
  isInternet: z.boolean().default(false),
  description: z.string().default(""),
  description2: z.string().default(""),
  limitMin: z.number().default(0),
  limitMax: z.number().default(0),
  mass: z.number().default(0),
  supplierId: z.number().int().default(0),
  guarantee: z.number().int().default(0),
  guaranteeType: z.string().default("year"),
  shortName: z.string().default(""),
  nameComplement: z.string().default(""),
  note: z.string().default("")
});

const orderCreateSchema = z.object({
  type: z.enum(["receivedOrder", "issuedOrder"]),
  partnerName: z.string(),
  date: z.string(),
  items: z.array(itemSchema).min(1),
  partnerIco: z.string().default("")
});

const printSchema = z.object({
  agenda: z.enum(printAgendas),
  reportId: z.number().int(),
  recordId: z.number().int().default(0),
  pdfPath: z.string().default(""),
  pdfBase64: z.boolean().default(false),
  printer: z.string().default(""),
  copies: z.number().int().default(1),
  datePrint: z.string().default(""),
  queryFilter: z.string().default(""),
  userFilterName: z.string().default(""),
  usrAgenda: z.string().default(""),
  emailTo: z.string().default(""),
  emailCc: z.string().default(""),
  emailBcc: z.string().default(""),
  emailSubject: z.string().default(""),
  emailBody: z.string().default(""),
  emailTemplate: z.string().default(""),
  emailAttachments: z.string().default(""),
  emailPriority: z.enum(["", "normal", "low", "high"]).default(""),
  emailReturnReceipt: z.boolean().default(false),
  emailReadReceipt: z.boolean().default(false),
  removeFile: z.boolean().default(false),
  includeIsdoc: z.boolean().default(false),
  isdocGraphicNote: z.enum(["", "topRight", "topLeft", "bottomRight", "bottomLeft"]).default(""),
  parameters: z.record(z.string(), z.any()).default({})
});

const batchWriteOperationSchema = z.discriminatedUnion("tool", [
  z.object({ requestId: z.string().default(""), tool: z.literal("create_address"), data: addressCreateSchema.extend({ company: z.string() }) }),
  z.object({ requestId: z.string().default(""), tool: z.literal("create_invoice"), data: invoiceCreateSchema }),
  z.object({ requestId: z.string().default(""), tool: z.literal("create_stock"), data: stockCreateSchema }),
  z.object({ requestId: z.string().default(""), tool: z.literal("create_order"), data: orderCreateSchema }),
  z.object({ requestId: z.string().default(""), tool: z.literal("print"), data: printSchema })
]);

const batchListOperationSchema = z.object({
  requestId: z.string().default(""),
  tool: z.enum(["list_documents", "list_stock", "list_contacts", "list_export_agenda"]),
  agenda: z.string().default("invoice"),
  invoiceType: z.enum(["", "issuedInvoice", "receivedInvoice"]).default(""),
  documentType: z.enum(["", "receivedOrder", "issuedOrder", "receivedOffer", "issuedOffer", "receivedEnquiry", "issuedEnquiry"]).default(""),
  id: z.number().int().default(0),
  extId: z.string().default(""),
  extSystemName: z.string().default(""),
  dateFrom: z.string().default(""),
  dateTill: z.string().default(""),
  company: z.string().default(""),
  ico: z.string().default(""),
  number: z.string().default(""),
  code: z.string().default(""),
  name: z.string().default(""),
  city: z.string().default(""),
  street: z.string().default(""),
  zip: z.string().default(""),
  dic: z.string().default(""),
  EAN: z.string().default(""),
  PLU: z.number().int().default(0),
  storage: z.string().default(""),
  store: z.string().default(""),
  internet: z.boolean().optional(),
  lastChanges: z.string().default(""),
  userFilterName: z.string().default(""),
  queryFilter: z.string().default(""),
  idFrom: z.number().int().default(0),
  count: z.number().int().default(0),
  limit: z.number().int().min(1).max(10_000).default(defaultListLimit),
  includeDocuments: z.boolean().optional(),
  includeAttachments: z.boolean().optional(),
  includeParameters: z.boolean().optional(),
  includeLiquidations: z.boolean().optional(),
  includeRelatedFiles: z.boolean().optional(),
  includeRelatedLinks: z.boolean().optional(),
  includePictures: z.boolean().optional(),
  includeCategories: z.boolean().optional(),
  includeRelatedStocks: z.boolean().optional(),
  includeAlternativeStocks: z.boolean().optional(),
  includeIntParameters: z.boolean().optional(),
  includeStockItem: z.boolean().optional(),
  includeStockAttach: z.boolean().optional(),
  includeStockSerialNumber: z.boolean().optional(),
  includeStockPriceItem: z.boolean().optional(),
  includeStockParameters: z.boolean().optional()
});

const dataExportSpecSchema = z.object({
  requestId: z.string().default(""),
  kind: z.enum(["documents", "stock", "contacts", "export_agenda"]).default("documents"),
  agenda: z.string().default("invoice"),
  invoiceType: z.enum(["", "issuedInvoice", "receivedInvoice"]).default(""),
  documentType: z.enum(["", "receivedOrder", "issuedOrder", "receivedOffer", "issuedOffer", "receivedEnquiry", "issuedEnquiry"]).default(""),
  id: z.number().int().default(0),
  dateFrom: z.string().default(""),
  dateTill: z.string().default(""),
  company: z.string().default(""),
  ico: z.string().default(""),
  number: z.string().default(""),
  lastChanges: z.string().default(""),
  queryFilter: z.string().default(""),
  userFilterName: z.string().default(""),
  pageSize: z.number().int().min(1).max(1_000).default(100),
  maxRecords: z.number().int().min(1).max(100_000).default(1_000),
  previewLimit: z.number().int().min(0).max(100).default(10)
});

const databaseIdSchema = z.string().default("").describe(
  "Registry id or exact POHODA database name. Prefer passing this explicitly on every accounting-unit-specific call; omit only when a configured default database is intentionally used."
);

export function registerPohodaTools(server: McpServer, context: PohodaServerContext): void {
  const { client, databaseRegistry } = context;
  const exportStore = context.exportStore ?? new ExportStore(process.env.POHODA_XML_EXPORT_DIR ?? join(process.cwd(), "var", "exports"));

  server.registerTool("status", {
    title: "Check Pohoda XML transport status",
    description: "Check local Pohoda /XML transport configuration.",
    inputSchema: { companyDetail: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ companyDetail }) => jsonResult(client.getStatus(companyDetail)));

  server.registerTool("list_xml_databases", {
    title: "List known Pohoda XML databases",
    description: "Lists configured registry entries and filesystem database guesses. This is refreshed on every call; use includeLive=true to also ask POHODA for the official current accounting-unit list.",
    inputSchema: {
      includeLive: z.boolean().default(false),
      liveLimit: z.number().int().min(1).max(10_000).default(defaultListLimit)
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ includeLive, liveLimit }) => {
    if (!databaseRegistry && !includeLive) {
      throw new Error("XML database registry is not configured. Set POHODA_XML_DATABASES_FILE or POHODA_DATA_DIR.");
    }
    const databases = databaseRegistry ? await databaseRegistry.all() : [];
    const live = includeLive ? extractAccountingUnits(assertOk(await client.listAccountingUnits()), liveLimit) : [];
    return jsonResult({ databases: dedupeDatabases([...databases, ...live]) });
  });

  server.registerTool("current_database", {
    title: "Show configured default Pohoda XML database",
    description: "Diagnostic helper for the configured fallback database and ICO. Normal work should pass databaseId directly on each tool call.",
    inputSchema: { includeStatus: z.boolean().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ includeStatus }) => jsonResult({
    database: client.getDatabase(),
    ico: client.getIco(),
    ...(includeStatus ? { status: client.getStatusNoStart(true) } : {})
  }));

  server.registerTool("list_accounting_units", {
    title: "List Pohoda accounting units",
    description: "Discover accounting units/clients visible to the configured POHODA user. Returns compact paginated rows by default, with fuzzy search over name, person name, ICO, DIČ, database, city, address, and id fields.",
    inputSchema: {
      query: z.string().default(""),
      ico: z.string().default(""),
      dic: z.string().default(""),
      year: z.number().int().default(0),
      database: z.string().default(""),
      city: z.string().default(""),
      cursor: z.string().default(""),
      limit: z.number().int().min(1).max(500).default(50),
      includeRaw: z.boolean().default(false)
    },
    outputSchema: {
      total: z.number(),
      returned: z.number(),
      nextCursor: z.string(),
      query: z.string(),
      filters: z.record(z.string(), z.any()),
      units: z.array(z.record(z.string(), z.any()))
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async (args) => {
    const data = assertOk(await client.listAccountingUnits());
    const units = extractAccountingUnits(data, 10_000, args.includeRaw);
    const page = accountingUnitPage(units, args);
    return {
      content: [{ type: "text" as const, text: stringify(page) }],
      structuredContent: page
    };
  });

  server.registerTool("list_documents", {
    title: "List Pohoda documents",
    inputSchema: {
      agenda: z.enum(documentAgendas),
      invoiceType: z.enum(["", "issuedInvoice", "receivedInvoice"]).default(""),
      documentType: z.enum(["", "receivedOrder", "issuedOrder", "receivedOffer", "issuedOffer", "receivedEnquiry", "issuedEnquiry"]).default(""),
      id: z.number().int().default(0),
      extId: z.string().default(""),
      extSystemName: z.string().default(""),
      dateFrom: z.string().default(""),
      dateTill: z.string().default(""),
      company: z.string().default(""),
      ico: z.string().default(""),
      number: z.string().default(""),
      lastChanges: z.string().default(""),
      userFilterName: z.string().default(""),
      queryFilter: z.string().default(""),
      idFrom: z.number().int().default(0),
      count: z.number().int().default(0),
      includeDocuments: z.boolean().optional(),
      includeAttachments: z.boolean().optional(),
      includeParameters: z.boolean().optional(),
      includeLiquidations: z.boolean().optional(),
      limit: z.number().int().min(1).max(10_000).default(defaultListLimit),
      databaseId: databaseIdSchema
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (args) => {
    if (args.agenda === "invoice" && args.invoiceType === "") {
      throw new Error("invoiceType is required for invoice exports.");
    }
    if (args.agenda === "order" && args.documentType === "") {
      throw new Error("documentType is required for order exports (receivedOrder or issuedOrder).");
    }
    assertExtId(args.extId, args.extSystemName);
    const filter = clean({
      id: args.id || undefined,
      extId: args.extId ? { ids: args.extId, exSystemName: args.extSystemName } : undefined,
      dateFrom: args.dateFrom,
      dateTill: args.dateTill,
      company: args.company,
      ico: args.ico,
      number: args.number,
      lastChanges: args.lastChanges,
      userFilterName: args.userFilterName,
      queryFilter: args.queryFilter
    });
    const subtype = args.agenda === "invoice" ? args.invoiceType : args.documentType;
    return jsonText(jsonList(assertOk(await client.listRecords(args.agenda, filter, subtype, {
      idFrom: args.idFrom,
      count: args.count || args.limit,
      restrictions: documentRestrictions(args.agenda, args),
      database: await databaseName(args.databaseId)
    })), args.limit));
  });

  server.registerTool("list_stock", {
    title: "List Pohoda stock items",
    inputSchema: {
      id: z.number().int().default(0), extId: z.string().default(""), extSystemName: z.string().default(""),
      code: z.string().default(""), name: z.string().default(""), EAN: z.string().default(""), PLU: z.number().int().default(0),
      storage: z.string().default(""), store: z.string().default(""), internet: z.boolean().optional(),
      lastChanges: z.string().default(""), userFilterName: z.string().default(""), queryFilter: z.string().default(""),
      idFrom: z.number().int().default(0), count: z.number().int().default(0),
      includeRelatedFiles: z.boolean().optional(), includeRelatedLinks: z.boolean().optional(), includePictures: z.boolean().optional(),
      includeCategories: z.boolean().optional(), includeRelatedStocks: z.boolean().optional(), includeAlternativeStocks: z.boolean().optional(),
      includeIntParameters: z.boolean().optional(), includeStockItem: z.boolean().optional(), includeStockAttach: z.boolean().optional(),
      includeStockSerialNumber: z.boolean().optional(), includeStockPriceItem: z.boolean().optional(), includeStockParameters: z.boolean().optional(),
      includeAttachments: z.boolean().optional(), limit: z.number().int().min(1).default(defaultListLimit), databaseId: databaseIdSchema
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (args) => {
    assertExtId(args.extId, args.extSystemName);
    return jsonText(jsonList(assertOk(await client.listRecords("stock", clean({
      id: args.id || undefined,
      extId: args.extId ? { ids: args.extId, exSystemName: args.extSystemName } : undefined,
      code: args.code, name: args.name, EAN: args.EAN, PLU: args.PLU || undefined,
      storage: args.storage, store: args.store, internet: args.internet,
      lastChanges: args.lastChanges, userFilterName: args.userFilterName, queryFilter: args.queryFilter
    }), "", {
      idFrom: args.idFrom,
      count: args.count || args.limit,
      restrictions: clean({
        "lStk:relatedFiles": args.includeRelatedFiles, "lStk:relatedLinks": args.includeRelatedLinks, "lStk:pictures": args.includePictures,
        "lStk:categories": args.includeCategories, "lStk:relatedStocks": args.includeRelatedStocks, "lStk:alternativeStocks": args.includeAlternativeStocks,
        "lStk:intParameters": args.includeIntParameters, "lStk:stockItem": args.includeStockItem, "lStk:stockAttach": args.includeStockAttach,
        "lStk:stockSerialNumber": args.includeStockSerialNumber, "lStk:stockPriceItem": args.includeStockPriceItem, "lStk:stockParameters": args.includeStockParameters,
        "lStk:attachments": args.includeAttachments
      }),
      database: await databaseName(args.databaseId)
    })), args.limit));
  });

  server.registerTool("list_contacts", {
    title: "List Pohoda contacts",
    inputSchema: {
      id: z.number().int().default(0), extId: z.string().default(""), extSystemName: z.string().default(""),
      company: z.string().default(""), ico: z.string().default(""), name: z.string().default(""), city: z.string().default(""),
      street: z.string().default(""), zip: z.string().default(""), dic: z.string().default(""), number: z.string().default(""),
      lastChanges: z.string().default(""), userFilterName: z.string().default(""), queryFilter: z.string().default(""),
      idFrom: z.number().int().default(0), count: z.number().int().default(0), includeAttachments: z.boolean().optional(),
      limit: z.number().int().min(1).default(defaultListLimit), databaseId: databaseIdSchema
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (args) => {
    assertExtId(args.extId, args.extSystemName);
    return jsonText(jsonList(assertOk(await client.listRecords("addressbook", clean({
      id: args.id || undefined,
      extId: args.extId ? { ids: args.extId, exSystemName: args.extSystemName } : undefined,
      company: args.company, ico: args.ico, name: args.name, city: args.city, street: args.street, zip: args.zip, dic: args.dic,
      addressNumber: args.number, lastChanges: args.lastChanges, userFilterName: args.userFilterName, queryFilter: args.queryFilter
    }), "", {
      idFrom: args.idFrom, count: args.count || args.limit,
      restrictions: clean({ "lAdb:attachments": args.includeAttachments }),
      database: await databaseName(args.databaseId)
    })), args.limit));
  });

  server.registerTool("list_export_agenda", {
    title: "List Pohoda export agenda",
    inputSchema: {
      agenda: z.enum(exportAgendas), id: z.number().int().default(0), lastChanges: z.string().default(""),
      userFilterName: z.string().default(""), queryFilter: z.string().default(""), idFrom: z.number().int().default(0),
      count: z.number().int().default(0), limit: z.number().int().min(1).default(defaultListLimit), databaseId: databaseIdSchema
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (args) => {
    assertExportAgendaFilters(args.agenda, args);
    return jsonText(jsonList(assertOk(await client.listRecords(args.agenda, clean({
      id: args.id || undefined, lastChanges: args.lastChanges, userFilterName: args.userFilterName, queryFilter: args.queryFilter
    }), "", {
      idFrom: args.idFrom,
      count: exportAgendasWithoutServerLimit.includes(args.agenda as any) ? args.count : (args.count || args.limit),
      database: await databaseName(args.databaseId)
    })), args.limit));
  });

  server.registerTool("batch_list_records", {
    title: "Batch multiple Pohoda read/list requests",
    description: "Runs multiple compatible read/list requests for the same accounting unit in one POHODA /XML process by packing them into a single dataPack. Use this when an agent knows it needs several lists or summaries at once.",
    inputSchema: {
      operations: z.array(batchListOperationSchema).min(1).max(25),
      databaseId: databaseIdSchema,
      dataPackId: z.string().default("")
    },
    outputSchema: {
      ok: z.boolean(),
      state: z.string(),
      database: z.string(),
      operationCount: z.number(),
      transport: z.record(z.string(), z.any()),
      results: z.array(z.record(z.string(), z.any()))
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ operations, databaseId, dataPackId }) => {
    const plans = operations.map((operation, index) => batchListOperationPlan(operation, index));
    const database = await databaseName(databaseId);
    const response = await client.listRecordsBatch(plans.map((plan) => ({
      agenda: plan.agenda,
      filter: plan.filter,
      subType: plan.subtype,
      options: plan.options,
      note: `${plan.requestId}:${plan.tool}`
    })), dataPackId, clean({ databaseOverride: database }));
    const data = response.toArray();
    const results = plans.map((plan, index) => compactBatchListResult(plan, data.items[index]));
    const structuredContent = {
      ok: data.state === "ok" && results.every((result) => result.ok),
      state: data.state,
      database: activeDatabase(database),
      operationCount: plans.length,
      transport: data.transport,
      results
    };
    return {
      content: [{ type: "text" as const, text: stringify(structuredContent) }],
      structuredContent
    };
  });

  server.registerTool("create_invoice", {
    title: "Create Pohoda invoice",
    inputSchema: {
      type: z.enum(["issuedInvoice", "receivedInvoice"]), items: z.array(itemSchema).min(1), number: z.string().default(""),
      partnerName: z.string().default(""), date: z.string().default(""), partnerIco: z.string().default(""), partnerStreet: z.string().default(""),
      partnerCity: z.string().default(""), partnerZip: z.string().default(""), partnerId: z.number().int().default(0), text: z.string().default(""),
      symVar: z.string().default(""), dateDue: z.string().default(""), dateTax: z.string().default(""), dateAccounting: z.string().default(""),
      paymentType: z.string().default(""), accountIds: z.string().default(""), accounting: z.string().default(""),
      classificationVAT: z.string().default(""), centre: z.string().default(""), activity: z.string().default(""), contract: z.string().default(""),
      currency: z.string().default(""), currencyRate: z.number().default(0), note: z.string().default(""), intNote: z.string().default(""),
      dataPackId: z.string().default(""), databaseId: databaseIdSchema
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ items, dataPackId, databaseId, ...header }) =>
    jsonResult(assertOk(await client.createInvoice(header, items, dataPackId, await databaseName(databaseId)))));

  server.registerTool("create_address", {
    title: "Create Pohoda contact",
    inputSchema: {
      company: z.string(), ico: z.string().default(""), dic: z.string().default(""), street: z.string().default(""), city: z.string().default(""),
      zip: z.string().default(""), phone: z.string().default(""), email: z.string().default(""), dataPackId: z.string().default(""), databaseId: databaseIdSchema
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ dataPackId, databaseId, ...data }) =>
    jsonResult(assertOk(await client.createAddress(data, dataPackId, await databaseName(databaseId)))));

  server.registerTool("batch_create_invoices", {
    title: "Batch create Pohoda invoices with optional contacts",
    description: "Creates up to 50 invoices for one accounting unit in a single POHODA /XML run. Use this instead of repeated create_address/create_invoice calls when creating multiple invoices, especially when each invoice needs a new addressbook contact.",
    inputSchema: {
      invoices: z.array(batchInvoiceCreateSchema).min(1).max(50),
      dataPackId: z.string().default(""),
      databaseId: databaseIdSchema
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ invoices, dataPackId, databaseId }) => {
    const plans = invoices.map((entry, index) => batchInvoiceCreatePlan(entry, index));
    const database = await databaseName(databaseId);
    const response = await client.createInvoiceBatch(plans.map((plan) => ({
      requestId: plan.requestId,
      ...(plan.address ? { address: plan.address } : {}),
      header: plan.header,
      items: plan.items
    })), dataPackId, database);
    const data = response.toArray();
    const results = compactBatchCreateInvoiceResults(plans, data.items);
    const structuredContent = {
      ok: data.state === "ok" && results.every((result) => result.ok),
      state: data.state,
      database: activeDatabase(database),
      invoiceCount: plans.length,
      dataPackItemCount: data.items.length,
      transport: data.transport,
      results
    };
    return {
      content: [{ type: "text" as const, text: stringify(structuredContent) }],
      structuredContent
    };
  });

  server.registerTool("batch_write", {
    title: "Batch multiple Pohoda write/output operations",
    description: "Runs multiple typed write/output operations for one accounting unit in a single POHODA /XML process by packing them into one dataPack. Use this for mixed creates such as contacts, invoices, stock, orders, and print jobs instead of repeated single-write calls.",
    inputSchema: {
      operations: z.array(batchWriteOperationSchema).min(1).max(100),
      dataPackId: z.string().default(""),
      databaseId: databaseIdSchema
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ operations, dataPackId, databaseId }) => {
    const plans = operations.map((operation, index) => batchWriteOperationPlan(operation, index));
    const database = await databaseName(databaseId);
    const response = await client.writeBatch(plans.map((plan) => plan.operation), dataPackId, database);
    const data = response.toArray();
    const results = plans.map((plan, index) => compactBatchWriteResult(plan, data.items[index]));
    const structuredContent = {
      ok: data.state === "ok" && results.every((result) => result.ok),
      state: data.state,
      database: activeDatabase(database),
      operationCount: plans.length,
      transport: data.transport,
      results
    };
    return {
      content: [{ type: "text" as const, text: stringify(structuredContent) }],
      structuredContent
    };
  });

  server.registerTool("create_stock", {
    title: "Create Pohoda stock item",
    inputSchema: {
      code: z.string(), name: z.string(), sellingPrice: z.number(), unit: z.string().default("ks"), storage: z.string().default(""),
      vatRate: z.enum(vatRates).default("high"), purchasingPrice: z.number().default(0), EAN: z.string().default(""), PLU: z.number().int().default(0),
      isSales: z.boolean().default(true), isInternet: z.boolean().default(false), description: z.string().default(""), description2: z.string().default(""),
      limitMin: z.number().default(0), limitMax: z.number().default(0), mass: z.number().default(0), supplierId: z.number().int().default(0),
      guarantee: z.number().int().default(0), guaranteeType: z.string().default("year"), shortName: z.string().default(""), nameComplement: z.string().default(""),
      note: z.string().default(""), dataPackId: z.string().default(""), databaseId: databaseIdSchema
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ dataPackId, databaseId, ...data }) =>
    jsonResult(assertOk(await client.createStock(data, dataPackId, await databaseName(databaseId)))));

  server.registerTool("create_order", {
    title: "Create Pohoda order",
    inputSchema: {
      type: z.enum(["receivedOrder", "issuedOrder"]), partnerName: z.string(), date: z.string(),
      items: z.array(itemSchema).min(1), partnerIco: z.string().default(""), dataPackId: z.string().default(""), databaseId: databaseIdSchema
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ items, dataPackId, databaseId, ...header }) =>
    jsonResult(assertOk(await client.createOrder(header, items, dataPackId, await databaseName(databaseId)))));

  server.registerTool("print", {
    title: "Print Pohoda record",
    inputSchema: {
      agenda: z.enum(printAgendas), reportId: z.number().int(), recordId: z.number().int().default(0), pdfPath: z.string().default(""),
      pdfBase64: z.boolean().default(false), printer: z.string().default(""), copies: z.number().int().default(1), datePrint: z.string().default(""),
      queryFilter: z.string().default(""), userFilterName: z.string().default(""), usrAgenda: z.string().default(""),
      emailTo: z.string().default(""), emailCc: z.string().default(""), emailBcc: z.string().default(""), emailSubject: z.string().default(""),
      emailBody: z.string().default(""), emailTemplate: z.string().default(""), emailAttachments: z.string().default(""),
      emailPriority: z.enum(["", "normal", "low", "high"]).default(""), emailReturnReceipt: z.boolean().default(false),
      emailReadReceipt: z.boolean().default(false), removeFile: z.boolean().default(false), includeIsdoc: z.boolean().default(false),
      isdocGraphicNote: z.enum(["", "topRight", "topLeft", "bottomRight", "bottomLeft"]).default(""),
      parameters: z.record(z.string(), z.any()).default({}), databaseId: databaseIdSchema
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ databaseId, ...options }) =>
    jsonResult(assertOk(await client.printRecord({ ...options, database: await databaseName(databaseId) }))));

  server.registerTool("raw_xml", {
    title: "Send raw Pohoda XML",
    inputSchema: { xml: z.string().min(1), note: z.string().default(""), dataPackId: z.string().default(""), databaseId: databaseIdSchema },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ xml, note, dataPackId, databaseId }) =>
    jsonResult(assertOk(await client.sendRawXml(xml, note, dataPackId, clean({ databaseOverride: await databaseName(databaseId) })))));

  server.registerTool("raw_xml_batch", {
    title: "Send raw Pohoda XML batch",
    inputSchema: { items: z.array(z.string().min(1)).min(1), note: z.string().default(""), dataPackId: z.string().default(""), databaseId: databaseIdSchema },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ items, note, dataPackId, databaseId }) =>
    jsonResult(assertOk(await client.sendRawXmlBatch(items, note, dataPackId, clean({ databaseOverride: await databaseName(databaseId) })))));

  server.registerTool("create_data_export", {
    title: "Create compact persisted Pohoda data export",
    description: "Exports larger POHODA datasets into a persisted snapshot and returns compact preview, cursor, summary, and resource links instead of dumping all records into model context.",
    inputSchema: {
      kind: z.enum(["documents", "stock", "contacts", "export_agenda"]).default("documents"),
      agenda: z.string().default("invoice"),
      invoiceType: z.enum(["", "issuedInvoice", "receivedInvoice"]).default(""),
      documentType: z.enum(["", "receivedOrder", "issuedOrder", "receivedOffer", "issuedOffer", "receivedEnquiry", "issuedEnquiry"]).default(""),
      id: z.number().int().default(0),
      dateFrom: z.string().default(""),
      dateTill: z.string().default(""),
      company: z.string().default(""),
      ico: z.string().default(""),
      number: z.string().default(""),
      lastChanges: z.string().default(""),
      queryFilter: z.string().default(""),
      userFilterName: z.string().default(""),
      pageSize: z.number().int().min(1).max(1_000).default(100),
      maxRecords: z.number().int().min(1).max(100_000).default(1_000),
      previewLimit: z.number().int().min(0).max(100).default(10),
      databaseId: databaseIdSchema
    },
    outputSchema: exportOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async (args) => {
    const database = await databaseName(args.databaseId);
    const snapshot = await createExportSnapshot(args, database);
    const page = await exportStore.page(snapshot.exportId, "", args.previewLimit || 1);
    const structuredContent = exportResponse(snapshot, page.records.slice(0, args.previewLimit), page.nextCursor);
    return exportToolResult(structuredContent, "Created POHODA export snapshot.");
  });

  server.registerTool("create_data_export_bundle", {
    title: "Create multiple compact POHODA data exports efficiently",
    description: "Creates several persisted export snapshots for the same accounting unit. Page rounds are batched into shared POHODA /XML runs, so agents can fetch related datasets without paying startup cost per dataset.",
    inputSchema: {
      exports: z.array(dataExportSpecSchema).min(1).max(10),
      databaseId: databaseIdSchema,
      dataPackId: z.string().default("")
    },
    outputSchema: {
      ok: z.boolean(),
      database: z.string(),
      exportCount: z.number(),
      exports: z.array(z.record(z.string(), z.any()))
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ exports, databaseId, dataPackId }) => {
    const database = await databaseName(databaseId);
    const snapshots = await createExportBundleSnapshots(exports, database, dataPackId);
    const exportResults = await Promise.all(snapshots.map(async ({ requestId, snapshot, previewLimit }) => {
      const page = await exportStore.page(snapshot.exportId, "", previewLimit || 1);
      return {
        requestId,
        ...exportResponse(snapshot, page.records.slice(0, previewLimit), page.nextCursor)
      };
    }));
    const structuredContent = {
      ok: true,
      database: activeDatabase(database),
      exportCount: exportResults.length,
      exports: exportResults
    };
    return exportToolResult(structuredContent, "Created POHODA export bundle.");
  });

  server.registerTool("read_export_page", {
    title: "Read a compact page from a POHODA export",
    description: "Reads a bounded page from a persisted export snapshot using an opaque cursor returned by create_data_export or a previous page call.",
    inputSchema: {
      exportId: z.string().min(1),
      cursor: z.string().default(""),
      limit: z.number().int().min(1).max(1_000).default(50)
    },
    outputSchema: pageOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ exportId, cursor, limit }) => {
    const page = await exportStore.page(exportId, cursor, limit);
    const structuredContent = {
      exportId: page.exportId,
      offset: page.offset,
      limit: page.limit,
      returned: page.returned,
      total: page.total,
      nextCursor: page.nextCursor,
      summary: page.summary,
      records: page.records.map(compactRecord),
      resources: page.resources
    };
    return exportToolResult(structuredContent, "Read POHODA export page.");
  });

  server.registerTool("summarize_export", {
    title: "Summarize a persisted POHODA export",
    description: "Returns compact server-side totals for a persisted export without returning the full record payload.",
    inputSchema: { exportId: z.string().min(1) },
    outputSchema: summaryOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ exportId }) => {
    const snapshot = await exportStore.get(exportId);
    const structuredContent = {
      exportId,
      kind: snapshot.kind,
      agenda: snapshot.agenda,
      database: snapshot.database,
      count: snapshot.records.length,
      summary: snapshot.summary,
      resources: snapshot.resources
    };
    return exportToolResult(structuredContent, "Summarized POHODA export.");
  });

  server.registerTool("cleanup_export", {
    title: "Delete a persisted POHODA export",
    inputSchema: { exportId: z.string().min(1) },
    outputSchema: { exportId: z.string(), deleted: z.boolean() },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ exportId }) => {
    await exportStore.delete(exportId);
    const structuredContent = { exportId, deleted: true };
    return {
      content: [{ type: "text" as const, text: stringify(structuredContent) }],
      structuredContent
    };
  });

  registerResources(server, { ...context, exportStore });

  async function databaseName(databaseId: string): Promise<string> {
    const trimmed = databaseId.trim();
    if (trimmed === "") {
      if (client.getDatabase().trim() !== "") {
        return "";
      }
      throw new Error("databaseId is required for this tool because no default POHODA database is configured. Use list_accounting_units or list_xml_databases, then pass the registry id or exact database name as databaseId.");
    }
    if (!databaseRegistry) {
      return trimmed;
    }
    try {
      return (await databaseRegistry.get(trimmed)).database;
    } catch {
      return trimmed;
    }
  }

  function activeDatabase(databaseOverride: string): string {
    return databaseOverride || client.getDatabase();
  }

  /*
   * Current database mutation was intentionally removed from the MCP tool surface.
   * Tools should target accounting units with explicit databaseId values; the client
   * default is now only a configured fallback for simple single-company setups.
   */
  async function createExportSnapshot(args: {
    kind: "documents" | "stock" | "contacts" | "export_agenda";
    agenda: string;
    invoiceType: "" | "issuedInvoice" | "receivedInvoice";
    documentType: "" | "receivedOrder" | "issuedOrder" | "receivedOffer" | "issuedOffer" | "receivedEnquiry" | "issuedEnquiry";
    id: number;
    dateFrom: string;
    dateTill: string;
    company: string;
    ico: string;
    number: string;
    lastChanges: string;
    queryFilter: string;
    userFilterName: string;
    pageSize: number;
    maxRecords: number;
  }, database: string): Promise<ExportSnapshot> {
    const plan = exportPlan(args);
    if (args.kind === "export_agenda") {
      assertExportAgendaFilters(args.agenda, {
        id: args.id,
        lastChanges: args.lastChanges,
        userFilterName: args.userFilterName,
        queryFilter: args.queryFilter,
        idFrom: 0,
        count: args.pageSize
      });
    }
    const filters = clean({
      id: args.id || undefined,
      dateFrom: args.dateFrom,
      dateTill: args.dateTill,
      company: args.company,
      ico: args.ico,
      number: args.number,
      lastChanges: args.lastChanges,
      queryFilter: args.queryFilter,
      userFilterName: args.userFilterName
    });
    const records: ExportRecord[] = [];
    let idFrom = 0;
    let fetchedPages = 0;
    let complete = false;
    while (records.length < args.maxRecords) {
      const count = Math.min(args.pageSize, args.maxRecords - records.length);
      const options = plan.useServerLimit ? { idFrom, count, database } : { database };
      const response = assertOk(await client.listRecords(plan.agenda, filters, plan.subtype, options));
      fetchedPages += 1;
      const pageRecords = extractRecords(response).map((record, pageIndex) => normalizeExportRecord(record, records.length + pageIndex));
      records.push(...pageRecords);
      const maxId = maxNumericId(pageRecords);
      if (!plan.useServerLimit || pageRecords.length < count || maxId <= idFrom) {
        complete = true;
        break;
      }
      idFrom = maxId + 1;
    }
    const capped = records.slice(0, args.maxRecords);
    return exportStore.save({
      kind: args.kind,
      agenda: plan.agenda,
      subtype: plan.subtype,
      database: activeDatabase(database),
      ico: client.getIco(),
      filters,
      paging: {
        requestedPageSize: args.pageSize,
        maxRecords: args.maxRecords,
        fetchedPages,
        complete
      },
      summary: summarizeRecords(capped),
      records: capped
    });
  }

  async function createExportBundleSnapshots(specs: Array<z.infer<typeof dataExportSpecSchema>>, database: string, dataPackId: string): Promise<Array<{
    requestId: string;
    previewLimit: number;
    snapshot: ExportSnapshot;
  }>> {
    const states = specs.map((spec, index) => {
      const plan = exportPlan(spec);
      if (spec.kind === "export_agenda") {
        assertExportAgendaFilters(spec.agenda, {
          id: spec.id,
          lastChanges: spec.lastChanges,
          userFilterName: spec.userFilterName,
          queryFilter: spec.queryFilter,
          idFrom: 0,
          count: spec.pageSize
        });
      }
      return {
        requestId: spec.requestId.trim() || `export-${index + 1}`,
        spec,
        plan,
        filters: clean({
          id: spec.id || undefined,
          dateFrom: spec.dateFrom,
          dateTill: spec.dateTill,
          company: spec.company,
          ico: spec.ico,
          number: spec.number,
          lastChanges: spec.lastChanges,
          queryFilter: spec.queryFilter,
          userFilterName: spec.userFilterName
        }),
        records: [] as ExportRecord[],
        idFrom: 0,
        fetchedPages: 0,
        complete: false
      };
    });

    let round = 0;
    while (states.some((state) => !state.complete && state.records.length < state.spec.maxRecords)) {
      const active = states.filter((state) => !state.complete && state.records.length < state.spec.maxRecords);
      const requests = active.map((state) => {
        const count = Math.min(state.spec.pageSize, state.spec.maxRecords - state.records.length);
        return {
          agenda: state.plan.agenda,
          filter: state.filters,
          subType: state.plan.subtype,
          options: state.plan.useServerLimit ? { idFrom: state.idFrom, count, database } : { database },
          note: `${state.requestId}:page-${state.fetchedPages + 1}`
        };
      });
      const roundId = dataPackId === "" ? "" : suffixedDataPackId(dataPackId, `-r${round + 1}`);
      const response = assertOk(await client.listRecordsBatch(requests, roundId, clean({ databaseOverride: database })));
      active.forEach((state, index) => {
        const item = response.items?.[index];
        state.fetchedPages += 1;
        const count = Math.min(state.spec.pageSize, state.spec.maxRecords - state.records.length);
        const pageRecords = extractRecordsFromItemData(item?.data ?? {})
          .map((record, pageIndex) => normalizeExportRecord(record, state.records.length + pageIndex));
        state.records.push(...pageRecords);
        const maxId = maxNumericId(pageRecords);
        if (!state.plan.useServerLimit || pageRecords.length < count || maxId <= state.idFrom) {
          state.complete = true;
        } else {
          state.idFrom = maxId + 1;
        }
      });
      round += 1;
    }

    return Promise.all(states.map(async (state) => ({
      requestId: state.requestId,
      previewLimit: state.spec.previewLimit,
      snapshot: await exportStore.save({
        kind: state.spec.kind,
        agenda: state.plan.agenda,
        subtype: state.plan.subtype,
        database: activeDatabase(database),
        ico: client.getIco(),
        filters: state.filters,
        paging: {
          requestedPageSize: state.spec.pageSize,
          maxRecords: state.spec.maxRecords,
          fetchedPages: state.fetchedPages,
          complete: state.complete
        },
        summary: summarizeRecords(state.records.slice(0, state.spec.maxRecords)),
        records: state.records.slice(0, state.spec.maxRecords)
      })
    })));
  }
}

function registerResources(server: McpServer, context: PohodaServerContext): void {
  const exportStore = context.exportStore;
  server.registerResource("agendas", "pohoda://enums/agendas", { mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: stringify({
      documents: { tool: "list_documents", agendas: documentAgendas },
      stock: { tool: "list_stock", agendas: ["stock"] },
      contacts: { tool: "list_contacts", agendas: ["addressbook"] },
      export_agendas: { tool: "list_export_agenda", agendas: exportAgendas }
    }) }]
  }));
  server.registerResource("xml-databases", "pohoda://xml-databases", { mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: stringify({ databases: context.databaseRegistry ? await context.databaseRegistry.all() : [] }) }]
  }));
  server.registerResource("vat-rates", "pohoda://enums/vat-rates", { mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: stringify({ none: "No VAT (exempt)", low: "Reduced VAT rate", high: "Standard VAT rate" }) }]
  }));
  server.registerResource("payment-types", "pohoda://enums/payment-types", { mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: stringify({ draft: "Bank transfer / draft", cash: "Cash", card: "Card payment", compensation: "Compensation/offset" }) }]
  }));
  server.registerResource("print-agendas", "pohoda://enums/print-agendas", { mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: stringify(Object.fromEntries(printAgendas.map((agenda) => [agenda, "Pohoda print agenda"]))) }]
  }));
  server.registerResource("guide", "pohoda://guide", { mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: stringify({
      listing: {
        targetDatabase: "For accounting-unit-specific tools, pass databaseId explicitly using a registry id or exact POHODA database name. current_database only shows the configured fallback; there is no select_database step. If databaseId is omitted and no default database is configured, the tool fails before running POHODA.",
        use: {
          list_documents: "Transactional documents; invoice requires invoiceType, order requires documentType.",
          list_stock: "Stock cards and inventory items.",
          list_contacts: "Address book records.",
          list_export_agenda: "Read-only codebooks/reference lists.",
          batch_list_records: "Several read/list requests for one accounting unit in a single POHODA /XML run."
        },
        efficiency: "Tools default server-side count to limit. Increase count only when needed; use idFrom for paging.",
        filters: "Prefer explicit filters first. extId requires extSystemName."
      },
      writing: {
        use: {
          create_invoice: "One invoice.",
          create_address: "One addressbook contact.",
          create_stock: "One stock card.",
          create_order: "One order.",
          print: "One print/PDF/email output job.",
          batch_write: "Several typed write/output operations for one accounting unit in a single POHODA /XML run.",
          batch_create_invoices: "Convenience tool for several invoices, optionally with one addressbook contact before each invoice, in a single POHODA /XML run."
        },
        efficiency: "Use batch_write whenever you need more than one write/output operation in the same accounting unit. Use batch_create_invoices for repeated contact+invoice workflows. Both avoid paying Pohoda.exe startup once per item while preserving per-operation results.",
        ordering: "Operations run in the order supplied inside one dataPack. For batch_create_invoices, when createAddress is true, each contact is placed immediately before its invoice.",
        parallelism: "Do not mix accounting units in one batch. Send one batch per database; different database batches can run in parallel through the transport queue."
      },
      xmlTransport: {
        queueing: "Same-database calls are serialized with a per-database lock. Different databases run in parallel up to the process cap.",
        batching: "Use batch_list_records when several typed reads are known up front. Use create_data_export_bundle for several persisted exports. Use batch_write for multi-operation writes, batch_create_invoices for invoice-heavy workflows, and raw_xml_batch only for advanced custom multi-item dataPacks.",
        freshness: "Normal list/create/status calls ask POHODA each time. list_xml_databases refreshes configured/filesystem sources each time. Export snapshots are intentionally point-in-time; create a new export after UI changes.",
        discovery: "Use list_accounting_units for official live discovery. It always asks POHODA and supports fuzzy query plus ICO, DIČ, city, database, and year filters; use cursors instead of asking for every client at once. list_xml_databases(includeLive=true) combines refreshed configured/filesystem sources with live POHODA sources.",
        idempotency: "Create/raw tools accept dataPackId for duplicate checking."
      },
      largeExports: {
        use: "Use create_data_export for one large dataset or create_data_export_bundle for several related datasets. They return compact preview rows, summary totals, opaque nextCursor values, and resource links to full JSON/NDJSON data.",
        paging: "Use read_export_page with the returned exportId and nextCursor. Cursors are opaque and expire with the export snapshot.",
        summaries: "Use summarize_export for totals without loading full records into model context. For invoice exports, summary.total/byCurrency/byPartner/byMonth are home-currency totals, normally CZK; foreign invoice totals are separate in summary.foreignCurrency keyed by currency code.",
        cleanup: "Use cleanup_export when the snapshot is no longer needed."
      }
    }) }]
  }));
  if (exportStore) {
    server.registerResource("export-file", new ResourceTemplate("pohoda://exports/{exportId}/{file}", { list: undefined }), {
      title: "POHODA persisted export file",
      mimeType: "application/json",
      description: "Reads persisted export metadata, records.json, records.ndjson, or summary.json by exportId."
    }, async (uri, variables) => {
      const exportId = String(variables.exportId ?? "");
      const file = String(variables.file ?? "");
      const result = await exportStore.readResource(exportId, file);
      return { contents: [{ uri: uri.href, mimeType: result.mimeType, text: result.text }] };
    });
  }
}

export function assertOk(response: PohodaResponse): Record<string, any> {
  const data = response.toArray();
  if (!response.isOk()) {
    throw new Error(`Pohoda XML returned error: ${stringify(data)}`);
  }
  return data;
}

function exportPlan(args: {
  kind: "documents" | "stock" | "contacts" | "export_agenda";
  agenda: string;
  invoiceType: string;
  documentType: string;
}): { agenda: string; subtype: string; useServerLimit: boolean } {
  if (args.kind === "stock") {
    return { agenda: "stock", subtype: "", useServerLimit: true };
  }
  if (args.kind === "contacts") {
    return { agenda: "addressbook", subtype: "", useServerLimit: true };
  }
  if (args.kind === "export_agenda") {
    if (!exportAgendas.includes(args.agenda as any)) {
      throw new Error(`Unsupported export agenda '${args.agenda}'.`);
    }
    const useServerLimit = !exportAgendasWithoutServerLimit.includes(args.agenda as any);
    return { agenda: args.agenda, subtype: "", useServerLimit };
  }
  if (!documentAgendas.includes(args.agenda as any)) {
    throw new Error(`Unsupported document agenda '${args.agenda}'.`);
  }
  if (args.agenda === "invoice" && args.invoiceType === "") {
    throw new Error("invoiceType is required for invoice exports.");
  }
  if (args.agenda === "order" && args.documentType === "") {
    throw new Error("documentType is required for order exports.");
  }
  return { agenda: args.agenda, subtype: args.agenda === "invoice" ? args.invoiceType : args.documentType, useServerLimit: true };
}

function exportResponse(snapshot: ExportSnapshot, preview: ExportRecord[], nextCursor: string): Record<string, unknown> {
  return {
    exportId: snapshot.exportId,
    kind: snapshot.kind,
    agenda: snapshot.agenda,
    subtype: snapshot.subtype,
    database: snapshot.database,
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
    count: snapshot.records.length,
    complete: snapshot.paging.complete,
    nextCursor,
    summary: snapshot.summary,
    preview: preview.map(compactRecord),
    resources: snapshot.resources
  };
}

function exportToolResult(structuredContent: Record<string, unknown>, text: string) {
  const resources = (structuredContent.resources ?? {}) as Record<string, string>;
  const resourceLinks = Object.entries(resources).map(([name, uri]) => ({
    type: "resource_link" as const,
    uri,
    name,
    mimeType: uri.endsWith(".ndjson") ? "application/x-ndjson" : "application/json",
    description: `POHODA export ${name}`
  }));
  return {
    content: [
      { type: "text" as const, text: `${text}\n${stringify(structuredContent)}` },
      ...resourceLinks
    ],
    structuredContent
  };
}

function extractRecords(data: Record<string, any>): Record<string, any>[] {
  const item = data.items?.[0]?.data ?? {};
  return extractRecordsFromItemData(item);
}

function extractRecordsFromItemData(item: Record<string, any>): Record<string, any>[] {
  const candidates = ["invoice", "stock", "addressbook", "order", "voucher", "bank", "contract", "intDoc", "offer", "enquiry", "vydejka", "prijemka", "prodejka", "prevodka", "vyroba", "accountancy", "movement"];
  for (const key of candidates) {
    if (Array.isArray(item[key])) {
      return item[key] as Record<string, any>[];
    }
    if (item[key] && typeof item[key] === "object") {
      return [item[key] as Record<string, any>];
    }
  }
  for (const value of Object.values(item)) {
    if (Array.isArray(value)) {
      return value.filter((entry) => entry && typeof entry === "object") as Record<string, any>[];
    }
  }
  return [];
}

function normalizeExportRecord(raw: Record<string, any>, index: number): ExportRecord {
  const header = firstRecord(raw.invoiceHeader, raw.stockHeader, raw.addressbookHeader, raw.orderHeader, raw.voucherHeader, raw.bankHeader, raw);
  const identity = firstRecord(header.partnerIdentity, header.identity, header.accountingUnitIdentity, {});
  const address = firstRecord(identity.address, header.address, {});
  const summary = firstRecord(raw.invoiceSummary, raw.orderSummary, raw.summary, {});
  const amounts = extractCurrencyAmounts(summary, raw, header);
  return clean({
    index,
    id: numberOrString(header.id ?? raw.id ?? ""),
    number: asText(firstRecord(header.number, raw.number, {}).numberRequested ?? header.code ?? header.number ?? raw.number),
    date: asText(header.date ?? header.dateAccounting ?? raw.date ?? ""),
    partner: asText(address.company ?? header.company ?? header.name ?? raw.name ?? ""),
    ico: asText(address.ico ?? header.ico ?? raw.ico ?? ""),
    text: asText(header.text ?? raw.text ?? ""),
    total: amounts.homeCurrency.total,
    currency: amounts.homeCurrency.currency,
    homeCurrency: amounts.homeCurrency,
    foreignCurrency: amounts.foreignCurrency,
    raw
  }) as ExportRecord;
}

function compactRecord(record: ExportRecord): Record<string, unknown> {
  return clean({
    index: record.index,
    id: record.id,
    number: record.number,
    date: record.date,
    partner: record.partner,
    ico: record.ico,
    text: record.text,
    total: record.total,
    currency: record.currency,
    homeCurrency: record.homeCurrency,
    foreignCurrency: record.foreignCurrency
  });
}

function maxNumericId(records: ExportRecord[]): number {
  return Math.max(0, ...records.map((record) => typeof record.id === "number" ? record.id : Number(record.id)).filter((id) => Number.isFinite(id)));
}

function extractTotal(summary: Record<string, any>, raw: Record<string, any>, header: Record<string, any> = {}): number {
  const candidates = [
    summary.homeCurrency?.priceHighSum,
    summary.homeCurrency?.priceSum,
    summary.homeCurrency?.priceNone,
    findDeepNumber(raw, "amountHome"),
    header.sellingPrice,
    header.price,
    header.weightedPurchasePrice,
    raw.total,
    raw.price
  ];
  return firstNumber(...candidates);
}

function extractCurrencyAmounts(summary: Record<string, any>, raw: Record<string, any>, header: Record<string, any>): { homeCurrency: CurrencyTotal; foreignCurrency?: CurrencyTotal } {
  const home = firstRecord(summary.homeCurrency, {});
  const foreign = firstRecord(summary.foreignCurrency, {});
  const homeCurrency = asText(home.currency?.ids ?? home.currency?.id ?? "CZK") || "CZK";
  const homeTotal = firstNumber(
    home.priceHighSum,
    home.priceSum,
    home.priceNone,
    findDeepNumber(raw, "amountHome"),
    extractTotal(summary, raw, header)
  );
  const foreignCurrency = asText(foreign.currency?.ids ?? foreign.currency?.id ?? "");
  const foreignTotal = firstNumber(
    foreign.priceSum,
    foreign.amount,
    findDeepNumber(raw, "amountForeign")
  );
  return clean({
    homeCurrency: { currency: homeCurrency, total: round2(homeTotal) },
    foreignCurrency: foreignCurrency !== "" && foreignTotal !== 0 ? { currency: foreignCurrency, total: round2(foreignTotal) } : undefined
  }) as { homeCurrency: CurrencyTotal; foreignCurrency?: CurrencyTotal };
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const number = Number(String(value ?? "").replace(",", "."));
    if (Number.isFinite(number) && number !== 0) {
      return round2(number);
    }
  }
  return 0;
}

function findDeepNumber(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepNumber(item, key);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record[key] !== undefined) {
    return record[key];
  }
  for (const child of Object.values(record)) {
    const found = findDeepNumber(child, key);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function firstRecord(...values: unknown[]): Record<string, any> {
  for (const value of values) {
    if (Array.isArray(value) && value[0] && typeof value[0] === "object") {
      return value[0] as Record<string, any>;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, any>;
    }
  }
  return {};
}

function numberOrString(value: unknown): number | string {
  const numeric = Number(value);
  return Number.isInteger(numeric) && String(value).trim() !== "" ? numeric : asText(value);
}

function asText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function exportOutputSchema() {
  return {
    exportId: z.string(),
    kind: z.string(),
    agenda: z.string(),
    subtype: z.string(),
    database: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    count: z.number(),
    complete: z.boolean(),
    nextCursor: z.string(),
    summary: z.record(z.string(), z.any()),
    preview: z.array(z.record(z.string(), z.any())),
    resources: z.record(z.string(), z.string())
  };
}

function pageOutputSchema() {
  return {
    exportId: z.string(),
    offset: z.number(),
    limit: z.number(),
    returned: z.number(),
    total: z.number(),
    nextCursor: z.string(),
    summary: z.record(z.string(), z.any()),
    records: z.array(z.record(z.string(), z.any())),
    resources: z.record(z.string(), z.string())
  };
}

function summaryOutputSchema() {
  return {
    exportId: z.string(),
    kind: z.string(),
    agenda: z.string(),
    database: z.string(),
    count: z.number(),
    summary: z.record(z.string(), z.any()),
    resources: z.record(z.string(), z.string())
  };
}

function batchListOperationPlan(args: z.infer<typeof batchListOperationSchema>, index: number): {
  requestId: string;
  tool: string;
  agenda: string;
  subtype: string;
  filter: Record<string, any>;
  options: Record<string, any>;
  limit: number;
} {
  const requestId = args.requestId.trim() || `op-${index + 1}`;
  if (args.tool === "list_documents") {
    if (!documentAgendas.includes(args.agenda as any)) {
      throw new Error(`Operation ${requestId}: unsupported document agenda '${args.agenda}'.`);
    }
    if (args.agenda === "invoice" && args.invoiceType === "") {
      throw new Error(`Operation ${requestId}: invoiceType is required for invoice exports.`);
    }
    if (args.agenda === "order" && args.documentType === "") {
      throw new Error(`Operation ${requestId}: documentType is required for order exports.`);
    }
    assertExtId(args.extId, args.extSystemName);
    return {
      requestId,
      tool: args.tool,
      agenda: args.agenda,
      subtype: args.agenda === "invoice" ? args.invoiceType : args.documentType,
      filter: clean({
        id: args.id || undefined,
        extId: args.extId ? { ids: args.extId, exSystemName: args.extSystemName } : undefined,
        dateFrom: args.dateFrom,
        dateTill: args.dateTill,
        company: args.company,
        ico: args.ico,
        number: args.number,
        lastChanges: args.lastChanges,
        userFilterName: args.userFilterName,
        queryFilter: args.queryFilter
      }),
      options: {
        idFrom: args.idFrom,
        count: args.count || args.limit,
        restrictions: documentRestrictions(args.agenda, args)
      },
      limit: args.limit
    };
  }
  if (args.tool === "list_stock") {
    assertExtId(args.extId, args.extSystemName);
    return {
      requestId,
      tool: args.tool,
      agenda: "stock",
      subtype: "",
      filter: clean({
        id: args.id || undefined,
        extId: args.extId ? { ids: args.extId, exSystemName: args.extSystemName } : undefined,
        code: args.code,
        name: args.name,
        EAN: args.EAN,
        PLU: args.PLU || undefined,
        storage: args.storage,
        store: args.store,
        internet: args.internet,
        lastChanges: args.lastChanges,
        userFilterName: args.userFilterName,
        queryFilter: args.queryFilter
      }),
      options: {
        idFrom: args.idFrom,
        count: args.count || args.limit,
        restrictions: clean({
          "lStk:relatedFiles": args.includeRelatedFiles,
          "lStk:relatedLinks": args.includeRelatedLinks,
          "lStk:pictures": args.includePictures,
          "lStk:categories": args.includeCategories,
          "lStk:relatedStocks": args.includeRelatedStocks,
          "lStk:alternativeStocks": args.includeAlternativeStocks,
          "lStk:intParameters": args.includeIntParameters,
          "lStk:stockItem": args.includeStockItem,
          "lStk:stockAttach": args.includeStockAttach,
          "lStk:stockSerialNumber": args.includeStockSerialNumber,
          "lStk:stockPriceItem": args.includeStockPriceItem,
          "lStk:stockParameters": args.includeStockParameters,
          "lStk:attachments": args.includeAttachments
        })
      },
      limit: args.limit
    };
  }
  if (args.tool === "list_contacts") {
    assertExtId(args.extId, args.extSystemName);
    return {
      requestId,
      tool: args.tool,
      agenda: "addressbook",
      subtype: "",
      filter: clean({
        id: args.id || undefined,
        extId: args.extId ? { ids: args.extId, exSystemName: args.extSystemName } : undefined,
        company: args.company,
        ico: args.ico,
        name: args.name,
        city: args.city,
        street: args.street,
        zip: args.zip,
        dic: args.dic,
        addressNumber: args.number,
        lastChanges: args.lastChanges,
        userFilterName: args.userFilterName,
        queryFilter: args.queryFilter
      }),
      options: {
        idFrom: args.idFrom,
        count: args.count || args.limit,
        restrictions: clean({ "lAdb:attachments": args.includeAttachments })
      },
      limit: args.limit
    };
  }
  if (!exportAgendas.includes(args.agenda as any)) {
    throw new Error(`Operation ${requestId}: unsupported export agenda '${args.agenda}'.`);
  }
  assertExportAgendaFilters(args.agenda, {
    id: args.id,
    lastChanges: args.lastChanges,
    userFilterName: args.userFilterName,
    queryFilter: args.queryFilter,
    idFrom: args.idFrom,
    count: args.count
  });
  return {
    requestId,
    tool: args.tool,
    agenda: args.agenda,
    subtype: "",
    filter: clean({
      id: args.id || undefined,
      lastChanges: args.lastChanges,
      userFilterName: args.userFilterName,
      queryFilter: args.queryFilter
    }),
    options: {
      idFrom: args.idFrom,
      count: exportAgendasWithoutServerLimit.includes(args.agenda as any) ? args.count : (args.count || args.limit)
    },
    limit: args.limit
  };
}

function compactBatchListResult(plan: ReturnType<typeof batchListOperationPlan>, item: Record<string, any> | undefined): Record<string, unknown> {
  const data = cloneJson(item?.data ?? {});
  const truncated = truncateFirstArray(data, plan.limit);
  return clean({
    requestId: plan.requestId,
    tool: plan.tool,
    agenda: plan.agenda,
    subtype: plan.subtype,
    ok: item?.state === "ok",
    state: item?.state ?? "missing",
    itemId: item?.id ?? "",
    attributes: item?.attributes ?? {},
    limit: plan.limit,
    truncated,
    data
  });
}

function batchInvoiceCreatePlan(args: z.infer<typeof batchInvoiceCreateSchema>, index: number): {
  requestId: string;
  createAddress: boolean;
  address?: Record<string, any>;
  header: Record<string, any>;
  items: Record<string, any>[];
} {
  const requestId = args.requestId !== "" ? args.requestId : `invoice-${index + 1}`;
  const { items, ...header } = args.invoice;
  const address = clean({
    company: args.address.company || args.invoice.partnerName,
    ico: args.address.ico || args.invoice.partnerIco,
    dic: args.address.dic,
    street: args.address.street || args.invoice.partnerStreet,
    city: args.address.city || args.invoice.partnerCity,
    zip: args.address.zip || args.invoice.partnerZip,
    phone: args.address.phone,
    email: args.address.email
  });
  if (args.createAddress && String(address.company ?? "") === "") {
    throw new Error(`Invoice batch entry ${requestId}: address.company or invoice.partnerName is required when createAddress is true.`);
  }
  if (!args.createAddress && Number(args.invoice.partnerId ?? 0) <= 0 && args.invoice.partnerName === "") {
    throw new Error(`Invoice batch entry ${requestId}: invoice.partnerName or invoice.partnerId is required.`);
  }
  return clean({
    requestId,
    createAddress: args.createAddress,
    address: args.createAddress ? address : undefined,
    header,
    items
  }) as {
    requestId: string;
    createAddress: boolean;
    address?: Record<string, any>;
    header: Record<string, any>;
    items: Record<string, any>[];
  };
}

function compactBatchCreateInvoiceResults(plans: ReturnType<typeof batchInvoiceCreatePlan>[], items: Record<string, any>[]): Array<Record<string, any>> {
  let offset = 0;
  return plans.map((plan) => {
    const addressItem = plan.createAddress ? items[offset++] : undefined;
    const invoiceItem = items[offset++];
    return clean({
      requestId: plan.requestId,
      ok: (!plan.createAddress || addressItem?.state === "ok") && invoiceItem?.state === "ok",
      address: plan.createAddress ? compactCreateStep("address", addressItem) : undefined,
      invoice: compactCreateStep("invoice", invoiceItem)
    });
  });
}

function batchWriteOperationPlan(args: z.infer<typeof batchWriteOperationSchema>, index: number): {
  requestId: string;
  tool: z.infer<typeof batchWriteOperationSchema>["tool"];
  operation: Parameters<PohodaClient["writeBatch"]>[0][number];
} {
  const requestId = args.requestId !== "" ? args.requestId : `${args.tool}-${index + 1}`;
  if (args.tool === "create_invoice") {
    const { items, ...header } = args.data;
    return { requestId, tool: args.tool, operation: { requestId, tool: args.tool, header, items } };
  }
  if (args.tool === "create_order") {
    const { items, ...header } = args.data;
    return { requestId, tool: args.tool, operation: { requestId, tool: args.tool, header, items } };
  }
  if (args.tool === "print") {
    return { requestId, tool: args.tool, operation: { requestId, tool: args.tool, options: args.data } };
  }
  return { requestId, tool: args.tool, operation: { requestId, tool: args.tool, data: args.data } };
}

function compactBatchWriteResult(plan: ReturnType<typeof batchWriteOperationPlan>, item: Record<string, any> | undefined): Record<string, any> {
  return clean({
    requestId: plan.requestId,
    tool: plan.tool,
    ...compactCreateStep(plan.tool, item)
  });
}

function compactCreateStep(kind: string, item: Record<string, any> | undefined): Record<string, any> {
  return clean({
    kind,
    ok: item?.state === "ok",
    state: item?.state ?? "missing",
    itemId: item?.id ?? "",
    attributes: item?.attributes ?? {},
    importDetails: item?.data?.importDetails,
    producedDetails: item?.data?.producedDetails,
    data: item?.data ?? {}
  });
}

function truncateFirstArray(data: Record<string, any>, limit: number): string {
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > limit) {
      const total = value.length;
      data[key] = value.slice(0, limit);
      return `Showing first ${limit} of ${total} records for '${key}'. Refine filters or lower count to narrow.`;
    }
  }
  return "";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function suffixedDataPackId(dataPackId: string, suffix: string): string {
  if (dataPackId.length + suffix.length <= 64) {
    return `${dataPackId}${suffix}`;
  }
  return `${dataPackId.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
}

function jsonResult(data: unknown) {
  return jsonText(stringify(data));
}

function jsonText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function stringify(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function clean<T extends Record<string, any>>(data: T): Record<string, any> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== "" && value !== null && value !== undefined));
}

function assertExtId(extId: string, extSystemName: string): void {
  if (extId !== "" && extSystemName === "") {
    throw new Error("extSystemName is required when extId is used.");
  }
  if (extId === "" && extSystemName !== "") {
    throw new Error("extId is required when extSystemName is used.");
  }
}

function assertExportAgendaFilters(agenda: string, args: { id: number; lastChanges: string; userFilterName: string; queryFilter: string; idFrom: number; count: number }): void {
  if (exportAgendasWithoutServerLimit.includes(agenda as any) && (args.idFrom > 0 || args.count > 0)) {
    throw new Error(`${agenda} export does not support server-side idFrom/count paging.`);
  }
  if (exportAgendasWithoutFilters.includes(agenda as any) && (args.id > 0 || args.lastChanges !== "" || args.userFilterName !== "" || args.queryFilter !== "")) {
    throw new Error(`${agenda} export does not support filters; call it without id, lastChanges, userFilterName, or queryFilter.`);
  }
  if (args.lastChanges !== "" && !exportAgendasWithLastChanges.includes(agenda as any)) {
    throw new Error(`${agenda} export does not support lastChanges. Use id, userFilterName, queryFilter, or raw_xml if the schema has an agenda-specific filter.`);
  }
}

function documentRestrictions(agenda: string, args: Record<string, any>): Record<string, boolean> {
  if (agenda === "movement") {
    if (args.includeDocuments !== undefined || args.includeAttachments !== undefined || args.includeParameters !== undefined || args.includeLiquidations !== undefined) {
      throw new Error("movement export does not support restrictionData flags.");
    }
    return {};
  }
  if (agenda === "contract") {
    if (args.includeDocuments !== undefined || args.includeLiquidations !== undefined) {
      throw new Error("contract export supports only includeAttachments and includeParameters restriction flags.");
    }
    return clean({ "lCon:attachments": args.includeAttachments, "lCon:parameters": args.includeParameters }) as Record<string, boolean>;
  }
  return clean({
    "lst:documents": args.includeDocuments,
    "lst:attachments": args.includeAttachments,
    "lst:parameters": args.includeParameters,
    "lst:liquidations": args.includeLiquidations
  }) as Record<string, boolean>;
}

function accountingUnitPage(units: XmlDatabase[], args: {
  query: string;
  ico: string;
  dic: string;
  year: number;
  database: string;
  city: string;
  cursor: string;
  limit: number;
  includeRaw: boolean;
}): Record<string, unknown> {
  const filters = clean({
    ico: args.ico,
    dic: args.dic,
    year: args.year || undefined,
    database: args.database,
    city: args.city
  });
  const scored = units
    .map((unit) => ({ unit, score: accountingUnitScore(unit, args.query) }))
    .filter(({ unit, score }) =>
      score > 0
      && fieldMatches(unit.ico, args.ico)
      && fieldMatches(unit.dic, args.dic)
      && (args.year <= 0 || unit.year === args.year)
      && fieldMatches(unit.database, args.database)
      && fieldMatches(unit.city, args.city)
    )
    .sort((a, b) => b.score - a.score || String(a.unit.name).localeCompare(String(b.unit.name), "cs"));
  const offset = args.cursor === "" ? 0 : decodeAccountingCursor(args.cursor);
  const limit = Math.max(1, Math.min(500, args.limit));
  const page = scored.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    total: scored.length,
    returned: page.length,
    nextCursor: nextOffset < scored.length ? encodeAccountingCursor(nextOffset) : "",
    query: args.query,
    filters,
    units: page.map(({ unit, score }) => compactAccountingUnit(unit, score, args.includeRaw))
  };
}

export function extractAccountingUnits(data: Record<string, any>, limit: number, includeRaw = false): XmlDatabase[] {
  let items = data.items?.[0]?.data?.itemAccountingUnit ?? [];
  if (!Array.isArray(items)) {
    items = [items];
  }
  return items.slice(0, Math.max(1, limit)).map((item: any, index: number) => {
    const dataFile = String(item.dataFile ?? "");
    const database = dataFile !== "" ? databaseNameFromPath(dataFile) : `accounting-unit-${index + 1}`;
    const address = item.accountingUnitIdentity?.address ?? {};
    return clean({
      id: safeId(database),
      name: address.company || database,
      database,
      source: "official-xml",
      path: dataFile || undefined,
      ico: address.ico,
      dic: address.dic,
      city: address.city,
      personName: address.name,
      street: address.street,
      zip: address.zip,
      dateFrom: item.dateFrom,
      dateTo: item.dateTo,
      unitType: item.unitType,
      stateType: item.stateType,
      ...(includeRaw ? { raw: item } : {}),
      year: item.year ? Number(item.year) : undefined
    }) as XmlDatabase;
  });
}

function compactAccountingUnit(unit: XmlDatabase, score: number, includeRaw: boolean): Record<string, unknown> {
  return clean({
    id: unit.id,
    name: unit.name,
    database: unit.database,
    ico: unit.ico,
    dic: unit.dic,
    city: unit.city,
    personName: unit.personName,
    street: unit.street,
    zip: unit.zip,
    year: unit.year,
    dateFrom: unit.dateFrom,
    dateTo: unit.dateTo,
    unitType: unit.unitType,
    stateType: unit.stateType,
    score,
    source: unit.source,
    path: unit.path,
    ...(includeRaw && (unit as any).raw ? { raw: (unit as any).raw } : {})
  });
}

function accountingUnitScore(unit: XmlDatabase, query: string): number {
  const trimmed = query.trim();
  if (trimmed === "") {
    return 1;
  }
  const fields = [
    unit.name,
    unit.personName,
    unit.ico,
    unit.dic,
    unit.database,
    unit.city,
    unit.street,
    unit.zip,
    unit.id,
    unit.path
  ].map((field) => String(field ?? "")).filter(Boolean);
  let best = 0;
  for (const field of fields) {
    best = Math.max(best, fuzzyScore(trimmed, field));
  }
  return best;
}

function fuzzyScore(query: string, value: string): number {
  const q = normalizeSearch(query);
  const v = normalizeSearch(value);
  if (q === "" || v === "") {
    return 0;
  }
  if (v === q) {
    return 100;
  }
  if (v.includes(q)) {
    return 90 - Math.min(20, v.length - q.length);
  }
  if (q.includes(v)) {
    return 70 - Math.min(20, q.length - v.length);
  }
  const distance = levenshtein(q, v);
  const ratio = 1 - distance / Math.max(q.length, v.length);
  return ratio >= 0.55 ? Math.round(ratio * 70) : 0;
}

function fieldMatches(value: unknown, filter: string): boolean {
  const trimmed = filter.trim();
  return trimmed === "" || fuzzyScore(trimmed, String(value ?? "")) > 0;
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = current;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

function encodeAccountingCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeAccountingCursor(cursor: string): number {
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid accounting-unit cursor.");
  }
  if (!Number.isInteger(parsed?.offset) || parsed.offset < 0) {
    throw new Error("Invalid accounting-unit cursor.");
  }
  return parsed.offset;
}

function databaseNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function safeId(value: string): string {
  const id = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || value;
}

function dedupeDatabases(databases: XmlDatabase[]): XmlDatabase[] {
  const byDatabase = new Map<string, XmlDatabase>();
  for (const database of databases) {
    if (!byDatabase.has(database.database)) {
      byDatabase.set(database.database, database);
    }
  }
  return [...byDatabase.values()];
}

function jsonList(data: Record<string, any>, limit: number): string {
  const first = data.items?.[0];
  if (first?.data && typeof first.data === "object") {
    for (const [key, value] of Object.entries(first.data)) {
      if (Array.isArray(value) && value.length > limit) {
        const total = value.length;
        first.data[key] = value.slice(0, limit);
        first.truncated = `Showing first ${limit} of ${total} records. Refine filters to narrow.`;
        break;
      }
    }
  }
  return stringify(data);
}
