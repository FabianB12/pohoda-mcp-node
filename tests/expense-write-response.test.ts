import { describe, expect, it } from "vitest";
import { classifyExpenseWriteResponse } from "../src/mcp/expense-write-response.js";
import { PohodaResponse } from "../src/pohoda/response.js";

const row = (n: number, id: string, state = "ok") => `<rsp:responsePackItem id="pack-${n}" state="ok"><inv:invoiceResponse state="${state}"><inv:producedDetails><inv:id>${id}</inv:id></inv:producedDetails></inv:invoiceResponse></rsp:responsePackItem>`;
const parse = (body: string, state = "ok", transport = {}) => new PohodaResponse(`<rsp:responsePack xmlns:rsp="urn:response" xmlns:inv="urn:invoice" state="${state}">${body}</rsp:responsePack>`, transport);

describe("expense write response identity and certainty", () => {
  it("maps reordered items by identity and preserves a missing middle item as uncertain", () => {
    const outcomes = classifyExpenseWriteResponse(parse(row(3, "13") + row(1, "11")), "pack", 3);
    expect(outcomes.map(o => [o.outcome, o.id])).toEqual([["created", 11], ["missing", undefined], ["created", 13]]);
  });
  it("distinguishes nested rejection from conflicting created ID and malformed IDs", () => {
    const outcomes = classifyExpenseWriteResponse(parse(row(1, "0", "error") + row(2, "12", "error") + row(3, "oops", "error")), "pack", 3);
    expect(outcomes.map(o => o.outcome)).toEqual(["rejected", "conflict", "missing"]);
  });
  it("does not assign duplicate, absent or unrelated response IDs", () => {
    const outcomes = classifyExpenseWriteResponse(parse(row(1, "11") + row(1, "12") + row(8, "18")), "pack", 2);
    expect(outcomes.map(o => o.outcome)).toEqual(["missing", "missing"]);
  });
  it("only calls a pack refusal definite with a parsed rejection outcome", () => {
    expect(classifyExpenseWriteResponse(parse("", "error", { responseOutcome: "rejected" }), "pack", 1)[0]?.outcome).toBe("rejected");
    expect(classifyExpenseWriteResponse(new PohodaResponse("broken"), "pack", 1)[0]?.outcome).toBe("missing");
  });
});
