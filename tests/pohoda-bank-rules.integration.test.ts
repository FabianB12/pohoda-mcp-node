/**
 * Live bank-statement rule checks beyond the happy path. Gated exactly like the
 * existing bank suite: explicit demo database + ICO + write permission, and the
 * unit must carry live demo metadata. Writes only new MCPTEST records.
 * The December statement runs through the registered MCP tool (zod schema,
 * databaseId resolution) on the production PohodaClient.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { BankStatementService, type StatementInput, type StatementPayment } from '../src/mcp/bank-statement.js';
import { checkMarkGeometry } from '../src/mcp/bank-statement-pdf.js';
import { recordsIn } from '../src/mcp/expense-import.js';
import { registerPohodaTools } from '../src/mcp/tools.js';
import { preparePdfPages } from '../src/mcp/pdf-pages.js';
import { PohodaClient } from '../src/pohoda/client.js';
import type { TransportOptions } from '../src/pohoda/transport.js';
import { accountingModeOf, type AccountingMode } from '../src/pohoda/bank-settlement.js';
import { parallelsOptionsFromEnv, discoverPohodaInstall, ensureVmRunning, ParallelsPohodaTransport, HarnessXmlClient, extractLiveUnits, selectVerifiedDemoUnit } from './support/parallels-pohoda.js';

const opts = parallelsOptionsFromEnv();
const live = opts?.allowWrites && opts.demoDatabase && opts.demoIco ? describe.sequential : describe.skip;
const run = (process.env.POHODA_PRL_RUN || Date.now().toString()).replace(/[^a-zA-Z0-9]/g, '').slice(-12);
const code = Number.parseInt(createHash('sha256').update(`rules-${run}`).digest('hex').slice(0, 7), 16).toString().padStart(7, '1').slice(0, 7);
const outDir = resolve(process.env.POHODA_PRL_EVIDENCE_DIR || join('tests/output', `bankrules-${run}`));
const reportPath = process.env.POHODA_PRL_REPORT || join('tests/output', `bankrules-${run}.json`);
const evidence: Record<string, any> = { run, code, timings: {} };
const h = (raw: any) => raw.invoiceHeader ?? raw.bankHeader ?? raw.bankAccountHeader ?? raw;
const arr = (v: any) => v == null ? [] : Array.isArray(v) ? v : [v];
// Run-specific cents keep amount-only matching away from other demo documents.
const cents = String(10 + Number(code) % 89);
const amt = (whole: number) => `${whole}.${cents}`;
const vs = (suffix: string) => `${code}${suffix}`;
const movementBase = 100000 + (Number(code) % 80000) * 10;
const OWN = { number: '123456789', bank: '0100' };

function czIban(number: string, bank: string): string {
  const bban = bank + '000000' + number.padStart(10, '0');
  let r = 0; for (const d of `${bban}123500`) r = (r * 10 + Number(d)) % 97;
  return `CZ${String(98 - r).padStart(2, '0')}${bban}`;
}

type Row = { movement: number; date: string; amount: string; direction: 'expense' | 'receipt'; vs?: string; counterparty: string; text: string };
const PAGE = { w: 595, h: 842, crop: { x: 15, y: 20, width: 565, height: 800 } };
const rowY = (i: number) => 600 - i * 26;
/** A realistic text-layer statement: header with own account/IBAN, counterparty accounts per row. */
async function statementPdf(path: string, period: string, month: number, rows: Row[]): Promise<StatementPayment[]> {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([PAGE.w, PAGE.h]);
  page.setCropBox(PAGE.crop.x, PAGE.crop.y, PAGE.crop.width, PAGE.crop.height);
  const t = (s: string, x: number, y: number, size = 9) => page.drawText(s, { x, y, size, font });
  t(`MCPTEST Banka a.s. - Bankovni vypis c. ${month} / ${period.slice(0, 4)}`, 40, 790, 12);
  t('Majitel uctu: MCPTEST Demo s.r.o.', 40, 770); t(`Cislo uctu: ${OWN.number}/${OWN.bank}`, 40, 756);
  t(`IBAN: ${czIban(OWN.number, OWN.bank)}`, 40, 742); t('Mena: CZK', 40, 728);
  t(`Obdobi: ${period}`, 40, 714); t(`Datum vypisu: ${lastDay(period)}`, 40, 700);
  t('Pohyb   Datum        Protiucet            VS            Popis                         Castka', 60, 630);
  const payments: StatementPayment[] = [];
  rows.forEach((r, i) => {
    const y = rowY(i);
    t(String(r.movement), 60, y); t(r.date, 110, y); t(r.counterparty, 180, y); t(r.vs ?? '', 290, y); t(r.text, 370, y);
    t(`${r.direction === 'expense' ? '-' : '+'}${r.amount}`, 520, y);
    const top = PAGE.crop.y + PAGE.crop.height;
    payments.push({ movement: r.movement, date: r.date, amount: r.amount, direction: r.direction, ...(r.vs ? { variableSymbol: r.vs } : {}), text: `MCPTEST ${run} ${r.text}`.slice(0, 240), mark: { page: 1, x: 0.02, y: Number(((top - (y + 3)) / PAGE.crop.height).toFixed(4)) } });
  });
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, await pdf.save());
  return payments;
}
function lastDay(period: string) { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10); }

/** Deterministic text-layer reader (not OCR): proves the supplied tool input equals what the PDF says. */
async function extractStatement(path: string) {
  const task = getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: false }), doc = await task.promise;
  const page = await doc.getPage(1), content = await page.getTextContent();
  const lines = new Map<number, { x: number; s: string }[]>();
  for (const item of content.items as any[]) { const y = Math.round(item.transform[5]); lines.set(y, [...(lines.get(y) || []), { x: item.transform[4], s: item.str }]); }
  const text = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([y, parts]) => ({ y, cells: parts.sort((a, b) => a.x - b.x).map(p => p.s.trim()).filter(Boolean) }));
  const all = text.map(l => l.cells.join(' ')).join('\n');
  const header = { account: /Cislo uctu: (\d+)\/(\d{4})/.exec(all), iban: /IBAN: (CZ\d{22})/.exec(all)?.[1], currency: /Mena: ([A-Z]{3})/.exec(all)?.[1], period: /Obdobi: (\d{4}-\d{2})/.exec(all)?.[1], date: /Datum vypisu: (\d{4}-\d{2}-\d{2})/.exec(all)?.[1] };
  const movements = text.filter(l => /^\d{5,6}$/.test(l.cells[0] ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(l.cells[1] ?? '')).map(l => {
    const signed = l.cells.at(-1)!, maybeVs = l.cells[3];
    return { movement: Number(l.cells[0]), date: l.cells[1]!, counterparty: l.cells[2]!, variableSymbol: maybeVs && /^\d+$/.test(maybeVs) ? maybeVs : undefined, direction: signed.startsWith('-') ? 'expense' : 'receipt', amount: signed.slice(1), y: l.y };
  });
  await task.destroy();
  return { header: { accountNumber: header.account?.[1], bankCode: header.account?.[2], iban: header.iban, currency: header.currency, period: header.period, dateStatement: header.date }, movements };
}

/** Green check pixels in each row's far-right check area of the rendered (cropped) page, and anywhere left of it. */
async function greenAtMarks(pdfPath: string, payments: StatementPayment[], dir: string) {
  const rendered = await preparePdfPages({ pdfPath, outputDirectory: dir, format: 'png', dpi: 100 });
  const img = await loadImage(await readFile(rendered.pages[0]!.path)), canvas = createCanvas(img.width, img.height), ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const sx = img.width / PAGE.crop.width;
  const count = (x: number, y: number, w: number, hgt: number) => {
    const data = ctx.getImageData(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), Math.max(1, Math.round(w)), Math.max(1, Math.round(hgt))).data;
    let green = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 1]! > 90 && data[i]! < 90 && data[i + 2]! < 130 && data[i + 1]! - data[i]! > 40) green++;
    return green;
  };
  return payments.map(p => {
    const g = checkMarkGeometry(PAGE.crop.width, PAGE.crop.height, p.mark.y);
    const top = (g.centerY - g.size / 2 - 2) * sx, height = (g.size + 4) * sx;
    return { movement: p.movement, green: count((g.left - 2) * sx, top, (g.size + 4) * sx, height), leftOfCheck: count(0, top, (g.left - 3) * sx, height) };
  });
}

live('POHODA bank statement rules (independent live checks)', () => {
  // Seed liquidations use the live-verified unit type (never assumed).
  let accountingMode: AccountingMode;
  let transport: ParallelsPohodaTransport, client: PohodaClient, target: TransportOptions, database: string, accountId: number;
  let mcp: McpClient, inv: Record<string, number> = {};
  let dec: { input: StatementInput; pdf: string; bytes: Buffer }, planOk = false, decResult: any;
  const bankWrites = (from: number) => transport.results.slice(from).reduce((n, r) => n + (r.request.match(/<bnk:bank version=/g)?.length ?? 0), 0);
  const nonBankWrites = (from: number) => transport.results.slice(from).filter(r => /<(inv|adb|vch|int|bka):\w+ version=/.test(r.request)).length;
  const timed = async <T>(name: string, fn: () => Promise<T>) => { const t = performance.now(); try { return await fn(); } finally { evidence.timings[name] = Math.round(performance.now() - t); } };
  async function readInvoices(ids: Record<string, number>) {
    const entries = Object.entries(ids), agendaOf = (k: string) => k === 'R6' ? 'issuedInvoice' : 'receivedInvoice';
    const response = await client.listRecordsBatch(entries.map(([k, id]) => ({ agenda: 'invoice', subType: agendaOf(k), filter: { id }, options: { restrictions: { 'lst:liquidations': true } } })), '', target);
    expect(response.isOk()).toBe(true);
    return Object.fromEntries(entries.map(([k, id], i) => {
      const raw = recordsIn(response.items[i]!.data).find(r => Number(h(r).id) === id)!;
      return [k, { remaining: String(h(raw).liquidation?.amountHome ?? '0'), links: arr(raw.liquidations?.liquidation).map((l: any) => ({ sourceAgenda: l.sourceAgenda, sourceId: Number(l.sourceDocument?.id), amount: String(l.amount), date: l.date })) }];
    }));
  }
  async function accountBanks() {
    const response = await client.listRecordsBatch([{ agenda: 'bank', subType: '', filter: {}, options: {} }], '', target);
    expect(response.isOk()).toBe(true);
    return recordsIn(response.items[0]!.data).filter(r => Number(h(r).account?.id) === accountId).map(r => Number(h(r).id));
  }
  async function callTool(args: Record<string, unknown>) {
    const res: any = await mcp.callTool({ name: 'process_bank_statement', arguments: args }, undefined, { timeout: 900_000 });
    return res.structuredContent ?? JSON.parse(res.content[0].text);
  }
  const toolArgs = (input: StatementInput) => ({ ...input, databaseId: database });

  beforeAll(async () => {
    if (opts!.startVm) await ensureVmRunning(opts!);
    const exePath = opts!.exePath || (await discoverPohodaInstall(opts!)).exePaths[0]!;
    transport = new ParallelsPohodaTransport({ ...opts!, exePath, evidenceDir: outDir });
    const units = extractLiveUnits((await new HarnessXmlClient(transport, opts!.bootstrapIco).listAccountingUnits()).toArray());
    const selection = selectVerifiedDemoUnit(units, opts!.demoDatabase, opts!.demoIco);
    evidence.units = units.map(u => ({ database: u.database, ico: u.ico, name: (u as any).name }));
    if (!selection.ok) throw Error(selection.reason);
    evidence.demoSelection = selection.evidence;
    const mode = accountingModeOf(selection.unit.unitType);
    if (!mode) throw Error(`Unsupported live unitType '${selection.unit.unitType}' for ${selection.unit.database}`);
    accountingMode = mode;
    database = selection.unit.database;
    target = { databaseOverride: database, dataPackIco: selection.unit.ico! };
    client = new PohodaClient({ transport, ico: selection.unit.ico!, database, application: 'MCPTEST bank rules' });
    const server = new McpServer({ name: 'pohoda-test', version: '0' });
    registerPohodaTools(server, { client, registryClient: null });
    const [a, b] = InMemoryTransport.createLinkedPair();
    mcp = new McpClient({ name: 'mcptest', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);

    const accounts = recordsIn((await client.listRecordsBatch([{ agenda: 'bankAccount', subType: '', filter: {}, options: {} }], '', target)).items[0]!.data).map(h);
    evidence.accounts = accounts.map(a => ({ id: a.id, ids: a.ids, number: a.numberAccount, code: a.codeBank }));
    const own = accounts.find(a => a.ids === 'TSB2' && String(a.numberAccount) === OWN.number);
    if (!own) throw Error('Demo account TSB2 (from the existing bank suite) is missing; run tests/pohoda-bank.integration.test.ts first.');
    accountId = Number(own.id);
    expect(accounts.length).toBeGreaterThan(1); // multiple own accounts: default must not be chosen

    // New MCPTEST invoices only. R1/R2 share VS (oldest has another amount); R3/R4 share an amount;
    // R5 is later partially paid; R6 is an issued invoice for an incoming payment.
    const specs: [string, string, string, string, string][] = [
      ['R1', 'receivedInvoice', vs('1'), '2026-11-01', amt(500)], ['R2', 'receivedInvoice', vs('1'), '2026-11-05', amt(300)],
      ['R3', 'receivedInvoice', vs('3'), '2026-11-02', amt(211)], ['R4', 'receivedInvoice', vs('4'), '2026-11-03', amt(211)],
      ['R5', 'receivedInvoice', vs('5'), '2026-11-04', amt(1000)], ['R6', 'issuedInvoice', vs('6'), '2026-11-06', amt(777)],
      ['R7', 'receivedInvoice', vs('7'), '2026-11-07', amt(123)], ['R8', 'receivedInvoice', vs('8'), '2026-11-08', amt(444)],
      ['R9', 'receivedInvoice', vs('9'), '2026-11-09', amt(55)], ['R10', 'receivedInvoice', vs('10'), '2026-10-02', amt(66)]
    ];
    const xml = specs.map(([k, type, symVar, date, amount]) => `<inv:invoice version="2.0"><inv:invoiceHeader><inv:invoiceType>${type}</inv:invoiceType><inv:symVar>${symVar}</inv:symVar><inv:date>${date}</inv:date><inv:dateTax>${date}</inv:dateTax><inv:dateDue>${date.slice(0, 8)}28</inv:dateDue>${type === 'receivedInvoice' ? '<inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>' : ''}<inv:text>MCPTEST bankrules ${run} ${k}</inv:text><inv:intNote>MCPTEST bankrules ${run} ${k}</inv:intNote></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceNone>${amount}</typ:priceNone></inv:homeCurrency></inv:invoiceSummary></inv:invoice>`);
    transport.label = 'seed-invoices';
    const created = await client.sendRawXmlBatch(xml, 'MCPTEST bankrules invoices', `MCPTEST-bankrules-inv-${run}`, target);
    evidence.seedInvoiceResponse = created.items.map(i => ({ state: i.state, id: i.data.producedDetails?.id, note: i.note }));
    expect(created.isOk()).toBe(true);
    specs.forEach(([k], i) => inv[k] = Number(created.items[i]!.data.producedDetails?.id));
    expect(Object.values(inv).every(id => id > 0)).toBe(true);

    // Partial payment of R5 (400) as a separate earlier movement; it is not part of the tested statement.
    transport.label = 'seed-partial';
    const partial = await client.writeBatch([{ tool: 'create_bank_document', requestId: 'partial', header: { type: 'expense', account: 'TSB2', statementPeriod: '2026-11', numberMovement: String(movementBase + 9), dateStatement: '2026-11-30', datePayment: '2026-11-20', symVar: vs('5'), text: `MCPTEST bankrules ${run} partial`, intNote: `MCPTEST bankrules ${run} seed partial`, accountingMode, liquidations: [{ agenda: 'receivedInvoice', id: inv.R5!, amount: '400.00' }] }, items: [] }], `MCPTEST-bankrules-partial-${run}`, target);
    expect(partial.isOk()).toBe(true);
    // Legacy unliquidated movement for R8 without statement numbering and without an MCP marker.
    transport.label = 'seed-legacy';
    const legacy = await client.sendRawXmlBatch([`<bnk:bank version="2.0"><bnk:bankHeader><bnk:bankType>expense</bnk:bankType><bnk:account><typ:ids>TSB2</typ:ids></bnk:account><bnk:symVar>${vs('8')}</bnk:symVar><bnk:dateStatement>2026-12-31</bnk:dateStatement><bnk:datePayment>2026-12-12</bnk:datePayment><bnk:text>MCPTEST bankrules ${run} legacy</bnk:text><bnk:intNote>MCPTEST bankrules ${run} seed legacy</bnk:intNote></bnk:bankHeader><bnk:bankSummary><bnk:homeCurrency><typ:priceNone>${amt(444)}</typ:priceNone></bnk:homeCurrency></bnk:bankSummary></bnk:bank>`], 'MCPTEST bankrules legacy', `MCPTEST-bankrules-legacy-${run}`, target);
    expect(legacy.isOk()).toBe(true);
    evidence.seed = { invoices: inv, partialBankId: Number(partial.items[0]!.data.producedDetails?.id), legacyBankId: Number(legacy.items[0]!.data.producedDetails?.id) };

    const m = (o: number) => movementBase + o; // gaps in numbering are intentional
    const cp = '2000145399/0800';
    const rows: Row[] = [
      { movement: m(0), date: '2026-12-02', amount: amt(300), direction: 'expense', vs: vs('1'), counterparty: cp, text: 'oldest VS wrong amount' },
      { movement: m(1), date: '2026-12-03', amount: amt(211), direction: 'expense', counterparty: cp, text: 'same amount ambiguous' },
      { movement: m(3), date: '2026-12-04', amount: amt(600), direction: 'expense', vs: vs('5'), counterparty: cp, text: 'remaining after partial' },
      { movement: m(4), date: '2026-12-05', amount: amt(777), direction: 'receipt', vs: vs('6'), counterparty: '19-2000145399/0800', text: 'incoming receipt' },
      { movement: m(6), date: '2026-12-08', amount: amt(123), direction: 'expense', counterparty: cp, text: 'no VS, VS row later' },
      { movement: m(7), date: '2026-12-09', amount: amt(123), direction: 'expense', vs: vs('7'), counterparty: cp, text: 'VS match' },
      { movement: m(9), date: '2026-12-12', amount: amt(444), direction: 'expense', vs: vs('8'), counterparty: cp, text: 'legacy entry exists' },
      { movement: m(10), date: '2026-12-15', amount: amt(98765), direction: 'expense', counterparty: cp, text: 'unmatched' },
      { movement: m(12), date: '2026-12-20', amount: amt(55), direction: 'expense', counterparty: cp, text: 'two rows one invoice A' },
      { movement: m(13), date: '2026-12-21', amount: amt(55), direction: 'expense', counterparty: cp, text: 'two rows one invoice B' }
    ];
    const pdf = join(outDir, 'vypis-2026-12.pdf');
    const payments = await statementPdf(pdf, '2026-12', 12, rows);
    dec = { pdf, bytes: await readFile(pdf), input: { databaseId: database, sourcePdfPath: pdf, statementPeriod: '2026-12', dateStatement: '2026-12-31', accountNumber: OWN.number, bankCode: OWN.bank, iban: czIban(OWN.number, OWN.bank), currency: 'CZK', execute: false, payments } };
    evidence.december = { pdf, sha256: createHash('sha256').update(dec.bytes).digest('hex'), rows };
  }, 600_000);

  afterAll(async () => {
    await mcp?.close().catch(() => {}); await transport?.cleanup();
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ evidence, exchanges: transport?.results.map(r => ({ label: r.requestPath?.split('/').pop(), requestPath: r.requestPath, responsePath: r.responsePath })) }, null, 2));
  });

  it('text-layer PDF extraction equals the supplied tool input (own account, not counterparty)', async () => {
    const got = await extractStatement(dec.pdf);
    evidence.extraction = got;
    expect(got.header).toEqual({ accountNumber: OWN.number, bankCode: OWN.bank, iban: dec.input.iban, currency: 'CZK', period: '2026-12', dateStatement: '2026-12-31' });
    expect(got.movements.map(({ y: _y, counterparty: _c, ...rest }) => ({ ...rest, variableSymbol: rest.variableSymbol }))).toEqual(dec.input.payments.map(p => ({ movement: p.movement, date: p.date, variableSymbol: p.variableSymbol, direction: p.direction, amount: p.amount })));
    expect(got.movements.every(m => !m.counterparty.startsWith(OWN.number))).toBe(true);
  });

  it('MCP tool preview: exact plan, statement 012, no accounting writes', async () => {
    const before = transport.results.length;
    const preview = await timed('decPreviewMs', () => callTool(toolArgs(dec.input)));
    evidence.decPreview = preview;
    expect(bankWrites(before)).toBe(0); expect(nonBankWrites(before)).toBe(0);
    expect(preview).toMatchObject({ state: 'planned', statementNumber: '012', account: { ids: 'TSB2', id: String(accountId) } });
    const byMove = Object.fromEntries(preview.rows.map((r: any) => [r.movement - movementBase, r]));
    expect(byMove[0]).toMatchObject({ status: 'unmatched' }); expect(byMove[0].reason).toMatch(/nejstarší/);
    expect(byMove[1]).toMatchObject({ status: 'unmatched' }); expect(byMove[1].reason).toMatch(/více dokladům/);
    expect(byMove[3]).toMatchObject({ status: 'matched', reason: 'variableSymbol', document: { id: inv.R5 } });
    expect(byMove[4]).toMatchObject({ status: 'matched', reason: 'variableSymbol', document: { id: inv.R6, agenda: 'issuedInvoice' } });
    expect(byMove[6]).toMatchObject({ status: 'unmatched' });
    expect(byMove[7]).toMatchObject({ status: 'matched', reason: 'variableSymbol', document: { id: inv.R7 } });
    expect(byMove[9]).toMatchObject({ status: 'needs_review', bankId: evidence.seed.legacyBankId });
    for (const o of [10, 12, 13]) expect(byMove[o]).toMatchObject({ status: 'unmatched' });
    expect(preview.matched).toBe(3);
    planOk = true;
  }, 600_000);

  it('MCP tool execute: real liquidation only for 3 exact matches; others untouched; checks only on those rows', async () => {
    if (!planOk) throw Error('Preview plan differed; execute skipped to avoid unintended writes.');
    const invBefore = await readInvoices(inv), banksBefore = await accountBanks();
    evidence.invoicesBefore = invBefore;
    const before = transport.results.length;
    decResult = await timed('decExecuteMs', () => callTool(toolArgs({ ...dec.input, execute: true })));
    evidence.decExecute = decResult;
    expect(bankWrites(before)).toBe(3); expect(nonBankWrites(before)).toBe(0);
    expect(decResult).toMatchObject({ state: 'processed', settled: 3, ok: false }); // ok=false only because of the legacy review row
    expect(decResult.rows.filter((r: any) => r.status === 'needs_review').map((r: any) => r.movement)).toEqual([movementBase + 9]);
    const settled = decResult.rows.filter((r: any) => r.status === 'settled');
    expect(settled.map((r: any) => r.movement - movementBase)).toEqual([3, 4, 7]);
    expect(decResult.createdIds.sort()).toEqual(settled.map((r: any) => r.bankId).sort());

    const after = await readInvoices(inv), banksAfter = await accountBanks();
    evidence.invoicesAfter = after;
    expect(banksAfter.filter(id => !banksBefore.includes(id)).sort()).toEqual(decResult.createdIds.sort());
    const pay = (o: number) => dec.input.payments.find(p => p.movement === movementBase + o)!;
    for (const [k, o] of [['R5', 3], ['R6', 4], ['R7', 7]] as const) {
      const row = settled.find((r: any) => r.movement === movementBase + o);
      expect(after[k]!.remaining).toBe('0');
      const link = after[k]!.links.find((l: any) => l.sourceId === row.bankId);
      expect(link).toMatchObject({ sourceAgenda: 'bank', date: pay(o).date });
      expect(Number(link.amount)).toBeCloseTo(Number(pay(o).amount), 2);
    }
    expect(after.R5!.links).toHaveLength(2); // the earlier partial + this remaining payment
    for (const k of ['R1', 'R2', 'R3', 'R4', 'R8', 'R9', 'R10']) expect(after[k]).toEqual(invBefore[k]);

    const pdfOut = decResult.annotatedPdf.path as string;
    expect(await readFile(dec.pdf)).toEqual(dec.bytes);
    expect(pdfOut).not.toBe(dec.pdf); expect(decResult.annotatedPdf.marked).toBe(3);
    const outDoc = await PDFDocument.load(await readFile(pdfOut));
    expect(outDoc.getPage(0).getCropBox()).toEqual(PAGE.crop); expect(outDoc.getPage(0).getRotation().angle).toBe(0);
    const green = await greenAtMarks(pdfOut, dec.input.payments, join(outDir, 'render-out')), base = await greenAtMarks(dec.pdf, dec.input.payments, join(outDir, 'render-src'));
    evidence.markPixels = { annotated: green, source: base };
    expect(base.every(g => g.green === 0)).toBe(true);
    for (const g of green) expect(g.green > 0).toBe([3, 4, 7].includes(g.movement - movementBase));
    expect(green.every(g => g.leftOfCheck === 0)).toBe(true); // far right only, nothing in the row's text area
  }, 900_000);

  it('MCP tool retry with renamed identical PDF writes nothing and reverifies the same IDs', async () => {
    const copy = join(outDir, 'renamed-copy.pdf'); await copyFile(dec.pdf, copy);
    const before = transport.results.length;
    const retry = await timed('decRetryMs', () => callTool(toolArgs({ ...dec.input, sourcePdfPath: copy, execute: true })));
    evidence.decRetry = retry;
    expect(bankWrites(before)).toBe(0); expect(nonBankWrites(before)).toBe(0);
    expect(retry.settled).toBe(3); expect(retry.createdIds).toEqual([]);
    const ids = (r: any) => r.rows.filter((x: any) => x.status === 'settled').map((x: any) => x.bankId);
    expect(ids(retry)).toEqual(ids(decResult));
    expect(retry.rows.find((r: any) => r.movement === movementBase + 9)).toMatchObject({ status: 'needs_review', doNotRetry: true });
  }, 900_000);

  it('November statement with only unmatched movements: no writes, statement 011, PDF not copied', async () => {
    const pdf = join(outDir, 'vypis-2026-11.pdf');
    const payments = await statementPdf(pdf, '2026-11', 11, [
      { movement: movementBase + 20, date: '2026-11-10', amount: amt(87654), direction: 'expense', counterparty: '2000145399/0800', text: 'unknown' },
      { movement: movementBase + 22, date: '2026-11-11', amount: amt(87655), direction: 'receipt', vs: vs('99'), counterparty: '2000145399/0800', text: 'unknown receipt' }
    ]);
    const bytes = await readFile(pdf), banksBefore = await accountBanks(), before = transport.results.length;
    const result = await timed('novExecuteMs', () => new BankStatementService(client).process({ databaseId: database, sourcePdfPath: pdf, statementPeriod: '2026-11', dateStatement: '2026-11-30', accountNumber: OWN.number, bankCode: OWN.bank, currency: 'CZK', execute: true, payments }, target));
    evidence.november = result;
    expect(result).toMatchObject({ ok: true, state: 'processed', statementNumber: '011', settled: 0, unmatched: 2, createdIds: [], annotatedPdf: { path: pdf, marked: 0 } });
    expect(bankWrites(before)).toBe(0); expect(await readFile(pdf)).toEqual(bytes);
    expect(await accountBanks()).toEqual(banksBefore);
  }, 600_000);

  it('October: response lost after a real write is recovered on retry without a duplicate', async () => {
    const pdf = join(outDir, 'vypis-2026-10.pdf');
    const payments = await statementPdf(pdf, '2026-10', 10, [
      { movement: movementBase + 30, date: '2026-10-14', amount: amt(66), direction: 'expense', vs: vs('10'), counterparty: '2000145399/0800', text: 'lost response' }
    ]);
    const input: StatementInput = { databaseId: database, sourcePdfPath: pdf, statementPeriod: '2026-10', dateStatement: '2026-10-31', iban: czIban(OWN.number, OWN.bank), currency: 'CZK', execute: true, payments };
    const lossy = { listRecordsBatch: client.listRecordsBatch.bind(client), listAccountingUnits: client.listAccountingUnits.bind(client), writeBatch: async (...a: Parameters<PohodaClient['writeBatch']>) => { await client.writeBatch(...a); throw Error('Simulated lost response after POHODA wrote'); } };
    const before = transport.results.length;
    const first = await new BankStatementService(lossy).process(input, target);
    evidence.lostFirst = first;
    expect(bankWrites(before)).toBe(1);
    expect(first.rows[0]).toMatchObject({ status: 'write_uncertain', doNotRetry: true }); expect(first.annotatedPdf.marked).toBe(0);
    const copy = join(outDir, 'vypis-2026-10-renamed.pdf'); await copyFile(pdf, copy);
    const mid = transport.results.length;
    const retry = await timed('octRetryMs', () => callTool(toolArgs({ ...input, sourcePdfPath: copy })));
    evidence.lostRetry = retry;
    expect(bankWrites(mid)).toBe(0);
    expect(retry).toMatchObject({ ok: true, settled: 1, createdIds: [], annotatedPdf: { marked: 1 } });
    const after = await readInvoices({ R10: inv.R10! });
    expect(after.R10!.remaining).toBe('0'); expect(after.R10!.links).toHaveLength(1);
    expect(after.R10!.links[0]).toMatchObject({ sourceAgenda: 'bank', sourceId: retry.rows[0].bankId, date: '2026-10-14' });
  }, 900_000);

  it('EUR via MCP tool: dry-run allowed, execute blocked before any write', async () => {
    const before = transport.results.length;
    const eur = { ...dec.input, currency: 'EUR', accountNumber: '987654321', iban: undefined, statementPeriod: '2026-10', dateStatement: '2026-10-31', payments: [dec.input.payments[2]!] };
    const res: any = await mcp.callTool({ name: 'process_bank_statement', arguments: toolArgs({ ...eur, execute: true }) }, undefined, { timeout: 600_000 });
    evidence.eurExecute = res;
    expect(res.isError).toBe(true); expect(JSON.stringify(res.content)).toMatch(/cizoměnových výpisů.*Nic nebylo zapsáno/);
    expect(transport.results.length).toBe(before); // blocked before even reading
    const preview: any = await mcp.callTool({ name: 'process_bank_statement', arguments: toolArgs({ ...eur, execute: false }) }, undefined, { timeout: 600_000 });
    evidence.eurPreview = preview;
    expect(bankWrites(before)).toBe(0); expect(nonBankWrites(before)).toBe(0);
    // Either a read-only plan, or a refusal because the demo has no exactly matching EUR account.
    expect(preview.structuredContent?.state === 'planned' || /matching POHODA accounts/.test(JSON.stringify(preview.content))).toBe(true);
  }, 600_000);
});
