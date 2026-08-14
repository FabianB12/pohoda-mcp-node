# POHODA MCP Usage Guide

This project has access to the XML version of the POHODA MCP server for working with
Stormware POHODA accounting data. Use the MCP tools directly instead of guessing from
local files.

Only use the XML MCP workflow. Ignore any old HTTP, mServer, PHP, or profile-based
POHODA integration notes if they appear elsewhere; they are legacy context and are not
the intended operational path.

## Core Rules

- Always target the correct accounting unit. Use `list_accounting_units` to discover
  available units and pass `databaseId` on every accounting-unit-specific call.
- POHODA validates the `dat:dataPack` ICO against the selected unit. Prefer database
  discovery rows or registry ids that include the unit ICO; direct database filenames
  must contain an 8-digit ICO or match live discovery.
- Do not rely on stale cached assumptions. If the POHODA UI may have changed data,
  list/export the data fresh before acting.
- Prefer typed MCP tools over `raw_xml`. Use `raw_xml` or `raw_xml_batch` only when a
  typed tool cannot express the needed POHODA XML workflow.
- Keep responses compact. Use filters, limits, batching, and persisted exports instead
  of dumping large datasets into the model context.
- For retryable writes, provide a stable `dataPackId` so POHODA duplicate checking can
  help protect against accidental re-imports.

## Scanned PDF Intake

When a user provides one PDF containing scanned invoices, receipts, or other accounting
documents, call `prepare_scanned_pdf` before trying to inspect the PDF page by page. The
tool renders all selected pages concurrently, stores stable numbered JPEG/PNG files,
returns page metadata and paths, and inlines the images by default. Unchanged inputs with
the same render options use the cache, so do not render the same PDF repeatedly.

Recommended defaults are JPEG, 180 DPI, quality 82, and `inlineImages: true`. Use PNG only
when lossless rendering is needed for unusually small or degraded print. For very large
files, process explicit `firstPage`/`lastPage` ranges instead of raising limits without
reason.

When sub-agents are available and the PDF contains at least four pages/documents that can
be read independently:

1. Render the PDF once with `prepare_scanned_pdf`.
2. Divide the returned page paths into disjoint, roughly equal adjacent ranges and ask
   sub-agents to extract them concurrently. Do not ask every sub-agent to inspect the
   whole PDF.
3. Require each sub-agent to return structured document fields, source page numbers,
   confidence/uncertainties, both `dateTax` and `dateKHDPH` when applicable, and whether
   a page continues the previous or next document.
4. Keep extraction read-only. Sub-agents must not create contacts, invoices, receipts, or
   other POHODA records independently.
5. The parent agent reconciles multi-page documents, detects duplicates, verifies supplier
   or customer identity, dates, document numbers, currencies, net/VAT/gross totals, payment
   method, and target accounting unit.
6. Group validated records by `databaseId`, then submit one `batch_write` or
   `batch_create_invoices` call per accounting unit. Different accounting-unit batches may
   run in parallel; same-unit writes remain ordered in one batch.
7. Verify the completed write with fresh compact reads/exports and report rejected or
   uncertain documents separately.

For adjacent pages that may belong to one invoice, preserve overlap as metadata instead
of importing each page as a separate document. A page image is not automatically one
accounting document.

## Czech VAT Date Rule

Do not treat `dateTax` and `dateKHDPH` as interchangeable optional fields.

- For a received taxable invoice or other liability, `dateTax` is POHODA's date of
  deduction/delivery. It determines the VAT-return and control-statement period.
- `dateKHDPH` is the supplier's original DUZP/DPPD shown on the source document and
  reported in the control-statement detail.
- If the dates are equal, explicitly send the same `YYYY-MM-DD` value in both fields.
  Do not fill only `dateTax`.
- If they differ, put the deduction/delivery date in `dateTax` and preserve the original
  source DUZP/DPPD in `dateKHDPH`.
- Apply the same extraction rule to taxable cash expenses, internal documents,
  commitments, and corrective tax documents. Do not normally set `dateKHDPH` on an
  ordinary `issuedInvoice`.
- Never invent a source DUZP/DPPD from an issue date. Flag the document for review when
  the relevant date cannot be read reliably.

The XML builder defensively copies `dateTax` into `dateKHDPH` when the latter is omitted
on an applicable document type. That fallback only protects the equal-date case; it
cannot recover a distinct supplier date, so extraction must still return both fields.

## Discovery

Use `list_accounting_units` first when you do not know which client/company/year to use.
It returns live POHODA accounting units with fields such as name, ICO, DIC, city, year,
date range, and database identifier.

Use filters when the list may be large:

- `query` for fuzzy search across company/person/database/address fields.
- `ico`, `dic`, `city`, `year`, or `database` when known.
- `limit` and `cursor` for pagination.

There is no mutable database selection step. Use `current_database` only to inspect the
configured fallback. For normal work, pass explicit `databaseId`; if neither `databaseId`
nor a configured default exists, accounting-unit-specific tools will fail before running
POHODA.

## Efficient Reads

Use the smallest useful query:

- For invoices and documents, use `list_documents` with `invoiceType`, dates, number,
  ICO, company, or id filters.
- For cash register documents, use `list_documents` with `agenda: "voucher"`; create
  them with `create_cash_voucher` instead of raw XML.
- For other receivables/liabilities, use `list_documents` with `agenda: "invoice"` and
  `invoiceType: "receivable"` or `invoiceType: "commitment"`.
- For activities (Cinnosti), use `list_export_agenda` with `agenda: "activity"`.
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

For invoice exports, treat `summary.total`, `summary.byCurrency`, `summary.byPartner`,
and `summary.byMonth` as home-currency totals, normally CZK. If invoices have foreign
currency, use `summary.foreignCurrency` for foreign totals keyed by currency code; compact
records also include `homeCurrency` and `foreignCurrency` fields when available.

Do not request thousands of full records directly into chat unless truly necessary.

## Efficient Writes

When doing more than one write/output operation in the same accounting unit, use
`batch_write`. It can batch typed operations such as:

- `create_address`
- `create_invoice`
- `create_other_liability`
- `create_other_receivable`
- `create_cash_voucher`
- `manage_activity`
- `create_stock`
- `manage_stock`
- `create_order`
- `create_bank_document`
- `create_internal_document`
- `create_stock_receipt`
- `create_stock_issue`
- `create_stock_transfer`
- `create_production_document`
- `create_sales_receipt`
- `create_offer`
- `create_enquiry`
- `manage_contract`
- `manage_centre`
- `manage_store`
- `manage_storage`
- `manage_bank_account`
- `manage_group_stock`
- `manage_parameter_definition`
- `print`

For repeated invoice creation where each invoice may need a new contact, prefer
`batch_create_invoices`. It creates each optional address immediately before its invoice
inside one POHODA `dataPack`.

Use one batch per accounting unit. Different accounting-unit batches may run in parallel,
but same-unit operations are intentionally serialized to avoid unsafe POHODA concurrency.

After important writes, verify with fresh list calls or a compact export. Treat POHODA
warnings as important: an `ok` response may still include adjusted fields such as default
accounting, VAT classification, payment type, or account.

Use `create_cash_voucher` for normal Pokladna receipts/expenses. Set `type` to `receipt`
for cash income and `expense` for cash expense, pass the POHODA cash register in
`cashAccount`, and include activity/centre/contract/accounting/VAT fields when needed.

Use `create_other_liability` for Ostatni zavazky and `create_other_receivable` for
Ostatni pohledavky. These are invoice XML documents with fixed `invoiceType`
`commitment`/`receivable`, so they support the same item, partner, activity, centre,
contract, payment, VAT, and foreign-currency fields as `create_invoice`.

Use `manage_activity` for Cinnosti. `action: "add"` creates an activity. For
`update`/`delete`, first list activities and pass the numeric POHODA `id` as `matchId`
or `id`; the official POHODA action filter for activities is id-based.

Use native tools instead of raw XML for the common POHODA agendas: bank documents,
internal documents, warehouse receipts/issues/transfers/production, sales receipts,
offers, enquiries, contracts, centres, stores/storage, bank accounts, stock groups,
and optional parameter definitions. These tools support batching through
`batch_write`; keep dependencies in order inside the batch, e.g. contact/stock setup
before documents that reference them.

For stock creation, POHODA company settings may require both `storage` and `typePrice`
(`stk:storage` and `stk:typePrice`). Prefer copying these from an existing stock card
when creating test/demo stock.

Most broad document tools expose normal header/item fields plus `extraHeader`,
`extraItem`, and `extraData` for rare POHODA XSD fields. Use those only with
already-prefixed XML-object keys from the official schema; prefer the typed fields first.

Use `list_balance` for Saldo/balance exports. It is read-only and separate from
`batch_write`.

## Printing, PDFs, and Email

Use `print` for POHODA print/export workflows. It can print, create PDFs, return PDF
Base64, include ISDOC, or send email through POHODA, depending on POHODA configuration.

You need the correct POHODA print agenda and report id. For example:

- `vydane_faktury` for issued invoices.
- `prijate_faktury` for received invoices.

PDF paths are paths on the Windows machine running POHODA, not local paths in this
project.

`prepare_scanned_pdf` is separate from POHODA printing. Its `pdfPath` must be accessible
to the machine running this MCP process, and its returned image paths are local to that
same machine.

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
