/**
 * Live daňová evidence (singleEntry) bank liquidation proof on Parallels POHODA /XML.
 *
 * Reproduces the client failure (errno 114 + warning 602 at bnk:liquidationItem/bnk:homeCurrency)
 * with the OLD double-entry price branch sent as guarded raw XML to one MCPTEST document, then
 * settles 0 % / 21 % received + issued invoices, a commitment and received/issued advances through
 * the registered process_bank_statement MCP tool, which must read the live unitType and send
 * bnk:homeCurrencyJU/typ:unitPrice. Reads back bank links and zero remaining; a retry writes nothing.
 *
 * Gate: POHODA_PRL_VM, POHODA_PRL_ALLOW_WRITES=1, POHODA_PRL_DE_DATABASE (exact data file) and
 * POHODA_PRL_DE_ICO. Before every write the unit is re-identified live: exact file, ICO, MCPTEST name
 * and unitType singleEntry. Never falls back to another unit. Only new MCPTEST records are written.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const deDatabase = process.env.POHODA_PRL_DE_DATABASE ?? '', deIco = process.env.POHODA_PRL_DE_ICO ?? '';
const live = opts?.allowWrites && deDatabase && deIco ? describe.sequential : describe.skip;
const run = (process.env.POHODA_PRL_RUN || Date.now().toString()).replace(/[^a-zA-Z0-9]/g, '').slice(-12);
const tag = `MCPTEST-DE-${run}`;
const code = Number.parseInt(createHash('sha256').update(`bankde-${run}`).digest('hex').slice(0, 7), 16).toString().padStart(7, '1').slice(0, 7);
const outDir = resolve(process.env.POHODA_PRL_EVIDENCE_DIR || join('tests/output', `bankde-${run}`));
const reportPath = process.env.POHODA_PRL_REPORT || join('tests/output', `bankde-${run}.json`);
const OWN = { number: '123456789', bank: '0100', ids: 'TSB2' };
const evidence: Record<string, any> = { run, tag, code, identityChecks: [] };
const h = (raw: any) => raw.invoiceHeader ?? raw.bankHeader ?? raw.bankAccountHeader ?? raw;
const arr = (v: any) => v == null ? [] : Array.isArray(v) ? v : [v];
const num = (v: any) => Number((v && typeof v === 'object' ? v['#text'] : v) ?? 0);

type Agenda = 'receivedInvoice' | 'commitment' | 'receivedAdvanceInvoice' | 'issuedInvoice' | 'issuedAdvanceInvoice';
type Doc = { key: string; agenda: Agenda; vat: 0 | 21; base: string };
const base = 1000 + (Number(code) % 7000), cents = String(10 + (Number(code) % 89));
const value = (i: number) => `${base + i * 11}.${cents}`;
// 21 % bases are whole crowns so the VAT and total are exact without POHODA rounding.
const DOCS: Doc[] = [
  { key: 'R21', agenda: 'receivedInvoice', vat: 21, base: `${base + 100}.00` },
  { key: 'R0', agenda: 'receivedInvoice', vat: 0, base: value(1) },
  { key: 'C0', agenda: 'commitment', vat: 0, base: value(2) },
  { key: 'RA', agenda: 'receivedAdvanceInvoice', vat: 0, base: value(3) },
  { key: 'I21', agenda: 'issuedInvoice', vat: 21, base: `${base + 200}.00` },
  { key: 'I0', agenda: 'issuedInvoice', vat: 0, base: value(5) },
  { key: 'IA', agenda: 'issuedAdvanceInvoice', vat: 0, base: value(6) }
];
// Target of the OLD double-entry branch; must stay unpaid.
const OLD: Doc = { key: 'OLD', agenda: 'receivedInvoice', vat: 0, base: value(7) };
const vs = (i: number) => `${code}${String(i).padStart(2, '0')}`;
const direction = (a: Agenda) => ['receivedInvoice', 'commitment', 'receivedAdvanceInvoice'].includes(a) ? 'expense' as const : 'receipt' as const;
const movementBase = 300000 + (Number(code) % 8999) * 10;

function invoiceXml(d: Doc, i: number): string {
  const price = d.vat ? `<typ:priceHigh>${d.base}</typ:priceHigh>` : `<typ:priceNone>${d.base}</typ:priceNone>`;
  return `<inv:invoice version="2.0"><inv:invoiceHeader><inv:invoiceType>${d.agenda}</inv:invoiceType><inv:symVar>${vs(i)}</inv:symVar><inv:date>2026-10-0${1 + (i % 9)}</inv:date><inv:dateTax>2026-10-0${1 + (i % 9)}</inv:dateTax><inv:dateDue>2026-10-25</inv:dateDue><inv:text>${tag} ${d.key}</inv:text><inv:intNote>${tag} ${d.key}</inv:intNote></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency>${price}</inv:homeCurrency></inv:invoiceSummary></inv:invoice>`;
}

function responseShape(xml: string) {
  const r = new PohodaResponse(xml);
  return { packState: r.state, programVersion: r.programVersion, items: r.items.map(i => ({ id: i.id, state: i.state, note: i.attributes.note, producedId: i.data.producedDetails?.id, importDetails: i.data.importDetails })) };
}

live('POHODA daňová evidence bank liquidation (homeCurrencyJU) via registered MCP tool', () => {
  let transport: ParallelsPohodaTransport, client: PohodaClient, target: TransportOptions, mcp: McpClient, accountId: number;
  const ids: Record<string, number> = {}, totals: Record<string, string> = {};
  let payments: StatementPayment[], pdfPath: string, args: Record<string, unknown>, planOk = false, executed: any;
  const bankWrites = (from: number) => transport.results.slice(from).reduce((n, r) => n + (r.request.match(/<bnk:bank version=/g)?.length ?? 0), 0);

  /** Exact file + ICO + MCPTEST name + singleEntry, re-read live before every write. */
  async function assertDe(step: string) {
    const units = extractLiveUnits((await new HarnessXmlClient(transport, deIco).listAccountingUnits()).toArray());
    const sel = selectVerifiedDemoUnit(units, deDatabase, deIco);
    if (!sel.ok) throw Error(`DE identity check failed before ${step}: ${sel.reason}`);
    if (!/^MCPTEST /.test(sel.unit.name) || sel.unit.unitType !== 'singleEntry' || sel.unit.database !== deDatabase) throw Error(`Unexpected unit before ${step}: ${sel.unit.database}/${sel.unit.ico}/${sel.unit.name}/${sel.unit.unitType}`);
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
    const out: Record<string, any> = {};
    docs.forEach((d, i) => {
      const raw = recordsIn(response.items[i]!.data).find(r => Number(h(r).id) === ids[d.key])!;
      const home = raw.invoiceSummary?.homeCurrency ?? {};
      out[d.key] = { id: ids[d.key], agenda: h(raw).invoiceType, liquidation: h(raw).liquidation ?? null, home, links: arr(raw.liquidations?.liquidation).map((l: any) => ({ sourceAgenda: l.sourceAgenda, sourceId: Number(l.sourceDocument?.id), amount: String(l.amount), date: l.date })) };
    });
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
    const unit = await assertDe('setup');
    target = { databaseOverride: unit.database, dataPackIco: unit.ico! };
    client = new PohodaClient({ transport, ico: unit.ico!, database: unit.database, application: 'MCPTEST bank DE' });
    const server = new McpServer({ name: 'pohoda-test', version: '0' });
    registerPohodaTools(server, { client, registryClient: null });
    const [a, b] = InMemoryTransport.createLinkedPair();
    mcp = new McpClient({ name: 'mcptest', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);

    const listAccounts = async () => recordsIn((await client.listRecordsBatch([{ agenda: 'bankAccount', subType: '', filter: {}, options: {} }], '', target)).items[0]!.data).map(h);
    let own = (await listAccounts()).find(x => x.ids === OWN.ids && String(x.numberAccount) === OWN.number);
    if (!own) {
      await assertDe('create-bank-account');
      transport.label = 'create-bank-account';
      const created = await client.manageBankAccount('add', { ids: OWN.ids, numberAccount: OWN.number, codeBank: OWN.bank, nameBank: 'MCPTEST DE bank' }, {}, '', target);
      evidence.accountCreate = responseShape(String((created.transport as any).xml));
      expect(created.isOk()).toBe(true);
      own = (await listAccounts()).find(x => x.ids === OWN.ids && String(x.numberAccount) === OWN.number);
    }
    accountId = Number(own!.id); expect(accountId).toBeGreaterThan(0);

    await assertDe('seed-documents');
    transport.label = 'seed-documents';
    const all = [...DOCS, OLD];
    const created = await client.sendRawXmlBatch(all.map(invoiceXml), `${tag} documents`, `${tag}-docs`, target);
    evidence.seedResponse = responseShape(String((created.transport as any).xml));
    expect(created.isOk()).toBe(true);
    all.forEach((d, i) => ids[d.key] = Number(created.items[i]!.data.producedDetails?.id));
    expect(all.every(d => ids[d.key]! > 0)).toBe(true);
  }, 900_000);

  afterAll(async () => {
    await mcp?.close().catch(() => {}); await transport?.cleanup();
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ evidence, exchanges: transport?.results.map(r => ({ label: r.requestPath, responsePath: r.responsePath, durationMs: r.durationMs, exitCode: r.exitCode })) }, null, 2));
  });

  it('seeded DE documents are outstanding with their 0 % / 21 % totals and no links', async () => {
    const before = await readDocs([...DOCS, OLD]);
    evidence.docsBefore = before;
    for (const d of [...DOCS, OLD]) {
      const doc = before[d.key];
      expect(doc.agenda, d.key).toBe(d.agenda);
      expect(doc.links, d.key).toEqual([]);
      const expected = d.vat ? (Number(d.base) * 1.21).toFixed(2) : Number(d.base).toFixed(2);
      if (d.vat) {
        expect(num(doc.home.priceHigh), d.key).toBeCloseTo(Number(d.base), 2);
        expect(num(doc.home.priceHighVAT), d.key).toBeCloseTo(Number(d.base) * 0.21, 2);
        expect(doc.home.priceHighVAT?.rate, d.key).toBe('21');
        expect(num(doc.home.priceHighSum), d.key).toBeCloseTo(Number(expected), 2);
      } else expect(num(doc.home.priceNone), d.key).toBeCloseTo(Number(d.base), 2);
      expect(num(doc.liquidation?.amountHome), d.key).toBeCloseTo(Number(expected), 2);
      totals[d.key] = expected;
    }
  }, 600_000);

  it('OLD double-entry branch (bnk:homeCurrency/bnk:unitPrice) is rejected on DE: warning 602 + errno 114, nothing created', async () => {
    const unit = await assertDe('raw-old-branch');
    expect(unit.unitType).toBe('singleEntry');
    const banksBefore = (await accountBanks()).map(r => Number(h(r).id));
    const amount = totals.OLD ?? Number(OLD.base).toFixed(2);
    const raw = `<bnk:bank version="2.0"><bnk:bankHeader><bnk:bankType>expense</bnk:bankType><bnk:account><typ:ids>${OWN.ids}</typ:ids></bnk:account><bnk:statementNumber><bnk:statementNumber>010</bnk:statementNumber><bnk:numberMovement>${movementBase + 90}</bnk:numberMovement></bnk:statementNumber><bnk:symVar>${vs(7)}</bnk:symVar><bnk:dateStatement>2026-10-31</bnk:dateStatement><bnk:datePayment>2026-10-20</bnk:datePayment><bnk:text>${tag} old PU branch</bnk:text><bnk:intNote>${tag} raw-old-branch</bnk:intNote></bnk:bankHeader><bnk:bankDetail><bnk:bankLiquidationItem><bnk:settingsLiquidation><bnk:sourceAgenda>receivedInvoice</bnk:sourceAgenda><bnk:sourceDocument><typ:id>${ids.OLD}</typ:id></bnk:sourceDocument><bnk:liquidationPrice>${amount}</bnk:liquidationPrice></bnk:settingsLiquidation><bnk:liquidationItem><bnk:quantity>1</bnk:quantity><bnk:homeCurrency><bnk:unitPrice>${amount}</bnk:unitPrice></bnk:homeCurrency></bnk:liquidationItem></bnk:bankLiquidationItem></bnk:bankDetail></bnk:bank>`;
    const pack = `${tag}-old`;
    transport.label = 'raw-old-branch';
    const from = transport.results.length;
    const response = await client.sendRawXmlBatch([raw], `${tag} old branch`, pack, target);
    const xml = transport.results.slice(from).map(r => r.xml).join('');
    const packId = /<dat:dataPack\b[^>]*\bid="([^"]+)"/.exec(transport.results[from]!.request)?.[1] ?? pack;
    const outcomes = classifyBankWriteResponse(response as any, packId, 1);
    const created = (await accountBanks()).filter(r => !banksBefore.includes(Number(h(r).id)));
    const after = await readDocs([OLD]);
    evidence.oldBranch = { request: transport.results[from]!.requestPath, response: transport.results[from]!.responsePath, shape: responseShape(xml), outcomes, createdBanks: created.map(r => Number(h(r).id)), docAfter: after.OLD };
    const details = JSON.stringify(responseShape(xml).items);
    expect(details).toMatch(/"errno":"602"[^}]*bnk:homeCurrency|bnk:homeCurrency[^}]*"errno":"602"/);
    expect(details).toMatch(/"errno":"114"/);
    expect(outcomes.map(o => o.outcome)).toEqual(['rejected']);
    expect(created).toEqual([]);
    expect(after.OLD.links).toEqual([]);
    expect(num(after.OLD.liquidation?.amountHome)).toBeCloseTo(Number(amount), 2);
  }, 600_000);

  it('MCP preview reads live unitType singleEntry and matches all seven DE documents without writing', async () => {
    pdfPath = join(outDir, 'vypis-2026-10.pdf');
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([595, 842]);
    page.drawText(`MCPTEST DE Banka - vypis 2026-10 (${tag})`, { x: 40, y: 800, size: 11, font });
    payments = DOCS.map((d, i) => {
      const y = 700 - i * 22, amount = totals[d.key]!;
      page.drawText(`${movementBase + i}  2026-10-20  ${vs(i)}  ${d.key}  ${direction(d.agenda) === 'expense' ? '-' : '+'}${amount}`, { x: 60, y, size: 9, font });
      return { movement: movementBase + i, date: '2026-10-20', amount, direction: direction(d.agenda), variableSymbol: vs(i), text: `${tag} ${d.key}`, mark: { page: 1, x: 0.03, y: Number(((842 - (y + 3)) / 842).toFixed(4)) } };
    });
    await mkdir(dirname(pdfPath), { recursive: true }); await writeFile(pdfPath, await pdf.save());
    args = { databaseId: deDatabase, sourcePdfPath: pdfPath, statementPeriod: '2026-10', dateStatement: '2026-10-31', accountNumber: OWN.number, bankCode: OWN.bank, currency: 'CZK', execute: false, payments };
    const from = transport.results.length;
    const { isError, body } = await callTool(args);
    evidence.preview = body;
    expect(isError).toBe(false);
    expect(bankWrites(from)).toBe(0);
    expect(body).toMatchObject({ state: 'planned', accountingUnit: { unitType: 'singleEntry', accountingMode: 'singleEntry' }, statementNumber: '010', matched: DOCS.length, unmatched: 0, needsReview: 0 });
    for (const [i, d] of DOCS.entries()) expect(body.rows.find((r: any) => r.movement === movementBase + i)).toMatchObject({ status: 'matched', document: { id: ids[d.key], agenda: d.agenda } });
    planOk = true;
  }, 900_000);

  it('MCP execute sends homeCurrencyJU/typ:unitPrice, settles every DE document to zero with a bank link', async () => {
    if (!planOk) throw Error('Preview plan differed; execute skipped.');
    const banksBefore = (await accountBanks()).map(r => Number(h(r).id));
    await assertDe('execute');
    const from = transport.results.length;
    const { isError, body } = await callTool({ ...args, execute: true });
    executed = body; evidence.execute = body;
    const writes = transport.results.slice(from).filter(r => /<bnk:bank version=/.test(r.request));
    evidence.writeExchanges = writes.map(r => ({ requestPath: r.requestPath, responsePath: r.responsePath, shape: responseShape(r.xml) }));
    expect(bankWrites(from)).toBe(DOCS.length);
    for (const w of writes) {
      expect(w.request).toMatch(/<bnk:homeCurrencyJU>\s*<typ:unitPrice>/);
      expect(w.request).not.toMatch(/<bnk:homeCurrency>/);
      expect(w.request).toContain('<bnk:payVAT>false</bnk:payVAT>');
      expect(w.request).toContain('<typ:priceVAT>');
    }
    expect(JSON.stringify(evidence.writeExchanges)).not.toMatch(/"errno":"(114|602)"/);
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, state: 'processed', accountingUnit: { accountingMode: 'singleEntry' }, settled: DOCS.length, rejected: 0, writeUncertain: 0 });
    const fresh = (await accountBanks()).filter(r => !banksBefore.includes(Number(h(r).id)));
    expect(fresh.map(r => Number(h(r).id)).sort((x, y) => x - y)).toEqual([...body.createdIds].sort((x: number, y: number) => x - y));
    const after = await readDocs([...DOCS, OLD]);
    evidence.docsAfter = after;
    for (const d of DOCS) {
      const row = body.rows.find((r: any) => r.document?.id === ids[d.key]);
      expect(row?.status, d.key).toBe('settled');
      const links = after[d.key].links.filter((l: any) => l.sourceAgenda === 'bank' && l.sourceId === row.bankId);
      expect(links, d.key).toHaveLength(1);
      expect(Number(links[0].amount), d.key).toBeCloseTo(Number(totals[d.key]), 2);
      expect(links[0].date, d.key).toBe('2026-10-20');
      expect(after[d.key].liquidation?.amountHome ?? '0', d.key).toMatch(/^0(\.0+)?$/);
    }
    expect(after.OLD).toEqual(evidence.docsBefore.OLD);
    expect(await readFile(pdfPath)).not.toHaveLength(0);
  }, 1_800_000);

  it('MCP retry of the same statement writes zero new bank records', async () => {
    if (!executed) throw Error('Execute did not run.');
    const count = (await accountBanks()).length;
    await assertDe('retry');
    const from = transport.results.length;
    const { body } = await callTool({ ...args, execute: true });
    evidence.retry = body;
    expect(bankWrites(from)).toBe(0);
    expect(body).toMatchObject({ settled: DOCS.length, createdIds: [] });
    expect((await accountBanks()).length).toBe(count);
  }, 1_800_000);
});
