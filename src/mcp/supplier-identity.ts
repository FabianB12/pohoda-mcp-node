/**
 * Supplier identity against the POHODA address book of the explicit accounting unit.
 *
 * An address-book ID ("ID adresy") is an internal POHODA key. A caller or model can
 * produce a plausible but wrong one, so an ID is never trusted on its own: it is a claim
 * that must match the document's supplier facts (IČO, DIČ, else name) on a real record.
 * Without an ID, the supplier is resolved from IČO/DIČ (and, for preview only, exact
 * name). Several records for one supplier are reported, never silently picked.
 *
 * Reads are batched (one listRecordsBatch per chunk of unique filters) and every POHODA
 * filter result is re-checked locally, so an ignored or fuzzy filter cannot create a match.
 */
import type { ListRecordsBatchRequest, PohodaClient } from "../pohoda/client.js";
import type { TransportOptions } from "../pohoda/transport.js";
import { companyKey, normalizeDic, normalizeIco } from "../registry/czech-registry.js";

type Fields = Record<string, any>;
const text = (v: unknown): string => v == null ? "" : String(v).trim();

/** Rows per identifier lookup; a full page means the lookup may be incomplete and fails closed. */
export const SUPPLIER_LOOKUP_COUNT = 100;
const REQUESTS_PER_BATCH = 100;

export type AddressRecord = { id: number; company: string; name: string; ico: string; dic: string; country: string; isSupplier: boolean; header: Fields };

export type SupplierFacts = { partnerId?: unknown; partnerIco?: unknown; partnerDic?: unknown; partnerName?: unknown; partnerCountry?: unknown };

export type SupplierStatus =
  | "verified"           // claimed ID exists and matches the supplier facts
  | "resolved"           // no claimed ID; exactly one record matches IČO/DIČ (or exact name in preview)
  | "new"                // no claimed ID and no record: the importer creates the contact
  | "missingIdentifier"  // no ID, IČO or DIČ and nothing found by name
  | "idNotFound" | "idConflict" | "idUnverifiable"
  | "duplicate"          // several records match one supplier
  | "identifierConflict" // IČO and DIČ point to different records / contradict a record
  | "incomplete";        // a lookup hit its bound: cannot prove uniqueness

export type SupplierResolution = {
  status: SupplierStatus;
  /** Machine code for the row (review issue / import error). */
  code: string;
  /** Czech explanation for the reviewer; empty for verified/resolved/new. */
  message: string;
  claimedId?: number;
  /** Record to link (verified/resolved), or the record the claimed ID points to (idConflict). */
  record?: AddressRecord;
  /** How the linked record was established. */
  via?: "ico" | "dic" | "name";
  /** Records matching the supplier facts (IČO/DIČ/name), for evidence and alternatives. */
  candidates: AddressRecord[];
  /** For a rejected claimed ID: what the supplier facts alone resolve to. */
  alternative?: SupplierResolution;
  /** Name on the linked record differs from the document (informational when IČO/DIČ match). */
  nameDiffers?: boolean;
};

export const OK_STATUSES: ReadonlySet<SupplierStatus> = new Set(["verified", "resolved", "new"]);

export type AddressBookLookup = {
  byId: Map<number, AddressRecord | null>;
  lookups: Map<string, { records: AddressRecord[]; complete: boolean }>;
  checkedAt: string;
};

function countryOf(value: unknown): string {
  const v = value && typeof value === "object" ? (value as Fields).ids ?? (value as Fields)["#text"] : value;
  return text(v).toUpperCase();
}

/** Country-scoped IČO key: Czech checksum normalization, otherwise the trimmed identifier. */
export function icoKey(ico: unknown, country?: unknown): string {
  const raw = text(ico).replace(/\s+/g, "");
  if (!raw) return "";
  const c = countryOf(country) || "CZ";
  const checked = normalizeIco(raw);
  return `${c}:${checked.ok ? checked.ico : raw.toUpperCase()}`;
}

export function dicKey(dic: unknown): string {
  const raw = text(dic);
  if (!raw) return "";
  return normalizeDic(raw)?.normalized || raw.replace(/\s+/g, "").toUpperCase();
}

function factsOf(facts: SupplierFacts) {
  const country = countryOf(facts.partnerCountry);
  const ico = icoKey(facts.partnerIco, country);
  const dic = dicKey(facts.partnerDic);
  const name = companyKey(text(facts.partnerName));
  const claimedId = Number(facts.partnerId) > 0 ? Number(facts.partnerId) : 0;
  return { country, ico, dic, name, claimedId };
}

export function addressRecordOf(raw: Fields): AddressRecord | undefined {
  const header = raw?.addressbookHeader;
  if (!header || typeof header !== "object") return undefined;
  const address = (header.identity ?? {}).address ?? {};
  const id = Number(header.id);
  if (!(id > 0)) return undefined;
  return {
    id, company: text(address.company), name: text(address.name), ico: text(address.ico), dic: text(address.dic),
    country: countryOf(address.country), isSupplier: text(header.p1) === "true" || header.p1 === true, header
  };
}

function addressRecords(data: Fields): AddressRecord[] {
  const out: AddressRecord[] = [];
  const visit = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value.addressbookHeader) { const record = addressRecordOf(value); if (record) out.push(record); return; }
    for (const child of Object.values(value)) visit(child);
  };
  visit(data);
  return out;
}

const recordIco = (r: AddressRecord) => icoKey(r.ico, r.country);
const nameMatches = (r: AddressRecord, key: string) => Boolean(key) && [r.company, r.name, `${r.company} ${r.name}`].some((n) => text(n) && companyKey(n) === key);

type LookupKey = { key: string; request: ListRecordsBatchRequest; matches: (r: AddressRecord) => boolean };

function lookupKeys(facts: SupplierFacts, allowNameMatch: boolean): LookupKey[] {
  const f = factsOf(facts);
  const keys: LookupKey[] = [];
  const request = (filter: Fields, count = SUPPLIER_LOOKUP_COUNT): ListRecordsBatchRequest => ({ agenda: "addressbook", filter, options: { count } });
  if (f.claimedId) keys.push({ key: `id:${f.claimedId}`, request: request({ id: f.claimedId }, 2), matches: (r) => r.id === f.claimedId });
  if (f.ico) keys.push({ key: `ico:${f.ico}`, request: request({ ico: f.ico.slice(f.ico.indexOf(":") + 1) }), matches: (r) => recordIco(r) === f.ico });
  if (f.dic) keys.push({ key: `dic:${f.dic}`, request: request({ dic: f.dic }), matches: (r) => dicKey(r.dic) === f.dic });
  if (allowNameMatch && !f.ico && !f.dic && f.name) keys.push({ key: `name:${f.name}`, request: request({ company: text(facts.partnerName) }), matches: (r) => nameMatches(r, f.name) });
  return keys;
}

/**
 * One batched read of every distinct ID/IČO/DIČ (and, with allowNameMatch, name) filter.
 * Throws when POHODA does not answer every lookup; callers fail closed.
 */
export async function readAddressBook(client: Pick<PohodaClient, "listRecordsBatch">, rows: SupplierFacts[], target: TransportOptions, options: { allowNameMatch?: boolean } = {}): Promise<AddressBookLookup> {
  const unique = new Map<string, LookupKey>();
  for (const row of rows) for (const key of lookupKeys(row, options.allowNameMatch === true)) if (!unique.has(key.key)) unique.set(key.key, key);
  const list = [...unique.values()];
  const book: AddressBookLookup = { byId: new Map(), lookups: new Map(), checkedAt: new Date().toISOString() };
  for (let start = 0; start < list.length; start += REQUESTS_PER_BATCH) {
    const chunk = list.slice(start, start + REQUESTS_PER_BATCH);
    const response = await client.listRecordsBatch(chunk.map((k) => k.request), "", target);
    if (!response.isOk() || response.items.length !== chunk.length) throw new Error("POHODA address-book lookup failed or was incomplete.");
    chunk.forEach((lookup, index) => {
      const all = addressRecords(response.items[index]!.data);
      const records = all.filter(lookup.matches);
      const bound = Number(lookup.request.options?.count) || SUPPLIER_LOOKUP_COUNT;
      book.lookups.set(lookup.key, { records, complete: all.length < bound || lookup.key.startsWith("id:") });
      if (lookup.key.startsWith("id:")) book.byId.set(Number(lookup.key.slice(3)), records[0] ?? null);
    });
  }
  return book;
}

export function describeRecord(r: AddressRecord): string {
  const label = r.company || r.name || "(bez názvu)";
  return `ID ${r.id} ${label}${r.ico ? `, IČO ${r.ico}` : ""}${r.dic ? `, DIČ ${r.dic}` : ""}`;
}

function describeFacts(facts: SupplierFacts): string {
  const parts = [text(facts.partnerName) || "(bez názvu)"];
  if (text(facts.partnerIco)) parts.push(`IČO ${text(facts.partnerIco)}`);
  if (text(facts.partnerDic)) parts.push(`DIČ ${text(facts.partnerDic)}`);
  return parts.join(", ");
}

const uniqueById = (records: AddressRecord[]) => [...new Map(records.map((r) => [r.id, r])).values()].sort((a, b) => a.id - b.id);

function result(status: SupplierStatus, code: string, message: string, extra: Partial<SupplierResolution> = {}): SupplierResolution {
  return { status, code, message, candidates: [], ...extra };
}

/** Resolution from IČO/DIČ (or exact name) alone, ignoring any claimed ID. */
function resolveByFacts(facts: SupplierFacts, book: AddressBookLookup, allowNameMatch: boolean): SupplierResolution {
  const f = factsOf(facts);
  const get = (key: string) => book.lookups.get(key);
  const ico = f.ico ? get(`ico:${f.ico}`) : undefined;
  const dic = f.dic ? get(`dic:${f.dic}`) : undefined;
  if ((f.ico && !ico) || (f.dic && !dic)) return result("incomplete", "SUPPLIER_LOOKUP_INCOMPLETE", "Adresář POHODY nebyl pro tohoto dodavatele prohledán; dodavatele nelze ověřit.");
  if (ico?.complete === false || dic?.complete === false) return result("incomplete", "SUPPLIER_LOOKUP_INCOMPLETE", `Hledání v adresáři POHODY vrátilo ${SUPPLIER_LOOKUP_COUNT} a více adres; dodavatele nelze jednoznačně ověřit.`);
  if (!f.ico && !f.dic) {
    const byName = allowNameMatch && f.name ? get(`name:${f.name}`) : undefined;
    if (byName?.complete === false) return result("incomplete", "SUPPLIER_LOOKUP_INCOMPLETE", `Hledání podle názvu vrátilo ${SUPPLIER_LOOKUP_COUNT} a více adres; doplňte IČO nebo DIČ z dokladu.`);
    const named = uniqueById(byName?.records ?? []);
    if (named.length === 1) return result("resolved", "SUPPLIER_RESOLVED", "", { record: named[0]!, via: "name", candidates: named });
    if (named.length > 1) return result("duplicate", "SUPPLIER_DUPLICATE_CONTACTS", `V adresáři POHODY je více adres se stejným názvem (${named.map(describeRecord).join("; ")}); import mezi nimi nevybírá. Doplňte IČO nebo DIČ z dokladu, případně sloučte duplicitní adresy v POHODĚ.`, { candidates: named });
    return result("missingIdentifier", "SUPPLIER_IDENTIFIER_REQUIRED", "Dodavatel nemá IČO ani DIČ a v adresáři POHODY nebyl jednoznačně nalezen; doplňte IČO nebo DIČ z dokladu.");
  }
  const icoRecords = uniqueById(ico?.records ?? []), dicRecords = uniqueById(dic?.records ?? []);
  const candidates = uniqueById([...icoRecords, ...dicRecords]);
  if (!candidates.length) return result("new", "SUPPLIER_NEW", "");
  if (icoRecords.length && dicRecords.length && !icoRecords.some((r) => dicRecords.some((d) => d.id === r.id))) {
    return result("identifierConflict", "SUPPLIER_IDENTIFIER_CONFLICT", `IČO a DIČ dodavatele patří v adresáři POHODY různým adresám (${candidates.map(describeRecord).join("; ")}); ověřte IČO a DIČ na dokladu.`, { candidates });
  }
  if (candidates.length > 1) {
    return result("duplicate", "SUPPLIER_DUPLICATE_CONTACTS", `V adresáři POHODY je více adres tohoto dodavatele (${candidates.map(describeRecord).join("; ")}); import mezi nimi nevybírá. Sloučte nebo opravte duplicitní adresy v POHODĚ; import pak dodavatele dohledá znovu.`, { candidates });
  }
  const record = candidates[0]!;
  const conflicts: string[] = [];
  if (f.ico && record.ico && recordIco(record) !== f.ico) conflicts.push(`IČO v adresáři ${record.ico}`);
  if (f.dic && record.dic && dicKey(record.dic) !== f.dic) conflicts.push(`DIČ v adresáři ${record.dic}`);
  if (conflicts.length) {
    return result("identifierConflict", "SUPPLIER_IDENTIFIER_CONFLICT", `Adresa ${describeRecord(record)} odpovídá dokladu jen částečně (${conflicts.join(", ")}; doklad: ${describeFacts(facts)}); ověřte IČO a DIČ na dokladu.`, { record, candidates });
  }
  const via = icoRecords.some((r) => r.id === record.id) ? "ico" as const : "dic" as const;
  return result("resolved", "SUPPLIER_RESOLVED", "", { record, via, candidates, nameDiffers: Boolean(f.name) && !nameMatches(record, f.name) });
}

/**
 * Pure decision for one supplier. A claimed ID is accepted only when the record exists,
 * agrees with every IČO/DIČ the document has, and is positively confirmed by IČO, DIČ or
 * (when the document has neither on the record) the exact company name.
 */
export function resolveSupplier(facts: SupplierFacts, book: AddressBookLookup, options: { allowNameMatch?: boolean } = {}): SupplierResolution {
  const allowNameMatch = options.allowNameMatch === true;
  const f = factsOf(facts);
  const byFacts = resolveByFacts(facts, book, allowNameMatch);
  if (!f.claimedId) return byFacts;
  const claimedId = f.claimedId;
  const alternative = byFacts;
  if (!book.byId.has(claimedId)) return result("incomplete", "SUPPLIER_LOOKUP_INCOMPLETE", `ID adresy ${claimedId} nebylo v adresáři POHODY ověřeno.`, { claimedId, alternative });
  const record = book.byId.get(claimedId);
  if (!record) return result("idNotFound", "SUPPLIER_ID_NOT_FOUND", `ID adresy ${claimedId} v adresáři POHODY neexistuje; zadané ID se nepoužije.`, { claimedId, alternative, candidates: alternative.candidates });
  const reasons: string[] = [];
  const icoMatch = Boolean(f.ico && record.ico && recordIco(record) === f.ico);
  const dicMatch = Boolean(f.dic && record.dic && dicKey(record.dic) === f.dic);
  if (f.ico && record.ico && !icoMatch) reasons.push(`IČO ${record.ico} ≠ ${text(facts.partnerIco)}`);
  if (f.dic && record.dic && !dicMatch) reasons.push(`DIČ ${record.dic} ≠ ${text(facts.partnerDic)}`);
  const nameMatch = nameMatches(record, f.name);
  if (!icoMatch && !dicMatch && f.name && !nameMatch && (record.company || record.name)) reasons.push(`název ${record.company || record.name} ≠ ${text(facts.partnerName)}`);
  // An IČO/DIČ the record lacks but another record has belongs to that other record.
  for (const other of alternative.candidates) if (other.id !== record.id) {
    if (f.ico && !record.ico && recordIco(other) === f.ico) reasons.push(`IČO ${text(facts.partnerIco)} má adresa ${describeRecord(other)}`);
    else if (f.dic && !record.dic && dicKey(other.dic) === f.dic) reasons.push(`DIČ ${text(facts.partnerDic)} má adresa ${describeRecord(other)}`);
  }
  if (reasons.length) {
    return result("idConflict", "SUPPLIER_ID_CONFLICT", `ID adresy ${claimedId} patří jinému subjektu (${describeRecord(record)}) než dodavatel z dokladu (${describeFacts(facts)}): ${[...new Set(reasons)].join("; ")}. Zadané ID se nepoužije.`, { claimedId, record, alternative, candidates: alternative.candidates });
  }
  if (!icoMatch && !dicMatch && !nameMatch) {
    return result("idUnverifiable", "SUPPLIER_ID_UNVERIFIABLE", `ID adresy ${claimedId} (${describeRecord(record)}) nelze ověřit podle IČO, DIČ ani názvu dodavatele z dokladu; zadané ID se nepoužije.`, { claimedId, record, alternative, candidates: alternative.candidates });
  }
  if (alternative.status === "incomplete") return { ...alternative, claimedId };
  const others = alternative.candidates.filter((r) => r.id !== record.id);
  if (others.length) {
    const all = uniqueById([record, ...others]);
    return result("duplicate", "SUPPLIER_DUPLICATE_CONTACTS", `V adresáři POHODY je více adres tohoto dodavatele (${all.map(describeRecord).join("; ")}); import mezi nimi nevybírá. Sloučte nebo opravte duplicitní adresy v POHODĚ; import pak dodavatele dohledá znovu.`, { claimedId, candidates: all });
  }
  return result("verified", "SUPPLIER_VERIFIED", "", { claimedId, record, via: icoMatch ? "ico" : dicMatch ? "dic" : "name", candidates: alternative.candidates, nameDiffers: Boolean(f.name) && !nameMatch });
}

/** Evidence for one row, safe to return to the caller and store in the manifest. */
export function supplierEvidence(rowId: string, facts: SupplierFacts, resolution: SupplierResolution): Fields {
  const brief = (r: AddressRecord) => ({ id: r.id, company: r.company || r.name, ico: r.ico, dic: r.dic });
  return {
    rowId, code: resolution.code, status: resolution.status, message: resolution.message,
    supplier: { name: text(facts.partnerName), ico: text(facts.partnerIco), dic: text(facts.partnerDic), country: text(facts.partnerCountry) },
    ...(resolution.claimedId ? { claimedId: resolution.claimedId } : {}),
    ...(resolution.record ? { record: brief(resolution.record) } : {}),
    ...(resolution.candidates.length ? { candidates: resolution.candidates.map(brief) } : {}),
    ...(resolution.alternative && OK_STATUSES.has(resolution.alternative.status) && resolution.alternative.record ? { resolvedByFacts: { ...brief(resolution.alternative.record), via: resolution.alternative.via } } : {})
  };
}

/** Pre-write rejection: no POHODA write was attempted; every affected row is listed. */
export class SupplierIdentityError extends Error {
  readonly writeAttempted = false;
  constructor(public readonly issues: Fields[]) {
    super(`Dodavatel neodpovídá adresáři POHODY; nic nebylo zapsáno. ${issues.map((i) => `${i.rowId}: ${i.message}`).join(" ")}`);
    this.name = "SupplierIdentityError";
  }
}

export const supplierLabel = (via: SupplierResolution["via"]): string => via === "ico" ? "IČO" : via === "dic" ? "DIČ" : "názvu";
