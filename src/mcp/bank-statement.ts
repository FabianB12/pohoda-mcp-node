import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { PohodaClient, WriteBatchOperation } from '../pohoda/client.js';
import type { TransportOptions } from '../pohoda/transport.js';
import { toMinorUnits, moneyValue, sumHomeCurrency, sumHomeCurrencyMinor, homeSummaryFields } from '../pohoda/money.js';
import { SETTLEMENT_AGENDAS, composeLiquidationText, documentPurpose, findLiveAccountingUnit, followsLiquidationText, learnLiquidationConvention, partnerDifferences, partnerIdentityOf, sourceVatBuckets, statementMonthNumber, validateBankHeaderText, type AccountingMode, type LiquidationTextConvention, type SettlementAgenda } from '../pohoda/bank-settlement.js';
import { recordsIn, scanExpenseAgendas } from './expense-import.js';
import { loadStatementPdf, markSettledPayments, type StatementMark } from './bank-statement-pdf.js';

type Fields = Record<string, any>;
/**
 * movement is the statement's own movement number: kept internally for matching,
 * markers, PDF rows and reports, but never written to bnk:numberMovement.
 * text is the statement's description; it is validated but never becomes the bank
 * text, which always comes from the settled document.
 */
export type StatementPayment = {
  movement: number; date: string; amount: number | string; direction: 'expense' | 'receipt';
  variableSymbol?: string | undefined; text?: string | undefined; mark: StatementMark;
};
export type FieldDifference = { field: string; expected: string; stored: string };
export type StatementInput = {
  databaseId: string; sourcePdfPath: string; statementPeriod: string; dateStatement: string;
  accountNumber?: string | undefined; bankCode?: string | undefined; iban?: string | undefined;
  currency: string; payments: StatementPayment[]; execute: boolean;
};
export type SettlementDocument = {
  id: number; agenda: SettlementAgenda; number: string; date: string; symbol: string;
  currency: string; remaining: number; raw: Fields;
};
const minor = (v: unknown) => toMinorUnits(v as number | string);
const text = (v: any): string => v == null ? '' : typeof v === 'object' ? text(v['#text']) : String(v).trim();
const asArray = <T>(v: T | T[] | undefined): T[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
const header = (r: Fields) => r.invoiceHeader ?? r.bankHeader ?? r.bankAccountHeader ?? r;
const key = (d: SettlementDocument) => `${d.agenda}:${d.id}`;
const checksum = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const locks = new Map<string, Promise<unknown>>();
const directionOf = (d: { agenda: string }) => ['receivedInvoice', 'commitment', 'receivedAdvanceInvoice'].includes(d.agenda) ? 'expense' : 'receipt';

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function normalizeSymbol(value: unknown): string {
  const s = text(value).replace(/\s/g, '');
  return /^\d+$/.test(s) ? s.replace(/^0+/, '') : s.toUpperCase();
}
function domestic(number: string, bankCode = ''): string {
  const pair = number.replace(/\s/g, '').split('/');
  if (pair.length > 2 || (pair[1] && bankCode && pair[1] !== bankCode)) throw new Error('Conflicting bank codes.');
  const code = pair[1] || bankCode;
  if (!/^\d{4}$/.test(code)) throw new Error('Bank code must contain four digits.');
  const m = /^(?:(\d{1,6})-)?(\d{1,10})$/.exec(pair[0]!);
  if (!m) throw new Error('Invalid domestic account number.');
  return `${(m[1] || '').replace(/^0+/, '') || '0'}-${m[2]!.replace(/^0+/, '') || '0'}/${code}`;
}
function normalizedIban(value: string): string {
  const clean = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(clean)) throw new Error('Invalid IBAN.');
  let remainder = 0;
  for (const c of clean.slice(4) + clean.slice(0, 4)) {
    for (const digit of /[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  if (remainder !== 1) throw new Error('Invalid IBAN checksum.');
  return clean;
}
function accountKeys(number?: string, code?: string, ibanValue?: string): string[] {
  const id = ibanValue ? normalizedIban(ibanValue) : '';
  const result: string[] = [];
  if (number) {
    try { result.push(domestic(number, code)); }
    catch (error) { if (!id || id.startsWith('CZ')) throw error; } // foreign accounts match by validated IBAN
  }
  if (id) {
    result.push(id);
    if (id.startsWith('CZ')) {
      if (id.length !== 24) throw new Error('Invalid Czech IBAN length.');
      const local = domestic(`${id.slice(8, 14)}-${id.slice(14)}`, id.slice(4, 8));
      if (number && result[0] !== local) throw new Error('Statement account and IBAN disagree.');
      result.push(local);
    }
  }
  return result;
}
export function resolveStatementAccount(input: Pick<StatementInput, 'accountNumber' | 'bankCode' | 'iban' | 'currency' | 'dateStatement'>, rows: Fields[]): Fields {
  const wanted = accountKeys(input.accountNumber, input.bankCode, input.iban);
  if (!wanted.length) throw new Error('Read the account number or IBAN from the statement header before processing.');
  const found = rows.map(header).filter(h => {
    if (h.cancelled && text(h.cancelled) <= input.dateStatement) return false;
    if ((text(h.currencyBankAccount?.currency?.ids) || 'CZK') !== input.currency) return false;
    try { return accountKeys(text(h.numberAccount), text(h.codeBank), text(h.IBAN)).some(k => wanted.includes(k)); }
    catch { return false; }
  });
  if (found.length !== 1) throw new Error(`Statement account has ${found.length} matching POHODA accounts; nothing was written.`);
  if (!Number.isSafeInteger(Number(found[0]!.id)) || Number(found[0]!.id) <= 0 || !text(found[0]!.ids)) throw new Error('Bank account has no usable POHODA ID/code.');
  return found[0]!;
}

/** Reference to a POHODA document in diagnostics: IDs and numbers only, no partner data. */
export type DocumentRef = { agenda: string; id: number | null; number: string };
export type SettlementIssue = DocumentRef & {
  field: string; problem: string;
  resolution?: 'targetedRead' | 'unresolved' | 'ignored'; liquidationLinks?: number; movements?: number[];
};
/** A liquidable document whose remaining amount (or identity/date) is not proven. */
export type UnknownDocument = {
  agenda: SettlementAgenda; id: number | null; number: string; date: string; symbol: string; currency: string;
  /** Known remaining amount when only the identity/date is invalid; undefined = unbounded. */
  remaining?: number | undefined; issue: SettlementIssue;
};
export type ClassifiedDocument =
  | { kind: 'known'; document: SettlementDocument }
  | { kind: 'unknown'; unknown: UnknownDocument }
  | { kind: 'ignored'; issue: SettlementIssue };

const isCancelled = (h: Fields) => !['', 'false', '0'].includes(text(h.storno)); // storno=cancelledDocument|cancelDocument
const isMoney = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '');
const ref = (d: { agenda: string; id: number | null; number: string }): DocumentRef => ({ agenda: d.agenda, id: d.id, number: d.number });

/**
 * Proven zero total only: at least one exported home-currency price field and all
 * of them summing to 0. A missing/empty summary or rounding alone is not a zero.
 */
function zeroTotal(raw: Fields): boolean {
  const summary = raw.invoiceSummary, home = summary?.homeCurrency;
  if (!home || typeof home !== 'object' || !homeSummaryFields.some(f => isMoney(moneyValue(home[f])))) return false;
  try {
    if (summary.foreignCurrency && minor(moneyValue(summary.foreignCurrency.priceSum)) !== 0) return false;
    return sumHomeCurrencyMinor(home) === 0;
  } catch { return false; }
}

/**
 * Classifies inv:invoiceHeader/inv:liquidation (export-only typ:liquidationType;
 * every child optional in the XSD). Live-verified shapes on POHODA 14302.10:
 * unpaid {amountHome[, amountForeign]}, partially paid {date, amountHome[, amountForeign]},
 * fully paid {date} only, and an empty element for a zero-total document.
 * amountHome/amountForeign are the REMAINING amount. Anything else is unknown:
 * it is never treated as zero, paid, or the original total.
 * withLinks: raw comes from a read with lst:liquidations, so an absent
 * liquidations list proves there are no allocations.
 */
export function classifySettlementDocument(raw: Fields, expectedAgenda?: string, withLinks = false): ClassifiedDocument {
  const h = header(raw), summary = raw.invoiceSummary ?? {}, exported = text(h.invoiceType), agenda = exported || expectedAgenda || '';
  const numericId = Number(text(h.id)), id = Number.isSafeInteger(numericId) && numericId > 0 ? numericId : null;
  const base = { agenda, id, number: text(h.number?.numberRequested) };
  if (!(SETTLEMENT_AGENDAS as readonly string[]).includes(agenda)) {
    // Other invoice types (e.g. corrective tax documents) are not bank liquidation targets.
    return { kind: 'ignored', issue: { ...base, field: 'invoiceHeader.invoiceType', problem: `Typ ${agenda || '(chybí)'} nelze likvidovat bankou; doklad se nepáruje.`, resolution: 'ignored' } };
  }
  const missingType = !exported;
  const currency = text(summary.foreignCurrency?.currency?.ids) || 'CZK';
  const amountField = currency === 'CZK' ? 'amountHome' : 'amountForeign';
  const liq = h.liquidation;
  let remaining: number | undefined, field = 'invoiceHeader.liquidation', problem = '';
  if (liq === undefined || liq === null) problem = 'POHODA neexportovala stav likvidace (element chybí).';
  else if (typeof liq !== 'object') {
    if (text(liq) !== '') problem = 'Neočekávaný obsah stavu likvidace.';
    else if (!zeroTotal(raw)) problem = 'Prázdný stav likvidace u dokladu s nenulovou nebo neznámou celkovou částkou.';
    else if (!withLinks) problem = 'Prázdný stav likvidace u nulového dokladu; vazby úhrad dosud nebyly načteny.';
    else if (raw.liquidations) problem = 'Prázdný stav likvidace, ale nulový doklad má vazby úhrad.';
    else remaining = 0; // live: a zero-total document exports <inv:liquidation/>
  } else {
    const value = moneyValue(liq[amountField]);
    field = `invoiceHeader.liquidation.${amountField}`;
    if (isMoney(value)) {
      try { remaining = minor(value); } catch { problem = 'Zbývající částka není platné číslo.'; }
    } else if (currency !== 'CZK' && isMoney(moneyValue(liq.amountHome))) problem = 'U cizoměnového dokladu chybí zbývající částka v cizí měně.';
    else if (validDate(text(liq.date))) remaining = 0; // live: full payment exports only the date
    else { field = 'invoiceHeader.liquidation'; problem = 'Neznámý zůstatek: chybí částka i datum likvidace.'; }
  }
  const date = text(h.date), symbol = normalizeSymbol(h.symVar);
  if (missingType && !problem) { field = 'invoiceHeader.invoiceType'; problem = 'POHODA neexportovala typ dokladu.'; remaining = undefined; }
  if (problem) {
    if (isCancelled(h)) return { kind: 'ignored', issue: { ...base, field, problem: `${problem} Doklad je stornovaný/stornující, nepáruje se.`, resolution: 'ignored' } };
    return { kind: 'unknown', unknown: { agenda: agenda as SettlementAgenda, id, number: base.number, date, symbol, currency, issue: { ...base, field, problem } } };
  }
  if (remaining! > 0 && !isCancelled(h) && (id === null || !validDate(date))) {
    const bad = id === null ? 'invoiceHeader.id' : 'invoiceHeader.date';
    return { kind: 'unknown', unknown: { agenda: agenda as SettlementAgenda, id, number: base.number, date, symbol, currency, remaining, issue: { ...base, field: bad, problem: id === null ? 'Doklad nemá platné ID.' : 'Doklad nemá platné datum; nelze určit nejstarší doklad.' } } };
  }
  return { kind: 'known', document: { id: id ?? 0, agenda: agenda as SettlementAgenda, number: base.number, date, symbol, currency, remaining: remaining!, raw } };
}
/** Strict form for callers that need a proven state. */
export function settlementDocument(raw: Fields, withLinks = false): SettlementDocument {
  const c = classifySettlementDocument(raw, undefined, withLinks);
  if (c.kind === 'known') return c.document;
  const issue = c.kind === 'unknown' ? c.unknown.issue : c.issue;
  throw new Error(`${issue.agenda || 'invoice'} #${issue.id ?? '?'} ${issue.number}: ${issue.field}: ${issue.problem}`);
}
type MatchRow = { payment: StatementPayment; status: 'matched' | 'unmatched' | 'needs_review'; reason: string; document?: SettlementDocument; blockedBy?: DocumentRef[] };
/**
 * Unknown documents never match, but they block every payment they could
 * compete for: the same direction/currency and VS, or (for amount-only rows)
 * the same exact amount, or any amount when their remaining amount is unknown.
 */
export function matchStatementPayments(payments: StatementPayment[], currency: string, documents: SettlementDocument[], unknown: UnknownDocument[] = []): MatchRow[] {
  const reserved = new Set<string>();
  const eligible = documents.filter(d => d.remaining > 0 && !isCancelled(header(d.raw)));
  const blockers = unknown.filter(u => u.currency === currency);
  const byVS = new Map<string, SettlementDocument[]>(), byAmount = new Map<string, SettlementDocument[]>();
  for (const d of eligible) {
    if (!validDate(d.date) || !Number.isSafeInteger(d.id) || d.id <= 0) throw new Error('Invalid invoice identity/date from POHODA.');
    if (d.symbol) {
      const indexKey = `${directionOf(d)}|${d.currency}|${d.symbol}`, list = byVS.get(indexKey) || [];
      list.push(d); byVS.set(indexKey, list);
    }
    const indexKey = `${directionOf(d)}|${d.currency}|${d.remaining}`, list = byAmount.get(indexKey) || [];
    list.push(d); byAmount.set(indexKey, list);
  }
  for (const list of byVS.values()) list.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id || a.agenda.localeCompare(b.agenda));
  const rows: MatchRow[] = [], fallback = new Map<string, MatchRow[]>();
  // Pass 1: variable symbols, in statement order. A VS that names outstanding
  // documents never falls back to an amount match, even once they are used up.
  for (const payment of payments) {
    const amount = minor(payment.amount), symbol = normalizeSymbol(payment.variableSymbol);
    if (amount <= 0 || !['expense', 'receipt'].includes(payment.direction)) throw new Error('Invalid statement payment.');
    const row: MatchRow = { payment, status: 'unmatched', reason: '' }; rows.push(row);
    const unknownVS = symbol ? blockers.filter(u => directionOf(u) === payment.direction && u.symbol === symbol) : [];
    if (unknownVS.length) {
      row.status = 'needs_review'; row.blockedBy = unknownVS.map(ref);
      row.reason = 'Stejný VS má doklad s neověřeným stavem likvidace; nelze určit nejstarší neuhrazený doklad. Nezapisuje se.';
      continue;
    }
    const vsList = symbol ? byVS.get(`${payment.direction}|${currency}|${symbol}`) : undefined;
    if (vsList) {
      const open = vsList.filter(d => !reserved.has(key(d)));
      // Never jump over an older unpaid document sharing this variable symbol.
      if (open[0]?.remaining === amount) { row.status = 'matched'; row.reason = 'variableSymbol'; row.document = open[0]!; reserved.add(key(open[0]!)); }
      else row.reason = open.length ? 'VS souhlasí, ale nejstarší doklad má jinou zbývající částku.' : 'Doklady s tímto VS již páruje jiný pohyb výpisu.';
      continue;
    }
    const amountKey = `${payment.direction}|${currency}|${amount}`;
    fallback.set(amountKey, [...(fallback.get(amountKey) || []), row]);
  }
  // Pass 2: a unique exact amount, only when exactly one movement and one
  // remaining document share it; otherwise the pairing is ambiguous.
  for (const [amountKey, list] of fallback) {
    const sameAmount = (byAmount.get(amountKey) || []).filter(d => !reserved.has(key(d)));
    const { direction, amount } = { direction: list[0]!.payment.direction, amount: minor(list[0]!.payment.amount) };
    const competing = blockers.filter(u => directionOf(u) === direction && (u.remaining === undefined || u.remaining === amount));
    for (const row of list) {
      if (competing.length) {
        row.status = 'needs_review'; row.blockedBy = competing.map(ref);
        row.reason = 'Částku může mít i doklad s neověřeným stavem likvidace; párování podle částky nelze prokázat. Nezapisuje se.';
      } else if (sameAmount.length === 1 && list.length === 1) { row.status = 'matched'; row.reason = 'amount'; row.document = sameAmount[0]!; reserved.add(key(sameAmount[0]!)); }
      else row.reason = sameAmount.length > 1 ? 'Částka odpovídá více dokladům.' : sameAmount.length ? 'Stejnou částku má více pohybů výpisu.' : 'Nenalezena odpovídající položka k likvidaci.';
    }
  }
  return rows;
}

export class BankStatementService {
  constructor(private readonly client: Pick<PohodaClient, 'listRecordsBatch' | 'writeBatch' | 'listAccountingUnits'>) {}
  async process(input: StatementInput, target: TransportOptions): Promise<Fields> {
    if (!target.databaseOverride || !target.dataPackIco || input.databaseId !== target.databaseOverride) throw new Error('Explicit matching accounting unit and ICO required.');
    const lockKey = `${target.databaseOverride}|${target.dataPackIco}`, previous = locks.get(lockKey) || Promise.resolve();
    const running = previous.catch(() => {}).then(() => this.run(input, target)); locks.set(lockKey, running);
    try { return await running; }
    finally { if (locks.get(lockKey) === running) locks.delete(lockKey); }
  }
  private async run(input: StatementInput, target: TransportOptions): Promise<Fields> {
    const statementNumber = statementMonthNumber(input.statementPeriod);
    if (!validDate(input.dateStatement) || input.dateStatement.slice(0, 7) !== input.statementPeriod) throw new Error('Statement date must belong to statementPeriod.');
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('Explicit statement currency required.');
    if (typeof input.execute !== 'boolean') throw new Error('Explicit execute flag required.');
    if (input.execute && input.currency !== 'CZK') throw new Error('Automatická likvidace cizoměnových výpisů zatím není podporována: POHODA vyžaduje ověřený kurz. Pro náhled použijte execute=false. Nic nebylo zapsáno.');
    if (!input.payments.length || input.payments.length > 1000) throw new Error('Provide 1–1000 extracted statement movements.');
    const movements = new Set<number>();
    for (const p of input.payments) {
      if (!Number.isInteger(p.movement) || p.movement < 1 || p.movement > 999999 || movements.has(p.movement)) throw new Error('Statement movement numbers must be unique positive integers.');
      movements.add(p.movement);
      if (!validDate(p.date) || !['expense', 'receipt'].includes(p.direction) || minor(p.amount) <= 0) throw new Error('Invalid payment date, direction or amount.');
      try { validateBankHeaderText({ text: p.text, symVar: p.variableSymbol }); }
      catch (error) { throw new Error(`Pohyb ${p.movement}: ${(error as Error).message}`); }
    }
    const pdf = await loadStatementPdf(input.sourcePdfPath, input.payments.map(p => p.mark));
    // The liquidation XML differs for daňová evidence (homeCurrencyJU) and
    // double-entry units; read the live unit type for this exact file + ICO.
    const unit = await this.accountingUnit(target);
    if (input.execute && !unit.accountingMode) throw new Error(`Typ účetní jednotky nelze ověřit (${unit.problem}). Likvidace se pro daňovou evidenci a podvojné účetnictví zapisuje odlišně, proto se bez ověřeného typu nic nezapisuje. Nic nebylo zapsáno; zopakujte náhled execute=false po ověření jednotky v list_accounting_units.`);
    const accountingUnit = { unitType: unit.unitType || null, accountingMode: unit.accountingMode ?? 'unknown', ...(unit.problem ? { problem: unit.problem } : {}) };
    const groups = [{ agenda: 'bankAccount', subType: '' }, { agenda: 'bank', subType: '' }, ...SETTLEMENT_AGENDAS.map(subType => ({ agenda: 'invoice', subType }))];
    let snapshot: Map<string, Fields[]>;
    try { snapshot = await scanExpenseAgendas(this.client, groups, {}, target, false, 2000); }
    catch (error) {
      // A failed read is a transport/data-pack failure of this attempt, not a
      // missing POHODA feature: retry the read-only preview once it is resolved.
      throw new Error(`Načtení bankovních účtů, pohybů a dokladů k likvidaci z POHODA selhalo: ${(error as Error).message} Nic nebylo zapsáno ani spárováno. Jde o chybu čtení této jednotky, ne o chybějící export POHODA; po ověření dostupnosti jednotky zopakujte náhled execute=false.`);
    }
    const account = resolveStatementAccount(input, snapshot.get('bankAccount|') || []);
    const bankRows = snapshot.get('bank|') || [];
    const { documents, unknown, issues } = await this.classifyDocuments(snapshot, target);
    const documentIndex = new Map(documents.map(d => [key(d), d]));
    // The unit's own generated liquidation text ("Úhrada FP c. <číslo>") is learned from its bank items.
    const convention = learnLiquidationConvention(bankRows, [...documents, ...unknown]);
    const accountRows = bankRows.filter(raw => { const h = header(raw); return Number(h.account?.id) === Number(account.id) || text(h.account?.ids) === text(account.ids); });
    // Existing records are found by their per-movement marker. New records leave
    // bnk:numberMovement blank; the positional index only catches legacy/manual
    // records that still carry a movement number.
    const byMarker = new Map<string, Fields[]>(), bySlot = new Map<string, Fields[]>();
    for (const raw of accountRows) {
      const h = header(raw), markers = new Set(text(h.intNote).split(/\r?\n/).map(line => /^(MCP-BANK:[0-9a-f]{32})\|/.exec(line)?.[1]).filter((m): m is string => !!m));
      for (const m of markers) byMarker.set(m, [...(byMarker.get(m) || []), raw]);
      const movement = text(h.statementNumber?.numberMovement);
      if (movement) { const slot = `${text(h.dateStatement).slice(0, 4)}|${text(h.statementNumber?.statementNumber)}|${Number(movement)}`; bySlot.set(slot, [...(bySlot.get(slot) || []), raw]); }
    }
    const expectedMarkers = new Map(input.payments.map(p => [p.movement, this.marker(input, p, account.id)]));
    const claimed = new Set<number>();
    for (const m of expectedMarkers.values()) for (const raw of byMarker.get(m) || []) claimed.add(Number(header(raw).id));
    const rows: Fields[] = [], fresh: StatementPayment[] = [];
    for (const payment of input.payments) {
      const expectedMarker = expectedMarkers.get(payment.movement)!, hits = byMarker.get(expectedMarker) || [];
      if (hits.length > 1) {
        rows.push({ movement: payment.movement, status: 'needs_review', bankId: Number(header(hits[0]!).id), bankIds: hits.map(raw => Number(header(raw).id)), doNotRetry: true, reason: `Pohyb má ${hits.length} bankovní záznamy se stejnou značkou; nic se znovu nezapisuje.` });
        continue;
      }
      if (!hits.length) {
        const unclaimed = (raw: Fields) => !claimed.has(Number(header(raw).id));
        const slot = (bySlot.get(`${input.statementPeriod.slice(0, 4)}|${statementNumber}|${payment.movement}`) || []).filter(unclaimed);
        if (slot.length) { rows.push({ movement: payment.movement, status: 'needs_review', bankId: Number(header(slot[0]!).id), doNotRetry: true, reason: 'Bankovní pohyb se stejným číslem výpisu a pohybu již existuje; bez ověřené vazby jej nelze znovu zapsat.' }); continue; }
        // A manually entered, homebanking or renumbered movement: same facts are
        // reviewed, never duplicated (records claimed by this statement excluded).
        const same = accountRows.find(raw => unclaimed(raw) && this.sameMovementFacts(raw, input, payment));
        if (same) rows.push({ movement: payment.movement, status: 'needs_review', bankId: Number(header(same).id), doNotRetry: true, reason: 'V účtu již existuje stejný bankovní pohyb bez ověřené vazby; nezapisuje se znovu.' });
        else fresh.push(payment);
        continue;
      }
      const raw = hits[0]!, h = header(raw);
      const marker = text(h.intNote).split(/\r?\n/).find(line => line.startsWith(`${expectedMarker}|`))!;
      if (!this.bankFactsMatch(raw, input, payment, account)) {
        rows.push({ movement: payment.movement, status: 'needs_review', bankId: Number(h.id), doNotRetry: true, reason: 'Bankovní pohyb již existuje; bez ověřené vazby jej nelze znovu zapsat.' });
        continue;
      }
      const doc = documentIndex.get(marker.slice(expectedMarker.length + 1));
      rows.push({ movement: payment.movement, status: 'existing', bankId: Number(h.id), document: doc, payment, marker });
    }
    rows.push(...matchStatementPayments(fresh, input.currency, documents, unknown).map(p => ({ ...p, movement: p.payment.movement })));
    if (unit.accountingMode === 'singleEntry') for (const row of rows.filter(r => r.status === 'matched')) {
      const split = sourceVatBuckets(row.document.raw, row.payment.amount);
      if ('problem' in split) { row.status = 'needs_review'; row.reason = split.problem; }
      else row.vat = split.buckets;
    }
    for (const row of rows.filter(r => r.status === 'matched')) planBankFields(row, row.document.raw, convention);
    for (const issue of issues) {
      const movements = rows.filter(r => r.blockedBy?.some((b: DocumentRef) => b.agenda === issue.agenda && b.id === issue.id && b.number === issue.number)).map(r => r.movement);
      if (movements.length) issue.movements = movements;
    }
    const order = new Map(input.payments.map((p, i) => [p.movement, i]));
    rows.sort((a, b) => order.get(a.movement)! - order.get(b.movement)!);
    const toWrite = rows.filter(r => r.status === 'matched');
    const diagnostics = publicDiagnostics(issues);
    if (!input.execute) {
      const review = rows.filter(r => r.status === 'needs_review').length;
      return { ok: true, state: 'planned', accountingUnit, account: { id: account.id, ids: account.ids }, statementNumber, bankTextConvention: convention, matched: toWrite.length, unmatched: rows.filter(r => r.status === 'unmatched').length, needsReview: review, rows: rows.map(publicRow), ...(diagnostics ? { diagnostics } : {}),
        message: `Náhled: likvidace zatím nebyla provedena. Zapsat lze jen ${toWrite.length} pohybů se stavem matched; nespárované a needs_review se nezapisují.${diagnostics ? ` ${diagnostics.unresolvedCount} dokladů má neověřený stav likvidace; blokují jen pohyby uvedené v blockedBy, ostatní plán zůstává platný.` : ''} execute=true jen v rámci pokynu uživatele zpracovat výpis a případného schválení hostitelem; zamítnutý zápis neobcházet.${unit.accountingMode ? '' : ` Typ účetní jednotky nelze ověřit (${unit.problem}); execute=true bude odmítnut před zápisem.`}` };
    }
    if (checksum(await readFile(input.sourcePdfPath)) !== pdf.sha256) throw new Error('Source statement changed; nothing was written.');
    const reportedIds = new Set<number>();
    let writeSummary: Fields | undefined, reconciliation: Fields | undefined;
    if (toWrite.length) {
      // Re-read exact targets once before writing. A changed currency, date,
      // symbol or balance invalidates the plan instead of silently rematching it.
      const refreshed = await this.readDocuments(toWrite.map(r => r.document), target);
      for (const row of toWrite) {
        const raw = refreshed.get(key(row.document)), state = raw && classifySettlementDocument(raw, row.document.agenda, true);
        const current = state?.kind === 'known' ? state.document : undefined;
        if (!current || current.remaining !== minor(row.payment.amount) || current.currency !== row.document.currency || current.symbol !== row.document.symbol || current.date !== row.document.date || isCancelled(header(raw!))) {
          const detail = !raw ? 'doklad nebyl nalezen' : state?.kind === 'unknown' ? state.unknown.issue.problem : state?.kind === 'ignored' ? state.issue.problem : 'změnil se zůstatek, měna, VS, datum nebo storno';
          throw new Error(`An invoice changed; re-run matching. Nothing was written. (${row.document.agenda} #${row.document.id} ${row.document.number}: ${detail})`);
        }
        if (unit.accountingMode === 'singleEntry') {
          const split = sourceVatBuckets(raw!, row.payment.amount);
          if ('problem' in split || JSON.stringify(split.buckets) !== JSON.stringify(row.vat)) throw new Error(`Rozpis DPH dokladu ${row.document.number} se změnil; zopakujte náhled. Nic nebylo zapsáno.`);
        }
        // Text and partner come from the freshly read document, never from the statement.
        if (!planBankFields(row, raw!, convention)) throw new Error(`${row.reason} Nic nebylo zapsáno.`);
      }
      const operations: Extract<WriteBatchOperation, { tool: 'create_bank_document' }>[] = toWrite.map(row => ({
        tool: 'create_bank_document', requestId: `movement-${row.movement}`, header: {
          // No numberMovement: the movement field stays blank in POHODA; row.movement lives on in the marker.
          type: row.payment.direction, account: String(account.ids), statementPeriod: input.statementPeriod, dateStatement: input.dateStatement, datePayment: row.payment.date, symVar: row.payment.variableSymbol || '', text: row.bankText,
          ...(row.partner ? { partnerIdentity: row.partner } : {}),
          intNote: `${this.marker(input, row.payment, account.id)}|${key(row.document)}`,
          accountingMode: unit.accountingMode!, ...(input.currency !== 'CZK' ? { currency: input.currency } : {}), liquidations: [{ agenda: row.document.agenda, id: row.document.id, amount: row.payment.amount, ...(row.vat ? { vat: row.vat } : {}) }]
        }, items: []
      }));
      // Markers and full read-back are the duplicate guard. The transport pack
      // is per-attempt so a previously rejected item can be safely retried.
      const packId = `bank-${randomBytes(12).toString('hex')}`;
      let response: BankWriteResponse | undefined, transportError = '';
      try { response = await this.client.writeBatch(operations, packId, target); }
      catch (error) { transportError = (error as Error).message; }
      const outcomes = classifyBankWriteResponse(response, packId, operations.length, transportError);
      toWrite.forEach((row, i) => applyWriteOutcome(row, outcomes[i]!));
      for (const o of outcomes) if (o.bankId) reportedIds.add(o.bankId);
      const unresolved = toWrite.filter(r => r.writeOutcome !== 'created');
      if (unresolved.length) reconciliation = await this.reconcile(unresolved, input, account, target);
      writeSummary = summarizeWrite(packId, response, transportError, toWrite, reconciliation);
    }
    const verify = rows.filter(r => ['created', 'existing'].includes(r.status) && r.document && r.bankId);
    if (verify.length) {
      try {
        const current = await this.readDocuments(verify.map(r => r.document), target);
        const banks = await this.readBanks(verify.map(r => r.bankId), target);
        for (const row of verify) {
          const raw = current.get(key(row.document)), bank = banks.get(row.bankId);
          const links = asArray<Fields>(raw?.liquidations?.liquidation).filter(link => text(link.sourceAgenda) === 'bank' && Number(link.sourceDocument?.id) === row.bankId);
          const linkAmount = links.reduce((sum, link) => sum + minor(moneyValue(input.currency === 'CZK' ? link.amount : link.foreignCurrencySource) ?? 0), 0);
          const expectedMarker = `${this.marker(input, row.payment, account.id)}|${key(row.document)}`;
          const state = raw && classifySettlementDocument(raw, row.document.agenda, true);
          const valid = state?.kind === 'known' && state.document.currency === input.currency && state.document.remaining === 0 && links.length > 0 && linkAmount === minor(row.payment.amount) && links.every(link => text(link.date) === row.payment.date) && !!bank && this.bankFactsMatch(bank, input, row.payment, account) && text(header(bank).intNote).split(/\r?\n/).includes(expectedMarker);
          // Text, partner and the blank movement field are verified against the settled document as stored.
          const differences = valid ? storedFieldDifferences(bank!, raw!, row, convention) : [];
          if (differences.length) row.fieldDifferences = differences;
          // A record POHODA reported as failed (or found only by read-back) stays a review case even when verified.
          const settledOk = valid && !differences.length && !row.responseConflict;
          row.status = settledOk ? 'settled' : 'needs_review'; row.verified = valid; row.doNotRetry = !settledOk;
          if (!valid) row.reason = 'Likvidace nebo uložené údaje nebyly potvrzeny; platbu znovu nezapisovat.';
          else if (differences.length) row.reason = `Likvidace je ověřena, ale uložené údaje bankovního záznamu se liší od likvidovaného dokladu (${differences.map(d => d.field).join(', ')}); viz fieldDifferences. Záznam se znovu nezapisuje ani nepřepisuje; opravte jej v POHODA ručně.`;
          else if (row.responseConflict) row.reason = 'Bankovní záznam a likvidace jsou ověřeny čtením, ale odpověď POHODA hlásila chybu nebo chyběla; zkontrolujte importErrors, znovu nezapisovat.';
        }
      } catch (error) {
        for (const row of verify) { row.status = 'needs_review'; row.doNotRetry = true; row.reason = (error as Error).message; }
      }
    }
    for (const row of rows.filter(r => r.status === 'existing')) { row.status = 'needs_review'; row.doNotRetry = true; row.reason = 'Cílový doklad nelze ověřit.'; }
    const settled = rows.filter(r => r.status === 'settled');
    const stem = basename(input.sourcePdfPath).replace(/\.pdf$/i, '');
    const output = join(dirname(resolve(input.sourcePdfPath)), `${stem}-zlikvidovano-${pdf.sha256.slice(0, 8)}.pdf`);
    let annotated: Fields;
    try { annotated = await markSettledPayments(pdf, input.sourcePdfPath, output, settled.map(r => r.payment.mark)); }
    catch (error) { annotated = { error: (error as Error).message }; }
    const rejected = rows.filter(r => r.status === 'rejected').length, uncertain = rows.filter(r => r.status === 'write_uncertain').length;
    return { ok: !rows.some(r => ['needs_review', 'write_uncertain', 'rejected'].includes(r.status)) && !annotated.error, state: 'processed', accountingUnit, account: { id: account.id, ids: account.ids }, statementNumber, bankTextConvention: convention, settled: settled.length, unmatched: rows.filter(r => r.status === 'unmatched').length, needsReview: rows.filter(r => r.status === 'needs_review').length, rejected, writeUncertain: uncertain, createdIds: [...reportedIds], rows: rows.map(publicRow), ...(writeSummary ? { write: writeSummary } : {}), ...(diagnostics ? { diagnostics } : {}), annotatedPdf: annotated,
      ...(writeSummary ? { message: writeMessage(writeSummary, settled.length) } : {}) };
  }
  /** One fresh listAccountingUnit read per run; a missing, ambiguous or unknown type never defaults to double-entry. */
  private async accountingUnit(target: TransportOptions): Promise<{ unitType: string; accountingMode?: AccountingMode | undefined; problem?: string }> {
    let data: Fields;
    try {
      const response = await this.client.listAccountingUnits();
      if (!response.isOk()) throw new Error(`stav odpovědi ${response.state}`);
      data = response.toArray();
    } catch (error) { return { unitType: '', problem: `čtení seznamu účetních jednotek selhalo: ${(error as Error).message}` }; }
    const unit = findLiveAccountingUnit(data, String(target.databaseOverride), String(target.dataPackIco));
    if (!unit) return { unitType: '', problem: `jednotka ${target.databaseOverride} s IČO ${target.dataPackIco} není v seznamu účetních jednotek jednoznačně` };
    if (!unit.accountingMode) return { unitType: unit.unitType, problem: `nepodporovaný typ účetní jednotky '${unit.unitType || '(prázdný)'}'` };
    return { unitType: unit.unitType, accountingMode: unit.accountingMode };
  }
  /**
   * Read-only reconciliation after a rejected or uncertain write: one bank scan
   * for this run's per-movement markers. A found record is reported with its ID
   * (a later run verifies it as existing); nothing is ever written or retried here.
   */
  private async reconcile(rows: Fields[], input: StatementInput, account: Fields, target: TransportOptions): Promise<Fields> {
    let banks: Fields[];
    try { banks = (await scanExpenseAgendas(this.client, [{ agenda: 'bank', subType: '' }], {}, target, false, 2000)).get('bank|') || []; }
    catch (error) {
      const message = `Kontrolní čtení bankovních záznamů selhalo: ${(error as Error).message}`;
      for (const row of rows) row.reconciliation = { performed: false, error: message };
      return { performed: false, error: message };
    }
    let found = 0;
    for (const row of rows) {
      const expected = `${this.marker(input, row.payment, account.id)}|${key(row.document)}`;
      const hits = banks.filter(raw => { const h = header(raw); return (Number(h.account?.id) === Number(account.id) || text(h.account?.ids) === text(account.ids)) && text(h.intNote).split(/\r?\n/).includes(expected); });
      row.reconciliation = { performed: true, bankRecordFound: hits.length > 0, ...(hits.length ? { bankIds: hits.map(raw => Number(header(raw).id)) } : {}) };
      if (!hits.length) {
        if (row.status === 'rejected') row.reason += ' Kontrolní čtení potvrdilo, že bankovní záznam s touto značkou neexistuje; likvidace tímto pohybem neproběhla.';
        else row.reason += ' Kontrolní čtení po zápisu záznam s touto značkou nenašlo; nový náhled execute=false značky znovu prohledá. Neopakovat zápis jiným nástrojem.';
        continue;
      }
      found++; row.responseConflict = true; row.bankId = Number(header(hits[0]!).id);
      if (hits.length > 1) { row.status = 'needs_review'; row.reason = `Kontrolní čtení našlo ${hits.length} bankovní záznamy se stejnou značkou; znovu nezapisovat.`; continue; }
      if (row.status === 'rejected') { row.status = 'needs_review'; row.reason += ` Přesto kontrolní čtení našlo bankovní záznam ID ${row.bankId} s touto značkou; zkontrolujte jej ručně, znovu nezapisovat.`; continue; }
      if (row.status === 'write_uncertain') { row.reason += ` Kontrolní čtení našlo bankovní záznam ID ${row.bankId} s touto značkou; nový běh jej ověří jako existující bez dalšího zápisu.`; continue; }
    }
    return { performed: true, scannedBankRecords: banks.length, foundAfterRejectedOrUncertain: found };
  }
  private marker(input: StatementInput, payment: StatementPayment, accountId: unknown): string {
    return `MCP-BANK:${checksum(JSON.stringify([String(accountId), input.statementPeriod, payment.movement, payment.date, payment.direction, minor(payment.amount), input.currency, normalizeSymbol(payment.variableSymbol)])).slice(0, 32)}`;
  }
  private bankFactsMatch(raw: Fields, input: StatementInput, payment: StatementPayment, account: Fields): boolean {
    try {
      const h = header(raw), foreign = raw.bankSummary?.foreignCurrency;
      const amount = foreign ? moneyValue(foreign.priceSum) : sumHomeCurrency(raw.bankSummary?.homeCurrency || {});
      return (text(foreign?.currency?.ids) || 'CZK') === input.currency && minor(amount) === minor(payment.amount) && Number(h.account?.id) === Number(account.id) && text(h.statementNumber?.statementNumber) === statementMonthNumber(input.statementPeriod) && movementCompatible(h, payment) && text(h.dateStatement) === input.dateStatement && text(h.datePayment) === payment.date && text(h.bankType) === payment.direction && normalizeSymbol(h.symVar) === normalizeSymbol(payment.variableSymbol);
    } catch { return false; }
  }
  /** Account is pre-filtered. A missing VS on either side is treated as compatible. */
  private sameMovementFacts(raw: Fields, input: StatementInput, payment: StatementPayment): boolean {
    try {
      const h = header(raw), foreign = raw.bankSummary?.foreignCurrency;
      const amount = foreign ? moneyValue(foreign.priceSum) : sumHomeCurrency(raw.bankSummary?.homeCurrency || {});
      const stored = normalizeSymbol(h.symVar), wanted = normalizeSymbol(payment.variableSymbol);
      return (text(foreign?.currency?.ids) || 'CZK') === input.currency && minor(amount) === minor(payment.amount) && text(h.datePayment) === payment.date && text(h.bankType) === payment.direction && (!stored || !wanted || stored === wanted);
    } catch { return false; }
  }
  /**
   * Classifies every scanned document. Unknown states get one targeted re-read
   * by ID with lst:liquidations before they are reported; a failed re-read only
   * leaves them unresolved (they still block competing payments).
   */
  private async classifyDocuments(snapshot: Map<string, Fields[]>, target: TransportOptions) {
    const documents: SettlementDocument[] = [], issues: SettlementIssue[] = [], seen = new Set<string>();
    let unknown: UnknownDocument[] = [];
    for (const agenda of SETTLEMENT_AGENDAS) for (const raw of snapshot.get(`invoice|${agenda}`) || []) {
      const c = classifySettlementDocument(raw, agenda);
      if (c.kind === 'known') { if (!seen.has(key(c.document))) { seen.add(key(c.document)); documents.push(c.document); } }
      else if (c.kind === 'unknown') unknown.push(c.unknown);
      else issues.push(c.issue);
    }
    const readable = unknown.filter(u => u.id !== null).slice(0, MAX_TARGETED_READS) as (UnknownDocument & { id: number })[];
    if (readable.length) {
      let fresh: Map<string, Fields> | undefined, failure = '';
      try { fresh = await this.readDocuments(readable, target); } catch (error) { failure = (error as Error).message; }
      unknown = unknown.flatMap(u => {
        if (!readable.includes(u as UnknownDocument & { id: number })) { u.issue.problem += ' Cílené čtení nebylo provedeno (limit).'; return [u]; }
        if (!fresh) { u.issue.problem += ` Cílené čtení selhalo: ${failure}`; return [u]; }
        const raw = fresh.get(`${u.agenda}:${u.id}`);
        if (!raw) { u.issue.problem += ' Cílené čtení podle ID doklad nevrátilo.'; return [u]; }
        const c = classifySettlementDocument(raw, u.agenda, true);
        if (c.kind === 'known') { documents.push(c.document); issues.push({ ...u.issue, resolution: 'targetedRead' }); return []; }
        if (c.kind === 'ignored') { issues.push(c.issue); return []; }
        c.unknown.issue.liquidationLinks = asArray(raw.liquidations?.liquidation).length;
        return [c.unknown];
      });
    }
    for (const u of unknown) issues.push(Object.assign(u.issue, { resolution: 'unresolved' as const }));
    return { documents, unknown, issues };
  }
  private async readDocuments(documents: { agenda: SettlementAgenda; id: number }[], target: TransportOptions): Promise<Map<string, Fields>> {
    const unique = [...new Map(documents.map(d => [`${d.agenda}:${d.id}`, d])).values()], map = new Map<string, Fields>();
    for (let start = 0; start < unique.length; start += 100) {
      const chunk = unique.slice(start, start + 100), response = await this.client.listRecordsBatch(chunk.map(d => ({ agenda: 'invoice', subType: d.agenda, filter: { id: d.id }, options: { restrictions: { 'lst:liquidations': true } } })), '', target);
      if (!response.isOk() || response.items.length !== chunk.length) throw new Error('Invoice read-back failed.');
      chunk.forEach((d, i) => { const raw = recordsIn(response.items[i]!.data).find(r => Number(header(r).id) === d.id && text(header(r).invoiceType) === d.agenda); if (raw) map.set(`${d.agenda}:${d.id}`, raw); });
    }
    return map;
  }
  private async readBanks(ids: number[], target: TransportOptions): Promise<Map<number, Fields>> {
    const unique = [...new Set(ids)], map = new Map<number, Fields>();
    for (let start = 0; start < unique.length; start += 100) {
      const chunk = unique.slice(start, start + 100), response = await this.client.listRecordsBatch(chunk.map(id => ({ agenda: 'bank', subType: '', filter: { id }, options: {} })), '', target);
      if (!response.isOk() || response.items.length !== chunk.length) throw new Error('Bank read-back failed.');
      chunk.forEach((id, i) => { const raw = recordsIn(response.items[i]!.data).find(r => Number(header(r).id) === id); if (raw) map.set(id, raw); });
    }
    return map;
  }
}
/** Blank (current rule) or, for a record written by an older version, the statement's own movement number. */
function movementCompatible(h: Fields, payment: StatementPayment): boolean {
  const stored = text(h.statementNumber?.numberMovement);
  return stored === '' || (/^\d+$/.test(stored) && Number(stored) === payment.movement);
}
/**
 * Bank text and partner of a matched row, from the settled document only:
 * "<POHODA generated text>, <document purpose>" and its partnerIdentity (ID + inline).
 * Returns false (row moved to needs_review) when the text cannot be composed.
 */
function planBankFields(row: Fields, raw: Fields, convention: LiquidationTextConvention): boolean {
  const number = text(header(raw).number?.numberRequested) || row.document.number;
  try {
    if (!number) throw new Error('Likvidovaný doklad nemá číslo; text úhrady nelze sestavit.');
    const { text: bankText, truncated } = composeLiquidationText(`${convention.prefixes[row.document.agenda as SettlementAgenda]}${number}`, documentPurpose(raw));
    Object.assign(row, { bankText, textTruncated: truncated, partner: partnerIdentityOf(raw) });
    return true;
  } catch (error) {
    Object.assign(row, { status: 'needs_review', reason: (error as Error).message, doNotRetry: false });
    return false;
  }
}
/**
 * Stored text, partner and movement field of a verified bank record against the
 * settled document. The text must follow the rule for that document (any
 * generated-prefix variant, so older runs stay verifiable); a header that does
 * not use POHODA's own generated item text is reported as a warning only.
 */
function storedFieldDifferences(bank: Fields, doc: Fields, row: Fields, convention: LiquidationTextConvention): FieldDifference[] {
  const h = header(bank), diffs: FieldDifference[] = [], agenda = row.document.agenda as SettlementAgenda;
  const movement = text(h.statementNumber?.numberMovement);
  if (movement) diffs.push({ field: 'statementNumber.numberMovement', expected: '', stored: movement });
  const number = text(header(doc).number?.numberRequested), purpose = documentPurpose(doc);
  const items = asArray<Fields>(bank.bankDetail?.bankItem).map(i => text(i?.text)).filter(Boolean);
  const generated = items.length && items.every(t => t === items[0]) ? items[0]! : '';
  const compose = (head: string) => { try { return composeLiquidationText(head, purpose).text; } catch { return ''; } };
  const fromPohoda = generated ? compose(generated) : '', predicted = number ? compose(`${convention.prefixes[agenda]}${number}`) : '';
  const stored = text(h.text);
  if (!followsLiquidationText(stored, agenda, number, purpose)) diffs.push({ field: 'text', expected: fromPohoda || predicted, stored });
  else if (fromPohoda && stored !== fromPohoda) row.warnings = [...(row.warnings || []), `Text hlavičky nepoužívá text položky vygenerovaný POHODA ('${generated}'); typ, číslo i účel dokladu obsahuje.`];
  diffs.push(...partnerDifferences(partnerIdentityOf(doc), partnerIdentityOf(bank)));
  return diffs;
}
function publicRow(row: Fields): Fields {
  const partner = row.partner ? { ...(row.partner.id ? { id: row.partner.id } : {}), ...(row.partner.address?.company ? { company: row.partner.address.company } : {}) } : undefined;
  return { movement: row.movement, status: row.status, reason: row.reason, bankId: row.bankId, ...(row.bankIds ? { bankIds: row.bankIds } : {}), verified: row.verified, doNotRetry: row.doNotRetry, document: row.document ? { id: row.document.id, agenda: row.document.agenda, number: row.document.number } : undefined, ...(row.blockedBy ? { blockedBy: row.blockedBy } : {}),
    ...(row.bankText ? { bankText: row.bankText, ...(row.textTruncated ? { textTruncated: true } : {}), partner: partner ?? null } : {}),
    ...(row.fieldDifferences ? { fieldDifferences: row.fieldDifferences } : {}), ...(row.warnings?.length ? { warnings: row.warnings } : {}),
    ...(row.writeOutcome ? { write: { outcome: row.writeOutcome, responseItemId: row.responseItemId, itemState: row.itemState, documentState: row.documentState, ...(row.importErrors?.length ? { importErrors: row.importErrors } : {}), ...(row.importWarnings?.length ? { importWarnings: row.importWarnings } : {}), ...(row.reconciliation ? { reconciliation: row.reconciliation } : {}) } } : {}) };
}

/** Parsed POHODA response as produced by PohodaResponse (only the fields used here). */
export type BankWriteResponse = { state: string; programVersion?: string; transport?: Record<string, unknown>; items: { id: string; state: string; attributes?: Record<string, string>; data: Fields }[] };
export type ImportMessage = { state: string; errno?: string; note: string; xpath?: string; valueRequested?: string; valueProduced?: string };
/**
 * created: POHODA returned a positive record ID (verified by read-back afterwards).
 * rejected: POHODA explicitly refused the item (item or document state error, no ID).
 * missing: no usable answer for the item (transport failure, unparsable/absent/duplicate
 * item, ok without ID): the write is uncertain. conflict: an ID together with an error.
 */
export type BankWriteOutcome = { index: number; itemId: string; outcome: 'created' | 'rejected' | 'missing' | 'conflict'; bankId?: number | undefined; itemState?: string | undefined; documentState?: string | undefined; errors: ImportMessage[]; warnings: ImportMessage[]; detail: string };
const MAX_ROW_MESSAGES = 5, MAX_NOTE = 300;
const clip = (v: string, n = MAX_NOTE) => v.length > n ? `${v.slice(0, n)}…` : v;
const scalar = (v: unknown): string => v != null && typeof v === 'object' ? text((v as Fields)['#text'] ?? '') : text(v);
/** Item-level notes echo the request XML (schema errors); keep only the diagnostic lines. */
function itemNote(note: string): string {
  // fast-xml-parser keeps numeric references (live notes use &#xA; as line breaks).
  return clip(note.replace(/&#(?:x0*[ad]|0*1[03]);/gi, '\n').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('<')).join(' '), 600);
}
function importMessages(data: Fields | undefined): { errors: ImportMessage[]; warnings: ImportMessage[] } {
  const errors: ImportMessage[] = [], warnings: ImportMessage[] = [];
  for (const d of asArray<Fields>(data?.importDetails?.detail)) {
    if (!d || typeof d !== 'object') continue;
    const state = scalar(d.state), entry: ImportMessage = { state, note: clip(scalar(d.note)) };
    for (const [k, v] of [['errno', d.errno], ['xpath', d.XPath], ['valueRequested', d.valueRequested], ['valueProduced', d.valueProduced]] as const) { const t = scalar(v); if (t) entry[k] = clip(t, 200); }
    if (state === 'error') errors.push(entry); else if (state === 'warning') warnings.push(entry);
  }
  return { errors, warnings };
}
/** Maps response items to operations by dataPackItem ID (`${packId}-${n}`), never by position. */
export function classifyBankWriteResponse(response: BankWriteResponse | undefined, packId: string, count: number, transportError = ''): BankWriteOutcome[] {
  const byId = new Map<string, BankWriteResponse['items']>();
  for (const item of response?.items ?? []) byId.set(item.id, [...(byId.get(item.id) || []), item]);
  return Array.from({ length: count }, (_, index) => {
    const itemId = `${packId}-${index + 1}`, base = { index, itemId, errors: [] as ImportMessage[], warnings: [] as ImportMessage[] };
    if (!response) return { ...base, outcome: 'missing' as const, detail: `Odpověď POHODA nebyla získána: ${clip(transportError, 600)}` };
    const list = byId.get(itemId) || [];
    if (list.length !== 1) return { ...base, outcome: 'missing' as const, detail: list.length ? `Odpověď obsahuje ${list.length} položky s ID ${itemId}.` : `Odpověď POHODA (stav ${response.state || 'neznámý'}, ${response.items.length} položek) neobsahuje položku ${itemId}.` };
    const item = list[0]!, data = item.data ?? {}, documentState = scalar(data.state) || undefined;
    const rawId = scalar(data.producedDetails?.id), id = Number(rawId), bankId = Number.isSafeInteger(id) && id > 0 ? id : undefined;
    const { errors, warnings } = importMessages(data);
    if (item.state === 'error' && item.attributes?.note) errors.unshift({ state: 'error', note: itemNote(item.attributes.note) });
    const common = { ...base, itemState: item.state, documentState, errors: errors.slice(0, MAX_ROW_MESSAGES), warnings: warnings.slice(0, MAX_ROW_MESSAGES), ...(bankId ? { bankId } : {}) };
    const failed = item.state === 'error' || documentState === 'error';
    if (bankId) return failed || errors.length ? { ...common, outcome: 'conflict' as const, detail: `POHODA vrátila ID ${bankId} a zároveň chybu.` } : { ...common, outcome: 'created' as const, detail: '' };
    if (failed && (rawId === '' || id === 0)) {
      if (!common.errors.length) common.errors.push({ state: 'error', note: 'POHODA vrátila stav error bez detailu chyby.' });
      return { ...common, outcome: 'rejected' as const, detail: 'POHODA zápis odmítla.' };
    }
    return { ...common, outcome: 'missing' as const, detail: `Položka ${itemId} má stav ${item.state}/${documentState ?? '-'} bez platného ID záznamu.` };
  });
}
function applyWriteOutcome(row: Fields, o: BankWriteOutcome): void {
  Object.assign(row, { writeOutcome: o.outcome, responseItemId: o.itemId, itemState: o.itemState, documentState: o.documentState, importErrors: o.errors, importWarnings: o.warnings, doNotRetry: true });
  const causes = o.errors.map(e => [e.errno && `errno ${e.errno}`, e.note, e.xpath && `(${fieldOf(e.xpath)})`].filter(Boolean).join(' ')).join('; ');
  if (o.outcome === 'created') { row.bankId = o.bankId; row.status = 'created'; return; }
  if (o.outcome === 'conflict') { row.bankId = o.bankId; row.status = 'created'; row.responseConflict = true; row.reason = `${o.detail} ${causes}`.trim(); return; }
  if (o.outcome === 'rejected') { row.status = 'rejected'; row.reason = `POHODA zápis odmítla a nevrátila ID bankovního pohybu: ${causes}.`; return; }
  row.status = 'write_uncertain'; row.reason = `Výsledek zápisu není prokázán: ${o.detail}`;
}
const fieldOf = (xpath: string) => xpath.replace(/\[\d+\]/g, '').replace(/^\/dat:dataPack\/dat:dataPackItem\//, '');
const MAX_CAUSES = 10, MAX_CAUSE_MOVEMENTS = 20;
function summarizeWrite(packId: string, response: BankWriteResponse | undefined, transportError: string, rows: Fields[], reconciliation: Fields | undefined): Fields {
  const causes = new Map<string, Fields>();
  for (const row of rows) for (const e of (row.importErrors || []) as ImportMessage[]) {
    // Group by errno, field and note without document numbers so 34 equal rejections read as one cause.
    const field = e.xpath ? fieldOf(e.xpath) : undefined, k = `${e.errno ?? ''}|${field ?? ''}|${e.note.replace(/\d{5,}/g, '#')}`;
    const c = causes.get(k) || { errno: e.errno, note: e.note, ...(field ? { field } : {}), count: 0, movements: [] as number[] };
    c.count++; if (c.movements.length < MAX_CAUSE_MOVEMENTS) c.movements.push(row.movement); causes.set(k, c);
  }
  const by = (o: string) => rows.filter(r => r.writeOutcome === o).length, transport = response?.transport as Fields | undefined;
  const list = [...causes.values()].sort((a, b) => b.count - a.count);
  return { dataPackId: packId, responseState: response?.state ?? 'none', ...(response?.programVersion ? { programVersion: response.programVersion } : {}), ...(transport?.jobId ? { jobId: transport.jobId } : {}), ...(transportError ? { transportError: clip(transportError, 600) } : {}),
    ...(transport?.responseOutcome ? { responseOutcome: transport.responseOutcome } : {}), ...(typeof transport?.jobRetained === 'boolean' ? { jobRetained: transport.jobRetained, ...(transport.jobRetained && transport.jobDir ? { jobDirectory: transport.jobDir } : {}) } : {}),
    attempted: rows.length, created: by('created'), rejected: by('rejected'), uncertain: by('missing'), conflicting: by('conflict'), causes: list.slice(0, MAX_CAUSES), causesTruncated: list.length > MAX_CAUSES, ...(reconciliation ? { reconciliation } : {}) };
}
function writeMessage(w: Fields, settled: number): string {
  const parts = [`Zápis: ${w.attempted} pokusů, ověřeně zlikvidováno ${settled}.`];
  if (w.rejected) parts.push(`POHODA odmítla ${w.rejected} pohybů (příčiny v write.causes a rows[].write.importErrors); výsledek kontrolního čtení je v reconciliation. Zůstatek dokladu rovný platbě znamená neuhrazený doklad, ne provedenou likvidaci.`);
  if (w.uncertain || w.conflicting) parts.push(`${w.uncertain + w.conflicting} pohybů nemá prokázaný výsledek; viz reconciliation. Znovu nezapisovat jiným nástrojem; nový náhled execute=false značky znovu prohledá.`);
  parts.push('Příčinu odmítnutí uveďte přesně podle chybové zprávy POHODA; nedomýšlejte jinou.');
  return parts.join(' ');
}

const MAX_TARGETED_READS = 1000, MAX_LISTED_ISSUES = 50;
/** Structured, bounded data diagnostics: agenda/ID/number/field only, no partner data or raw XML. */
function publicDiagnostics(issues: SettlementIssue[]): Fields | undefined {
  if (!issues.length) return undefined;
  const unresolved = issues.filter(i => i.resolution === 'unresolved'), blocking = unresolved.filter(i => i.movements?.length);
  const ordered = [...blocking, ...unresolved.filter(i => !i.movements?.length), ...issues.filter(i => i.resolution !== 'unresolved')];
  return {
    unresolvedCount: unresolved.length, blockingCount: blocking.length,
    resolvedByTargetedRead: issues.filter(i => i.resolution === 'targetedRead').length, ignored: issues.filter(i => i.resolution === 'ignored').length,
    issues: ordered.slice(0, MAX_LISTED_ISSUES), truncated: ordered.length > MAX_LISTED_ISSUES,
    note: 'unresolved: stav likvidace nelze z exportu prokázat; takový doklad se nepáruje a blokuje jen pohyby se stejným VS nebo možnou stejnou částkou. Opravte doklad v POHODA nebo jej zkontrolujte ručně a zopakujte náhled.'
  };
}
