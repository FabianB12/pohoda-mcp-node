import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { XmlBuilder } from "../src/pohoda/xml-builder.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true });

describe("XmlBuilder", () => {
  const builder = new XmlBuilder("12345678", "Test");

  it("produces a Windows-1250 dataPack with ICO and application", () => {
    const xml = builder.build("inv:invoice", "2.0", {
      "inv:invoiceHeader": { "inv:invoiceType": "issuedInvoice" }
    }, "create", {}, "invoice-001");

    expect(xml).toContain('<?xml version="1.0" encoding="Windows-1250"?>');
    expect(xml).toContain('ico="12345678"');
    expect(xml).toContain('application="Test"');
    expect(xml).toContain('id="invoice-001"');
    expect(parser.parse(xml).dataPack.dataPackItem.invoice.invoiceHeader.invoiceType).toBe("issuedInvoice");
  });

  it("writes nested data, attributes, booleans, numeric array wrappers, and escapes XML text", () => {
    const xml = builder.build("prn:print", "1.0", {
      "prn:record": {
        "@agenda": "vydane_faktury",
        "ftr:filter": { "ftr:id": 42 }
      },
      "prn:printerSettings": {
        "prn:parameters": [
          { "prn:checkbox1": true },
          { "prn:date1": "2026-07-01" }
        ],
        "prn:note": 'A & B < "C"'
      }
    }, "", {}, "print-001");

    expect(xml).toContain('agenda="vydane_faktury"');
    expect(xml).toContain("<prn:checkbox1>true</prn:checkbox1>");
    expect(xml).toContain("<prn:date1>2026-07-01</prn:date1>");
    expect(xml).toContain("A &amp; B &lt; &quot;C&quot;");
  });

  it("skips null, undefined, and empty string values while keeping false and zero", () => {
    const xml = builder.build("stk:stock", "2.0", {
      "stk:stockHeader": {
        "stk:name": "",
        "stk:EAN": undefined,
        "stk:note": null,
        "stk:isInternet": false,
        "stk:PLU": 0
      }
    }, "", {}, "stock-001");

    expect(xml).not.toContain("<stk:name>");
    expect(xml).not.toContain("<stk:EAN>");
    expect(xml).not.toContain("<stk:note>");
    expect(xml).toContain("<stk:isInternet>false</stk:isInternet>");
    expect(xml).toContain("<stk:PLU>0</stk:PLU>");
  });

  it("builds structured multi-item dataPacks with stable item ids", () => {
    const xml = builder.buildMany([
      {
        rootElement: "lStk:listStockRequest",
        version: "2.0",
        data: { "lStk:requestStock": {} },
        rootAttrs: { stockVersion: "2.0" },
        note: "stock"
      },
      {
        rootElement: "lAdb:listAddressBookRequest",
        version: "2.0",
        data: { "lAdb:requestAddressBook": {} },
        rootAttrs: { addressBookVersion: "2.0" },
        note: "contacts"
      }
    ], "batch", "batch-001");

    expect(xml).toContain('id="batch-001-1"');
    expect(xml).toContain('note="stock"');
    expect(xml).toContain('stockVersion="2.0"');
    expect(xml).toContain('id="batch-001-2"');
    expect(xml).toContain('addressBookVersion="2.0"');
  });

  it("builds raw multi-item dataPacks with all common namespaces", () => {
    const xml = builder.buildRawMany([
      '<acu:listAccountingUnitRequest version="1.6"/>',
      '<lst:listStoreRequest version="2.0" storeVersion="2.0"><lst:requestStore/></lst:listStoreRequest>'
    ], "raw", "raw-001");

    expect(xml).toContain('xmlns:acu="http://www.stormware.cz/schema/version_2/accountingunit.xsd"');
    expect(xml).toContain('<dat:dataPackItem id="raw-001-1" version="2.0"><acu:listAccountingUnitRequest version="1.6"/></dat:dataPackItem>');
    expect(xml).toContain('<dat:dataPackItem id="raw-001-2" version="2.0"><lst:listStoreRequest');
  });

  it("rejects invalid stable dataPack ids", () => {
    expect(() => builder.build("inv:invoice", "2.0", {}, "", {}, "bad id with spaces")).toThrow(/dataPackId/);
  });
});
