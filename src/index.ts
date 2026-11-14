import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfigFromEnv } from "./config/env.js";
import { registerPohodaTools } from "./mcp/tools.js";
import { POHODA_SERVER_INSTRUCTIONS } from "./mcp/guide.js";
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
  version: "2.0.0",
  title: "Pohoda XML CLI MCP Server"
}, {
  instructions: POHODA_SERVER_INSTRUCTIONS
});

registerPohodaTools(server, { client, databaseRegistry });

await server.connect(new StdioServerTransport());
