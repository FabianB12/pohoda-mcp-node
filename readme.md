# Pohoda MCP Server - TypeScript XML CLI Backend

MCP server for Stormware POHODA using the official command-line XML API:

```bat
Pohoda.exe /XML "Uzivatel" "Heslo" "C:\path\to\xml_imp.ini"
```

This backend does not require POHODA mServer. It writes a request XML file and an
`xml_imp.ini`, runs `Pohoda.exe /XML`, then parses the response XML.

## Setup

Requires Node.js 22 or newer.

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
| `POHODA_DATABASE` / `POHODA_DEFAULT_DATABASE` | Initial POHODA database name | empty |
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
- `select_database`
- `list_accounting_units`

Read tools:

- `list_documents`
- `list_stock`
- `list_contacts`
- `list_export_agenda`
- `batch_list_records`

Large/export tools:

- `create_data_export`
- `create_data_export_bundle`
- `read_export_page`
- `summarize_export`
- `cleanup_export`

Write tools:

- `create_invoice`
- `batch_write`
- `batch_create_invoices`
- `create_order`
- `create_address`
- `create_stock`

Print/output:

- `print`

Advanced:

- `raw_xml`
- `raw_xml_batch`

Use `raw_xml_batch` for schema-specific multi-step workflows where batching several
`dataPackItem`s into one POHODA process run is more efficient than separate calls.

Use `batch_list_records` when an agent already knows it needs several typed read/list
requests from the same accounting unit. The MCP packs them into one POHODA `dataPack`,
runs one `/XML` process, and returns per-operation results.

Use `batch_write` when doing several typed write/output operations in the same accounting
unit. It supports `create_address`, `create_invoice`, `create_stock`, `create_order`,
and `print` operations in one POHODA `dataPack`, returning per-operation results.

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

Use `create_data_export_bundle` when several related datasets are needed at once, such
as issued invoices, received invoices, stock, and contacts. The MCP batches each page
round into shared POHODA `/XML` runs and persists each dataset as its own export
snapshot with normal `read_export_page`, `summarize_export`, and resource support.

## Agent Guidance

- Call `current_database` before writes.
- Prefer passing `databaseId` directly to tools in multi-agent or concurrent workflows.
  `databaseId` may be a registry id or an exact POHODA database name.
- Use `select_database` only as a convenience default for simple single-session workflows.
- Prefer explicit filters and server-side `count`/`idFrom` over large exports.
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
`Pohoda.exe /XML` jobs through `utmctl`:

```bash
POHODA_UTM_VM=Windows npm run test:integration:utm
```

Optional variables:

| Variable | Description | Default |
| --- | --- | --- |
| `POHODA_UTMCTL` | Path to `utmctl` | `/Applications/UTM.app/Contents/MacOS/utmctl` |
| `POHODA_UTM_EXE_PATH` | Guest path to `Pohoda.exe` | `C:\Program Files (x86)\STORMWARE\POHODA\Pohoda.exe` |
| `POHODA_UTM_USERNAME` / `POHODA_UTM_PASSWORD` | POHODA credentials in the VM | `Admin` / empty |
| `POHODA_UTM_ICO` | Demo/company ICO | `12345678` |
| `POHODA_UTM_DATABASE` | Explicit database selector; otherwise discovered live | empty |
| `POHODA_UTM_MUTATION` | Also run demo-marked create tests | `0` |

The safe integration pass covers accounting-unit discovery, every supported read/list
agenda, safe raw XML, safe raw XML batch, and same-database queue serialization. With
`POHODA_UTM_MUTATION=1`, it also creates uniquely marked demo address, stock, order,
and invoice records.

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
