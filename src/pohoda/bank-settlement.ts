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
