/**
 * Bank header limits (bank.xsd text string96, type.xsd symVar string20) on every entry
 * path: registered MCP tools, write batches and the shared XML builder. Oversized input
 * must be refused before any POHODA exchange; the exact 96/20 boundary must pass unchanged.
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPohodaTools } from '../src/mcp/tools.js';
import { PohodaClient } from '../src/pohoda/client.js';
import { BANK_SYMBOL_MAX_LENGTH, BANK_TEXT_MAX_LENGTH } from '../src/pohoda/bank-settlement.js';
import type { CliXmlJobResult, XmlTransport } from '../src/pohoda/transport.js';

class RecordingTransport implements XmlTransport {
  calls: string[] = [];
  async exchange(xml: string, database: string): Promise<CliXmlJobResult> {
    this.calls.push(xml);
    const id = /<dat:dataPackItem[^>]*\bid="([^"]+)"/.exec(xml)?.[1] ?? 'i1';
    return { xml: `<rsp:responsePack version="2.0" state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="${id}" state="ok"/></rsp:responsePack>`, jobId: 'job', database, jobDir: '/tmp/job', queueWaitMs: 0, processSlotWaitMs: 0, durationMs: 1, exitCode: 0, jobRetained: false };
  }
  status() { return { transport: 'recording' }; }
}

const TEXT_96 = 'T'.repeat(BANK_TEXT_MAX_LENGTH), TEXT_97 = `${TEXT_96}x`;
const VS_20 = '1'.repeat(BANK_SYMBOL_MAX_LENGTH), VS_21 = `${VS_20}2`;

async function setup() {
  const transport = new RecordingTransport();
  const client = new PohodaClient({ transport, ico: '12345678', database: 'Db' });
  const server = new McpServer({ name: 'limits', version: '0' });
  registerPohodaTools(server, { client, registryClient: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new McpClient({ name: 'limits', version: '0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res: any = await mcp.callTool({ name, arguments: args });
    return { isError: !!res.isError, text: String(res.content?.[0]?.text ?? '') };
  };
  return { transport, client, call, close: () => mcp.close() };
}
const statement = (payment: Record<string, unknown>) => ({
  databaseId: '12345678_2026.mdb', sourcePdfPath: '/nonexistent/mcptest-limits.pdf', statementPeriod: '2026-07', dateStatement: '2026-07-31', accountNumber: '123456789', bankCode: '0100', currency: 'CZK', execute: true,
  payments: [{ movement: 1, date: '2026-07-01', amount: '100.00', direction: 'expense', mark: { page: 1, x: 0.05, y: 0.5 }, ...payment }]
});
const bankHeader = (extra: Record<string, unknown>) => ({ type: 'expense', account: 'TSB2', statementPeriod: '2026-07', numberMovement: '1', dateStatement: '2026-07-31', datePayment: '2026-07-01', text: 'MCPTEST', ...extra });

describe('bank header limits on every entry path', () => {
  it('process_bank_statement refuses 97-char text and 21-char VS at the MCP schema, before any exchange', async () => {
    const { transport, call, close } = await setup();
    for (const extra of [{ text: TEXT_97 }, { variableSymbol: VS_21 }, { text: TEXT_97, variableSymbol: VS_21 }]) {
      const res = await call('process_bank_statement', statement(extra));
      expect(res.isError, JSON.stringify(extra)).toBe(true);
      expect(res.text).toMatch(/Input validation error|too_big|Too big/i);
    }
    expect(transport.calls).toHaveLength(0);
    await close();
  });

  it('process_bank_statement accepts exactly 96/20 past schema and service validation', async () => {
    const { transport, call, close } = await setup();
    const res = await call('process_bank_statement', statement({ text: TEXT_96, variableSymbol: VS_20 }));
    // Passes both limit checks and fails only on the (absent) source PDF, still before any exchange.
    expect(res.text).not.toMatch(/too_big|Too big|nejvýše/i);
    expect(res.text).toMatch(/ENOENT|no such file|PDF/i);
    expect(transport.calls).toHaveLength(0);
    await close();
  });

  it('create_bank_document and batch_write refuse oversized text/VS before any exchange', async () => {
    const { transport, client, call, close } = await setup();
    for (const extra of [{ text: TEXT_97 }, { symVar: VS_21 }]) {
      const res = await call('create_bank_document', bankHeader(extra));
      expect(res.isError, JSON.stringify(extra)).toBe(true);
      expect(res.text).toMatch(/nejvýše (96|20) znaků/);
      const op = { tool: 'create_bank_document' as const, header: bankHeader(extra), items: [] };
      expect(() => client.validateWriteBatch([op])).toThrow(/nejvýše/);
      await expect(client.writeBatch([op], 'limits')).rejects.toThrow(/nejvýše/);
    }
    expect(transport.calls).toHaveLength(0);
    await close();
  });

  it('builds the exact 96-char text and 20-char VS unchanged into bnk:bankHeader', async () => {
    const { transport, client, call, close } = await setup();
    const res = await call('create_bank_document', bankHeader({ text: TEXT_96, symVar: VS_20 }));
    expect(res.isError).toBe(false);
    await client.writeBatch([{ tool: 'create_bank_document', header: bankHeader({ text: TEXT_96, symVar: VS_20 }), items: [] }], 'limits');
    expect(transport.calls).toHaveLength(2);
    for (const xml of transport.calls) {
      expect(xml).toContain(`<bnk:text>${TEXT_96}</bnk:text>`);
      expect(xml).toContain(`<bnk:symVar>${VS_20}</bnk:symVar>`);
    }
    await close();
  });
});

describe('liquidation price branch in serialized bank XML', () => {
  const liq = [{ agenda: 'issuedInvoice', id: 9, amount: '1470.70', vat: [{rate:'none',base:1470.7,vat:0}] }];
  const write = async (accountingMode?: string) => {
    const transport = new RecordingTransport();
    const client = new PohodaClient({ transport, ico: '12345678', database: 'Db' });
    await client.writeBatch([{ tool: 'create_bank_document', requestId: 'm1', header: bankHeader({ ...(accountingMode ? { accountingMode } : {}), liquidations: liq }), items: [] }], 'pack');
    return transport.calls[0]!;
  };
  it('daňová evidence uses the explicit source price and VAT in homeCurrencyJU', async () => {
    const xml = await write('singleEntry');
    expect(xml).toContain('<typ:unitPrice>1470.7</typ:unitPrice>');
    expect(xml).toContain('<typ:price>1470.7</typ:price>');
    expect(xml).toContain('<typ:priceVAT>0</typ:priceVAT>');
    expect(xml).toContain('<bnk:rateVAT>none</bnk:rateVAT>');
    expect(xml).not.toMatch(/<bnk:homeCurrency>|accountingMode/);
  });
  it('double-entry keeps bnk:homeCurrency/bnk:unitPrice', async () => {
    const xml = await write('doubleEntry');
    expect(xml).toMatch(/<bnk:homeCurrency>\s*<bnk:unitPrice>1470.7<\/bnk:unitPrice>\s*<\/bnk:homeCurrency>/);
    expect(xml).not.toMatch(/homeCurrencyJU/);
  });
  it('refuses a liquidation without a verified accounting mode before any exchange', async () => {
    await expect(write()).rejects.toThrow(/accounting mode/);
  });
});
