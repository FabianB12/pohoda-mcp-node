import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PDF_ARCHIVE_ROOT,
  PdfArchive,
  PdfArchiveError,
  PdfDocumentArchiver,
  archiveSegments,
  buildPdfPageSubset,
  formatPageRanges,
  normalizeSourcePages,
  buildPdfAttachment,
  extractShortcutTargets,
  isWindows1250RoundTrip,
  planPdfArchiveTarget,
  sanitizeSegment,
  shortcutTargetsMatch,
  validateArchiveRoot,
  verifyPdfAttachmentLink
} from "../src/pohoda/pdf-archive.js";
import { XmlBuilder } from "../src/pohoda/xml-builder.js";
import { fixturePages, pageWidth, writePagedPdf } from "./support/pdf-fixtures.js";

const UNIT = { database: "StwPh_12345678_2026", ico: "12345678", year: 2026 };
const posixOnly = process.platform === "win32" ? it.skip : it;

let work: string;
let root: string;
let sources: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "pdf-archive-"));
  root = path.join(work, "archive root");
  sources = path.join(work, "sources");
  await mkdir(sources, { recursive: true });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function pdfBytes(label: string, size = 4096): Buffer {
  const head = Buffer.from(`%PDF-1.7\n% ${label}\n`, "latin1");
  const body = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 31 + label.length) & 0xff;
  return Buffer.concat([head, body]);
}

async function source(name: string, bytes: Buffer, dir = sources): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function expectArchiveError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "PdfArchiveError", code });
}

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

describe("PdfArchive.archive", () => {
  it("copies exact bytes into a content-addressed unit/year folder without touching the source", async () => {
    const bytes = pdfBytes("invoice", 3 * 1024 * 1024 + 17);
    const file = await source("Faktura č. 1.pdf", bytes);
    const result = await new PdfArchive({ rootDir: root }).archive(file, UNIT);

    expect(result).toEqual({
      path: path.join(root, "12345678", "StwPh_12345678_2026", "2026", `${sha(bytes)}.pdf`),
      sha256: sha(bytes),
      bytes: bytes.length,
      reused: false
    });
    expect((await readFile(result.path)).equals(bytes)).toBe(true);
    expect((await readFile(file)).equals(bytes)).toBe(true);
    expect(await listFiles(root)).toEqual([result.path]);
  });

  it("reuses identical content within a unit/year, including the same multi-invoice PDF", async () => {
    const bytes = pdfBytes("multi");
    const first = await source("scan.pdf", bytes);
    const copy = await source("renamed copy.pdf", bytes, path.join(sources, "other"));
    const archive = new PdfArchive({ rootDir: root });

    const a = await archive.archive(first, UNIT);
    const b = await archive.archive(first, UNIT);
    const c = await new PdfArchive({ rootDir: root }).archive(copy, UNIT);

    expect(a.reused).toBe(false);
    expect(b).toEqual({ ...a, reused: true });
    expect(c).toEqual({ ...a, reused: true });
    expect(await listFiles(root)).toEqual([a.path]);
  });

  it("keeps different content with the same file name apart", async () => {
    const one = await source("invoice.pdf", pdfBytes("one"), path.join(sources, "a"));
    const two = await source("invoice.pdf", pdfBytes("two"), path.join(sources, "b"));
    const archive = new PdfArchive({ rootDir: root });

    const a = await archive.archive(one, UNIT);
    const b = await archive.archive(two, UNIT);

    expect(a.path).not.toBe(b.path);
    expect(a.reused || b.reused).toBe(false);
    expect((await readFile(a.path)).equals(await readFile(one))).toBe(true);
    expect((await readFile(b.path)).equals(await readFile(two))).toBe(true);
  });

  it("separates accounting units and years", async () => {
    const file = await source("shared.pdf", pdfBytes("shared"));
    const archive = new PdfArchive({ rootDir: root });

    const a = await archive.archive(file, UNIT);
    const b = await archive.archive(file, { database: "StwPh_87654321_2026", ico: "87654321", year: 2026 });
    const c = await archive.archive(file, { ...UNIT, year: "2025" });

    expect(new Set([a.path, b.path, c.path]).size).toBe(3);
    expect([a.reused, b.reused, c.reused]).toEqual([false, false, false]);
  });

  it("handles concurrent archiving of the same content in one instance and across instances", async () => {
    const bytes = pdfBytes("concurrent", 512 * 1024);
    const files = await Promise.all(Array.from({ length: 6 }, (_, i) => source(`copy-${i}.pdf`, bytes)));
    const shared = new PdfArchive({ rootDir: root });

    const results = await Promise.all([
      ...files.map((file) => shared.archive(file, UNIT)),
      ...files.map((file) => new PdfArchive({ rootDir: root }).archive(file, UNIT))
    ]);

    expect(new Set(results.map((r) => r.path)).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    const stored = await listFiles(root);
    expect(stored).toEqual([results[0]!.path]);
    expect((await readFile(stored[0]!)).equals(bytes)).toBe(true);
  });

  it("never overwrites a different file already at the content-addressed path", async () => {
    const bytes = pdfBytes("conflict");
    const file = await source("conflict.pdf", bytes);
    const plan = planPdfArchiveTarget(root, sha(bytes), UNIT);
    await mkdir(plan.directory, { recursive: true });
    await writeFile(plan.path, "%PDF- tampered");

    await expectArchiveError(new PdfArchive({ rootDir: root }).archive(file, UNIT), "TARGET_CONFLICT");
    expect(await readFile(plan.path, "utf8")).toBe("%PDF- tampered");
    expect(await listFiles(plan.directory)).toEqual([plan.path]);
  });

  it("rejects missing, non-file, empty, non-PDF, relative and oversized sources without writing", async () => {
    const archive = new PdfArchive({ rootDir: root });
    await expectArchiveError(archive.archive(path.join(sources, "missing.pdf"), UNIT), "SOURCE_NOT_FOUND");
    await expectArchiveError(archive.archive(sources, UNIT), "SOURCE_NOT_FILE");
    await expectArchiveError(archive.archive(await source("empty.pdf", Buffer.alloc(0)), UNIT), "SOURCE_EMPTY");
    await expectArchiveError(archive.archive(await source("image.pdf", Buffer.from("\x89PNG\r\n\x1a\n....")), UNIT), "SOURCE_NOT_PDF");
    await expectArchiveError(archive.archive(await source("short.pdf", Buffer.from("%PD")), UNIT), "SOURCE_NOT_PDF");
    await expectArchiveError(archive.archive(await source("late-header.pdf", Buffer.from("  %PDF-1.4")), UNIT), "SOURCE_NOT_PDF");
    await expectArchiveError(archive.archive("relative/invoice.pdf", UNIT), "SOURCE_INVALID_PATH");
    await expectArchiveError(archive.archive(`${sources}/a\0.pdf`, UNIT), "SOURCE_INVALID_PATH");
    await expectArchiveError(archive.archive("", UNIT), "SOURCE_INVALID_PATH");

    const big = await source("big.pdf", pdfBytes("big", 2048));
    await expectArchiveError(new PdfArchive({ rootDir: root, maxBytes: 2047 }).archive(big, UNIT), "SOURCE_TOO_LARGE");
    await expect(new PdfArchive({ rootDir: root, maxBytes: 2048 }).archive(big, UNIT)).resolves.toMatchObject({ bytes: 2048 });

    expect((await listFiles(root)).every((file) => file.endsWith(`${sha(pdfBytes("big", 2048))}.pdf`))).toBe(true);
    expect(() => new PdfArchive({ rootDir: root, maxBytes: 0 })).toThrow(PdfArchiveError);
  });

  it("keeps unit-controlled identifiers inside the root and rejects traversal context", async () => {
    const file = await source("x.pdf", pdfBytes("traversal"));
    const archive = new PdfArchive({ rootDir: root });

    const result = await archive.archive(file, { database: "../../../etc/evil", ico: "12345678", year: 2026 });
    expect(path.relative(root, result.path).startsWith("..")).toBe(false);
    const relative = path.relative(root, result.path).split(path.sep);
    expect(relative).toHaveLength(4);
    expect(relative[1]).toMatch(/^etc_evil-[0-9a-f]{8}$/);

    await expectArchiveError(archive.archive(file, { ...UNIT, year: "../2026" }), "CONTEXT_INVALID");
    await expectArchiveError(archive.archive(file, { ...UNIT, ico: "123/../4" }), "CONTEXT_INVALID");
    await expectArchiveError(archive.archive(file, { ...UNIT, database: "  " }), "CONTEXT_INVALID");
    await expectArchiveError(archive.archive(file, { ...UNIT, year: 26 }), "CONTEXT_INVALID");
  });

  posixOnly("refuses a unit folder that is a symlink escaping the root", async () => {
    const outside = path.join(work, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(root, { recursive: true });
    await symlink(outside, path.join(root, "12345678"));
    const file = await source("x.pdf", pdfBytes("symlink"));

    await expectArchiveError(new PdfArchive({ rootDir: root }).archive(file, UNIT), "ARCHIVE_ESCAPE");
    expect(await listFiles(outside)).toEqual([]);
  });

  posixOnly("rejects the default Windows root on a POSIX host without creating relative folders", async () => {
    const file = await source("x.pdf", pdfBytes("host"));
    const archive = new PdfArchive({ env: {} });
    expect(archive.rootDir).toBe(DEFAULT_PDF_ARCHIVE_ROOT);

    await expectArchiveError(archive.archive(file, UNIT), "ARCHIVE_ROOT_WRONG_HOST");
    await expectArchiveError(new PdfArchive({ rootDir: "C:/PDF" }).archive(file, UNIT), "ARCHIVE_ROOT_WRONG_HOST");
    await expectArchiveError(new PdfArchive({ rootDir: "\\\\server\\share\\pdf" }).archive(file, UNIT), "ARCHIVE_ROOT_WRONG_HOST");
    await expectArchiveError(new PdfArchive({ rootDir: "relative/archive" }).archive(file, UNIT), "ARCHIVE_ROOT_INVALID");
    expect(existsSync(path.join(process.cwd(), "C:"))).toBe(false);
    expect(existsSync(path.join(process.cwd(), DEFAULT_PDF_ARCHIVE_ROOT))).toBe(false);
    await expect(archive.archive(file, UNIT)).rejects.toThrow(/POHODA_PDF_ARCHIVE_DIR/);
  });

  it("uses POHODA_PDF_ARCHIVE_DIR when no explicit root is given", async () => {
    const file = await source("env.pdf", pdfBytes("env"));
    const envRoot = path.join(work, "env-root");
    const result = await new PdfArchive({ env: { POHODA_PDF_ARCHIVE_DIR: ` ${envRoot} ` } }).archive(file, UNIT);
    expect(result.path.startsWith(`${envRoot}${path.sep}`)).toBe(true);
    expect(new PdfArchive({ rootDir: root, env: { POHODA_PDF_ARCHIVE_DIR: envRoot } }).rootDir).toBe(root);
  });
});

describe("archive path planning", () => {
  const hash = "a".repeat(64);

  it("plans the requested Windows root with ASCII unit folders that round-trip Windows-1250", () => {
    const plan = planPdfArchiveTarget(DEFAULT_PDF_ARCHIVE_ROOT, hash, UNIT, "win32");
    expect(plan.path).toBe(`C:\\Účetnictví\\PDF DOKLADY KLIENTŮ Z POHODY\\12345678\\StwPh_12345678_2026\\2026\\${hash}.pdf`);
    expect(plan.path.length).toBeLessThanOrEqual(255);
    expect(isWindows1250RoundTrip(plan.path)).toBe(true);
    expect(planPdfArchiveTarget(DEFAULT_PDF_ARCHIVE_ROOT, hash, { database: "db" }, "win32").path)
      .toBe(`C:\\Účetnictví\\PDF DOKLADY KLIENTŮ Z POHODY\\no-ico\\db\\no-year\\${hash}.pdf`);
  });

  it("normalizes valid Windows roots and rejects invalid ones", () => {
    expect(validateArchiveRoot("C:/Účetnictví/PDF/", "win32")).toBe("C:\\Účetnictví\\PDF");
    expect(validateArchiveRoot("\\\\server\\share\\pdf", "win32")).toBe("\\\\server\\share\\pdf");
    expect(validateArchiveRoot("C:\\Ucetnictvi\u0301", "win32")).toBe("C:\\Ucetnictví");
    for (const bad of ["Účetnictví\\PDF", "C:\\a\\..\\b", "C:\\CON\\pdf", "C:\\a|b", "C:\\dir.\\x", "C:\\客户", "C:\\😀", ""]) {
      expect(() => validateArchiveRoot(bad, "win32"), bad).toThrow(PdfArchiveError);
    }
  });

  it("produces ASCII, collision-resistant, Windows-safe database folders", () => {
    expect(sanitizeSegment("StwPh_12345678_2026")).toBe("StwPh_12345678_2026");
    expect(sanitizeSegment("Účetní jednotka 2026")).toMatch(/^Ucetni_jednotka_2026-[0-9a-f]{8}$/);
    expect(sanitizeSegment("客户数据库")).toMatch(/^unit-[0-9a-f]{8}$/);
    expect(sanitizeSegment("客户数据库")).not.toBe(sanitizeSegment("另一个客户"));
    expect(sanitizeSegment("a/b")).not.toBe(sanitizeSegment("a_b"));
    expect(sanitizeSegment("CON")).toMatch(/^_CON-[0-9a-f]{8}$/);
    expect(sanitizeSegment("lpt1.mdb")).toMatch(/^_lpt1\.mdb-/);
    expect(sanitizeSegment("..")).toMatch(/^unit-/);
    expect(sanitizeSegment("x".repeat(200)).length).toBeLessThanOrEqual(48);
    for (const segment of archiveSegments({ database: "😀 \"<>|?*:", ico: "1", year: "2026" })) {
      expect(segment).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  it("rejects targets beyond typ:string255", () => {
    const longRoot = `C:\\${"x".repeat(200)}`;
    expect(() => planPdfArchiveTarget(longRoot, hash, UNIT, "win32")).toThrow(/string255|255/);
    try {
      planPdfArchiveTarget(longRoot, hash, UNIT, "win32");
    } catch (error) {
      expect((error as PdfArchiveError).code).toBe("TARGET_TOO_LONG");
    }
    expect(() => planPdfArchiveTarget(DEFAULT_PDF_ARCHIVE_ROOT, "NOTHEX", UNIT, "win32")).toThrow(PdfArchiveError);
  });
});

describe("POHODA attachment shortcut helpers", () => {
  const target = `C:\\Účetnictví\\PDF DOKLADY KLIENTŮ Z POHODY\\12345678\\StwPh_12345678_2026\\2026\\${"b".repeat(64)}.pdf`;

  it("builds a typ:shortcut/typ:target child that serializes in Windows-1250 XML", () => {
    const attachment = buildPdfAttachment(target);
    expect(attachment).toEqual({ "typ:shortcut": { "typ:target": target } });
    const xml = new XmlBuilder("12345678").build("inv:invoice", "2.0", { "inv:attachments": attachment });
    expect(xml).toContain(`<inv:attachments><typ:shortcut><typ:target>${target}</typ:target></typ:shortcut></inv:attachments>`);
    const many = new XmlBuilder("12345678").build("vch:voucher", "2.0", { "vch:attachments": [attachment, buildPdfAttachment("C:\\x\\b.pdf")] });
    expect(many).toContain("<vch:attachments><typ:shortcut><typ:target>");
    expect(many.match(/<typ:shortcut>/g)).toHaveLength(2);
  });

  it("rejects targets that would be lost or ambiguous in POHODA XML", () => {
    for (const bad of ["", " C:\\a.pdf", "relative\\a.pdf", "C:\\客户\\a.pdf", "C:\\😀.pdf", "C:\\a\\..\\b.pdf", "C:\\a\nb.pdf", `C:\\${"x".repeat(260)}.pdf`]) {
      expect(() => buildPdfAttachment(bad), JSON.stringify(bad)).toThrow(PdfArchiveError);
    }
    expect(buildPdfAttachment("/srv/pdf/a.pdf")).toEqual({ "typ:shortcut": { "typ:target": "/srv/pdf/a.pdf" } });
  });

  it("extracts and compares exported shortcut targets", () => {
    const parsed = {
      invoice: [{
        invoiceHeader: { id: "1", text: "target not shortcut" },
        attachments: {
          files: { companyDocumentsFolder: "C:\\Docs", file: { name: "other.pdf" } },
          shortcut: [{ target: target.toLowerCase().replace(/\\/g, "/") }, { target: { "#text": "C:\\other.pdf" } }]
        }
      }]
    };
    expect(extractShortcutTargets(parsed)).toEqual([target.toLowerCase().replace(/\\/g, "/"), "C:\\other.pdf"]);
    expect(extractShortcutTargets({ "inv:attachments": { "typ:shortcut": { "typ:target": target } } })).toEqual([target]);
    expect(verifyPdfAttachmentLink(target, parsed).linked).toBe(true);
    expect(verifyPdfAttachmentLink(target, { attachments: { files: { file: { name: "x.pdf" } } } })).toEqual({ linked: false, targets: [] });
    expect(shortcutTargetsMatch("/srv/A.pdf", "/srv/a.pdf")).toBe(false);
    expect(shortcutTargetsMatch(target, target.replace(".pdf", "x.pdf"))).toBe(false);
  });
});

describe("per-document source PDFs", () => {
  const staging = () => path.join(work, "staging");

  it("normalizes pages to unique ascending source order and labels ranges", () => {
    expect(normalizeSourcePages([3, 1, 2, 3])).toEqual([1, 2, 3]);
    expect(formatPageRanges([1, 2, 3, 5, 7, 8])).toBe("1-3,5,7-8");
    for (const bad of [[], [0], [1.5], [-1], "1", undefined, [Number.NaN]]) {
      expect(() => normalizeSourcePages(bad), JSON.stringify(bad)).toThrow(PdfArchiveError);
    }
  });

  it("builds a deterministic subset with exactly the requested pages, order, sizes and rotation", async () => {
    const file = path.join(sources, "five.pdf");
    const bytes = await writePagedPdf(file, 5, "five", { rotatePage: 4 });
    const source = await PDFDocument.load(bytes);
    const a = await buildPdfPageSubset(source, [2, 4, 5], sha(bytes));
    const b = await buildPdfPageSubset(await PDFDocument.load(bytes), [2, 4, 5], sha(bytes));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const subset = await PDFDocument.load(a);
    expect(subset.getPages().map((page) => page.getWidth())).toEqual([pageWidth(2), pageWidth(4), pageWidth(5)]);
    expect(subset.getPages().map((page) => page.getRotation().angle)).toEqual([0, 90, 0]);
    expect(subset.getSubject()).toBe(`MCP-SOURCE sha256=${sha(bytes)} pages=2,4-5 of 5`);
    await expect(buildPdfPageSubset(source, [4, 2], sha(bytes))).rejects.toMatchObject({ code: "PAGES_INVALID" });
    await expect(buildPdfPageSubset(source, [5, 6], sha(bytes))).rejects.toMatchObject({ code: "PAGES_OUT_OF_RANGE" });
  });

  it("archives a multi-page document subset next to the byte-identical original", async () => {
    const file = path.join(sources, "batch.pdf");
    const bytes = await writePagedPdf(file, 6, "batch");
    await mkdir(staging(), { recursive: true });
    const archiver = new PdfDocumentArchiver(new PdfArchive({ rootDir: root }), { stagingDir: staging() });
    const doc = await archiver.archiveDocument(file, [5, 3, 4], UNIT);
    await archiver.close();

    expect(doc).toMatchObject({ pages: [3, 4, 5], pageRanges: "3-5", pageCount: 6, wholeSource: false, reused: false });
    expect(doc.original).toMatchObject({ sha256: sha(bytes), bytes: bytes.length });
    expect(path.dirname(doc.path)).toBe(path.dirname(doc.original.path));
    expect(doc.path).toBe(planPdfArchiveTarget(root, doc.sha256, UNIT).path);
    expect(await fixturePages(doc.path)).toEqual([3, 4, 5]);
    expect((await readFile(doc.original.path)).equals(bytes)).toBe(true);
    expect((await readFile(file)).equals(bytes)).toBe(true);
    expect((await listFiles(root)).sort()).toEqual([doc.original.path, doc.path].sort());
    expect(await listFiles(staging())).toEqual([]);
  });

  it("links the original for a whole-source document without writing a subset", async () => {
    const file = path.join(sources, "one.pdf");
    const bytes = await writePagedPdf(file, 3);
    const archiver = new PdfDocumentArchiver(new PdfArchive({ rootDir: root }));
    const doc = await archiver.archiveDocument(file, [3, 2, 1], UNIT);
    expect(doc).toMatchObject({ wholeSource: true, path: doc.original.path, sha256: sha(bytes), pages: [1, 2, 3] });
    expect(await listFiles(root)).toEqual([doc.original.path]);
  });

  it("reuses the same subset on retry, for a renamed copy and for repeated pages", async () => {
    const file = path.join(sources, "scan.pdf");
    await writePagedPdf(file, 4, "scan");
    const renamed = path.join(sources, "other", "renamed scan.pdf");
    await mkdir(path.dirname(renamed), { recursive: true });
    await writeFile(renamed, await readFile(file));
    const stored: string[] = [];
    const real = new PdfArchive({ rootDir: root });
    const recording = { archive: (source: string, context: typeof UNIT) => { stored.push(source); return real.archive(source, context); } };

    const first = new PdfDocumentArchiver(recording);
    const a = await first.archiveDocument(file, [2, 3], UNIT);
    const again = await first.archiveDocument(file, [3, 2, 2], UNIT);
    await first.close();
    expect(again.path).toBe(a.path);
    expect(stored).toHaveLength(2);

    const retry = new PdfDocumentArchiver(recording);
    const b = await retry.archiveDocument(renamed, [2, 3], UNIT);
    await retry.close();
    expect(b).toMatchObject({ path: a.path, sha256: a.sha256, reused: true, original: { path: a.original.path, reused: true } });
    expect((await listFiles(root)).sort()).toEqual([a.original.path, a.path].sort());
  });

  it("keeps accounting years apart for documents of one source PDF", async () => {
    const file = path.join(sources, "years.pdf");
    await writePagedPdf(file, 2);
    const archiver = new PdfDocumentArchiver(new PdfArchive({ rootDir: root }));
    const a = await archiver.archiveDocument(file, [1], UNIT);
    const b = await archiver.archiveDocument(file, [1], { ...UNIT, year: 2025 });
    expect(path.dirname(a.path)).not.toBe(path.dirname(b.path));
    expect(path.dirname(b.original.path)).toBe(path.dirname(b.path));
    expect(await listFiles(root)).toHaveLength(4);
  });

  it("validates pages before archiving anything", async () => {
    const file = path.join(sources, "three.pdf");
    await writePagedPdf(file, 3);
    const archive = { archive: vi.fn() };
    const archiver = new PdfDocumentArchiver(archive as any);
    await expect(archiver.validatePages(file, [2, 3, 4, 7])).rejects.toMatchObject({ code: "PAGES_OUT_OF_RANGE", message: expect.stringContaining("sourcePages 4,7") });
    await expect(archiver.archiveDocument(file, [0], UNIT)).rejects.toMatchObject({ code: "PAGES_INVALID" });
    await expect(archiver.validatePages(await source("fake.pdf", pdfBytes("fake")), [1])).rejects.toMatchObject({ code: "SOURCE_UNREADABLE" });
    await expect(archiver.validatePages(path.join(sources, "missing.pdf"), [1])).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
    expect(archive.archive).not.toHaveBeenCalled();
  });

  it("validates a whole batch before the first archive write and keeps request order", async () => {
    const a = path.join(sources, "b.pdf"), b = path.join(sources, "a.pdf");
    await writePagedPdf(a, 3, "b");
    await writePagedPdf(b, 2, "a");
    const archive = { archive: vi.fn((source: string, context: typeof UNIT) => new PdfArchive({ rootDir: root }).archive(source, context)) };
    const archiver = new PdfDocumentArchiver(archive);
    await expect(archiver.archiveDocuments([{ sourcePath: a, pages: [1], context: UNIT }, { sourcePath: b, pages: [3], context: UNIT }]))
      .rejects.toMatchObject({ code: "PAGES_OUT_OF_RANGE" });
    expect(archive.archive).not.toHaveBeenCalled();
    const results = await archiver.archiveDocuments([{ sourcePath: a, pages: [3], context: UNIT }, { sourcePath: b, pages: [2], context: UNIT }, { sourcePath: a, pages: [1, 2], context: UNIT }]);
    await archiver.close();
    expect(await Promise.all(results.map((r) => fixturePages(r.path)))).toEqual([[3], [2], [1, 2]]);
  });

  it("refuses a source that changed after its pages were checked", async () => {
    const file = path.join(sources, "changing.pdf");
    await writePagedPdf(file, 3, "before");
    const archiver = new PdfDocumentArchiver(new PdfArchive({ rootDir: root }));
    await archiver.validatePages(file, [1, 2]);
    await writePagedPdf(file, 3, "after");
    await expect(archiver.archiveDocument(file, [1, 2], UNIT)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("rejects an archive adapter that stores different bytes", async () => {
    const file = path.join(sources, "adapter.pdf");
    await writePagedPdf(file, 2);
    const archiver = new PdfDocumentArchiver({ archive: async () => ({ path: "/x/y.pdf", sha256: "0".repeat(64), bytes: 1, reused: false }) });
    await expect(archiver.archiveDocument(file, [1], UNIT)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("splits hundreds of documents from one PDF with a single source parse", async () => {
    const pages = 240;
    const file = path.join(sources, "large.pdf");
    const bytes = await writePagedPdf(file, pages, "large");
    const load = vi.spyOn(PDFDocument, "load");
    const archiver = new PdfDocumentArchiver(new PdfArchive({ rootDir: root }));
    const documents = [
      ...Array.from({ length: 200 }, (_, i) => [i + 1]),
      ...Array.from({ length: 20 }, (_, i) => [201 + 2 * i, 202 + 2 * i])
    ];
    const started = performance.now();
    const results = await archiver.archiveDocuments(documents.map((docPages) => ({ sourcePath: file, pages: docPages, context: UNIT })));
    await archiver.close();
    const elapsed = performance.now() - started;

    expect(load.mock.calls.filter(([input]) => (input as Uint8Array).length === bytes.length)).toHaveLength(1);
    expect(new Set(results.map((r) => r.original.path)).size).toBe(1);
    expect(new Set(results.map((r) => r.path)).size).toBe(documents.length);
    expect(await fixturePages(results[57]!.path)).toEqual([58]);
    expect(await fixturePages(results.at(-1)!.path)).toEqual([239, 240]);
    expect(await listFiles(root)).toHaveLength(documents.length + 1);
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);
});
