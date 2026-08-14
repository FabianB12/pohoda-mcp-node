import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { DOMMatrix, ImageData, Path2D, createCanvas } from "@napi-rs/canvas";

export type PdfPageFormat = "jpeg" | "png";

export type PreparePdfPagesOptions = {
  pdfPath: string;
  outputDirectory?: string | undefined;
  format?: PdfPageFormat | undefined;
  dpi?: number | undefined;
  jpegQuality?: number | undefined;
  firstPage?: number | undefined;
  lastPage?: number | undefined;
  maxPages?: number | undefined;
  maxFileMb?: number | undefined;
  concurrency?: number | undefined;
  password?: string | undefined;
};

export type PreparedPdfPage = {
  page: number;
  path: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  bytes: number;
};

export type PreparedPdfPages = {
  pdfPath: string;
  outputDirectory: string;
  manifestPath: string;
  pageCount: number;
  selectedPageCount: number;
  firstPage: number;
  lastPage: number;
  format: PdfPageFormat;
  dpi: number;
  cached: boolean;
  durationMs: number;
  pages: PreparedPdfPage[];
};

type PdfManifest = Omit<PreparedPdfPages, "cached" | "durationMs"> & {
  cacheKey: string;
};

const DEFAULT_DPI = 180;
const DEFAULT_JPEG_QUALITY = 82;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_FILE_MB = 250;
const DEFAULT_CONCURRENCY = 4;
const MAX_PAGE_PIXELS = 24_000_000;
const inFlightRenders = new Map<string, Promise<PreparedPdfPages>>();

export async function preparePdfPages(options: PreparePdfPagesOptions): Promise<PreparedPdfPages> {
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

  installPdfJsCanvasGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(await readFile(pdfPath));
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    password: options.password || undefined,
    useSystemFonts: true
  });

  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    const firstPage = options.firstPage ?? 1;
    const lastPage = options.lastPage && options.lastPage > 0 ? options.lastPage : document.numPages;
    if (firstPage > document.numPages) {
      throw new Error(`firstPage ${firstPage} exceeds the PDF page count (${document.numPages}).`);
    }
    if (lastPage > document.numPages) {
      throw new Error(`lastPage ${lastPage} exceeds the PDF page count (${document.numPages}).`);
    }
    if (lastPage < firstPage) {
      throw new Error("lastPage must be greater than or equal to firstPage.");
    }

    const selectedPageCount = lastPage - firstPage + 1;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (selectedPageCount > maxPages) {
      throw new Error(
        `Selected ${selectedPageCount} pages, exceeding maxPages=${maxPages}. Use firstPage/lastPage ranges or explicitly raise maxPages.`
      );
    }

    const format = options.format ?? "jpeg";
    const dpi = options.dpi ?? DEFAULT_DPI;
    const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;
    const cacheKey = createHash("sha256").update(JSON.stringify({
      pdfPath,
      size: source.size,
      modified: source.mtimeMs,
      format,
      dpi,
      jpegQuality,
      firstPage,
      lastPage
    })).digest("hex").slice(0, 16);
    const safeName = sanitizeName(basename(pdfPath, extname(pdfPath)));
    const outputRoot = resolve(options.outputDirectory
      ?? process.env.POHODA_DOCUMENT_IMAGE_DIR
      ?? join(process.cwd(), "var", "document-pages"));
    const outputDirectory = join(outputRoot, `${safeName}-${cacheKey}`);
    const manifestPath = join(outputDirectory, "manifest.json");

    const cached = await readCachedManifest(manifestPath, cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
        durationMs: Math.round(performance.now() - startedAt)
      };
    }

    const activeRender = inFlightRenders.get(manifestPath);
    if (activeRender) {
      return {
        ...await activeRender,
        cached: true,
        durationMs: Math.round(performance.now() - startedAt)
      };
    }

    const render = (async (): Promise<PreparedPdfPages> => {
      await mkdir(outputDirectory, { recursive: true });
      const pageNumbers = Array.from({ length: selectedPageCount }, (_, index) => firstPage + index);
      const pages = await mapConcurrent(pageNumbers, options.concurrency ?? DEFAULT_CONCURRENCY, async (pageNumber) => {
        const page = await document!.getPage(pageNumber);
        try {
          const baseViewport = page.getViewport({ scale: 1 });
          const requestedScale = dpi / 72;
          const requestedPixels = baseViewport.width * baseViewport.height * requestedScale * requestedScale;
          const scale = requestedPixels > MAX_PAGE_PIXELS
            ? requestedScale * Math.sqrt(MAX_PAGE_PIXELS / requestedPixels)
            : requestedScale;
          const viewport = page.getViewport({ scale });
          const width = Math.max(1, Math.ceil(viewport.width));
          const height = Math.max(1, Math.ceil(viewport.height));
          const canvas = createCanvas(width, height);
          const context = canvas.getContext("2d");

          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, width, height);
          await page.render({
            canvas: canvas as never,
            canvasContext: context as never,
            viewport,
            background: "white"
          }).promise;

          const encoded = format === "jpeg"
            ? await canvas.encode("jpeg", jpegQuality)
            : await canvas.encode("png");
          const extension = format === "jpeg" ? "jpg" : "png";
          const pagePath = join(outputDirectory, `page-${String(pageNumber).padStart(4, "0")}.${extension}`);
          await writeFile(pagePath, encoded);
          return {
            page: pageNumber,
            path: pagePath,
            mimeType: format === "jpeg" ? "image/jpeg" as const : "image/png" as const,
            width,
            height,
            bytes: encoded.byteLength
          };
        } finally {
          page.cleanup();
        }
      });

      const manifest: PdfManifest = {
        cacheKey,
        pdfPath,
        outputDirectory,
        manifestPath,
        pageCount: document!.numPages,
        selectedPageCount,
        firstPage,
        lastPage,
        format,
        dpi,
        pages
      };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      return {
        ...manifest,
        cached: false,
        durationMs: Math.round(performance.now() - startedAt)
      };
    })();
    inFlightRenders.set(manifestPath, render);
    try {
      return await render;
    } finally {
      if (inFlightRenders.get(manifestPath) === render) {
        inFlightRenders.delete(manifestPath);
      }
    }
  } catch (error) {
    if (error instanceof pdfjs.PasswordException) {
      throw new Error(options.password
        ? "The PDF password is incorrect."
        : "The PDF is password protected; provide password to render it.");
    }
    throw error;
  } finally {
    await document?.cleanup();
    await loadingTask.destroy();
  }
}

async function readCachedManifest(manifestPath: string, cacheKey: string): Promise<PdfManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as PdfManifest;
    if (parsed.cacheKey !== cacheKey || !Array.isArray(parsed.pages)) {
      return undefined;
    }
    const files = await Promise.all(parsed.pages.map((page) => stat(page.path).catch(() => undefined)));
    if (files.some((file) => !file?.isFile())) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

function installPdfJsCanvasGlobals(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.DOMMatrix ??= DOMMatrix;
  globals.ImageData ??= ImageData;
  globals.Path2D ??= Path2D;
}

function sanitizeName(value: string): string {
  const safe = value.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 80) || "document";
}
