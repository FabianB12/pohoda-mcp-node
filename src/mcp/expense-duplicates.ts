import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { PohodaClient } from "../pohoda/client.js";
import type { TransportOptions } from "../pohoda/transport.js";
import { DEFAULT_PDF_ARCHIVE_MAX_BYTES } from "../pohoda/pdf-archive.js";
import { companyKey, normalizeDic, normalizeIco } from "../registry/czech-registry.js";
import { moneyValue, sumHomeCurrency, toMinorUnits } from "../pohoda/money.js";
import { expenseIdentityCandidates, retryMarker, retryMarkersIn, scanExpenseAgendas } from "./expense-import.js";
import type { ReviewTool } from "./review-contract.js";

type Fields = Record<string, any>;
export type DuplicateMatch = {
  location: "pohoda" | "batch";
  reason: "identity" | "reference" | "amount_date";
  agenda: string;
  type: string;
  id?: string;
  rowId?: string;
  number: string;
  date: string;
  total?: number;
  currency: string;
};
export type PreviewDuplicateCheck = {
  status: "clear" | "possible" | "incomplete";
  checkedAt: string;
  message: string;
  matches: DuplicateMatch[];
  matchCount: number;
};
export type DuplicateDraft = { rowId: string; tool: ReviewTool; data: Fields };
type Candidate = {
  data: Fields; agenda: string; type: string; id?: string; rowId?: string;
  number: string; reference: string; dates: string[]; total: number | undefined; currency: string;
  keys: string[]; markers: string[]; extId?: string; extSystem?: string; pdfKey?: string;
};
const groups = [{ agenda: "invoice", subType: "receivedInvoice" }, { agenda: "invoice", subType: "commitment" }, { agenda: "voucher", subType: "" }];
export const PREVIEW_DUPLICATE_PAGE_SIZE = 2_000;
const scalar = (v: any): string => v == null ? "" : typeof v === "object" ? scalar(v["#text"]) : String(v).trim();
const reference = (v: any): string => scalar(v).normalize("NFKC").replace(/\s+/g, "").toUpperCase();

/** Read-only. Scan each expense agenda once, hash each PDF once, then match locally. */
export async function checkPreviewDuplicates(client: Pick<PohodaClient, "listRecordsBatch">, drafts: DuplicateDraft[], target: TransportOptions) {
  const checkedAt = new Date().toISOString();
  const warnings: string[] = [];
  const fileHashes = new Map<string, Promise<string>>();
  const fileErrors = new Map<string, string>();
  const incoming: Candidate[] = [];
  for (const row of drafts) {
    let hash: string | undefined;
    if (row.data.sourcePdfPath) {
      const path = resolve(String(row.data.sourcePdfPath));
      let pending = fileHashes.get(path);
      if (!pending) { pending = hashPdf(path); fileHashes.set(path, pending); }
      try { hash = await pending; } catch (error) { fileErrors.set(row.rowId, (error as Error).message); }
    }
    incoming.push(fromDraft(row, hash));
  }
  let records: Candidate[] = [], complete = true;
  let snapshot = new Map<string, Fields[]>();
  try {
    // The selected database is already the scope. Do not limit duplicate checks
    // to the ten recent examples or assume a document was posted in its source month.
    snapshot = await scanExpenseAgendas(client, groups, {}, target, false, PREVIEW_DUPLICATE_PAGE_SIZE);
    for (const group of groups) for (const raw of snapshot.get(`${group.agenda}|${group.subType}`) ?? []) {
      const h = raw.invoiceHeader ?? raw.voucherHeader ?? raw;
      const type = scalar(h.invoiceType ?? h.voucherType ?? h.type) || group.subType || "expense";
      if (group.agenda === "invoice" && type !== group.subType) continue;
      if (group.agenda === "voucher" && type !== "expense") continue;
      records.push(fromStored(raw, group.agenda, type));
    }
  } catch (error) {
    complete = false;
    warnings.push(`Kontrolu duplicit v POHODĚ nelze dokončit: ${(error as Error).message}`);
  }
  const index = new Map<string, Candidate[]>();
  for (const record of records) for (const key of [...record.keys, ...record.markers.map((m) => `marker:${m}`), ...(record.extId ? [`marker:${retryMarkerSafe(record.extSystem, record.extId)}`] : [])]) {
    const list = index.get(key) ?? []; list.push(record); index.set(key, list);
  }
  const byRow: Record<string, PreviewDuplicateCheck> = {};
  for (const row of incoming) {
    const candidates = new Set<Candidate>();
    for (const key of [...row.keys, ...row.markers.map((m) => `marker:${m}`)]) for (const candidate of index.get(key) ?? []) candidates.add(candidate);
    const matches: DuplicateMatch[] = [];
    for (const candidate of candidates) {
      const reason = matchReason(row, candidate);
      if (reason) matches.push(toMatch(candidate, reason, "pohoda"));
    }
    for (const candidate of incoming) {
      if (candidate === row) continue;
      const reason = matchReason(row, candidate);
      if (reason) matches.push(toMatch(candidate, reason, "batch"));
    }
    const error = fileErrors.get(row.rowId!) || (!row.pdfKey && !row.keys.length ? "Chybí identita dodavatele i ověřitelný zdrojový PDF doklad." : undefined);
    const status = !complete || error ? "incomplete" : matches.length ? "possible" : "clear";
    const lines = matches.slice(0, 25).map(describeMatch);
    if (!complete) lines.unshift("Neověřeno: kontrola POHODY selhala. Před importem ji zopakujte.");
    if (error) lines.unshift(`Neověřeno PDF: ${error}`);
    if (matches.length > 25) lines.push(`Dalších shod: ${matches.length - 25}.`);
    if (!lines.length) lines.push("Bez nalezené shody v kontrolovaných agendách POHODY a této dávce.");
    byRow[row.rowId!] = { status, checkedAt, message: lines.join("\n"), matches: matches.slice(0, 25), matchCount: matches.length };
  }
  return { complete: complete && Object.values(byRow).every((row) => row.status !== "incomplete"), checkedAt, database: target.databaseOverride, scannedRecords: records.length, warnings, byRow, snapshot };
}

async function hashPdf(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > DEFAULT_PDF_ARCHIVE_MAX_BYTES) throw new Error("PDF není běžný soubor v povolené velikosti.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await stat(path);
  if (info.size !== after.size || info.mtimeMs !== after.mtimeMs) throw new Error("PDF se během kontroly změnilo.");
  return hash.digest("hex");
}

function supplierKeys(data: Fields): string[] {
  const keys: string[] = [];
  const ico = normalizeIco(data.partnerIco);
  if (ico.ok) keys.push(`ico:${ico.ico}`);
  else if (data.partnerIco) keys.push(`ico:${scalar(data.partnerIco).replace(/\s/g, "")}`);
  const dic = normalizeDic(data.partnerDic)?.normalized;
  if (dic) keys.push(`dic:${dic}`);
  if (Number(data.partnerId) > 0) keys.push(`id:${Number(data.partnerId)}`);
  const name = companyKey(data.partnerName);
  if (name) keys.push(`name:${name}`);
  return keys;
}

function fromDraft(row: DuplicateDraft, hash?: string): Candidate {
  const h = { ...row.data };
  if (h.partnerIco) { const ico = normalizeIco(h.partnerIco); if (ico.ok) h.partnerIco = ico.ico; }
  const type = row.tool === "create_cash_voucher" ? "expense" : row.tool === "create_other_liability" ? "commitment" : h.type || "receivedInvoice";
  const pages = Array.isArray(h.sourcePages) ? [...new Set<number>(h.sourcePages)].filter((p) => Number.isInteger(p) && p > 0).sort((a, b) => a - b) : [];
  const markers = hash && pages.length ? ["receivedInvoice", "commitment", "expense"].flatMap((kind) => {
    const identity = expenseIdentityCandidates({ ...h, type: kind, sourcePdfSha256: hash, sourcePages: pages });
    return identity.candidates.map((id) => retryMarker("pohoda-mcp-expenses", id));
  }) : h.sourceDocumentNumber ? expenseIdentityCandidates({ ...h, type }).candidates.map((id) => retryMarker("pohoda-mcp-expenses", id)) : [];
  return { data: h, agenda: type === "expense" ? "voucher" : "invoice", type, rowId: row.rowId, number: scalar(h.sourceDocumentNumber), reference: reference(h.sourceDocumentNumber), dates: dateValues(h), total: amount(h.total), currency: scalar(h.currency).toUpperCase() || "CZK", keys: supplierKeys(h), markers, ...(hash && pages.length ? { pdfKey: `${hash}|${pages.join(",")}` } : {}) };
}

function fromStored(raw: Fields, agenda: string, type: string): Candidate {
  const h = raw.invoiceHeader ?? raw.voucherHeader ?? raw, address = h.partnerIdentity?.address ?? {};
  const data = { partnerId: h.partnerIdentity?.id, partnerIco: address.ico, partnerDic: address.dic, partnerName: address.company || address.name };
  const summary = raw.invoiceSummary ?? raw.voucherSummary ?? {};
  let total: number | undefined;
  try { total = summary.foreignCurrency ? amount(summary.foreignCurrency.priceSum) : summary.homeCurrency && Object.keys(summary.homeCurrency).some((key) => key.startsWith("price")) ? amount(sumHomeCurrency(summary.homeCurrency)) : undefined; } catch { /* unknown amount cannot support a heuristic match */ }
  // Small card purchases have an internal K<number>, not the supplier's receipt
  // reference. Older manually entered cards therefore need amount/date matching.
  const internalCardReference = type === "commitment" && /^K\d+$/i.test(scalar(h.originalDocument))
    && /^PK/i.test(scalar(h.number?.numberRequested ?? h.number?.ids));
  const sourceDates = [...scalar(h.intNote).matchAll(/(?:vystaveno|DUZP|uhrazeno)\s+(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]!);
  return { data, agenda, type, id: scalar(h.id), number: scalar(h.number?.numberRequested ?? h.number?.ids), reference: internalCardReference ? "" : reference(h.originalDocument), dates: [...new Set([...dateValues(h), ...sourceDates])], total, currency: scalar(summary.foreignCurrency?.currency?.ids).toUpperCase() || "CZK", keys: supplierKeys(data), markers: retryMarkersIn(h.intNote), extId: scalar(h.extId?.ids), extSystem: scalar(h.extId?.exSystemName) };
}

function amount(value: any): number | undefined {
  try { const v = moneyValue(value); return v === undefined || v === null || v === "" ? undefined : toMinorUnits(v as string | number); } catch { return undefined; }
}
function dateValues(h: Fields): string[] {
  return [...new Set([h.sourceIssueDate, h.sourceTaxDate, h.sourcePaymentDate, h.date, h.dateTax, h.datePayment].map(scalar).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)))];
}
function sameSupplier(a: Candidate, b: Candidate): boolean {
  for (const field of ["partnerIco", "partnerDic"]) if (a.data[field] && b.data[field]) {
    const prefix = field === "partnerIco" ? "ico:" : "dic:";
    return a.keys.some((key) => key.startsWith(prefix) && b.keys.includes(key));
  }
  return a.keys.some((key) => b.keys.includes(key));
}
function matchReason(a: Candidate, b: Candidate): DuplicateMatch["reason"] | undefined {
  if ((a.pdfKey && a.pdfKey === b.pdfKey) || a.markers.some((m) => b.markers.includes(m)) || (b.extId && a.markers.includes(retryMarkerSafe(b.extSystem, b.extId)))) return "identity";
  if (!sameSupplier(a, b)) return undefined;
  if (a.reference && a.reference === b.reference) return "reference";
  if ((!a.reference || !b.reference) && a.total !== undefined && a.total === b.total && a.currency === b.currency && a.dates.some((date) => b.dates.includes(date))) return "amount_date";
  return undefined;
}
function retryMarkerSafe(system?: string, id?: string): string { try { return retryMarker(system || "", id || ""); } catch { return ""; } }
function toMatch(row: Candidate, reason: DuplicateMatch["reason"], location: DuplicateMatch["location"]): DuplicateMatch {
  return { location, reason, agenda: row.agenda, type: row.type, ...(row.id ? { id: row.id } : {}), ...(row.rowId ? { rowId: row.rowId } : {}), number: row.number, date: row.dates[0] ?? "", ...(row.total !== undefined ? { total: row.total / 100 } : {}), currency: row.currency };
}
function describeMatch(match: DuplicateMatch): string {
  const where = match.location === "batch" ? `řádek ${match.rowId} této dávky` : `POHODA ${match.type} #${match.id}${match.number ? ` (${match.number})` : ""}`;
  const reason = match.reason === "identity" ? "stejný zdrojový doklad" : match.reason === "reference" ? "stejný dodavatel a číslo dokladu" : "stejný dodavatel, částka, měna a datum; možná shoda";
  return `Možná duplicita: ${where} — ${reason}${match.date ? `, datum ${match.date}` : ""}${match.total !== undefined ? `, ${match.total.toFixed(2)} ${match.currency}` : ""}.`;
}

/** Compact reviewer label. Full evidence stays in the manifest/tool result. */
export function duplicateReviewNote(check?: PreviewDuplicateCheck): string {
  if (!check || check.status === "clear") return "";
  const refs = check.matches.slice(0, 2).map((m) => m.location === "batch" ? `řádek ${m.rowId}` : `${m.number || "POHODA"} (#${m.id})`);
  const extra = check.matchCount > 2 ? ` +${check.matchCount - 2}` : "";
  return [check.status === "incomplete" ? "Duplicity neověřeny." : "", refs.length ? `Duplicita: ${refs.join(", ")}${extra}.` : ""].filter(Boolean).join(" ");
}

export function withDuplicateReviewNote(note: string, check?: PreviewDuplicateCheck): string {
  const existing = note.split("\n").filter((line) => !/^(?:Duplicita:|Duplicity neověřeny\.|Možná duplicita:)/.test(line));
  return [duplicateReviewNote(check), ...existing].filter(Boolean).join("\n");
}
