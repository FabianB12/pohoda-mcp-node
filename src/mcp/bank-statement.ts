import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { PohodaClient, WriteBatchOperation } from '../pohoda/client.js';
import type { TransportOptions } from '../pohoda/transport.js';
import { toMinorUnits, moneyValue, sumHomeCurrency } from '../pohoda/money.js';
import { SETTLEMENT_AGENDAS, statementMonthNumber, type SettlementAgenda } from '../pohoda/bank-settlement.js';
import { recordsIn, scanExpenseAgendas } from './expense-import.js';
import { loadStatementPdf, markSettledPayments, type StatementMark } from './bank-statement-pdf.js';

type Fields = Record<string, any>;
export type StatementPayment = {
  movement: number; date: string; amount: number | string; direction: 'expense' | 'receipt';
  variableSymbol?: string | undefined; text?: string | undefined; mark: StatementMark;
};
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
const isTrue = (v: unknown) => ['true', '1'].includes(text(v));
const directionOf = (d: SettlementDocument) => ['receivedInvoice', 'commitment', 'receivedAdvanceInvoice'].includes(d.agenda) ? 'expense' : 'receipt';

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

/** amountHome/amountForeign is the REMAINING amount, verified on POHODA 14302. */
export function settlementDocument(raw: Fields): SettlementDocument {
  const h = header(raw), summary = raw.invoiceSummary ?? {};
  if (!SETTLEMENT_AGENDAS.includes(h.invoiceType) || !h.liquidation) throw new Error('POHODA did not export the invoice liquidation state.');
  const currency = text(summary.foreignCurrency?.currency?.ids) || 'CZK';
  const amount = moneyValue(h.liquidation[currency === 'CZK' ? 'amountHome' : 'amountForeign']);
  // A paid invoice exports a liquidation date without an amount. An empty or
  // incomplete liquidation block is not evidence of either a debt or payment.
  if ((amount === undefined || amount === null || amount === '') && !validDate(text(h.liquidation.date))) throw new Error('POHODA exported an unknown remaining amount.');
  return { id: Number(h.id), agenda: h.invoiceType, number: text(h.number?.numberRequested), date: text(h.date), symbol: normalizeSymbol(h.symVar), currency, remaining: minor(amount === undefined || amount === null || amount === '' ? 0 : amount), raw };
}
export function matchStatementPayments(payments: StatementPayment[], currency: string, documents: SettlementDocument[]) {
  const reserved = new Set<string>();
  const eligible = documents.filter(d => d.remaining > 0 && !isTrue(header(d.raw).storno));
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
  return payments.map(payment => {
    const amount = minor(payment.amount), symbol = normalizeSymbol(payment.variableSymbol);
    if (amount <= 0 || !['expense', 'receipt'].includes(payment.direction)) throw new Error('Invalid statement payment.');
    const sameVS = symbol ? (byVS.get(`${payment.direction}|${currency}|${symbol}`) || []).filter(d => !reserved.has(key(d))) : [];
    let match: SettlementDocument | undefined, reason = '';
    if (sameVS.length) {
      // Never jump over an older unpaid document sharing this variable symbol.
      if (sameVS[0]!.remaining === amount) { match = sameVS[0]; reason = 'variableSymbol'; }
      else return { payment, status: 'unmatched' as const, reason: 'VS souhlasí, ale nejstarší doklad má jinou zbývající částku.' };
    } else {
      const sameAmount = (byAmount.get(`${payment.direction}|${currency}|${amount}`) || []).filter(d => !reserved.has(key(d)));
      if (sameAmount.length === 1) { match = sameAmount[0]; reason = 'amount'; }
      else return { payment, status: 'unmatched' as const, reason: sameAmount.length ? 'Částka odpovídá více dokladům.' : 'Nenalezena odpovídající položka k likvidaci.' };
    }
    reserved.add(key(match!));
    return { payment, status: 'matched' as const, reason, document: match! };
  });
}

export class BankStatementService {
  constructor(private readonly client: Pick<PohodaClient, 'listRecordsBatch' | 'writeBatch'>) {}
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
      if (p.text && p.text.length > 240) throw new Error('Payment text exceeds 240 characters.');
    }
    const pdf = await loadStatementPdf(input.sourcePdfPath, input.payments.map(p => p.mark));
    const groups = [{ agenda: 'bankAccount', subType: '' }, { agenda: 'bank', subType: '' }, ...SETTLEMENT_AGENDAS.map(subType => ({ agenda: 'invoice', subType }))];
    const snapshot = await scanExpenseAgendas(this.client, groups, {}, target, false, 2000);
    const account = resolveStatementAccount(input, snapshot.get('bankAccount|') || []);
    const bankRows = snapshot.get('bank|') || [];
    const documents = SETTLEMENT_AGENDAS.flatMap(a => (snapshot.get(`invoice|${a}`) || []).map(settlementDocument));
    const documentIndex = new Map(documents.map(d => [key(d), d]));
    const bankIndex = new Map<string, Fields[]>();
    for (const raw of bankRows) {
      const h = header(raw);
      if (Number(h.account?.id) !== Number(account.id) && text(h.account?.ids) !== text(account.ids)) continue;
      const indexKey = `${text(h.dateStatement).slice(0, 4)}|${text(h.statementNumber?.statementNumber)}|${Number(h.statementNumber?.numberMovement)}`;
      const list = bankIndex.get(indexKey) || []; list.push(raw); bankIndex.set(indexKey, list);
    }
    const rows: Fields[] = [], fresh: StatementPayment[] = [];
    for (const payment of input.payments) {
      const matches = bankIndex.get(`${input.statementPeriod.slice(0, 4)}|${statementNumber}|${payment.movement}`) || [];
      if (matches.length > 1) throw new Error(`Movement ${payment.movement} has duplicate bank records; nothing was written.`);
      if (!matches.length) { fresh.push(payment); continue; }
      const raw = matches[0]!, h = header(raw), expectedMarker = this.marker(input, payment, account.id);
      const marker = text(h.intNote).split(/\r?\n/).find(line => line.startsWith(`${expectedMarker}|`));
      if (!marker || !this.bankFactsMatch(raw, input, payment, account)) {
        rows.push({ movement: payment.movement, status: 'needs_review', bankId: Number(h.id), doNotRetry: true, reason: 'Bankovní pohyb již existuje; bez ověřené vazby jej nelze znovu zapsat.' });
        continue;
      }
      const doc = documentIndex.get(marker.slice(expectedMarker.length + 1));
      rows.push({ movement: payment.movement, status: 'existing', bankId: Number(h.id), document: doc, payment, marker });
    }
    rows.push(...matchStatementPayments(fresh, input.currency, documents).map(p => ({ ...p, movement: p.payment.movement })));
    const order = new Map(input.payments.map((p, i) => [p.movement, i]));
    rows.sort((a, b) => order.get(a.movement)! - order.get(b.movement)!);
    const toWrite = rows.filter(r => r.status === 'matched');
    if (!input.execute) return { ok: true, state: 'planned', account: { id: account.id, ids: account.ids }, statementNumber, matched: toWrite.length, unmatched: rows.filter(r => r.status === 'unmatched').length, rows: rows.map(publicRow), message: 'Likvidace zatím nebyla provedena. Nespárované platby se nezapisují.' };
    if (checksum(await readFile(input.sourcePdfPath)) !== pdf.sha256) throw new Error('Source statement changed; nothing was written.');
    const reportedIds = new Set<number>();
    if (toWrite.length) {
      // Re-read exact targets once before writing. A changed currency, date,
      // symbol or balance invalidates the plan instead of silently rematching it.
      const refreshed = await this.readDocuments(toWrite.map(r => r.document), target);
      for (const row of toWrite) {
        const raw = refreshed.get(key(row.document)), current = raw && settlementDocument(raw);
        if (!current || current.remaining !== minor(row.payment.amount) || current.currency !== row.document.currency || current.symbol !== row.document.symbol || current.date !== row.document.date || isTrue(header(raw!).storno)) throw new Error('An invoice changed; re-run matching. Nothing was written.');
      }
      const operations: Extract<WriteBatchOperation, { tool: 'create_bank_document' }>[] = toWrite.map(row => ({
        tool: 'create_bank_document', requestId: `movement-${row.movement}`, header: {
          type: row.payment.direction, account: String(account.ids), statementPeriod: input.statementPeriod, numberMovement: String(row.movement), dateStatement: input.dateStatement, datePayment: row.payment.date, symVar: row.payment.variableSymbol || '', text: row.payment.text || `Úhrada ${row.document.number}`,
          intNote: `${this.marker(input, row.payment, account.id)}|${key(row.document)}`,
          ...(input.currency !== 'CZK' ? { currency: input.currency } : {}), liquidations: [{ agenda: row.document.agenda, id: row.document.id, amount: row.payment.amount }]
        }, items: []
      }));
      try {
        // Markers and full read-back are the duplicate guard. The transport pack
        // is per-attempt so a previously rejected item can be safely retried.
        const result = await this.client.writeBatch(operations, `bank-${randomBytes(12).toString('hex')}`, target);
        for (const item of result.items) { const id = Number(item.data.producedDetails?.id); if (id > 0) reportedIds.add(id); }
        toWrite.forEach((row, i) => {
          const item = result.items[i]; row.bankId = Number(item?.data.producedDetails?.id) || undefined;
          row.status = row.bankId ? 'created' : 'write_uncertain'; row.doNotRetry = true; row.importDetails = item?.data.importDetails;
        });
      } catch (error) {
        for (const row of toWrite) { row.status = 'write_uncertain'; row.doNotRetry = true; row.reason = (error as Error).message; }
      }
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
          const valid = !!raw && settlementDocument(raw).currency === input.currency && settlementDocument(raw).remaining === 0 && links.length > 0 && linkAmount === minor(row.payment.amount) && links.every(link => text(link.date) === row.payment.date) && !!bank && this.bankFactsMatch(bank, input, row.payment, account) && text(header(bank).intNote).split(/\r?\n/).includes(expectedMarker);
          row.status = valid ? 'settled' : 'needs_review'; row.verified = valid; row.doNotRetry = !valid;
          if (!valid) row.reason = 'Likvidace nebo uložené údaje nebyly potvrzeny; platbu znovu nezapisovat.';
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
    return { ok: !rows.some(r => ['needs_review', 'write_uncertain'].includes(r.status)) && !annotated.error, state: 'processed', account: { id: account.id, ids: account.ids }, statementNumber, settled: settled.length, unmatched: rows.filter(r => r.status === 'unmatched').length, createdIds: [...reportedIds], rows: rows.map(publicRow), annotatedPdf: annotated };
  }
  private marker(input: StatementInput, payment: StatementPayment, accountId: unknown): string {
    return `MCP-BANK:${checksum(JSON.stringify([String(accountId), input.statementPeriod, payment.movement, payment.date, payment.direction, minor(payment.amount), input.currency, normalizeSymbol(payment.variableSymbol)])).slice(0, 32)}`;
  }
  private bankFactsMatch(raw: Fields, input: StatementInput, payment: StatementPayment, account: Fields): boolean {
    try {
      const h = header(raw), foreign = raw.bankSummary?.foreignCurrency;
      const amount = foreign ? moneyValue(foreign.priceSum) : sumHomeCurrency(raw.bankSummary?.homeCurrency || {});
      return (text(foreign?.currency?.ids) || 'CZK') === input.currency && minor(amount) === minor(payment.amount) && Number(h.account?.id) === Number(account.id) && text(h.statementNumber?.statementNumber) === statementMonthNumber(input.statementPeriod) && Number(h.statementNumber?.numberMovement) === payment.movement && text(h.dateStatement) === input.dateStatement && text(h.datePayment) === payment.date && text(h.bankType) === payment.direction && normalizeSymbol(h.symVar) === normalizeSymbol(payment.variableSymbol);
    } catch { return false; }
  }
  private async readDocuments(documents: SettlementDocument[], target: TransportOptions): Promise<Map<string, Fields>> {
    const unique = [...new Map(documents.map(d => [key(d), d])).values()], map = new Map<string, Fields>();
    for (let start = 0; start < unique.length; start += 100) {
      const chunk = unique.slice(start, start + 100), response = await this.client.listRecordsBatch(chunk.map(d => ({ agenda: 'invoice', subType: d.agenda, filter: { id: d.id }, options: { restrictions: { 'lst:liquidations': true } } })), '', target);
      if (!response.isOk() || response.items.length !== chunk.length) throw new Error('Invoice read-back failed.');
      chunk.forEach((d, i) => { const raw = recordsIn(response.items[i]!.data).find(r => Number(header(r).id) === d.id && text(header(r).invoiceType) === d.agenda); if (raw) map.set(key(d), raw); });
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
function publicRow(row: Fields): Fields {
  return { movement: row.movement, status: row.status, reason: row.reason, bankId: row.bankId, verified: row.verified, doNotRetry: row.doNotRetry, document: row.document ? { id: row.document.id, agenda: row.document.agenda, number: row.document.number } : undefined };
}
