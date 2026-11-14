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
