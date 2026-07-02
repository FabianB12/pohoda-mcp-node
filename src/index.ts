import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfigFromEnv } from "./config/env.js";
import { registerPohodaTools } from "./mcp/tools.js";
import { PohodaClient } from "./pohoda/client.js";
import { XmlDatabaseRegistry } from "./pohoda/database-registry.js";
import { CliXmlTransport } from "./pohoda/transport.js";

const baseDir = dirname(dirname(fileURLToPath(import.meta.url)));
const config = createConfigFromEnv(process.env, baseDir);
const transport = new CliXmlTransport(config.transport);
const databaseRegistry = config.databasesFile || config.dataDir
  ? new XmlDatabaseRegistry({ registryPath: config.databasesFile, dataDir: config.dataDir })
  : undefined;
const client = new PohodaClient({ transport, ico: config.ico, database: config.database });

const server = new McpServer({
  name: "pohoda-xml-cli",
  version: "1.0.0",
  title: "Pohoda XML CLI MCP Server"
}, {
  instructions: [
    'Pohoda XML MCP server interacts with POHODA through the official command-line XML API: Pohoda.exe /XML "user" "password" "xml_imp.ini".',
    "Target accounting units explicitly: discover them with list_accounting_units or list_xml_databases, then pass databaseId on accounting-unit-specific calls. POHODA validates the dataPack ICO against the selected accounting unit, so use registry/live rows that include ICO or database filenames containing the 8-digit ICO. current_database only shows the configured fallback; there is no mutable select_database workflow.",
    "Same-database calls are serialized with a per-database lock. Different databases may run in parallel, capped by POHODA_XML_MAX_PARALLEL_PROCESSES.",
    "Prefer filters, idFrom/count, and limit on list tools. When you already know you need several reads from one accounting unit, use batch_list_records or create_data_export_bundle to avoid repeated Pohoda.exe startup. When doing more than one write/output operation for one accounting unit, use batch_write; it supports contacts, invoices, other liabilities/receivables, cash vouchers, activities, stock/order management, bank/internal/warehouse/production/sales receipt documents, offers, enquiries, contracts, centres, stores/storage, bank accounts, stock groups, parameter definitions, and print jobs. For repeated contact+invoice creation, use batch_create_invoices. Use raw_xml_batch only for advanced schema-specific dataPacks not covered by typed tools.",
    "Reference data and usage guidance are exposed as resources under pohoda://enums/*, pohoda://xml-databases, and pohoda://guide."
  ].join("\n")
});

registerPohodaTools(server, { client, databaseRegistry });

await server.connect(new StdioServerTransport());
