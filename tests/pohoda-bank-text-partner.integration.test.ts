/**
 * Live bank record fields from the settled document (POHODA /XML, Parallels demo unit):
 * - bank text "<POHODA generated text>, <document purpose>" for all six liquidable agendas,
 *   shortened purpose at 96 characters, no purpose for POHODA's "Import FA z XML" placeholder;
 * - partnerIdentity copied from the document (address-book link ID + inline address) and verified;
 * - statement number 001–012 with a blank movement field;
 * - a legacy record of the previous version (movement field filled, statement text, no partner,
 *   same marker) is found and reported with field differences, never rewritten or duplicated;
 * - checks only for verified settlements, at the far right of their rows; a retry writes nothing.
 *
 * Gate: POHODA_PRL_VM, POHODA_PRL_ALLOW_WRITES=1, POHODA_PRL_DEMO_DATABASE and POHODA_PRL_DEMO_ICO.
 * Before every write the unit is re-identified live (exact file, ICO, MCPTEST name). Only new
 * MCPTEST records are written; nothing is updated or deleted.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { normalizeSymbol, type StatementPayment } from '../src/mcp/bank-statement.js';
import { checkMarkGeometry } from '../src/mcp/bank-statement-pdf.js';
import { recordsIn } from '../src/mcp/expense-import.js';
import { preparePdfPages } from '../src/mcp/pdf-pages.js';
import { registerPohodaTools } from '../src/mcp/tools.js';
import { PohodaClient } from '../src/pohoda/client.js';
import { accountingModeOf, partnerIdentityOf, type AccountingMode } from '../src/pohoda/bank-settlement.js';
import { toMinorUnits } from '../src/pohoda/money.js';
import type { TransportOptions } from '../src/pohoda/transport.js';
import { parallelsOptionsFromEnv, discoverPohodaInstall, ensureVmRunning, ParallelsPohodaTransport, HarnessXmlClient, extractLiveUnits, selectVerifiedDemoUnit } from './support/parallels-pohoda.js';

const opts = parallelsOptionsFromEnv();
const live = opts?.allowWrites && opts.demoDatabase && opts.demoIco ? describe.sequential : describe.skip;
const run = (process.env.POHODA_PRL_RUN || Date.now().toString()).replace(/[^a-zA-Z0-9]/g, '').slice(-12);
const code = Number.parseInt(createHash('sha256').update(`banktext-${run}`).digest('hex').slice(0, 7), 16).toString().padStart(7, '1').slice(0, 7);
const tag = `MCPTEST-BT-${run}`;
const outDir = resolve(process.env.POHODA_PRL_EVIDENCE_DIR || join('tests/output', `banktext-${run}`));
const reportPath = process.env.POHODA_PRL_REPORT || join('tests/output', `banktext-${run}.json`);
const OWN = { number: '123456789', bank: '0100', ids: 'TSB2' };
const PERIOD = '2026-09', STATEMENT_DATE = '2026-09-30', PAY_DATE = '2026-09-21';
const h = (raw: any) => raw.invoiceHeader ?? raw.bankHeader ?? raw.bankAccountHeader ?? raw.addressbookHeader ?? raw;
const arr = (v: any) => v == null ? [] : Array.isArray(v) ? v : [v];
const evidence: Record<string, any> = { run, code, tag, identityChecks: [] };

type Agenda = 'receivedInvoice' | 'commitment' | 'issuedInvoice' | 'receivable' | 'receivedAdvanceInvoice' | 'issuedAdvanceInvoice';
type Doc = { key: string; agenda: Agenda; partner: 'link' | 'inline'; text: string };
const LONG = `${tag} dlouhý účel: servis klimatizace, výměna filtrů a dezinfekce rozvodů v provozovně Brno-sever`;
const DOCS: Doc[] = [
  { key: 'K1', agenda: 'receivedInvoice', partner: 'link', text: `${tag} telefon.služby 5-6/2026` },
  { key: 'K2', agenda: 'receivedInvoice', partner: 'inline', text: LONG },
  { key: 'K3', agenda: 'commitment', partner: 'inline', text: `${tag} ventilátory` },
  { key: 'K4', agenda: 'issuedInvoice', partner: 'inline', text: '' },
  { key: 'K5', agenda: 'receivable', partner: 'inline', text: `${tag} pohledávka` },
  { key: 'K6', agenda: 'receivedAdvanceInvoice', partner: 'link', text: `${tag} záloha stroj` },
  { key: 'K7', agenda: 'issuedAdvanceInvoice', partner: 'inline', text: `${tag} záloha zakázka` }
];
const LEGACY: Doc = { key: 'L', agenda: 'receivedInvoice', partner: 'inline', text: `${tag} legacy` };
const ABBR: Record<Agenda, string> = { receivedInvoice: 'FP', commitment: 'OZ', issuedInvoice: 'FV', receivable: 'OP', receivedAdvanceInvoice: 'PZ', issuedAdvanceInvoice: 'VZ' };
const cents = String(10 + Number(code) % 89);
const amount = (i: number) => `${300 + Number(code) % 500 + i * 7}.${cents}`;
const vs = (i: number) => `${code}${String(i).padStart(2, '0')}`;
const direction = (a: Agenda) => ['issuedInvoice', 'receivable', 'issuedAdvanceInvoice'].includes(a) ? 'receipt' as const : 'expense' as const;
const movementBase = 400000 + (Number(code) % 8999) * 10;
const PAGE = { w: 595, h: 842, crop: { x: 12, y: 18, width: 571, height: 806 } };

live('POHODA bank text, partner and blank movement field via registered MCP tool', () => {
  let transport: ParallelsPohodaTransport, client: PohodaClient, target: TransportOptions, mcp: McpClient, accountId: number, accountingMode: AccountingMode, database: string;
  const ids: Record<string, number> = {}, docRaw: Record<string, any> = {};
  let payments: StatementPayment[], pdfPath: string, args: Record<string, unknown>, executed: any;
  const bankWrites = (from: number) => transport.results.slice(from).reduce((n, r) => n + (r.request.match(/<bnk:bank version=/g)?.length ?? 0), 0);
  const all = [...DOCS, LEGACY];

  async function assertDemo(step: string) {
    const units = extractLiveUnits((await new HarnessXmlClient(transport, opts!.demoIco).listAccountingUnits()).toArray());
    const sel = selectVerifiedDemoUnit(units, opts!.demoDatabase, opts!.demoIco);
    if (!sel.ok) throw Error(`Demo identity check failed before ${step}: ${sel.reason}`);
    if (!/^MCPTEST /.test(sel.unit.name) || sel.unit.database !== opts!.demoDatabase || sel.unit.ico !== opts!.demoIco) throw Error(`Unexpected unit before ${step}: ${sel.unit.database}/${sel.unit.ico}/${sel.unit.name}`);
    evidence.identityChecks.push({ step, database: sel.unit.database, ico: sel.unit.ico, name: sel.unit.name, unitType: sel.unit.unitType });
    return sel.unit;
  }
  async function callTool(a: Record<string, unknown>) {
    const res: any = await mcp.callTool({ name: 'process_bank_statement', arguments: a }, undefined, { timeout: 1_800_000 });
    return { isError: res.isError, body: res.structuredContent ?? (() => { try { return JSON.parse(res.content[0].text); } catch { return res.content; } })() };
  }
  async function readDocs(docs: Doc[]) {
    const response = await client.listRecordsBatch(docs.map(d => ({ agenda: 'invoice', subType: d.agenda, filter: { id: ids[d.key]! }, options: { restrictions: { 'lst:liquidations': true } } })), '', target);
    expect(response.isOk()).toBe(true);
    return Object.fromEntries(docs.map((d, i) => [d.key, recordsIn(response.items[i]!.data).find(r => Number(h(r).id) === ids[d.key])!]));
  }
  async function accountBanks() {
    const response = await client.listRecordsBatch([{ agenda: 'bank', subType: '', filter: {}, options: {} }], '', target);
    expect(response.isOk()).toBe(true);
    return recordsIn(response.items[0]!.data).filter(r => Number(h(r).account?.id) === accountId);
  }
  /** Mirrors BankStatementService's marker so the legacy seed looks exactly like a record of the previous version. */
  const legacyMarker = (p: StatementPayment) => `MCP-BANK:${createHash('sha256').update(JSON.stringify([String(accountId), PERIOD, p.movement, p.date, p.direction, toMinorUnits(p.amount), 'CZK', normalizeSymbol(p.variableSymbol)])).digest('hex').slice(0, 32)}`;

  beforeAll(async () => {
    if (opts!.startVm) await ensureVmRunning(opts!);
    const exePath = opts!.exePath || (await discoverPohodaInstall(opts!)).exePaths[0]!;
    transport = new ParallelsPohodaTransport({ ...opts!, exePath, evidenceDir: outDir });
    const unit = await assertDemo('setup');
    const mode = accountingModeOf(unit.unitType); if (!mode) throw Error(`Unsupported unitType ${unit.unitType}`);
    accountingMode = mode; database = unit.database;
    target = { databaseOverride: unit.database, dataPackIco: unit.ico! };
    client = new PohodaClient({ transport, ico: unit.ico!, database: unit.database, application: 'MCPTEST bank text' });
    const server = new McpServer({ name: 'pohoda-test', version: '0' });
    registerPohodaTools(server, { client, registryClient: null });
    const [a, b] = InMemoryTransport.createLinkedPair();
    mcp = new McpClient({ name: 'mcptest', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);

    const own = recordsIn((await client.listRecordsBatch([{ agenda: 'bankAccount', subType: '', filter: {}, options: {} }], '', target)).items[0]!.data).map(h).find(x => x.ids === OWN.ids && String(x.numberAccount) === OWN.number);
    if (!own) throw Error('Demo account TSB2 is missing; run tests/pohoda-bank.integration.test.ts first.');
    accountId = Number(own.id);
    const adb = recordsIn((await client.listRecordsBatch([{ agenda: 'addressbook', subType: '', filter: {}, options: {} }], '', target)).items[0]!.data);
    const linked = adb.map(r => ({ id: Number(h(r).id), company: String(h(r).identity?.address?.company ?? '') })).find(x => /^MCPTEST/.test(x.company));
    if (!linked) throw Error('No MCPTEST address-book entry for the linked-partner case.');
    evidence.linkedPartner = linked;

    const partnerXml = (d: Doc, i: number) => d.partner === 'link'
      ? `<inv:partnerIdentity><typ:id>${linked.id}</typ:id></inv:partnerIdentity>`
      : `<inv:partnerIdentity><typ:address><typ:company>MCPTEST BT Partner &amp; ${d.key}</typ:company><typ:name>Jan Test</typ:name><typ:city>Brno</typ:city><typ:street>Zkušební ${i + 1}</typ:street><typ:zip>60200</typ:zip><typ:ico>9900${String(i).padStart(4, '0')}</typ:ico><typ:dic>CZ9900${String(i).padStart(4, '0')}</typ:dic></typ:address></inv:partnerIdentity>`;
    const xml = all.map((d, i) => `<inv:invoice version="2.0"><inv:invoiceHeader><inv:invoiceType>${d.agenda}</inv:invoiceType><inv:symVar>${vs(i)}</inv:symVar><inv:date>2026-09-01</inv:date><inv:dateTax>2026-09-01</inv:dateTax><inv:dateDue>2026-09-25</inv:dateDue>${d.agenda === 'receivedInvoice' ? '<inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>' : ''}${d.text ? `<inv:text>${d.text}</inv:text>` : ''}${partnerXml(d, i)}<inv:intNote>${tag} ${d.key}</inv:intNote></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceNone>${amount(i)}</typ:priceNone></inv:homeCurrency></inv:invoiceSummary></inv:invoice>`);
    await assertDemo('seed-documents');
    transport.label = 'seed-documents';
    const created = await client.sendRawXmlBatch(xml, `${tag} documents`, `${tag}-docs`, target);
    evidence.seed = created.items.map(i => ({ state: i.state, id: i.data.producedDetails?.id }));
    expect(created.isOk()).toBe(true);
    all.forEach((d, i) => ids[d.key] = Number(created.items[i]!.data.producedDetails?.id));
    expect(all.every(d => ids[d.key]! > 0)).toBe(true);
    Object.assign(docRaw, await readDocs(all));

    // Statement PDF: cropped page, one row per movement; x is deliberately left of the text (ignored).
    pdfPath = join(outDir, `vypis-${PERIOD}.pdf`);
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([PAGE.w, PAGE.h]);
    page.setCropBox(PAGE.crop.x, PAGE.crop.y, PAGE.crop.width, PAGE.crop.height);
    page.drawText(`MCPTEST Banka - vypis ${PERIOD} (${tag})`, { x: 40, y: 790, size: 11, font });
    const rows = [...all.map((d, i) => ({ movement: movementBase + i, amount: amount(i), direction: direction(d.agenda), vs: vs(i) })), { movement: movementBase + 50, amount: `9${amount(0)}`, direction: 'expense' as const, vs: '' }];
    payments = rows.map((r, i) => {
      const y = 700 - i * 24;
      page.drawText(`${r.movement}  ${PAY_DATE}  ${r.vs}  KARTA PROTISTRANA ${i}  ${r.direction === 'expense' ? '-' : '+'}${r.amount}`, { x: 50, y, size: 9, font });
      const top = PAGE.crop.y + PAGE.crop.height;
      return { movement: r.movement, date: PAY_DATE, amount: r.amount, direction: r.direction, ...(r.vs ? { variableSymbol: r.vs } : {}), text: `KARTA PROTISTRANA ${i}`, mark: { page: 1, x: 0.03, y: Number(((top - (y + 3)) / PAGE.crop.height).toFixed(4)) } };
    });
    await mkdir(dirname(pdfPath), { recursive: true }); await writeFile(pdfPath, await pdf.save());
    args = { databaseId: database, sourcePdfPath: pdfPath, statementPeriod: PERIOD, dateStatement: STATEMENT_DATE, accountNumber: OWN.number, bankCode: OWN.bank, currency: 'CZK', execute: false, payments };

    // Legacy record exactly as the previous version wrote it: movement field, statement text, no partner, marker.
    const lp = payments[all.length - 1]!;
    await assertDemo('seed-legacy');
    transport.label = 'seed-legacy';
    const legacy = await client.writeBatch([{ tool: 'create_bank_document', requestId: 'legacy', header: { type: lp.direction, account: OWN.ids, statementPeriod: PERIOD, numberMovement: String(lp.movement), dateStatement: STATEMENT_DATE, datePayment: lp.date, symVar: lp.variableSymbol, text: lp.text, intNote: `${legacyMarker(lp)}|${LEGACY.agenda}:${ids.L}`, accountingMode, liquidations: [{ agenda: LEGACY.agenda, id: ids.L!, amount: lp.amount }] }, items: [] }], `${tag}-legacy`, target);
    expect(legacy.isOk()).toBe(true);
    evidence.legacyBankId = Number(legacy.items[0]!.data.producedDetails?.id);
    expect(evidence.legacyBankId).toBeGreaterThan(0);
  }, 1_800_000);

  afterAll(async () => {
    await mcp?.close().catch(() => {}); await transport?.cleanup();
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ evidence, exchanges: transport?.results.map(r => ({ label: r.requestPath, responsePath: r.responsePath, durationMs: r.durationMs, exitCode: r.exitCode })) }, null, 2));
  });

  const number = (k: string) => String(h(docRaw[k]).number?.numberRequested?.['#text'] ?? h(docRaw[k]).number?.numberRequested);
  const expectedText = (d: Doc) => {
    const head = `Úhrada ${ABBR[d.agenda]} c. ${number(d.key)}`;
    if (!d.text) return head; // POHODA's "Import FA z XML" placeholder is not a purpose
    const room = 96 - head.length - 2;
    return d.text.length <= room ? `${head}, ${d.text}` : `${head}, ${d.text.slice(0, room).replace(/[\s,;:.\-–/]+$/u, '')}`;
  };

  it('preview: six agendas planned with document text and partner; legacy found by marker; nothing written', async () => {
    expect(String(h(docRaw.K4).text)).toBe('Import FA z XML');
    const from = transport.results.length;
    const { isError, body } = await callTool(args);
    evidence.preview = body;
    expect(isError).toBe(false); expect(bankWrites(from)).toBe(0);
    expect(body).toMatchObject({ state: 'planned', statementNumber: '009', matched: DOCS.length, unmatched: 1 });
    for (const [i, d] of DOCS.entries()) {
      const row = body.rows.find((r: any) => r.movement === movementBase + i);
      expect(row, d.key).toMatchObject({ status: 'matched', document: { id: ids[d.key], agenda: d.agenda }, bankText: expectedText(d) });
      expect(row.bankText.length, d.key).toBeLessThanOrEqual(96);
      if (d.partner === 'link') expect(row.partner, d.key).toMatchObject({ id: evidence.linkedPartner.id, company: evidence.linkedPartner.company });
      else expect(row.partner, d.key).toEqual({ company: `MCPTEST BT Partner & ${d.key}` });
    }
    expect(body.rows.find((r: any) => r.movement === movementBase + 1).textTruncated).toBe(true);
    expect(body.rows.find((r: any) => r.movement === movementBase + all.length - 1)).toMatchObject({ status: 'existing', bankId: evidence.legacyBankId });
  }, 900_000);

  it('execute: settles every agenda; stored text, partner and blank movement field verified; legacy reported, not rewritten', async () => {
    const before = (await accountBanks()).map(r => Number(h(r).id));
    await assertDemo('execute');
    const from = transport.results.length;
    const { isError, body } = await callTool({ ...args, execute: true });
    executed = body; evidence.execute = body;
    const writes = transport.results.slice(from).filter(r => /<bnk:bank version=/.test(r.request));
    evidence.writeRequests = writes.map(r => r.requestPath);
    expect(bankWrites(from)).toBe(DOCS.length);
    for (const w of writes) expect(w.request).not.toContain('numberMovement');
    expect(isError).toBe(true); // ok=false only because the legacy row needs review
    expect(body).toMatchObject({ ok: false, state: 'processed', statementNumber: '009', settled: DOCS.length, unmatched: 1, needsReview: 1, rejected: 0, writeUncertain: 0 });
    const fresh = (await accountBanks()).filter(r => !before.includes(Number(h(r).id)));
    expect(fresh.map(r => Number(h(r).id)).sort((x, y) => x - y)).toEqual([...body.createdIds].sort((x: number, y: number) => x - y));
    const after = await readDocs(all);
    evidence.bankFields = fresh.map(r => ({ id: Number(h(r).id), statementNumber: h(r).statementNumber, text: h(r).text, partner: h(r).partnerIdentity, items: arr(r.bankDetail?.bankItem).map((i: any) => i.text) }));
    for (const [i, d] of DOCS.entries()) {
      const row = body.rows.find((r: any) => r.movement === movementBase + i), bank = fresh.find(r => Number(h(r).id) === row.bankId)!;
      expect(row, d.key).toMatchObject({ status: 'settled', verified: true }); expect(row.fieldDifferences, d.key).toBeUndefined();
      expect(h(bank).statementNumber, d.key).toEqual({ statementNumber: '009' });
      expect(String(h(bank).text), d.key).toBe(expectedText(d));
      expect(arr(bank.bankDetail?.bankItem).map((x: any) => x.text), d.key).toEqual([`Úhrada ${ABBR[d.agenda]} c. ${number(d.key)}`]);
      expect(partnerIdentityOf(bank), d.key).toEqual(partnerIdentityOf(docRaw[d.key]));
      if (d.partner === 'link') expect(partnerIdentityOf(bank)?.id, d.key).toBe(evidence.linkedPartner.id);
      const links = arr(after[d.key].liquidations?.liquidation).filter((l: any) => l.sourceAgenda === 'bank' && Number(l.sourceDocument?.id) === row.bankId);
      expect(links, d.key).toHaveLength(1);
    }
    const legacy = body.rows.find((r: any) => r.movement === movementBase + all.length - 1);
    expect(legacy).toMatchObject({ status: 'needs_review', verified: true, doNotRetry: true, bankId: evidence.legacyBankId });
    expect(legacy.fieldDifferences.map((x: any) => x.field)).toEqual(expect.arrayContaining(['statementNumber.numberMovement', 'text', 'partnerIdentity.address.company']));
    const legacyBank = (await accountBanks()).find(r => Number(h(r).id) === evidence.legacyBankId)!;
    expect(String(h(legacyBank).statementNumber?.numberMovement)).toBe(String(movementBase + all.length - 1)); // untouched

    // PDF: checks only for the verified rows, at the far right of each row; none for legacy/unmatched, none further left.
    const rendered = await preparePdfPages({ pdfPath: body.annotatedPdf.path, outputDirectory: join(outDir, 'render'), format: 'png', dpi: 100 });
    const img = await loadImage(await readFile(rendered.pages[0]!.path)), canvas = createCanvas(img.width, img.height), ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const sx = img.width / PAGE.crop.width;
    const green = (x: number, y: number, w: number, hh: number) => { const data = ctx.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(hh))).data; let n = 0; for (let k = 0; k < data.length; k += 4) if (data[k + 1]! > 90 && data[k]! < 90 && data[k + 1]! - data[k]! > 40) n++; return n; };
    evidence.pixels = payments.map(p => {
      const g = checkMarkGeometry(PAGE.crop.width, PAGE.crop.height, p.mark.y), top = (g.centerY - g.size / 2 - 2) * sx, hh = (g.size + 4) * sx;
      return { movement: p.movement, check: green((g.left - 2) * sx, top, (g.size + 4) * sx, hh), left: green(0, top, (g.left - 3) * sx, hh) };
    });
    for (const p of evidence.pixels) {
      expect(p.check > 0, String(p.movement)).toBe(p.movement < movementBase + DOCS.length);
      expect(p.left, String(p.movement)).toBe(0);
    }
    expect(body.annotatedPdf.marked).toBe(DOCS.length);
  }, 1_800_000);

  it('retry of the same statement writes nothing and reverifies text and partner', async () => {
    if (!executed) throw Error('Execute did not run.');
    const count = (await accountBanks()).length, from = transport.results.length;
    await assertDemo('retry');
    const { body } = await callTool({ ...args, execute: true });
    evidence.retry = body;
    expect(bankWrites(from)).toBe(0);
    expect(body).toMatchObject({ settled: DOCS.length, needsReview: 1, createdIds: [] });
    expect(body.bankTextConvention.source.receivedInvoice).toBe('pohoda');
    expect((await accountBanks()).length).toBe(count);
  }, 1_800_000);
});
