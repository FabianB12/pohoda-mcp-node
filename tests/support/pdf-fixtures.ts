import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";

/** Page n of a fixture is (300 + n) points wide, so subsets can be checked for content and order. */
export const pageWidth = (page: number): number => 300 + page;

/** Writes a valid PDF whose pages are identifiable by width and text ("<label> page <n>"). */
export async function writePagedPdf(file: string, pageCount: number, label = "source", options: { rotatePage?: number } = {}): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= pageCount; page += 1) {
    const leaf = document.addPage([pageWidth(page), 500]);
    leaf.drawText(`${label} page ${page}`, { x: 20, y: 400, size: 14, font });
    if (options.rotatePage === page) leaf.setRotation(degrees(90));
  }
  const bytes = Buffer.from(await document.save());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return bytes;
}

/** Original page numbers of a fixture-derived PDF, in its page order. */
export async function fixturePages(file: string): Promise<number[]> {
  const document = await PDFDocument.load(await readFile(file));
  return document.getPages().map((page) => Math.round(page.getWidth()) - 300);
}

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
