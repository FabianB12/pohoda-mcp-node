# Verification: reviewed expense imports

Verified on 14 November 2026 against POHODA 14302.10 in an isolated Parallels
Windows 11 unit, **MCPTEST Demo s.r.o.**, database `12345678_2026.mdb`.
No client accounting unit was used. Test records remain in the demo unit.

The final production run (`p4root`) passed all **9 live tests** through:

`XLSX prepare → workbook edit → approved import → ExpenseImporter → PohodaClient → POHODA /XML → read-back`.

| Behavior | Verified result |
| --- | --- |
| Preview preparation | Reads existing records; creates no accounting records. |
| Source VAT and supported rounding | Exact rate buckets and final payable retained. A source rounding adjustment with no exact POHODA mode is rejected before writing. |
| Late invoice | Issue, VAT, accounting and KH dates move to the first day of the selected period; originals remain in the internal note. |
| PN | Whole source gross in zero-rate amount; no KH date. |
| Supplier | Address-book link and supplier flag retained. |
| Source PDF | Requested Czech archive path retained; guest file exists and its SHA-256 matches. |
| Card numbering | Requested PK number retained; small purchase gets K/VS from its suffix. A large purchase keeps its source references; the following small purchase continues the sequence. |
| Cash threshold | At CZK 10,000 after rounding, Doklad is blank. At CZK 10,000.01 it is the source number. Actual payment date is retained. |
| Configured exchange rate | Omitted EUR rate uses the demo's configured CNB rate. A placeholder rate of 1 is reported for review with the created ID retained. |
| Retry | A fresh review of the same PDF/source records matches stored markers and creates no duplicates. |
| List paging | `idFrom` is inclusive; count and document-date filters work on the tested version. |

The run's detailed local evidence is in `tests/output/production-p4root.json` and
`tests/output/production-p4root/` (ignored by Git). The test entry point is
`tests/pohoda-production.integration.test.ts`.

## Preview duplicate checks

A subsequent read-only demo run (`duppreview`, 14 November 2026) passed all three
checks: list paging, preview preparation without accounting writes, and detection of
an already posted invoice by supplier ID and source reference. The duplicate snapshot
read all three expense agendas in one XML request. Evidence is in
`tests/output/duplicate-preview.json` (ignored by Git).

Offline coverage includes older entries outside recent examples, renamed source PDFs,
reference-less receipts and internal K references, duplicate rows within a batch,
incomplete/failed paging, refresh without losing workbook edits, and a 500-row batch
using one shared POHODA read. Duplicate results use coloured rows and short review notes, without a separate status column, and are
never imported as accounting fields. An all-duplicate 88-document batch also produces the full editable workbook, keeps
source discrepancies and returns `nextAction: deliver_workbook`, including on reuse.
After the preview-layout and source-evidence checks, the full offline suite passes 349 tests. The re-saved client XLSX also opens through the compatibility loader without modifying its source file.

## Bank statement settlement

The final `bankfinal001` live run on the same isolated demo passed all four tests
(three CZK workflow checks plus the foreign-currency fail-before-write check):

- A statement identifies the second bank account (`TSB2`, ID 3) instead of the default KB account.
- January exports as statement number `001`, with source movement numbers unchanged.
- Two equal variable symbols settle the older invoice first; unique exact-amount matching also works.
- Only three exact matches create bank records. One wrong-amount transaction and one unmatched transaction stay untouched.
- The invoice's remaining balance becomes zero, with an exported liquidation link to the corresponding bank ID.
- The output PDF has checks only for those three verified payments, and the original bytes stay unchanged.
- Repeating the same input adds no bank entries.

Evidence: `tests/output/bankfinal001.json` and `tests/output/bankfinal001/`. Its new
source invoice IDs are 47, 48, 49, 50; created bank IDs are 16, 18, 20. They are all
`MCPTEST` fixtures, not client accounting data. `tests/pohoda-bank.integration.test.ts`
reproduces the checks with explicit demo and write gates.

A separate EUR experiment (`bankeur001`) found a real XML limitation: omitting the
bank exchange rate produces error 130, “Zadejte kurz cizí měny”, even when the unit
has a configured EUR rate. No EUR bank record was created; test invoice 46 remains
unpaid. Therefore non-CZK **execution is blocked before any write** until a verified
bank-rate path is implemented; read-only matching remains available. This differs
from ordinary foreign-currency invoice import. The account builder also now uses
the schema's `daily`/`fixed` rate mode instead of an invalid numeric value.

Official schema references: [bank liquidation items](https://www.stormware.cz/schema/version_2/bank.xsd),
[invoice liquidation state](https://www.stormware.cz/schema/version_2/invoice.xsd),
and [bank account rate modes](https://www.stormware.cz/schema/version_2/bankAccount.xsd).

## Deployment requirements and limits

- Enable **Používat složku dokumentů firmy** in the target POHODA unit.
- The tested Czech archive path requires a Czech-compatible Windows system locale
  (ANSI 1250). It did not survive unchanged on the original English ANSI 1252 VM.
- Use the target unit's real VAT classifications. POHODA can default an unspecified
  taxable card purchase to PN; the importer therefore requires the classification.
- Invoice external IDs are not reliable for lookup on the tested version. Preserve
  the generated `MCP-ID:` internal-note line used for duplicate checks.
- XML cannot preserve foreign-currency VAT buckets in the required summary-only
  format. Those cases require review; the server does not discard VAT or add items.
- A rate missing from POHODA's configured list can become 1. The read-back detects
  that result and reports it instead of treating the import as verified.
- Unsupported rounding is a review case, not permission to change source amounts.

Offline tests additionally cover edited/cleared cells, immutable review identity,
approval/version checks, formula rejection, hidden rows, supplier ambiguity, registry
evidence invalidation, partial retries and source-PDF copy failures.
