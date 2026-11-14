# POHODA XML MCP development

This repository implements a TypeScript MCP server for the official POHODA
`Pohoda.exe /XML` interface. HTTP/mServer/PHP connection notes are legacy.

## Development

- Run `npm ci`, `npm run check`, and `npm test`. Build with `npm run build`.
- Keep XML schema decisions in shared builders and import policy, not only prompts.
  Check official Stormware XSDs and examples for unfamiliar fields.
- Keep single-document and batch tools on the same validation path.
- Test boundaries, partial failures and retry recovery.
- Do not accept POHODA normalization as proof the source document was wrong.
  Return field differences and created IDs; never blindly retry an uncertain write.
- Canonical operator guidance is `src/mcp/guide.ts`, served as `pohoda://guide` and
  `get_usage_guide`. Update it when behavior changes; keep startup instructions short.
  Do not maintain another full operator manual in AGENTS.md or tool descriptions.

## Accounting data and live tests

- Discover units with `list_accounting_units`; pass explicit `databaseId` on every
  unit-specific operation. The XML ICO must match the selected unit.
- Read fresh state after UI changes. Batch reads and writes by accounting unit.
- Never mutate client data for a coding task. Live tests require user authorization
  and a positively identified demo/test unit; never select the first unit for writes.
  Mark test documents `MCPTEST` and use stable IDs.
- Do not print, email, deploy or delete records unless explicitly asked.
- Do not log credentials or embed them in commands, fixtures or reports.

## Import changes

- Read `src/mcp/guide.ts` before changing accounting behavior. Preserve the reviewed
  workbook boundary, source facts, required attachments and retry protections.
- Validate changes with the relevant policy/import/workbook tests. Guide delivery is
  covered by `tests/mcp-guide.test.ts`; live XML behavior is documented separately
  in `docs/verification.md`.
