/**
 * Czech texts for the review workbook and inspect results. Policy errors and warnings
 * carry a machine code (kept in structured metadata); only these localized texts are
 * shown to the reviewer. Notes written by the caller are never translated or rewritten.
 */
import { ExpensePolicyError, type ExpensePolicyNotice } from "../pohoda/expense-policy.js";

type Params = Record<string, string>;
/** `message` is shown to the reviewer; `code`, `field` and `detail` are technical metadata. */
export type ReviewIssue = { code: string; field?: string; message: string; detail?: string };

const BUCKETS: Record<string, string> = { low: "12 %", high: "21 %", third: "3. sazby" };
const FIELDS: Record<string, string> = { accounting: "Předkontace", text: "Text dokladu", classificationVAT: "Členění DPH" };

/** Czech amount, e.g. "1 201,40" (input as formatted by the policy, "1201.40"). */
export function czechAmount(value: unknown): string {
  const n = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) return String(value ?? "");
  return n.toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\s/g, " ");
}

export function czechDate(value: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value ?? "");
}

const signed = (value: string | undefined) => {
  if (value === undefined) return "";
  const amount = czechAmount(value);
  return Number(value) > 0 ? `+${amount}` : amount;
};

const ISSUES: Record<string, (p: Params) => string> = {
  SUMMARY_MISMATCH: (p) => p.bucket
    ? `Základ a DPH ${BUCKETS[p.bucket] ?? p.bucket} (${czechAmount(p.base)} + ${czechAmount(p.vat)}) nedávají vytištěný součet ${czechAmount(p.gross)}; ověřte částky na dokladu.`
    : p.buckets !== undefined && p.rounding !== undefined
      ? `Součet základů a DPH ${czechAmount(p.buckets)} se zaokrouhlením ${signed(p.rounding)} dává ${czechAmount(p.sum)}, ale Celkem je ${czechAmount(p.total)}; ověřte zaokrouhlení a částku k úhradě na dokladu.`
      : `Součet částek ${czechAmount(p.sum)} neodpovídá částce Celkem ${czechAmount(p.total)}; ověřte částky na dokladu.`,
  SUMMARY_INCOMPLETE: (p) => `U sazby DPH ${BUCKETS[p.bucket ?? ""] ?? p.bucket ?? ""} chybí základ nebo DPH; doplňte obě částky z dokladu (DPH se nepřepočítává).`,
  SUMMARY_REQUIRED: () => "Chybí částky dokladu (základ a DPH nebo částka bez DPH).",
  TOTAL_REQUIRED: () => "Chybí částka Celkem k úhradě po zaokrouhlení.",
  AMOUNT_PRECISION: () => "Částka má víc než dvě desetinná místa nebo není číslo.",
  CASH_ROUNDING_UNCONFIRMED: (p) => `Hotovost ${czechAmount(p.total)} má haléře a doklad neuvádí zaokrouhlení; ověřte vytištěnou částku k úhradě a řádek zaokrouhlení (případně zaokrouhlení 0).`,
  SOURCE_ROUNDING_UNSUPPORTED: () => "Zaokrouhlení z dokladu nelze v POHODĚ zapsat přesně; ověřte doklad, částky se nemění.",
  SOURCE_ISSUE_DATE_REQUIRED: () => "Chybí datum vystavení dokladu.",
  SOURCE_TAX_DATE_REQUIRED: () => "Chybí DUZP z dokladu; neodvozuje se z data vystavení.",
  SOURCE_PAYMENT_DATE_REQUIRED: () => "Chybí skutečné datum úhrady z dokladu; doplňte je ve zdrojových datech a připravte novou kontrolu.",
  SOURCE_DOCUMENT_NUMBER_REQUIRED: (p) => p.threshold ? "Nad 10 000 Kč je nutné číslo dokladu dodavatele." : "Chybí číslo dokladu dodavatele.",
  SYMVAR_INVALID: (p) => `VS „${p.symVar ?? ""}“ není číselný; opište číselný VS z dokladu, nebo jej vymažte, pokud jej doklad nemá.`,
  PARTNER_COUNTRY_REQUIRED: (p) => `DIČ ${p.dic ?? ""} je zahraniční, ale chybí země dodavatele; doplňte ji z dokladu nebo registru.`,
  TEXT_REQUIRED: () => "Chybí text dokladu.",
  TEXT_TOO_LONG: (p) => `Text dokladu má ${p.length ?? "víc než 240"} znaků; POHODA dovolí ${p.max ?? "240"}. Zkraťte jej.`,
  VAT_CLASSIFICATION_REQUIRED: () => "Chybí Členění DPH z číselníku klienta.",
  TAX_MODE_CONFLICT: () => "Členění DPH neodpovídá režimu DPH (PN jen u nedaňového dokladu).",
  TAX_MODE_REQUIRED: () => "Režim DPH nelze určit automaticky; potvrďte daňový doklad, nebo PN.",
  TAX_MODE_INVALID: () => "Neplatný režim DPH.",
  VAT_STATUS_EVIDENCE_REQUIRED: () => "Status plátce DPH dodavatele nemá doložený zdroj; ověřte jej.",
  VAT_PERIOD_BEFORE_SOURCE: () => "Období DPH je dřív než datum dokladu; ověřte období.",
  DATE_PERIOD_MISMATCH: () => "Datum DPH je mimo období DPH nebo před datem dokladu.",
  DATE_INVALID: () => "Neplatné datum.",
  CARD_NOT_COMMITMENT: () => "Číslování platby kartou (řada PK) platí jen pro Ostatní závazek.",
  CARD_PAYMENT_TYPE_CONFLICT: () => "Platba kartou odporuje Formě úhrady.",
  FOREIGN_TAXABLE_SPLIT_UNSUPPORTED: () => "Doklad v cizí měně s DPH nelze přesně zapsat souhrnnými částkami; vyžaduje ruční kontrolu.",
  FOREIGN_ROUNDING_UNSUPPORTED: () => "Doklad v cizí měně nemůže mít samostatné zaokrouhlení; vyžaduje ruční kontrolu.",
  FOREIGN_THRESHOLD_NEEDS_CZK: () => "U cizí měny chybí ověřená částka v CZK pro pravidlo 10 000 Kč.",
  CURRENCY_RATE_INVALID: () => "Neplatný kurz.",
  CURRENCY_AMOUNT_INVALID: () => "Neplatné množství pro kurz.",
  ITEMS_NOT_ALLOWED: () => "Výdaje se importují jen souhrnnými částkami, bez položek."
};

const NOTICES: Record<string, (p: Params) => string> = {
  ROUNDING_DERIVED: (p) => `Zaokrouhlení ${signed(p.rounding)} odvozeno z částky k úhradě ${czechAmount(p.total)} a součtu ${czechAmount(p.sum)}; ověřte je na dokladu.`,
  VAT_RATE_UNUSUAL: (p) => `DPH ${czechAmount(p.vat)} neodpovídá sazbě ${p.rates ?? ""} % ze základu ${czechAmount(p.base)}; ponecháno podle dokladu.`,
  VAT_WITHOUT_BASE: (p) => `DPH ${czechAmount(p.vat)} bez základu; ponecháno podle dokladu.`,
  PN_COLLAPSED: () => "PN: DPH dodavatele je součástí částky Bez DPH / PN; původní rozpis zůstává v interní poznámce.",
  SOURCE_DOCUMENT_NUMBER_MISSING: () => "Chybí číslo dokladu dodavatele.",
  SYMVAR_NOT_NUMERIC: () => "Doklad nemá číselný VS; VS zůstane prázdný.",
  SYMVAR_DERIVED: (p) => `VS ${p.symVar ?? ""} odvozen z čísla dokladu ${p.documentNumber ?? ""} (doklad VS neuvádí).`,
  SYMVAR_NOT_DERIVED: () => "Doklad nemá VS a z čísla dokladu jej nelze odvodit; VS zůstane prázdný.",
  FOREIGN_RATE_UNKNOWN: () => "Cizí měna: částku v CZK určí kurz nastavený v POHODĚ.",
  PARTNER_VAT_COUNTRY_DIFFERS: (p) => `DIČ ${p.dic ?? ""} je registrace ${p.dicCountry ?? ""}, země dodavatele je ${p.country ?? ""}; ověřte zemi a režim DPH.`
};

const GENERIC_ISSUE = "Zdrojové údaje nejsou úplné nebo si odporují; ověřte doklad.";

/** Czech text of a policy failure (ExpensePolicyError or a `{code, params}` issue). */
export function czechPolicyIssue(issue: { code: string; params?: Params }): string {
  return ISSUES[issue.code]?.(issue.params ?? {}) ?? GENERIC_ISSUE;
}

export function czechPolicyNotice(notice: ExpensePolicyNotice): string | undefined {
  return NOTICES[notice.code]?.(notice.params ?? {});
}

/** Known non-policy review errors (raised by the review workflow itself). */
export const REVIEW_TEXT = {
  sourcePdfRequired: "Chybí zdrojové PDF.",
  sourcePagesRequired: "Chybí čísla stran zdrojového PDF.",
  cashAccountRequired: "Chybí pokladna (u pokladního výdeje je povinná).",
  invoiceType: "Přijatá faktura musí být typu Přijatá faktura nebo Ostatní závazek.",
  invalidIco: "Neplatné české IČO dodavatele; ověřte jej na dokladu.",
  supplierChanged: "Dodavatel byl změněn; potvrďte název a adresu nového dodavatele, nebo připravte novou kontrolu.",
  vatTreatment: "Režim DPH dodavatele nelze z registru jednoznačně určit; potvrďte daňový doklad, nebo PN.",
  registryAmbiguous: "Dodavatel není v registru jednoznačný; ověřte IČO.",
  registryNotFound: "IČO nebylo v ARES nalezeno; ověřte je na dokladu.",
  registryUnavailable: "Registr ARES nebyl dostupný; dodavatel nebyl ověřen.",
  noSupplier: "Chybí IČO i název dodavatele; historie v POHODĚ nebyla prohledána.",
  itemsDropped: "Položky byly vynechány; výdaje se importují jen souhrnnými částkami.",
  supplierName: (source: string, registry: string) => `Název dodavatele neodpovídá ARES (doklad: ${source}; registr: ${registry}); ověřte IČO.`,
  registryCountry: (country: string, dicCountry: string, dic: string) => `Země z registru podle IČO (${country}) se liší od DIČ ${dic} (${dicCountry}); ověřte zemi a IČO podle dokladu.`,
  unsupportedField: (field: string) => `Pole ${field} není součástí kontroly a bylo ignorováno.`,
  vatPeriodReplaced: (given: string, period: string) => `Období DPH dokladu ${given} nahrazeno obdobím kontroly ${period}; potvrďte.`,
  notExpense: (type: string) => `Typ faktury ${type} není výdaj; připravte novou kontrolu jako Přijatou fakturu nebo Ostatní závazek.`,
  historyTextTooLong: (max: number) => `Text z historie je delší než ${max} znaků a nebyl použit; zadejte krátký text.`,
  historyChoices: (field: string, count: number, values: string[]) => `Historie má ${count} ${count >= 5 ? "různých hodnot" : "různé hodnoty"} pole ${FIELDS[field] ?? field} (${values.join(" | ")}); vyberte jednu.`,
  historyCashAccounts: (accounts: string[]) => `Pokladny v historii: ${accounts.join(", ")}.`,
  textLength: (length: number, preferred: number) => `Text má ${length} znaků; stačí krátký popis do ${preferred} znaků (např. Materiál).`,
  pdfNotFound: (path: string) => `Zdrojové PDF nebylo nalezeno: ${path}`,
  writtenAs: (label: string, shown: string, written: string) => `${label} „${shown}“ se do POHODY zapíše jako „${written}“; přepište buňku na „${written}“.`
} as const;

/** Czech message plus machine code for any error raised while validating a review row. */
export function reviewIssueOf(error: unknown): ReviewIssue {
  if (error instanceof ExpensePolicyError) return { code: error.code, ...(error.field ? { field: error.field } : {}), message: czechPolicyIssue(error) };
  if (error instanceof ReviewRowError) return { code: error.code, message: error.message };
  return { code: "REVIEW_ERROR", message: GENERIC_ISSUE, detail: error instanceof Error ? error.message : String(error) };
}

/** A review-row problem whose message is already Czech. */
export class ReviewRowError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ReviewRowError"; }
}
