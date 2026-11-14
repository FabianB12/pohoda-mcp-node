import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BankStatementService, classifySettlementDocument, matchStatementPayments, normalizeSymbol, resolveStatementAccount, settlementDocument, type StatementInput, type StatementPayment, type UnknownDocument } from '../src/mcp/bank-statement.js';
import { buildBankLiquidationDetail, statementMonthNumber } from '../src/pohoda/bank-settlement.js';
import { toMinorUnits } from '../src/pohoda/money.js';
import { PohodaResponse } from '../src/pohoda/response.js';
import { recordsIn } from '../src/mcp/expense-import.js';

type Fields=Record<string,any>;
const target={databaseOverride:'12345678_2026.mdb',dataPackIco:'12345678'};
const head=(raw:Fields)=>raw.invoiceHeader??raw.bankHeader??raw.bankAccountHeader;
const account=(id=2,number='000019-2000145399',code='0800',currency='CZK'):Fields=>({bankAccountHeader:{id,ids:`B${id}`,numberAccount:number,codeBank:code,...(currency==='CZK'?{}:{currencyBankAccount:{currency:{ids:currency}}})}});
const invoice=(id=1,amount=100,extras:Fields={}):Fields=>({invoiceHeader:{id,invoiceType:'receivedInvoice',number:{numberRequested:`FP${id}`},date:'2026-09-01',symVar:'123',liquidation:{amountHome:amount},...extras},invoiceSummary:{homeCurrency:{priceNone:amount}}});
const payment=(movement=1,extras:Partial<StatementPayment>={}):StatementPayment=>({movement,date:'2026-10-15',amount:100,direction:'expense',variableSymbol:'123',mark:{page:1,x:0.03,y:0.1+movement/2000},...extras});
const response=(items:Fields[])=>({isOk:()=>true,items:items.map(data=>({state:'ok',data}))});
class Client {
  accounts=[account()]; invoices:Fields[]=[invoice()]; banks:Fields[]=[]; calls:Fields[]=[]; writes:Fields[]=[];
  onList:((requests:Fields[])=>void)|undefined; onWrite:((client:Client)=>void)|undefined;
  throwAfterWrite=false; failBeforeWrite=false; failedWriteResponse=false; failTargeted=false; failScan=false;
  /** Shapes what an unfiltered scan returns (the scan has no lst:liquidations). */
  scanView:((raw:Fields)=>Fields)|undefined;
  async listRecordsBatch(requests:Fields[],_id:string,options:Fields){
    this.calls.push({requests:structuredClone(requests),options});this.onList?.(requests);
    if(this.failScan&&!requests.some(r=>r.filter?.id))return {isOk:()=>false,items:requests.map(()=>({state:'error',data:{}}))};
    if(this.failTargeted&&requests.some(r=>r.filter?.id)&&!this.writes.length)throw Error('Transport timeout');
    return response(requests.map(r=>{
      let rows=r.agenda==='bankAccount'?this.accounts:r.agenda==='bank'?this.banks:this.invoices.filter(raw=>head(raw).invoiceType===r.subType);
      if(r.filter?.id)rows=rows.filter(raw=>Number(head(raw).id)===r.filter.id);
      if(r.options?.idFrom)rows=rows.filter(raw=>Number(head(raw).id)>=r.options.idFrom);
      rows=rows.slice(0,r.options?.count??rows.length);
      if(r.agenda==='invoice'&&!r.filter?.id&&this.scanView)rows=rows.map(raw=>this.scanView!(structuredClone(raw)));
      return {[r.agenda==='bankAccount'?'bankAccount':r.agenda==='bank'?'bank':'invoice']:structuredClone(rows)};
    }));
  }
  async writeBatch(operations:Fields[],pack:string,options:Fields){
    this.writes.push({operations:structuredClone(operations),pack,options});
    if(this.failBeforeWrite)throw Error('Transport failure before output');
    const output:Fields[]=[];
    for(const op of operations){
      const h=op.header,id=100+this.banks.length,l=h.liquidations[0],raw=this.invoices.find(r=>head(r).id===l.id&&head(r).invoiceType===l.agenda)!;
      const currency=h.currency||'CZK';
      this.banks.push({bankHeader:{id,bankType:h.type,account:{id:2,ids:'B2'},statementNumber:{statementNumber:statementMonthNumber(h.statementPeriod),numberMovement:h.numberMovement},dateStatement:h.dateStatement,datePayment:h.datePayment,symVar:h.symVar,intNote:h.intNote},bankSummary:currency==='CZK'?{homeCurrency:{priceNone:l.amount}}:{foreignCurrency:{currency:{ids:currency},priceSum:l.amount}}});
      raw.invoiceHeader.liquidation={date:h.datePayment};
      raw.liquidations={liquidation:{date:h.datePayment,sourceAgenda:'bank',sourceDocument:{id},amount:l.amount,foreignCurrencySource:l.amount}};
      output.push(this.failedWriteResponse?{}:{producedDetails:{id}});
    }
    this.onWrite?.(this);
    if(this.throwAfterWrite)throw Error('Response lost after POHODA wrote');
    return response(output);
  }
}
let dir:string,source:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'bank-settlement-'));source=join(dir,'statement.pdf');const doc=await PDFDocument.create();doc.addPage([600,800]);await writeFile(source,await doc.save());});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
function input(extras:Partial<StatementInput>={}):StatementInput{return{databaseId:target.databaseOverride,sourcePdfPath:source,statementPeriod:'2026-10',dateStatement:'2026-10-31',accountNumber:'19-2000145399/0800',currency:'CZK',payments:[payment()],execute:true,...extras};}
const run=(client:Client,args=input())=>new BankStatementService(client as any).process(args,target);

describe('Bank account and exact matching policy',()=>{
  it('maps every statement month to 001–012',()=>{
    for(let m=1;m<=12;m++)expect(statementMonthNumber(`2026-${String(m).padStart(2,'0')}`)).toBe(String(m).padStart(3,'0'));
    expect(()=>statementMonthNumber('2026-13')).toThrow();
  });
  it('matches own account from normalized domestic number or validated Czech IBAN',()=>{
    const rows=[account(1,'123456789','0100'),account()];
    expect(resolveStatementAccount(input(),rows).id).toBe(2);
    expect(resolveStatementAccount(input({accountNumber:undefined,iban:'CZ65 0800 0000 1920 0014 5399'}),rows).id).toBe(2);
    expect(()=>resolveStatementAccount(input({iban:'CZ6508000000192000145398'}),rows)).toThrow(/checksum/);
  });
  it('does not pick a default, duplicate, wrong-currency or conflicting account',()=>{
    expect(()=>resolveStatementAccount(input({accountNumber:undefined}),[account()])).toThrow(/header/);
    expect(()=>resolveStatementAccount(input(),[account(),account()])).toThrow(/2 matching/);
    expect(()=>resolveStatementAccount(input({currency:'EUR'}),[account()])).toThrow(/0 matching/);
    expect(()=>resolveStatementAccount(input({bankCode:'0100'}),[account()])).toThrow(/Conflicting/);
    expect(()=>resolveStatementAccount(input({iban:'CZ6508000000192000145399',accountNumber:'123/0800'}),[account()])).toThrow(/disagree/);
  });
  it('excludes cancelled accounts at the statement date',()=>{
    const row=account();row.bankAccountHeader.cancelled='2026-09-30';
    expect(()=>resolveStatementAccount(input(),[row])).toThrow(/0 matching/);
  });
  it('normalizes numeric VS without discarding reference digits',()=>{
    expect(normalizeSymbol(' 000123 ')).toBe('123');expect(normalizeSymbol('000')).toBe('');expect(normalizeSymbol('12-3')).toBe('12-3');
  });
  it('reads remaining amount rather than subtracting it from original gross',()=>{
    const raw=invoice(1,100);raw.invoiceHeader.liquidation.amountHome='25.20';
    expect(settlementDocument(raw).remaining).toBe(2520);
    raw.invoiceHeader.liquidation={date:'2026-10-15'};expect(settlementDocument(raw).remaining).toBe(0);
    raw.invoiceHeader.liquidation={};expect(()=>settlementDocument(raw)).toThrow(/receivedInvoice #1 FP1: invoiceHeader.liquidation: Neznámý zůstatek/);
  });
  it('uses oldest same-VS documents once each',()=>{
    const docs=[settlementDocument(invoice(2,100,{date:'2026-10-02'})),settlementDocument(invoice(1,100,{date:'2026-09-01'}))];
    const rows=matchStatementPayments([payment(),payment(2)],'CZK',docs);
    expect(rows.map(r=>r.document?.id)).toEqual([1,2]);
  });
  it('leaves partial/overpayment untouched and never jumps over older same-VS invoice',()=>{
    for(const amount of [99,101])expect(matchStatementPayments([payment(1,{amount})],'CZK',[settlementDocument(invoice())])[0]!.status).toBe('unmatched');
    const docs=[settlementDocument(invoice(1,200)),settlementDocument(invoice(2,100,{date:'2026-10-02'})),settlementDocument(invoice(3,100,{symVar:'other'}))];
    expect(matchStatementPayments([payment()],'CZK',docs)[0]!.status).toBe('unmatched');
  });
  it('falls back to one exact amount only when no VS candidate exists',()=>{
    expect(matchStatementPayments([payment(1,{variableSymbol:'other'})],'CZK',[settlementDocument(invoice())])[0]!.reason).toBe('amount');
    expect(matchStatementPayments([payment(1,{variableSymbol:''})],'CZK',[settlementDocument(invoice()),settlementDocument(invoice(2))])[0]!.status).toBe('unmatched');
  });
  it('gives VS matches priority over earlier amount-only rows',()=>{
    const rows=matchStatementPayments([payment(1,{variableSymbol:''}),payment(2,{variableSymbol:'123'})],'CZK',[settlementDocument(invoice())]);
    expect(rows.map(r=>[r.status,r.document?.id])).toEqual([['unmatched',undefined],['matched',1]]);
  });
  it('leaves same-amount rows competing for one document untouched',()=>{
    const rows=matchStatementPayments([payment(1,{variableSymbol:''}),payment(2,{variableSymbol:'555'})],'CZK',[settlementDocument(invoice())]);
    expect(rows.map(r=>r.status)).toEqual(['unmatched','unmatched']);expect(rows[0]!.reason).toMatch(/více pohybů/);
  });
  it('never falls back to an amount match once same-VS documents are used',()=>{
    const docs=[settlementDocument(invoice(1)),settlementDocument(invoice(2,100,{symVar:'other'}))];
    const rows=matchStatementPayments([payment(1),payment(2)],'CZK',docs);
    expect(rows.map(r=>[r.status,r.document?.id])).toEqual([['matched',1],['unmatched',undefined]]);
  });
  it('never matches opposite direction, another currency, paid or cancelled invoices',()=>{
    const foreign=invoice();foreign.invoiceSummary={foreignCurrency:{currency:{ids:'EUR'},priceSum:100}};foreign.invoiceHeader.liquidation={amountForeign:100};
    const docs=[invoice(1,0),invoice(2,100,{invoiceType:'issuedInvoice'}),invoice(3,100,{storno:'true'}),foreign].map(settlementDocument);
    expect(matchStatementPayments([payment()],'CZK',docs)[0]!.status).toBe('unmatched');
  });
  it('builds a specific import-only liquidation link with exact amount',()=>{
    const xml=buildBankLiquidationDetail([{agenda:'receivedInvoice',id:7,amount:'100.01'}]);
    expect(xml[0]?.['bnk:bankLiquidationItem']).toMatchObject({'bnk:settingsLiquidation':{'bnk:sourceDocument':{'typ:id':7},'bnk:liquidationPrice':100.01},'bnk:liquidationItem':{'bnk:quantity':1,'bnk:homeCurrency':{'bnk:unitPrice':100.01}}});
    expect(()=>buildBankLiquidationDetail([{agenda:'receivedInvoice',id:7,amount:0}])).toThrow();
    expect(()=>buildBankLiquidationDetail([{agenda:'receivedInvoice',id:7,amount:100.001}])).toThrow();
    expect(()=>buildBankLiquidationDetail([{agenda:'receivedInvoice',id:7,amount:1},{agenda:'receivedInvoice',id:7,amount:1}])).toThrow(/Duplicate/);
  });
});

describe('Bank statement processing and verification',()=>{
  it('previews without any accounting write or PDF modification',async()=>{
    const client=new Client(),before=await readFile(source),result=await run(client,input({execute:false}));
    expect(result).toMatchObject({state:'planned',matched:1,statementNumber:'010'});expect(client.writes).toHaveLength(0);expect(await readFile(source)).toEqual(before);expect(client.calls).toHaveLength(1);
  });
  it('allows a foreign-currency preview but rejects execution before any read or write',async()=>{
    const client=new Client();
    client.accounts=[account(2,'000019-2000145399','0800','EUR')];
    client.invoices[0]!.invoiceHeader.liquidation={amountForeign:100};
    client.invoices[0]!.invoiceSummary={foreignCurrency:{currency:{ids:'EUR'},priceSum:100}};
    const preview=await run(client,input({currency:'EUR',execute:false}));
    expect(preview).toMatchObject({state:'planned',matched:1});
    const reads=client.calls.length;
    await expect(run(client,input({currency:'EUR'}))).rejects.toThrow(/cizoměnových výpisů.*Nic nebylo zapsáno/);
    expect(client.calls).toHaveLength(reads);
    expect(client.writes).toHaveLength(0);
  });
  it('writes only matched movements, verifies links and leaves unmatched rows unmarked',async()=>{
    const client=new Client(),before=await readFile(source),result=await run(client,input({payments:[payment(),payment(2,{amount:234,variableSymbol:'999'})]}));
    expect(result).toMatchObject({ok:true,settled:1,unmatched:1,statementNumber:'010',annotatedPdf:{marked:1,originalUnchanged:true}});
    expect(result.rows.map((r:Fields)=>r.status)).toEqual(['settled','unmatched']);
    expect(client.writes).toHaveLength(1);expect(client.writes[0]!.operations).toHaveLength(1);
    expect(client.writes[0]!.operations[0].header).toMatchObject({account:'B2',statementPeriod:'2026-10',numberMovement:'1',liquidations:[{agenda:'receivedInvoice',id:1,amount:100}]});
    expect(await readFile(source)).toEqual(before);expect(result.annotatedPdf.path).not.toBe(source);expect(client.calls).toHaveLength(4);
  });
  it('creates nothing when all rows are unmatched',async()=>{
    const client=new Client(),result=await run(client,input({payments:[payment(1,{amount:99})]}));
    expect(result).toMatchObject({ok:true,settled:0,unmatched:1,annotatedPdf:{path:source,marked:0}});expect(client.writes).toHaveLength(0);
  });
  it('retries a processed or renamed PDF without another bank record',async()=>{
    const client=new Client(),first=await run(client);const copy=join(dir,'renamed.pdf');await writeFile(copy,await readFile(source));
    const again=await run(client,input({sourcePdfPath:copy}));
    expect(first.settled).toBe(1);expect(again.settled).toBe(1);expect(again.createdIds).toEqual([]);expect(client.writes).toHaveLength(1);expect(client.banks).toHaveLength(1);
  });
  it('recovers a lost response by scanning markers and verifying existing liquidation',async()=>{
    const client=new Client();client.throwAfterWrite=true;
    const first=await run(client);expect(first.rows[0]).toMatchObject({status:'write_uncertain',doNotRetry:true});expect(first.annotatedPdf.marked).toBe(0);
    client.throwAfterWrite=false;const retry=await run(client);expect(retry.settled).toBe(1);expect(client.writes).toHaveLength(1);
  });
  it('uses a new transport data-pack id after a known failed attempt with no created record',async()=>{
    const client=new Client();client.failBeforeWrite=true;
    expect((await run(client)).rows[0].status).toBe('write_uncertain');
    client.failBeforeWrite=false;expect((await run(client)).settled).toBe(1);
    expect(client.writes[0]!.pack).not.toBe(client.writes[1]!.pack);
  });
  it('leaves legacy bank records alone instead of duplicating or claiming they are settled',async()=>{
    const client=new Client();await run(client);client.banks[0]!.bankHeader.intNote='Legacy';
    const result=await run(client);expect(result.rows[0]).toMatchObject({status:'needs_review',bankId:100});expect(result.annotatedPdf.marked).toBe(0);expect(client.writes).toHaveLength(1);
  });
  it('stops before writes if the source invoice balance or identity changes',async()=>{
    for(const change of [(r:Fields)=>r.invoiceHeader.liquidation.amountHome=99,(r:Fields)=>r.invoiceHeader.symVar='999']){
      const client=new Client();client.onList=requests=>{if(requests.some(r=>r.filter?.id)&&!client.writes.length)change(client.invoices[0]!);};
      await expect(run(client)).rejects.toThrow(/invoice changed/);expect(client.writes).toHaveLength(0);
    }
  });
  it('never marks a created bank row when its invoice link is absent',async()=>{
    const client=new Client();client.onWrite=c=>{delete c.invoices[0]!.liquidations;};
    const result=await run(client);expect(result).toMatchObject({ok:false,settled:0,createdIds:[100]});expect(result.rows[0]).toMatchObject({status:'needs_review',bankId:100,doNotRetry:true});expect(result.annotatedPdf.marked).toBe(0);
  });
  it.each(['datePayment','dateStatement','bankType','symVar'])('rejects changed stored %s and retains the created ID',async field=>{
    const client=new Client();client.onWrite=c=>c.banks[0]!.bankHeader[field]='wrong';
    const result=await run(client);expect(result.rows[0]).toMatchObject({status:'needs_review',bankId:100});expect(result.annotatedPdf.marked).toBe(0);
  });
  it('rejects wrong bank account, currency and amount in readback',async()=>{
    for(const change of [(c:Client)=>c.banks[0]!.bankHeader.account.id=3,(c:Client)=>c.banks[0]!.bankSummary={foreignCurrency:{currency:{ids:'EUR'},priceSum:100}},(c:Client)=>c.banks[0]!.bankSummary.homeCurrency.priceNone=99]){
      const client=new Client();client.onWrite=change;const result=await run(client);expect(result.settled).toBe(0);expect(result.annotatedPdf.marked).toBe(0);
    }
  });
  it('rejects invalid dates, duplicate movement numbers, wrong target and bad PDFs before writing',async()=>{
    const client=new Client();
    for(const value of [input({dateStatement:'2026-10-32'}),input({payments:[payment(1,{date:'2026-02-30'})]}),input({payments:[payment(),payment()]}),input({databaseId:'other'}),input({sourcePdfPath:join(dir,'missing.pdf')})])await expect(run(client,value)).rejects.toThrow();
    expect(client.writes).toHaveLength(0);
  });
  it('does not create a second bank record when a legacy entry uses other numbering',async()=>{
    const client=new Client();
    client.banks.push({bankHeader:{id:90,bankType:'expense',account:{id:2,ids:'B2'},datePayment:'2026-10-15',dateStatement:'2026-10-31',symVar:'',intNote:'Ručně zadáno'},bankSummary:{homeCurrency:{priceNone:100}}});
    const result=await run(client);
    expect(result.rows[0]).toMatchObject({status:'needs_review',bankId:90,doNotRetry:true});expect(client.writes).toHaveLength(0);expect(result.annotatedPdf.marked).toBe(0);
    client.banks[0]!.bankHeader.symVar='999';expect((await run(client)).settled).toBe(1); // different VS is a different payment
  });
  it('does not treat its own marked records as legacy for identical same-day payments',async()=>{
    const client=new Client();client.invoices=[invoice(1,100,{symVar:'1'}),invoice(2,100,{symVar:'2'})];
    const args=input({payments:[payment(1,{variableSymbol:'1'}),payment(2,{variableSymbol:'2'})]});
    expect((await run(client,args)).settled).toBe(2);const retry=await run(client,args);
    expect(retry).toMatchObject({ok:true,settled:2,createdIds:[]});expect(client.writes).toHaveLength(1);
  });
  it('settles an incoming receipt against an issued invoice and keeps December, payment date and remaining amount',async()=>{
    const client=new Client();client.invoices=[invoice(5,250,{invoiceType:'issuedInvoice',symVar:'77'})];client.invoices[0]!.invoiceHeader.liquidation.amountHome='60.50';
    const result=await run(client,input({statementPeriod:'2026-12',dateStatement:'2026-12-31',payments:[payment(9,{direction:'receipt',variableSymbol:'77',amount:'60.50',date:'2026-12-03'})]}));
    expect(result).toMatchObject({ok:true,settled:1,statementNumber:'012'});
    expect(client.writes[0]!.operations[0].header).toMatchObject({type:'receipt',statementPeriod:'2026-12',numberMovement:'9',datePayment:'2026-12-03',liquidations:[{agenda:'issuedInvoice',id:5,amount:'60.50'}]});
  });
  it('processes 1000 movements with one write and bounded reads',async()=>{
    const client=new Client();client.invoices=Array.from({length:1000},(_,i)=>invoice(i+1,100+i,{symVar:String(i+1)}));
    const payments=Array.from({length:1000},(_,i)=>payment(i+1,{variableSymbol:String(i+1),amount:100+i,mark:{page:1,x:.03,y:.05+i*.0009}}));
    const started=performance.now(),result=await run(client,input({payments})),ms=performance.now()-started;
    expect(result.settled).toBe(1000);expect(client.writes).toHaveLength(1);expect(client.calls).toHaveLength(31);
    expect(client.calls.every(c=>c.requests.length<=100)).toBe(true);expect(ms).toBeLessThan(10_000);
  });
  it('uses one write batch and bounded read batches for 200 movements',async()=>{
    const client=new Client();client.invoices=Array.from({length:200},(_,i)=>invoice(i+1,100,{symVar:String(i+1)}));
    const payments=Array.from({length:200},(_,i)=>payment(i+1,{variableSymbol:String(i+1)}));
    const result=await run(client,input({payments}));expect(result.settled).toBe(200);expect(client.writes).toHaveLength(1);expect(client.calls).toHaveLength(7);
    expect(client.calls.every(c=>c.requests.length<=100)).toBe(true);
  });
});

// Shapes captured live from POHODA 14302.10 in the MCPTEST demo unit (tests/output/bankvariants-*).
const fx=(raw:Fields,currency='EUR')=>{raw.invoiceSummary={foreignCurrency:{currency:{ids:currency},priceSum:100},homeCurrency:{priceNone:2500}};return raw;};
const unknownDoc=(extras:Partial<UnknownDocument>={}):UnknownDocument=>({agenda:'receivedInvoice',id:50,number:'FP50',date:'2026-09-01',symbol:'777',currency:'CZK',issue:{agenda:'receivedInvoice',id:50,number:'FP50',field:'invoiceHeader.liquidation',problem:'x'},...extras});
describe('Liquidation export variants',()=>{
  it('classifies every live-verified shape without inventing a zero',()=>{
    const known=(raw:Fields,withLinks=false)=>{const c=classifySettlementDocument(raw,undefined,withLinks);return c.kind==='known'?c.document.remaining:c.kind;};
    expect(known(invoice(1,100))).toBe(10000); // unpaid {amountHome}
    expect(known(invoice(1,100,{liquidation:{date:'2026-11-20',amountHome:'40'}}))).toBe(4000); // partial
    for(const invoiceType of ['receivedInvoice','commitment','issuedInvoice','receivable','receivedAdvanceInvoice','issuedAdvanceInvoice'])
      expect(known(invoice(1,100,{invoiceType,liquidation:{date:'2026-11-14'}}))).toBe(0); // fully paid: date only
    expect(known(fx(invoice(1,100,{liquidation:{amountHome:'2500',amountForeign:'100'}})))).toBe(10000);
    expect(known(fx(invoice(1,100,{liquidation:{date:'2026-11-20',amountHome:'1500',amountForeign:'60'}})))).toBe(6000);
    expect(known(fx(invoice(1,100,{liquidation:{date:'2026-11-20'}})))).toBe(0);
    expect(known(invoice(1,-100,{liquidation:{amountHome:'-100'}}))).toBe(-10000); // negative document: never a candidate
    // A zero-total document exports <inv:liquidation/>; zero only once a liquidations read proves no allocations.
    const zero=invoice(1,0,{liquidation:''});
    expect(known(zero)).toBe('unknown');expect(known(zero,true)).toBe(0);
    expect(known({...zero,liquidations:{liquidation:{id:1,amount:'5'}}},true)).toBe('unknown');
    expect(known(invoice(1,100,{liquidation:''}),true)).toBe('unknown'); // empty but non-zero total
  });
  it('reports unknown states with agenda, ID, number and field instead of throwing',()=>{
    const cases:[Fields,string,RegExp][]=[
      [invoice(7,100,{liquidation:undefined}),'invoiceHeader.liquidation',/element chybí/],
      [invoice(7,100,{liquidation:{}}),'invoiceHeader.liquidation',/chybí částka i datum/],
      [invoice(7,100,{liquidation:{amountHome:'abc'}}),'invoiceHeader.liquidation.amountHome',/platné číslo/],
      [fx(invoice(7,100,{liquidation:{amountHome:'2500'}})),'invoiceHeader.liquidation.amountForeign',/cizí měně/],
      [invoice(7,100,{date:'2026-02-30'}),'invoiceHeader.date',/datum/]
    ];
    for(const [raw,field,problem] of cases){
      const c=classifySettlementDocument(raw,'receivedInvoice');
      expect(c.kind).toBe('unknown');if(c.kind!=='unknown')continue;
      expect(c.unknown.issue).toMatchObject({agenda:'receivedInvoice',id:7,number:'FP7',field});expect(c.unknown.issue.problem).toMatch(problem);
    }
    const invalidDate=classifySettlementDocument(invoice(7,100,{date:'2026-02-30'}));
    expect(invalidDate.kind==='unknown'&&invalidDate.unknown.remaining).toBe(10000); // amount stays known, only ordering is unknown
    expect(classifySettlementDocument(invoice(7,100,{invoiceType:'receivedCorrectiveTax'}),'receivedInvoice')).toMatchObject({kind:'ignored',issue:{id:7,resolution:'ignored'}});
    expect(classifySettlementDocument(invoice(7,100,{liquidation:undefined,storno:'cancelledDocument'}))).toMatchObject({kind:'ignored'});
    expect(classifySettlementDocument(invoice(7,100,{invoiceType:''}),'commitment')).toMatchObject({kind:'unknown',unknown:{agenda:'commitment',issue:{field:'invoiceHeader.invoiceType'}}});
  });
  it('never matches cancelled or cancelling documents (storno is an enum, not a boolean)',()=>{
    for(const storno of ['cancelledDocument','cancelDocument','true'])
      expect(matchStatementPayments([payment()],'CZK',[settlementDocument(invoice(1,100,{storno}))])[0]!.status).toBe('unmatched');
  });
  it('unknown documents block only payments they could compete for',()=>{
    const docs=[settlementDocument(invoice(1,100,{symVar:'123'})),settlementDocument(invoice(2,250,{symVar:'456'}))];
    const unrelated=[unknownDoc({currency:'EUR'}),unknownDoc({agenda:'issuedInvoice'})]; // other currency / other direction
    expect(matchStatementPayments([payment(),payment(2,{variableSymbol:'',amount:250})],'CZK',docs,unrelated).map(r=>r.status)).toEqual(['matched','matched']);
    // Same VS: the oldest unpaid document cannot be determined.
    const sameVS=matchStatementPayments([payment()],'CZK',docs,[unknownDoc({symbol:'123',date:'2026-12-01'})])[0]!;
    expect(sameVS).toMatchObject({status:'needs_review',blockedBy:[{agenda:'receivedInvoice',id:50,number:'FP50'}]});
    // VS rows naming only known documents are unaffected by an unbounded unknown with another VS.
    expect(matchStatementPayments([payment()],'CZK',docs,[unknownDoc()])[0]!.status).toBe('matched');
    // Unbounded unknown amount blocks an amount-only match and a no-candidate row.
    const rows=matchStatementPayments([payment(1,{variableSymbol:'',amount:250}),payment(2,{variableSymbol:'',amount:999})],'CZK',docs,[unknownDoc()]);
    expect(rows.map(r=>r.status)).toEqual(['needs_review','needs_review']);
    // A known-amount unknown (invalid date) blocks only its own amount.
    const bounded=matchStatementPayments([payment(1,{variableSymbol:'',amount:250}),payment(2,{variableSymbol:'',amount:999})],'CZK',docs,[unknownDoc({remaining:99900})]);
    expect(bounded.map(r=>r.status)).toEqual(['matched','needs_review']);
  });
});

describe('Bank preview with incomplete POHODA data',()=>{
  const broken=(id=9,extras:Fields={})=>invoice(id,500,{symVar:'900',number:{numberRequested:`FP${id}`},liquidation:undefined,...extras});
  it('returns a usable plan when one unrelated record has no liquidation state, with a targeted read first',async()=>{
    const client=new Client();client.invoices=[invoice(1),invoice(2,300,{symVar:'300'}),broken(),invoice(3,0,{invoiceType:'issuedInvoice',liquidation:'',symVar:''})];
    client.invoices[3]!.invoiceSummary={homeCurrency:{priceNone:0}};
    const result=await run(client,input({execute:false,payments:[payment(),payment(2,{amount:300,variableSymbol:'300'}),payment(3,{amount:500,variableSymbol:'900'}),payment(4,{amount:42,variableSymbol:''})]}));
    expect(result).toMatchObject({ok:true,state:'planned',matched:2,needsReview:2});
    expect(result.rows.map((r:Fields)=>[r.movement,r.status])).toEqual([[1,'matched'],[2,'matched'],[3,'needs_review'],[4,'needs_review']]);
    expect(result.rows[2].blockedBy).toEqual([{agenda:'receivedInvoice',id:9,number:'FP9'}]);
    expect(result.diagnostics).toMatchObject({unresolvedCount:1,blockingCount:1,resolvedByTargetedRead:1});
    expect(result.diagnostics.issues[0]).toMatchObject({agenda:'receivedInvoice',id:9,number:'FP9',field:'invoiceHeader.liquidation',resolution:'unresolved',movements:[3,4],liquidationLinks:0});
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/invoiceSummary|priceNone/);
    // One scan plus one targeted read of the two unknown records, with liquidations.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]!.requests.map((r:Fields)=>[r.subType,r.filter.id,r.options.restrictions])).toEqual([['receivedInvoice',9,{'lst:liquidations':true}],['issuedInvoice',3,{'lst:liquidations':true}]]);
    expect(client.writes).toHaveLength(0);
  });
  it('resolves a record whose scan omitted the state by reading it by ID',async()=>{
    const client=new Client();client.scanView=raw=>{delete raw.invoiceHeader.liquidation;return raw;};
    const result=await run(client,input({execute:false}));
    expect(result).toMatchObject({matched:1,needsReview:0,diagnostics:{unresolvedCount:0,resolvedByTargetedRead:1}});
    expect(result.rows[0]).toMatchObject({status:'matched',document:{id:1}});
  });
  it('keeps the preview when the targeted read fails and says so',async()=>{
    const client=new Client();client.invoices.push(broken());client.failTargeted=true;
    const result=await run(client,input({execute:false}));
    expect(result).toMatchObject({state:'planned',matched:1,diagnostics:{unresolvedCount:1}});
    expect(result.diagnostics.issues[0].problem).toMatch(/Cílené čtení selhalo: Transport timeout/);
  });
  it('executes only unaffected matches, never writes or marks a blocked payment, and verifies the full remaining amount',async()=>{
    const client=new Client();client.invoices=[invoice(1),broken()];
    const result=await run(client,input({payments:[payment(),payment(2,{amount:500,variableSymbol:'900'})]}));
    expect(result).toMatchObject({ok:false,state:'processed',settled:1,needsReview:1,createdIds:[100],annotatedPdf:{marked:1}});
    expect(result.rows.map((r:Fields)=>r.status)).toEqual(['settled','needs_review']);
    expect(client.writes[0]!.operations.map((o:Fields)=>o.header.liquidations[0])).toEqual([{agenda:'receivedInvoice',id:1,amount:100}]);
    expect(result.diagnostics.issues[0]).toMatchObject({id:9,movements:[2]});
  });
  it('does not mark a settlement whose read-back has no proven zero remaining',async()=>{
    for(const after of [undefined,{},{amountHome:'0.01'}]){
      const client=new Client();client.onWrite=c=>{c.invoices[0]!.invoiceHeader.liquidation=after;};
      const result=await run(client);
      expect(result.rows[0]).toMatchObject({status:'needs_review',bankId:100,doNotRetry:true});expect(result.annotatedPdf.marked).toBe(0);
    }
  });
  it('stops before writing when a planned target loses its liquidation state, naming the document',async()=>{
    const client=new Client();client.onList=requests=>{if(requests.some(r=>r.filter?.id)&&!client.writes.length)delete client.invoices[0]!.invoiceHeader.liquidation;};
    await expect(run(client)).rejects.toThrow(/invoice changed.*receivedInvoice #1 FP1: POHODA neexportovala stav likvidace/);
    expect(client.writes).toHaveLength(0);
  });
  it('keeps a global scan failure fatal, precise and read-only',async()=>{
    const client=new Client();client.failScan=true;
    await expect(run(client,input({execute:false}))).rejects.toThrow(/Načtení bankovních účtů.*selhalo: Duplicate scan failed.*Nic nebylo zapsáno.*ne o chybějící export POHODA.*execute=false/);
    expect(client.writes).toHaveLength(0);
  });
});

// Synthetic response (no client data) replayed through the production parser, so
// the shapes are exactly what PohodaResponse/recordsIn produce: empty elements
// become '', VAT fields become {'#text','@rate'}, rounding is nested.
describe('Liquidation states from parsed POHODA XML',()=>{
  const home=(none:string,low:string,lowVat:string,high:string,highVat:string)=>`<inv:homeCurrency><typ:priceNone>${none}</typ:priceNone><typ:priceLow>${low}</typ:priceLow><typ:priceLowVAT rate="12">${lowVat}</typ:priceLowVAT><typ:priceLowSum>0</typ:priceLowSum><typ:priceHigh>${high}</typ:priceHigh><typ:priceHighVAT rate="21">${highVat}</typ:priceHighVAT><typ:priceHighSum>0</typ:priceHighSum><typ:round><typ:priceRound>0</typ:priceRound></typ:round></inv:homeCurrency>`;
  const zeroHome=home('0','0','0','0','0');
  const doc=(id:number,type:string,liquidation:string,summary:string,links='',date='<inv:date>2026-06-01</inv:date>')=>`<lst:invoice><inv:invoiceHeader><inv:id>${id}</inv:id><inv:invoiceType>${type}</inv:invoiceType><inv:number><typ:numberRequested>T${id}</typ:numberRequested></inv:number><inv:symVar>${id}</inv:symVar>${date}${liquidation}</inv:invoiceHeader><inv:invoiceSummary>${summary}</inv:invoiceSummary>${links}</lst:invoice>`;
  const parse=(...invoices:string[])=>{
    const xml=`<rsp:responsePack version="2.0" id="t" state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd"><rsp:responsePackItem version="2.0" id="i" state="ok"><lst:listInvoice version="2.0" state="ok">${invoices.join('')}</lst:listInvoice></rsp:responsePackItem></rsp:responsePack>`;
    return recordsIn(new PohodaResponse(xml).items[0]!.data);
  };
  const state=(raw:Fields,withLinks:boolean)=>{const c=classifySettlementDocument(raw,undefined,withLinks);return c.kind==='known'?c.document.remaining:`${c.kind}:${(c.kind==='unknown'?c.unknown.issue:c.issue).field}`;};
  const link='<inv:liquidations><typ:liquidation><typ:id>1</typ:id><typ:date>2026-01-19</typ:date><typ:sourceAgenda>bank</typ:sourceAgenda><typ:sourceDocument><typ:id>2</typ:id></typ:sourceDocument><typ:amount>777</typ:amount></typ:liquidation></inv:liquidations>';
  it('handles empty, date-only and remaining-amount liquidation exactly as parsed',()=>{
    const [zero,paid,partial,unpaid,undated]=parse(
      doc(1,'issuedInvoice','<inv:liquidation/>',zeroHome),
      doc(2,'receivedInvoice','<inv:liquidation><typ:date>2026-01-19</typ:date></inv:liquidation>',home('0.01','0','0','642.14','134.85'),link),
      doc(3,'issuedInvoice','<inv:liquidation><typ:amountHome>480</typ:amountHome></inv:liquidation>',home('0','116500','13980','0','0')),
      doc(4,'receivedInvoice','<inv:liquidation><typ:amountHome>4006.25</typ:amountHome></inv:liquidation>',home('0','0','0','3310.95','695.3')),
      doc(5,'receivedInvoice','<inv:liquidation><typ:amountHome>349</typ:amountHome></inv:liquidation>',home('0','0','0','288.43','60.57'),'','')
    ) as Fields[];
    expect(zero!.invoiceHeader.liquidation).toBe(''); // the shape that made e863f63 throw "did not export"
    expect(state(zero!,false)).toBe('unknown:invoiceHeader.liquidation'); // needs the targeted links read
    expect(state(zero!,true)).toBe(0);
    expect(state({...zero!,liquidations:parse(doc(9,'issuedInvoice','',zeroHome,link))[0]!.liquidations},true)).toBe('unknown:invoiceHeader.liquidation');
    expect(state(paid!,false)).toBe(0);
    expect(state(partial!,true)).toBe(48000); // remaining, not 130480 total; absent links do not change it
    expect(state(unpaid!,true)).toBe(400625);
    const c=classifySettlementDocument(undated!,undefined,true); // header without date: bounded unknown, never matched
    expect(c).toMatchObject({kind:'unknown',unknown:{remaining:34900,issue:{field:'invoiceHeader.date'}}});
  });
  it('never treats a missing, empty or rounding-only summary as a zero total',()=>{
    const empty='<inv:liquidation/>';
    for(const summary of ['','<inv:homeCurrency/>','<inv:homeCurrency><typ:round><typ:priceRound>0</typ:priceRound></typ:round></inv:homeCurrency>','<inv:homeCurrency><typ:priceNone></typ:priceNone></inv:homeCurrency>',`${zeroHome}<inv:foreignCurrency><typ:currency><typ:ids>EUR</typ:ids></typ:currency></inv:foreignCurrency>`])
      expect(state(parse(doc(1,'issuedInvoice',empty,summary))[0]!,true),summary).toBe('unknown:invoiceHeader.liquidation');
    expect(state({invoiceHeader:parse(doc(1,'issuedInvoice',empty,zeroHome))[0]!.invoiceHeader},true)).toBe('unknown:invoiceHeader.liquidation'); // no invoiceSummary at all
  });
});
