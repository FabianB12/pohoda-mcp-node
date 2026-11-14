# Pohoda MCP Server - TypeScript XML CLI Backend

MCP server for Stormware POHODA using the official command-line XML API:

```bat
Pohoda.exe /XML "Uzivatel" "Heslo" "C:\path\to\xml_imp.ini"
```

This backend does not require POHODA mServer. It writes a request XML file and an
`xml_imp.ini`, runs `Pohoda.exe /XML`, then parses the response XML.

## Setup

Requires Node.js 22.13 or newer.

```bash
npm install
npm run build
```

Run the MCP server with:

```bash
node dist/index.js
```

On Windows you can also use `run-server.cmd`, which loads `.env`, builds when needed,
and then starts `dist/index.js`.

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `POHODA_EXE_PATH` | Full path to `Pohoda.exe` | required |
| `POHODA_USERNAME` | POHODA user name | required |
| `POHODA_PASSWORD` | POHODA password | empty |
| `POHODA_ICO` | Company ICO for `dat:dataPack` | empty |
| `POHODA_DATABASE` / `POHODA_DEFAULT_DATABASE` | Optional fallback POHODA database name when a tool call omits `databaseId` | empty |
| `POHODA_XML_WORK_DIR` | Job, lock, and diagnostics directory | `XML/var/xml` |
| `POHODA_XML_TIMEOUT` | Per-job process timeout in seconds | `120` |
| `POHODA_XML_QUEUE_TIMEOUT` | Max seconds to wait for the same-database queue lock | `300` |
| `POHODA_XML_MAX_PARALLEL_PROCESSES` | Global cap for simultaneous POHODA `/XML` processes across databases | `4` |
| `POHODA_XML_CHECK_DUPLICITY` | Write `check_duplicity=1` to INI | `1` |
| `POHODA_XML_KEEP_FAILED_JOBS` | Keep failed job folders for debugging | `1` |
| `POHODA_XML_KEEP_SUCCESSFUL_JOBS` | Keep successful job folders | `0` |
| `POHODA_XML_DATABASES_FILE` | Optional JSON registry of databases | empty |
| `POHODA_DATA_DIR` | Optional folder scanned for database-like files | empty |
| `POHODA_XML_EXPORT_DIR` | Persisted export snapshots/resources | `XML/var/exports` |
| `POHODA_DOCUMENT_IMAGE_DIR` | Cached page images created by `prepare_scanned_pdf` | `XML/var/document-pages` |

Example MCP config:

```json
{
  "mcpServers": {
    "pohoda-xml": {
      "command": "node",
      "args": ["C:\\mcp\\pohoda\\XML\\dist\\index.js"],
      "env": {
        "POHODA_EXE_PATH": "C:\\Program Files (x86)\\STORMWARE\\POHODA\\Pohoda.exe",
        "POHODA_USERNAME": "Admin",
        "POHODA_PASSWORD": "secret",
        "POHODA_ICO": "12345678",
        "POHODA_DEFAULT_DATABASE": "StwPh_12345678_2026.mdb",
        "POHODA_XML_WORK_DIR": "C:\\mcp\\pohoda\\xml-work",
        "POHODA_XML_DATABASES_FILE": "C:\\mcp\\pohoda\\databases.json"
      }
    }
  }
}
```

Database registry example:

```json
[
  {
    "id": "client-a-2026",
    "name": "Client A 2026",
    "database": "StwPh_12345678_2026.mdb",
    "ico": "12345678",
    "dic": "CZ12345678",
    "city": "Praha",
    "year": 2026
  }
]
```

Registry entries should include `ico`. POHODA validates the `dat:dataPack ico` against
the selected accounting unit; if a direct database name is used without a registry ICO,
the MCP can only infer the ICO when the filename contains an 8-digit ICO or when live
accounting-unit discovery can match the database.

## Runtime Model

For each MCP tool call, the backend creates a unique job directory:

```text
{POHODA_XML_WORK_DIR}/jobs/{jobId}/
  request.xml
  response.xml
  xml_imp.ini
  metadata.json
  stdout.log
  stderr.log
```

The generated INI uses official single-file mode:

```ini
[XML]
input_xml=C:\...\request.xml
response_xml=C:\...\response.xml
database=StwPh_12345678_2026.mdb
check_duplicity=1
format_output=0
```

`format_output=0` is the default because Stormware documents pretty formatting as slow
for large XML. `database` is omitted only for official accounting-unit export.

## Concurrency

The XML backend uses one file lock per database.

- Same database: requests run sequentially.
- Different databases: requests can run in parallel, up to `POHODA_XML_MAX_PARALLEL_PROCESSES`.
- Accounting-unit discovery without `database`: uses a separate discovery lock.

This avoids unsafe same-unit concurrency while still letting many companies run at once.

## Tools

Database and transport:

- `status`
- `current_database`
- `list_xml_databases`
- `list_accounting_units`

Read tools:

- `lookup_supplier_registry`
- `prepare_scanned_pdf`
- `list_documents`
- `list_stock`
- `list_contacts`
- `list_export_agenda`
- `batch_list_records`
- `list_balance`

Large/export tools:

- `create_data_export`
- `create_data_export_bundle`
- `read_export_page`
- `summarize_export`
- `cleanup_export`

Write tools:

- `create_invoice`
- `create_other_liability`
- `create_other_receivable`
- `create_cash_voucher`
- `manage_activity`
- `batch_write`
- `batch_create_invoices`
- `create_order`
- `create_address`
- `manage_address`
- `create_stock`
- `manage_stock`
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

Print/output:

- `print`

Advanced:

- `raw_xml`
- `raw_xml_batch`

## Scanned PDF preprocessing

Use `prepare_scanned_pdf` when one uploaded PDF contains scanned invoices or receipts.
The tool uses PDF.js and a cross-platform native canvas renderer, so it does not require a
separate Poppler/ImageMagick installation on Windows. It:

- renders each selected PDF page to a numbered JPEG or PNG;
- renders several pages concurrently with a bounded worker pool;
- caches output by source file metadata and render settings;
- returns absolute image paths and dimensions;
- inlines rendered pages as MCP image content by default so the model can inspect them
  immediately;
- supports encrypted PDFs, page ranges, rendering limits, DPI/quality controls, and an
  optional output root.

Example arguments:

```json
{
  "pdfPath": "C:\\Imports\\scanned-invoices.pdf",
  "format": "jpeg",
  "dpi": 180,
  "jpegQuality": 82,
  "inlineImages": true
}
```

For four or more independently readable pages/documents, render once and distribute
disjoint returned page paths to sub-agents. Each reader should return structured fields,
source pages, confidence, and continuation markers. The parent agent must merge multi-page
documents, validate totals/VAT/identity, deduplicate, choose the accounting unit, and then
prepare one review workbook per `databaseId` using `prepare_expense_review`. Only after
user review and an explicit import instruction, call `import_expense_review`. Reader agents
must not write to POHODA independently.

### Default reviewed-workbook workflow

A request to process PDFs prepares an editable `.xlsx`; it does not authorize accounting
writes. The workflow is:

1. Extract source PDFs and call `prepare_expense_review` with the client, VAT month and
   document rows. The service checks POHODA and the incoming batch for duplicates, and
   reads similar client documents before saving the preview. Deliver the resulting
   XLSX as a file link even if every source document already exists or needs review;
   reporting findings in chat alone does not finish preparation.
2. Review/edit the workbook. Use `inspect_expense_review` to inspect its current contents.
   Resolve rows marked for review or mark them to skip.
3. Explicitly request import, then call `import_expense_review` with `approved: true` and the `expectedWorkbookSha256` returned by the latest inspection.
   The service rereads the reviewed cells and validates them before any accounting write.

Duplicate rows are pink, with a short reference in the existing review note. Matching
fields receive a stronger tint; yellow identifies fields needing correction. Ordinary
rows have no status text, and the detailed import plan is collapsed by default.
It checks source PDF/pages, supplier and document reference, and possible matches by
supplier, exact amount, currency and date when a reference is missing. Matches and
incomplete checks are marked **Prověřit**; nothing is silently removed. Re-preparing
refreshes checks without discarding edits, and import checks POHODA again.

For large batches, send up to 500 rows together. Duplicate detection and examples share
one paged snapshot (all three expense agendas batched per page), PDFs are hashed once
per file, and matching runs locally against indexes. Detailed tool previews are limited
to 20 rows; the workbook retains every row.

Review notes are not accounting data and are never imported. Short document descriptions
are preferred (for example, `Materiál` rather than a list of all materials). Existing client
records inform accounting conventions but never replace source VAT or amounts.
Direct expense create/batch MCP calls are blocked; the lower-level TypeScript client
remains available for implementation and controlled integration tests.

### Strict expense imports (version 2)

Received invoices (`receivedInvoice`), other liabilities (`commitment`) and cash
expenses require **summary amounts and header text, without items**. Pass the selected
`vatPeriod` (`YYYY-MM`), original source dates/number, exact VAT buckets, optional
`roundingAmount`, and `total` (final payable after rounding).
Taxable expenses also require an explicit `classificationVAT` from the client's
codebook: leaving it to a POHODA default can incorrectly classify a card purchase as PN.

The shared policy applies the selected month's first day to late invoice `date`,
`dateTax`, `dateAccounting` and `dateKHDPH`. Original source facts remain in `intNote`.
Cash expenses keep actual `datePayment`; they have no `dateAccounting` XML field.
PN/non-tax documents have no KH date and put the source gross in the zero-rate bucket.
Missing DIČ alone never establishes non-payer status. Foreign documents need an explicit
VAT-treatment decision; current registry status does not prove historical status.

`lookup_supplier_registry` looks up Czech suppliers through ARES and returns current
VAT evidence. Expense writes resolve/create contacts, mark suppliers and verify links.
Cash expense `Doklad` is populated only above CZK 10,000 payable after rounding.
For `cardPayment=true` commitments, the live PK sequence drives `KN`/variable symbol N
at or below CZK 10,000; above it the source references are used.

Omit `currencyRate` to let POHODA use its configured rate. There is no fallback of 1.
Foreign summaries cannot encode every VAT split: unsupported combinations fail clearly
rather than silently losing VAT or converting the currency. Inspect the applied FX data
and all verification differences returned after import.
POHODA recalculates document rounding from its selected rounding mode. The importer
selects a mode only when it reproduces the source payable exactly; an arbitrary
adjustment that no supported mode can preserve is returned for review before writing.

Expense results distinguish created, already-existing and created-but-unverified
records. A verification failure returns IDs and differences; never blindly re-import.
POHODA 14302 does not reliably export or filter invoice external IDs. Expense imports
therefore also keep a stable `MCP-ID:` line in the internal note and compare it during
fresh paged reads. Preserve that line if editing imported records manually. Duplicate
scans are grouped by agenda and accounting year and processed on the server.
This policy is a breaking input change from version 1; issued invoices, other receivables
and cash receipts retain their ordinary workflows.

The canonical operator guide is `pohoda://guide`, also available through the read-only
`get_usage_guide` tool for clients without resource access. Both serve the same content
from `src/mcp/guide.ts`; the server's short initialization instructions tell the agent
to read it before processing documents.

MCP clients decide whether to pass server instructions to the model or load resources
automatically. If yours does not, use [the optional workspace reminder](docs/consumer-AGENTS.md)
and keep only client/year-specific mappings alongside it. The repository root
`AGENTS.md` is for developers, not a second operator manual.

Use `raw_xml_batch` for schema-specific multi-step workflows where batching several
`dataPackItem`s into one POHODA process run is more efficient than separate calls.

Use `batch_list_records` when an agent already knows it needs several typed read/list
requests from the same accounting unit. The MCP packs them into one POHODA `dataPack`,
runs one `/XML` process, and returns per-operation results.

Use `batch_write` when doing several typed write/output operations in the same accounting
unit. It supports `create_address`, `create_invoice`, `create_other_liability`,
`create_other_receivable`, `create_cash_voucher`, `manage_activity`, `create_stock`,
`manage_stock`, `create_order`, bank/internal/warehouse/production/sales receipt
documents, offers, enquiries, contracts, centres, stores/storage, bank accounts, stock
groups, parameter definitions, and `print` operations in one POHODA
`dataPack`, returning per-operation results.

For stock creation, some POHODA company settings require `storage` and `typePrice`.
Use values from an existing stock card when unsure.

Use `create_cash_voucher` for Pokladna cash receipts/expenses. Set `type` to `receipt`
or `expense`, pass the target POHODA cash register as `cashAccount`, and use item/header
fields such as accounting, VAT classification, centre, activity, contract, partner, and
foreign currency when needed.

Use `create_other_liability` for Ostatni zavazky and `create_other_receivable` for
Ostatni pohledavky. They are typed wrappers around POHODA invoice XML with fixed
`invoiceType` values `commitment` and `receivable`.

Use `manage_activity` for Cinnosti. `add` creates a record; `update` and `delete`
require the numeric POHODA activity id, so list `activity` first when you only know a
code or name.

Use the native agenda tools instead of `raw_xml` for common POHODA work: `create_bank_document`
for Banka, `create_internal_document` for Interni doklady, `create_stock_receipt`/`create_stock_issue`/
`create_stock_transfer`/`create_production_document` for warehouse flows, `create_sales_receipt`
for Prodejky, `create_offer`, `create_enquiry`, `manage_contract`, `manage_centre`,
`manage_store`, `manage_storage`, `manage_bank_account`, `manage_group_stock`,
and `manage_parameter_definition`. Broad document tools accept
normal header/item fields plus `extraHeader`, `extraItem`, and `extraData` for rare
schema-specific fields using already-prefixed XML-object keys.

Use `list_balance` for Saldo/balance exports with `dateTo`, `pairing`, paging limits,
and optional user filters.

Use `batch_create_invoices` for the common invoice-heavy workflow. It can place an
addressbook item immediately before each invoice in one POHODA `dataPack`, so a workflow
that would otherwise be `create_address` + `create_invoice` per invoice pays the POHODA
startup cost once. Different accounting units should still be submitted as separate batch
calls so the per-database queues can run them in parallel.

## Large Data Exports

For datasets that may be too large for model context, use the persisted export flow:

1. Call `create_data_export` with filters, `pageSize`, `maxRecords`, and `previewLimit`.
2. The tool returns compact structured output: `exportId`, preview rows, summary totals,
   `nextCursor`, and resource links.
3. Call `read_export_page` with `exportId` and the opaque `nextCursor` to inspect more
   compact rows.
4. Call `summarize_export` for server-side totals without loading full records.
5. Read full-fidelity resources when needed:
   - `pohoda://exports/{exportId}/metadata.json`
   - `pohoda://exports/{exportId}/records.json`
   - `pohoda://exports/{exportId}/records.ndjson`
   - `pohoda://exports/{exportId}/summary.json`
6. Call `cleanup_export` when done.

`create_data_export` supports documents, stock, contacts, and export agendas. Invoice
exports are just `kind="documents"`, `agenda="invoice"`, and `invoiceType` set to
`issuedInvoice` or `receivedInvoice`.

Invoice export summaries keep home and foreign currency separate. `summary.total`,
`summary.byCurrency`, `summary.byPartner`, and `summary.byMonth` are home-currency totals,
normally CZK. Foreign totals are exposed separately as `summary.foreignCurrency`, keyed
by the foreign currency code. Compact records include `homeCurrency` and `foreignCurrency`
when POHODA returns them.

Use `create_data_export_bundle` when several related datasets are needed at once, such
as issued invoices, received invoices, stock, and contacts. The MCP batches each page
round into shared POHODA `/XML` runs and persists each dataset as its own export
snapshot with normal `read_export_page`, `summarize_export`, and resource support.

## Agent Guidance

- Discover the target accounting unit with `list_accounting_units` or
  `list_xml_databases`, then pass `databaseId` directly to accounting-unit-specific tools.
  `databaseId` may be a registry id or an exact POHODA database name. The MCP also needs
  the target unit ICO to build POHODA's `dat:dataPack` wrapper; prefer registry/live
  discovery rows that include ICO.
- There is no mutable database selection workflow. `current_database` is only a
  diagnostic for the configured fallback database. If a tool needs an accounting unit and
  neither `databaseId` nor a configured default exists, it fails before running POHODA.
- Prefer explicit filters and server-side `count`/`idFrom` over large exports.
- For scanned document bundles, call `prepare_scanned_pdf` once and use its cached page
  paths for parallel sub-agent extraction. Keep POHODA writes in the parent agent after
  page-boundary reconciliation, validation, and deduplication.
- If the task clearly needs several reads from the same accounting unit, plan them first
  and call `batch_list_records` instead of making separate list calls.
- For larger lists, summaries, or analysis, prefer `create_data_export` instead of
  returning raw list payloads directly to the model.
- If larger analysis needs several datasets, prefer `create_data_export_bundle` so page
  rounds are batched and full records stay in persisted resources.
- Use `list_accounting_units` for the official live accounting-unit export.
- `list_accounting_units` is paginated. Use `query`, `ico`, `dic`, `city`,
  `database`, `year`, `limit`, and opaque `cursor` instead of loading every client
  into model context. The `query` search is diacritic-insensitive and typo-tolerant
  across company name, person name, ICO, DIČ, database, city, address, id, and path.
- Use `list_xml_databases` for configured registry entries and filesystem fallback guesses.
  It refreshes these sources on every call; `includeLive=true` also asks POHODA for
  the current accounting-unit list.
- Normal list/create/status calls ask POHODA every time. Persisted exports are
  intentional point-in-time snapshots; create a new export after changing data in the
  POHODA UI.
- For retryable advanced writes, pass `dataPackId` to `raw_xml` or `raw_xml_batch`; POHODA
  duplicate checking uses `dataPack` and `dataPackItem` ids.
- Dedicated create/write tools, including `batch_write` and `batch_create_invoices`, also accept optional
  `dataPackId`; use it for retryable create attempts where duplicate checking should
  protect against re-import.
- `list_xml_databases(includeLive=true)` combines configured/filesystem entries with the
  official live accounting-unit export.
- PDF paths are paths on the POHODA host running `Pohoda.exe /XML`.

## Testing

```bash
npm test
npm run check
npm run build
```

The included tests cover request XML generation, response parsing, INI rendering, and
database registry discovery with fakeable transport/process execution. Real POHODA
integration tests should be opt-in because they require Windows and a licensed POHODA
installation.

### UTM POHODA Validation

When POHODA runs in a UTM Windows VM, the opt-in integration test can execute real
`Pohoda.exe /XML` jobs through `utmctl`. The default UTM run is intentionally a
small smoke test so normal validation stays fast:

```bash
npm run test:integration:utm
```

Use the larger suites only when changing agenda coverage, XML transport behavior, or
POHODA-specific schemas:

```bash
npm run test:integration:utm:mutation
npm run test:integration:utm:full
npm run test:integration:utm:full:mutation
```

Optional variables:

| Variable | Description | Default |
| --- | --- | --- |
| `POHODA_UTMCTL` | Path to `utmctl` | `/Applications/UTM.app/Contents/MacOS/utmctl` |
| `POHODA_UTM_EXE_PATH` | Guest path to `Pohoda.exe` | `C:\Program Files (x86)\STORMWARE\POHODA\Pohoda.exe` |
| `POHODA_UTM_USERNAME` / `POHODA_UTM_PASSWORD` | POHODA credentials in the VM | `Admin` / empty |
| `POHODA_UTM_ICO` | Demo/company ICO | `12345678` |
| `POHODA_UTM_DATABASE` | Explicit database selector; otherwise discovered live | empty |
| `POHODA_UTM_MUTATION` | Also run the demo-marked write smoke test | `0` |
| `POHODA_UTM_FULL` | Run the exhaustive live suite instead of only smoke coverage | `0` |

The default safe pass covers accounting-unit discovery, a core stock read,
batched stock/contact reads, and persisted invoice export paging. With
`POHODA_UTM_MUTATION=1`, it creates uniquely marked demo address, stock, order,
and invoice records in one batch. The full pass adds every supported read/list
agenda, safe raw XML, safe raw XML batch, export resource checks, same-database queue
serialization, broad native writes, setup/admin writes, operational stock/cash/bank
documents, production, sales receipts, and print probing.

Run a real benchmark with:

```bash
POHODA_UTM_VM=Windows npm run benchmark:utm
```

The benchmark reports per-call wall time, transport duration, queue wait, process-slot
wait, and a batching comparison. On the local UTM demo instance tested here,
single `/XML` calls were roughly 3.4-3.7 seconds, and a three-item `raw_xml_batch`
completed in roughly one process run instead of three.

The real POHODA 14302.10 demo rejected `listUserAgendaRequest` and
`listMeasureUnitRequest` for dataPack v2, so those two requests are intentionally not
exposed in `list_export_agenda`.


## Parallels integration tests

`npm run test:integration:parallels` is opt-in. With no VM configured it skips.
Set `POHODA_PRL_VM` to the existing Windows VM name and use
`POHODA_PRL_CURRENT_USER=1` when POHODA must run as the logged-in Windows user.
`POHODA_PRL_EXE_PATH` can identify an installation explicitly; otherwise the harness
checks standard installation locations. Credentials come from `POHODA_PRL_USERNAME`
and `POHODA_PRL_PASSWORD`; the harness sends them via stdin rather than host arguments.

Writes additionally require `POHODA_PRL_ALLOW_WRITES=1` and an explicit
`POHODA_PRL_DEMO_DATABASE`. Live accounting-unit metadata must identify it as a test/demo
unit; the harness never picks the first company for writes. Optionally pin its ICO with
`POHODA_PRL_DEMO_ICO`. Set `POHODA_PRL_REPORT` for the evidence JSON output.
All experimental documents use the `MCPTEST` marker and stable import IDs.

Tests cover exact VAT/rounding summaries, PN with an absent KH date, supplier linking,
POHODA-selected foreign rates and numbering behavior. A schema-valid request alone
is not proof that POHODA preserves the values: inspect the read-back evidence.

`npm run test:integration:production` uses the same environment gates and tests the
actual XLSX review service, expense importer and XML client together. It also checks
repeat imports, Czech PDF links, the cash threshold and card numbering across a large
purchase. Use a new `POHODA_PRL_RUN` tag for a new set of isolated test documents.


## Source PDF archive and document links

For PDF expense imports, pass `sourcePdfPath` (the original PDF readable by the MCP
server) and `sourcePages`. Attaching the source is required. `sourceType: "manual"`
is reserved for entries that did not come from a PDF.

The default archive root is `C:\Účetnictví\PDF DOKLADY KLIENTŮ Z POHODY`.
`POHODA_PDF_ARCHIVE_DIR` may explicitly override it. The server stores originals in
client/year subfolders using content-addressed filenames, so unrelated files cannot
silently overwrite each other. Several invoices from one PDF reuse the same saved file.
Source files are never deleted. The Windows path belongs to the machine hosting POHODA;
a non-Windows deployment needs an explicitly configured archive/bridge, not a relative
folder whose name happens to start with `C:`.

The XML links the archived file through `attachments/shortcut/target` in the Documents
tab. `attachments/files/file` is export-only and is not used for copying PDFs.
Post-import read-back must contain the saved target path. A successful invoice import
with a missing PDF link is returned as incomplete and must not be blindly re-imported.
Enable POHODA's **Používat složku dokumentů firmy** setting for the accounting unit.
The Windows system locale must support Czech (ANSI code page 1250) for this Czech
archive path: a live test on an English 1252 system changed accented path characters;
the same path round-tripped exactly after selecting the Czech system locale.
