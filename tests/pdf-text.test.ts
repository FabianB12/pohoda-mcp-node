import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, PDFDocument as SkiaPdfDocument } from "@napi-rs/canvas";
import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { ExportStore } from "../src/mcp/export-store.js";
import { extractPdfText, formatPageRanges, renderPdfText } from "../src/mcp/pdf-text.js";
import { registerPohodaTools } from "../src/mcp/tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const A4 = { width: 595, height: 842 };
const FONT = "11px Arial, Helvetica, sans-serif";
/** Statement rows: [canvas baseline y, date, Czech description, amount]. */
const ROWS: Array<[number, string, string, string]> = [
  [300, "03.03.2025", "Příchozí platba – Žluťoučký kůň s.r.o., VS 2025001", "12 345,67"],
  [330, "05.03.2025", "Odchozí úhrada faktury č. FP-2025-017 (ďábelské ódy)", "-1 234,50"],
  [360, "31.03.2025", "Poplatek za vedení účtu", "-99,00"]
];

describe("extractPdfText", () => {
  it("reads Czech text from a digital statement in page and row order with display positions", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "výpis březen.pdf");
    await writeFile(pdfPath, digitalStatement());

    const result = await extractPdfText({ pdfPath });

    expect(result.engine).toBe("pdfjs");
    expect(result.pageCount).toBe(2);
    expect(result.selectedPages).toEqual([1, 2]);
    expect(result.visualInspectionPages).toEqual([]);
    expect(result.textPages).toEqual([1, 2]);
    const [first, second] = result.pages;
    expect(first!.quality).toBe("text");
    expect(first!.needsVisualInspection).toBe(false);
    expect(first!.width).toBe(A4.width);
    expect(first!.height).toBe(A4.height);
    const texts = first!.lines.map((line) => line.text);
    expect(texts[0]).toBe("Výpis z účtu č. 3/2025");
    expect(texts).toContain("Číslo účtu: 123456789/0800  Měna: CZK");
    // Each statement row is one line with columns in left-to-right order.
    for (const [baseline, date, description, amount] of ROWS) {
      const line = first!.lines.find((entry) => entry.text.startsWith(date));
      expect(line?.text).toBe(`${date}  ${description}  ${amount}`);
      // Canvas baseline minus ~0.35 em is the visual row centre, as used for process_bank_statement marks.
      expect(Math.abs(line!.y - (baseline - 0.35 * 11) / A4.height)).toBeLessThan(0.0015);
    }
    const ys = first!.lines.map((line) => line.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(second!.lines.map((line) => line.text)).toEqual(["Konečný zůstatek: 11 012,17 CZK", "Strana 2 / 2"]);
    expect(result.sha256).toBe(createHash("sha256").update(await readFile(pdfPath)).digest("hex"));
  });

  it("maps simple-font Differences encodings to Czech Unicode", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "legacy.pdf");
    await writeFile(pdfPath, handcraftedPdf([{ text: "P\x80\x81\x82 \x83\x84\x85\x86 \x87\x88\x89 \x8A\x8B\x8C\x8D platba ze dne 3. 3. 2025, VS 77", encoding: CZECH_DIFFERENCES }]));

    const result = await extractPdfText({ pdfPath });

    expect(result.pages[0]!.lines.map((line) => line.text)).toEqual(["Pěšč řžýá íéů ĚŠČŘ platba ze dne 3. 3. 2025, VS 77"]);
    expect(result.pages[0]!.quality).toBe("text");
  });

  it("flags scanned, sparse, OCR-over-scan and garbled pages for visual inspection without OCR", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "mixed.pdf");
    await writeFile(pdfPath, mixedDocument());

    const result = await extractPdfText({ pdfPath });

    const byPage = new Map(result.pages.map((page) => [page.page, page]));
    expect(byPage.get(1)).toMatchObject({ quality: "text", needsVisualInspection: false });
    expect(byPage.get(2)).toMatchObject({ quality: "none", needsVisualInspection: true, charCount: 0, lines: [] });
    expect(byPage.get(2)!.reasons.join(" ")).toMatch(/cannot tell/);
    expect(byPage.get(3)).toMatchObject({ quality: "sparse", needsVisualInspection: true });
    expect(byPage.get(3)!.lines.map((line) => line.text)).toEqual(["Strana 3"]);
    expect(byPage.get(4)).toMatchObject({ quality: "text", needsVisualInspection: true });
    expect(byPage.get(4)!.rasterImages).toMatchObject({ pageLike: true });
    expect(byPage.get(4)!.reasons.join(" ")).toMatch(/OCR layer/);
    // A small logo does not force rendering a digital page.
    expect(byPage.get(5)).toMatchObject({ quality: "text", needsVisualInspection: false });
    expect(byPage.get(5)!.rasterImages).toMatchObject({ count: 1, pageLike: false });
    expect(result.visualInspectionPages).toEqual([2, 3, 4]);
    expect(result.textPages).toEqual([1, 5]);

    const rendered = renderPdfText(result);
    expect(rendered).toContain("Visual inspection required for page(s) 2-4");
    expect(rendered).toContain("No OCR was performed");
    expect(rendered).toMatch(/=== Page 2\/5 \(quality=none, NEEDS VISUAL INSPECTION/);

    const garbledPath = join(dir, "garbled.pdf");
    await writeFile(garbledPath, handcraftedPdf([{ text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghij", toUnicodePrivateUse: true }]));
    const garbled = await extractPdfText({ pdfPath: garbledPath });
    expect(garbled.pages[0]).toMatchObject({ quality: "poor", needsVisualInspection: true });
    expect(garbled.pages[0]!.reasons.join(" ")).toMatch(/private-use/);
  });

  it("selects explicit pages in page order and validates ranges", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "mixed.pdf");
    await writeFile(pdfPath, mixedDocument());

    const selected = await extractPdfText({ pdfPath, pages: [5, 2, 4, 5] });
    expect(selected.selectedPages).toEqual([2, 4, 5]);
    expect(selected.pages.map((page) => page.page)).toEqual([2, 4, 5]);
    expect(selected.visualInspectionPages).toEqual([2, 4]);

    const range = await extractPdfText({ pdfPath, firstPage: 3, lastPage: 4 });
    expect(range.selectedPages).toEqual([3, 4]);

    await expect(extractPdfText({ pdfPath, pages: [6] })).rejects.toThrow(/Page 6 exceeds the PDF page count \(5\)/);
    await expect(extractPdfText({ pdfPath, pages: [0] })).rejects.toThrow(/Invalid page number/);
    await expect(extractPdfText({ pdfPath, firstPage: 6 })).rejects.toThrow(/firstPage 6 exceeds/);
    await expect(extractPdfText({ pdfPath, lastPage: 9 })).rejects.toThrow(/lastPage 9 exceeds/);
    await expect(extractPdfText({ pdfPath, firstPage: 4, lastPage: 3 })).rejects.toThrow(/lastPage must/);
    await expect(extractPdfText({ pdfPath, maxPages: 4 })).rejects.toThrow(/Selected 5 pages, exceeding maxPages=4/);
  });

  it("bounds text per page and per response while keeping flags and a continuation page", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "long.pdf");
    const pages = Array.from({ length: 4 }, (_, index) => Array.from({ length: 30 }, (_, row) => `Strana ${index + 1} řádek ${row + 1}: úhrada faktury číslo ${1000 + row}`));
    await writeFile(pdfPath, linesPdf(pages));

    const perPage = await extractPdfText({ pdfPath, maxCharsPerPage: 200 });
    expect(perPage.pages.every((page) => page.truncated && page.lines.length > 0)).toBe(true);
    expect(perPage.pages.every((page) => page.lines.reduce((sum, line) => sum + line.text.length + 1, 0) <= 200)).toBe(true);
    expect(perPage.pages[0]!.lineCount).toBe(30);

    const smallResponse = await extractPdfText({ pdfPath, maxTotalChars: 100 });
    expect(smallResponse.totalChars).toBeLessThanOrEqual(100);
    expect(smallResponse.pages[0]!.truncated).toBe(true);
    expect(smallResponse.warnings.join(" ")).toContain("larger maxCharsPerPage and maxTotalChars");

    const budget = await extractPdfText({ pdfPath, maxTotalChars: 3_000 });
    expect(budget.continueFromPage).toBe(3);
    expect(budget.pages.map((page) => page.textOmitted)).toEqual([false, false, true, true]);
    expect(budget.pages[2]!.lines).toEqual([]);
    expect(budget.pages[2]!.charCount).toBeGreaterThan(0);
    expect(budget.totalChars).toBeLessThanOrEqual(3_000);
    expect(renderPdfText(budget)).toContain("Call again with firstPage=3");

    const resumed = await extractPdfText({ pdfPath, firstPage: 3, maxTotalChars: 3_000 });
    expect(resumed.continueFromPage).toBeNull();
    expect(resumed.pages[0]!.lines[0]!.text).toBe("Strana 3 řádek 1: úhrada faktury číslo 1000");
  });

  it("caches per page, coalesces concurrent calls and invalidates on file change without writing files", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "statement.pdf");
    const original = digitalStatement();
    await writeFile(pdfPath, original);
    const before = await stat(pdfPath);

    const concurrent = await Promise.all([extractPdfText({ pdfPath, pages: [1] }), extractPdfText({ pdfPath, pages: [1] })]);
    expect(concurrent.map((result) => result.cached).sort()).toEqual([false, true]);
    expect(concurrent[1].pages).toEqual(concurrent[0].pages);

    const widened = await extractPdfText({ pdfPath });
    expect(widened.cached).toBe(false);
    const repeated = await extractPdfText({ pdfPath, pages: [2] });
    expect(repeated.cached).toBe(true);
    expect(repeated.pages[0]).toEqual(widened.pages[1]);

    // Source preserved: same bytes, same mtime, and nothing written beside it.
    expect(Buffer.compare(await readFile(pdfPath), original)).toBe(0);
    expect((await stat(pdfPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(dir)).toEqual(["statement.pdf"]);

    await writeFile(pdfPath, linesPdf([["Nový obsah po změně souboru, VS 4242"]]));
    await utimes(pdfPath, new Date(), new Date(Date.now() + 5_000));
    const changed = await extractPdfText({ pdfPath });
    expect(changed.cached).toBe(false);
    expect(changed.pageCount).toBe(1);
    expect(changed.pages[0]!.lines.map((line) => line.text)).toEqual(["Nový obsah po změně souboru, VS 4242"]);
  });

  it("reports y in displayed coordinates for rotated pages, consistent with statement marks", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "rotated.pdf");
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([400, 600]);
    page.setRotation(degrees(90));
    // Drawn 90° counter-clockwise so the row reads horizontally after the page's clockwise /Rotate.
    page.drawText("Movement 1 1000.00", { x: 200, y: 50, size: 14, font, rotate: degrees(90) });
    await writeFile(pdfPath, await document.save());

    const result = await extractPdfText({ pdfPath });
    const extracted = result.pages[0]!;
    expect(extracted.rotation).toBe(90);
    expect(extracted.width).toBe(600);
    expect(extracted.height).toBe(400);
    expect(extracted.lines.map((line) => line.text)).toEqual(["Movement 1 1000.00"]);
    // bank-statement-pdf maps displayed y on a 90° page to user-space x = y * displayHeight.
    expect(extracted.lines[0]!.y * extracted.height).toBeCloseTo(200 - 0.35 * 14, 0);
  });

  it("rejects missing, non-PDF, oversized and malformed inputs", async () => {
    const dir = await temporaryDirectory();
    const textPath = join(dir, "notes.txt");
    const brokenPath = join(dir, "broken.pdf");
    const pdfPath = join(dir, "ok.pdf");
    await writeFile(textPath, "hello");
    await writeFile(brokenPath, "this is not a pdf");
    await writeFile(pdfPath, linesPdf([["x".repeat(10)]]));

    await expect(extractPdfText({ pdfPath: join(dir, "missing.pdf") })).rejects.toThrow(/does not exist/);
    await expect(extractPdfText({ pdfPath: textPath })).rejects.toThrow(/Expected a \.pdf/);
    await expect(extractPdfText({ pdfPath: brokenPath })).rejects.toThrow();
    await writeFile(join(dir, "big.pdf"), Buffer.alloc(1024 * 1024 + 1));
    await expect(extractPdfText({ pdfPath: join(dir, "big.pdf"), maxFileMb: 1 })).rejects.toThrow(/maxFileMb is 1/);
    await expect(extractPdfText({ pdfPath, maxCharsPerPage: 0 })).rejects.toThrow(/maxCharsPerPage must be a positive integer/);
  });

  it("formats page ranges compactly", () => {
    expect(formatPageRanges([7, 1, 2, 3, 9, 8, 12])).toBe("1-3, 7-9, 12");
    expect(formatPageRanges([])).toBe("");
  });

  it("is exposed as a read-only MCP tool with text content and structured results", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "mixed.pdf");
    await writeFile(pdfPath, mixedDocument());
    const tools = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
    const server = {
      registerTool(name: string, config: unknown, handler: (args: any) => Promise<any>) {
        tools.set(name, { config, handler });
      },
      registerResource() {}
    };
    registerPohodaTools(server as never, { client: {} as never, exportStore: new ExportStore(join(dir, "exports")) });

    const tool = tools.get("extract_pdf_text")!;
    expect(tool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const result = await tool.handler({
      pdfPath, pages: [1, 2], firstPage: 1, lastPage: 0, maxPages: 100,
      maxCharsPerPage: 20_000, maxTotalChars: 150_000, maxFileMb: 250, password: ""
    });
    expect(result.structuredContent.selectedPages).toEqual([1, 2]);
    expect(result.structuredContent.visualInspectionPages).toEqual([2]);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("Visual inspection required for page(s) 2");
    expect(result.content[0].text).toMatch(/y=0\.\d{4} \| Výpis z účtu č\. 3\/2025/);
    expect(await readdir(dir)).toEqual(["mixed.pdf"]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pohoda-pdf-text-"));
  tempDirs.push(dir);
  return dir;
}

function drawStatementPage(ctx: any): void {
  ctx.fillStyle = "#000";
  ctx.font = "bold 16px Arial, Helvetica, sans-serif";
  ctx.fillText("Výpis z účtu č. 3/2025", 50, 80);
  ctx.font = FONT;
  ctx.fillText("Číslo účtu: 123456789/0800", 50, 110);
  ctx.fillText("Měna: CZK", 400, 110);
  ctx.fillText("Datum", 50, 270);
  ctx.fillText("Popis", 140, 270);
  ctx.fillText("Částka", 480, 270);
  for (const [baseline, date, description, amount] of ROWS) {
    ctx.fillText(date, 50, baseline);
    ctx.fillText(description, 140, baseline);
    ctx.fillText(amount, 480, baseline);
  }
}

/** Skia/PDF output with embedded subset fonts and ToUnicode maps, like browser print-to-PDF statements. */
function digitalStatement(): Buffer {
  const document = new SkiaPdfDocument({ title: "MCPTEST statement" });
  drawStatementPage(document.beginPage(A4.width, A4.height));
  document.endPage();
  const second = document.beginPage(A4.width, A4.height) as any;
  second.font = FONT;
  second.fillText("Konečný zůstatek: 11 012,17 CZK", 50, 100);
  second.fillText("Strana 2 / 2", 260, 800);
  document.endPage();
  return document.close();
}

/** A raster "scan" of text: 150 dpi A4 with page-like proportions. */
function scanImage() {
  const canvas = createCanvas(1240, 1754);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f2ec";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#222";
  ctx.font = "32px Arial, Helvetica, sans-serif";
  for (let row = 0; row < 20; row += 1) ctx.fillText(`Faktura FV-2025-${row} částka ${row * 100},00 Kč`, 120, 200 + row * 60);
  return canvas;
}

function mixedDocument(): Buffer {
  const document = new SkiaPdfDocument({ title: "MCPTEST mixed" });
  drawStatementPage(document.beginPage(A4.width, A4.height));
  document.endPage();

  const scan = scanImage();
  const pure = document.beginPage(A4.width, A4.height) as any;
  pure.drawImage(scan, 0, 0, A4.width, A4.height);
  document.endPage();

  const stamped = document.beginPage(A4.width, A4.height) as any;
  stamped.drawImage(scan, 0, 0, A4.width, A4.height);
  stamped.font = FONT;
  stamped.fillText("Strana 3", 270, 820);
  document.endPage();

  const ocr = document.beginPage(A4.width, A4.height) as any;
  ocr.drawImage(scan, 0, 0, A4.width, A4.height);
  ocr.font = FONT;
  for (let row = 0; row < 12; row += 1) ocr.fillText(`Faktura FV-2025-${row} částka ${row * 100},00 Kč`, 60, 100 + row * 28);
  document.endPage();

  const logo = createCanvas(200, 60);
  const logoContext = logo.getContext("2d");
  logoContext.fillStyle = "#0a5";
  logoContext.fillRect(0, 0, 200, 60);
  const digital = document.beginPage(A4.width, A4.height) as any;
  digital.drawImage(logo, 40, 30, 100, 30);
  digital.font = FONT;
  digital.fillText("Faktura FV-2025-099, dodavatel Žluťoučký kůň s.r.o., celkem 1 210,00 Kč", 50, 120);
  document.endPage();
  return document.close();
}

function linesPdf(pages: string[][]): Buffer {
  const document = new SkiaPdfDocument({ title: "MCPTEST lines" });
  for (const lines of pages) {
    const ctx = document.beginPage(A4.width, A4.height) as any;
    ctx.font = FONT;
    lines.forEach((line, index) => ctx.fillText(line, 40, 60 + index * 24));
    document.endPage();
  }
  return document.close();
}

const CZECH_DIFFERENCES = "/Differences [128 /ecaron /scaron /ccaron /rcaron /zcaron /yacute /aacute /iacute /eacute /uring /Ecaron /Scaron /Ccaron /Rcaron]";

/** Minimal one-page PDF using non-embedded Helvetica with a custom encoding or ToUnicode map. */
function handcraftedPdf(runs: Array<{ text: string; encoding?: string; toUnicodePrivateUse?: boolean }>): Buffer {
  const run = runs[0]!;
  const escaped = run.text.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 14 Tf 50 700 Td (${escaped}) Tj ET`;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
  objects[4] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  const encoding = run.encoding ? ` /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding ${run.encoding} >>` : "";
  const toUnicode = run.toUnicodePrivateUse ? " /ToUnicode 6 0 R" : "";
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica${encoding}${toUnicode} >>`;
  if (run.toUnicodePrivateUse) {
    const cmap = [
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
      "/CMapName /MCPTEST-PUA def 1 begincodespacerange <00> <FF> endcodespacerange",
      "2 beginbfrange <41> <5A> <E041> <61> <7A> <E061> endbfrange",
      "endcmap CMapName currentdict /CMap defineresource pop end end"
    ].join("\n");
    objects[6] = `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`;
  }
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body, "latin1");
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
