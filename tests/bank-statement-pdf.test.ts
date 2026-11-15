import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { checkMarkGeometry, loadStatementPdf, markSettledPayments } from '../src/mcp/bank-statement-pdf.js';
import { preparePdfPages } from '../src/mcp/pdf-pages.js';

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
  it('accepts marks without x, still validates a supplied x and bounds y to the displayed page',async()=>{
    const {path}=await source();
    await expect(loadStatementPdf(path,[{page:1,y:.5}])).resolves.toBeTruthy();
    for(const mark of [{page:1,y:.02},{page:1,y:.98},{page:1,x:1.2,y:.5},{page:1,x:Number.NaN,y:.5}])await expect(loadStatementPdf(path,[mark])).rejects.toThrow(/normalized y/);
  });
  it('sizes the check with the page, keeps it inside the right edge and centred on the row',()=>{
    for(const [w,h] of [[595,842],[842,595],[300,400],[2000,2800]] as const){
      const g=checkMarkGeometry(w,h,.5);
      expect(g.size).toBeGreaterThanOrEqual(11);expect(g.size).toBeLessThanOrEqual(16);
      expect(g.right).toBeLessThan(w);expect(g.right).toBeGreaterThan(w-0.02*w-1);expect(g.left).toBeGreaterThan(w*0.9);
      const ys=g.points.map(p=>p[1]);expect((Math.min(...ys)+Math.max(...ys))/2).toBeCloseTo(g.centerY,6);expect(g.centerY).toBe(h/2);
    }
    expect(checkMarkGeometry(595,842,.5).size).toBeGreaterThan(10); // previously 10 pt
    const top=checkMarkGeometry(300,100,.03),bottom=checkMarkGeometry(300,100,.97);
    expect(top.centerY-top.size/2).toBeGreaterThan(0);expect(bottom.centerY+bottom.size/2).toBeLessThan(100);
  });
  it.each([0,90,180,270])('draws the check at the far right of the marked row on a cropped page rotated %i°',async rotation=>{
    const dir=await mkdtemp(join(tmpdir(),'bank-pdf-render-'));dirs.push(dir);
    const pdf=await PDFDocument.create(),page=pdf.addPage([400,500]);page.setCropBox(20,30,360,440);page.setRotation(degrees(rotation));
    const path=join(dir,'src.pdf');await writeFile(path,await pdf.save());
    const marks=[{page:1,x:.03,y:.3}];const out=join(dir,'out.pdf');
    await markSettledPayments(await loadStatementPdf(path,marks),path,out,marks);
    const rendered=await preparePdfPages({pdfPath:out,outputDirectory:join(dir,'png'),format:'png',dpi:72});
    const img=await loadImage(await readFile(rendered.pages[0]!.path)),canvas=createCanvas(img.width,img.height),ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
    const displayW=rotation%180?440:360,displayH=rotation%180?360:440;expect([img.width,img.height]).toEqual([displayW,displayH]);
    const {data}=ctx.getImageData(0,0,img.width,img.height);const green:[number,number][]=[];
    for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){const i=(y*img.width+x)*4;if(data[i+1]!>90&&data[i]!<90&&data[i+1]!-data[i]!>40)green.push([x,y]);}
    expect(green.length).toBeGreaterThan(20);
    const xs=green.map(p=>p[0]),ys=green.map(p=>p[1]),g=checkMarkGeometry(displayW,displayH,.3);
    expect(Math.min(...xs)).toBeGreaterThan(displayW*0.9);expect(Math.max(...xs)).toBeLessThan(displayW);
    expect(Math.abs((Math.min(...ys)+Math.max(...ys))/2-g.centerY)).toBeLessThan(3);expect(Math.max(...ys)-Math.min(...ys)).toBeGreaterThan(g.size*0.7);
  });
  it('uses the visible area when the crop box extends beyond the media box',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'bank-pdf-media-'));dirs.push(dir);
    const pdf=await PDFDocument.create(),page=pdf.addPage([400,500]);page.setCropBox(0,0,600,500);
    const path=join(dir,'src.pdf');await writeFile(path,await pdf.save());const marks=[{page:1,y:.5}];const out=join(dir,'out.pdf');
    await markSettledPayments(await loadStatementPdf(path,marks),path,out,marks);
    const rendered=await preparePdfPages({pdfPath:out,outputDirectory:join(dir,'png'),format:'png',dpi:72});
    const img=await loadImage(await readFile(rendered.pages[0]!.path)),canvas=createCanvas(img.width,img.height),ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
    const {data}=ctx.getImageData(0,0,img.width,img.height);let right=0;
    for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){const i=(y*img.width+x)*4;if(data[i+1]!>90&&data[i]!<90&&data[i+1]!-data[i]!>40)right=Math.max(right,x);}
    expect(img.width).toBe(400);expect(right).toBeGreaterThan(360);expect(right).toBeLessThan(400);
  });
  it.runIf(process.env.BANK_PDF_SAMPLE_OUT)('writes the synthetic visual verification sample',async()=>{
    const {path}=await source([0,90,180,270]);const marks=[1,2,3,4].map(page=>({page,x:.03,y:.36}));
    await markSettledPayments(await loadStatementPdf(path,marks),path,process.env.BANK_PDF_SAMPLE_OUT!,marks);
  });
});
