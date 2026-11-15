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

### Independent rule check (`opus55r2`, 14 November 2026)

A second live suite, `tests/pohoda-bank-rules.integration.test.ts`, runs the December
statement through the registered `process_bank_statement` MCP tool (SDK server, zod
input) on the production `PohodaClient`. It passed 7/7 after three matching fixes, and
the original 4 bank checks were rerun (`opus55b2`) and passed:

- A no-VS row could take an invoice by amount before a later row whose VS matched it.
  VS matches now run first.
- Two same-amount rows competing for one invoice settled the first one. They now stay
  untouched, and a VS whose documents are already used never falls back to amount.
- A legacy unmarked bank entry with other/no statement numbering was not detected, so
  a second bank record would be created. It is now a `needs_review` row.

Verified live: own account `TSB2` among three accounts (from account number and IBAN, with a counterparty account
on every row), statements 010/011/012, kept movement gaps and payment dates; the oldest
same-VS invoice with another amount, same-amount ambiguity, the competing rows and
the legacy entry all stay unwritten with unchanged balances; remaining balance after
an earlier partial payment, and an incoming receipt to an issued invoice, settle with a
`bank` liquidation link (ID, amount, date) and zero remaining; checks render only
beside settled rows in a copy (crop preserved, source bytes unchanged); a renamed
copy and a lost response after a real write both retry without new bank records; an
all-unmatched statement writes nothing; EUR previews but execution is refused before
any XML request. Statement values are read back from a synthetic text-layer PDF;
OCR of scanned statements is not tested. Offline: 1000 movements use one write
and 31 bounded reads. Evidence: `tests/output/bankrules-opus55r2.json` and
`tests/output/bankrules-opus55r2/`.

### Liquidation-state variants (`bankvar`, 14 November 2026)

A reported client preview failed with “POHODA did not export the invoice liquidation
state”. The client XML was not available, so its specific cause is **not proven**.
The demo reproduced the same message, read-only, with the previous code
(`tests/output/bankvar-oldrepro.json`): the bank scan reads all six liquidable
agendas, and one valid zero-total invoice aborted the whole preview.

The demo exported these `inv:invoiceHeader/inv:liquidation` shapes (`typ:liquidationType`;
the XSD makes every child optional and gives no semantics for omitted ones). Evidence is in
`tests/output/bankvariants-bv1*`, `bankvariants-bv2*` and `bankvar-bvlive1*`:

| Document | Exported state |
| --- | --- |
| Unpaid CZK (all six agendas incl. advances) | `amountHome` = remaining amount |
| Partially paid CZK | `date` + `amountHome` (remaining) |
| Fully paid (received/issued invoice, commitment, receivable, both advance types; EUR) | `date` only |
| Unpaid / partially paid EUR | `amountHome` + `amountForeign` (+ `date` once partially paid) |
| Zero total | empty `<inv:liquidation/>`, no `liquidations`, also with `lst:liquidations` |
| Negative document | negative `amountHome` |
| Storno pair | `storno` = `cancelledDocument` / `cancelDocument` (an enum, not a boolean), `date` only |

Corrective tax documents are listed only under their own invoice type; CZ
`receivedCreditNotice` imports are rejected (“Nesprávný typ dokladu”). An EUR bank
liquidation with an explicit bank rate on the EUR account was accepted. Automatic
execution still does not support it.

Changes: each document is classified separately. Live shapes are known. A zero total
counts as settled only after a `lst:liquidations` read shows no allocations. A
missing or empty state, a missing foreign remaining amount, an invalid amount, ID or
date, or a missing type is unknown. It is never treated as zero, paid or the original
total, and the remaining amount is never computed from totals minus allocations.
Unknown documents are re-read by ID with liquidations, at most 1000 per preview. Those
still unresolved are listed in `diagnostics` (agenda, id, number, field, problem,
blocking movements, link count), with no partner data or raw XML. They never match.
They block only payments they could compete with: the same direction/currency and VS,
or for amount-only rows the same or an unknown amount. These rows are `needs_review`
with `blockedBy`. The rest of the plan stays valid, and `execute=true` writes only
those other matches. Cancelled and cancelling documents are now excluded as storno.
A failed global scan is still fatal, with a precise read-only message.

Live (`bvlive1`, 5/5): shapes as in the table above. The MCP preview gives the full plan
with zero-total and storno documents present (both zero-total demo invoices resolved
by the targeted read; storno and paid-advance payments unmatched; received advance
matched). A proxy hid one invoice's state from every read. The preview stayed
usable, with that ID in `diagnostics` and its VS row plus two amount-only rows
`needs_review`. Execute wrote and verified only the two unaffected settlements
(zero remaining, bank link with ID/amount/date, two PDF checks). The blocked
invoices, storno and paid documents stayed unchanged, and a renamed retry wrote
nothing. Entry point: `tests/pohoda-bank-variants.integration.test.ts`.
After the change, the original live bank suites passed again: `pohoda-bank` 4/4
(`bvreg1`) and `pohoda-bank-rules` 7/7 (`bvreg2`, evidence `tests/output/bankrules-bvreg2*`).

### Write results and input limits (`wfix11141941`, 14 November 2026)

`tests/pohoda-bank-write-results.integration.test.ts` passed 5/5 on the current
working tree (POHODA 14302.10, verified `12345678_2026.mdb`, ICO 12345678, seven
identity checks). Through the registered MCP tool, a 59-movement statement
matched 34 targets across all six liquidable agendas. Execute wrote one 34-item
pack (`write`: 34 created, 0 rejected, 0 uncertain). Read-back confirmed 34
links with zero remaining balance. A renamed retry wrote nothing.

Bank `text` is limited to 96 characters (`string96`) and `symVar` to 20
(`string20`). With 97-character text or a 21-character VS, the MCP tool returned
a schema error for both preview and execute, with zero POHODA exchanges. Text of
exactly 96 characters and a VS of exactly 20 characters were stored unchanged
(bank IDs 236 and 238), and settled with links and zero remaining balance.

A demo-only raw XML pack in the test harness (not an MCP tool) sent the oversized
values directly. POHODA answered item `state="error"` with “violates maxLength
constraint of '96'/'20'” and no record ID. `classifyBankWriteResponse` classified
both items as `rejected`; no bank record was created, and both target documents
stayed unpaid with no links. Evidence: `tests/output/bankwrite-wfix11141941*`.
These limits are proven POHODA schema rejections. This run does not show that
they caused any client failure.

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

### Daňová evidence liquidation branch (live-verified)

A client run on a POHODA daňová evidence unit rejected all 34 liquidations with
errno 114 (“Likvidací dokladu nesmí vzniknout přeplatek” / “neplatné položky pro
likvidaci”) and warning 602 at `bnk:liquidationItem/bnk:homeCurrency` (“Hodnota se
nepoužívá u zvoleného typu záznamu”). bank.xsd defines `homeCurrency`/`foreignCurrency`
(`bnk:unitPrice`) for double-entry units and `homeCurrencyJU`/`foreignCurrencyJU`
(`typ:unitPrice`, “pouze pro JU a DE”) for daňová evidence. `process_bank_statement`
now reads the live `unitType` for the exact database and ICO once per run, sends the JU
branch for `singleEntry`, and refuses execute=true before writing if the type is unknown.
The JU price node alone was insufficient. The live tests showed that each source VAT
bucket needs its own liquidation item: `payVAT=false`, the corresponding `rateVAT`,
and `homeCurrencyJU` containing `typ:unitPrice` and `typ:price` equal to the base and
`typ:priceVAT` equal to the exact source VAT. A gross-only item was rejected for a VAT invoice.

Run `rootde1` on POHODA 14302.10 passed all five tests in the positively identified
`MCPTEST DE Bank s.r.o.` unit (`11223341_2026.mdb`, IČO 11223341, `singleEntry`).
The old XML reproduced warning 602 plus error 114. The registered MCP tool then settled
seven documents (received/issued invoices at 0% and 21%, a commitment and both advance
types), verified their links and zero remaining balances, and retried without new records.
Created bank IDs: 44, 46, 48, 50, 52, 54, 56. Evidence: ignored `tests/output/bankde-rootde1.json`
and its XML folder. These were test records only; no client unit was changed.

The existing double-entry integration suite also passed all four tests in run
`rootpu1` against `12345678_2026.mdb` (53.67 seconds of tests), including settlement,
unmatched payments and duplicate-free retries.

The DE path does not guess VAT allocation after partial payment, for rounding or for an
unsupported third or historical VAT bucket: those rows remain `needs_review` before writes. The double-entry
path retains its previous exact-remaining-amount behavior. Foreign-currency execution remains blocked.


### Per-document PDF attachments

Expense imports now archive the original PDF unchanged and attach a PDF containing
only the document's canonical sourcePages. Whole-source documents reuse the original.
Offline tests verify page content/order, multi-page documents, crop/rotation, invalid
pages before writes, stable retries and preservation of the original bytes. A 220-document
fixture shares source parsing and uses bounded archive writes. Legacy full-source links
are reported for review without duplicating or changing existing accounting records.
Live POHODA attachment acceptance remains covered by the existing shortcut mechanism;
this new page-extraction path has not yet been run through POHODA in this change.


### Latest expense conventions

Received invoices and commitments use the printed due date, or their original issue
date if the source has no due date. This does not shift with the VAT period.
The preview keeps Datum splatnosti visible; cash vouchers leave it empty because
`voucherHeader` has no due-date element. A card-paid cash voucher is rejected for
reclassification as a commitment; an actual invoice paid by card remains an invoice.
Policy/workbook/XML tests cover these distinctions and edits to the derived due date.

Fuel descriptions use `PHM nafta` or `PHM benzín`. Unambiguous fuel components in mixed
texts are normalized while preserving the other items; ambiguous descriptions remain
unchanged. Tests cover mixed items, accents, idempotency and preview/import consistency.


### Bank document fields and right-side marks

Live runs `bt2` (new partner/text suite, 3/3), `btde2` (DE, 5/5),
`bt2rules` (7/7), `bt2variants` (5/5), `btwrite-results` (5/5), and
`btbase2` (4/4) used only positively identified MCPTEST units. The new suite
covered all six agendas, linked and inline partners, blank movement fields,
document-purpose text, length limits, legacy records and duplicate-free retries.
PU generated “c.” and DE “č.”; the service learns the unit's existing convention
and checks POHODA's generated item text. Evidence is under ignored
`tests/output/banktext-bt2*` and `tests/output/bankde-btde2*`.

Only rows with status settled receive right-margin checks. Offline rendered-pixel
tests cover all four page rotations and cropped pages. Existing settled records
with differing partner/text/movement fields are reported for manual review and
never rewritten. Partners with extra phone/email fields have not been tested live.
