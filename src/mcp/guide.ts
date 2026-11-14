import { DEFAULT_PDF_ARCHIVE_ROOT } from "../pohoda/pdf-archive.js";

/** Canonical operator guidance. Both the resource and fallback tool serve this object. */
export const POHODA_GUIDE_URI = "pohoda://guide";

/** Sent during MCP initialization; hosts decide how to present it to the model. */
export const POHODA_SERVER_INSTRUCTIONS = [
  "POHODA accounting server using the XML CLI. Before processing documents, read pohoda://guide; if resource access is unavailable, call get_usage_guide. Read it once per conversation and again after a context reset.",
  "A request to process client PDFs is complete only after delivering a linked editable XLSX preview, then waiting for user review. Duplicates and discrepancies belong in that preview, even if every document is already in POHODA; they are not reasons to stop before creating it. Use prepare_expense_review -> inspect_expense_review -> import_expense_review with approved=true and the inspected workbook hash. Processing documents alone is not approval to import.",
  "Discover the correct client/year and pass databaseId explicitly; obtain the VAT period. Preserve source amounts, use short document descriptions, and keep review notes out of POHODA. PDF imports must archive and link the original source.",
  "The server validates expense policy and reports stored-field differences. Do not blindly retry created or uncertain writes. Full rules, supported tools, limitations and client-specific conventions are in the guide."
].join("\n");

export const POHODA_USAGE_GUIDE = {
  access: {
    resource: POHODA_GUIDE_URI,
    fallbackTool: "get_usage_guide",
    scope: "Canonical instructions for agents using this MCP. Read before processing documents and after a context reset; avoid reloading the same guide on every tool call.",
    delivery: "Server instructions are sent at initialization. Whether a host injects them or automatically reads resources depends on that host; publishing a resource does not itself load it into model context."
  },
  integration: "Use only the POHODA XML CLI workflow. Old HTTP, mServer, PHP and profile-based instructions are legacy.",
  clientContext: {
    period: "Confirm the client/year and VAT period YYYY-MM. Never infer the VAT month from the database filename. If a critical fact is missing, ask a focused question rather than guessing.",
    codebooks: "Read the client's own codebooks, cash registers, accounting assignments and number series. Historical examples from another client/year are not defaults.",
    localConventions: "Keep client-specific accounting mappings in the client's workspace configuration, explicitly scoped to client and year. A workspace AGENTS.md may hold those local facts and a pointer to this guide; do not duplicate the full general guide there."
  },
  sourceExtraction: {
    facts: "Extract supplier identity, source document number, original issue date, original DUZP/DPPD when present, due date, actual payment date, currency, exact net/VAT/gross buckets, rounding and payment method.",
    uncertainty: "Never invent an unreadable value or derive an unreadable DUZP from the issue date. Put uncertainty in reviewNotes, resolve it with the user, or leave the row marked Prověřit.",
    boundaries: "A page is not automatically one document. Reconcile adjacent continuation pages and duplicates. Reader agents return sourcePages, document boundaries and uncertainties; only the parent prepares the review.",
    currencies: "Distinguish the actual document/payment currency from an informational CZK/EUR conversion printed on the source."
  },
  authorization: {
    preparation: "Preparing or inspecting a workbook does not authorize accounting writes. A request to process client documents means preview first.",
    otherActions: "Create or edit accounting records only when requested. Printing and email require an explicit target, accounting unit, report and recipient as applicable.",
    limits: "approved=true is a tool argument, not independent proof of human consent. The agent must obtain an explicit import instruction from the user."
  },
  defaultExpenseWorkflow: {
    intent: "A request to process PDFs for a client means prepare an editable XLSX preview, not permission to import.",
    completion: "Deliver the actual editable XLSX using workbookPath as a file link, with a brief count of rows needing review. A chat summary, duplicate counts or findings alone do not complete preparation. Include every extracted source document, even when all documents already exist in POHODA. Mark duplicates and discrepancies Prověřit; never silently omit them or change the source to match POHODA.",
    stopping: "During preparation, stop for review means flag the affected row and continue creating the workbook, not end the task or wait for permission to prepare it. Unknown VAT treatment, rounding discrepancies, missing nonessential fields and uncertain extraction belong in the preview. Ask only for context essential to select the client/year or VAT period, or explain a technical failure that prevents producing the file. An explicit user stop, cancellation or request for analysis only overrides preview delivery.",
    prepare: "Discover the unit and VAT month, extract source fields, then call prepare_expense_review. It checks existing received invoices, other liabilities and cash expenses for duplicates across the selected database, reuses those records for similar-client examples, and writes a workbook without changing POHODA.",
    duplicates: "Duplicate rows are pink with a short reference in the existing review note (e.g. Duplicita: PK26007 (#72)); matching fields get a stronger tint. The check uses matching source PDF/pages, supplier plus document number, or (when a reference is missing) supplier plus exact amount/currency/date. Matches and incomplete checks are marked Prověřit; never silently delete or skip them. Explain the match and let the user decide. No match is not a guarantee of uniqueness. Re-preparing the same review refreshes checks while preserving edited cells; import checks current POHODA state again.",
    performance: "Prepare all extracted documents for one client in one call (up to 500 rows). The server batches paged POHODA reads, reuses the snapshot for history, indexes matches locally and hashes each source PDF once. Do not issue per-document duplicate searches. The full workbook contains all rows; the initial tool response limits detailed row previews to 20.",
    review: "First deliver the workbook, then wait for user review and edits. Use inspect_expense_review to read the edited file. Keep uncertainties in the review-notes column; never copy these notes into POHODA text or intNote.",
    import: "Only after an explicit user instruction to import, call import_expense_review with approved=true, reviewId, the edited workbookPath, the same databaseId and expectedWorkbookSha256 from the latest inspect_expense_review. It reads the exact inspected version and rejects unresolved or hidden rows, formulas and invalid data. A cleared cell must stay cleared; never restore cached extraction values.",
    presentation: "Keep the review concise: no extra status columns, no success messages or per-row timestamps, and no routine explanations. Use short actionable notes only; normal rows stay blank. Yellow marks fields needing correction, pink marks duplicates, grey marks skipped rows. Keep the detailed import plan collapsed; full evidence remains in the manifest and tool results.",
    descriptions: "Prefer short category descriptions, e.g. Materiál instead of a list of cement, concrete and timber. Historical examples inform conventions but never override source amounts, VAT or explicit user rules."
  },
  listing: {
    targetDatabase: "For accounting-unit-specific tools, pass databaseId explicitly using a registry id or exact POHODA database name. POHODA validates dat:dataPack ico against the selected unit, so prefer registry/live discovery rows that include ICO; direct database filenames must contain an 8-digit ICO or match live discovery. current_database only shows the configured fallback; there is no select_database step. If databaseId is omitted and no default database is configured, the tool fails before running POHODA.",
    use: {
      list_documents: "Transactional documents; invoice requires invoiceType, order requires documentType. Use invoiceType=commitment for Ostatni zavazky, invoiceType=receivable for Ostatni pohledavky, and agenda=voucher for Pokladna cash documents.",
      list_stock: "Stock cards and inventory items.",
      list_contacts: "Address book records.",
      list_export_agenda: "Read-only codebooks/reference lists. Use agenda=activity to find Cinnosti ids before update/delete.",
      batch_list_records: "Several read/list requests for one accounting unit in a single POHODA /XML run.",
      list_balance: "Saldo/balance export for open receivables/payables by date and pairing mode."
    },
    efficiency: "Tools default server-side count to limit. Increase count only when needed; use idFrom for paging.",
    filters: "Prefer explicit filters first. extId requires extSystemName, but invoice extId filters are unreliable on POHODA 14302. Never infer that a document is absent from an extId filter alone."
  },
  scannedDocuments: {
    tool: "prepare_scanned_pdf",
    use: "Call once for PDFs containing scanned invoices or receipts. It renders pages concurrently, caches unchanged inputs, writes numbered page images, and inlines images by default. Reuse the images. Empty text extraction does not prove a blank scan. Defaults: JPEG, 180 DPI, quality 82; use explicit page ranges for large PDFs.",
    delegation: "When there are at least four independent pages/documents and sub-agents are available, give each sub-agent a disjoint set of returned page paths. Sub-agents extract only and return structured fields plus confidence and page-boundary notes. The parent reconciles multi-page documents, duplicates, totals, VAT, supplier/customer identity, and target accounting unit before any POHODA write.",
    writing: "After extraction, group expenses by databaseId and call prepare_expense_review. Return the editable workbook, wait for user review and an explicit import instruction, then call import_expense_review. Reader agents never create contacts or documents."
  },
  vatDates: {
    dateTax: "For received taxable documents, the deduction/delivery date that determines the VAT-return and control-statement reporting period.",
    dateKHDPH: "Expense imports preserve supplier's original DUZP/DPPD in sourceTaxDate and provenance. Late expense documents use day one of vatPeriod for KH as requested by this workspace; PN omits KH entirely. Other agendas retain source dates.",
    issuedInvoices: "Do not normally set dateKHDPH on an ordinary issuedInvoice. Issued corrective tax documents are an exception.",
    fallback: "Strict expense imports use the shared policy instead of guessing KH dates. PN/nonTax must omit dateKHDPH. A fallback remains only for other applicable agendas."
  },
  expensePolicy: {
    version: 2,
    inputs: "receivedInvoice, commitment and cash expense require vatPeriod, short header text, source dates, exact summary buckets and final total; provide roundingAmount when present. Items must be empty. Taxable expenses require classificationVAT from the client's codebook; POHODA's default can incorrectly be PN.",
    sourcePdfs: `PDF imports require sourcePdfPath and non-empty sourcePages. Originals are archived under ${DEFAULT_PDF_ARCHIVE_ROOT} in client/year subfolders and linked through the Documents tab. Archive once and link every document from that PDF. Do not substitute rendered page images for the original. sourceType=manual is only for non-PDF sources. Copy/link failure is not a completed import.`,
    suppliers: "Use lookup_supplier_registry for ARES identity and current VAT evidence. Expense creates resolve and verify supplier links; uncertain identities require review.",
    nonTax: "Automatically use PN only for a sufficiently confirmed Czech non-payer and a source with no VAT. Missing DIČ alone proves nothing. Foreign/EU documents need an explicit tax-mode decision. PN puts the whole original gross into priceNone and omits dateKHDPH. Registry status is current and does not independently prove status on an older source date.",
    dates: "Late invoice date/dateTax/dateAccounting/dateKHDPH use vatPeriod day one. PN has no KH. Cash datePayment stays actual.",
    numbering: "Cash expense Doklad only above CZK 10000 payable. cardPayment commitments use PK suffix N for KN/VS N at or below threshold, otherwise source references.",
    foreignCurrency: "Omit currencyRate for POHODA configured rate. Read back applied rate/amount. Do not drop unrepresentable foreign VAT splits or silently change currency.",
    rounding: "Preserve source VAT and rounding exactly. POHODA recomputes rounding from its mode; when no mode reproduces the source payable, flag the row Prověřit, still deliver the preview, and block that row from import until resolved. Summary-only XML cannot preserve foreign VAT buckets or a separate foreign rounding adjustment; these cases are not automatic imports.",
    verification: "Inspect ok, verified, differences, warnings and created IDs. Import acceptance does not prove the source was preserved. POHODA warnings never authorize changing source amounts. Preserve the generated MCP-ID: internal-note line for retry detection. If creation succeeded but verification failed, inspect the record rather than blindly re-import. After an authorized deletion, verify absence and refresh number series before a corrected import.",
    deployment: "For PDF links enable Používat složku dokumentů firmy in POHODA. The tested Czech archive path requires Windows ANSI code page 1250. A missing or placeholder exchange rate of 1 is a review failure."
  },
  writing: {
    use: {
      prepare_expense_review: "Read-only preparation of an editable XLSX for received invoices, other liabilities and cash expenses, including duplicate checks and similar client examples.",
      inspect_expense_review: "Read the user's edited workbook and report selected rows and review issues without importing.",
      import_expense_review: "Import the reviewed workbook only after the user explicitly requests it; verifies supplier, amounts, dates and PDF links.",
      create_invoice: "One non-expense invoice. Received invoices and commitments require the reviewed workbook workflow.",
      create_other_liability: "Direct creation is disabled. Use prepare_expense_review then import_expense_review for Ostatni zavazky.",
      create_other_receivable: "One Ostatni pohledavka; typed invoice XML with invoiceType=receivable.",
      create_cash_voucher: "One Pokladna cash receipt. Cash expenses require the reviewed workbook workflow; cashAccount is required.",
      manage_activity: "Add/update/delete one Cinnost. Update/delete require numeric POHODA id as matchId/id.",
      create_address: "One addressbook contact.",
      manage_address: "Add/update/delete one addressbook contact with action filters.",
      create_stock: "One stock card.",
      manage_stock: "Add/update/delete one stock card with id/extId/code matching.",
      create_order: "One order.",
      create_bank_document: "One Banka document.",
      create_internal_document: "One Interni doklad.",
      create_stock_receipt: "One Prijemka warehouse receipt.",
      create_stock_issue: "One Vydejka warehouse issue.",
      create_stock_transfer: "One Prevodka warehouse transfer.",
      create_production_document: "One Vyroba production document.",
      create_sales_receipt: "One Prodejka sales/POS receipt.",
      create_offer: "One Nabidka.",
      create_enquiry: "One Poptavka.",
      manage_contract: "One Zakazka/contract with optional plan items.",
      manage_centre: "Add/update/delete one Stredisko/Centre.",
      manage_store: "Create/import one store/warehouse setup record.",
      manage_storage: "Import storage classification/tree nodes.",
      manage_bank_account: "Add one bank account setup record; delete is not exposed by the current official schema.",
      manage_group_stock: "Add/update/delete stock groups and variants.",
      manage_parameter_definition: "Advanced optional parameter definitions for an agenda.",
      print: "One print/PDF/email output job.",
      batch_write: "Several typed write/output operations for one accounting unit in a single POHODA /XML run.",
      batch_create_invoices: "Convenience tool for several invoices, optionally with one addressbook contact before each invoice, in a single POHODA /XML run."
    },
    efficiency: "Expense writes go through one import_expense_review per reviewed client workbook; it batches internally. For other agendas, use batch_write for multiple writes in one unit or batch_create_invoices for non-expense invoices. Never mix accounting units in a batch.",
    ordering: "Operations run in the order supplied inside one dataPack. For batch_create_invoices, when createAddress is true, each contact is placed immediately before its invoice.",
    parallelism: "Do not mix accounting units in one batch. Send one batch per database; different database batches can run in parallel through the transport queue.",
    extras: "Broad document/setup tools expose typed common fields plus extraHeader, extraItem, extraData, or similar advanced fragments. Prefer typed fields; use extra fragments only with already-prefixed XML-object keys from the official POHODA schema."
  },
  xmlTransport: {
    queueing: "Same-database calls are serialized with a per-database lock. Different databases run in parallel up to the process cap.",
    batching: "Use batch_list_records when several typed reads are known up front and create_data_export_bundle for persisted exports. Expense documents always use the reviewed-workbook workflow. For other agendas, use batch_write or batch_create_invoices; raw_xml_batch is for unsupported advanced XML workflows and cannot bypass expense review.",
    freshness: "Normal list/create/status calls ask POHODA each time. list_xml_databases refreshes configured/filesystem sources each time. Export snapshots are intentionally point-in-time; create a new export after UI changes.",
    discovery: "Use list_accounting_units for official live discovery. It always asks POHODA and supports fuzzy query plus ICO, DIČ, city, database, and year filters; use cursors instead of asking for every client at once. list_xml_databases(includeLive=true) combines refreshed configured/filesystem sources with live POHODA sources.",
    idempotency: "Create/raw tools accept dataPackId for duplicate checking."
  },
  largeExports: {
    use: "Use create_data_export for one large dataset or create_data_export_bundle for several related datasets. They return compact preview rows, summary totals, opaque nextCursor values, and resource links to full JSON/NDJSON data.",
    paging: "Use read_export_page with the returned exportId and nextCursor. Cursors are opaque and expire with the export snapshot.",
    summaries: "Use summarize_export for totals without loading full records into model context. For invoice exports, summary.total/byCurrency/byPartner/byMonth are home-currency totals, normally CZK; foreign invoice totals are separate in summary.foreignCurrency keyed by currency code.",
    cleanup: "Use cleanup_export when the snapshot is no longer needed."
  }
} as const;
