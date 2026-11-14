import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { POHODA_GUIDE_URI, POHODA_SERVER_INSTRUCTIONS, POHODA_USAGE_GUIDE } from "../src/mcp/guide.js";

describe("Canonical MCP operator guide", () => {
  it("delivers concise startup instructions and identical resource/tool guides over the real stdio entry point", async () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const dir = await mkdtemp(join(tmpdir(), "pohoda-guide-"));
    const client = new Client({ name: "guide-protocol-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(root, "src/index.ts")],
      cwd: root,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        POHODA_EXE_PATH: join(dir, "no-pohoda-executable"),
        POHODA_REGISTRY_LOOKUP: "off",
        POHODA_XML_WORK_DIR: dir
      },
      stderr: "pipe"
    });
    try {
      await client.connect(transport);
      // initialize delivers instructions without a separate resource read.
      expect(client.getInstructions()).toBe(POHODA_SERVER_INSTRUCTIONS);
      expect(client.getInstructions()).toContain("Before processing documents, read pohoda://guide");
      expect(POHODA_SERVER_INSTRUCTIONS.split(/\s+/).length).toBeLessThan(260);

      const resources = await client.listResources();
      expect(resources.resources.find((r) => r.uri === POHODA_GUIDE_URI)?.description).toContain("Canonical");
      const resource = await client.readResource({ uri: POHODA_GUIDE_URI });
      const resourceText = resource.contents.find((c) => "text" in c);
      expect(resourceText && "text" in resourceText).toBe(true);
      const guide = JSON.parse((resourceText as { text: string }).text);
      expect(guide).toEqual(POHODA_USAGE_GUIDE);

      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "get_usage_guide")?.annotations?.readOnlyHint).toBe(true);
      const fallback = await client.callTool({ name: "get_usage_guide", arguments: {} });
      expect(fallback.isError).not.toBe(true);
      expect(fallback.structuredContent).toEqual(guide);
      const fallbackText = (fallback.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")!.text!;
      expect(JSON.parse(fallbackText)).toEqual(guide);

      // Guidance is available without credentials, a database, ARES or POHODA itself.
      expect(guide.defaultExpenseWorkflow.import).toContain("expectedWorkbookSha256");
      expect(guide.sourceExtraction.uncertainty).toContain("Never invent");
      expect(guide.expensePolicy.verification).toContain("MCP-ID:");
      expect(client.getInstructions()).toContain("even if every document is already in POHODA");
      expect(guide.defaultExpenseWorkflow.completion).toContain("chat summary");
      expect(guide.defaultExpenseWorkflow.completion).toContain("Include every extracted source document");
      expect(guide.defaultExpenseWorkflow.stopping).toContain("flag the affected row and continue creating the workbook");
      expect(guide.defaultExpenseWorkflow.stopping).toContain("explicit user stop");
      expect(tools.tools.find((tool) => tool.name === "prepare_expense_review")?.description).toContain("even if all documents already exist");
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
