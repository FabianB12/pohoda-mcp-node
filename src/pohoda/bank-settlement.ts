import type { XmlObject } from './xml-builder.js';
import { toMinorUnits, fromMinorUnits } from './money.js';

export const SETTLEMENT_AGENDAS = ['receivedInvoice', 'commitment', 'issuedInvoice', 'receivable', 'receivedAdvanceInvoice', 'issuedAdvanceInvoice'] as const;
export type SettlementAgenda = typeof SETTLEMENT_AGENDAS[number];
export type BankLiquidation = { agenda: SettlementAgenda; id: number; amount: number | string };

/** Import-only bankLiquidationItem creates the real payment link, not just a bank entry. */
export function buildBankLiquidationDetail(targets: BankLiquidation[], currency = 'CZK'): XmlObject[] {
  if (!targets.length) throw new Error('At least one liquidation target is required.');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Liquidation currency must be an ISO code.');
  const seen = new Set<string>();
  return targets.map((target) => {
    if (!SETTLEMENT_AGENDAS.includes(target.agenda) || !Number.isSafeInteger(target.id) || target.id <= 0) throw new Error('Invalid liquidation target.');
    const key = `${target.agenda}:${target.id}`;
    if (seen.has(key)) throw new Error('Duplicate liquidation target.');
    seen.add(key);
    const amount = toMinorUnits(target.amount);
    if (amount <= 0) throw new Error('Liquidation amount must be positive.');
    return { 'bnk:bankLiquidationItem': {
      'bnk:settingsLiquidation': { 'bnk:sourceAgenda': target.agenda, 'bnk:sourceDocument': { 'typ:id': target.id }, 'bnk:liquidationPrice': fromMinorUnits(amount) },
      'bnk:liquidationItem': { 'bnk:quantity': 1, [currency === 'CZK' ? 'bnk:homeCurrency' : 'bnk:foreignCurrency']: { 'bnk:unitPrice': fromMinorUnits(amount) } }
    } };
  });
}

export function statementMonthNumber(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('Statement period must be YYYY-MM.');
  return period.slice(5).padStart(3, '0');
}
