import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { loadStatementPdf, markSettledPayments } from '../src/mcp/bank-statement-pdf.js';

const dirs: string[] = [];
async function source(rotations = [0]) {
  const dir=await mkdtemp(join(tmpdir(),'bank-pdf-'));dirs.push(dir);
  const pdf=await PDFDocument.create();
  rotations.forEach(rotation=>{const page=pdf.addPage([400,500]);page.setCropBox(20,30,360,440);page.setRotation(degrees(rotation));page.drawText(`MCPTEST bank statement ${rotation}`,{x:60,y:400,size:10});page.drawText('Matched payment 123.45',{x:60,y:300,size:10});page.drawText('Unmatched payment 555.00',{x:60,y:220,size:10});});
  const path=join(dir,'source.pdf');await writeFile(path,await pdf.save());return{dir,path};
}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});

describe('bank statement PDF marks',()=>{
  it('keeps the original exact bytes and adds only requested marks to a separate valid PDF',async()=>{
    const {dir,path}=await source();const before=await readFile(path);
    const mark={page:1,x:.03,y:.36};const loaded=await loadStatementPdf(path,[mark]);
    const result=await markSettledPayments(loaded,path,join(dir,'checked.pdf'),[mark]);
    expect(result).toMatchObject({marked:1,originalUnchanged:true});
    expect(await readFile(path)).toEqual(before);
    const output=await PDFDocument.load(await readFile(result.path));
    expect(output.getPageCount()).toBe(1);expect(output.getPage(0).getCropBox()).toEqual(loaded.pdf.getPage(0).getCropBox());
    expect(await readFile(result.path)).not.toEqual(before);
  });
  it('does not create or edit any PDF when no settlement is verified',async()=>{
    const {dir,path}=await source();const before=await readFile(path);const loaded=await loadStatementPdf(path,[]);
    expect(await markSettledPayments(loaded,path,join(dir,'unused.pdf'),[])).toEqual({path,marked:0,originalUnchanged:true});
    expect(await readFile(path)).toEqual(before);await expect(readFile(join(dir,'unused.pdf'))).rejects.toThrow();
  });
  it('rejects invalid page coordinates, malformed PDFs and overwriting the source before writing',async()=>{
    const {path}=await source();const valid={page:1,x:.03,y:.36};
    for(const mark of [{...valid,page:2},{...valid,page:0},{...valid,x:-1},{...valid,y:NaN}])await expect(loadStatementPdf(path,[mark])).rejects.toThrow();
    const loaded=await loadStatementPdf(path,[valid]);await expect(markSettledPayments(loaded,path,path,[valid])).rejects.toThrow(/separate/);
    await expect(loadStatementPdf('relative.pdf',[])).rejects.toThrow(/absolute/);
  });
  it('rejects changed source bytes rather than marking a stale statement',async()=>{
    const {dir,path}=await source();const mark={page:1,x:.03,y:.36};const loaded=await loadStatementPdf(path,[mark]);
    await writeFile(path,'changed');
    await expect(markSettledPayments(loaded,path,join(dir,'checked.pdf'),[mark])).rejects.toThrow(/changed/);
  });
  it('preserves crop and rotation for all four display orientations',async()=>{
    const {dir,path}=await source([0,90,180,270]);const marks=[1,2,3,4].map(page=>({page,x:.03,y:.36}));
    const loaded=await loadStatementPdf(path,marks);const result=await markSettledPayments(loaded,path,join(dir,'rotated.pdf'),marks);
    const output=await PDFDocument.load(await readFile(result.path));
    expect(output.getPages().map(p=>p.getRotation().angle)).toEqual([0,90,180,270]);
    output.getPages().forEach(p=>expect(p.getCropBox()).toEqual({x:20,y:30,width:360,height:440}));
  });
  it.runIf(process.env.BANK_PDF_SAMPLE_OUT)('writes the synthetic visual verification sample',async()=>{
    const {path}=await source([0,90,180,270]);const marks=[1,2,3,4].map(page=>({page,x:.03,y:.36}));
    await markSettledPayments(await loadStatementPdf(path,marks),path,process.env.BANK_PDF_SAMPLE_OUT!,marks);
  });
});
