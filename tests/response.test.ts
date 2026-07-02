import { describe, expect, it } from "vitest";
import { PohodaResponse } from "../src/pohoda/response.js";

describe("PohodaResponse", () => {
  it("treats non-XML as an error response", () => {
    const response = new PohodaResponse("not xml");
    expect(response.state).toBe("error");
    expect(response.items).toEqual([]);
    expect(response.isOk()).toBe(false);
  });

  it("parses ok response attributes and transport metadata", () => {
    const xml = '<?xml version="1.0" encoding="Windows-1250"?>'
      + '<rsp:responsePack version="2.0" id="t1" state="ok" programVersion="12345" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd">'
      + '<rsp:responsePackItem version="2.0" id="item01" state="ok" />'
      + "</rsp:responsePack>";

    const response = new PohodaResponse(xml, { jobId: "job-1", queueWaitMs: 10 });
    expect(response.isOk()).toBe(true);
    expect(response.programVersion).toBe("12345");
    expect(response.toArray().transport.jobId).toBe("job-1");
    expect(response.items[0]?.id).toBe("item01");
    expect(response.items[0]?.attributes.version).toBe("2.0");
  });

  it("makes root ok responses fail when any item failed and preserves import details", () => {
    const xml = '<?xml version="1.0" encoding="Windows-1250"?>'
      + '<rsp:responsePack version="2.0" id="t1" state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd">'
      + '<rsp:responsePackItem version="2.0" id="i1" state="error">'
      + '<rsp:note>Import failed</rsp:note>'
      + '<rsp:importDetails><rsp:detail><rsp:state>error</rsp:state><rsp:errno>123</rsp:errno><rsp:note>Missing field</rsp:note></rsp:detail></rsp:importDetails>'
      + '</rsp:responsePackItem>'
      + '</rsp:responsePack>';

    const response = new PohodaResponse(xml);
    expect(response.isOk()).toBe(false);
    expect(response.items[0]?.data.note).toBe("Import failed");
    expect(response.items[0]?.data.importDetails.detail.errno).toBe("123");
  });

  it("treats nested agenda response errors as failed items", () => {
    const xml = '<?xml version="1.0" encoding="Windows-1250"?>'
      + '<rsp:responsePack version="2.0" id="t1" state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:str="http://www.stormware.cz/schema/version_2/storage.xsd" xmlns:rdc="http://www.stormware.cz/schema/version_2/documentresponse.xsd">'
      + '<rsp:responsePackItem version="2.0" id="storage" state="ok">'
      + '<str:storageResponse version="2.0" state="error">'
      + '<rdc:importDetails><rdc:detail><rdc:state>error</rdc:state><rdc:note>Nested failure</rdc:note></rdc:detail></rdc:importDetails>'
      + '</str:storageResponse>'
      + '</rsp:responsePackItem>'
      + '</rsp:responsePack>';

    const response = new PohodaResponse(xml);
    expect(response.items[0]?.isOk()).toBe(false);
    expect(response.isOk()).toBe(false);
  });

  it("parses primary list payloads without wrapping them under responsePackItem", () => {
    const xml = '<?xml version="1.0" encoding="Windows-1250"?>'
      + '<rsp:responsePack version="2.0" id="t1" state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd">'
      + '<rsp:responsePackItem version="2.0" id="i1" state="ok">'
      + '<lst:listInvoice version="2.0" state="ok">'
      + '<lst:invoice version="2.0"><inv:invoiceHeader><inv:id>1</inv:id></inv:invoiceHeader></lst:invoice>'
      + '<lst:invoice version="2.0"><inv:invoiceHeader><inv:id>2</inv:id></inv:invoiceHeader></lst:invoice>'
      + '</lst:listInvoice>'
      + '</rsp:responsePackItem>'
      + '</rsp:responsePack>';

    const response = new PohodaResponse(xml);
    expect(response.items[0]?.data.invoice).toHaveLength(2);
    expect(response.items[0]?.data.invoice[1].invoiceHeader.id).toBe("2");
  });
});
