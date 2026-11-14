/** Live banking proof. All writes are gated and restricted to positively identified MCPTEST demo data. */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { BankStatementService, type StatementInput } from '../src/mcp/bank-statement.js';
import { recordsIn } from '../src/mcp/expense-import.js';
import { PohodaClient } from '../src/pohoda/client.js';
import type { TransportOptions } from '../src/pohoda/transport.js';
import { parallelsOptionsFromEnv, discoverPohodaInstall, ensureVmRunning, ParallelsPohodaTransport, HarnessXmlClient, extractLiveUnits, selectVerifiedDemoUnit } from './support/parallels-pohoda.js';

const opts=parallelsOptionsFromEnv();
const live=opts?.allowWrites && opts.demoDatabase && opts.demoIco ? describe.sequential : describe.skip;
const run=(process.env.POHODA_PRL_RUN || Date.now().toString()).replace(/[^a-zA-Z0-9]/g,'').slice(-12);
const code=Number.parseInt(createHash('sha256').update(run).digest('hex').slice(0,7),16).toString().slice(0,7);
const reportPath=process.env.POHODA_PRL_REPORT || join(tmpdir(),`pohoda-bank-${run}.json`);
const evidence:Record<string,unknown>={};
const h=(raw:any)=>raw.invoiceHeader??raw.bankHeader??raw.bankAccountHeader??raw;

live('POHODA bank settlement production path',()=>{
  let transport:ParallelsPohodaTransport,client:PohodaClient,target:TransportOptions,service:BankStatementService,input:StatementInput;
  let invoiceIds:number[]=[],accountId:number,sourceBytes:Buffer,result:any;
  const values=[148.37,148.37,779.23,389.11];
  async function readInvoices(){
    const response=await client.listRecordsBatch(invoiceIds.map(id=>({agenda:'invoice',subType:'receivedInvoice',filter:{id},options:{restrictions:{'lst:liquidations':true}}})),'',target);
    expect(response.isOk()).toBe(true);return response.items.map((item,i)=>recordsIn(item.data).find(raw=>Number(h(raw).id)===invoiceIds[i])!);
  }
  beforeAll(async()=>{
    if(opts!.startVm)await ensureVmRunning(opts!);
    const exePath=opts!.exePath||(await discoverPohodaInstall(opts!)).exePaths[0]!;
    transport=new ParallelsPohodaTransport({...opts!,exePath});
    const selection=selectVerifiedDemoUnit(extractLiveUnits((await new HarnessXmlClient(transport,opts!.bootstrapIco).listAccountingUnits()).toArray()),opts!.demoDatabase,opts!.demoIco);
    if(!selection.ok)throw Error(selection.reason);
    target={databaseOverride:selection.unit.database,dataPackIco:selection.unit.ico!};
    client=new PohodaClient({transport,ico:selection.unit.ico!,database:selection.unit.database,application:'MCPTEST bank settlement'});
    service=new BankStatementService(client);
    const response=await client.listRecordsBatch([{agenda:'bankAccount',subType:'',filter:{},options:{}}],'',target);
    let account=recordsIn(response.items[0]!.data).find(raw=>h(raw).ids==='TSB2');
    if(!account){
      const created=await client.manageBankAccount('add',{ids:'TSB2',numberAccount:'123456789',codeBank:'0100',nameBank:'MCPTEST second bank'}, {}, '', target);
      expect(created.isOk()).toBe(true);
      const reread=await client.listRecordsBatch([{agenda:'bankAccount',subType:'',filter:{},options:{}}],'',target);
      account=recordsIn(reread.items[0]!.data).find(raw=>h(raw).ids==='TSB2');
    }
    accountId=Number(h(account).id);expect(accountId).toBeGreaterThan(0);
    // Dedicated new documents only; no existing accounting data is changed.
    const rawXml=values.map((amount,index)=>`<inv:invoice version="2.0"><inv:invoiceHeader><inv:invoiceType>receivedInvoice</inv:invoiceType><inv:symVar>${code}${index<2?'1':index}</inv:symVar><inv:date>2026-01-0${index+1}</inv:date><inv:dateTax>2026-01-0${index+1}</inv:dateTax><inv:dateDue>2026-01-15</inv:dateDue><inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT><inv:text>MCPTEST bank ${run} invoice ${index}</inv:text><inv:intNote>MCPTEST bank ${run}</inv:intNote></inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:priceNone>${amount}</typ:priceNone></inv:homeCurrency></inv:invoiceSummary></inv:invoice>`);
    const created=await client.sendRawXmlBatch(rawXml,'MCPTEST bank source invoices',`MCPTEST-bank-inv-${run}`,target);expect(created.isOk()).toBe(true);
    invoiceIds=created.items.map(item=>Number(item.data.producedDetails?.id));expect(invoiceIds.every(id=>id>0)).toBe(true);
    const dir=await mkdtemp(join(tmpdir(),'MCPTEST-bank-'));const pdfPath=join(dir,'bank-statement.pdf');
    const pdf=await PDFDocument.create();const page=pdf.addPage([600,800]);page.drawText(`MCPTEST bank statement ${run}`,{x:50,y:760,size:12});
    const movementBase=1000+Number(code.slice(-4));
    const payments=[...values,98765.43].map((amount,index)=>{
      page.drawText(`${index+1}. Payment ${amount}`,{x:50,y:650-index*50,size:12});
      return {movement:movementBase+index,date:'2026-01-20',amount:index===3?amount+.01:amount,direction:'expense' as const,variableSymbol:index===2?undefined:`${code}${index<2?'1':index}`,text:`MCPTEST bank ${run} movement ${index}`,mark:{page:1,x:.03,y:(800-(650-index*50))/800}};
    });
    await writeFile(pdfPath,await pdf.save());sourceBytes=await readFile(pdfPath);
    input={databaseId:selection.unit.database,sourcePdfPath:pdfPath,statementPeriod:'2026-01',dateStatement:'2026-01-31',accountNumber:'123456789',bankCode:'0100',currency:'CZK',execute:false,payments};
    evidence.context={database:selection.unit.database,invoiceIds,accountId,pdfPath,run};
  },300_000);
  afterAll(async()=>{
    await transport?.cleanup();await mkdir(dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify({evidence,exchanges:transport?.results.map(r=>({requestPath:r.requestPath,responsePath:r.responsePath}))},null,2));
  });
  it('previews matches on the statement account and does not write bank records',async()=>{
    const before=transport.results.length;const preview=await service.process(input,target);evidence.preview=preview;
    expect(preview.account.id).toBe(String(accountId));expect(preview.statementNumber).toBe('001');
    expect(preview.matched).toBe(3);expect(preview.unmatched).toBe(2);
    expect(transport.results.slice(before).every(r=>!/<bnk:bank version=/.test(r.request))).toBe(true);
    expect(preview.rows[0].document.id).toBe(invoiceIds[0]);expect(preview.rows[1].document.id).toBe(invoiceIds[1]);
  },180_000);
  it('creates real liquidation links only for exact matches and checks only those PDF rows',async()=>{
    result=await service.process({...input,execute:true},target);evidence.settled=result;
    expect(result.ok).toBe(true);expect(result.settled).toBe(3);expect(result.unmatched).toBe(2);expect(result.annotatedPdf.marked).toBe(3);
    const invoices=await readInvoices();
    invoices.slice(0,3).forEach((raw,index)=>{
      expect(h(raw).liquidation.amountHome??'0').toBe('0');
      const links=Array.isArray(raw.liquidations?.liquidation)?raw.liquidations.liquidation:[raw.liquidations?.liquidation];
      expect(links.some((l:any)=>l?.sourceAgenda==='bank'&&Number(l?.sourceDocument?.id)===result.rows[index].bankId)).toBe(true);
    });
    expect(h(invoices[3]).liquidation.amountHome).toBe(String(values[3]));
    expect(await readFile(input.sourcePdfPath)).toEqual(sourceBytes);
    expect((await PDFDocument.load(await readFile(result.annotatedPdf.path))).getPageCount()).toBe(1);
    const banks=await client.listRecordsBatch(result.rows.filter((r:any)=>r.status==='settled').map((r:any)=>({agenda:'bank',subType:'',filter:{id:r.bankId},options:{}})),'',target);
    for(const item of banks.items){const raw=recordsIn(item.data)[0]!;expect(Number(h(raw).account.id)).toBe(accountId);expect(h(raw).statementNumber.statementNumber).toBe('001');}
  },180_000);
  it('retries without adding another bank movement',async()=>{
    const before=transport.results.length;const retried=await service.process({...input,execute:true},target);evidence.retry=retried;
    expect(retried.ok).toBe(true);expect(retried.settled).toBe(3);expect(retried.unmatched).toBe(2);
    expect(transport.results.slice(before).every(r=>!/<bnk:bank version=/.test(r.request))).toBe(true);
    expect(retried.rows.filter((r:any)=>r.status==='settled').map((r:any)=>r.bankId)).toEqual(result.rows.filter((r:any)=>r.status==='settled').map((r:any)=>r.bankId));
  },180_000);
  it('stops foreign-currency execution before any accounting write until a verified bank rate is supported',async()=>{
    const before=transport.results.length;
    const eurInput:StatementInput={...input,currency:'EUR',accountNumber:'987654321',statementPeriod:'2026-10',dateStatement:'2026-10-31',execute:true,payments:[{movement:2000+Number(code.slice(-4)),date:'2026-10-20',amount:222.33,direction:'expense',variableSymbol:`${code}8`,mark:{page:1,x:.03,y:.35}}]};
    await expect(service.process(eurInput,target)).rejects.toThrow(/foreign|ciz|FX|CZK|kurz/i);
    expect(transport.results.slice(before).every(r=>!/<bnk:bank version=/.test(r.request))).toBe(true);
    evidence.foreignCurrency='Blocked before accounting writes: verified bank exchange rate required';
  });

});
