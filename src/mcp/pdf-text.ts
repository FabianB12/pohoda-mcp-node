import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream, type PDFObject } from "pdf-lib";

/**
 * Read-only extraction of a PDF's existing text layer with pdfjs-dist.
 *
 * No OCR is performed and nothing is written next to, or instead of, the source PDF.
 * Pages without a usable text layer are reported with needsVisualInspection=true so
 * the caller renders only those pages (prepare_scanned_pdf) instead of every page.
 */

export type PdfTextQuality = "text" | "sparse" | "poor" | "none";

export type ExtractPdfTextOptions = {
  pdfPath: string;
  /** Explicit 1-based pages, returned in ascending page order. Overrides firstPage/lastPage. */
  pages?: number[] | undefined;
  firstPage?: number | undefined;
  /** Inclusive; 0 or undefined means the final page. */
  lastPage?: number | undefined;
  maxPages?: number | undefined;
  maxCharsPerPage?: number | undefined;
  maxTotalChars?: number | undefined;
  maxFileMb?: number | undefined;
  password?: string | undefined;
};

export type PdfTextLine = {
  /** Vertical centre of the line as a fraction of the displayed page height from the top (after /Rotate, visible crop box). */
  y: number;
  /** Left edge of the line as a fraction of the displayed page width. */
  x: number;
  text: string;
};

export type PdfRasterImages = {
  count: number;
  largestPixels: number;
  /** A large image with roughly page-shaped proportions: typical of scanned pages, including those with an OCR text layer. */
  pageLike: boolean;
};

export type PdfTextPage = {
  page: number;
  quality: PdfTextQuality;
  needsVisualInspection: boolean;
  reasons: string[];
  charCount: number;
  lineCount: number;
  width: number;
  height: number;
  rotation: number;
  /** null when the image check could not be performed. */
  rasterImages: PdfRasterImages | null;
  lines: PdfTextLine[];
  /** Lines were cut at maxCharsPerPage. */
  truncated: boolean;
  /** Text was not returned because maxTotalChars was reached; flags are still valid. */
  textOmitted: boolean;
};

export type PdfTextResult = {
  pdfPath: string;
  sha256: string;
  engine: "pdfjs";
  pageCount: number;
  selectedPages: number[];
  cached: boolean;
  durationMs: number;
  totalChars: number;
  /** First page whose text was omitted because of maxTotalChars; request again from this page. */
  continueFromPage: number | null;
  textPages: number[];
  visualInspectionPages: number[];
  warnings: string[];
  pages: PdfTextPage[];
};

type ExtractedPage = Omit<PdfTextPage, "truncated" | "textOmitted">;

type CachedDocument = {
  key: string;
  sha256: string;
  pageCount: number;
  pages: Map<number, ExtractedPage>;
  warnings: Set<string>;
};

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_CHARS_PER_PAGE = 20_000;
const DEFAULT_MAX_TOTAL_CHARS = 150_000;
const DEFAULT_MAX_FILE_MB = 250;
const CACHE_DOCUMENTS = 12;
/** A page with fewer visible characters than this may be a scan with a small digital stamp or footer. */
const SPARSE_TEXT_CHARS = 20;
const SUSPICIOUS_RATIO = 0.02;
const UNEXPECTED_SCRIPT_RATIO = 0.1;
const ALPHANUMERIC_RATIO = 0.4;

const documentCache = new Map<string, CachedDocument>();
const inFlight = new Map<string, Promise<unknown>>();

const pdfjsDirectory = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

export async function extractPdfText(options: ExtractPdfTextOptions): Promise<PdfTextResult> {
  const startedAt = performance.now();
  const pdfPath = resolve(options.pdfPath);
  const source = await stat(pdfPath).catch(() => undefined);
  if (!source?.isFile()) {
    throw new Error(`PDF file does not exist or is not a regular file: ${pdfPath}`);
  }
  if (extname(pdfPath).toLowerCase() !== ".pdf") {
    throw new Error(`Expected a .pdf file: ${pdfPath}`);
  }
  const maxFileMb = options.maxFileMb ?? DEFAULT_MAX_FILE_MB;
  if (source.size > maxFileMb * 1024 * 1024) {
    throw new Error(`PDF is ${(source.size / 1024 / 1024).toFixed(1)} MB; maxFileMb is ${maxFileMb}.`);
  }
  const maxPages = positiveInteger(options.maxPages ?? DEFAULT_MAX_PAGES, "maxPages");
  const maxCharsPerPage = positiveInteger(options.maxCharsPerPage ?? DEFAULT_MAX_CHARS_PER_PAGE, "maxCharsPerPage");
  const maxTotalChars = positiveInteger(options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS, "maxTotalChars");

  const canonicalPath = await realpath(pdfPath);
  const key = createHash("sha256").update(JSON.stringify({
    path: canonicalPath,
    size: source.size,
    modified: source.mtimeMs,
    password: options.password ? createHash("sha256").update(options.password).digest("hex") : ""
  })).digest("hex");

  // Serialize work per document so simultaneous calls reuse one extraction.
  const previous = inFlight.get(key);
  const run = (async () => {
    await previous?.catch(() => undefined);
    return extractWithCache(key, pdfPath, options, maxPages);
  })();
  inFlight.set(key, run);
  let extracted: Awaited<ReturnType<typeof extractWithCache>>;
  try {
    extracted = await run;
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }

  const { document, selectedPages, cached } = extracted;
  let totalChars = 0;
  let continueFromPage: number | null = null;
  const pages = selectedPages.map((pageNumber): PdfTextPage => {
    const page = document.pages.get(pageNumber)!;
    if (continueFromPage !== null) {
      return { ...page, lines: [], truncated: false, textOmitted: true };
    }
    let pageChars = 0;
    let truncated = false;
    const lines: PdfTextLine[] = [];
    // The first page must respect the response budget too. Later pages remain
    // whole-page resumable rather than consuming only the tail of that budget.
    const pageLimit = totalChars === 0 ? Math.min(maxCharsPerPage, maxTotalChars) : maxCharsPerPage;
    for (const line of page.lines) {
      const length = line.text.length + 1;
      if (pageChars + length > pageLimit) {
        if (lines.length === 0 && pageLimit > 1) {
          lines.push({ ...line, text: line.text.slice(0, pageLimit - 1) });
          pageChars = pageLimit;
        }
        truncated = true;
        break;
      }
      pageChars += length;
      lines.push(line);
    }
    if (totalChars + pageChars > maxTotalChars && totalChars > 0) {
      continueFromPage = pageNumber;
      return { ...page, lines: [], truncated: false, textOmitted: true };
    }
    totalChars += pageChars;
    return { ...page, lines, truncated, textOmitted: false };
  });

  return {
    pdfPath,
    sha256: document.sha256,
    engine: "pdfjs",
    pageCount: document.pageCount,
    selectedPages,
    cached,
    durationMs: Math.round(performance.now() - startedAt),
    totalChars,
    continueFromPage,
    textPages: pages.filter((page) => !page.needsVisualInspection).map((page) => page.page),
    visualInspectionPages: pages.filter((page) => page.needsVisualInspection).map((page) => page.page),
    warnings: [...document.warnings, ...pages.filter(page => page.truncated).map(page => `Page ${page.page} text is truncated; request that page with larger maxCharsPerPage and maxTotalChars before treating its contents as complete.`)],
    pages
  };
}

/** Compact page list such as "1-3, 7" for messages and page-range suggestions. */
export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index]!;
    let end = start;
    while (sorted[index + 1] === end + 1) {
      end += 1;
      index += 1;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(", ");
}

/** Plain-text rendering for MCP content: page headers, flags and lines with their y position. */
export function renderPdfText(result: PdfTextResult): string {
  const out: string[] = [];
  out.push(`Text layer of ${result.pdfPath}: ${result.selectedPages.length}/${result.pageCount} pages, ${result.totalChars} chars, ${result.durationMs} ms${result.cached ? " (cache hit)" : ""}. No OCR was performed; the source PDF was only read.`);
  if (result.visualInspectionPages.length) {
    out.push(`Visual inspection required for page(s) ${formatPageRanges(result.visualInspectionPages)}: their text layer is missing, sparse, unreliable or may be OCR over a scan. Render only those pages with prepare_scanned_pdf (firstPage/lastPage) and read them visually; never treat missing text as blank.`);
  } else {
    out.push("Every selected page has a usable text layer; rendering images is not needed to read them. Still check amounts and identifiers against the document structure.");
  }
  if (result.continueFromPage !== null) {
    out.push(`Text budget reached: text from page ${result.continueFromPage} onward was omitted. Call again with firstPage=${result.continueFromPage}.`);
  }
  for (const warning of result.warnings) out.push(`Warning: ${warning}`);
  out.push("Line format: y=<vertical centre, fraction of displayed page height from top> | text. Use y as process_bank_statement mark.y for a single-line movement row.");
  for (const page of result.pages) {
    const flags = [
      `quality=${page.quality}`,
      page.needsVisualInspection ? "NEEDS VISUAL INSPECTION" : "",
      `${page.charCount} chars`,
      `${page.lineCount} lines`,
      page.rotation ? `rotation=${page.rotation}` : "",
      page.truncated ? "TRUNCATED at maxCharsPerPage" : "",
      page.textOmitted ? "TEXT OMITTED (budget)" : ""
    ].filter(Boolean).join(", ");
    out.push("", `=== Page ${page.page}/${result.pageCount} (${flags}) ===`);
    for (const reason of page.reasons) out.push(`! ${reason}`);
    for (const line of page.lines) out.push(`y=${line.y.toFixed(4)} | ${line.text}`);
  }
  return out.join("\n");
}

async function extractWithCache(key: string, pdfPath: string, options: ExtractPdfTextOptions, maxPages: number) {
  let document = documentCache.get(key);
  let cached = true;
  if (document) {
    // Refresh LRU order.
    documentCache.delete(key);
    documentCache.set(key, document);
    const selectedPages = selectPages(options, document.pageCount, maxPages);
    if (selectedPages.every((page) => document!.pages.has(page))) {
      return { document, selectedPages, cached };
    }
  }
  cached = false;

  const bytes = await readFile(pdfPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (document && document.sha256 !== sha256) document = undefined;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password: options.password || undefined,
    useSystemFonts: false,
    disableFontFace: true,
    cMapUrl: join(pdfjsDirectory, "cmaps") + sep,
    cMapPacked: true,
    verbosity: 0
  });
  try {
    const pdf = await loadingTask.promise;
    try {
      document ??= { key, sha256, pageCount: pdf.numPages, pages: new Map(), warnings: new Set() };
      const selectedPages = selectPages(options, pdf.numPages, maxPages);
      const missing = selectedPages.filter((page) => !document!.pages.has(page));
      const extracted = new Map<number, Omit<ExtractedPage, "rasterImages" | "needsVisualInspection" | "reasons"> & { reasons: string[] }>();
      for (const pageNumber of missing) {
        const page = await pdf.getPage(pageNumber);
        try {
          extracted.set(pageNumber, await extractPage(page, pageNumber));
        } finally {
          page.cleanup();
        }
      }
      // Raster check only matters for pages whose text looks usable; others are flagged already.
      const needImageCheck = [...extracted.values()].filter((page) => page.quality === "text").map((page) => page.page);
      const images = needImageCheck.length ? await inspectRasterImages(bytes, needImageCheck) : new Map<number, PdfRasterImages>();
      if (needImageCheck.length && images.size === 0) {
        document.warnings.add("Raster-image check was unavailable; a page with a usable text layer could still be a scan with an OCR layer.");
      }
      for (const page of extracted.values()) {
        const rasterImages = images.get(page.page) ?? null;
        const reasons = [...page.reasons];
        if (rasterImages?.pageLike) {
          reasons.push("Page contains a page-sized raster image: it is likely a scan, and its text may be an OCR layer or cover only part of the content.");
        } else if (rasterImages && rasterImages.largestPixels >= 250_000) {
          reasons.push(`Page contains a raster image (${rasterImages.largestPixels} px); content inside images is not in the text layer.`);
        }
        document.pages.set(page.page, {
          ...page,
          rasterImages,
          reasons,
          needsVisualInspection: page.quality !== "text" || Boolean(rasterImages?.pageLike)
        });
      }
      documentCache.delete(key);
      documentCache.set(key, document);
      while (documentCache.size > CACHE_DOCUMENTS) {
        documentCache.delete(documentCache.keys().next().value!);
      }
      return { document, selectedPages, cached };
    } finally {
      await pdf.cleanup();
    }
  } catch (error) {
    if (error instanceof pdfjs.PasswordException) {
      throw new Error(options.password
        ? "The PDF password is incorrect."
        : "The PDF is password protected; provide password to extract its text.");
    }
    throw error;
  } finally {
    await loadingTask.destroy();
  }
}

function selectPages(options: ExtractPdfTextOptions, pageCount: number, maxPages: number): number[] {
  let pages: number[];
  if (options.pages?.length) {
    for (const page of options.pages) {
      if (!Number.isInteger(page) || page < 1) throw new Error(`Invalid page number: ${page}.`);
      if (page > pageCount) throw new Error(`Page ${page} exceeds the PDF page count (${pageCount}).`);
    }
    pages = [...new Set(options.pages)].sort((a, b) => a - b);
  } else {
    const firstPage = options.firstPage ?? 1;
    const lastPage = options.lastPage && options.lastPage > 0 ? options.lastPage : pageCount;
    if (!Number.isInteger(firstPage) || firstPage < 1) throw new Error(`Invalid firstPage: ${firstPage}.`);
    if (!Number.isInteger(lastPage)) throw new Error(`Invalid lastPage: ${lastPage}.`);
    if (firstPage > pageCount) throw new Error(`firstPage ${firstPage} exceeds the PDF page count (${pageCount}).`);
    if (lastPage > pageCount) throw new Error(`lastPage ${lastPage} exceeds the PDF page count (${pageCount}).`);
    if (lastPage < firstPage) throw new Error("lastPage must be greater than or equal to firstPage.");
    pages = Array.from({ length: lastPage - firstPage + 1 }, (_, index) => firstPage + index);
  }
  if (pages.length > maxPages) {
    throw new Error(`Selected ${pages.length} pages, exceeding maxPages=${maxPages}. Use firstPage/lastPage or pages, or explicitly raise maxPages.`);
  }
  return pages;
}

type PdfJsPage = {
  rotate: number;
  getViewport(parameters: { scale: number }): {
    width: number;
    height: number;
    convertToViewportPoint(x: number, y: number): number[];
  };
  getTextContent(parameters?: { includeMarkedContent?: boolean; disableNormalization?: boolean }): Promise<{ items: unknown[] }>;
};

type PdfJsTextItem = { str: string; transform: number[]; width: number; height: number; hasEOL: boolean };

type PlacedItem = { text: string; x0: number; x1: number; yc: number; size: number; vertical: boolean };

async function extractPage(page: PdfJsPage, pageNumber: number) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: false });
  const placed: PlacedItem[] = [];
  for (const raw of content.items) {
    const item = raw as Partial<PdfJsTextItem>;
    if (typeof item.str !== "string" || !Array.isArray(item.transform) || !item.str.trim()) continue;
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
    const directionNorm = Math.hypot(a, b) || 1;
    const ux = a / directionNorm;
    const uy = b / directionNorm;
    const size = Math.hypot(c, d) || item.height || directionNorm;
    const upX = Math.hypot(c, d) ? c : -uy * size;
    const upY = Math.hypot(c, d) ? d : ux * size;
    const width = Number.isFinite(item.width) ? item.width! : 0;
    const [sx = 0, sy = 0] = viewport.convertToViewportPoint(e, f);
    const [ex = 0, ey = 0] = viewport.convertToViewportPoint(e + ux * width, f + uy * width);
    const [, cy = 0] = viewport.convertToViewportPoint(e + upX * 0.35, f + upY * 0.35);
    const vertical = Math.abs(ey - sy) > Math.abs(ex - sx) && width > 0;
    placed.push({
      text: item.str,
      x0: Math.min(sx, ex),
      x1: Math.max(sx, ex),
      yc: vertical ? (sy + ey) / 2 : cy,
      size: Math.max(0.5, size),
      vertical
    });
  }

  const horizontal = placed.filter((item) => !item.vertical).sort((left, right) => left.yc - right.yc || left.x0 - right.x0);
  const groups: PlacedItem[][] = [];
  let current: PlacedItem[] = [];
  let currentY = 0;
  let currentSize = 0;
  for (const item of horizontal) {
    if (current.length && Math.abs(item.yc - currentY) <= 0.45 * Math.min(currentSize, item.size)) {
      current.push(item);
      currentY = current.reduce((sum, entry) => sum + entry.yc, 0) / current.length;
      currentSize = Math.min(currentSize, item.size);
    } else {
      if (current.length) groups.push(current);
      current = [item];
      currentY = item.yc;
      currentSize = item.size;
    }
  }
  if (current.length) groups.push(current);
  const vertical = placed.filter((item) => item.vertical).sort((left, right) => left.x0 - right.x0 || left.yc - right.yc);
  for (const item of vertical) groups.push([item]);

  const lines: PdfTextLine[] = [];
  for (const group of groups) {
    const ordered = [...group].sort((left, right) => left.x0 - right.x0);
    let text = "";
    let previous: PlacedItem | undefined;
    for (const item of ordered) {
      if (previous) {
        // Skip fake-bold duplicates drawn at almost the same position.
        if (item.text === previous.text && Math.abs(item.x0 - previous.x0) < item.size * 0.2) continue;
        const gap = item.x0 - previous.x1;
        const charWidth = Math.max((previous.x1 - previous.x0) / Math.max(1, previous.text.length), previous.size * 0.3);
        const separator = gap > charWidth * 2.5 ? "  " : gap > previous.size * 0.15 ? " " : "";
        if (separator && !text.endsWith(" ") && !item.text.startsWith(" ")) text += separator;
      }
      text += item.text;
      previous = item;
    }
    text = text.replace(/\s+$/u, "").replace(/^\s+/u, "");
    if (!text) continue;
    const yc = group.reduce((sum, item) => sum + item.yc, 0) / group.length;
    lines.push({
      y: round(clamp(yc / viewport.height)),
      x: round(clamp(ordered[0]!.x0 / viewport.width)),
      text
    });
  }

  const allText = lines.map((line) => line.text).join("");
  const assessment = assessText(allText);
  const reasons = [...assessment.reasons];
  if (vertical.length) reasons.push(`${vertical.length} text run(s) are rotated relative to the page; they are listed after the horizontal lines.`);
  return {
    page: pageNumber,
    quality: assessment.quality,
    reasons,
    charCount: assessment.visibleChars,
    lineCount: lines.length,
    width: round(viewport.width, 2),
    height: round(viewport.height, 2),
    rotation: ((page.rotate % 360) + 360) % 360,
    lines
  };
}

function assessText(text: string): { quality: PdfTextQuality; visibleChars: number; reasons: string[] } {
  const chars = [...text.replace(/\s+/gu, "")];
  const visibleChars = chars.length;
  if (!visibleChars) {
    return {
      quality: "none",
      visibleChars,
      reasons: ["No extractable text: the page may be a scanned image, text drawn as vector outlines, or blank. Text extraction cannot tell which."]
    };
  }
  let suspicious = 0;
  let unexpectedScript = 0;
  let alphanumeric = 0;
  for (const char of chars) {
    const code = char.codePointAt(0)!;
    if (code === 0xfffd || code < 0x20 || (code >= 0x7f && code < 0xa0) || (code >= 0xe000 && code <= 0xf8ff) || code >= 0xf0000) {
      suspicious += 1;
    } else if (!isExpectedScript(code)) {
      unexpectedScript += 1;
    }
    if (/[\p{L}\p{N}]/u.test(char)) alphanumeric += 1;
  }
  const reasons: string[] = [];
  if (suspicious / visibleChars > SUSPICIOUS_RATIO) {
    reasons.push(`${suspicious} of ${visibleChars} characters are replacement, control or private-use characters: a font lacks a reliable Unicode map.`);
  }
  if (unexpectedScript / visibleChars > UNEXPECTED_SCRIPT_RATIO) {
    reasons.push(`${unexpectedScript} of ${visibleChars} characters are outside Latin, Greek and Cyrillic scripts: the text layer is probably garbled.`);
  }
  if (alphanumeric / visibleChars < ALPHANUMERIC_RATIO) {
    reasons.push(`Only ${alphanumeric} of ${visibleChars} characters are letters or digits: the text layer may be garbled or decorative.`);
  }
  if (reasons.length) return { quality: "poor", visibleChars, reasons };
  if (visibleChars < SPARSE_TEXT_CHARS) {
    return {
      quality: "sparse",
      visibleChars,
      reasons: [`Only ${visibleChars} visible characters: the page may be a scan with a small digital stamp, header or page number.`]
    };
  }
  return { quality: "text", visibleChars, reasons: [] };
}

function isExpectedScript(code: number): boolean {
  return code < 0x0250 // Basic Latin, Latin-1, Latin Extended-A/B
    || (code >= 0x0370 && code < 0x0530) // Greek, Cyrillic
    || (code >= 0x1e00 && code < 0x1f00) // Latin Extended Additional
    || (code >= 0x2000 && code < 0x2200) // punctuation, super/subscripts, currency, letterlike, number forms, arrows
    || (code >= 0x2200 && code < 0x2400) // mathematical operators, technical
    || (code >= 0x2500 && code < 0x2600) // box drawing, blocks, geometric shapes
    || (code >= 0x2600 && code < 0x27c0) // symbols, dingbats (checkmarks)
    || (code >= 0xfb00 && code < 0xfb07); // Latin ligatures
}

/**
 * Inspects image XObjects referenced by page resources (and nested forms) without
 * decoding image data. Placement is not computed; a large image with page-like
 * proportions is treated as a probable scan. Inline images are not detected.
 */
async function inspectRasterImages(bytes: Uint8Array, pageNumbers: number[]): Promise<Map<number, PdfRasterImages>> {
  const result = new Map<number, PdfRasterImages>();
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return result;
  }
  const pages = document.getPages();
  for (const pageNumber of pageNumbers) {
    const page = pages[pageNumber - 1];
    if (!page) continue;
    try {
      const images: Array<{ width: number; height: number }> = [];
      collectImages(document, page.node.Resources(), images, new Set(), 0);
      const { width, height } = page.getSize();
      const pageArea = Math.max(1, width * height);
      const pageAspect = width / Math.max(1, height);
      let largestPixels = 0;
      let pageLike = false;
      for (const image of images) {
        const pixels = image.width * image.height;
        largestPixels = Math.max(largestPixels, pixels);
        const aspect = image.width / Math.max(1, image.height);
        const similar = (target: number) => aspect / target > 0.75 && aspect / target < 1.34;
        // At least ~72 dpi over a page-shaped area.
        if (pixels >= pageArea * 0.9 && (similar(pageAspect) || similar(1 / pageAspect))) pageLike = true;
      }
      result.set(pageNumber, { count: images.length, largestPixels, pageLike });
    } catch {
      // Leave this page without image information.
    }
  }
  return result;
}

function collectImages(
  document: PDFDocument,
  resources: PDFDict | undefined,
  images: Array<{ width: number; height: number }>,
  seen: Set<PDFObject>,
  depth: number
): void {
  if (!resources || depth > 6) return;
  const xObjects = lookup(document, resources.get(PDFName.of("XObject")));
  if (!(xObjects instanceof PDFDict)) return;
  for (const [, value] of xObjects.entries()) {
    const ref = value instanceof PDFRef ? value : undefined;
    const object = lookup(document, value);
    if (!(object instanceof PDFStream) || seen.has(ref ?? object)) continue;
    seen.add(ref ?? object);
    const subtype = object.dict.get(PDFName.of("Subtype"));
    if (subtype === PDFName.of("Image")) {
      const width = lookup(document, object.dict.get(PDFName.of("Width")));
      const height = lookup(document, object.dict.get(PDFName.of("Height")));
      if (width instanceof PDFNumber && height instanceof PDFNumber) {
        images.push({ width: width.asNumber(), height: height.asNumber() });
      }
    } else if (subtype === PDFName.of("Form")) {
      const nested = lookup(document, object.dict.get(PDFName.of("Resources")));
      if (nested instanceof PDFDict) collectImages(document, nested, images, seen, depth + 1);
    }
  }
}

function lookup(document: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? document.context.lookup(value) : value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
