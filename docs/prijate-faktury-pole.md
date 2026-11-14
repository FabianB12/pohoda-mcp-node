# Přijaté faktury: přehled polí a kontrola před importem

Výchozí postup je **PDF → upravitelný XLSX → kontrola uživatelem → výslovný pokyn
k importu → POHODA → kontrolní načtení výsledku**. Samotný pokyn „zpracuj doklady“
znamená připravit tabulku. Pro přípravu slouží `prepare_expense_review`, pro načtení
upravené tabulky `inspect_expense_review` a pro schválený import `import_expense_review`.

## Co vyplňujeme

| Pole v POHODĚ | Vstup / zdroj | Pravidlo tohoto projektu |
| --- | --- | --- |
| Účetní jednotka | `databaseId` | Vždy konkrétní klient a rok z živého seznamu jednotek. |
| Druh dokladu | `type` | Přijatá faktura; karetní nákup patří do ostatních závazků. |
| Dodavatel | `partnerId`, jméno, IČO, DIČ, adresa | Dohledat, případně doplnit přes ARES, založit jen chybějící kontakt a ověřit vazbu na adresář. Nejasnou shodu dát ke kontrole. |
| Evidenční číslo | `number` / číselná řada | Číslování POHODY; u karet se čte aktuální řada PK. |
| Doklad dodavatele | `sourceDocumentNumber` → `originalDocument` | Podle zdroje. U malých karet a pokladních výdajů platí výjimky níže. |
| Variabilní symbol | `sourceSymVar` → `symVar` | Podle zdroje; u malých karet pořadí řady PK. Zachovat počáteční nuly. |
| Text | `text` | Krátký popis, např. „Materiál“. Bez položek faktury a bez poznámek ke kontrole. |
| Vystaveno | `sourceIssueDate` → `date` | Podle dokladu. U opožděného dokladu první den zpracovávaného měsíce. |
| Datum DPH | `sourceTaxDate` → `dateTax` | Původní DUZP z dokladu; u opožděného dokladu první den zpracovávaného měsíce. |
| Datum KH DPH | `dateKHDPH` | U opožděného daňového dokladu také první den zpracovávaného měsíce. U PN prázdné. |
| Datum účetního případu | `dateAccounting` | U opožděné faktury první den zpracovávaného měsíce. |
| Splatnost | `dateDue` | Podle zdroje, pokud je uvedena; neposouvá se s obdobím DPH. |
| Předkontace | `accounting` | Podle klienta a typu nákladu; podobné doklady slouží jako podklad pro kontrolu. |
| Členění DPH | `classificationVAT` | Podle schváleného režimu. Nedaňový doklad má PN. |
| Členění KH DPH | `classificationKVDPH` | Pokud je pro daný doklad určeno. |
| Základy a DPH po sazbách | `priceNone`, `priceLow*`, `priceHigh*`, `price3*` | Přesná čísla ze zdroje v souhrnu dokladu. Nepřepočítávat DPH podle návrhu POHODY. |
| Zaokrouhlení | `roundingAmount` | Samostatně podle zdroje. |
| Celkem k úhradě | `total` | Konečná částka po zaokrouhlení; musí souhlasit se souhrnem. |
| Měna a kurz | `currency`, případně `currencyRate` | Neuvedený kurz přebírá POHODA ze svého nastavení. Nepoužívat náhradní kurz 1. Nepodporovaný rozpis cizoměnové DPH se zastaví ke kontrole. |
| Středisko, činnost, zakázka | `centre`, `activity`, `contract` | Jen podle známého přiřazení u konkrétního klienta. |
| Interní poznámka | `intNote` | Uchovává původní data a reference při přesunu období nebo změně polí. Poznámka ke kontrole z XLSX se sem nepřenáší. |
| Dokumenty / PDF | `sourcePdfPath`, `sourcePages` | Originál uložit do `C:\Účetnictví\PDF DOKLADY KLIENTŮ Z POHODY` a ověřit odkaz v POHODĚ. |

## Další pravidla

- **Český neplátce:** automatické PN pouze při ověřených údajích a dokladu bez DPH.
  Celá hrubá částka jde do nulové sazby a datum KH zůstává prázdné. Stav registru
  je aktuální; případná historická nejasnost vyžaduje rozhodnutí.
- **EU a jiné zahraniční doklady:** režim DPH musí být výslovně zvolen. Zahraniční
  dodavatel sám o sobě neznamená PN.
- **Opožděný doklad:** v období `2026-11` se příslušná data posunou na `2026-11-01`.
  Původní data zůstávají dohledatelná. Skutečné datum hotovostní platby se zachová.
- **Pokladní výdej:** pole Doklad jen při konečné částce **nad 10 000 Kč**.
  Částka 10 000,40 Kč zaokrouhlená k úhradě na 10 000 Kč má toto pole prázdné.
- **Karetní ostatní závazek:** do 10 000 Kč včetně např. `PK26004 → K4 / VS 4`.
  Nad limit zůstává řada PK, Doklad a VS se převezmou ze zdroje. Velký nákup
  také spotřebuje pořadí řady.
- **Kontrolní poznámky:** samostatný sloupec XLSX. Akce „Prověřit“ brání importu;
  „Vynechat“ řádek přeskočí. Před importem se načtou skutečně upravené buňky.

Podobné doklady z POHODY pomáhají s konvencemi klienta. Nejsou zdrojem pro změnu
částek, DPH nebo výslovných pravidel uživatele.
