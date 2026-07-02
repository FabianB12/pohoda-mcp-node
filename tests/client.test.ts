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
});
