import { describe, expect, it } from "vitest";
import { PohodaClient } from "../src/pohoda/client.js";
import type { CliXmlJobResult, XmlTransport } from "../src/pohoda/transport.js";

/** Received-invoice VS derivation on the direct create and batch XML paths (no live POHODA). */
class FakeTransport implements XmlTransport {
  public calls: string[] = [];
  async exchange(xml: string, database: string): Promise<CliXmlJobResult> {
    this.calls.push(xml);
    return { xml: '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"/></rsp:responsePack>', jobId: "job", database, jobDir: "/tmp/job", queueWaitMs: 0, processSlotWaitMs: 0, durationMs: 1, exitCode: 0, jobRetained: false };
  }
  status(): Record<string, unknown> { return { transport: "fake" }; }
}

const received = (extra: Record<string, any> = {}) => ({
  type: "receivedInvoice", partnerName: "Supplier", text: "Material", vatPeriod: "2026-11", taxMode: "taxable", classificationVAT: "PD",
  date: "2026-11-03", dateKHDPH: "2026-11-03", originalDocument: "FV-2026/0007", priceHigh: 100, priceHighVAT: 21, total: 121, ...extra
});
const symVars = (xml: string) => [...xml.matchAll(/<inv:symVar>([^<]*)<\/inv:symVar>/g)].map((m) => m[1]);

describe("received invoice VS in generated XML", () => {
  it("derives a missing VS on single create and keeps the original supplier number", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    await client.createInvoice(received({ number: "FP260001" }), []);
    expect(symVars(transport.calls[0]!)).toEqual(["20260007"]);
    expect(transport.calls[0]).toContain("<inv:originalDocument>FV-2026/0007</inv:originalDocument>");
  });

  it("applies the same rule per document in a batch without touching explicit VS or other liabilities", async () => {
    const transport = new FakeTransport();
    const client = new PohodaClient({ transport, ico: "12345678", database: "Db" });
    await client.createInvoiceBatch([
      { requestId: "derived", header: received(), items: [] },
      { requestId: "explicit", header: received({ symVar: "0042" }), items: [] },
      { requestId: "liability", header: received({ type: "commitment", originalDocument: "NP-2026/9" }), items: [] },
      { requestId: "nodigits", header: received({ originalDocument: "ABC" }), items: [] }
    ], "symvar-batch");
    expect(transport.calls).toHaveLength(1);
    expect(symVars(transport.calls[0]!)).toEqual(["20260007", "0042"]);
  });
});
