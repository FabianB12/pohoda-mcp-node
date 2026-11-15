import type { XmlObject } from './xml-builder.js';
import { toMinorUnits, fromMinorUnits, moneyValue } from './money.js';

export const SETTLEMENT_AGENDAS = ['receivedInvoice', 'commitment', 'issuedInvoice', 'receivable', 'receivedAdvanceInvoice', 'issuedAdvanceInvoice'] as const;
export type SettlementAgenda = typeof SETTLEMENT_AGENDAS[number];
export type VatRate = 'none' | 'low' | 'high';
/** One VAT bucket of the source document: base without VAT and its VAT, in home currency. */
export type VatBucket = { rate: VatRate; base: number | string; vat: number | string };
/** `vat` is required for daňová evidence: POHODA rejects a DE liquidation (errno 114) unless the items repeat the source VAT split. */
export type BankLiquidation = { agenda: SettlementAgenda; id: number; amount: number | string; vat?: VatBucket[] | undefined };

// bank.xsd: bankHeader/text is string96; type.xsd: symVarType is string20.
export const BANK_TEXT_MAX_LENGTH = 96;
export const BANK_SYMBOL_MAX_LENGTH = 20;
export function validateBankHeaderText(header: { text?: unknown; symVar?: unknown }): void {
  if (String(header.text ?? '').length > BANK_TEXT_MAX_LENGTH) throw new Error(`Text bankovního pohybu smí mít nejvýše ${BANK_TEXT_MAX_LENGTH} znaků. Zkraťte popis; částku ani VS neměňte.`);
  if (String(header.symVar ?? '').length > BANK_SYMBOL_MAX_LENGTH) throw new Error(`Variabilní symbol bankovního pohybu smí mít nejvýše ${BANK_SYMBOL_MAX_LENGTH} znaků. Ověřte VS na výpisu; nekrátí se automaticky.`);
}

/**
 * bank.xsd liquidationItem has separate price elements per accounting mode:
 * homeCurrency/foreignCurrency (bnk:unitPrice) for double-entry units and
 * homeCurrencyJU/foreignCurrencyJU (typ:unitPrice, "pouze pro JU a DE") for
 * daňová evidence. POHODA ignores the other branch (warning 602) and then
 * rejects the liquidation with errno 114, so the mode must be known, never guessed.
 */
export type AccountingMode = 'doubleEntry' | 'singleEntry';
const DOUBLE_ENTRY_UNIT_TYPES = new Set(['doubleEntry', 'doubleEntryNonProfit', 'doubleEntryAllowance']);
/** Maps accountingunit.xsd unitTypeType to the liquidation branch; unknown or missing values return undefined. */
export function accountingModeOf(unitType: unknown): AccountingMode | undefined {
  const value = typeof unitType === 'string' ? unitType.trim() : '';
  if (value === 'singleEntry') return 'singleEntry';
  return DOUBLE_ENTRY_UNIT_TYPES.has(value) ? 'doubleEntry' : undefined;
}
export type LiveAccountingUnit = { database: string; ico: string; unitType: string; accountingMode?: AccountingMode | undefined };
/**
 * Selects the live listAccountingUnit entry for the exact database file and ICO
 * the data pack targets. Both sides are compared by file name (the listing
 * reports a bare file name; a configured database may be a full path). Every
 * response item is scanned. Returns undefined when the unit is absent or ambiguous.
 */
const fileName = (value: unknown) => String(value ?? '').trim().split(/[\\/]/).pop()!.trim().toLowerCase();
export function findLiveAccountingUnit(data: Record<string, any>, database: string, ico: string): LiveAccountingUnit | undefined {
  const items: any[] = (Array.isArray(data?.items) ? data.items : []).flatMap((entry: any) => {
    const raw = entry?.data?.itemAccountingUnit;
    return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  });
  const want = fileName(database), wantIco = ico.trim();
  if (!want || !wantIco) return undefined;
  const hits = items.map((item) => {
    const address = item?.accountingUnitIdentity?.address ?? {};
    return { database: String(item?.dataFile ?? '').trim().split(/[\\/]/).pop()!.trim(), ico: String(address.ico ?? '').trim(), unitType: String(item?.unitType ?? '').trim() };
  }).filter((unit) => unit.database.toLowerCase() === want && unit.ico === wantIco);
  if (hits.length !== 1) return undefined;
  return { ...hits[0]!, accountingMode: accountingModeOf(hits[0]!.unitType) };
}

/**
 * Live POHODA 14302.10, daňová evidence: one liquidation item per VAT bucket of
 * the source document, payVAT=false, rateVAT and homeCurrencyJU with
 * unitPrice=price=base and priceVAT=VAT. A single gross item at rate none is
 * rejected with errno 114 for a 21 % invoice; unitPrice alone is rejected even for 0 %.
 * The split comes only from the source document's own summary (never recomputed)
 * and is valid only while nothing has been paid yet (remaining == total).
 */
export function sourceVatBuckets(raw: Record<string, any>, remaining: number | string): { buckets: VatBucket[] } | { problem: string } {
  const home = raw?.invoiceSummary?.homeCurrency;
  if (!home || typeof home !== 'object') return { problem: 'Doklad neexportoval rozpis DPH (invoiceSummary/homeCurrency).' };
  const amount = (key: string): number | undefined => {
    const value = moneyValue(home[key]);
    if (value === undefined || value === null || value === '') return 0;
    try { return toMinorUnits(value as number | string); } catch { return undefined; }
  };
  const parts = { none: amount('priceNone'), lowBase: amount('priceLow'), lowVat: amount('priceLowVAT'), highBase: amount('priceHigh'), highVat: amount('priceHighVAT'), thirdBase: amount('price3'), thirdVat: amount('price3VAT') };
  const round = moneyValue(home.round?.priceRound);
  let rounding = 0;
  try { rounding = round === undefined || round === '' ? 0 : toMinorUnits(round as number | string); } catch { return { problem: 'Neplatné zaokrouhlení dokladu.' }; }
  if (Object.values(parts).some(v => v === undefined)) return { problem: 'Rozpis DPH dokladu obsahuje neplatnou částku.' };
  for (const [field, expected] of [['priceLowVAT', 12], ['priceHighVAT', 21]] as const) {
    const value = home[field];
    const rate = value && typeof value === 'object' ? (value.rate ?? value['@rate']) : undefined;
    if (rate !== undefined && Number(rate) !== expected && amount(field)) return { problem: 'Historická sazba DPH vyžaduje ověření rozpisu likvidace v daňové evidenci.' };
  }
  if (parts.thirdBase || parts.thirdVat) return { problem: 'Doklad má třetí sazbu DPH; likvidace v daňové evidenci pro ni není ověřena.' };
  if (rounding) return { problem: 'Doklad má zaokrouhlení; rozpis likvidace v daňové evidenci pro zaokrouhlení není ověřen.' };
  const buckets: VatBucket[] = [];
  if (parts.none) buckets.push({ rate: 'none', base: fromMinorUnits(parts.none!), vat: 0 });
  if (parts.lowBase || parts.lowVat) buckets.push({ rate: 'low', base: fromMinorUnits(parts.lowBase!), vat: fromMinorUnits(parts.lowVat!) });
  if (parts.highBase || parts.highVat) buckets.push({ rate: 'high', base: fromMinorUnits(parts.highBase!), vat: fromMinorUnits(parts.highVat!) });
  const total = buckets.reduce((sum, b) => sum + toMinorUnits(b.base) + toMinorUnits(b.vat), 0);
  if (!buckets.length || buckets.some(b => toMinorUnits(b.base) < 0 || toMinorUnits(b.vat) < 0)) return { problem: 'Rozpis DPH dokladu je prázdný nebo záporný.' };
  if (total !== toMinorUnits(remaining)) return { problem: 'Doklad je částečně uhrazen nebo rozpis DPH nesouhlasí se zůstatkem; rozdělení úhrady podle sazeb se v daňové evidenci nedopočítává.' };
  return { buckets };
}

/** Import-only bankLiquidationItem creates the real payment link, not just a bank entry. */
export function buildBankLiquidationDetail(targets: BankLiquidation[], currency: string, accountingMode: AccountingMode): XmlObject[] {
  if (!targets.length) throw new Error('At least one liquidation target is required.');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Liquidation currency must be an ISO code.');
  if (accountingMode !== 'doubleEntry' && accountingMode !== 'singleEntry') throw new Error('Liquidation requires the verified accounting mode of the unit (doubleEntry or singleEntry); nothing was written.');
  const single = accountingMode === 'singleEntry';
  if (single && currency !== 'CZK') throw new Error('Daňová evidence liquidation is verified only in CZK; nothing was written.');
  const seen = new Set<string>();
  return targets.map((target) => {
    if (!SETTLEMENT_AGENDAS.includes(target.agenda) || !Number.isSafeInteger(target.id) || target.id <= 0) throw new Error('Invalid liquidation target.');
    const key = `${target.agenda}:${target.id}`;
    if (seen.has(key)) throw new Error('Duplicate liquidation target.');
    seen.add(key);
    const amount = toMinorUnits(target.amount);
    if (amount <= 0) throw new Error('Liquidation amount must be positive.');
    const settings = { 'bnk:sourceAgenda': target.agenda, 'bnk:sourceDocument': { 'typ:id': target.id }, 'bnk:liquidationPrice': fromMinorUnits(amount) };
    if (!single) {
      return { 'bnk:bankLiquidationItem': { 'bnk:settingsLiquidation': settings, 'bnk:liquidationItem': { 'bnk:quantity': 1, [currency === 'CZK' ? 'bnk:homeCurrency' : 'bnk:foreignCurrency']: { 'bnk:unitPrice': fromMinorUnits(amount) } } } };
    }
    const buckets = target.vat ?? [];
    const rates = new Set<string>();
    let sum = 0;
    const items = buckets.map((bucket) => {
      if (!['none', 'low', 'high'].includes(bucket.rate) || rates.has(bucket.rate)) throw new Error('Invalid VAT split for daňová evidence liquidation.');
      rates.add(bucket.rate);
      const base = toMinorUnits(bucket.base), vat = toMinorUnits(bucket.vat);
      if (base < 0 || vat < 0 || base + vat <= 0 || (bucket.rate === 'none' && vat !== 0)) throw new Error('Invalid VAT split for daňová evidence liquidation.');
      sum += base + vat;
      return { 'bnk:quantity': 1, 'bnk:payVAT': false, 'bnk:rateVAT': bucket.rate, 'bnk:homeCurrencyJU': { 'typ:unitPrice': fromMinorUnits(base), 'typ:price': fromMinorUnits(base), 'typ:priceVAT': fromMinorUnits(vat) } };
    });
    if (!items.length || sum !== amount) throw new Error('Daňová evidence liquidation requires the source VAT split matching the amount exactly; nothing was written.');
    // An array keeps sibling order: settingsLiquidation, then one liquidationItem per VAT bucket.
    return { 'bnk:bankLiquidationItem': [{ 'bnk:settingsLiquidation': settings }, ...items.map(item => ({ 'bnk:liquidationItem': item }))] };
  });
}

export function statementMonthNumber(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('Statement period must be YYYY-MM.');
  return period.slice(5).padStart(3, '0');
}

/**
 * Document-type abbreviations POHODA writes into the generated liquidation item
 * text (bankLiquidationItem/liquidationItem/text omitted: "Pokud nebude uveden,
 * bude nastaven text z Globálního nastavení"). Live POHODA 14302.10, all six
 * agendas: "Úhrada FP c. 261100113", FV, OZ, OP, PZ (přijatá záloha), VZ (vydaná záloha).
 */
export const LIQUIDATION_ABBREVIATIONS: Record<SettlementAgenda, string> = {
  receivedInvoice: 'FP', issuedInvoice: 'FV', commitment: 'OZ', receivable: 'OP', receivedAdvanceInvoice: 'PZ', issuedAdvanceInvoice: 'VZ'
};
/** Live default of the generated text when the unit has no own example: "Úhrada FP c. <number>". */
export const defaultLiquidationPrefix = (agenda: SettlementAgenda) => `Úhrada ${LIQUIDATION_ABBREVIATIONS[agenda]} c. `;
export type LiquidationTextConvention = { prefixes: Record<SettlementAgenda, string>; source: Record<SettlementAgenda, 'pohoda' | 'derived' | 'default'> };
const PREFIX_SHAPE = /^[^\d,;]{1,40}\s$/u;
const scalarText = (v: any): string => v == null ? '' : typeof v === 'object' ? scalarText(v['#text']) : String(v).trim();
const list = <T>(v: T | T[] | undefined | null): T[] => v == null ? [] : Array.isArray(v) ? v : [v];

/**
 * Learns the unit's own generated liquidation text ("<prefix><document number>")
 * from existing bank items whose trailing token is the number of exactly one
 * liquidable document. Agendas without an example reuse a learned prefix with
 * their own abbreviation, otherwise the live default. Never fails: the prefix is
 * a prediction that the post-write read-back compares with POHODA's own item text.
 */
export function learnLiquidationConvention(bankRows: Record<string, any>[], documents: { agenda: string; number: string }[]): LiquidationTextConvention {
  const owners = new Map<string, Set<string>>();
  for (const d of documents) if (d.number) owners.set(d.number, (owners.get(d.number) ?? new Set()).add(d.agenda));
  const counts = new Map<SettlementAgenda, Map<string, number>>();
  for (const raw of bankRows) for (const item of list<Record<string, any>>(raw?.bankDetail?.bankItem)) {
    const t = scalarText(item?.text), m = /^(.*\s)(\S+)$/su.exec(t);
    const agendas = m ? owners.get(m[2]!) : undefined;
    if (!m || !agendas || agendas.size !== 1 || !PREFIX_SHAPE.test(m[1]!)) continue;
    const agenda = [...agendas][0] as SettlementAgenda;
    if (!SETTLEMENT_AGENDAS.includes(agenda) || !m[1]!.includes(LIQUIDATION_ABBREVIATIONS[agenda])) continue;
    const c = counts.get(agenda) ?? new Map<string, number>(); c.set(m[1]!, (c.get(m[1]!) ?? 0) + 1); counts.set(agenda, c);
  }
  const prefixes = {} as Record<SettlementAgenda, string>, source = {} as LiquidationTextConvention['source'];
  const best = (c: Map<string, number>, fallback: string) => [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] === fallback ? -1 : b[0] === fallback ? 1 : a[0].localeCompare(b[0])))[0]![0];
  for (const agenda of SETTLEMENT_AGENDAS) {
    const c = counts.get(agenda);
    if (c?.size) { prefixes[agenda] = best(c, defaultLiquidationPrefix(agenda)); source[agenda] = 'pohoda'; }
  }
  // Template from any learned agenda: replace its abbreviation (whole word) with the missing agenda's.
  const template = SETTLEMENT_AGENDAS.find(a => source[a] === 'pohoda' && new RegExp(`(^|\\s)${LIQUIDATION_ABBREVIATIONS[a]}(\\s)`).test(prefixes[a]));
  for (const agenda of SETTLEMENT_AGENDAS) {
    if (source[agenda]) continue;
    if (template) { prefixes[agenda] = prefixes[template].replace(new RegExp(`(^|\\s)${LIQUIDATION_ABBREVIATIONS[template]}(\\s)`), `$1${LIQUIDATION_ABBREVIATIONS[agenda]}$2`); source[agenda] = 'derived'; }
    else { prefixes[agenda] = defaultLiquidationPrefix(agenda); source[agenda] = 'default'; }
  }
  return { prefixes, source };
}

/** POHODA's placeholder text for an XML import without inv:text ("Import FA z XML") is not a purpose. */
const IMPORT_PLACEHOLDER = /^Import \S{1,4} z XML$/;
/** Purpose of the settled document: its own header text, whitespace-collapsed. */
export function documentPurpose(raw: Record<string, any>): string {
  const t = scalarText((raw?.invoiceHeader ?? raw)?.text).replace(/\s+/g, ' ').trim();
  return IMPORT_PLACEHOLDER.test(t) ? '' : t;
}
/**
 * Bank header text = POHODA's generated liquidation text + ", " + the settled
 * document's purpose ("Úhrada FP c. FP26104, telefon.služby 5-6/2026"); without
 * a purpose only the generated text ("Úhrada FV c. 2025022"). The statement's
 * counterparty description never replaces it. Only the purpose is shortened to
 * fit bnk:text (string96); type and number are never cut.
 */
export function composeLiquidationText(generated: string, purpose: string): { text: string; truncated: boolean } {
  const head = generated.trim();
  if (!head || head.length > BANK_TEXT_MAX_LENGTH) throw new Error('Text úhrady dokladu nelze sestavit (chybí nebo je příliš dlouhé číslo dokladu).');
  const clean = purpose.replace(/\s+/g, ' ').trim();
  if (!clean) return { text: head, truncated: false };
  const room = BANK_TEXT_MAX_LENGTH - head.length - 2;
  if (clean.length <= room) return { text: `${head}, ${clean}`, truncated: false };
  const cut = clean.slice(0, Math.max(0, room)).replace(/[\s,;:.\-–/]+$/u, '');
  return { text: cut ? `${head}, ${cut}` : head, truncated: true };
}

/** typ:addressType fields copied from the settled document's partnerIdentity (bank.xsd partnerIdentity is typ:address). */
export const PARTNER_ADDRESS_FIELDS = ['company', 'division', 'name', 'city', 'street', 'zip', 'ico', 'dic', 'VATPayerType', 'icDph', 'phone', 'mobilPhone', 'fax', 'email'] as const;
export type PartnerIdentity = { id?: number | undefined; address?: Partial<Record<typeof PARTNER_ADDRESS_FIELDS[number] | 'country', string>> | undefined };
/** Normalized partner of an exported document or bank record: address-book link ID and the inline address. */
export function partnerIdentityOf(raw: Record<string, any>): PartnerIdentity | undefined {
  const h = raw?.invoiceHeader ?? raw?.bankHeader ?? raw;
  const p = h?.partnerIdentity;
  if (!p || typeof p !== 'object') return undefined;
  const id = Number(scalarText(p.id)), a = p.address && typeof p.address === 'object' ? p.address : {};
  const address: NonNullable<PartnerIdentity['address']> = {};
  for (const f of PARTNER_ADDRESS_FIELDS) { const v = scalarText(a[f]); if (v) address[f] = v; }
  const country = scalarText(a.country?.ids ?? a.country);
  if (country) address.country = country;
  const result: PartnerIdentity = {};
  if (Number.isSafeInteger(id) && id > 0) result.id = id;
  if (Object.keys(address).length) result.address = address;
  return Object.keys(result).length ? result : undefined;
}
/** bnk:partnerIdentity with the linked address-book ID and the document's own inline address (live: both are stored as sent). */
export function buildBankPartnerIdentity(partner: PartnerIdentity | undefined): XmlObject | undefined {
  if (!partner) return undefined;
  const out: XmlObject = {};
  if (partner.id !== undefined) {
    if (!Number.isSafeInteger(partner.id) || partner.id <= 0) throw new Error('Invalid partner address-book ID.');
    out['typ:id'] = partner.id;
  }
  const a = partner.address ?? {}, address: XmlObject = {};
  for (const f of PARTNER_ADDRESS_FIELDS) if (a[f]) address[`typ:${f}`] = a[f]!;
  if (a.country) address['typ:country'] = { 'typ:ids': a.country };
  if (Object.keys(address).length) out['typ:address'] = address;
  return Object.keys(out).length ? out : undefined;
}
/** Field-level differences between the expected and the stored partner ("" = absent). */
export function partnerDifferences(expected: PartnerIdentity | undefined, stored: PartnerIdentity | undefined): { field: string; expected: string; stored: string }[] {
  const diffs: { field: string; expected: string; stored: string }[] = [];
  const e = String(expected?.id ?? ''), s = String(stored?.id ?? '');
  if (e !== s) diffs.push({ field: 'partnerIdentity.id', expected: e, stored: s });
  for (const f of [...PARTNER_ADDRESS_FIELDS, 'country'] as const) {
    const ev = expected?.address?.[f] ?? '', sv = stored?.address?.[f] ?? '';
    if (ev !== sv) diffs.push({ field: `partnerIdentity.address.${f}`, expected: ev, stored: sv });
  }
  return diffs;
}
/** A generated-text prefix ("Úhrada FP c. ") for this agenda: no digits/commas, its abbreviation as a word. */
export function isLiquidationPrefix(prefix: string, agenda: SettlementAgenda): boolean {
  return PREFIX_SHAPE.test(prefix) && new RegExp(`(^|\\s)${LIQUIDATION_ABBREVIATIONS[agenda]}(\\s)`).test(prefix);
}
/**
 * Stored bank text follows the rule for this document whatever generated prefix
 * variant was used when it was written ("c." / "č." or a learned wording):
 * "<prefix><number>[, <purpose, possibly shortened to 96>]".
 */
export function followsLiquidationText(stored: string, agenda: SettlementAgenda, number: string, purpose: string): boolean {
  if (!number) return false;
  for (let i = stored.indexOf(number); i > 0; i = stored.indexOf(number, i + 1)) {
    const prefix = stored.slice(0, i);
    if (!isLiquidationPrefix(prefix, agenda)) continue;
    try { if (composeLiquidationText(prefix + number, purpose).text === stored) return true; } catch { /* not this split */ }
  }
  return false;
}
