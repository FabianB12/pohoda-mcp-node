# Optional accounting-workspace reminder

The full operator guide is served by the MCP as `pohoda://guide` and by the
read-only `get_usage_guide` tool. It is maintained in `src/mcp/guide.ts`.

If your client does not reliably pass MCP server instructions to the agent, put
this short reminder in the accounting workspace's `AGENTS.md`:

> Before processing POHODA documents, read `pohoda://guide`. If resource access is
> unavailable, call `get_usage_guide`. Follow its preview → user review → explicit
> import workflow. Deliver the XLSX even when all documents are duplicates or need
> review; a findings summary is not completion. Keep client-specific mappings here,
> scoped by client and year.

This is a pointer, not a separate copy of the accounting rules. Merely storing
this file under `docs/` does not load it into an agent's context.
