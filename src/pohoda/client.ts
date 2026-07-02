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
  | { requestId?: string; tool: "create_invoice"; header: Record<string, any>; items: Record<string, any>[] }
  | { requestId?: string; tool: "create_stock"; data: Record<string, any> }
  | { requestId?: string; tool: "create_order"; header: Record<string, any>; items: Record<string, any>[] }
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

  public async createAddress(data: Record<string, any>, dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("adb:addressbook", "2.0", buildAddressData(data), "Create address", {}, dataPackId, databaseOption(target));
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

  public async createOrder(header: Record<string, any>, items: Record<string, any>[], dataPackId = "", target: DatabaseTarget = ""): Promise<PohodaResponse> {
    return this.send("ord:order", "2.0", buildOrderData(header, items), "Create order", {}, dataPackId, databaseOption(target));
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

function buildInvoiceData(header: Record<string, any>, items: Record<string, any>[]): XmlObject {
  const type = header.type === "receivedInvoice" ? "receivedInvoice" : "issuedInvoice";
  const currency = header.currency ?? "";
  const invoiceHeader = filterEmpty({
    "inv:invoiceType": type,
    "inv:number": header.number ? { "typ:numberRequested": header.number } : undefined,
    "inv:symVar": header.symVar,
    "inv:date": header.date,
    "inv:dateTax": header.dateTax,
    "inv:dateAccounting": header.dateAccounting,
    "inv:dateDue": header.dateDue,
    "inv:accounting": ids(header.accounting ?? ""),
    "inv:classificationVAT": header.classificationVAT ? { "typ:classificationVATType": header.classificationVAT } : undefined,
    "inv:text": header.text,
    "inv:partnerIdentity": buildPartnerIdentity(header),
    "inv:paymentType": buildPaymentType(header.paymentType ?? ""),
    "inv:account": ids(header.accountIds ?? ""),
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
        "inv:rateVAT": item.vatRate ?? "high",
        ...(currency ? { "inv:foreignCurrency": { "typ:unitPrice": Number(item.unitPrice ?? 0) } } : { "inv:homeCurrency": { "typ:unitPrice": Number(item.unitPrice ?? 0) } }),
        "inv:stockItem": item.stockCode ? { "typ:stockItem": { "typ:ids": item.stockCode } } : undefined
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
  if (operation.tool === "create_invoice") {
    return {
      rootElement: "inv:invoice",
      version: "2.0",
      data: buildInvoiceData(operation.header, operation.items),
      note: `${requestId}:create_invoice`
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
  if (operation.tool === "create_order") {
    return {
      rootElement: "ord:order",
      version: "2.0",
      data: buildOrderData(operation.header, operation.items),
      note: `${requestId}:create_order`
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

function ids(value: string): XmlObject | undefined {
  return value !== "" ? { "typ:ids": value } : undefined;
}

function filterEmpty<T extends Record<string, any>>(data: T): XmlObject {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)));
}
