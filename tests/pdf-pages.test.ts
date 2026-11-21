import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExportStore } from "../src/mcp/export-store.js";
import { preparePdfPages } from "../src/mcp/pdf-pages.js";
import { registerPohodaTools } from "../src/mcp/tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("preparePdfPages", () => {
  it("renders every selected page to compact JPEG files and reuses cached output", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "invoice bundle.pdf");
    await writeFile(pdfPath, minimalPdf(["Invoice 1", "Receipt 2"]));

    const first = await preparePdfPages({
      pdfPath,
      outputDirectory: join(dir, "pages"),
      dpi: 120,
      jpegQuality: 75,
      concurrency: 8
    });

    expect(first.cached).toBe(false);
    expect(first.pageCount).toBe(2);
    expect(first.selectedPageCount).toBe(2);
    expect(first.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(first.pages.every((page) => page.width > 500 && page.height > 700)).toBe(true);
    expect(first.pages.every((page) => page.mimeType === "image/jpeg" && page.bytes > 1_000)).toBe(true);
    for (const page of first.pages) {
      const bytes = await readFile(page.path);
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    }

    const second = await preparePdfPages({
      pdfPath,
      outputDirectory: join(dir, "pages"),
      dpi: 120,
      jpegQuality: 75,
      concurrency: 1
    });
    expect(second.cached).toBe(true);
    expect(second.outputDirectory).toBe(first.outputDirectory);
    expect(second.pages).toEqual(first.pages);
  });

  it("supports bounded page ranges and lossless PNG output", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "bundle.pdf");
    await writeFile(pdfPath, minimalPdf(["One", "Two", "Three"]));

    const result = await preparePdfPages({
      pdfPath,
      outputDirectory: join(dir, "pages"),
      format: "png",
      dpi: 96,
      firstPage: 2,
      lastPage: 3,
      maxPages: 2
    });

    expect(result.pageCount).toBe(3);
    expect(result.pages.map((page) => page.page)).toEqual([2, 3]);
    const bytes = await readFile(result.pages[0]!.path);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("renders only the flagged scattered pages and keeps their cache separate from a full range", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "mixed.pdf");
    await writeFile(pdfPath, minimalPdf(["One", "Two", "Three"]));
    const options = { pdfPath, outputDirectory: join(dir, "pages"), dpi: 96, pages: [3, 1, 3], maxPages: 2 };
    const selected = await preparePdfPages(options);
    expect(selected.pages.map(page => page.page)).toEqual([1, 3]);
    expect(selected.selectedPageCount).toBe(2);
    expect((await preparePdfPages(options)).cached).toBe(true);
    const whole = await preparePdfPages({ ...options, pages: undefined, maxPages: 3 });
    expect(whole.outputDirectory).not.toBe(selected.outputDirectory);
    expect(whole.pages.map(page => page.page)).toEqual([1, 2, 3]);
    await expect(preparePdfPages({ ...options, pages: [4] })).rejects.toThrow(/existing positive PDF page/);
  });

  it("coalesces simultaneous requests for the same PDF and render settings", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "concurrent.pdf");
    await writeFile(pdfPath, minimalPdf(["One", "Two", "Three"]));
    const options = { pdfPath, outputDirectory: join(dir, "pages"), dpi: 120, concurrency: 2 } as const;

    const results = await Promise.all([preparePdfPages(options), preparePdfPages(options)]);

    expect(results.map((result) => result.cached).sort()).toEqual([false, true]);
    expect(results[0].pages).toEqual(results[1].pages);
  });

  it("rejects invalid paths, non-PDF files, invalid ranges, and oversized selections", async () => {
    const dir = await temporaryDirectory();
    const textPath = join(dir, "not-a-pdf.txt");
    const pdfPath = join(dir, "bundle.pdf");
    await writeFile(textPath, "hello");
    await writeFile(pdfPath, minimalPdf(["One", "Two"]));

    await expect(preparePdfPages({ pdfPath: join(dir, "missing.pdf") })).rejects.toThrow(/does not exist/);
    await expect(preparePdfPages({ pdfPath: textPath })).rejects.toThrow(/Expected a \.pdf/);
    await expect(preparePdfPages({ pdfPath, firstPage: 3 })).rejects.toThrow(/exceeds the PDF page count/);
    await expect(preparePdfPages({ pdfPath, firstPage: 2, lastPage: 1 })).rejects.toThrow(/lastPage must/);
    await expect(preparePdfPages({ pdfPath, maxPages: 1 })).rejects.toThrow(/exceeding maxPages=1/);
  });

  it("returns bounded inline MCP images plus paths for every rendered page", async () => {
    const dir = await temporaryDirectory();
    const pdfPath = join(dir, "bundle.pdf");
    await writeFile(pdfPath, minimalPdf(["One", "Two"]));
    const tools = new Map<string, (args: any) => Promise<any>>();
    const server = {
      registerTool(name: string, _config: unknown, handler: (args: any) => Promise<any>) {
        tools.set(name, handler);
      },
      registerResource() {}
    };
    registerPohodaTools(server as never, {
      client: {} as never,
      exportStore: new ExportStore(join(dir, "exports"))
    });

    const result = await tools.get("prepare_scanned_pdf")!({
      pdfPath,
      outputDirectory: join(dir, "pages"),
      format: "jpeg",
      dpi: 96,
      jpegQuality: 75,
      firstPage: 1,
      lastPage: 0,
      maxPages: 10,
      maxFileMb: 10,
      concurrency: 2,
      password: "",
      inlineImages: true,
      maxInlinePages: 1
    });

    expect(result.structuredContent.selectedPageCount).toBe(2);
    expect(result.structuredContent.inlineImageCount).toBe(1);
    expect(result.structuredContent.pages).toHaveLength(2);
    expect(result.content.map((item: any) => item.type)).toEqual(["text", "text", "image"]);
    expect(result.content[1].text).toContain("PDF page 1");
    expect(result.content[2].mimeType).toBe("image/jpeg");
    expect(Buffer.from(result.content[2].data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(result.content[0].text).toContain("remaining 1");
  });
});

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pohoda-pdf-pages-"));
  tempDirs.push(dir);
  return dir;
}

function minimalPdf(pageLabels: string[]): Buffer {
  const objects: string[] = [];
  const pageObjectIds = pageLabels.map((_, index) => 3 + index * 2);
  const fontObjectId = 3 + pageLabels.length * 2;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageLabels.length} >>`;
  pageLabels.forEach((label, index) => {
    const pageId = pageObjectIds[index]!;
    const contentId = pageId + 1;
    const escaped = label.replace(/[()\\]/g, "\\$&");
    const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontObjectId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let body = "%PDF-1.4\n";
  const offsets = new Array<number>(objects.length).fill(0);
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}
