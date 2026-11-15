/**
 * Live reproduction of a 59-movement statement with 34 exact matches across all six
 * liquidable agendas, executed through the registered process_bank_statement MCP tool
 * on the production PohodaClient (Parallels POHODA /XML). Gated like the other bank
 * suites: explicit demo database + ICO + POHODA_PRL_ALLOW_WRITES; the unit identity is
 * re-verified live before every write. Only new MCPTEST records are written.
 *
 * Does NOT treat inv:liquidation/amountHome as paid: before execution every target must
 * show amountHome == its full total AND zero lst:liquidations links (outstanding, unpaid);
 * afterwards each must show a bank link with the new bank ID, amount, date and zero remaining.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { classifyBankWriteResponse, type StatementPayment } from '../src/mcp/bank-statement.js';
import { recordsIn } from '../src/mcp/expense-import.js';
import { registerPohodaTools } from '../src/mcp/tools.js';
import { PohodaClient } from '../src/pohoda/client.js';
import { PohodaResponse } from '../src/pohoda/response.js';
import type { TransportOptions } from '../src/pohoda/transport.js';
import { parallelsOptionsFromEnv, discoverPohodaInstall, ensureVmRunning, ParallelsPohodaTransport, HarnessXmlClient, extractLiveUnits, selectVerifiedDemoUnit } from './support/parallels-pohoda.js';

const opts = parallelsOptionsFromEnv();
const live = opts?.allowWrites && opts.demoDatabase && opts.demoIco ? describe.sequential : describe.skip;
const run = (process.env.POHODA_PRL_RUN || Date.now().toString()).replace(/[^a-zA-Z0-9]/g, '').slice(-12);
const tag = `MCPTEST-BW-${run}`;
const code = Number.parseInt(createHash('sha256').update(`bankwrite-${run}`).digest('hex').slice(0, 7), 16).toString().padStart(7, '1').slice(0, 7);
const outDir = resolve(process.env.POHODA_PRL_EVIDENCE_DIR || join('tests/output', `bankwrite-${run}`));
const reportPath = process.env.POHODA_PRL_REPORT || join('tests/output', `bankwrite-${run}.json`);
const EXPECTED = { database: '12345678_2026.mdb', ico: '12345678', name: 'MCPTEST Demo s.r.o.' };
const OWN = { number: '123456789', bank: '0100', ids: 'TSB2' };
const evidence: Record<string, any> = { run, tag, code, timings: {}, identityChecks: [] };
const h = (raw: any) => raw.invoiceHeader ?? raw.bankHeader ?? raw.bankAccountHeader ?? raw;
const arr = (v: any) => v == null ? [] : Array.isArray(v) ? v : [v];
// Run-unique whole parts and cents keep amount-only matches away from older demo documents.
const base = 20000 + (Number(code) % 40000);
const cents = String(10 + Number(code) % 89);
const amt = (i: number) => `${base + i * 7}.${cents}`;
const vs = (i: number) => `${code}${String(i).padStart(2, '0')}`;
const movementBase = 100000 + (Number(code) % 8999) * 100;

type Agenda = 'receivedInvoice' | 'commitment' | 'receivedAdvanceInvoice' | 'issuedInvoice' | 'issuedAdvanceInvoice' | 'receivable';
type Doc = { key: string; agenda: Agenda; vs: string; date: string; amount: string; byVs: boolean; payDate: string };
const expenseAgendas: Agenda[] = ['receivedInvoice', 'commitment', 'receivedAdvanceInvoice'];
const direction = (a: Agenda) => expenseAgendas.includes(a) ? 'expense' as const : 'receipt' as const;

// 34 matched targets mixed across agendas; some by VS, some amount-only (e.g. card payments).
const PLAN: [Agenda, number, number][] = [ // agenda, count, how many of them amount-only
  ['receivedInvoice', 10, 3], ['commitment', 6, 3], ['receivedAdvanceInvoice', 5, 0],
  ['issuedInvoice', 6, 1], ['issuedAdvanceInvoice', 4, 0], ['receivable', 3, 1]
];
const payDates = ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-03', '2026-07-08', '2026-07-15', '2026-07-22', '2026-07-30'];
const DOCS: Doc[] = (() => {
  const out: Doc[] = []; let n = 0;
  for (const [agenda, count, amountOnly] of PLAN) for (let i = 0; i < count; i++, n++) {
    out.push({ key: `M${n}`, agenda, vs: vs(n), date: `2026-06-${String(1 + (n % 25)).padStart(2, '0')}`, amount: amt(n), byVs: i >= amountOnly, payDate: payDates[n % payDates.length]! });
  }
  return out;
})();
// Documents that exist but must NOT be settled (oldest same-VS has a different outstanding amount).
const WRONG: Doc[] = [
  { key: 'W0', agenda: 'receivedInvoice', vs: vs(60), date: '2026-06-02', amount: amt(60), byVs: true, payDate: '2026-07-09' },
  { key: 'W1', agenda: 'issuedInvoice', vs: vs(61), date: '2026-06-03', amount: amt(61), byVs: true, payDate: '2026-06-29' }
];

type Row = { movement: number; date: string; amount: string; direction: 'expense' | 'receipt'; vs?: string | undefined; text: string; expect: 'matched' | 'unmatched'; doc?: string };
function statementRows(): Row[] {
  const rows: Row[] = [];
  DOCS.forEach(d => rows.push({ movement: 0, date: d.payDate, amount: d.amount, direction: direction(d.agenda), vs: d.byVs ? d.vs : undefined, text: `${d.agenda} ${d.byVs ? 'VS' : 'card/amount'} ${d.key}`, expect: 'matched', doc: d.key }));
  WRONG.forEach(d => rows.push({ movement: 0, date: d.payDate, amount: `${Number(d.amount.split('.')[0]) + 1}.${cents}`, direction: direction(d.agenda), vs: d.vs, text: `wrong amount ${d.key}`, expect: 'unmatched' }));
  for (let i = 0; i < 20; i++) rows.push({ movement: 0, date: payDates[(i + 3) % payDates.length]!, amount: `${base + 50000 + i * 13}.${cents}`, direction: i % 3 ? 'expense' : 'receipt', text: `no document ${i}`, expect: 'unmatched' });
  for (let i = 0; i < 3; i++) rows.push({ movement: 0, date: '2026-07-1' + i, amount: `${base + 70000 + i}.${cents}`, direction: 'expense', vs: vs(80 + i), text: `unknown VS ${i}`, expect: 'unmatched' });
  // Interleave deterministically (statement order by date), keep stable movement numbers with gaps.
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.text.localeCompare(b.text));
  rows.forEach((r, i) => { r.movement = movementBase + i + (i >= 30 ? 1 : 0); }); // one intentional gap
  return rows;
}

const PAGE = { w: 595, h: 842 };
const PER_PAGE = 30, rowY = (i: number) => 700 - (i % PER_PAGE) * 21;
async function statementPdf(path: string, period: string, rows: Row[]): Promise<StatementPayment[]> {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages: any[] = [];
  const payments: StatementPayment[] = [];
  rows.forEach((r, i) => {
    const p = Math.floor(i / PER_PAGE);
    if (!pages[p]) {
      const page = pdf.addPage([PAGE.w, PAGE.h]); pages[p] = page;
      page.drawText(`MCPTEST Banka - vypis ${period} (${tag}) strana ${p + 1}`, { x: 40, y: 800, size: 11, font });
      page.drawText(`Cislo uctu: ${OWN.number}/${OWN.bank}  Mena: CZK  Datum vypisu: 2026-07-31`, { x: 40, y: 780, size: 9, font });
    }
    const y = rowY(i), page = pages[p];
    page.drawText(`${r.movement}  ${r.date}  ${r.vs ?? ''}  ${r.text}  ${r.direction === 'expense' ? '-' : '+'}${r.amount}`, { x: 60, y, size: 8, font });
    payments.push({ movement: r.movement, date: r.date, amount: r.amount, direction: r.direction, ...(r.vs ? { variableSymbol: r.vs } : {}), text: `${tag} ${r.text}`.slice(0, 90), mark: { page: p + 1, x: 0.03, y: Number(((PAGE.h - (y + 3)) / PAGE.h).toFixed(4)) } });
  });
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, await pdf.save());
  return payments;
}

/** Raw write-response shape: pack state/version and per-item id, state, note, produced id, importDetails. */
function responseShape(xml: string) {
  const r = new PohodaResponse(xml);
  const packAttrs = /<rsp:responsePack\b([^>]*)>/.exec(xml)?.[1] ?? '';
  return {
    packState: r.state, programVersion: r.programVersion, packNote: /\bnote="([^"]*)"/.exec(packAttrs)?.[1],
    itemCount: r.items.length,
    items: r.items.map(i => ({ id: i.id, state: i.state, note: i.attributes.note, producedId: i.data.producedDetails?.id, dataState: i.data.state, importDetails: i.data.importDetails }))
  };
}

live('POHODA bank write results: 34 exact matches via registered MCP tool', () => {
  let transport: ParallelsPohodaTransport, client: PohodaClient, target: TransportOptions, database: string, accountId: number, mcp: McpClient;
  const ids: Record<string, number> = {};
  let rows: Row[], payments: StatementPayment[], pdfPath: string, pdfBytes: Buffer, args: Record<string, unknown>, planOk = false, executed: any;
  const bankWrites = (from: number) => transport.results.slice(from).reduce((n, r) => n + (r.request.match(/<bnk:bank version=/g)?.length ?? 0), 0);
  const nonBankWrites = (from: number) => transport.results.slice(from).filter(r => /<(inv|adb|vch|int|bka):\w+ version=/.test(r.request)).length;
  const timed = async <T>(name: string, fn: () => Promise<T>) => { const t = performance.now(); try { return await fn(); } finally { evidence.timings[name] = Math.round(performance.now() - t); } };

  /** Strict demo identity before every write: explicit DB, live MCPTEST marker, ICO and exact name. */
  async function assertDemo(step: string) {
    const units = extractLiveUnits((await new HarnessXmlClient(transport, opts!.bootstrapIco).listAccountingUnits()).toArray());
    const sel = selectVerifiedDemoUnit(units, opts!.demoDatabase, opts!.demoIco);
    if (!sel.ok) throw Error(`Demo identity check failed before ${step}: ${sel.reason}`);
    if (sel.unit.database !== EXPECTED.database || sel.unit.ico !== EXPECTED.ico || sel.unit.name !== EXPECTED.name) throw Error(`Unexpected demo unit before ${step}: ${sel.unit.database}/${sel.unit.ico}/${sel.unit.name}`);
    evidence.identityChecks.push({ step, database: sel.unit.database, ico: sel.unit.ico, name: sel.unit.name });
    return sel.unit;
  }
  async function callTool(a: Record<string, unknown>) {
    const res: any = await mcp.callTool({ name: 'process_bank_statement', arguments: a }, undefined, { timeout: 1_800_000 });
    return { isError: res.isError, body: res.structuredContent ?? (() => { try { return JSON.parse(res.content[0].text); } catch { return res.content; } })() };
  }
  async function readDocs(keys: string[], all: Doc[]) {
    const docs = keys.map(k => all.find(d => d.key === k)!);
    const out: Record<string, any> = {};
    for (let s = 0; s < docs.length; s += 50) {
      const chunk = docs.slice(s, s + 50);
      const response = await client.listRecordsBatch(chunk.map(d => ({ agenda: 'invoice', subType: d.agenda, filter: { id: ids[d.key]! }, options: { restrictions: { 'lst:liquidations': true } } })), '', target);
      expect(response.isOk()).toBe(true);
      chunk.forEach((d, i) => {
        const raw = recordsIn(response.items[i]!.data).find(r => Number(h(r).id) === ids[d.key])!;
        out[d.key] = { id: ids[d.key], agenda: h(raw).invoiceType, liquidation: h(raw).liquidation ?? null, total: raw.invoiceSummary?.homeCurrency?.priceNone ?? null, links: arr(raw.liquidations?.liquidation).map((l: any) => ({ sourceAgenda: l.sourceAgenda, sourceId: Number(l.sourceDocument?.id), amount: String(l.amount), date: l.date })) };
      });
    }
    return out;
  }
  async function accountBanks() {
    const response = await client.listRecordsBatch([{ agenda: 'bank', subType: '', filter: {}, options: {} }], '', target);
    expect(response.isOk()).toBe(true);
    return recordsIn(response.items[0]!.data).filter(r => Number(h(r).account?.id) === accountId);
  }

  beforeAll(async () => {
    if (opts!.startVm) await ensureVmRunning(opts!);
    const exePath = opts!.exePath || (await discoverPohodaInstall(opts!)).exePaths[0]!;
    transport = new ParallelsPohodaTransport({ ...opts!, exePath, evidenceDir: outDir });
    const unit = await assertDemo('setup');
    database = unit.database; target = { databaseOverride: database, dataPackIco: unit.ico! };
    client = new PohodaClient({ transport, ico: unit.ico!, database, application: 'MCPTEST bank write results' });
    const server = new McpServer({ name: 'pohoda-test', version: '0' });
    registerPohodaTools(server, { client, registryClient: null });
    const [a, b] = InMemoryTransport.createLinkedPair();
    mcp = new McpClient({ name: 'mcptest', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);

    const accounts = recordsIn((await client.listRecordsBatch([{ agenda: 'bankAccount', subType: '', filter: {}, options: {} }], '', target)).items[0]!.data).map(h);
    evidence.accounts = accounts.map(x => ({ id: x.id, ids: x.ids, number: x.numberAccount, code: x.codeBank }));
    const own = accounts.find(x => x.ids === OWN.ids && String(x.numberAccount) === OWN.number);
    if (!own) throw Error('Demo account TSB2 is missing; run tests/pohoda-bank.integration.test.ts first (not created here).');
    accountId = Number(own.id);

    await assertDemo('seed-documents');
    const all = [...DOCS, ...WRONG];
    const xml = all.map(d => `<inv:invoice version="2.0"><inv:invoiceHeader><inv:invoiceType>${d.agenda}</inv:invoiceType><inv:symVar>${d.vs}</inv:symVar><inv:date>${d.date}</inv:date><inv:dateTax>${d.date}</inv:dateTax><inv:dateDue>2026-07-20</inv:dateDue>${d.agenda === 'receivedInvoice' ? '<inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>' : ''}<inv:text>${tag} ${d.key}</inv:text><inv:intNote>${tag} ${d.key}</inv:intNote></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceNone>${d.amount}</typ:priceNone></inv:homeCurrency></inv:invoiceSummary></inv:invoice>`);
    transport.label = 'seed-documents';
    const created = await client.sendRawXmlBatch(xml, `${tag} documents`, `${tag}-docs`, target);
    evidence.seedResponse = responseShape(String((created.transport as any).xml));
    expect(created.isOk()).toBe(true);
    all.forEach((d, i) => ids[d.key] = Number(created.items[i]!.data.producedDetails?.id));
    expect(Object.values(ids).every(id => id > 0)).toBe(true);
    evidence.documents = all.map(d => ({ ...d, id: ids[d.key] }));

    rows = statementRows();
    pdfPath = join(outDir, 'vypis-2026-07.pdf');
    payments = await statementPdf(pdfPath, '2026-07', rows);
    pdfBytes = await readFile(pdfPath);
    args = { databaseId: database, sourcePdfPath: pdfPath, statementPeriod: '2026-07', dateStatement: '2026-07-31', accountNumber: OWN.number, bankCode: OWN.bank, currency: 'CZK', execute: false, payments };
    evidence.statement = { pdfPath, sha256: createHash('sha256').update(pdfBytes).digest('hex'), rows };
  }, 900_000);

  afterAll(async () => {
    await mcp?.close().catch(() => {}); await transport?.cleanup();
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ evidence, exchanges: transport?.results.map(r => ({ requestPath: r.requestPath, responsePath: r.responsePath, durationMs: r.durationMs, exitCode: r.exitCode })) }, null, 2));
  });

  it('targets are outstanding and unpaid before execution (amountHome is the remaining balance, no links)', async () => {
    const before = await readDocs([...DOCS, ...WRONG].map(d => d.key), [...DOCS, ...WRONG]);
    evidence.docsBefore = before;
    for (const d of [...DOCS, ...WRONG]) {
      expect(before[d.key].agenda).toBe(d.agenda);
      expect(before[d.key].links).toEqual([]);
      expect(Number(before[d.key].liquidation?.amountHome)).toBeCloseTo(Number(d.amount), 2);
      expect(before[d.key].liquidation?.date).toBeUndefined();
    }
  }, 600_000);

  it('MCP preview: exactly 34 matched (all six agendas, VS + amount-only), 25 unmatched, no writes', async () => {
    const before = transport.results.length;
    const { isError, body } = await timed('previewMs', () => callTool(args));
    evidence.preview = body;
    expect(isError).toBe(false);
    expect(bankWrites(before)).toBe(0); expect(nonBankWrites(before)).toBe(0);
    expect(body).toMatchObject({ state: 'planned', statementNumber: '007', account: { ids: OWN.ids, id: String(accountId) }, matched: 34, unmatched: 25, needsReview: 0 });
    const byMove = new Map(body.rows.map((r: any) => [r.movement, r]));
    for (const r of rows) {
      const got: any = byMove.get(r.movement);
      expect(got.status).toBe(r.expect);
      if (r.doc) expect(got.document).toMatchObject({ id: ids[r.doc], agenda: DOCS.find(d => d.key === r.doc)!.agenda });
      if (r.doc) expect(got.reason).toBe(r.vs ? 'variableSymbol' : 'amount');
    }
    evidence.previewAgendas = Object.fromEntries(PLAN.map(([a]) => [a, body.rows.filter((r: any) => r.document?.agenda === a).length]));
    planOk = true;
  }, 900_000);

  it('MCP execute: 34 genuine bank records with liquidation links, zero outstanding, checks only on settled rows', async () => {
    if (!planOk) throw Error('Preview plan differed; execute skipped to avoid unintended writes.');
    const banksBefore = (await accountBanks()).map(r => Number(h(r).id));
    await assertDemo('execute-34');
    const before = transport.results.length;
    const { isError, body } = await timed('executeMs', () => callTool({ ...args, execute: true }));
    executed = body; evidence.execute = body;
    const writeExchanges = transport.results.slice(before).filter(r => /<bnk:bank version=/.test(r.request));
    evidence.writeExchanges = writeExchanges.map(r => ({ durationMs: r.durationMs, exitCode: r.exitCode, bankItems: r.request.match(/<bnk:bank version=/g)?.length, requestPath: r.requestPath, responsePath: r.responsePath, shape: responseShape(r.xml) }));
    // Raw response shape is recorded before any assertion so a failure still leaves evidence.
    expect(bankWrites(before)).toBe(34); expect(nonBankWrites(before)).toBe(0);
    expect(isError).toBe(false);
    expect(body.rows.filter((r: any) => r.status === 'write_uncertain')).toEqual([]);
    expect(body).toMatchObject({ ok: true, state: 'processed', settled: 34, unmatched: 25, needsReview: 0 });
    expect(body.createdIds).toHaveLength(34);

    const banksAfter = await accountBanks();
    const fresh = banksAfter.filter(r => !banksBefore.includes(Number(h(r).id)));
    expect(fresh.map(r => Number(h(r).id)).sort((x, y) => x - y)).toEqual([...body.createdIds].sort((x: number, y: number) => x - y));
    const settledRows = body.rows.filter((r: any) => r.status === 'settled');
    for (const row of settledRows) {
      const bank = fresh.find(r => Number(h(r).id) === row.bankId)!, src = rows.find(r => r.movement === row.movement)!;
      expect(h(bank).statementNumber?.statementNumber).toBe('007');
      // The movement number is kept only in the marker/report; POHODA's movement field stays blank.
      expect(h(bank).statementNumber?.numberMovement).toBeUndefined();
      expect(String(h(bank).text)).toBe(row.bankText);
      expect(row.bankText).toMatch(/^Úhrada (FP|FV|OZ|OP|PZ|VZ) c\. \S+/);
      expect(h(bank).datePayment).toBe(src.date); expect(h(bank).dateStatement).toBe('2026-07-31');
      expect(h(bank).bankType).toBe(src.direction);
      expect(String(h(bank).intNote)).toMatch(/^MCP-BANK:[0-9a-f]{32}\|/);
    }
    const after = await readDocs([...DOCS, ...WRONG].map(d => d.key), [...DOCS, ...WRONG]);
    evidence.docsAfter = after;
    for (const d of DOCS) {
      const row = settledRows.find((r: any) => r.document?.id === ids[d.key]);
      expect(row, d.key).toBeTruthy();
      const links = after[d.key].links.filter((l: any) => l.sourceAgenda === 'bank' && l.sourceId === row.bankId);
      expect(links, d.key).toHaveLength(1);
      expect(Number(links[0].amount)).toBeCloseTo(Number(d.amount), 2);
      expect(links[0].date).toBe(d.payDate);
      // Zero outstanding: full payment exports date only (or amountHome 0).
      expect(after[d.key].liquidation?.amountHome ?? '0').toMatch(/^0(\.0+)?$/);
    }
    for (const d of WRONG) expect(after[d.key]).toEqual(evidence.docsBefore[d.key]);
    expect(await readFile(pdfPath)).toEqual(pdfBytes);
    expect(body.annotatedPdf.marked).toBe(34);
    expect(body.annotatedPdf.path).not.toBe(pdfPath);
    expect((await PDFDocument.load(await readFile(body.annotatedPdf.path))).getPageCount()).toBe(2);
  }, 1_800_000);

  it('MCP retry with a renamed identical PDF writes zero new bank records', async () => {
    if (!executed) throw Error('Execute did not run.');
    const copy = join(outDir, 'vypis-2026-07-prejmenovany.pdf'); await copyFile(pdfPath, copy);
    const banksBefore = (await accountBanks()).length;
    await assertDemo('retry-34');
    const before = transport.results.length;
    const { body } = await timed('retryMs', () => callTool({ ...args, sourcePdfPath: copy, execute: true }));
    evidence.retry = body;
    expect(bankWrites(before)).toBe(0); expect(nonBankWrites(before)).toBe(0);
    expect(body).toMatchObject({ settled: 34, createdIds: [] });
    const idsOf = (r: any) => r.rows.filter((x: any) => x.status === 'settled').map((x: any) => x.bankId);
    expect(idsOf(body)).toEqual(idsOf(executed));
    expect((await accountBanks()).length).toBe(banksBefore);
  }, 1_800_000);

  it('input limits: >96 text / >20 VS refused by the MCP tool before any exchange; exact 96/20 settles; raw POHODA rejection classified', async () => {
    // New synthetic MCPTEST documents only (August statement).
    const vs20 = `${code}${'0'.repeat(10)}${run.replace(/\D/g, '').padStart(3, '7').slice(-3)}`;
    const X: Doc[] = [
      { key: 'X0', agenda: 'receivedInvoice', vs: vs(90), date: '2026-07-02', amount: amt(90), byVs: true, payDate: '2026-08-05' },  // control
      { key: 'X1', agenda: 'receivedInvoice', vs: vs(91), date: '2026-07-02', amount: amt(91), byVs: true, payDate: '2026-08-06' },  // text exactly 96
      { key: 'X2', agenda: 'commitment', vs: vs20, date: '2026-07-02', amount: amt(92), byVs: true, payDate: '2026-08-07' },          // VS exactly 20
      { key: 'X3', agenda: 'receivedInvoice', vs: vs(93), date: '2026-07-02', amount: amt(93), byVs: true, payDate: '2026-08-08' },  // invalid-input target (must stay unpaid)
      { key: 'X4', agenda: 'commitment', vs: vs(94), date: '2026-07-02', amount: amt(94), byVs: true, payDate: '2026-08-09' }        // raw-XML 21-char VS target (must stay unpaid)
    ];
    expect(vs20).toHaveLength(20);
    await assertDemo('seed-limit-docs');
    transport.label = 'seed-limit-docs';
    const created = await client.sendRawXmlBatch(X.map(d => `<inv:invoice version="2.0"><inv:invoiceHeader><inv:invoiceType>${d.agenda}</inv:invoiceType><inv:symVar>${d.vs}</inv:symVar><inv:date>${d.date}</inv:date><inv:dateTax>${d.date}</inv:dateTax><inv:dateDue>2026-08-20</inv:dateDue>${d.agenda === 'receivedInvoice' ? '<inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>' : ''}<inv:text>${tag} ${d.key}</inv:text><inv:intNote>${tag} ${d.key}</inv:intNote></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceNone>${d.amount}</typ:priceNone></inv:homeCurrency></inv:invoiceSummary></inv:invoice>`), `${tag} limit docs`, `${tag}-ldocs`, target);
    evidence.limitSeed = responseShape(String((created.transport as any).xml));
    expect(created.isOk()).toBe(true);
    X.forEach((d, i) => ids[d.key] = Number(created.items[i]!.data.producedDetails?.id));
    expect(X.every(d => ids[d.key]! > 0)).toBe(true);
    const seeded = await readDocs(X.map(d => d.key), X);
    evidence.limitDocsBefore = seeded;
    const text96 = `${tag} X1 `.padEnd(96, 'Z'), text97 = `${text96}Q`;
    expect(text96).toHaveLength(96);
    const xrows: Row[] = [
      { movement: movementBase + 90, date: '2026-08-05', amount: X[0]!.amount, direction: 'expense', vs: X[0]!.vs, text: 'control', expect: 'matched', doc: 'X0' },
      { movement: movementBase + 91, date: '2026-08-06', amount: X[1]!.amount, direction: 'expense', vs: X[1]!.vs, text: 'text 96', expect: 'matched', doc: 'X1' },
      { movement: movementBase + 92, date: '2026-08-07', amount: X[2]!.amount, direction: 'expense', vs: X[2]!.vs, text: 'VS 20', expect: 'matched', doc: 'X2' }
    ];
    const xpdf = join(outDir, 'vypis-2026-08.pdf');
    const xpay = await statementPdf(xpdf, '2026-08', [...xrows, { movement: movementBase + 93, date: '2026-08-08', amount: X[3]!.amount, direction: 'expense', vs: X[3]!.vs, text: 'invalid', expect: 'unmatched' }]);
    xpay[1]!.text = text96;
    const valid = xpay.slice(0, 3), invalidRow = xpay[3]!;
    const xargs = { databaseId: database, sourcePdfPath: xpdf, statementPeriod: '2026-08', dateStatement: '2026-08-31', accountNumber: OWN.number, bankCode: OWN.bank, currency: 'CZK' };

    // 1) Invalid inputs through the registered MCP tool: refused, zero POHODA exchanges (reads or writes).
    const invalid = [
      { name: 'text97', payment: { ...invalidRow, text: text97 } },
      { name: 'vs21', payment: { ...invalidRow, variableSymbol: `${X[3]!.vs}${'9'.repeat(21 - X[3]!.vs.length)}` } }
    ];
    evidence.limitInvalid = [];
    for (const v of invalid) for (const execute of [false, true]) {
      const before = transport.results.length;
      const res = await callTool({ ...xargs, execute, payments: [...valid, v.payment] });
      const exchanges = transport.results.length - before;
      evidence.limitInvalid.push({ case: v.name, execute, isError: res.isError, exchanges, textLength: String(v.payment.text ?? '').length, vsLength: String(v.payment.variableSymbol ?? '').length, message: JSON.stringify(res.body).slice(0, 600) });
      expect(res.isError, v.name).toBe(true);
      expect(exchanges, v.name).toBe(0);
    }

    // 2) Guarded raw XML (demo only, test harness, not an MCP tool) to obtain POHODA's actual answer to the
    //    same oversized values, then classify it with the production classifier.
    await assertDemo('raw-oversized-bank');
    const banksBeforeRaw = (await accountBanks()).map(r => Number(h(r).id));
    const rawBank = (d: Doc, move: number, textValue: string, symVar: string) => `<bnk:bank version="2.0"><bnk:bankHeader><bnk:bankType>expense</bnk:bankType><bnk:account><typ:ids>${OWN.ids}</typ:ids></bnk:account><bnk:statementNumber><bnk:statementNumber>008</bnk:statementNumber><bnk:numberMovement>${move}</bnk:numberMovement></bnk:statementNumber><bnk:symVar>${symVar}</bnk:symVar><bnk:dateStatement>2026-08-31</bnk:dateStatement><bnk:datePayment>${d.payDate}</bnk:datePayment><bnk:text>${textValue}</bnk:text><bnk:intNote>${tag} raw-oversized ${d.key}</bnk:intNote></bnk:bankHeader><bnk:bankDetail><bnk:bankLiquidationItem><bnk:settingsLiquidation><bnk:sourceAgenda>${d.agenda}</bnk:sourceAgenda><bnk:sourceDocument><typ:id>${ids[d.key]}</typ:id></bnk:sourceDocument><bnk:liquidationPrice>${d.amount}</bnk:liquidationPrice></bnk:settingsLiquidation><bnk:liquidationItem><bnk:quantity>1</bnk:quantity><bnk:homeCurrency><bnk:unitPrice>${d.amount}</bnk:unitPrice></bnk:homeCurrency></bnk:liquidationItem></bnk:bankLiquidationItem></bnk:bankDetail></bnk:bank>`;
    const rawPack = `${tag}-rawlim`;
    transport.label = 'raw-oversized-bank';
    const rawBefore = transport.results.length;
    const raw = await client.sendRawXmlBatch([rawBank(X[3]!, movementBase + 93, `${tag} X3 `.padEnd(97, 'Q'), X[3]!.vs), rawBank(X[4]!, movementBase + 94, `${tag} X4`, `${X[4]!.vs}${'9'.repeat(21 - X[4]!.vs.length)}`)], `${tag} raw oversized`, rawPack, target);
    const rawXml = transport.results.slice(rawBefore).map(r => r.xml).join('');
    const packId = /<dat:dataPack\b[^>]*\bid="([^"]+)"/.exec(transport.results[rawBefore]!.request)?.[1] ?? rawPack;
    const outcomes = classifyBankWriteResponse(raw as any, packId, 2);
    evidence.limitRaw = { packId, shape: responseShape(rawXml), outcomes };
    const banksAfterRaw = (await accountBanks()).filter(r => !banksBeforeRaw.includes(Number(h(r).id)));
    evidence.limitRawNewBanks = banksAfterRaw.map(r => Number(h(r).id));
    expect(outcomes.map(o => o.outcome)).toEqual(['rejected', 'rejected']);
    expect(outcomes[0]!.errors.map(e => e.note).join(' ')).toMatch(/maxLength.*'96'/);
    expect(outcomes[1]!.errors.map(e => e.note).join(' ')).toMatch(/maxLength.*'20'/);
    expect(outcomes.every(o => !o.bankId && !/<bnk:/.test(o.errors.map(e => e.note).join(' ')))).toBe(true);
    expect(banksAfterRaw).toEqual([]);

    // 3) Exact boundary through the MCP tool: preview then execute; 96-char text and 20-char VS stored unchanged.
    const preview = await callTool({ ...xargs, execute: false, payments: valid });
    evidence.limitPreview = preview.body;
    expect(preview.isError).toBe(false);
    const pm = new Map(preview.body.rows.map((r: any) => [r.movement, r]));
    for (const r of xrows) expect((pm.get(r.movement) as any)?.status, r.text).toBe('matched');
    const banksBefore = (await accountBanks()).map(r => Number(h(r).id));
    await assertDemo('execute-limit-boundary');
    const before = transport.results.length;
    const res = await callTool({ ...xargs, execute: true, payments: valid });
    evidence.limitExecute = res;
    evidence.limitWrite = transport.results.slice(before).filter(r => /<bnk:bank version=/.test(r.request)).map(r => ({ durationMs: r.durationMs, requestPath: r.requestPath, responsePath: r.responsePath, shape: responseShape(r.xml) }));
    const fresh = (await accountBanks()).filter(r => !banksBefore.includes(Number(h(r).id)));
    evidence.limitNewBanks = fresh.map(r => ({ id: Number(h(r).id), movement: h(r).statementNumber?.numberMovement, textLength: String(h(r).text ?? '').length, symVar: String(h(r).symVar ?? ''), datePayment: h(r).datePayment }));
    const after = await readDocs(X.map(d => d.key), X);
    evidence.limitDocsAfter = after;
    expect(bankWrites(before)).toBe(3); expect(nonBankWrites(before)).toBe(0);
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ ok: true, settled: 3, rejected: 0, writeUncertain: 0, needsReview: 0 });
    expect(res.body.write).toMatchObject({ attempted: 3, created: 3, rejected: 0, uncertain: 0, conflicting: 0 });
    expect(fresh.map(r => Number(h(r).id)).sort((a, b) => a - b)).toEqual([...res.body.createdIds].sort((a: number, b: number) => a - b));
    const byMove = (m: number) => fresh.find(r => Number(h(r).id) === res.body.rows.find((x: any) => x.movement === m)?.bankId)!;
    // A 96-character statement description is accepted but never stored: the bank text comes from the settled document.
    expect(String(h(byMove(movementBase + 91)).text)).not.toBe(text96);
    expect(String(h(byMove(movementBase + 91)).text)).toBe(res.body.rows.find((x: any) => x.movement === movementBase + 91).bankText);
    expect(String(h(byMove(movementBase + 92)).symVar)).toBe(vs20);
    for (const d of X.slice(0, 3)) {
      const row = res.body.rows.find((r: any) => r.document?.id === ids[d.key]);
      expect(row?.status, d.key).toBe('settled');
      const links = after[d.key].links.filter((l: any) => l.sourceAgenda === 'bank' && l.sourceId === row.bankId);
      expect(links, d.key).toHaveLength(1);
      expect(Number(links[0].amount)).toBeCloseTo(Number(d.amount), 2);
      expect(after[d.key].liquidation?.amountHome ?? '0').toMatch(/^0(\.0+)?$/);
    }
    // Invalid-input targets: unchanged, still outstanding (remaining == total), no links.
    for (const d of X.slice(3)) {
      expect(after[d.key], d.key).toEqual(seeded[d.key]);
      expect(after[d.key].links).toEqual([]);
      expect(Number(after[d.key].liquidation?.amountHome)).toBeCloseTo(Number(d.amount), 2);
    }
  }, 1_800_000);
});
