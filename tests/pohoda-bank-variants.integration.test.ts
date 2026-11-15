/**
 * Live liquidation-state variants for bank statement previews. Gated exactly like
 * the other bank suites (explicit demo database + ICO + write permission + live
 * demo metadata) and writes only new MCPTEST records.
 *
 * Covers real exports of a zero-total invoice (empty inv:liquidation), a paid
 * issued advance invoice (date only), a cancelled pair (storno enum) and an
 * unpaid received advance invoice, then fault-injects one record whose state is
 * missing from every read to prove the preview stays usable and execution writes
 * only payments that record cannot compete for.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BankStatementService, type StatementInput, type StatementPayment } from '../src/mcp/bank-statement.js';
import { recordsIn } from '../src/mcp/expense-import.js';
import { registerPohodaTools } from '../src/mcp/tools.js';
import { PohodaClient } from '../src/pohoda/client.js';
import type { TransportOptions } from '../src/pohoda/transport.js';
import { accountingModeOf, type AccountingMode } from '../src/pohoda/bank-settlement.js';
import { parallelsOptionsFromEnv, discoverPohodaInstall, ensureVmRunning, ParallelsPohodaTransport, HarnessXmlClient, extractLiveUnits, selectVerifiedDemoUnit } from './support/parallels-pohoda.js';

const opts = parallelsOptionsFromEnv();
const live = opts?.allowWrites && opts.demoDatabase && opts.demoIco ? describe.sequential : describe.skip;
const run = (process.env.POHODA_PRL_RUN || Date.now().toString()).replace(/[^a-zA-Z0-9]/g, '').slice(-12);
const code = Number.parseInt(createHash('sha256').update(`variants-${run}`).digest('hex').slice(0, 7), 16).toString().padStart(7, '1').slice(0, 7);
const outDir = resolve(process.env.POHODA_PRL_EVIDENCE_DIR || join('tests/output', `bankvar-${run}`));
const reportPath = process.env.POHODA_PRL_REPORT || join('tests/output', `bankvar-${run}.json`);
const evidence: Record<string, any> = { run, code };
const h = (raw: any) => raw.invoiceHeader ?? raw.bankHeader ?? raw.bankAccountHeader ?? raw;
const arr = (v: any) => v == null ? [] : Array.isArray(v) ? v : [v];
const cents = String(10 + Number(code) % 89);
const amt = (whole: number) => `${whole}.${cents}`;
const vs = (suffix: string) => `${code}${suffix}`;
const movementBase = 300000 + (Number(code) % 60000) * 10;
const OWN = { number: '123456789', bank: '0100' };
type Spec = [key: string, type: string, symVar: string, amount: string];
const SPECS: Spec[] = [
  ['A', 'receivedInvoice', vs('1'), amt(150)],        // unpaid, VS match
  ['AD', 'receivedAdvanceInvoice', vs('2'), amt(180)], // unpaid received advance, VS match
  ['Z', 'receivedInvoice', vs('3'), '0'],              // zero total: empty <inv:liquidation/>
  ['P', 'issuedAdvanceInvoice', vs('4'), amt(100)],    // paid below: date-only state
  ['S', 'receivedInvoice', vs('5'), amt(170)],         // cancelled below (storno)
  ['U', 'receivedInvoice', vs('6'), amt(190)],         // state hidden by the fault proxy
  ['R', 'receivedInvoice', vs('7'), amt(210)]          // amount-only candidate
];

live('POHODA bank liquidation-state variants (live)', () => {
  // Seed liquidations use the live-verified unit type (never assumed).
  let accountingMode: AccountingMode;
  let transport: ParallelsPohodaTransport, client: PohodaClient, target: TransportOptions, database: string;
  let mcp: McpClient, ids: Record<string, number> = {}, input: StatementInput, planOk = false, executed: any;
  const bankWrites = (from: number) => transport.results.slice(from).reduce((n, r) => n + (r.request.match(/<bnk:bank version=/g)?.length ?? 0), 0);
  const otherWrites = (from: number) => transport.results.slice(from).filter(r => /<(inv|adb|vch|int|bka):\w+ version=/.test(r.request)).length;
  /** Hides U's liquidation state from every read: an "unknown" record next to valid data. */
  const hideU = (data: any) => { for (const raw of recordsIn(data)) if (Number(h(raw).id) === ids.U) { delete h(raw).liquidation; delete raw.liquidations; } };
  const faulty = () => ({
    listRecordsBatch: async (...a: Parameters<PohodaClient['listRecordsBatch']>) => { const r = await client.listRecordsBatch(...a); r.items.forEach(i => hideU(i.data)); return r; },
    writeBatch: client.writeBatch.bind(client),
    listAccountingUnits: client.listAccountingUnits.bind(client)
  });
  async function readState(keys: string[], withLinks = true) {
    const agendaOf = (k: string) => SPECS.find(s => s[0] === k)![1];
    const response = await client.listRecordsBatch(keys.map(k => ({ agenda: 'invoice', subType: agendaOf(k), filter: { id: ids[k] }, options: withLinks ? { restrictions: { 'lst:liquidations': true } } : {} })), '', target);
    expect(response.isOk()).toBe(true);
    return Object.fromEntries(keys.map((k, i) => {
      const raw = recordsIn(response.items[i]!.data).find(r => Number(h(r).id) === ids[k])!;
      return [k, { storno: h(raw).storno ?? null, liquidation: h(raw).liquidation ?? null, links: arr(raw.liquidations?.liquidation).map((l: any) => ({ sourceAgenda: l.sourceAgenda ?? null, sourceId: Number(l.sourceDocument?.id) || null, amount: String(l.amount), date: l.date })) }];
    }));
  }

  beforeAll(async () => {
    if (opts!.startVm) await ensureVmRunning(opts!);
    const exePath = opts!.exePath || (await discoverPohodaInstall(opts!)).exePaths[0]!;
    transport = new ParallelsPohodaTransport({ ...opts!, exePath, evidenceDir: outDir });
    const units = extractLiveUnits((await new HarnessXmlClient(transport, opts!.bootstrapIco).listAccountingUnits()).toArray());
    const selection = selectVerifiedDemoUnit(units, opts!.demoDatabase, opts!.demoIco);
    if (!selection.ok) throw Error(selection.reason);
    evidence.demoSelection = selection.evidence;
    database = selection.unit.database;
    const mode = accountingModeOf(selection.unit.unitType);
    if (!mode) throw Error(`Unsupported live unitType '${selection.unit.unitType}' for ${selection.unit.database}`);
    accountingMode = mode;
    target = { databaseOverride: database, dataPackIco: selection.unit.ico! };
    client = new PohodaClient({ transport, ico: selection.unit.ico!, database, application: 'MCPTEST bank variants' });
    const server = new McpServer({ name: 'pohoda-test', version: '0' });
    registerPohodaTools(server, { client, registryClient: null });
    const [a, b] = InMemoryTransport.createLinkedPair();
    mcp = new McpClient({ name: 'mcptest', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);

    const xml = SPECS.map(([k, type, symVar, amount]) => `<inv:invoice version="2.0"><inv:invoiceHeader><inv:invoiceType>${type}</inv:invoiceType><inv:symVar>${symVar}</inv:symVar><inv:date>2026-11-0${1 + SPECS.findIndex(s => s[0] === k) % 8}</inv:date><inv:dateTax>2026-11-02</inv:dateTax><inv:dateDue>2026-11-28</inv:dateDue>${type === 'receivedInvoice' ? '<inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>' : ''}<inv:text>MCPTEST bankvar ${run} ${k}</inv:text><inv:intNote>MCPTEST bankvar ${run} ${k}</inv:intNote></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceNone>${amount}</typ:priceNone></inv:homeCurrency></inv:invoiceSummary></inv:invoice>`);
    transport.label = 'seed-invoices';
    const created = await client.sendRawXmlBatch(xml, 'MCPTEST bankvar invoices', `MCPTEST-bankvar-inv-${run}`, target);
    expect(created.isOk()).toBe(true);
    SPECS.forEach(([k], i) => ids[k] = Number(created.items[i]!.data.producedDetails?.id));
    evidence.ids = ids;
    expect(Object.values(ids).every(id => id > 0)).toBe(true);
    transport.label = 'seed-pay-P';
    const paid = await client.writeBatch([{ tool: 'create_bank_document', requestId: 'P', header: { type: 'receipt', account: 'TSB2', statementPeriod: '2026-11', numberMovement: String(movementBase + 50), dateStatement: '2026-11-30', datePayment: '2026-11-21', symVar: vs('4'), text: `MCPTEST bankvar ${run} pay P`, intNote: `MCPTEST bankvar ${run} seed P`, accountingMode, liquidations: [{ agenda: 'issuedAdvanceInvoice', id: ids.P!, amount: amt(100) }] }, items: [] }], `MCPTEST-bankvar-pay-${run}`, target);
    expect(paid.isOk()).toBe(true);
    transport.label = 'seed-storno-S';
    const storno = await client.sendRawXmlBatch([`<inv:invoice version="2.0"><inv:cancelDocument><typ:sourceDocument><typ:id>${ids.S}</typ:id></typ:sourceDocument></inv:cancelDocument><inv:invoiceHeader><inv:invoiceType>receivedInvoice</inv:invoiceType><inv:text>MCPTEST bankvar ${run} S storno</inv:text></inv:invoiceHeader></inv:invoice>`], 'MCPTEST bankvar storno', `MCPTEST-bankvar-storno-${run}`, target);
    expect(storno.isOk()).toBe(true);
    evidence.seed = { paidP: Number(paid.items[0]!.data.producedDetails?.id), stornoS: Number(storno.items[0]!.data.producedDetails?.id) };

    const rows: [number, string, string, StatementPayment['direction'], string | undefined][] = [
      [0, '2026-12-02', amt(150), 'expense', vs('1')],
      [1, '2026-12-03', amt(180), 'expense', vs('2')],
      [2, '2026-12-04', amt(170), 'expense', vs('5')],
      [3, '2026-12-05', amt(190), 'expense', vs('6')],
      [4, '2026-12-06', amt(210), 'expense', undefined],
      [5, '2026-12-07', amt(100), 'receipt', vs('4')]
    ];
    const pdf = await PDFDocument.create(); pdf.addPage([595, 842]);
    const path = join(outDir, 'vypis-variants.pdf'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, await pdf.save());
    const payments = rows.map(([o, date, amount, direction, symbol]) => ({ movement: movementBase + o, date, amount, direction, ...(symbol ? { variableSymbol: symbol } : {}), text: `MCPTEST bankvar ${run} ${o}`, mark: { page: 1, x: 0.02, y: 0.2 + o * 0.05 } }));
    input = { databaseId: database, sourcePdfPath: path, statementPeriod: '2026-12', dateStatement: '2026-12-31', accountNumber: OWN.number, bankCode: OWN.bank, currency: 'CZK', execute: false, payments };
  }, 600_000);

  afterAll(async () => {
    await mcp?.close().catch(() => {}); await transport?.cleanup();
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ evidence, exchanges: transport?.results.map(r => ({ requestPath: r.requestPath, responsePath: r.responsePath })) }, null, 2));
  });

  it('exports the expected live shapes for zero-total, paid advance, storno and unpaid documents', async () => {
    transport.label = 'shapes';
    const plain = await readState(['A', 'AD', 'Z', 'P', 'S'], false), linked = await readState(['Z', 'P', 'S'], true);
    evidence.shapes = { plain, linked };
    expect(plain.A!.liquidation).toEqual({ amountHome: String(Number(amt(150))) });
    expect(plain.AD!.liquidation).toEqual({ amountHome: String(Number(amt(180))) });
    expect(plain.Z!.liquidation).toBe(''); expect(linked.Z!.links).toEqual([]);           // zero total: empty element, no allocations
    expect(Object.keys(plain.P!.liquidation)).toEqual(['date']);                        // paid issued advance: date only
    expect(linked.P!.links).toEqual([expect.objectContaining({ sourceAgenda: 'bank', sourceId: evidence.seed.paidP })]);
    expect(plain.S!.storno).toBe('cancelledDocument'); expect(Object.keys(plain.S!.liquidation)).toEqual(['date']);
  }, 600_000);

  it('MCP preview: complete plan with zero-total and storno documents present, no writes', async () => {
    const before = transport.results.length;
    transport.label = 'preview';
    const res: any = await mcp.callTool({ name: 'process_bank_statement', arguments: { ...input, databaseId: database } }, undefined, { timeout: 900_000 });
    const preview = res.structuredContent; evidence.preview = preview;
    expect(res.isError).not.toBe(true);
    expect(bankWrites(before)).toBe(0); expect(otherWrites(before)).toBe(0);
    const byMove = Object.fromEntries(preview.rows.map((r: any) => [r.movement - movementBase, r]));
    expect(byMove[0]).toMatchObject({ status: 'matched', reason: 'variableSymbol', document: { id: ids.A } });
    expect(byMove[1]).toMatchObject({ status: 'matched', reason: 'variableSymbol', document: { id: ids.AD, agenda: 'receivedAdvanceInvoice' } });
    expect(byMove[2]).toMatchObject({ status: 'unmatched' }); // cancelled document is never a target
    expect(byMove[3]).toMatchObject({ status: 'matched', document: { id: ids.U } });
    expect(byMove[4]).toMatchObject({ status: 'matched', reason: 'amount', document: { id: ids.R } });
    expect(byMove[5]).toMatchObject({ status: 'unmatched' }); // P already paid
    expect(preview.needsReview).toBe(0);
    // The zero-total document is resolved by the targeted read, never reported as blocking.
    expect(preview.diagnostics?.unresolvedCount ?? 0).toBe(0);
    expect(preview.diagnostics.resolvedByTargetedRead).toBeGreaterThanOrEqual(1);
    expect(preview.diagnostics.issues).toContainEqual(expect.objectContaining({ id: ids.Z, resolution: 'targetedRead' }));
  }, 900_000);

  it('fault-injected unknown record: usable plan, only competing payments blocked, diagnostics name it', async () => {
    const before = transport.results.length;
    transport.label = 'preview-fault';
    const preview = await new BankStatementService(faulty()).process(input, target); evidence.faultPreview = preview;
    expect(bankWrites(before)).toBe(0);
    const byMove = Object.fromEntries(preview.rows.map((r: any) => [r.movement - movementBase, r]));
    expect(byMove[0]).toMatchObject({ status: 'matched', document: { id: ids.A } });
    expect(byMove[1]).toMatchObject({ status: 'matched', document: { id: ids.AD } });
    expect(byMove[2]).toMatchObject({ status: 'needs_review' }); // no live VS target, so its amount could be U's
    expect(byMove[3]).toMatchObject({ status: 'needs_review', blockedBy: [expect.objectContaining({ agenda: 'receivedInvoice', id: ids.U })] });
    expect(byMove[4]).toMatchObject({ status: 'needs_review' }); // unbounded unknown amount competes with amount-only rows
    expect(byMove[5]).toMatchObject({ status: 'unmatched' });   // receipts are another direction
    expect(preview.diagnostics).toMatchObject({ unresolvedCount: 1, blockingCount: 1 });
    expect(preview.diagnostics.issues[0]).toMatchObject({ agenda: 'receivedInvoice', id: ids.U, field: 'invoiceHeader.liquidation', resolution: 'unresolved', movements: [movementBase + 2, movementBase + 3, movementBase + 4] });
    planOk = true;
  }, 900_000);

  it('fault-injected execute writes only unaffected matches and verifies full remaining amounts', async () => {
    if (!planOk) throw Error('Fault plan differed; execute skipped to avoid unintended writes.');
    const before = transport.results.length, stateBefore = await readState(['U', 'R', 'S', 'P']);
    transport.label = 'execute-fault';
    executed = await new BankStatementService(faulty()).process({ ...input, execute: true }, target); evidence.faultExecute = executed;
    expect(bankWrites(before)).toBe(2); expect(otherWrites(before)).toBe(0);
    expect(executed).toMatchObject({ state: 'processed', settled: 2, needsReview: 3, ok: false, annotatedPdf: { marked: 2 } });
    const settled = executed.rows.filter((r: any) => r.status === 'settled');
    expect(settled.map((r: any) => r.document.id)).toEqual([ids.A, ids.AD]);
    const after = await readState(['A', 'AD', 'U', 'R', 'S', 'P']); evidence.afterExecute = after;
    for (const [k, o] of [['A', 0], ['AD', 1]] as const) {
      expect(Object.keys(after[k]!.liquidation)).toEqual(['date']);
      expect(after[k]!.links).toEqual([expect.objectContaining({ sourceAgenda: 'bank', sourceId: settled.find((r: any) => r.movement === movementBase + o).bankId, date: input.payments[o]!.date })]);
    }
    for (const k of ['U', 'R', 'S', 'P']) expect(after[k]).toEqual(stateBefore[k]);
  }, 900_000);

  it('retry with a renamed PDF and the same unknown record writes nothing', async () => {
    const copy = join(outDir, 'vypis-variants-renamed.pdf'); await copyFile(input.sourcePdfPath, copy);
    const before = transport.results.length;
    transport.label = 'retry-fault';
    const retry = await new BankStatementService(faulty()).process({ ...input, sourcePdfPath: copy, execute: true }, target); evidence.faultRetry = retry;
    expect(bankWrites(before)).toBe(0);
    expect(retry).toMatchObject({ settled: 2, createdIds: [] });
    const ids2 = (r: any) => r.rows.filter((x: any) => x.status === 'settled').map((x: any) => x.bankId);
    expect(ids2(retry)).toEqual(ids2(executed));
  }, 900_000);
});
