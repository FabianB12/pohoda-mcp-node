import { LineCapStyle, PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';

/**
 * y is the vertical centre of the movement's row as a fraction of the displayed
 * page (visible crop box after /Rotate), measured from the top. x is accepted for
 * compatibility but ignored: the check is always drawn at the far right of the row.
 */
export type StatementMark = { page: number; x?: number | undefined; y: number };
type Box = { x: number; y: number; width: number; height: number };
/** Visible area as viewers render it: CropBox clipped to MediaBox (both inheritable). */
function visibleBox(page: PDFPage): Box {
  const crop = page.getCropBox(), media = page.getMediaBox();
  const x1 = Math.max(crop.x, media.x), y1 = Math.max(crop.y, media.y);
  const x2 = Math.min(crop.x + crop.width, media.x + media.width), y2 = Math.min(crop.y + crop.height, media.y + media.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : crop;
}
/** Check-mark geometry in displayed points: size grows with the page (A4 ≈ 14 pt), right edge inset from the visible edge. */
export function checkMarkGeometry(displayWidth: number, displayHeight: number, y: number) {
  const size = Math.min(16, Math.max(11, displayWidth * 0.024));
  const inset = Math.max(4, displayWidth * 0.012);
  const centerY = Math.min(Math.max(y * displayHeight, size / 2 + 1), displayHeight - size / 2 - 1);
  const left = displayWidth - inset - size;
  // Short stroke down-right, long stroke up-right; vertically centred on the row.
  const points = [[left, centerY + size * 0.075], [left + size * 0.35, centerY + size * 0.425], [left + size, centerY - size * 0.425]] as const;
  return { size, inset, centerY, left, right: left + size, thickness: Math.max(2, size * 0.17), points };
}
export async function loadStatementPdf(path: string, marks: StatementMark[]) {
  if (!isAbsolute(path)) throw new Error('sourcePdfPath must be absolute.');
  const info = await stat(path);
  if (!info.isFile() || info.size > 250 * 1024 * 1024) throw new Error('Invalid or oversized statement PDF.');
  const bytes = await readFile(path);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const mark of marks) {
    if (!Number.isInteger(mark.page) || mark.page < 1 || mark.page > pdf.getPageCount()) throw new Error('Statement mark has an invalid page.');
    if (!Number.isFinite(mark.y) || mark.y < 0.03 || mark.y > 0.97 || (mark.x !== undefined && (!Number.isFinite(mark.x) || mark.x < 0 || mark.x > 0.97))) throw new Error('Statement mark must give the row position as normalized y (0.03–0.97) from the top of the displayed page.');
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
    const page = pdf.getPage(mark.page - 1), box = visibleBox(page);
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const width = rotation % 180 ? box.height : box.width, height = rotation % 180 ? box.width : box.height;
    // Displayed (top-left origin, after /Rotate) -> unrotated user space.
    const project = (x: number, y: number) => {
      if (rotation === 90) return { x: box.x + y, y: box.y + x };
      if (rotation === 180) return { x: box.x + box.width - x, y: box.y + y };
      if (rotation === 270) return { x: box.x + box.width - y, y: box.y + box.height - x };
      return { x: box.x + x, y: box.y + box.height - y };
    };
    const g = checkMarkGeometry(width, height, mark.y);
    for (const [a, b] of [[g.points[0], g.points[1]], [g.points[1], g.points[2]]] as const) {
      page.drawLine({ start: project(a[0], a[1]), end: project(b[0], b[1]), thickness: g.thickness, color: rgb(0.05, 0.5, 0.24), lineCap: LineCapStyle.Round });
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const tmp = `${output}.${randomBytes(5).toString('hex')}.tmp`;
  try { await writeFile(tmp, await pdf.save(), { flag: 'wx' }); await rename(tmp, output); }
  finally { await unlink(tmp).catch(()=>{}); }
  return { path: output, marked: marks.length, originalUnchanged: true };
}
