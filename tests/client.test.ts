import { describe, expect, it } from "vitest";
import { PohodaClient } from "../src/pohoda/client.js";
import type { XmlTransport, CliXmlJobResult } from "../src/pohoda/transport.js";

class FakeTransport implements XmlTransport {
  public calls: Array<{ xml: string; database: string; options: Record<string, unknown> }> = [];

  async exchange(xml: string, database: string, options: Record<string, unknown> = {}): Promise<CliXmlJobResult> {
    this.calls.push({ xml, database, options });
    return {
      xml: '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"/></rsp:responsePack>',
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

  status(database = ""): Record<string, unknown> {
    return { transport: "fake", database };
  }
}

describe("PohodaClient", () => {
  it("builds list invoice XML with invoiceType, filter, paging, and no duplicity check", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    await client.listRecords("invoice", { id: 123, number: "FV001" }, "issuedInvoice", { idFrom: 100, count: 50 });

    expect(transport.calls[0]?.database).toBe("Db");
    expect(transport.calls[0]?.options.checkDuplicity).toBe(false);
    expect(transport.calls[0]?.xml).toContain("<lst:listInvoiceRequest");
    expect(transport.calls[0]?.xml).toContain('invoiceType="issuedInvoice"');
    expect(transport.calls[0]?.xml).toContain("<ftr:id>123</ftr:id>");
    expect(transport.calls[0]?.xml).toContain("<ftr:idFrom>100</ftr:idFrom>");
    expect(transport.calls[0]?.xml).toContain("<ftr:count>50</ftr:count>");
    expect(transport.calls[0]?.xml).toContain("<typ:numberRequested>FV001</typ:numberRequested>");
  });

  it("uses addressbook-specific direct company and ICO filters", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    await client.listRecords("addressbook", { company: "Alpha", ico: "12345678" }, "", { count: 10 });

    expect(transport.calls[0]?.xml).toContain("<lAdb:listAddressBookRequest");
    expect(transport.calls[0]?.xml).toContain("<ftr:company>Alpha</ftr:company>");
    expect(transport.calls[0]?.xml).toContain("<ftr:ico>12345678</ftr:ico>");
    expect(transport.calls[0]?.xml).not.toContain("selectedCompanys");
    expect(transport.calls[0]?.xml).not.toContain("selectedIco");
  });

  it("omits database for official accounting-unit export", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    await client.listAccountingUnits();

    expect(transport.calls[0]?.database).toBe("");
    expect(transport.calls[0]?.options.allowNoDatabase).toBe(true);
    expect(transport.calls[0]?.xml).toContain("<acu:listAccountingUnitRequest");
    expect(transport.calls[0]?.xml).toContain('version="1.6"');
  });

  it("uses per-call database override for create and raw batch operations", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });
    await client.createInvoice({ type: "issuedInvoice", partnerName: "Firma", date: "2026-07-01" }, [
      { text: "Work", unitPrice: 100, quantity: 1 }
    ], "invoice-1", "OtherDb");
    await client.sendRawXmlBatch(["<x:first />", "<x:second />"], "raw", "raw-1", { databaseOverride: "RawDb" });

    expect(transport.calls[0]?.database).toBe("OtherDb");
    expect(transport.calls[0]?.xml).toContain('id="invoice-1"');
    expect(transport.calls[1]?.database).toBe("RawDb");
    expect(transport.calls[1]?.xml).toContain('id="raw-1-2"');
  });

  it("builds stock storage and price group references", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });

    await client.createStock({
      code: "STOCK-1",
      name: "Stock item",
      sellingPrice: 100,
      storage: "SKLAD",
      typePrice: "ZAKL"
    }, "stock-1", "Db");

    expect(transport.calls[0]?.xml).toContain("<stk:storage><typ:ids>SKLAD</typ:ids></stk:storage>");
    expect(transport.calls[0]?.xml).toContain("<stk:typePrice><typ:ids>ZAKL</typ:ids></stk:typePrice>");
  });

  it("uses per-call dataPack ICO override with database overrides", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await client.listRecords("stock", {}, "", { database: "OtherDb", dataPackIco: "87654321", count: 1 });
    await client.createInvoice({ type: "issuedInvoice", partnerName: "Firma", date: "2026-07-01" }, [
      { text: "Work", unitPrice: 100, quantity: 1 }
    ], "invoice-ico", { database: "InvoiceDb", dataPackIco: "11111111" });
    await client.sendRawXmlBatch(["<x:first />"], "raw", "raw-ico", { databaseOverride: "RawDb", dataPackIco: "22222222" });

    expect(transport.calls[0]?.database).toBe("OtherDb");
    expect(transport.calls[0]?.xml).toContain('ico="87654321"');
    expect(transport.calls[0]?.xml).not.toContain('ico="12345678"');
    expect(transport.calls[1]?.database).toBe("InvoiceDb");
    expect(transport.calls[1]?.xml).toContain('ico="11111111"');
    expect(transport.calls[2]?.database).toBe("RawDb");
    expect(transport.calls[2]?.xml).toContain('ico="22222222"');
  });

  it("builds typed batch list XML in a single transport call", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await client.listRecordsBatch([
      { agenda: "invoice", subType: "issuedInvoice", filter: { number: "FV001" }, options: { count: 5 }, note: "issued invoices" },
      { agenda: "stock", filter: { code: "ABC" }, options: { count: 3 }, note: "stock" }
    ], "batch-1", { databaseOverride: "BatchDb" });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.database).toBe("BatchDb");
    expect(transport.calls[0]?.options.checkDuplicity).toBe(false);
    expect(transport.calls[0]?.xml).toContain('id="batch-1-1"');
    expect(transport.calls[0]?.xml).toContain('note="issued invoices"');
    expect(transport.calls[0]?.xml).toContain("<lst:listInvoiceRequest");
    expect(transport.calls[0]?.xml).toContain('invoiceType="issuedInvoice"');
    expect(transport.calls[0]?.xml).toContain("<typ:numberRequested>FV001</typ:numberRequested>");
    expect(transport.calls[0]?.xml).toContain('id="batch-1-2"');
    expect(transport.calls[0]?.xml).toContain("<lStk:listStockRequest");
    expect(transport.calls[0]?.xml).toContain("<ftr:code>ABC</ftr:code>");
  });

  it("builds typed invoice create batch XML in a single transport call", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await client.createInvoiceBatch([
      {
        requestId: "first",
        address: { company: "Alpha", ico: "111", email: "alpha@example.test" },
        header: { type: "issuedInvoice", partnerName: "Alpha", partnerIco: "111", date: "2026-07-02" },
        items: [{ text: "Work", unitPrice: 100, quantity: 1 }]
      },
      {
        requestId: "second",
        header: { type: "issuedInvoice", partnerName: "Beta", partnerIco: "222", date: "2026-07-03" },
        items: [{ text: "More work", unitPrice: 200, quantity: 1 }]
      }
    ], "create-batch", "BatchDb");

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.database).toBe("BatchDb");
    expect(transport.calls[0]?.xml).toContain('id="create-batch-1"');
    expect(transport.calls[0]?.xml).toContain('note="first:address"');
    expect(transport.calls[0]?.xml).toContain("<adb:addressbook");
    expect(transport.calls[0]?.xml).toContain("<typ:company>Alpha</typ:company>");
    expect(transport.calls[0]?.xml).toContain('id="create-batch-2"');
    expect(transport.calls[0]?.xml).toContain('note="first:invoice"');
    expect(transport.calls[0]?.xml).toContain("<inv:invoice");
    expect(transport.calls[0]?.xml).toContain("<inv:invoiceType>issuedInvoice</inv:invoiceType>");
    expect(transport.calls[0]?.xml).toContain('id="create-batch-3"');
    expect(transport.calls[0]?.xml).toContain('note="second:invoice"');
  });

  it("builds mixed typed write batch XML in a single transport call", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await client.writeBatch([
      { requestId: "addr", tool: "create_address", data: { company: "Alpha", ico: "111" } },
      { requestId: "stock", tool: "create_stock", data: { code: "S-1", name: "Service", sellingPrice: 500 } },
      {
        requestId: "order",
        tool: "create_order",
        header: { type: "issuedOrder", partnerName: "Alpha", date: "2026-07-02" },
        items: [{ text: "Work", unitPrice: 100, quantity: 1 }]
      }
    ], "write-batch", "BatchDb");

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.database).toBe("BatchDb");
    expect(transport.calls[0]?.xml).toContain('id="write-batch-1"');
    expect(transport.calls[0]?.xml).toContain('note="addr:create_address"');
    expect(transport.calls[0]?.xml).toContain("<adb:addressbook");
    expect(transport.calls[0]?.xml).toContain('id="write-batch-2"');
    expect(transport.calls[0]?.xml).toContain('note="stock:create_stock"');
    expect(transport.calls[0]?.xml).toContain("<stk:stock");
    expect(transport.calls[0]?.xml).toContain('id="write-batch-3"');
    expect(transport.calls[0]?.xml).toContain('note="order:create_order"');
    expect(transport.calls[0]?.xml).toContain("<ord:order");
  });

  it("builds cash voucher, other liability, and activity XML with official roots", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await client.createCashVoucher({
      type: "receipt",
      cashAccount: "HLAVNI",
      date: "2026-07-02",
      text: "Cash receipt",
      partnerName: "Cash Partner",
      activity: "CONSULT",
      classificationVAT: "inland"
    }, [
      { text: "Paid service", unitPrice: 121, quantity: 1, vatRate: "high", payVAT: true, activity: "CONSULT" }
    ], "voucher-1", "CashDb");
    await client.createOtherLiability({
      partnerName: "Supplier",
      date: "2026-07-02",
      dateDue: "2026-07-16",
      text: "Other payable",
      sphereType: "business",
      symSpec: "555",
      paymentAccountNumber: "123456789",
      paymentBankCode: "0100",
      activity: "ADMIN",
      vatPeriod: "2026-07",
      taxMode: "nonTax",
      originalDocument: "OL-1",
      priceNone: 250,
      total: 250
    }, [], "liability-1", "LiabilityDb");
    await client.manageActivity("update", { name: "Consulting", code: "CONSULT", note: "Updated" }, { id: 42 }, "activity-1", "CodebookDb");

    expect(transport.calls[0]?.database).toBe("CashDb");
    expect(transport.calls[0]?.xml).toContain("<vch:voucher");
    expect(transport.calls[0]?.xml).toContain("<vch:voucherType>receipt</vch:voucherType>");
    expect(transport.calls[0]?.xml).toContain("<vch:cashAccount><typ:ids>HLAVNI</typ:ids></vch:cashAccount>");
    expect(transport.calls[0]?.xml).toContain("<vch:activity><typ:ids>CONSULT</typ:ids></vch:activity>");
    expect(transport.calls[0]?.xml).toContain("<vch:payVAT>true</vch:payVAT>");

    expect(transport.calls[1]?.database).toBe("LiabilityDb");
    expect(transport.calls[1]?.xml).toContain("<inv:invoiceType>commitment</inv:invoiceType>");
    expect(transport.calls[1]?.xml).toContain("<inv:sphereType>business</inv:sphereType>");
    expect(transport.calls[1]?.xml).toContain("<inv:symSpec>555</inv:symSpec>");
    expect(transport.calls[1]?.xml).toContain("<typ:accountNo>123456789</typ:accountNo>");
    expect(transport.calls[1]?.xml).toContain("<typ:bankCode>0100</typ:bankCode>");

    expect(transport.calls[2]?.database).toBe("CodebookDb");
    expect(transport.calls[2]?.xml).toContain("<acv:activity");
    expect(transport.calls[2]?.xml).toContain("<acv:update><ftr:filter><ftr:id>42</ftr:id></ftr:filter></acv:update>");
    expect(transport.calls[2]?.xml).toContain("<acv:code>CONSULT</acv:code>");
    expect(transport.calls[2]?.xml).toContain("<acv:name>Consulting</acv:name>");
  });

  it("keeps dateTax and dateKHDPH correct across taxable document types", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });
    const item = [{ text: "Taxable supply", unitPrice: 100, quantity: 1, vatRate: "high" }];
    const summary = { priceHigh: 100, priceHighVAT: 21, total: 121 };

    await client.createInvoice({
      type: "receivedInvoice",
      date: "2026-08-05",
      dateTax: "2026-08-05",
      partnerName: "Supplier",
      text: "Received same",
      vatPeriod: "2026-08",
      taxMode: "taxable", classificationVAT: "PD",
      originalDocument: "FA-1",
      ...summary
    }, [], "received-same", "Db");
    await client.createInvoice({
      type: "receivedInvoice",
      date: "2026-08-05",
      dateTax: "2026-08-05",
      dateKHDPH: "2026-07-31",
      partnerName: "Supplier",
      text: "Received late source",
      vatPeriod: "2026-08",
      taxMode: "taxable", classificationVAT: "PD",
      originalDocument: "FA-2",
      ...summary
    }, [], "received-different", "Db");
    await client.createInvoice({
      type: "issuedInvoice",
      date: "2026-08-05",
      dateTax: "2026-08-05",
      partnerName: "Customer"
    }, item, "issued", "Db");
    await client.createInvoice({
      type: "issuedCorrectiveTax",
      date: "2026-08-05",
      dateTax: "2026-08-05",
      partnerName: "Customer"
    }, item, "issued-corrective", "Db");
    await client.createOtherLiability({
      date: "2026-08-05",
      dateTax: "2026-08-05",
      partnerName: "Supplier",
      text: "Liability",
      vatPeriod: "2026-08",
      taxMode: "taxable", classificationVAT: "PD",
      originalDocument: "Z-1",
      ...summary
    }, [], "liability", "Db");
    await client.createCashVoucher({
      type: "expense",
      cashAccount: "HLAVNI",
      date: "2026-08-05",
      dateTax: "2026-08-05",
      datePayment: "2026-08-05",
      text: "Cash expense",
      vatPeriod: "2026-08",
      taxMode: "taxable", classificationVAT: "PD",
      ...summary
    }, [], "expense", "Db");
    await client.createCashVoucher({
      type: "receipt",
      cashAccount: "HLAVNI",
      date: "2026-08-05",
      dateTax: "2026-08-05",
      text: "Cash receipt"
    }, item, "receipt", "Db");
    await client.createInternalDocument({
      date: "2026-08-05",
      dateTax: "2026-08-05",
      text: "Internal VAT document"
    }, item, "internal", "Db");

    expect(transport.calls[0]?.xml).toContain("<inv:dateTax>2026-08-05</inv:dateTax>");
    expect(transport.calls[0]?.xml).toContain("<inv:dateKHDPH>2026-08-05</inv:dateKHDPH>");
    // Late source DUZP (July) imported into August: all four dates move to the period start.
    expect(transport.calls[1]?.xml).toContain("<inv:date>2026-08-01</inv:date>");
    expect(transport.calls[1]?.xml).toContain("<inv:dateTax>2026-08-01</inv:dateTax>");
    expect(transport.calls[1]?.xml).toContain("<inv:dateAccounting>2026-08-01</inv:dateAccounting>");
    expect(transport.calls[1]?.xml).toContain("<inv:dateKHDPH>2026-08-01</inv:dateKHDPH>");
    expect(transport.calls[1]?.xml).toContain("Zdroj: doklad FA-2; vystaveno 2026-08-05; DUZP 2026-07-31");
    expect(transport.calls[2]?.xml).toContain("<inv:dateTax>2026-08-05</inv:dateTax>");
    expect(transport.calls[2]?.xml).not.toContain("<inv:dateKHDPH>");
    expect(transport.calls[3]?.xml).toContain("<inv:dateKHDPH>2026-08-05</inv:dateKHDPH>");
    expect(transport.calls[4]?.xml).toContain("<inv:dateKHDPH>2026-08-05</inv:dateKHDPH>");
    expect(transport.calls[5]?.xml).toContain("<vch:dateKHDPH>2026-08-05</vch:dateKHDPH>");
    expect(transport.calls[6]?.xml).not.toContain("<vch:dateKHDPH>");
    expect(transport.calls[7]?.xml).toContain("<int:dateKHDPH>2026-08-05</int:dateKHDPH>");
  });

  it("batches new voucher, liability, receivable, and activity operations in one dataPack", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await client.writeBatch([
      {
        requestId: "voucher",
        tool: "create_cash_voucher",
        header: { type: "expense", cashAccount: "HLAVNI", date: "2026-07-02", dateTax: "2026-07-02", datePayment: "2026-07-02", text: "Cash expense", vatPeriod: "2026-07", taxMode: "taxable", classificationVAT: "PD", priceHigh: 50, priceHighVAT: 10.5, total: 60.5 },
        items: []
      },
      {
        requestId: "liability",
        tool: "create_other_liability",
        header: { partnerName: "Supplier", date: "2026-07-02", dateTax: "2026-07-02", text: "Liability", vatPeriod: "2026-07", taxMode: "taxable", classificationVAT: "PD", originalDocument: "Z-7", priceHigh: 100, priceHighVAT: 21, total: 121 },
        items: []
      },
      {
        requestId: "receivable",
        tool: "create_other_receivable",
        header: { partnerName: "Customer", date: "2026-07-02", text: "Receivable" },
        items: [{ text: "Charge", unitPrice: 200, quantity: 1, vatRate: "none" }]
      },
      { requestId: "activity", tool: "manage_activity", action: "add", data: { code: "NEW", name: "New activity" } }
    ], "new-write-batch", "BatchDb");

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.database).toBe("BatchDb");
    expect(transport.calls[0]?.xml).toContain('note="voucher:create_cash_voucher"');
    expect(transport.calls[0]?.xml).toContain("<vch:voucher");
    expect(transport.calls[0]?.xml).toContain("<vch:voucherType>expense</vch:voucherType>");
    expect(transport.calls[0]?.xml).toContain("<vch:dateKHDPH>2026-07-02</vch:dateKHDPH>");
    expect(transport.calls[0]?.xml).toContain('note="liability:create_other_liability"');
    expect(transport.calls[0]?.xml).toContain("<inv:invoiceType>commitment</inv:invoiceType>");
    expect(transport.calls[0]?.xml).toContain("<inv:dateKHDPH>2026-07-02</inv:dateKHDPH>");
    expect(transport.calls[0]?.xml).toContain('note="receivable:create_other_receivable"');
    expect(transport.calls[0]?.xml).toContain("<inv:invoiceType>receivable</inv:invoiceType>");
    expect(transport.calls[0]?.xml).toContain('note="activity:manage_activity"');
    expect(transport.calls[0]?.xml).toContain("<acv:activity");
    expect(transport.calls[0]?.xml).toContain("<acv:code>NEW</acv:code>");
    expect(transport.calls[0]?.xml).not.toContain("<acv:actionType/>");
  });

  it("rejects activity update and delete without a numeric id before transport", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await expect(client.manageActivity("delete", {}, {}, "bad-activity", "Db"))
      .rejects.toThrow(/requires match.id or data.id/);
    expect(transport.calls).toHaveLength(0);
  });

  it("validates print output combinations and builds PDF/email options", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });

    expect(() => client.printRecord({ agenda: "vydane_faktury", reportId: 1, recordId: 7, printer: "HP", pdfPath: "C:\\x.pdf" }))
      .toThrow(/mutually exclusive/);

    await client.printRecord({
      agenda: "vydane_faktury",
      reportId: 1,
      recordId: 7,
      pdfPath: "C:\\x.pdf",
      pdfBase64: true,
      emailTo: "a@example.com;b@example.com",
      emailSubject: "Invoice",
      includeIsdoc: true,
      database: "PrintDb"
    });

    expect(transport.calls[0]?.database).toBe("PrintDb");
    expect(transport.calls[0]?.xml).toContain("<prn:binaryData>");
    expect(transport.calls[0]?.xml).toContain("<prn:sendMail>");
    expect(transport.calls[0]?.xml).toContain("<prn:isdoc>");
  });

  it("builds new native agenda XML with schema-shaped details", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await client.createSalesReceipt({
      type: "prodejka",
      date: "2026-07-02",
      text: "POS receipt",
      partnerName: "Retail Customer"
    }, [
      { text: "Retail item", quantity: 2, unit: "ks", unitPrice: 50, vatRate: "high", stockCode: "ITEM-1" }
    ], [
      { paymentType: "cash", received: 121, note: "Paid cash" }
    ], "sales-1", "SalesDb");
    await client.manageStorage({
      code: "SKLAD",
      idStore: 1,
      name: "Main store",
      note: "Top node",
      offerTo: true,
      subStorages: [{ code: "REGAL", name: "Shelf" }]
    }, "storage-1", "SetupDb");
    await client.listBalance({ dateTo: "2026-12-31", pairing: "PairingSymbolIC", limit: 10 }, "balance-1", "BalanceDb");

    expect(transport.calls[0]?.database).toBe("SalesDb");
    expect(transport.calls[0]?.xml).toContain("<pro:prodejka");
    expect(transport.calls[0]?.xml).toContain("<pro:prodejkaType>saleVoucher</pro:prodejkaType>");
    expect(transport.calls[0]?.xml).toContain("<pro:prodejkaPayments><pro:paymentItem>");
    expect(transport.calls[0]?.xml).toContain("<pro:paymentType><typ:paymentType>cash</typ:paymentType></pro:paymentType>");
    expect(transport.calls[0]?.xml).toContain("<pro:received>121</pro:received>");
    const paymentXml = transport.calls[0]?.xml.match(/<pro:prodejkaPayments>.*<\/pro:prodejkaPayments>/)?.[0] ?? "";
    expect(paymentXml).not.toContain("<pro:homeCurrency>");

    expect(transport.calls[1]?.database).toBe("SetupDb");
    expect(transport.calls[1]?.xml).toContain('<str:itemStorage code="SKLAD" idStore="1" name="Main store" note="Top node" offerTo="true">');
    expect(transport.calls[1]?.xml).toContain('<str:itemStorage code="REGAL" name="Shelf"/>');
    expect(transport.calls[1]?.xml).not.toContain("<str:idStore>");

    expect(transport.calls[2]?.database).toBe("BalanceDb");
    expect(transport.calls[2]?.options.checkDuplicity).toBe(false);
    expect(transport.calls[2]?.xml).toContain("<lst:listBalanceRequest");
    expect(transport.calls[2]?.xml).toContain('balanceVersion="2.0"');
    expect(transport.calls[2]?.xml).toContain("<lst:dateTo>2026-12-31</lst:dateTo>");
    expect(transport.calls[2]?.xml).toContain("<lst:pairing>PairingSymbolIC</lst:pairing>");
  });

  it("batches broad native agenda operations in one dataPack", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await client.writeBatch([
      {
        requestId: "bank",
        tool: "create_bank_document",
        header: { type: "receipt", account: "BANKA", datePayment: "2026-07-02", text: "Bank receipt" },
        items: [{ text: "Bank item", quantity: 1, unitPrice: 100, vatRate: "none" }]
      },
      {
        requestId: "internal",
        tool: "create_internal_document",
        header: { date: "2026-07-02", text: "Internal" },
        items: [{ text: "Internal item", quantity: 1, unitPrice: 100, vatRate: "none" }]
      },
      {
        requestId: "receipt",
        tool: "create_stock_receipt",
        header: { date: "2026-07-02", text: "Stock receipt" },
        items: [{ text: "Stock item", quantity: 1, unitPrice: 100, vatRate: "high", stockCode: "STOCK-1" }]
      },
      { requestId: "centre", tool: "manage_centre", action: "add", data: { code: "C1", name: "Centre 1" } },
      { requestId: "group", tool: "manage_group_stock", action: "add", data: { code: "G1", name: "Group 1" }, variants: [{ stockCode: "STOCK-1", name: "Variant" }] }
    ], "broad-batch", "BatchDb");

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.database).toBe("BatchDb");
    expect(transport.calls[0]?.xml).toContain('note="bank:create_bank_document"');
    expect(transport.calls[0]?.xml).toContain("<bnk:bank");
    expect(transport.calls[0]?.xml).toContain('note="internal:create_internal_document"');
    expect(transport.calls[0]?.xml).toContain("<int:intDoc");
    expect(transport.calls[0]?.xml).toContain('note="receipt:create_stock_receipt"');
    expect(transport.calls[0]?.xml).toContain("<pri:prijemka");
    expect(transport.calls[0]?.xml).toContain('note="centre:manage_centre"');
    expect(transport.calls[0]?.xml).toContain("<cen:centre");
    expect(transport.calls[0]?.xml).toContain('note="group:manage_group_stock"');
    expect(transport.calls[0]?.xml).toContain("<grs:groupStocks");
  });

  it("keeps schema-sensitive setup and stock movement tools narrow", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await client.createStockTransfer({
      date: "2026-07-02",
      text: "Transfer",
      store: "SKLAD"
    }, [
      { text: "Ignored by schema", quantity: 2, unit: "ks", unitPrice: 100, vatRate: "high", stockCode: "STOCK-1" }
    ], "transfer-1", "Db");
    await client.createProductionDocument({
      date: "2026-07-02",
      text: "Production"
    }, [
      { quantity: 1, stockCode: "PRODUCT-1", note: "Make one" }
    ], "production-1", "Db");
    await client.createOffer({
      type: "issuedOffer",
      date: "2026-07-02",
      dateTax: "2026-07-02",
      dateAccounting: "2026-07-02",
      validTill: "2026-08-02",
      partnerName: "Offer partner",
      text: "Offer"
    }, [
      { text: "Offer item", quantity: 1, unit: "ks", unitPrice: 100, vatRate: "none" }
    ], "offer-1", "Db");
    await client.createEnquiry({
      type: "issuedEnquiry",
      date: "2026-07-02",
      dateTax: "2026-07-02",
      dateAccounting: "2026-07-02",
      validTill: "2026-08-02",
      partnerName: "Enquiry partner",
      text: "Enquiry"
    }, [
      { text: "Enquiry item", quantity: 1, unit: "ks", unitPrice: 100, vatRate: "none" }
    ], "enquiry-1", "Db");
    await client.manageStore({
      name: "S1",
      text: "Store 1",
      usePLU: true,
      lowerLimit: 1,
      upperLimit: 999
    }, "store-1", "Db");
    await client.manageBankAccount("add", {
      ids: "BANK1",
      numberAccount: "123456789",
      codeBank: "0100",
      nameBank: "Bank"
    }, {}, "bank-account-1", "Db");
    await client.manageParameterDefinition({
      idsAgenda: "addressbook",
      formParameters: [{ label: "Custom", name: "Custom", type: "text", length: 32 }],
      userCode: "function test() {}"
    }, "parameter-1", "Db");

    const transferXml = transport.calls[0]?.xml ?? "";
    expect(transferXml).toContain("<pre:prevodka");
    expect(transferXml).toContain("<pre:quantity>2</pre:quantity>");
    expect(transferXml).toContain("<pre:stockItem><typ:stockItem><typ:ids>STOCK-1</typ:ids></typ:stockItem></pre:stockItem>");
    expect(transferXml).not.toContain("<pre:text>Ignored by schema</pre:text>");
    expect(transferXml).not.toContain("<pre:homeCurrency>");
    expect(transferXml).not.toContain("<pre:rateVAT>");
    expect(transferXml).not.toContain("<pre:validate");
    expect(transferXml).not.toContain("<pre:link");

    const productionXml = transport.calls[1]?.xml ?? "";
    expect(productionXml).toContain("<vyr:vyroba");
    expect(productionXml).toContain("<vyr:quantity>1</vyr:quantity>");
    expect(productionXml).toContain("<vyr:stockItem><typ:stockItem><typ:ids>PRODUCT-1</typ:ids></typ:stockItem></vyr:stockItem>");
    expect(productionXml).not.toContain("<vyr:homeCurrency>");
    expect(productionXml).not.toContain("<vyr:rateVAT>");
    expect(productionXml).not.toContain("<vyr:link");
    expect(productionXml).not.toContain("<vyr:linkedDocument");

    const offerXml = transport.calls[2]?.xml ?? "";
    expect(offerXml).toContain("<ofr:validTill>2026-08-02</ofr:validTill>");
    expect(offerXml).not.toContain("<ofr:dateTax>");
    expect(offerXml).not.toContain("<ofr:dateAccounting>");
    expect(offerXml).not.toContain("<ofr:MOSS");
    expect(offerXml).not.toContain("<ofr:evidentiaryResourcesMOSS");

    const enquiryXml = transport.calls[3]?.xml ?? "";
    expect(enquiryXml).toContain("<enq:validTill>2026-08-02</enq:validTill>");
    expect(enquiryXml).not.toContain("<enq:dateTax>");
    expect(enquiryXml).not.toContain("<enq:dateAccounting>");
    expect(enquiryXml).not.toContain("<enq:paymentType>");
    expect(enquiryXml).not.toContain("<enq:MOSS");
    expect(enquiryXml).not.toContain("<enq:evidentiaryResourcesMOSS");

    const storeXml = transport.calls[4]?.xml ?? "";
    expect(storeXml).toContain("<sto:PLU><sto:usePLU>true</sto:usePLU><sto:lowerLimit>1</sto:lowerLimit><sto:upperLimit>999</sto:upperLimit></sto:PLU>");
    expect(storeXml).not.toContain("PLUsettings");

    const bankAccountXml = transport.calls[5]?.xml ?? "";
    expect(bankAccountXml).toContain("<bka:bankAccount");
    expect(bankAccountXml).toContain("<bka:ids>BANK1</bka:ids>");
    expect(bankAccountXml).not.toContain("<bka:actionType>");

    const parameterXml = transport.calls[6]?.xml ?? "";
    expect(parameterXml).toContain('<prm:parameter version="2.0" idsAgenda="addressbook">');
    expect(parameterXml).toContain("<prm:parameterDef>");
    expect(parameterXml).toContain("<prm:userCode>function test() {}</prm:userCode>");
    expect(parameterXml).not.toContain("<prm:parameter>");
    expect(parameterXml).not.toContain("<prm:defaultValue>");
  });

  it("rejects schema-required setup fields before transport", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Default" });

    await expect(client.manageStorage({ name: "Missing code" }, "bad-storage", "Db"))
      .rejects.toThrow(/manage_storage itemStorage requires code/);
    await expect(client.manageGroupStock("add", { code: "G1" }, [], {}, "bad-group", "Db"))
      .rejects.toThrow(/manage_group_stock add requires name/);
    await expect(client.manageBankAccount("add", { ids: "BANK" }, {}, "bad-bank", "Db"))
      .rejects.toThrow(/manage_bank_account add requires numberAccount, codeBank/);
    expect(transport.calls).toHaveLength(0);
  });

  it("builds summary-only expense XML with exact buckets, rounding, numbering, and typed classification", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });

    await client.createInvoice({
      type: "receivedInvoice",
      text: "Material",
      vatPeriod: "2026-08",
      taxMode: "taxable",
      date: "2026-08-03",
      dateKHDPH: "2026-08-02",
      originalDocument: "FA-2026-17",
      symVar: "202617",
      number: "26PF0005",
      numberSeries: "26PF",
      numberSeriesId: 73,
      classificationVAT: "UD",
      partnerName: "Dodavatel s.r.o.",
      partnerIco: "12345679",
      partnerDic: "CZ12345679",
      partnerCountry: "CZ",
      partnerExtId: "SUP-1",
      partnerExtSystemName: "registry",
      priceNone: "10",
      priceLow: 100,
      priceLowVAT: 12,
      priceHigh: 0.1 + 0.2,
      priceHighVAT: 0.06,
      roundingAmount: -0.36,
      total: 122
    }, [], "expense-summary", "Db");

    const xml = transport.calls[0]?.xml ?? "";
    expect(xml).not.toContain("<inv:invoiceDetail>");
    expect(xml).toContain('<inv:number><typ:numberRequested checkDuplicity="true">26PF0005</typ:numberRequested></inv:number>');
    expect(xml).toContain("<inv:originalDocument>FA-2026-17</inv:originalDocument>");
    expect(xml).toContain("<inv:symVar>202617</inv:symVar>");
    expect(xml).toContain("<inv:classificationVAT><typ:ids>UD</typ:ids></inv:classificationVAT>");
    expect(xml).toContain("<inv:dateTax>2026-08-02</inv:dateTax>");
    expect(xml).toContain("<inv:dateKHDPH>2026-08-02</inv:dateKHDPH>");
    expect(xml).toContain("<typ:extId><typ:ids>SUP-1</typ:ids><typ:exSystemName>registry</typ:exSystemName></typ:extId>");
    expect(xml).toContain("<typ:dic>CZ12345679</typ:dic>");
    expect(xml).toContain("<typ:country><typ:ids>CZ</typ:ids></typ:country>");
    expect(xml).toContain("<inv:invoiceSummary><inv:roundingDocument>math2one</inv:roundingDocument><inv:roundingVAT>none</inv:roundingVAT><inv:calculateVAT>false</inv:calculateVAT><inv:homeCurrency><typ:priceNone>10</typ:priceNone><typ:priceLow>100</typ:priceLow><typ:priceLowVAT>12</typ:priceLowVAT><typ:priceLowSum>112</typ:priceLowSum><typ:priceHigh>0.3</typ:priceHigh><typ:priceHighVAT>0.06</typ:priceHighVAT><typ:priceHighSum>0.36</typ:priceHighSum><typ:round><typ:priceRound>-0.36</typ:priceRound></typ:round></inv:homeCurrency></inv:invoiceSummary>");
    expect(xml).not.toContain("vatPeriod");
    expect(xml).not.toContain("_expensePolicy");
  });

  it("keeps inland/nonSubsume as classification enum and other codes as ids", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    await client.createInvoice({ type: "issuedInvoice", partnerName: "Customer", classificationVAT: "inland" }, [
      { text: "A", unitPrice: 1, classificationVAT: "UD" }
    ], "classification", "Db");
    const xml = transport.calls[0]?.xml ?? "";
    expect(xml).toContain("<inv:classificationVAT><typ:classificationVATType>inland</typ:classificationVATType></inv:classificationVAT>");
    expect(xml).toContain("<inv:classificationVAT><typ:ids>UD</typ:ids></inv:classificationVAT>");
  });

  it("rejects items and invalid expense headers before transport", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    const base = { type: "receivedInvoice", text: "X", vatPeriod: "2026-08", taxMode: "taxable", classificationVAT: "PD", date: "2026-08-03", dateKHDPH: "2026-08-03", originalDocument: "F1", priceHigh: 100, priceHighVAT: 21, total: 121 };

    await expect(client.createInvoice(base, [{ text: "Item", unitPrice: 100 }], "bad-1", "Db")).rejects.toThrow(/ITEMS_NOT_ALLOWED/);
    await expect(client.createInvoice({ ...base, total: 120 }, [], "bad-2", "Db")).rejects.toThrow(/SUMMARY_MISMATCH/);
    await expect(client.createOtherLiability({ ...base, vatPeriod: "" }, [], "bad-3", "Db")).rejects.toThrow(/VAT_PERIOD_REQUIRED/);
    await expect(client.createCashVoucher({ ...base, type: "expense", cashAccount: "HL", text: "" }, [], "bad-4", "Db")).rejects.toThrow(/TEXT_REQUIRED/);
    await expect(client.writeBatch([{ tool: "create_other_liability", header: { ...base, priceHighVAT: 21.001 }, items: [] }], "bad-5", "Db")).rejects.toThrow(/AMOUNT_PRECISION/);
    expect(transport.calls).toHaveLength(0);
  });

  it("builds small and large card commitments with K/VS from the PK sequence", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    const card = { text: "Card purchase", vatPeriod: "2026-08", taxMode: "taxable", classificationVAT: "PD", date: "2026-08-10", dateKHDPH: "2026-08-10", cardPayment: true, numberSeries: "PK26" };

    await client.createOtherLiability({ ...card, number: "PK26007", cardSequence: 7, originalDocument: "UCT-55", priceHigh: 1000, priceHighVAT: 210, total: 1210 }, [], "card-small", "Db");
    await client.createOtherLiability({ ...card, number: "PK26008", cardSequence: 8, originalDocument: "FA-900", symVar: "900", priceHigh: 10000, priceHighVAT: 2100, total: 12100 }, [], "card-large", "Db");
    await expect(client.createOtherLiability({ ...card, cardSequence: 9, paymentType: "cash", originalDocument: "X", priceHigh: 1, priceHighVAT: 0.21, total: 1.21 }, [], "card-cash", "Db"))
      .rejects.toThrow(/CARD_PAYMENT_TYPE_CONFLICT/);

    const small = transport.calls[0]?.xml ?? "";
    expect(small).toContain("<inv:invoiceType>commitment</inv:invoiceType>");
    expect(small).toContain('<inv:number><typ:numberRequested checkDuplicity="true">PK26007</typ:numberRequested></inv:number>');
    expect(small).toContain("<inv:originalDocument>K7</inv:originalDocument>");
    expect(small).toContain("<inv:symVar>7</inv:symVar>");
    expect(small).toContain("<inv:paymentType><typ:paymentType>creditcard</typ:paymentType></inv:paymentType>");
    expect(small).toContain("Zdroj: doklad UCT-55");
    const large = transport.calls[1]?.xml ?? "";
    expect(large).toContain("<inv:originalDocument>FA-900</inv:originalDocument>");
    expect(large).toContain("<inv:symVar>900</inv:symVar>");
    expect(large).not.toContain("Zdroj:");
  });

  it("applies the cash expense originalDocument threshold on the final payable and leaves receipts alone", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    const expense = { type: "expense", cashAccount: "HL", text: "Cash", vatPeriod: "2026-08", taxMode: "taxable", classificationVAT: "PD", date: "2026-08-04", dateKHDPH: "2026-08-04", datePayment: "2026-08-05", originalDocument: "UCT-1" };

    await client.createCashVoucher({ ...expense, priceHigh: 8264.46, priceHighVAT: 1735.54, roundingAmount: 0, total: 10000 }, [], "cash-small", "Db");
    await client.createCashVoucher({ ...expense, priceHigh: 8264.88, priceHighVAT: 1735.62, roundingAmount: -0.5, total: 10000 }, [], "cash-rounded", "Db");
    await client.createCashVoucher({ ...expense, priceHigh: 8265.29, priceHighVAT: 1735.71, total: 10001 }, [], "cash-large", "Db");
    await client.createCashVoucher({ type: "receipt", cashAccount: "HL", date: "2026-08-04", text: "Receipt", originalDocument: "R-1" }, [
      { text: "Sale", unitPrice: 1, vatRate: "none" }
    ], "cash-receipt", "Db");

    for (const call of transport.calls.slice(0, 2)) {
      expect(call.xml).not.toContain("<vch:originalDocument>");
      expect(call.xml).toContain("Zdroj: doklad UCT-1; vystaveno 2026-08-04; DUZP 2026-08-04; uhrazeno 2026-08-05");
      expect(call.xml).toContain("<vch:datePayment>2026-08-05</vch:datePayment>");
      expect(call.xml).not.toContain("<vch:voucherDetail>");
    }
    expect(transport.calls[1]?.xml).toContain("<typ:round><typ:priceRound>-0.5</typ:priceRound></typ:round>");
    expect(transport.calls[2]?.xml).toContain("<vch:originalDocument>UCT-1</vch:originalDocument>");
    expect(transport.calls[3]?.xml).toContain("<vch:originalDocument>R-1</vch:originalDocument>");
    expect(transport.calls[3]?.xml).toContain("<vch:voucherDetail>");
  });

  it("emits foreign summaries without a forced exchange rate and blocks unexpressible foreign VAT", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    const foreign = { type: "receivedInvoice", text: "EU service", vatPeriod: "2026-08", taxMode: "nonTax", date: "2026-08-04", originalDocument: "INV-77", currency: "EUR" };

    await client.createInvoice({ ...foreign, priceNone: 120, total: 120 }, [], "fx-default-rate", "Db");
    await client.createInvoice({ ...foreign, priceNone: 120, total: 120, currencyRate: 24.5, currencyAmount: 1 }, [], "fx-explicit", "Db");
    await client.createInvoice({ type: "issuedInvoice", partnerName: "Customer", currency: "EUR" }, [{ text: "A", unitPrice: 1 }], "fx-issued", "Db");
    await expect(client.createInvoice({ ...foreign, taxMode: "taxable", classificationVAT: "PD", dateKHDPH: "2026-08-04", priceHigh: 100, priceHighVAT: 21, total: 121 }, [], "fx-vat", "Db"))
      .rejects.toThrow(/FOREIGN_TAXABLE_SPLIT_UNSUPPORTED/);

    const defaultRate = transport.calls[0]?.xml ?? "";
    expect(defaultRate).toContain("<inv:invoiceSummary><inv:roundingDocument>none</inv:roundingDocument><inv:roundingVAT>none</inv:roundingVAT><inv:calculateVAT>false</inv:calculateVAT><inv:foreignCurrency><typ:currency><typ:ids>EUR</typ:ids></typ:currency><typ:priceSum>120</typ:priceSum></inv:foreignCurrency></inv:invoiceSummary>");
    expect(defaultRate).not.toContain("<typ:rate>");
    expect(defaultRate).not.toContain("<inv:homeCurrency>");
    expect(defaultRate).toContain("<inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>");
    expect(defaultRate).not.toContain("<inv:dateKHDPH>");
    expect(transport.calls[1]?.xml).toContain("<typ:rate>24.5</typ:rate><typ:amount>1</typ:amount>");
    expect(transport.calls[2]?.xml).not.toContain("<typ:rate>");
    expect(transport.calls[2]?.xml).not.toContain("<typ:amount>");
  });

  it("builds flag-only, guarded-add, and identity-safe address operations", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });

    await client.manageAddress("update", { p1: true }, { id: 7 }, "p1-only", "Db");
    await client.manageAddress("add", { company: "Dodavatel", ico: "12345679", dic: "CZ12345679", country: "CZ", p1: true, intNote: "ARES" }, { ico: "12345679" }, "guarded-add", "Db");
    await client.manageAddress("update", { company: "New name", ico: "99999999" }, { id: 8 }, "update", "Db");
    await expect(client.manageAddress("update", { company: "No match", ico: "11111111" }, {}, "no-match", "Db")).rejects.toThrow(/requires a match/);

    const flagOnly = transport.calls[0]?.xml ?? "";
    expect(flagOnly).toContain("<adb:update><ftr:filter><ftr:id>7</ftr:id></ftr:filter></adb:update>");
    expect(flagOnly).toContain("<adb:addressbookHeader><adb:p1>true</adb:p1></adb:addressbookHeader>");
    expect(flagOnly).not.toContain("adb:identity");
    const add = transport.calls[1]?.xml ?? "";
    expect(add).toContain('<adb:actionType><adb:add update="false" add="true"><ftr:filter><ftr:ico>12345679</ftr:ico></ftr:filter></adb:add></adb:actionType>');
    expect(add).toContain("<typ:dic>CZ12345679</typ:dic>");
    expect(add).toContain("<typ:country><typ:ids>CZ</typ:ids></typ:country>");
    expect(add).toContain("<adb:p1>true</adb:p1>");
    expect(add).toContain("<adb:intNote>ARES</adb:intNote>");
    const update = transport.calls[2]?.xml ?? "";
    expect(update).toContain("<adb:update><ftr:filter><ftr:id>8</ftr:id></ftr:filter></adb:update>");
    expect(update).not.toContain("<ftr:ico>99999999</ftr:ico>");
    expect(transport.calls).toHaveLength(3);
  });
  it("links the archived source PDF in invoice and cash document attachment blocks", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    const path = String.raw`C:\Účetnictví\PDF DOKLADY KLIENTŮ Z POHODY\test.pdf`;
    const header = { text: "PDF source", vatPeriod: "2026-11", taxMode: "nonTax", date: "2026-11-02", datePayment: "2026-11-02", priceNone: 100, total: 100, sourcePdfArchivePath: path };
    await client.createInvoice({ ...header, type: "receivedInvoice" }, [], "pdf-invoice", "Db");
    await client.createCashVoucher({ ...header, type: "expense", cashAccount: "HP" }, [], "pdf-cash", "Db");
    expect(transport.calls[0]?.xml).toContain(`<inv:attachments><typ:shortcut><typ:target>${path}</typ:target></typ:shortcut></inv:attachments>`);
    expect(transport.calls[1]?.xml).toContain(`<vch:attachments><typ:shortcut><typ:target>${path}</typ:target></typ:shortcut></vch:attachments>`);
    expect(transport.calls[0]?.xml).not.toContain("typ:companyDocumentsFolder");
    expect(transport.calls[1]?.xml).not.toContain("typ:file");
  });

});

describe('typed bank liquidation imports', () => {
  it('writes an explicit target link and derives the padded statement month on single and batch paths', async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: '12345678', database: 'Default' });
    const header = { type: 'expense', account: '', bankAccount: 'KB', statementPeriod: '2026-01', statementNumber: 'wrong', numberMovement: '5', dateStatement: '2026-01-31', datePayment: '2026-01-20', liquidations: [{ agenda: 'receivedInvoice', id: 42, amount: '12.34' }] };
    await client.createBankDocument(header, [], 'bank-settle-single', 'Db');
    await client.writeBatch([{ tool: 'create_bank_document', header, items: [] }], 'bank-settle-batch', 'Db');
    for (const call of transport.calls) {
      expect(call.xml).toContain('<bnk:account><typ:ids>KB</typ:ids></bnk:account>');
      expect(call.xml).toContain('<bnk:statementNumber>001</bnk:statementNumber>');
      expect(call.xml).toContain('<bnk:numberMovement>5</bnk:numberMovement>');
      expect(call.xml).toContain('<bnk:sourceAgenda>receivedInvoice</bnk:sourceAgenda>');
      expect(call.xml).toContain('<bnk:sourceDocument><typ:id>42</typ:id></bnk:sourceDocument>');
      expect(call.xml).toContain('<bnk:liquidationPrice>12.34</bnk:liquidationPrice>');
      expect(call.xml).toContain('<bnk:quantity>1</bnk:quantity>');
      expect(call.xml).not.toContain('<bnk:bankItem>');
    }
  });
  it('uses the bank-account rate mode enum rather than writing a numeric exchange rate', async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: '12345678', database: 'Default' });
    await client.manageBankAccount('add', { ids: 'EUR', numberAccount: '123', codeBank: '0100', currency: 'EUR', rateType: 'daily' }, {}, 'fx-account', 'Db');
    expect(transport.calls[0]!.xml).toContain('<bka:rate>daily</bka:rate>');
    expect(transport.calls[0]!.xml).not.toContain('<bka:rate>1</bka:rate>');
  });
  it('rejects liquidation mixed with ordinary items before transport', async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: '12345678', database: 'Default' });
    await expect(client.createBankDocument({ account: 'KB', liquidations: [{ agenda: 'receivedInvoice', id: 42, amount: 100 }] }, [{ unitPrice: 100 }])).rejects.toThrow(/ordinary items/);
    expect(transport.calls).toHaveLength(0);
  });
});
