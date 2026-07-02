import { agendaConfig } from "./constants.js";
import { PohodaResponse } from "./response.js";
import type { TransportOptions, XmlTransport } from "./transport.js";
import { XmlBuilder, type DataPackItem, type XmlObject } from "./xml-builder.js";

export type PohodaClientOptions = {
  transport: XmlTransport;
  ico: string;
  database: string;
  application?: string;
};

export type ListRecordsBatchRequest = {
  agenda: string;
  filter?: Record<string, unknown>;
  subType?: string;
  options?: Record<string, unknown>;
  note?: string;
};

export type CreateInvoiceBatchEntry = {
  requestId?: string;
  address?: Record<string, any>;
  header: Record<string, any>;
  items: Record<string, any>[];
};

export type WriteBatchOperation =
  | { requestId?: string; tool: "create_address"; data: Record<string, any> }
  | { requestId?: string; tool: "manage_address"; action: "add" | "update" | "delete"; data: Record<string, any>; match?: Record<string, any> }
  | { requestId?: string; tool: "create_invoice"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_cash_voucher"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_other_liability"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_other_receivable"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_stock"; data: Record<string, any> }
  | { requestId?: string; tool: "manage_stock"; action: "add" | "update" | "delete"; data: Record<string, any>; match?: Record<string, any> }
  | { requestId?: string; tool: "create_order"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_bank_document"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_internal_document"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_stock_receipt"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_stock_issue"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_stock_transfer"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_production_document"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_sales_receipt"; header: Record<string, any>; items: Record<string, any>[]; payments?: Record<string, any>[] }
  | { requestId?: string; tool: "create_offer"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_enquiry"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "manage_contract"; data: Record<string, any>; planItems?: Record<string, any>[] }
  | { requestId?: string; tool: "manage_centre"; action: "add" | "update" | "delete"; data: Record<string, any>; match?: Record<string, any> }
  | { requestId?: string; tool: "manage_activity"; action: "add" | "update" | "delete"; data: Record<string, any>; match?: Record<string, any> }
  | { requestId?: string; tool: "manage_store"; data: Record<string, any> }
  | { requestId?: string; tool: "manage_storage"; data: Record<string, any> }
  | { requestId?: string; tool: "manage_bank_account"; action: "add"; data: Record<string, any>; match?: Record<string, any> }
  | { requestId?: string; tool: "manage_group_stock"; action: "add" | "update" | "delete"; data: Record<string, any>; variants?: Record<string, any>[]; match?: Record<string, any> }
  | { requestId?: string; tool: "manage_parameter_definition"; data: Record<string, any> }
  | { requestId?: string; tool: "print"; options: Record<string, any> };

type DatabaseTarget = string | TransportOptions;

export class PohodaClient {
  private readonly transport: XmlTransport;
  private readonly application: string;
  private ico: string;
  private database: string;
  private xml: XmlBuilder;

  public constructor(options: PohodaClientOptions) {
    this.transport = options.transport;
    this.ico = options.ico;
    this.database = options.database;
    this.application = options.application ?? "MCP Server";
    this.xml = new XmlBuilder(this.ico, this.application);
  }

  public setContext(database: string, ico?: string): void {
    this.database = database.trim();
    if (ico !== undefined) {
      this.ico = ico.trim();
      this.xml = new XmlBuilder(this.ico, this.application);
    }
  }

  public getDatabase(): string {
    return this.database;
  }

  public getIco(): string {
    return this.ico;
  }

  public getStatus(companyDetail = false): Record<string, unknown> {
    return {
      ...this.transport.status(this.database),
      ico: this.ico,
      companyDetailAvailable: false,
      message: companyDetail
        ? "CLI XML transport has no HTTP status endpoint. Use list_accounting_units for live company/database details."
        : "CLI XML transport is configured."
    };
  }

  public getStatusNoStart(companyDetail = false): Record<string, unknown> {
    return this.getStatus(companyDetail);
  }

  public async listRecords(agenda: string, filter: Record<string, unknown> = {}, subType = "", options: Record<string, unknown> = {}): Promise<PohodaResponse> {
    const item = this.listRecordsItem(agenda, filter, subType, options);
    return this.send(item.rootElement, item.version, item.data, `List ${agenda}`, item.rootAttrs, "", { checkDuplicity: false, ...databaseOption(options) });
  }

  public async listRecordsBatch(requests: ListRecordsBatchRequest[], dataPackId = "", options: TransportOptions = {}): Promise<PohodaResponse> {
    if (requests.length === 0) {
      throw new Error("At least one list request is required.");
    }
    const items = requests.map((request) => this.listRecordsItem(
      request.agenda,
      request.filter ?? {},
      request.subType ?? "",
      request.options ?? {},
      request.note
    ));
    return this.sendDataPackItems(items, "Batch list records", dataPackId, { checkDuplicity: false, ...options });
  }

  private listRecordsItem(agenda: string, filter: Record<string, unknown> = {}, subType = "", options: Record<string, unknown> = {}, note = ""): DataPackItem {
    const config = agendaConfig[agenda];
    if (!config) {
      throw new Error(`Unknown agenda: ${agenda}. Supported: ${Object.keys(agendaConfig).join(", ")}`);
    }
    const versionAttr = config.versionAttr ?? `${agenda}Version`;
    const requestTag = `${config.listPrefix}:${config.listRequest}`;
    const innerTag = `${config.listPrefix}:${config.requestTag}`;
    const requestData: XmlObject = {};
    const filterData = buildFilterData(filter, agenda);
    if (Object.keys(filterData).length > 0) {
      requestData["ftr:filter"] = filterData;
    }
    if (typeof filter.queryFilter === "string" && filter.queryFilter !== "") {
      requestData["ftr:queryFilter"] = { "ftr:filter": filter.queryFilter };
    }
    if (typeof filter.userFilterName === "string" && filter.userFilterName !== "") {
      requestData["ftr:userFilterName"] = filter.userFilterName;
    }
    const inner: XmlObject = {};
    const limit = buildLimitData(options);
    if (Object.keys(limit).length > 0) {
      inner[`${config.listPrefix}:limit`] = limit;
    }
    inner[innerTag] = requestData;
    const restrictions = buildRestrictionData(options.restrictions);
    if (Object.keys(restrictions).length > 0) {
      inner[`${config.listPrefix}:restrictionData`] = restrictions;
    }
    return {
      rootElement: requestTag,
      version: "2.0",
      data: inner,
      note,
      rootAttrs: {
        [versionAttr]: "2.0",
        ...(subType !== "" ? { [`${agenda}Type`]: subType } : {})
      }
    };
  }

  public async createInvoice(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("inv:invoice", "2.0", buildInvoiceData(header, items), "Create invoice", {}, dataPackId, databaseOption(target));
  }

  public async createOtherLiability(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.createInvoice({ ...header, type: "commitment" }, items, dataPackId, target);
  }

  public async createOtherReceivable(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.createInvoice({ ...header, type: "receivable" }, items, dataPackId, target);
  }

  public async createAddress(data: Record<string, any>, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("adb:addressbook", "2.0", buildAddressData(data), "Create address", {}, dataPackId, databaseOption(target));
  }

  public async manageAddress(action: "add" | "update" | "delete", data: Record<string, any>, match: Record<string, any> = {}, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("adb:addressbook", "2.0", buildManageAddressData(action, data, match), "Manage address", {}, dataPackId, databaseOption(target));
  }

  public async createInvoiceBatch(entries: CreateInvoiceBatchEntry[], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    if (entries.length === 0) {
      throw new Error("At least one invoice batch entry is required.");
    }
    const items: DataPackItem[] = [];
    entries.forEach((entry, index) => {
      const requestId = entry.requestId && entry.requestId !== "" ? entry.requestId : `invoice-${index + 1}`;
      if (entry.address) {
        items.push({
          rootElement: "adb:addressbook",
          version: "2.0",
          data: buildAddressData(entry.address),
          note: `${requestId}:address`
        });
      }
      items.push({
        rootElement: "inv:invoice",
        version: "2.0",
        data: buildInvoiceData(entry.header, entry.items),
        note: `${requestId}:invoice`
      });
    });
    return this.sendDataPackItems(items, "Batch create invoices", dataPackId, databaseOption(target));
  }

  public async createStock(data: Record<string, any>, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("stk:stock", "2.0", buildStockData(data), "Create stock", {}, dataPackId, databaseOption(target));
  }

  public async manageStock(action: "add" | "update" | "delete", data: Record<string, any>, match: Record<string, any> = {}, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("stk:stock", "2.0", buildManageStockData(action, data, match), "Manage stock", {}, dataPackId, databaseOption(target));
  }

  public async createOrder(header: Record<string, any>, items: Record<string, any>[], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("ord:order", "2.0", buildOrderData(header, items), "Create order", {}, dataPackId, databaseOption(target));
  }

  public async createCashVoucher(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("vch:voucher", "2.0", buildVoucherData(header, items), "Create cash voucher", {}, dataPackId, databaseOption(target));
  }

  public async createBankDocument(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("bnk:bank", "2.0", buildGenericDocumentData(bankDocumentConfig, header, items), "Create bank document", {}, dataPackId, databaseOption(target));
  }

  public async createInternalDocument(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("int:intDoc", "2.0", buildGenericDocumentData(internalDocumentConfig, header, items), "Create internal document", {}, dataPackId, databaseOption(target));
  }

  public async createStockReceipt(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("pri:prijemka", "2.0", buildGenericDocumentData(stockReceiptConfig, header, items), "Create stock receipt", {}, dataPackId, databaseOption(target));
  }

  public async createStockIssue(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("vyd:vydejka", "2.0", buildGenericDocumentData(stockIssueConfig, header, items), "Create stock issue", {}, dataPackId, databaseOption(target));
  }

  public async createStockTransfer(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("pre:prevodka", "2.0", buildGenericDocumentData(stockTransferConfig, header, items), "Create stock transfer", {}, dataPackId, databaseOption(target));
  }

  public async createProductionDocument(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("vyr:vyroba", "2.0", buildGenericDocumentData(productionConfig, header, items), "Create production document", {}, dataPackId, databaseOption(target));
  }

  public async createSalesReceipt(header: Record<string, any>, items: Record<string, any>[] = [], payments: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("pro:prodejka", "2.0", buildSalesReceiptData(header, items, payments), "Create sales receipt", {}, dataPackId, databaseOption(target));
  }

  public async createOffer(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("ofr:offer", "2.0", buildGenericDocumentData(offerConfig, header, items), "Create offer", {}, dataPackId, databaseOption(target));
  }

  public async createEnquiry(header: Record<string, any>, items: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("enq:enquiry", "2.0", buildGenericDocumentData(enquiryConfig, header, items), "Create enquiry", {}, dataPackId, databaseOption(target));
  }

  public async manageContract(data: Record<string, any>, planItems: Record<string, any>[] = [], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("con:contract", "2.0", buildContractData(data, planItems), "Manage contract", {}, dataPackId, databaseOption(target));
  }

  public async manageCentre(action: "add" | "update" | "delete", data: Record<string, any>, match: Record<string, any> = {}, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("cen:centre", "2.0", buildSimpleCodebookData("cen", "centre", action, data, match, ["code", "name", "establishment", "note", "markRecord"]), "Manage centre", {}, dataPackId, databaseOption(target));
  }

  public async manageActivity(action: "add" | "update" | "delete", data: Record<string, any>, match: Record<string, any> = {}, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("acv:activity", "2.0", buildActivityData(action, data, match), "Manage activity", {}, dataPackId, databaseOption(target));
  }

  public async manageStore(data: Record<string, any>, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("sto:store", "2.0", buildStoreData(data), "Manage store", {}, dataPackId, databaseOption(target));
  }

  public async manageStorage(data: Record<string, any>, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("str:storage", "2.0", buildStorageData(data), "Manage storage", {}, dataPackId, databaseOption(target));
  }

  public async manageBankAccount(action: "add", data: Record<string, any>, match: Record<string, any> = {}, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("bka:bankAccount", "2.0", buildBankAccountData(action, data, match), "Manage bank account", {}, dataPackId, databaseOption(target));
  }

  public async manageGroupStock(action: "add" | "update" | "delete", data: Record<string, any>, variants: Record<string, any>[] = [], match: Record<string, any> = {}, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("grs:groupStocks", "2.0", buildGroupStockData(action, data, variants, match), "Manage group stock", {}, dataPackId, databaseOption(target));
  }

  public async manageParameterDefinition(data: Record<string, any>, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("prm:parameter", "2.0", buildParameterDefinitionData(data), "Manage parameter definition", filterEmpty({ idsAgenda: data.idsAgenda }) as Record<string, string>, dataPackId, databaseOption(target));
  }

  public async listBalance(options: Record<string, any> = {}, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("lst:listBalanceRequest", "1.0", buildBalanceRequestData(options), "List balance", { balanceVersion: "2.0" }, dataPackId, { checkDuplicity: false, ...databaseOption(target) });
  }

  public printRecord(options: Record<string, any>): Promise<PohodaResponse> {
    return this.send("prn:print", "1.0", buildPrintData(options), `Print ${options.agenda}`, {}, "", { checkDuplicity: false, ...databaseOption(options) });
  }

  public async writeBatch(operations: WriteBatchOperation[], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    if (operations.length === 0) {
      throw new Error("At least one write batch operation is required.");
    }
    const items = operations.map((operation, index) => writeBatchItem(operation, index));
    return this.sendDataPackItems(items, "Batch write", dataPackId, databaseOption(target));
  }

  public async sendRawXml(innerXml: string, note = "", dataPackId = "", transportOptions: TransportOptions = {}): Promise<PohodaResponse> {
    return this.exchange(this.builderFor(transportOptions).buildRawMany([innerXml], note, dataPackId), transportOptions);
  }

  public async sendRawXmlBatch(innerXmlItems: string[], note = "", dataPackId = "", transportOptions: TransportOptions = {}): Promise<PohodaResponse> {
    return this.exchange(this.builderFor(transportOptions).buildRawMany(innerXmlItems, note, dataPackId), transportOptions);
  }

  public async sendDataPackItems(items: DataPackItem[], note = "", dataPackId = "", transportOptions: TransportOptions = {}): Promise<PohodaResponse> {
    return this.exchange(this.builderFor(transportOptions).buildMany(items, note, dataPackId), transportOptions);
  }

  public async listAccountingUnits(): Promise<PohodaResponse> {
    return this.exchange(this.xml.build("acu:listAccountingUnitRequest", "1.6", {}, "List accounting units"), {
      allowNoDatabase: true,
      omitDatabase: true,
      checkDuplicity: false
    });
  }

  private async send(rootElement: string, version: string, data: XmlObject, note: string, rootAttrs: Record<string, string> = {}, dataPackId = "", options: TransportOptions = {}): Promise<PohodaResponse> {
    return this.exchange(this.builderFor(options).build(rootElement, version, data, note, rootAttrs, dataPackId), options);
  }

  private async exchange(xml: string, options: TransportOptions = {}): Promise<PohodaResponse> {
    const database = options.omitDatabase ? "" : String(options.databaseOverride ?? this.database);
    const result = await this.transport.exchange(xml, database, options);
    return new PohodaResponse(result.xml, result);
  }

  private builderFor(options: TransportOptions = {}): XmlBuilder {
    const ico = String(options.dataPackIco ?? this.ico).trim();
    return ico === this.ico ? this.xml : new XmlBuilder(ico, this.application);
  }
}

function buildPrintData(options: Record<string, any>): XmlObject {
    const pdfPath = String(options.pdfPath ?? "");
    if (Number(options.reportId ?? 0) <= 0) {
      throw new Error("reportId is required for print.");
    }
    if ((options.printer ?? "") !== "" && pdfPath !== "") {
      throw new Error("printer and pdfPath are mutually exclusive in this MCP tool. Use exactly one output mode.");
    }
    if (pdfPath === "" && (options.pdfBase64 || options.includeIsdoc || (options.isdocGraphicNote ?? "") !== "" || hasEmailOptions(options) || options.removeFile)) {
      throw new Error("pdfPath is required when using pdfBase64, email, ISDOC, or removeFile print options.");
    }
    const printerSettings: XmlObject = {
      "prn:report": { "prn:id": Number(options.reportId) }
    };
    if ((options.printer ?? "") !== "") {
      printerSettings["prn:printer"] = options.printer;
    }
    if (pdfPath !== "") {
      const pdf: XmlObject = { "prn:fileName": pdfPath };
      const mail = buildSendMailData(options);
      if (Object.keys(mail).length > 0) {
        pdf["prn:sendMail"] = mail;
      }
      if (options.pdfBase64) {
        pdf["prn:binaryData"] = filterEmpty({
          "prn:responseXml": "true",
          "prn:removeFile": options.removeFile ? true : undefined
        });
      }
      if (options.includeIsdoc || (options.isdocGraphicNote ?? "") !== "") {
        pdf["prn:isdoc"] = {
          "prn:includeToPdf": Boolean(options.includeIsdoc ?? true),
          "prn:graphicNote": (options.isdocGraphicNote ?? "") !== "" ? options.isdocGraphicNote : "topRight"
        };
      }
      printerSettings["prn:pdf"] = pdf;
    }
    const parameters = filterEmpty({
      "prn:copy": Number(options.copies ?? 1) > 1 ? Math.min(Number(options.copies), 20) : undefined,
      "prn:datePrint": options.datePrint,
      ...buildPrintParameters(options.parameters)
    });
    if (Object.keys(parameters).length > 0) {
      printerSettings["prn:parameters"] = parameters;
    }
    return {
      "prn:record": filterEmpty({
        "@agenda": options.agenda,
        "@usrAgenda": (options.usrAgenda ?? "") !== "" ? options.usrAgenda : undefined,
        ...buildPrintRecordSelector(options)
      }),
      "prn:printerSettings": printerSettings
    };
}

function databaseOption(options: DatabaseTarget | Record<string, unknown>): TransportOptions {
  const raw = typeof options === "string" ? { database: options } : options;
  const database = String(raw.database ?? raw.databaseId ?? raw.databaseOverride ?? "").trim();
  const dataPackIco = String(raw.dataPackIco ?? raw.ico ?? "").trim();
  const result: TransportOptions = {};
  if (database !== "") {
    result.databaseOverride = database;
  }
  if (dataPackIco !== "") {
    result.dataPackIco = dataPackIco;
  }
  return result;
}

type DocumentConfig = {
  prefix: string;
  headerName: string;
  detailName?: string;
  itemName?: string;
  summaryName?: string;
  typeField?: string;
  typeDefault?: string;
  currencyByHeader?: boolean;
  itemCurrencyByHeader?: boolean;
  includeStockDefaults?: boolean;
};

const bankDocumentConfig: DocumentConfig = {
  prefix: "bnk",
  headerName: "bankHeader",
  detailName: "bankDetail",
  itemName: "bankItem",
  summaryName: "bankSummary",
  typeField: "bankType",
  typeDefault: "receipt",
  currencyByHeader: true,
  itemCurrencyByHeader: true
};

const internalDocumentConfig: DocumentConfig = {
  prefix: "int",
  headerName: "intDocHeader",
  detailName: "intDocDetail",
  itemName: "intDocItem",
  summaryName: "intDocSummary",
  currencyByHeader: true,
  itemCurrencyByHeader: true
};

const stockReceiptConfig: DocumentConfig = {
  prefix: "pri",
  headerName: "prijemkaHeader",
  detailName: "prijemkaDetail",
  itemName: "prijemkaItem",
  summaryName: "prijemkaSummary",
  currencyByHeader: true,
  itemCurrencyByHeader: true,
  includeStockDefaults: true
};

const stockIssueConfig: DocumentConfig = {
  prefix: "vyd",
  headerName: "vydejkaHeader",
  detailName: "vydejkaDetail",
  itemName: "vydejkaItem",
  summaryName: "vydejkaSummary",
  currencyByHeader: true,
  itemCurrencyByHeader: true,
  includeStockDefaults: true
};

const stockTransferConfig: DocumentConfig = {
  prefix: "pre",
  headerName: "prevodkaHeader",
  detailName: "prevodkaDetail",
  itemName: "prevodkaItem",
  includeStockDefaults: true
};

const productionConfig: DocumentConfig = {
  prefix: "vyr",
  headerName: "vyrobaHeader",
  detailName: "vyrobaDetail",
  itemName: "vyrobaItem",
  includeStockDefaults: true
};

const offerConfig: DocumentConfig = {
  prefix: "ofr",
  headerName: "offerHeader",
  detailName: "offerDetail",
  itemName: "offerItem",
  summaryName: "offerSummary",
  typeField: "offerType",
  typeDefault: "issuedOffer",
  currencyByHeader: true,
  itemCurrencyByHeader: true,
  includeStockDefaults: true
};

const enquiryConfig: DocumentConfig = {
  prefix: "enq",
  headerName: "enquiryHeader",
  detailName: "enquiryDetail",
  itemName: "enquiryItem",
  summaryName: "enquirySummary",
  typeField: "enquiryType",
  typeDefault: "issuedEnquiry",
  currencyByHeader: true,
  itemCurrencyByHeader: true,
  includeStockDefaults: true
};

function buildGenericDocumentData(config: DocumentConfig, header: Record<string, any>, items: Record<string, any>[]): XmlObject {
  const prefix = config.prefix;
  const data: XmlObject = {
    [`${prefix}:${config.headerName}`]: buildDocumentHeader(config, header)
  };
  if (config.detailName && config.itemName && items.length > 0) {
    data[`${prefix}:${config.detailName}`] = items.map((item) => ({
      [`${prefix}:${config.itemName}`]: buildGenericItem(config, item, String(header.currency ?? "").trim())
    }));
  }
  if (config.summaryName) {
    const summary = buildDocumentSummary(prefix, header);
    if (Object.keys(summary).length > 0) {
      data[`${prefix}:${config.summaryName}`] = summary;
    }
  }
  Object.assign(data, namespaceObject(prefix, header.extraData));
  return data;
}

function buildDocumentHeader(config: DocumentConfig, header: Record<string, any>): XmlObject {
  const prefix = config.prefix;
  if (prefix === "pre" || prefix === "vyr") {
    return buildStockMovementHeader(prefix, header);
  }
  if (prefix === "ofr" || prefix === "enq") {
    return buildOfferEnquiryHeader(config, header);
  }
  return buildGenericHeader(config, header);
}

function buildGenericHeader(config: DocumentConfig, header: Record<string, any>): XmlObject {
  const prefix = config.prefix;
  const documentType = normalizeDocumentType(prefix, header.type ?? (config.typeField ? header[config.typeField] : undefined) ?? config.typeDefault);
  return filterEmpty({
    [`${prefix}:id`]: Number(header.id ?? 0) > 0 ? Number(header.id) : undefined,
    [`${prefix}:extId`]: buildExtId(header),
    ...(config.typeField ? { [`${prefix}:${config.typeField}`]: documentType } : {}),
    [`${prefix}:storno`]: header.storno,
    [`${prefix}:account`]: ref(header.account ?? header.bankAccount ?? header.accountIds ?? ""),
    [`${prefix}:cashAccount`]: ref(header.cashAccount ?? ""),
    [`${prefix}:number`]: buildDocumentNumber(prefix, header.number),
    [`${prefix}:statementNumber`]: buildBankStatementNumber(header),
    [`${prefix}:symVar`]: header.symVar,
    [`${prefix}:symPar`]: header.symPar,
    [`${prefix}:symConst`]: header.symConst,
    [`${prefix}:symSpec`]: header.symSpec,
    [`${prefix}:originalDocument`]: header.originalDocument,
    [`${prefix}:originalDocumentNumber`]: header.originalDocumentNumber,
    [`${prefix}:date`]: prefix === "bnk" ? undefined : header.date,
    [`${prefix}:dateStatement`]: header.dateStatement,
    [`${prefix}:datePayment`]: header.datePayment,
    [`${prefix}:dateTax`]: header.dateTax,
    [`${prefix}:dateAccounting`]: header.dateAccounting,
    [`${prefix}:dateDelivery`]: header.dateDelivery,
    [`${prefix}:dateOrder`]: header.dateOrder,
    [`${prefix}:dateOfReceipt`]: header.dateOfReceipt,
    [`${prefix}:dateKHDPH`]: header.dateKHDPH,
    [`${prefix}:dateKVDPH`]: header.dateKVDPH,
    [`${prefix}:numberOrder`]: header.numberOrder,
    [`${prefix}:accounting`]: ref(header.accounting ?? ""),
    [`${prefix}:classificationVAT`]: header.classificationVAT ? { "typ:classificationVATType": header.classificationVAT } : undefined,
    [`${prefix}:classificationKVDPH`]: ref(header.classificationKVDPH ?? ""),
    [`${prefix}:transactionTaxType`]: header.transactionTaxType,
    [`${prefix}:text`]: header.text,
    [`${prefix}:partnerIdentity`]: buildPartnerIdentity(header),
    [`${prefix}:paymentType`]: buildPaymentType(header.paymentType ?? ""),
    [`${prefix}:paymentAccount`]: buildPaymentAccount(header),
    [`${prefix}:priceLevel`]: ref(header.priceLevel ?? ""),
    [`${prefix}:store`]: ["pri", "vyd", "pro"].includes(prefix) ? undefined : ref(header.store ?? ""),
    [`${prefix}:isExecuted`]: header.isExecuted,
    [`${prefix}:isDelivered`]: header.isDelivered,
    [`${prefix}:kasa`]: ref(header.kasa ?? header.cashDesk ?? ""),
    [`${prefix}:centre`]: ref(header.centre ?? ""),
    [`${prefix}:activity`]: ref(header.activity ?? ""),
    [`${prefix}:contract`]: ref(header.contract ?? ""),
    [`${prefix}:carrier`]: header.carrier,
    [`${prefix}:details`]: header.details,
    [`${prefix}:note`]: header.note,
    [`${prefix}:intNote`]: header.intNote,
    [`${prefix}:histRate`]: header.histRate,
    [`${prefix}:lock1`]: header.lock1,
    [`${prefix}:lock2`]: header.lock2,
    [`${prefix}:markRecord`]: header.markRecord,
    [`${prefix}:labels`]: buildLabels(prefix, header.labels),
    [`${prefix}:parameters`]: buildParameters(prefix, header.parameters),
    ...namespaceObject(prefix, header.extraHeader)
  });
}

function buildOfferEnquiryHeader(config: DocumentConfig, header: Record<string, any>): XmlObject {
  const prefix = config.prefix;
  const isOffer = prefix === "ofr";
  const documentType = normalizeDocumentType(prefix, header.type ?? (config.typeField ? header[config.typeField] : undefined) ?? config.typeDefault);
  return filterEmpty({
    [`${prefix}:id`]: Number(header.id ?? 0) > 0 ? Number(header.id) : undefined,
    [`${prefix}:extId`]: isOffer ? buildExtId(header) : undefined,
    ...(config.typeField ? { [`${prefix}:${config.typeField}`]: documentType } : {}),
    [`${prefix}:number`]: buildDocumentNumber(prefix, header.number),
    [`${prefix}:date`]: header.date,
    [`${prefix}:validTill`]: header.validTill,
    [`${prefix}:text`]: header.text,
    [`${prefix}:partnerIdentity`]: buildPartnerIdentity(header),
    [`${prefix}:paymentType`]: isOffer ? buildPaymentType(header.paymentType ?? "") : undefined,
    [`${prefix}:priceLevel`]: ref(header.priceLevel ?? ""),
    [`${prefix}:centre`]: ref(header.centre ?? ""),
    [`${prefix}:activity`]: ref(header.activity ?? ""),
    [`${prefix}:contract`]: ref(header.contract ?? ""),
    [`${prefix}:regVATinEU`]: ref(header.regVATinEU ?? ""),
    [`${prefix}:MOSS`]: optionalNamespaceObject("typ", header.MOSS),
    [`${prefix}:evidentiaryResourcesMOSS`]: optionalNamespaceObject("typ", header.evidentiaryResourcesMOSS),
    [`${prefix}:accountingPeriodMOSS`]: isOffer ? header.accountingPeriodMOSS : undefined,
    [`${prefix}:permanentDocument`]: isOffer ? header.permanentDocument : undefined,
    [`${prefix}:isExecuted`]: header.isExecuted,
    [`${prefix}:isDelivered`]: isOffer ? header.isDelivered : undefined,
    [`${prefix}:details`]: header.details,
    [`${prefix}:note`]: header.note,
    [`${prefix}:intNote`]: header.intNote,
    [`${prefix}:histRate`]: header.histRate,
    [`${prefix}:lock1`]: header.lock1,
    [`${prefix}:lock2`]: header.lock2,
    [`${prefix}:markRecord`]: header.markRecord,
    [`${prefix}:labels`]: buildLabels(prefix, header.labels),
    [`${prefix}:parameters`]: buildParameters(prefix, header.parameters),
    ...namespaceObject(prefix, header.extraHeader)
  });
}

function normalizeDocumentType(prefix: string, value: unknown): unknown {
  if (prefix === "pro" && value === "prodejka") {
    return "saleVoucher";
  }
  return value;
}

function buildStockMovementHeader(prefix: string, header: Record<string, any>): XmlObject {
  return filterEmpty({
    [`${prefix}:id`]: Number(header.id ?? 0) > 0 ? Number(header.id) : undefined,
    [`${prefix}:number`]: buildDocumentNumber(prefix, header.number),
    [`${prefix}:date`]: header.date,
    [`${prefix}:time`]: header.time,
    [`${prefix}:dateOfReceipt`]: header.dateOfReceipt,
    [`${prefix}:timeOfReceipt`]: header.timeOfReceipt,
    [`${prefix}:symPar`]: header.symPar,
    [`${prefix}:store`]: ref(header.store ?? ""),
    [`${prefix}:acc`]: header.acc,
    [`${prefix}:text`]: header.text,
    [`${prefix}:partnerIdentity`]: buildPartnerIdentity(header),
    [`${prefix}:centreSource`]: ref(header.centreSource ?? header.sourceCentre ?? ""),
    [`${prefix}:centreDestination`]: ref(header.centreDestination ?? header.destinationCentre ?? ""),
    [`${prefix}:activity`]: ref(header.activity ?? ""),
    [`${prefix}:contract`]: ref(header.contract ?? ""),
    [`${prefix}:note`]: header.note,
    [`${prefix}:intNote`]: header.intNote,
    [`${prefix}:lock1`]: header.lock1,
    [`${prefix}:lock2`]: header.lock2,
    [`${prefix}:notPost`]: prefix === "pre" ? header.notPost : undefined,
    [`${prefix}:markRecord`]: header.markRecord,
    [`${prefix}:labels`]: prefix === "vyr" ? buildLabels(prefix, header.labels) : undefined,
    [`${prefix}:validate`]: optionalNamespaceObject("typ", header.validate),
    [`${prefix}:parameters`]: buildParameters(prefix, header.parameters),
    ...namespaceObject(prefix, header.extraHeader)
  });
}

function buildGenericItem(config: DocumentConfig, item: Record<string, any>, headerCurrency = ""): XmlObject {
  const prefix = config.prefix;
  if (prefix === "pre" || prefix === "vyr") {
    return buildStockMovementItem(prefix, item);
  }
  const currency = String(item.currency ?? headerCurrency).trim();
  const useForeign = config.itemCurrencyByHeader && currency !== "";
  return filterEmpty({
    [`${prefix}:id`]: Number(item.id ?? 0) > 0 ? Number(item.id) : undefined,
    [`${prefix}:extId`]: item.extId,
    [`${prefix}:parentCompStock`]: item.parentCompStock,
    [`${prefix}:text`]: item.text ?? "",
    [`${prefix}:quantity`]: Number(item.quantity ?? 1),
    [`${prefix}:transferred`]: item.transferred,
    [`${prefix}:unit`]: item.unit,
    [`${prefix}:coefficient`]: item.coefficient,
    [`${prefix}:payVAT`]: item.payVAT,
    [`${prefix}:rateVAT`]: item.vatRate ?? item.rateVAT ?? "high",
    [`${prefix}:percentVAT`]: item.percentVAT,
    [`${prefix}:discountPercentage`]: item.discountPercentage,
    [`${prefix}:${useForeign ? "foreignCurrency" : "homeCurrency"}`]: buildCurrencyItem(item, prefix === "bnk" ? "bnk" : "typ"),
    [`${prefix}:typeServiceMOSS`]: item.typeServiceMOSS,
    [`${prefix}:note`]: item.note,
    [`${prefix}:code`]: item.code,
    [`${prefix}:symPar`]: item.symPar,
    [`${prefix}:guarantee`]: item.guarantee,
    [`${prefix}:guaranteeType`]: item.guaranteeType,
    [`${prefix}:stockItem`]: buildStockItemRef(item),
    [`${prefix}:linkToStock`]: ref(item.linkToStock ?? ""),
    [`${prefix}:sourceStore`]: ref(item.sourceStore ?? item.storeSource ?? ""),
    [`${prefix}:destinationStore`]: ref(item.destinationStore ?? item.storeDestination ?? ""),
    [`${prefix}:acc`]: item.acc,
    [`${prefix}:accounting`]: ref(item.accounting ?? ""),
    [`${prefix}:classificationVAT`]: item.classificationVAT ? { "typ:classificationVATType": item.classificationVAT } : undefined,
    [`${prefix}:classificationKVDPH`]: ref(item.classificationKVDPH ?? ""),
    [`${prefix}:PDP`]: item.PDP,
    [`${prefix}:CodePDP`]: item.CodePDP,
    [`${prefix}:centre`]: ref(item.centre ?? ""),
    [`${prefix}:activity`]: ref(item.activity ?? ""),
    [`${prefix}:contract`]: ref(item.contract ?? ""),
    [`${prefix}:parameters`]: buildParameters(prefix, item.parameters),
    ...namespaceObject(prefix, item.extraItem)
  });
}

function buildStockMovementItem(prefix: string, item: Record<string, any>): XmlObject {
  return filterEmpty({
    [`${prefix}:link`]: optionalNamespaceObject("typ", item.link),
    [`${prefix}:linkedDocument`]: prefix === "vyr" ? optionalNamespaceObject("typ", item.linkedDocument) : undefined,
    [`${prefix}:quantity`]: Number(item.quantity ?? 1),
    [`${prefix}:stockItem`]: buildStockItemRef(item),
    [`${prefix}:expirationDate`]: prefix === "vyr" ? item.expirationDate : undefined,
    [`${prefix}:note`]: item.note,
    [`${prefix}:parameters`]: buildParameters(prefix, item.parameters),
    [`${prefix}:productionList`]: prefix === "vyr" ? optionalNamespaceObject("vyr", item.productionList) : undefined,
    ...namespaceObject(prefix, item.extraItem)
  });
}

function buildSalesReceiptData(header: Record<string, any>, items: Record<string, any>[], payments: Record<string, any>[]): XmlObject {
  const data = buildGenericDocumentData({
    prefix: "pro",
    headerName: "prodejkaHeader",
    detailName: "prodejkaDetail",
    itemName: "prodejkaItem",
    summaryName: "prodejkaSummary",
    typeField: "prodejkaType",
    typeDefault: "saleVoucher",
    currencyByHeader: true,
    itemCurrencyByHeader: true,
    includeStockDefaults: true
  }, header, items);
  if (payments.length > 0) {
    data["pro:prodejkaPayments"] = payments.map((payment) => ({
      "pro:paymentItem": filterEmpty({
        "pro:paymentType": buildPaymentType(payment.paymentType ?? payment.type ?? ""),
        "pro:text": payment.text,
        "pro:received": payment.received ?? payment.price,
        "pro:paymentAdvanced": buildSalesPaymentAdvanced(payment),
        "pro:note": payment.note,
        ...namespaceObject("pro", payment.extraPayment)
      })
    }));
  }
  return data;
}

function buildSalesPaymentAdvanced(payment: Record<string, any>): XmlObject | undefined {
  if (payment.currency || payment.rate || payment.amount) {
    return filterEmpty({
      "pro:rate": Number(payment.rate ?? payment.currencyRate ?? 0) || 1,
      "pro:amount": Number(payment.amount ?? payment.currencyAmount ?? 0) || 1
    });
  }
  if (payment.paymentTerminal !== undefined || payment.symVar || payment.account) {
    return filterEmpty({
      "pro:paymentTerminal": payment.paymentTerminal,
      "pro:symVar": payment.symVar,
      "pro:account": payment.account
    });
  }
  return undefined;
}

function buildDocumentNumber(prefix: string, value: unknown): XmlObject | string | undefined {
  const number = String(value ?? "").trim();
  if (number === "") {
    return undefined;
  }
  return prefix === "bnk" ? number : { "typ:numberRequested": number };
}

function buildBankStatementNumber(header: Record<string, any>): XmlObject | undefined {
  const statementNumber = String(header.statementNumber ?? "").trim();
  const numberMovement = String(header.numberMovement ?? "").trim();
  if (statementNumber === "" && numberMovement === "") {
    return undefined;
  }
  return filterEmpty({
    "bnk:statementNumber": statementNumber,
    "bnk:numberMovement": numberMovement
  });
}

function buildManageAddressData(action: "add" | "update" | "delete", data: Record<string, any>, match: Record<string, any>): XmlObject {
  const result: XmlObject = {};
  if (action !== "add") {
    result["adb:actionType"] = { [`adb:${action}`]: buildActionFilter(match, data, "addressbook") };
  }
  if (action !== "delete") {
    Object.assign(result, buildAddressData(data));
  }
  return result;
}

function buildManageStockData(action: "add" | "update" | "delete", data: Record<string, any>, match: Record<string, any>): XmlObject {
  const result: XmlObject = {};
  if (action !== "add") {
    result["stk:actionType"] = { [`stk:${action}`]: buildActionFilter(match, data, "stock") };
  }
  if (action !== "delete") {
    Object.assign(result, buildStockData(data));
  }
  return result;
}

function buildContractData(data: Record<string, any>, planItems: Record<string, any>[]): XmlObject {
  const result: XmlObject = {
    "con:contractDesc": filterEmpty({
      "con:id": Number(data.id ?? 0) > 0 ? Number(data.id) : undefined,
      "con:number": data.number ? { "typ:numberRequested": data.number } : undefined,
      "con:datePlanStart": data.datePlanStart,
      "con:datePlanDelivery": data.datePlanDelivery,
      "con:dateStart": data.dateStart,
      "con:dateDelivery": data.dateDelivery,
      "con:dateWarranty": data.dateWarranty,
      "con:text": data.text,
      "con:partnerIdentity": buildPartnerIdentity(data),
      "con:responsiblePerson": ref(data.responsiblePerson ?? ""),
      "con:status": data.status,
      "con:ost1": data.ost1,
      "con:ost2": data.ost2,
      "con:note": data.note,
      "con:markRecord": data.markRecord,
      "con:labels": buildLabels("con", data.labels),
      "con:parameters": buildParameters("con", data.parameters),
      ...namespaceObject("con", data.extraDesc)
    })
  };
  if (planItems.length > 0) {
    result["con:contractPlan"] = planItems.map((item) => ({
      "con:contractPlanItem": filterEmpty({
        "con:id": Number(item.id ?? 0) > 0 ? Number(item.id) : undefined,
        "con:date": item.date,
        "con:typeOfOperation": item.typeOfOperation,
        "con:title": item.title,
        "con:source": item.source,
        "con:quantity": item.quantity,
        "con:unit": item.unit,
        "con:price": item.price,
        "con:note": item.note,
        "con:parameters": buildParameters("con", item.parameters),
        ...namespaceObject("con", item.extraPlanItem)
      })
    }));
  }
  Object.assign(result, namespaceObject("con", data.extraData));
  return result;
}

function buildSimpleCodebookData(prefix: string, name: string, action: "add" | "update" | "delete", data: Record<string, any>, match: Record<string, any>, fields: string[]): XmlObject {
  const result: XmlObject = {};
  if (action !== "add") {
    result[`${prefix}:actionType`] = { [`${prefix}:${action}`]: buildActionFilter(match, data, name) };
  }
  if (action !== "delete") {
    const header: XmlObject = {
      [`${prefix}:id`]: Number(data.id ?? 0) > 0 ? Number(data.id) : undefined,
      [`${prefix}:extId`]: buildExtId(data)
    };
    for (const field of fields) {
      const value = data[field];
      header[`${prefix}:${field}`] = field === "establishment" ? ref(value ?? "") : value;
    }
    Object.assign(header, namespaceObject(prefix, data.extraHeader));
    result[`${prefix}:${name}Header`] = filterEmpty(header);
  }
  return result;
}

function buildStoreData(data: Record<string, any>): XmlObject {
  return filterEmpty({
    "sto:id": Number(data.id ?? 0) > 0 ? Number(data.id) : undefined,
    "sto:name": data.name,
    "sto:text": data.text,
    "sto:allowNegInvBalance": data.allowNegInvBalance,
    "sto:storekeeper": ref(data.storekeeper ?? ""),
    "sto:PLU": buildPluSettings(data),
    "sto:note": data.note,
    "sto:markRecord": data.markRecord,
    "sto:sourceStore": data.sourceStore,
    "sto:destinationStore": data.destinationStore,
    "sto:createInventoryCard": data.createInventoryCard,
    "sto:unitPZD": ref(data.unitPZD ?? ""),
    "sto:parameters": buildParameters("sto", data.parameters),
    ...namespaceObject("sto", data.extraData)
  });
}

function buildStorageData(data: Record<string, any>): XmlObject {
  const storages = Array.isArray(data.storages) && data.storages.length > 0 ? data.storages : [data];
  return storages.map((item) => ({ "str:itemStorage": buildStorageItem(item) })) as unknown as XmlObject;
}

function buildStorageItem(item: Record<string, any>): XmlObject {
  requireFields(item, ["code"], "manage_storage itemStorage");
  const children = Array.isArray(item.subStorages) ? item.subStorages.map((child) => ({ "str:itemStorage": buildStorageItem(child) })) : [];
  return filterEmpty({
    "@id": Number(item.id ?? 0) > 0 ? Number(item.id) : undefined,
    "@code": item.code,
    "@idStore": Number(item.idStore ?? 0) > 0 ? Number(item.idStore) : undefined,
    "@name": item.name,
    "@note": item.note,
    "@offerTo": item.offerTo,
    "str:subStorages": children.length > 0 ? children : undefined,
    ...namespaceObject("str", item.extraItem)
  });
}

function buildBankAccountData(action: "add", data: Record<string, any>, match: Record<string, any>): XmlObject {
  const result: XmlObject = {};
  const addFilter = buildOptionalActionFilter(match, data, "bankAccount");
  if (addFilter) {
    result["bka:actionType"] = { "bka:add": addFilter };
  }
  requireFields(data, ["ids", "numberAccount", "codeBank"], "manage_bank_account add");
  result["bka:bankAccountHeader"] = filterEmpty({
    "bka:id": Number(data.id ?? 0) > 0 ? Number(data.id) : undefined,
    "bka:extId": buildExtId(data),
    "bka:ids": data.ids,
    "bka:numberAccount": data.numberAccount,
    "bka:codeBank": data.codeBank,
    "bka:nameBank": data.nameBank,
    "bka:symSpec": data.symSpec,
    "bka:IBAN": data.IBAN,
    "bka:SWIFT": data.SWIFT,
    "bka:analyticAccount": ref(data.analyticAccount ?? ""),
    "bka:currencyBankAccount": data.currency ? { "bka:currency": ref(data.currency), "bka:rate": Number(data.currencyRate ?? 0) || 1 } : undefined,
    "bka:cancelled": data.cancelled,
    "bka:homebanking": data.homebanking,
    "bka:payTerminal": data.payTerminal,
    "bka:note": data.note,
    ...namespaceObject("bka", data.extraHeader)
  });
  return result;
}

function buildGroupStockData(action: "add" | "update" | "delete", data: Record<string, any>, variants: Record<string, any>[], match: Record<string, any>): XmlObject {
  const result: XmlObject = {
    "grs:actionType": { [`grs:${action}`]: buildActionFilter(match, data, "groupStocks") }
  };
  if (action !== "delete") {
    requireFields(data, ["code", "name"], `manage_group_stock ${action}`);
    result["grs:groupStocksHeader"] = filterEmpty({
      "grs:id": Number(data.id ?? 0) > 0 ? Number(data.id) : undefined,
      "grs:code": data.code,
      "grs:name": data.name,
      "grs:description": data.description,
      "grs:internet": data.internet,
      "grs:picture": data.picture,
      "grs:note": data.note,
      "grs:markRecord": data.markRecord,
      ...namespaceObject("grs", data.extraHeader)
    });
    if (variants.length > 0) {
      result["grs:groupStocksDetail"] = variants.map((variant) => ({
        "grs:variant": filterEmpty({
          "grs:actionType": variant.actionType,
          "grs:stockItem": buildStockItemRef(variant),
          "grs:order": variant.order,
          "grs:name": variant.name,
          "grs:quantity": variant.quantity,
          ...namespaceObject("grs", variant.extraVariant)
        })
      }));
    }
  }
  return result;
}

function buildParameterDefinitionData(data: Record<string, any>): XmlObject {
  return filterEmpty({
    "prm:userAgendaDef": optionalNamespaceObject("prm", data.userAgendaDef),
    "prm:formParameter": buildParameterItems(data.formParameters ?? data.formParameter),
    "prm:itemParameter": buildParameterItems(data.itemParameters ?? data.itemParameter),
    "prm:item2Parameter": buildParameterItems(data.item2Parameters ?? data.item2Parameter),
    "prm:userForm": optionalNamespaceObject("prm", data.userForm),
    "prm:userCode": typeof data.userCode === "string" ? data.userCode : undefined,
    "prm:userCodePart": data.userCodePart && typeof data.userCodePart === "object" ? namespaceObject("prm", data.userCodePart) : undefined,
    ...namespaceObject("prm", data.extraData)
  });
}

function buildParameterItems(value: unknown): XmlObject | undefined {
  const items = Array.isArray(value) ? value as Record<string, any>[] : [];
  if (items.length === 0) {
    return undefined;
  }
  return items.map((item) => ({
    "prm:parameterDef": filterEmpty({
      "prm:id": Number(item.id ?? 0) > 0 ? Number(item.id) : undefined,
      "prm:label": item.label,
      "prm:name": item.name,
      "prm:type": item.type,
      "prm:length": item.length,
      "prm:definition": item.definition,
      "prm:list": ref(item.list ?? ""),
      "prm:write": item.write,
      "prm:row": item.row,
      "prm:use0": item.use0,
      "prm:use1": item.use1,
      "prm:use2": item.use2,
      "prm:use3": item.use3,
      "prm:use4": item.use4,
      "prm:use5": item.use5,
      ...namespaceObject("prm", item.extraParameter)
    })
  })) as unknown as XmlObject;
}

function buildBalanceRequestData(options: Record<string, any>): XmlObject {
  const limit = buildLimitData({ idFrom: options.idFrom, count: options.count || options.limit });
  return filterEmpty({
    "lst:limit": Object.keys(limit).length > 0 ? limit : undefined,
    "lst:requestBalance": filterEmpty({
      "lst:dateTo": options.dateTo,
      "lst:adjustTo": options.adjustTo,
      "lst:groupByDoc": options.groupByDoc,
      "lst:removeBalancedRec": options.removeBalancedRec,
      "lst:pairing": options.pairing || "PairingSymbol",
      "lst:userFilterName": options.userFilterName
    })
  });
}

function buildActionFilter(match: Record<string, any>, data: Record<string, any>, agenda: string): XmlObject {
  const source = { ...data, ...match };
  const filter = buildFilterData(filterEmpty({
    id: Number(source.id ?? 0) > 0 ? Number(source.id) : undefined,
    extId: source.extId ? { ids: source.extId, exSystemName: source.extSystemName ?? source.exSystemName } : undefined,
    code: source.code,
    name: agenda === "stock" ? source.name : undefined,
    ico: agenda === "addressbook" ? source.ico : undefined,
    company: agenda === "addressbook" ? source.company : undefined
  }), agenda);
  if (Object.keys(filter).length === 0) {
    throw new Error(`${agenda} ${source.action ?? "update/delete"} requires a match id, extId+extSystemName, code, or another supported filter.`);
  }
  return { "ftr:filter": filter };
}

function buildOptionalActionFilter(match: Record<string, any>, data: Record<string, any>, agenda: string): XmlObject | undefined {
  try {
    return buildActionFilter(match, data, agenda);
  } catch {
    return undefined;
  }
}

function requireFields(data: Record<string, any>, fields: string[], label: string): void {
  const missing = fields.filter((field) => String(data[field] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(`${label} requires ${missing.join(", ")}.`);
  }
}

function buildStockItemRef(data: Record<string, any>): XmlObject | undefined {
  if (data.stockItem && typeof data.stockItem === "object") {
    return namespaceObject("typ", data.stockItem);
  }
  const id = Number(data.stockId ?? 0);
  const idsValue = String(data.stockCode ?? data.stockIds ?? data.code ?? "").trim();
  const stockItem = id > 0
    ? { "typ:id": id }
    : idsValue !== "" ? { "typ:ids": idsValue } : undefined;
  if (!stockItem) {
    return undefined;
  }
  const store = ref(data.stockStore ?? data.store ?? data.sourceStore ?? "");
  if (store) {
    return {
      "typ:store": store,
      "typ:stockItem": stockItem
    };
  }
  if (id > 0) {
    return { "typ:stockItem": { "typ:id": id } };
  }
  return { "typ:stockItem": stockItem };
}

function buildLabels(prefix: string, value: unknown): XmlObject | undefined {
  const labels = splitList(value).map((label) => ({ "typ:label": { "typ:ids": label } }));
  return labels.length > 0 ? labels as unknown as XmlObject : undefined;
}

function buildParameters(prefix: string, value: unknown): XmlObject | undefined {
  if (!value) {
    return undefined;
  }
  const entries: Record<string, any>[] = Array.isArray(value)
    ? value as Record<string, any>[]
    : Object.entries(value as Record<string, any>).map(([name, parameterValue]) => ({ name, value: parameterValue }));
  const parameters = entries.map((entry) => ({
    "typ:parameter": filterEmpty({
      "typ:name": entry.name ?? entry.ids,
      "typ:value": entry.value,
      "typ:list": entry.list,
      ...namespaceObject("typ", entry.extraParameter)
    })
  }));
  return parameters.length > 0 ? parameters as unknown as XmlObject : undefined;
}

function buildPluSettings(data: Record<string, any>): XmlObject | undefined {
  if (!data.usePLU && data.lowerLimit === undefined && data.upperLimit === undefined) {
    return undefined;
  }
  return filterEmpty({
    "sto:usePLU": data.usePLU,
    "sto:lowerLimit": data.lowerLimit,
    "sto:upperLimit": data.upperLimit
  });
}

function namespaceObject(prefix: string, value: unknown): XmlObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: XmlObject = {};
  for (const [key, child] of Object.entries(value as Record<string, any>)) {
    const xmlKey = key.startsWith("@") || key.includes(":") ? key : `${prefix}:${key}`;
    if (child && typeof child === "object" && !Array.isArray(child) && !(child instanceof Date)) {
      result[xmlKey] = namespaceObject(prefix, child);
    } else if (Array.isArray(child)) {
      result[xmlKey] = child.map((item) => item && typeof item === "object" ? namespaceObject(prefix, item) : item) as any;
    } else {
      result[xmlKey] = child;
    }
  }
  return filterEmpty(result);
}

function optionalNamespaceObject(prefix: string, value: unknown): XmlObject | undefined {
  const object = namespaceObject(prefix, value);
  return Object.keys(object).length > 0 ? object : undefined;
}

function buildInvoiceData(header: Record<string, any>, items: Record<string, any>[]): XmlObject {
  const type = header.type || "issuedInvoice";
  const currency = header.currency ?? "";
  const invoiceHeader = filterEmpty({
    "inv:invoiceType": type,
    "inv:extId": buildExtId(header),
    "inv:sphereType": header.sphereType,
    "inv:number": header.number ? { "typ:numberRequested": header.number } : undefined,
    "inv:symVar": header.symVar,
    "inv:originalDocument": header.originalDocument,
    "inv:originalDocumentNumber": header.originalDocumentNumber,
    "inv:symPar": header.symPar,
    "inv:date": header.date,
    "inv:dateTax": header.dateTax,
    "inv:dateAccounting": header.dateAccounting,
    "inv:dateDue": header.dateDue,
    "inv:dateApplicationVAT": header.dateApplicationVAT,
    "inv:dateKHDPH": header.dateKHDPH,
    "inv:dateDelivery": header.dateDelivery,
    "inv:accounting": ids(header.accounting ?? ""),
    "inv:classificationVAT": header.classificationVAT ? { "typ:classificationVATType": header.classificationVAT } : undefined,
    "inv:classificationKVDPH": ids(header.classificationKVDPH ?? ""),
    "inv:numberKHDPH": header.numberKHDPH,
    "inv:numberKVDPH": header.numberKVDPH,
    "inv:text": header.text,
    "inv:partnerIdentity": buildPartnerIdentity(header),
    "inv:paymentType": buildPaymentType(header.paymentType ?? ""),
    "inv:account": ids(header.accountIds ?? ""),
    "inv:symConst": header.symConst,
    "inv:symSpec": header.symSpec,
    "inv:paymentAccount": buildPaymentAccount(header),
    "inv:messageForRecipient": header.messageForRecipient,
    "inv:paymentTerminal": header.paymentTerminal,
    "inv:note": header.note,
    "inv:intNote": header.intNote,
    "inv:centre": ids(header.centre ?? ""),
    "inv:activity": ids(header.activity ?? ""),
    "inv:contract": ids(header.contract ?? "")
  });
  const data: XmlObject = { "inv:invoiceHeader": invoiceHeader };
  if (items.length > 0) {
    data["inv:invoiceDetail"] = items.map((item) => ({
      "inv:invoiceItem": filterEmpty({
        "inv:text": item.text ?? "",
        "inv:quantity": Number(item.quantity ?? 1),
        "inv:unit": item.unit,
        "inv:coefficient": item.coefficient,
        "inv:payVAT": item.payVAT,
        "inv:rateVAT": item.vatRate ?? "high",
        "inv:discountPercentage": item.discountPercentage,
        ...(currency ? { "inv:foreignCurrency": buildCurrencyItem(item) } : { "inv:homeCurrency": buildCurrencyItem(item) }),
        "inv:note": item.note,
        "inv:code": item.code,
        "inv:stockItem": item.stockCode ? { "typ:stockItem": { "typ:ids": item.stockCode } } : undefined,
        "inv:accounting": ids(item.accounting ?? ""),
        "inv:classificationVAT": item.classificationVAT ? { "typ:classificationVATType": item.classificationVAT } : undefined,
        "inv:classificationKVDPH": ids(item.classificationKVDPH ?? ""),
        "inv:centre": ids(item.centre ?? ""),
        "inv:activity": ids(item.activity ?? ""),
        "inv:contract": ids(item.contract ?? "")
      })
    }));
  }
  if (currency) {
    data["inv:invoiceSummary"] = {
      "inv:foreignCurrency": {
        "typ:currency": { "typ:ids": currency },
        "typ:rate": Number(header.currencyRate ?? 0) || 1,
        "typ:amount": 1
      }
    };
  }
  return data;
}

function buildVoucherData(header: Record<string, any>, items: Record<string, any>[]): XmlObject {
  const currency = header.currency ?? "";
  const data: XmlObject = {
    "vch:voucherHeader": filterEmpty({
      "vch:extId": buildExtId(header),
      "vch:voucherType": header.type ?? header.voucherType,
      "vch:cashAccount": ids(header.cashAccount ?? header.cashAccountIds ?? ""),
      "vch:number": header.number ? { "typ:numberRequested": header.number } : undefined,
      "vch:originalDocument": header.originalDocument,
      "vch:date": header.date,
      "vch:datePayment": header.datePayment,
      "vch:dateTax": header.dateTax,
      "vch:dateKHDPH": header.dateKHDPH,
      "vch:accounting": ids(header.accounting ?? ""),
      "vch:classificationVAT": header.classificationVAT ? { "typ:classificationVATType": header.classificationVAT } : undefined,
      "vch:classificationKVDPH": ids(header.classificationKVDPH ?? ""),
      "vch:text": header.text,
      "vch:partnerIdentity": buildPartnerIdentity(header),
      "vch:symPar": header.symPar,
      "vch:priceLevel": ids(header.priceLevel ?? ""),
      "vch:centre": ids(header.centre ?? ""),
      "vch:activity": ids(header.activity ?? ""),
      "vch:contract": ids(header.contract ?? ""),
      "vch:note": header.note,
      "vch:intNote": header.intNote,
      "vch:markRecord": header.markRecord
    })
  };
  if (items.length > 0) {
    data["vch:voucherDetail"] = items.map((item) => ({
      "vch:voucherItem": filterEmpty({
        "vch:extId": item.extId,
        "vch:text": item.text ?? "",
        "vch:quantity": Number(item.quantity ?? 1),
        "vch:unit": item.unit,
        "vch:coefficient": item.coefficient,
        "vch:payVAT": item.payVAT,
        "vch:rateVAT": item.vatRate ?? "none",
        "vch:percentVAT": item.percentVAT,
        "vch:discountPercentage": item.discountPercentage,
        ...(currency ? { "vch:foreignCurrency": buildCurrencyItem(item) } : { "vch:homeCurrency": buildCurrencyItem(item) }),
        "vch:note": item.note,
        "vch:code": item.code,
        "vch:symPar": item.symPar,
        "vch:stockItem": item.stockCode ? { "typ:stockItem": { "typ:ids": item.stockCode } } : undefined,
        "vch:linkToStock": item.linkToStock ? { "typ:ids": item.linkToStock } : undefined,
        "vch:accounting": ids(item.accounting ?? ""),
        "vch:classificationVAT": item.classificationVAT ? { "typ:classificationVATType": item.classificationVAT } : undefined,
        "vch:classificationKVDPH": ids(item.classificationKVDPH ?? ""),
        "vch:PDP": item.PDP,
        "vch:CodePDP": item.CodePDP,
        "vch:centre": ids(item.centre ?? ""),
        "vch:activity": ids(item.activity ?? ""),
        "vch:contract": ids(item.contract ?? "")
      })
    }));
  }
  const summary = buildDocumentSummary("vch", header);
  if (Object.keys(summary).length > 0) {
    data["vch:voucherSummary"] = summary;
  }
  return data;
}

function buildActivityData(action: "add" | "update" | "delete", data: Record<string, any>, match: Record<string, any>): XmlObject {
  const result: XmlObject = {};
  if (action === "update" || action === "delete") {
    const id = Number(match.id || data.id || 0);
    if (id <= 0) {
      throw new Error("Activity update/delete requires match.id or data.id. POHODA activity action filters support numeric id.");
    }
    result["acv:actionType"] = { [`acv:${action}`]: { "ftr:filter": { "ftr:id": id } } };
  }
  if (action !== "delete") {
    result["acv:activityHeader"] = filterEmpty({
      "acv:id": Number(data.id ?? 0) > 0 ? Number(data.id) : undefined,
      "acv:extId": buildExtId(data),
      "acv:code": data.code,
      "acv:name": data.name,
      "acv:taxType": ids(data.taxType ?? data.taxTypeIds ?? ""),
      "acv:note": data.note,
      "acv:markRecord": data.markRecord
    });
  }
  return result;
}

function buildAddressData(data: Record<string, any>): XmlObject {
  return {
    "adb:addressbookHeader": filterEmpty({
      "adb:identity": {
        "typ:address": filterEmpty({
          "typ:company": data.company ?? "",
          "typ:ico": data.ico,
          "typ:dic": data.dic,
          "typ:street": data.street,
          "typ:city": data.city,
          "typ:zip": data.zip
        })
      },
      "adb:phone": data.phone,
      "adb:email": data.email
    })
  };
}

function buildStockData(data: Record<string, any>): XmlObject {
  const vatRate = data.vatRate ?? "high";
  return {
    "stk:stockHeader": filterEmpty({
      "stk:stockType": "card",
      "stk:code": data.code,
      "stk:EAN": data.EAN,
      "stk:PLU": data.PLU || undefined,
      "stk:isSales": data.isSales ?? true,
      "stk:isInternet": data.isInternet ?? false,
      "stk:name": data.name,
      "stk:nameComplement": data.nameComplement,
      "stk:unit": data.unit ?? "ks",
      "stk:storage": ids(data.storage ?? ""),
      "stk:typePrice": ids(data.typePrice ?? data.priceGroup ?? ""),
      "stk:sellingRateVAT": vatRate,
      "stk:purchasingRateVAT": vatRate,
      "stk:purchasingPrice": data.purchasingPrice > 0 ? Number(data.purchasingPrice) : undefined,
      "stk:sellingPrice": Number(data.sellingPrice),
      "stk:limitMin": data.limitMin > 0 ? Number(data.limitMin) : undefined,
      "stk:limitMax": data.limitMax > 0 ? Number(data.limitMax) : undefined,
      "stk:mass": data.mass > 0 ? Number(data.mass) : undefined,
      "stk:supplier": data.supplierId > 0 ? { "typ:id": Number(data.supplierId) } : undefined,
      "stk:shortName": data.shortName,
      "stk:guaranteeType": data.guarantee > 0 ? (data.guaranteeType ?? "year") : undefined,
      "stk:guarantee": data.guarantee > 0 ? Number(data.guarantee) : undefined,
      "stk:description": data.description,
      "stk:description2": data.description2,
      "stk:note": data.note
    })
  };
}

function buildOrderData(header: Record<string, any>, items: Record<string, any>[]): XmlObject {
  const type = header.type === "issuedOrder" ? "issuedOrder" : "receivedOrder";
  return {
    "ord:orderHeader": filterEmpty({
      "ord:orderType": type,
      "ord:date": header.date,
      "ord:partnerIdentity": buildPartnerIdentity(header)
    }),
    "ord:orderDetail": items.map((item) => ({
      "ord:orderItem": filterEmpty({
        "ord:text": item.text ?? "",
        "ord:quantity": Number(item.quantity ?? 1),
        "ord:unit": item.unit,
        "ord:rateVAT": item.vatRate ?? "high",
        "ord:homeCurrency": { "typ:unitPrice": Number(item.unitPrice ?? 0) }
      })
    }))
  };
}

function writeBatchItem(operation: WriteBatchOperation, index: number): DataPackItem {
  const requestId = operation.requestId && operation.requestId !== "" ? operation.requestId : `${operation.tool}-${index + 1}`;
  if (operation.tool === "create_address") {
    return {
      rootElement: "adb:addressbook",
      version: "2.0",
      data: buildAddressData(operation.data),
      note: `${requestId}:create_address`
    };
  }
  if (operation.tool === "manage_address") {
    return {
      rootElement: "adb:addressbook",
      version: "2.0",
      data: buildManageAddressData(operation.action, operation.data, operation.match ?? {}),
      note: `${requestId}:manage_address`
    };
  }
  if (operation.tool === "create_invoice") {
    return {
      rootElement: "inv:invoice",
      version: "2.0",
      data: buildInvoiceData(operation.header, operation.items),
      note: `${requestId}:create_invoice`
    };
  }
  if (operation.tool === "create_other_liability") {
    return {
      rootElement: "inv:invoice",
      version: "2.0",
      data: buildInvoiceData({ ...operation.header, type: "commitment" }, operation.items),
      note: `${requestId}:create_other_liability`
    };
  }
  if (operation.tool === "create_other_receivable") {
    return {
      rootElement: "inv:invoice",
      version: "2.0",
      data: buildInvoiceData({ ...operation.header, type: "receivable" }, operation.items),
      note: `${requestId}:create_other_receivable`
    };
  }
  if (operation.tool === "create_cash_voucher") {
    return {
      rootElement: "vch:voucher",
      version: "2.0",
      data: buildVoucherData(operation.header, operation.items),
      note: `${requestId}:create_cash_voucher`
    };
  }
  if (operation.tool === "create_stock") {
    return {
      rootElement: "stk:stock",
      version: "2.0",
      data: buildStockData(operation.data),
      note: `${requestId}:create_stock`
    };
  }
  if (operation.tool === "manage_stock") {
    return {
      rootElement: "stk:stock",
      version: "2.0",
      data: buildManageStockData(operation.action, operation.data, operation.match ?? {}),
      note: `${requestId}:manage_stock`
    };
  }
  if (operation.tool === "create_order") {
    return {
      rootElement: "ord:order",
      version: "2.0",
      data: buildOrderData(operation.header, operation.items),
      note: `${requestId}:create_order`
    };
  }
  if (operation.tool === "create_bank_document") {
    return {
      rootElement: "bnk:bank",
      version: "2.0",
      data: buildGenericDocumentData(bankDocumentConfig, operation.header, operation.items),
      note: `${requestId}:create_bank_document`
    };
  }
  if (operation.tool === "create_internal_document") {
    return {
      rootElement: "int:intDoc",
      version: "2.0",
      data: buildGenericDocumentData(internalDocumentConfig, operation.header, operation.items),
      note: `${requestId}:create_internal_document`
    };
  }
  if (operation.tool === "create_stock_receipt") {
    return {
      rootElement: "pri:prijemka",
      version: "2.0",
      data: buildGenericDocumentData(stockReceiptConfig, operation.header, operation.items),
      note: `${requestId}:create_stock_receipt`
    };
  }
  if (operation.tool === "create_stock_issue") {
    return {
      rootElement: "vyd:vydejka",
      version: "2.0",
      data: buildGenericDocumentData(stockIssueConfig, operation.header, operation.items),
      note: `${requestId}:create_stock_issue`
    };
  }
  if (operation.tool === "create_stock_transfer") {
    return {
      rootElement: "pre:prevodka",
      version: "2.0",
      data: buildGenericDocumentData(stockTransferConfig, operation.header, operation.items),
      note: `${requestId}:create_stock_transfer`
    };
  }
  if (operation.tool === "create_production_document") {
    return {
      rootElement: "vyr:vyroba",
      version: "2.0",
      data: buildGenericDocumentData(productionConfig, operation.header, operation.items),
      note: `${requestId}:create_production_document`
    };
  }
  if (operation.tool === "create_sales_receipt") {
    return {
      rootElement: "pro:prodejka",
      version: "2.0",
      data: buildSalesReceiptData(operation.header, operation.items, operation.payments ?? []),
      note: `${requestId}:create_sales_receipt`
    };
  }
  if (operation.tool === "create_offer") {
    return {
      rootElement: "ofr:offer",
      version: "2.0",
      data: buildGenericDocumentData(offerConfig, operation.header, operation.items),
      note: `${requestId}:create_offer`
    };
  }
  if (operation.tool === "create_enquiry") {
    return {
      rootElement: "enq:enquiry",
      version: "2.0",
      data: buildGenericDocumentData(enquiryConfig, operation.header, operation.items),
      note: `${requestId}:create_enquiry`
    };
  }
  if (operation.tool === "manage_contract") {
    return {
      rootElement: "con:contract",
      version: "2.0",
      data: buildContractData(operation.data, operation.planItems ?? []),
      note: `${requestId}:manage_contract`
    };
  }
  if (operation.tool === "manage_centre") {
    return {
      rootElement: "cen:centre",
      version: "2.0",
      data: buildSimpleCodebookData("cen", "centre", operation.action, operation.data, operation.match ?? {}, ["code", "name", "establishment", "note", "markRecord"]),
      note: `${requestId}:manage_centre`
    };
  }
  if (operation.tool === "manage_activity") {
    return {
      rootElement: "acv:activity",
      version: "2.0",
      data: buildActivityData(operation.action, operation.data, operation.match ?? {}),
      note: `${requestId}:manage_activity`
    };
  }
  if (operation.tool === "manage_store") {
    return {
      rootElement: "sto:store",
      version: "2.0",
      data: buildStoreData(operation.data),
      note: `${requestId}:manage_store`
    };
  }
  if (operation.tool === "manage_storage") {
    return {
      rootElement: "str:storage",
      version: "2.0",
      data: buildStorageData(operation.data),
      note: `${requestId}:manage_storage`
    };
  }
  if (operation.tool === "manage_bank_account") {
    return {
      rootElement: "bka:bankAccount",
      version: "2.0",
      data: buildBankAccountData(operation.action, operation.data, operation.match ?? {}),
      note: `${requestId}:manage_bank_account`
    };
  }
  if (operation.tool === "manage_group_stock") {
    return {
      rootElement: "grs:groupStocks",
      version: "2.0",
      data: buildGroupStockData(operation.action, operation.data, operation.variants ?? [], operation.match ?? {}),
      note: `${requestId}:manage_group_stock`
    };
  }
  if (operation.tool === "manage_parameter_definition") {
    return {
      rootElement: "prm:parameter",
      version: "2.0",
      rootAttrs: filterEmpty({ idsAgenda: operation.data.idsAgenda }) as Record<string, string>,
      data: buildParameterDefinitionData(operation.data),
      note: `${requestId}:manage_parameter_definition`
    };
  }
  return {
    rootElement: "prn:print",
    version: "1.0",
    data: buildPrintData(operation.options),
    note: `${requestId}:print`
  };
}

function buildFilterData(filter: Record<string, unknown>, agenda = ""): XmlObject {
  const data: XmlObject = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === "" || value === null || value === undefined) {
      continue;
    }
    const map: Record<string, unknown> = {
      id: { "ftr:id": Number(value) },
      extId: typeof value === "object" ? { "ftr:extId": { "typ:ids": (value as any).ids ?? "", "typ:exSystemName": (value as any).exSystemName ?? "" } } : {},
      dateFrom: { "ftr:dateFrom": value },
      dateTill: { "ftr:dateTill": value },
      lastChanges: { "ftr:lastChanges": value },
      company: agenda === "addressbook" ? { "ftr:company": value } : { "ftr:selectedCompanys": { "ftr:company": value } },
      ico: agenda === "addressbook" ? { "ftr:ico": value } : { "ftr:selectedIco": { "ftr:ico": value } },
      number: { "ftr:selectedNumbers": { "ftr:number": { "typ:numberRequested": value } } },
      code: { "ftr:code": value },
      name: { "ftr:name": value },
      EAN: { "ftr:EAN": value },
      PLU: { "ftr:PLU": Number(value) },
      storage: { "ftr:storage": { "typ:ids": value } },
      store: { "ftr:store": { "typ:ids": value } },
      internet: { "ftr:internet": Boolean(value) },
      city: { "ftr:city": value },
      street: { "ftr:street": value },
      zip: { "ftr:zip": value },
      dic: { "ftr:dic": value },
      addressNumber: { "ftr:number": value }
    };
    Object.assign(data, (map[key] ?? {}) as XmlObject);
  }
  return data;
}

function buildLimitData(options: Record<string, unknown>): XmlObject {
  const data: XmlObject = {};
  const idFrom = Number(options.idFrom ?? 0);
  const count = Number(options.count ?? 0);
  if (idFrom > 0) {
    data["ftr:idFrom"] = idFrom;
  }
  if (count > 0) {
    data["ftr:count"] = Math.max(1, Math.min(10_000, count));
  }
  return data;
}

function buildRestrictionData(restrictions: unknown): XmlObject {
  if (!restrictions || typeof restrictions !== "object") {
    return {};
  }
  return Object.fromEntries(Object.entries(restrictions).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, Boolean(value)]));
}

function buildPartnerIdentity(header: Record<string, any>): XmlObject | undefined {
  if (Number(header.partnerId ?? 0) > 0) {
    return { "typ:id": Number(header.partnerId) };
  }
  if (!header.partnerName) {
    return undefined;
  }
  return {
    "typ:address": filterEmpty({
      "typ:company": header.partnerName,
      "typ:ico": header.partnerIco,
      "typ:street": header.partnerStreet,
      "typ:city": header.partnerCity,
      "typ:zip": header.partnerZip
    })
  };
}

function buildExtId(data: Record<string, any>): XmlObject | undefined {
  const idsValue = String(data.extId ?? "").trim();
  const exSystemName = String(data.extSystemName ?? data.exSystemName ?? "").trim();
  return idsValue !== "" && exSystemName !== ""
    ? { "typ:ids": idsValue, "typ:exSystemName": exSystemName }
    : undefined;
}

function buildPaymentAccount(header: Record<string, any>): XmlObject | undefined {
  const accountNo = String(header.paymentAccountNo ?? header.paymentAccountNumber ?? "").trim();
  const bankCode = String(header.paymentBankCode ?? "").trim();
  return accountNo !== "" && bankCode !== ""
    ? { "typ:accountNo": accountNo, "typ:bankCode": bankCode }
    : undefined;
}

function buildCurrencyItem(item: Record<string, any>, prefix = "typ"): XmlObject {
  return filterEmpty({
    [`${prefix}:unitPrice`]: Number(item.unitPrice ?? 0),
    [`${prefix}:price`]: item.price !== undefined ? Number(item.price) : undefined,
    [`${prefix}:priceVAT`]: item.priceVAT !== undefined ? Number(item.priceVAT) : undefined,
    [`${prefix}:priceSum`]: item.priceSum !== undefined ? Number(item.priceSum) : undefined
  });
}

function buildDocumentSummary(prefix: string, header: Record<string, any>): XmlObject {
  return filterEmpty({
    [`${prefix}:roundingDocument`]: header.roundingDocument,
    [`${prefix}:roundingVAT`]: header.roundingVAT,
    [`${prefix}:calculateVAT`]: header.calculateVAT,
    [`${prefix}:typeCalculateVATInclusivePrice`]: header.typeCalculateVATInclusivePrice,
    [`${prefix}:homeCurrency`]: buildHomeCurrencySummary(header),
    [`${prefix}:foreignCurrency`]: buildForeignCurrencySummary(header)
  });
}

function buildHomeCurrencySummary(data: Record<string, any>): XmlObject | undefined {
  const summary = filterEmpty({
    "typ:priceNone": data.priceNone,
    "typ:priceLow": data.priceLow,
    "typ:priceLowVAT": data.priceLowVAT,
    "typ:priceLowSum": data.priceLowSum,
    "typ:priceHigh": data.priceHigh,
    "typ:priceHighVAT": data.priceHighVAT,
    "typ:priceHighSum": data.priceHighSum,
    "typ:price3": data.price3,
    "typ:price3VAT": data.price3VAT,
    "typ:price3Sum": data.price3Sum
  });
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function buildForeignCurrencySummary(data: Record<string, any>): XmlObject | undefined {
  const currency = String(data.currency ?? "").trim();
  if (currency === "") {
    return undefined;
  }
  return filterEmpty({
    "typ:currency": { "typ:ids": currency },
    "typ:rate": Number(data.currencyRate ?? 0) || 1,
    "typ:amount": Number(data.currencyAmount ?? 0) || 1,
    "typ:priceSum": data.currencyPriceSum !== undefined ? Number(data.currencyPriceSum) : undefined
  });
}

function buildPaymentType(paymentType: string): XmlObject | undefined {
  if (paymentType === "") {
    return undefined;
  }
  return ["draft", "cash", "card", "compensation"].includes(paymentType)
    ? { "typ:paymentType": paymentType }
    : { "typ:ids": paymentType };
}

function buildPrintRecordSelector(options: Record<string, any>): XmlObject {
  if (Number(options.recordId ?? 0) > 0) {
    return { "ftr:filter": { "ftr:id": Number(options.recordId) } };
  }
  if ((options.queryFilter ?? "") !== "") {
    return { "ftr:queryFilter": { "ftr:filter": options.queryFilter } };
  }
  if ((options.userFilterName ?? "") !== "") {
    return { "ftr:userFilterName": options.userFilterName };
  }
  throw new Error("recordId, queryFilter, or userFilterName is required for print.");
}

function buildSendMailData(options: Record<string, any>): XmlObject {
  return filterEmpty({
    "prn:template": options.emailTemplate ? { "prn:name": options.emailTemplate } : undefined,
    "prn:to": emails(options.emailTo),
    "prn:cc": emails(options.emailCc),
    "prn:bcc": emails(options.emailBcc),
    "prn:subject": options.emailSubject,
    "prn:body": options.emailBody,
    "prn:attachments": attachments(options.emailAttachments),
    "prn:priority": options.emailPriority || undefined,
    "prn:returnReceipt": options.emailReturnReceipt ? true : undefined,
    "prn:disposNotif": options.emailReadReceipt ? true : undefined,
    "prn:removeFile": options.removeFile ? true : undefined
  });
}

function hasEmailOptions(options: Record<string, any>): boolean {
  return ["emailTemplate", "emailTo", "emailCc", "emailBcc", "emailSubject", "emailBody", "emailAttachments", "emailPriority"]
    .some((key) => (options[key] ?? "") !== "") || Boolean(options.emailReturnReceipt || options.emailReadReceipt);
}

function buildPrintParameters(parameters: unknown): XmlObject {
  if (!parameters || typeof parameters !== "object") {
    return {};
  }
  const allowed = new Set(["checkbox1", "checkbox2", "checkbox3", "checkbox4", "checkbox5", "checkbox6", "checkbox7", "checkbox8", "radioButton1", "spin1", "currency1", "month1", "month2", "year1", "date1"]);
  const result: XmlObject = {};
  for (const [name, value] of Object.entries(parameters)) {
    if (allowed.has(name) && value !== null && value !== undefined && value !== "") {
      result[`prn:${name}`] = value as any;
    }
  }
  return result;
}

function emails(value: unknown): XmlObject | undefined {
  const items = splitList(value).map((email) => ({ "prn:email": email }));
  return items.length > 0 ? items as unknown as XmlObject : undefined;
}

function attachments(value: unknown): XmlObject | undefined {
  const items = splitList(value).map((attachment) => ({ "prn:attachment": attachment }));
  return items.length > 0 ? items as unknown as XmlObject : undefined;
}

function splitList(value: unknown): string[] {
  return (Array.isArray(value) ? value : String(value ?? "").split(/[,;]/)).map((item) => String(item).trim()).filter(Boolean);
}

function ref(value: unknown): XmlObject | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "number") {
    return value > 0 ? { "typ:id": value } : undefined;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const data = value as Record<string, any>;
    return filterEmpty({
      "typ:id": Number(data.id ?? 0) > 0 ? Number(data.id) : undefined,
      "typ:ids": data.ids ?? data.code,
      "typ:extId": buildExtId(data)
    });
  }
  const text = String(value).trim();
  return text !== "" ? { "typ:ids": text } : undefined;
}

function ids(value: string): XmlObject | undefined {
  return value !== "" ? { "typ:ids": value } : undefined;
}

function filterEmpty<T extends Record<string, any>>(data: T): XmlObject {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)));
}
