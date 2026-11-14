import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import iconv from "iconv-lite";
import type { XmlObject } from "./xml-builder.js";

/**
 * Source PDF archive for imported POHODA documents.
 *
 * POHODA XML import can link a file to a document only through the root
 * `attachments` block (typ:attachmentsType) using `typ:shortcut/typ:target`
 * (typ:string255). `typ:files/companyDocumentsFolder` and `typ:files/file` are
 * export-only, so the PDF must already exist at a path POHODA can open when the
 * document is imported. This module copies the source PDF into a
 * content-addressed archive and returns that path for the shortcut target.
 */

export const DEFAULT_PDF_ARCHIVE_ROOT = "C:\\Účetnictví\\PDF DOKLADY KLIENTŮ Z POHODY";
export const PDF_ARCHIVE_ROOT_ENV = "POHODA_PDF_ARCHIVE_DIR";
export const DEFAULT_PDF_ARCHIVE_MAX_BYTES = 250 * 1024 * 1024;
/** typ:shortcut/typ:target is typ:string255. */
export const SHORTCUT_TARGET_MAX_LENGTH = 255;

const PDF_HEADER = Buffer.from("%PDF-", "ascii");
const CHUNK_BYTES = 1024 * 1024;
const MAX_SEGMENT_LENGTH = 48;
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type PdfArchiveErrorCode =
  | "ARCHIVE_ROOT_WRONG_HOST"
  | "ARCHIVE_ROOT_INVALID"
  | "ARCHIVE_ESCAPE"
  | "CONTEXT_INVALID"
  | "SOURCE_INVALID_PATH"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_NOT_FILE"
  | "SOURCE_EMPTY"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_NOT_PDF"
  | "SOURCE_CHANGED"
  | "TARGET_INVALID"
  | "TARGET_TOO_LONG"
  | "TARGET_CONFLICT"
  | "COPY_FAILED";

export class PdfArchiveError extends Error {
  public constructor(public readonly code: PdfArchiveErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfArchiveError";
  }
}

export type PdfArchiveOptions = {
  /** Archive root. Defaults to POHODA_PDF_ARCHIVE_DIR, then DEFAULT_PDF_ARCHIVE_ROOT. */
  rootDir?: string;
  /** Maximum source size in bytes. Defaults to 250 MiB. */
  maxBytes?: number;
  /** Environment used to read POHODA_PDF_ARCHIVE_DIR. Defaults to process.env. */
  env?: Record<string, string | undefined>;
};

export type PdfArchiveContext = {
  /** Explicit POHODA databaseId / database of the target accounting unit. */
  database: string;
  /** ICO of the accounting unit (digits only). */
  ico?: string;
  /** Accounting year of the unit (four digits). */
  year?: string | number;
};

export type PdfArchiveResult = {
  /** Absolute archived path; use it as typ:shortcut/typ:target. */
  path: string;
  /** Lowercase hex SHA-256 of the exact source bytes. */
  sha256: string;
  bytes: number;
  /** True when an identical archived file already existed (no new copy). */
  reused: boolean;
};

export type PdfArchivePlan = {
  root: string;
  directory: string;
  path: string;
  segments: string[];
};

type Platform = NodeJS.Platform;

export class PdfArchive {
  public readonly rootDir: string;
  public readonly maxBytes: number;
  private readonly locks = new Map<string, Promise<unknown>>();

  public constructor(options: PdfArchiveOptions = {}) {
    const env = options.env ?? process.env;
    const fromEnv = env[PDF_ARCHIVE_ROOT_ENV]?.trim();
    this.rootDir = (options.rootDir ?? (fromEnv || DEFAULT_PDF_ARCHIVE_ROOT)).normalize("NFC");
    const maxBytes = options.maxBytes ?? DEFAULT_PDF_ARCHIVE_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new PdfArchiveError("ARCHIVE_ROOT_INVALID", "PDF archive maxBytes must be a positive integer.");
    }
    this.maxBytes = maxBytes;
  }

  /**
   * Copies a source PDF into <root>/<ico>/<database>/<year>/<sha256>.pdf.
   * Identical content within the same unit/year reuses the existing file.
   * Throws PdfArchiveError on any failure; callers must not write documents then.
   */
  public async archive(sourcePath: string, context: PdfArchiveContext): Promise<PdfArchiveResult> {
    const platform = process.platform;
    const root = validateArchiveRoot(this.rootDir, platform);
    validateSourcePath(sourcePath);
    const segments = archiveSegments(context);

    const source = await openSource(sourcePath);
    try {
      const stats = await source.stat();
      if (!stats.isFile()) {
        throw new PdfArchiveError("SOURCE_NOT_FILE", `Source PDF ${sourcePath} is not a regular file.`);
      }
      if (stats.size === 0) {
        throw new PdfArchiveError("SOURCE_EMPTY", `Source PDF ${sourcePath} is empty.`);
      }
      if (stats.size > this.maxBytes) {
        throw new PdfArchiveError("SOURCE_TOO_LARGE", `Source PDF ${sourcePath} has ${stats.size} bytes; the archive limit is ${this.maxBytes} bytes.`);
      }
      const first = await digestHandle(source, this.maxBytes, true, sourcePath);
      if (first.bytes !== stats.size) {
        throw new PdfArchiveError("SOURCE_CHANGED", `Source PDF ${sourcePath} changed while it was being read.`);
      }
      const plan = planPdfArchiveTarget(root, first.sha256, context, platform, segments);
      const key = platform === "win32" ? plan.path.toUpperCase() : plan.path;
      return await this.withLock(key, () => this.store(source, sourcePath, root, plan, first));
    } finally {
      await source.close();
    }
  }

  private async store(
    source: FileHandle,
    sourcePath: string,
    root: string,
    plan: PdfArchivePlan,
    expected: { sha256: string; bytes: number }
  ): Promise<PdfArchiveResult> {
    await ensureContainedDirectory(root, plan.directory);
    const result = (reused: boolean): PdfArchiveResult => ({ path: plan.path, sha256: expected.sha256, bytes: expected.bytes, reused });

    if (await verifyExisting(plan.path, expected)) {
      return result(true);
    }

    const tempPath = path.join(plan.directory, `.${expected.sha256.slice(0, 16)}.${process.pid}.${randomBytes(6).toString("hex")}.partial`);
    try {
      const temp = await open(tempPath, "wx");
      let copied: { sha256: string; bytes: number };
      try {
        copied = await copyHandle(source, temp, this.maxBytes);
        await temp.sync();
      } finally {
        await temp.close();
      }
      if (copied.sha256 !== expected.sha256 || copied.bytes !== expected.bytes) {
        throw new PdfArchiveError("SOURCE_CHANGED", `Source PDF ${sourcePath} changed while it was being archived.`);
      }
      const onDisk = await digestPath(tempPath);
      if (onDisk.sha256 !== expected.sha256 || onDisk.bytes !== expected.bytes) {
        throw new PdfArchiveError("COPY_FAILED", `Archived copy of ${sourcePath} does not match the source bytes.`);
      }

      try {
        // link() creates the final name atomically and never replaces an existing file.
        await link(tempPath, plan.path);
        return result(false);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          return await reuseOrConflict(plan.path, expected);
        }
        if (!["EPERM", "ENOTSUP", "EXDEV", "ENOSYS", "EINVAL", "EOPNOTSUPP", "EACCES"].includes(errorCode(error))) {
          throw wrapCopyError(error, plan.path);
        }
      }
      // Fallback for filesystems without hard links: exclusive (non-overwriting) copy.
      try {
        await copyFile(tempPath, plan.path, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          return await reuseOrConflict(plan.path, expected);
        }
        throw wrapCopyError(error, plan.path);
      }
      const final = await digestPath(plan.path);
      if (final.sha256 !== expected.sha256 || final.bytes !== expected.bytes) {
        await unlink(plan.path).catch(() => undefined);
        throw new PdfArchiveError("COPY_FAILED", `Archived file ${plan.path} does not match the source bytes.`);
      }
      return result(false);
    } catch (error) {
      if (error instanceof PdfArchiveError) throw error;
      throw wrapCopyError(error, plan.path);
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    }
  }
}

/** Builds one root-level attachments child: { "typ:shortcut": { "typ:target": path } }. */
export function buildPdfAttachment(targetPath: string): XmlObject {
  return { "typ:shortcut": { "typ:target": validateShortcutTarget(targetPath) } };
}

/** Validates a typ:shortcut/typ:target value; returns it unchanged. */
export function validateShortcutTarget(targetPath: string): string {
  if (typeof targetPath !== "string" || targetPath.trim() === "" || targetPath.trim() !== targetPath) {
    throw new PdfArchiveError("TARGET_INVALID", "Attachment target must be a non-empty path without surrounding whitespace.");
  }
  if (CONTROL_CHARS.test(targetPath)) {
    throw new PdfArchiveError("TARGET_INVALID", "Attachment target contains control characters.");
  }
  if (targetPath.length > SHORTCUT_TARGET_MAX_LENGTH) {
    throw new PdfArchiveError("TARGET_TOO_LONG", `Attachment target has ${targetPath.length} characters; typ:string255 allows ${SHORTCUT_TARGET_MAX_LENGTH}.`);
  }
  if (!isWindows1250RoundTrip(targetPath)) {
    throw new PdfArchiveError("TARGET_INVALID", "Attachment target contains characters that cannot be written in Windows-1250 POHODA XML.");
  }
  const windows = looksLikeWindowsPath(targetPath);
  if (!windows && !path.posix.isAbsolute(targetPath)) {
    throw new PdfArchiveError("TARGET_INVALID", `Attachment target ${targetPath} must be an absolute path.`);
  }
  if (targetPath.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new PdfArchiveError("TARGET_INVALID", "Attachment target must not contain '..' segments.");
  }
  return targetPath;
}

/** Collects every shortcut target from exported attachments (prefixed or unprefixed keys). */
export function extractShortcutTargets(value: unknown): string[] {
  const targets: string[] = [];
  const visit = (node: unknown, inShortcut: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, inShortcut));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const local = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
      if (inShortcut && local === "target") {
        for (const item of Array.isArray(child) ? child : [child]) {
          const text = textOf(item);
          if (text !== undefined) targets.push(text);
        }
      } else {
        visit(child, local === "shortcut");
      }
    }
  };
  visit(value, false);
  return targets;
}

/** Compares link targets; Windows paths compare case-insensitively with either separator. */
export function shortcutTargetsMatch(expected: string, actual: string): boolean {
  const a = expected.trim();
  const b = actual.trim();
  if (a === b) return true;
  if (!looksLikeWindowsPath(a) || !looksLikeWindowsPath(b)) return false;
  const normalize = (value: string) => value.replace(/\//g, "\\").normalize("NFC").toUpperCase();
  return normalize(a) === normalize(b);
}

/** Reports whether an exported document links the expected archived PDF. */
export function verifyPdfAttachmentLink(expectedPath: string, exported: unknown): { linked: boolean; targets: string[] } {
  const targets = extractShortcutTargets(exported);
  return { linked: targets.some((target) => shortcutTargetsMatch(expectedPath, target)), targets };
}

/** Pure planner for the archive destination (no filesystem access). */
export function planPdfArchiveTarget(
  rootDir: string,
  sha256: string,
  context: PdfArchiveContext,
  platform: Platform = process.platform,
  precomputedSegments?: string[]
): PdfArchivePlan {
  const root = validateArchiveRoot(rootDir, platform);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new PdfArchiveError("TARGET_INVALID", "Archive file name requires a lowercase hex SHA-256.");
  }
  const segments = precomputedSegments ?? archiveSegments(context);
  const p = platform === "win32" ? path.win32 : path.posix;
  const directory = p.join(root, ...segments);
  const target = p.join(directory, `${sha256}.pdf`);
  if (target.length > SHORTCUT_TARGET_MAX_LENGTH) {
    throw new PdfArchiveError("TARGET_TOO_LONG", `Archived path would have ${target.length} characters; typ:shortcut/typ:target allows ${SHORTCUT_TARGET_MAX_LENGTH}. Use a shorter ${PDF_ARCHIVE_ROOT_ENV}.`);
  }
  validateShortcutTarget(target);
  return { root, directory, path: target, segments };
}

/** Validates an archive root for the given host and returns its normalized form. */
export function validateArchiveRoot(rootDir: string, platform: Platform = process.platform): string {
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    throw new PdfArchiveError("ARCHIVE_ROOT_INVALID", "PDF archive root must be a non-empty absolute path.");
  }
  const raw = rootDir.trim().normalize("NFC");
  if (CONTROL_CHARS.test(raw)) {
    throw new PdfArchiveError("ARCHIVE_ROOT_INVALID", "PDF archive root contains control characters.");
  }
  if (!isWindows1250RoundTrip(raw)) {
    throw new PdfArchiveError("ARCHIVE_ROOT_INVALID", `PDF archive root ${raw} contains characters that cannot be written in Windows-1250 POHODA XML.`);
  }
  if (raw.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new PdfArchiveError("ARCHIVE_ROOT_INVALID", "PDF archive root must not contain '..' segments.");
  }
  if (platform === "win32") {
    const candidate = raw.replace(/\//g, "\\");
    const drive = /^[A-Za-z]:\\/.test(candidate);
    const unc = /^\\\\[^\\?.]+\\[^\\]+/.test(candidate);
    if (!drive && !unc) {
      throw new PdfArchiveError("ARCHIVE_ROOT_INVALID", `PDF archive root ${raw} must be an absolute Windows path such as ${DEFAULT_PDF_ARCHIVE_ROOT}.`);
    }
    const body = drive ? candidate.slice(3) : candidate.slice(2);
    for (const segment of body.split("\\").filter(Boolean)) {
      if (WINDOWS_INVALID_CHARS.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment.split(".")[0] ?? "")) {
        throw new PdfArchiveError("ARCHIVE_ROOT_INVALID", `PDF archive root segment "${segment}" is not a valid Windows folder name.`);
      }
    }
    const normalized = path.win32.normalize(candidate);
    return /^[A-Za-z]:\\$/.test(normalized) ? normalized : normalized.replace(/\\+$/, "");
  }
  if (looksLikeWindowsPath(raw)) {
    throw new PdfArchiveError(
      "ARCHIVE_ROOT_WRONG_HOST",
      `PDF archive root ${raw} is a Windows path, but this MCP server runs on ${platform}. `
        + `Run the server on the Windows host where POHODA opens linked documents, or set ${PDF_ARCHIVE_ROOT_ENV} `
        + "to an absolute local directory that POHODA can open. Use sourceType manual only for documents without a source PDF."
    );
  }
  if (!path.posix.isAbsolute(raw)) {
    throw new PdfArchiveError("ARCHIVE_ROOT_INVALID", `PDF archive root ${raw} must be an absolute path.`);
  }
  const normalized = path.posix.normalize(raw);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

/** ASCII-safe folder segments: <ico|no-ico>/<database>/<year|no-year>. */
export function archiveSegments(context: PdfArchiveContext): string[] {
  if (!context || typeof context !== "object") {
    throw new PdfArchiveError("CONTEXT_INVALID", "PDF archive context with an explicit database is required.");
  }
  if (typeof context.database !== "string" || context.database.trim() === "") {
    throw new PdfArchiveError("CONTEXT_INVALID", "PDF archive requires the explicit databaseId of the accounting unit.");
  }
  let icoSegment = "no-ico";
  if (context.ico !== undefined && context.ico !== "") {
    const ico = String(context.ico).trim();
    if (!/^\d{1,10}$/.test(ico)) {
      throw new PdfArchiveError("CONTEXT_INVALID", `PDF archive ICO "${context.ico}" must contain digits only.`);
    }
    icoSegment = ico;
  }
  let yearSegment = "no-year";
  if (context.year !== undefined && context.year !== "") {
    const year = String(context.year).trim();
    if (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > 2999) {
      throw new PdfArchiveError("CONTEXT_INVALID", `PDF archive year "${context.year}" must be a four-digit year.`);
    }
    yearSegment = year;
  }
  return [icoSegment, sanitizeSegment(context.database), yearSegment];
}

/**
 * Converts a free-form identifier into a short ASCII folder name. Lossy
 * conversions append a hash of the original so different units never share a folder.
 */
export function sanitizeSegment(raw: string): string {
  const original = raw.trim();
  let value = original.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  value = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_");
  value = value.replace(/^[._-]+/, "").replace(/[._ -]+$/, "");
  if (WINDOWS_RESERVED.test(value.split(".")[0] ?? "")) {
    value = `_${value}`;
  }
  const lossy = value !== original;
  if (value === "") value = "unit";
  if (lossy || value.length > MAX_SEGMENT_LENGTH) {
    const hash = createHash("sha256").update(original, "utf8").digest("hex").slice(0, 8);
    value = `${value.slice(0, MAX_SEGMENT_LENGTH - 9)}-${hash}`;
  }
  return value;
}

export function isWindows1250RoundTrip(value: string): boolean {
  return iconv.decode(iconv.encode(value, "win1250"), "win1250") === value;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function validateSourcePath(sourcePath: string): void {
  if (typeof sourcePath !== "string" || sourcePath.trim() === "" || sourcePath.includes("\0")) {
    throw new PdfArchiveError("SOURCE_INVALID_PATH", "sourcePdfPath must be a non-empty absolute path to the source PDF.");
  }
  if (!path.isAbsolute(sourcePath)) {
    throw new PdfArchiveError("SOURCE_INVALID_PATH", `sourcePdfPath ${sourcePath} must be an absolute path readable by the MCP server.`);
  }
}

async function openSource(sourcePath: string): Promise<FileHandle> {
  try {
    return await open(sourcePath, "r");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new PdfArchiveError("SOURCE_NOT_FOUND", `Source PDF ${sourcePath} does not exist on the MCP server.`, { cause: error });
    }
    if (code === "EISDIR") {
      throw new PdfArchiveError("SOURCE_NOT_FILE", `Source PDF ${sourcePath} is not a regular file.`, { cause: error });
    }
    throw new PdfArchiveError("SOURCE_NOT_FOUND", `Source PDF ${sourcePath} cannot be opened (${code || "unknown error"}).`, { cause: error });
  }
}

async function digestHandle(handle: FileHandle, maxBytes: number, requirePdf: boolean, label: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    if (position === 0 && requirePdf && (bytesRead < PDF_HEADER.length || !buffer.subarray(0, PDF_HEADER.length).equals(PDF_HEADER))) {
      throw new PdfArchiveError("SOURCE_NOT_PDF", `Source ${label} is not a PDF (missing %PDF- header).`);
    }
    position += bytesRead;
    if (position > maxBytes) {
      throw new PdfArchiveError("SOURCE_TOO_LARGE", `Source PDF ${label} exceeds the archive limit of ${maxBytes} bytes.`);
    }
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { sha256: hash.digest("hex"), bytes: position };
}

async function copyHandle(source: FileHandle, target: FileHandle, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    let written = 0;
    while (written < bytesRead) {
      const result = await target.write(chunk, written, bytesRead - written, position + written);
      written += result.bytesWritten;
    }
    position += bytesRead;
    if (position > maxBytes) {
      throw new PdfArchiveError("SOURCE_CHANGED", `Source PDF grew beyond ${maxBytes} bytes while it was being archived.`);
    }
  }
  return { sha256: hash.digest("hex"), bytes: position };
}

async function digestPath(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(filePath, "r");
  try {
    return await digestHandle(handle, Number.MAX_SAFE_INTEGER, false, filePath);
  } finally {
    await handle.close();
  }
}

/** Returns true for an identical existing archive file, false when absent; throws on conflicts. */
async function verifyExisting(filePath: string, expected: { sha256: string; bytes: number }): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw wrapCopyError(error, filePath);
  }
  if (!stats.isFile()) {
    throw new PdfArchiveError("TARGET_CONFLICT", `Archive path ${filePath} exists but is not a regular file; it was not replaced.`);
  }
  // A concurrent writer using the copy fallback may still be filling the file.
  for (let attempt = 0; ; attempt += 1) {
    const actual = await digestPath(filePath);
    if (actual.sha256 === expected.sha256 && actual.bytes === expected.bytes) return true;
    if (actual.bytes >= expected.bytes || attempt >= 5) {
      throw new PdfArchiveError("TARGET_CONFLICT", `Archive path ${filePath} already contains different content (sha256 ${actual.sha256}); it was not overwritten.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function reuseOrConflict(filePath: string, expected: { sha256: string; bytes: number }): Promise<PdfArchiveResult> {
  if (!(await verifyExisting(filePath, expected))) {
    throw new PdfArchiveError("COPY_FAILED", `Archive path ${filePath} disappeared during archiving.`);
  }
  return { path: filePath, sha256: expected.sha256, bytes: expected.bytes, reused: true };
}

async function ensureContainedDirectory(root: string, directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw new PdfArchiveError("COPY_FAILED", `Cannot create archive folder ${directory} (${errorCode(error) || "unknown error"}).`, { cause: error });
  }
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  const fold = (value: string) => (process.platform === "win32" ? value.toUpperCase() : value);
  const relative = path.relative(fold(realRoot), fold(realDirectory));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PdfArchiveError("ARCHIVE_ESCAPE", `Archive folder ${directory} resolves outside the archive root ${root}.`);
  }
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    const text = (value as Record<string, unknown>)["#text"];
    return typeof text === "string" || typeof text === "number" ? String(text) : undefined;
  }
  return undefined;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
}

function wrapCopyError(error: unknown, target: string): PdfArchiveError {
  if (error instanceof PdfArchiveError) return error;
  return new PdfArchiveError("COPY_FAILED", `Cannot archive PDF to ${target} (${errorCode(error) || String(error)}).`, { cause: error });
}
