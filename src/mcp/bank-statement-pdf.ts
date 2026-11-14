import { PDFDocument, rgb } from 'pdf-lib';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';

export type StatementMark = { page: number; x: number; y: number };
/** x/y are fractions of the displayed crop box, measured from its top-left. */
export async function loadStatementPdf(path: string, marks: StatementMark[]) {
  if (!isAbsolute(path)) throw new Error('sourcePdfPath must be absolute.');
  const info = await stat(path);
  if (!info.isFile() || info.size > 250 * 1024 * 1024) throw new Error('Invalid or oversized statement PDF.');
  const bytes = await readFile(path);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const mark of marks) {
    if (!Number.isInteger(mark.page) || mark.page < 1 || mark.page > pdf.getPageCount()) throw new Error('Statement mark has an invalid page.');
    if (![mark.x, mark.y].every(Number.isFinite) || mark.x < 0 || mark.x > 0.97 || mark.y < 0.03 || mark.y > 0.97) throw new Error('Statement mark must fit in the page margin (normalized x/y).');
    const angle = ((pdf.getPage(mark.page - 1).getRotation().angle % 360) + 360) % 360;
    if (![0,90,180,270].includes(angle)) throw new Error('Unsupported PDF page rotation.');
  }
  return { bytes, pdf, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Only verified payment rows are passed here. The original is never overwritten. */
export async function markSettledPayments(input: Awaited<ReturnType<typeof loadStatementPdf>>, source: string, output: string, marks: StatementMark[]) {
  if (!marks.length) return { path: source, marked: 0, originalUnchanged: true };
  const comparable = (p: string) => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  if (comparable(source) === comparable(output) || !isAbsolute(output)) throw new Error('Annotated PDF requires a separate absolute output path.');
  const [realSource, realOutput] = await Promise.all([realpath(source), realpath(output).catch(() => undefined)]);
  if (realOutput && comparable(realSource) === comparable(realOutput)) throw new Error('Annotated PDF requires a separate absolute output path.');
  if (createHash('sha256').update(await readFile(source)).digest('hex') !== input.sha256) throw new Error('Source statement changed before PDF annotation.');
  // Use the original bytes for each output; retrying cannot accumulate duplicate marks.
  const pdf = await PDFDocument.load(input.bytes, { updateMetadata: false });
  for (const mark of marks) {
    const page = pdf.getPage(mark.page - 1), box = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const width = rotation % 180 ? box.height : box.width, height = rotation % 180 ? box.width : box.height;
    const project = (x: number, y: number) => {
      if (rotation === 90) return { x: box.x + y, y: box.y + x };
      if (rotation === 180) return { x: box.x + box.width - x, y: box.y + y };
      if (rotation === 270) return { x: box.x + box.width - y, y: box.y + box.height - x };
      return { x: box.x + x, y: box.y + box.height - y };
    };
    const x = mark.x * width, y = mark.y * height;
    const size = Math.min(10, width * 0.02);
    for (const [a,b] of [[[x,y],[x+size*.35,y+size*.35]], [[x+size*.35,y+size*.35],[x+size,y-size*.45]]] as const) {
      page.drawLine({ start: project(a[0],a[1]), end: project(b[0],b[1]), thickness: 1.8, color: rgb(0.05,0.5,0.24) });
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const tmp = `${output}.${randomBytes(5).toString('hex')}.tmp`;
  try { await writeFile(tmp, await pdf.save(), { flag: 'wx' }); await rename(tmp, output); }
  finally { await unlink(tmp).catch(()=>{}); }
  return { path: output, marked: marks.length, originalUnchanged: true };
}
