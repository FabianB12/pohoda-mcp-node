# POHODA MCP Usage Guide

This project has access to the XML version of the POHODA MCP server for working with
Stormware POHODA accounting data. Use the MCP tools directly instead of guessing from
local files.

Only use the XML MCP workflow. Ignore any old HTTP, mServer, PHP, or profile-based
POHODA integration notes if they appear elsewhere; they are legacy context and are not
the intended operational path.

## Core Rules

- Always target the correct accounting unit. Use `list_accounting_units` to discover
  available units and pass `databaseId` on calls whenever possible.
- Do not rely on stale cached assumptions. If the POHODA UI may have changed data,
  list/export the data fresh before acting.
- Prefer typed MCP tools over `raw_xml`. Use `raw_xml` or `raw_xml_batch` only when a
  typed tool cannot express the needed POHODA XML workflow.
- Keep responses compact. Use filters, limits, batching, and persisted exports instead
  of dumping large datasets into the model context.
- For retryable writes, provide a stable `dataPackId` so POHODA duplicate checking can
  help protect against accidental re-imports.

## Discovery

Use `list_accounting_units` first when you do not know which client/company/year to use.
It returns live POHODA accounting units with fields such as name, ICO, DIC, city, year,
date range, and database identifier.

Use filters when the list may be large:

- `query` for fuzzy search across company/person/database/address fields.
- `ico`, `dic`, `city`, `year`, or `database` when known.
- `limit` and `cursor` for pagination.

Use `current_database` only to inspect the shared default. For reliable multi-client work,
prefer explicit `databaseId` on every tool call.

## Efficient Reads

Use the smallest useful query:

- For invoices and documents, use `list_documents` with `invoiceType`, dates, number,
  ICO, company, or id filters.
- For contacts, use `list_contacts`.
- For stock, use `list_stock`.
- For reference/codebook data, use `list_export_agenda`.

When several reads are needed from the same accounting unit, use `batch_list_records`
instead of separate list calls. This packs multiple reads into one POHODA XML run.

For large datasets, use persisted exports:

- `create_data_export` for one large dataset.
- `create_data_export_bundle` for several related datasets.
- `read_export_page` to page through compact records.
- `summarize_export` for totals without loading all records.
- `cleanup_export` when the export snapshot is no longer needed.

Do not request thousands of full records directly into chat unless truly necessary.

## Efficient Writes

When doing more than one write/output operation in the same accounting unit, use
`batch_write`. It can batch typed operations such as:

- `create_address`
- `create_invoice`
- `create_stock`
- `create_order`
- `print`

For repeated invoice creation where each invoice may need a new contact, prefer
`batch_create_invoices`. It creates each optional address immediately before its invoice
inside one POHODA `dataPack`.

Use one batch per accounting unit. Different accounting-unit batches may run in parallel,
but same-unit operations are intentionally serialized to avoid unsafe POHODA concurrency.

After important writes, verify with fresh list calls or a compact export. Treat POHODA
warnings as important: an `ok` response may still include adjusted fields such as default
accounting, VAT classification, payment type, or account.

## Printing, PDFs, and Email

Use `print` for POHODA print/export workflows. It can print, create PDFs, return PDF
Base64, include ISDOC, or send email through POHODA, depending on POHODA configuration.

You need the correct POHODA print agenda and report id. For example:

- `vydane_faktury` for issued invoices.
- `prijate_faktury` for received invoices.

PDF paths are paths on the Windows machine running POHODA, not local paths in this
project.

## Parallelism

The MCP is optimized for this pattern:

1. Group work by accounting unit/database.
2. Batch same-unit reads with `batch_list_records` or export bundles.
3. Batch same-unit writes with `batch_write` or `batch_create_invoices`.
4. Run different accounting-unit batches in parallel when useful.

Avoid sending many tiny individual tool calls when one batch can express the work.

## Safety

- Never create, update, print, email, or otherwise mutate data unless the user asked for it.
- Before destructive or externally visible actions such as email or printer output, confirm
  the target, report, recipient, and accounting unit unless they are already explicit.
- Prefer fresh verification after writes and clearly report what was created, changed, or
  not found.
- If a tool returns a POHODA schema or validation error, fix the input and retry with a
  stable `dataPackId` only when doing so is safe.
