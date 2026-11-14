// Read-only Czech public-registry lookups and supplier-contact planning.
//
// - ARES REST API v1.4.0 (MF CR): identity, seat address, DIC, registry source states.
//   https://ares.gov.cz/ekonomicke-subjekty-v-be/rest  (OpenAPI: .../rest/v3/api-docs)
// - ADIS "rozhraniCRPDPH" SOAP (MF CR / GFR), operation getStatusNespolehlivySubjektRozsirenyV2:
//   current VAT subject type, unreliable flag, published bank accounts.
//   https://adisrws.mfcr.cz/adistc/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP?wsdl
//
// Nothing in this module writes to POHODA. It reports evidence and plans; callers decide.
// Both registries report the CURRENT state only. Nothing here proves a supplier's status on a
// historical tax point; every VAT result carries that caveat.
import { XMLParser } from "fast-xml-parser";

export const ARES_BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";
export const ADIS_URL = "https://adisrws.mfcr.cz/adistc/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP";
export const ADIS_SOAP_ACTION = "http://adis.mfcr.cz/rozhraniCRPDPH/getStatusNespolehlivySubjektRozsirenyV2";
/** extId system name used for contacts created from registry/document data (adb:identity/typ:extId). */
export const REGISTRY_EXT_SYSTEM = "pohoda-mcp-registry";
/** POHODA typ:address XSD max lengths. Values are never truncated silently. */
export const POHODA_ADDRESS_LIMITS = { company: 255, ico: 15, dic: 18, street: 64, city: 45, zip: 15 } as const;

const ALLOWED_HOSTS = new Set(["ares.gov.cz", "adisrws.mfcr.cz"]);
const PRAGUE_KOD_OBCE = 554782;

// ================================================================= identifiers

export type IcoCheck = { ok: true; ico: string } | { ok: false; reason: "empty" | "format" | "checksum" };

/** Czech ICO: 8 digits with mod-11 check digit. Shorter legacy values are left-padded with zeros. */
export function normalizeIco(input: string | number | undefined | null): IcoCheck {
  const raw = String(input ?? "").replace(/\s+/g, "");
  if (raw === "") return { ok: false, reason: "empty" };
  if (!/^\d{1,8}$/.test(raw)) return { ok: false, reason: "format" };
  const ico = raw.padStart(8, "0");
  return isValidIcoChecksum(ico) ? { ok: true, ico } : { ok: false, reason: "checksum" };
}

export function isValidIcoChecksum(ico: string): boolean {
  if (!/^\d{8}$/.test(ico)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(ico[i]) * (8 - i);
  return (11 - (sum % 11)) % 10 === Number(ico[7]);
}

/**
 * VAT identifier prefixes (EU VIES prefixes plus XI for Northern Ireland). The VAT prefix is not
 * always the ISO country code: Greece uses EL, Northern Ireland XI.
 */
export const VAT_PREFIX_TO_ISO: Readonly<Record<string, string>> = {
  AT: "AT", BE: "BE", BG: "BG", CY: "CY", CZ: "CZ", DE: "DE", DK: "DK", EE: "EE", EL: "GR", ES: "ES",
  FI: "FI", FR: "FR", HR: "HR", HU: "HU", IE: "IE", IT: "IT", LT: "LT", LU: "LU", LV: "LV", MT: "MT",
  NL: "NL", PL: "PL", PT: "PT", RO: "RO", SE: "SE", SI: "SI", SK: "SK", XI: "GB"
};

export type VatIdParts = {
  /** Prefix exactly as written on the source (uppercased). Never rewritten (EL stays EL, GR stays GR). */
  vatPrefix: string;
  /** Characters after the prefix, separators removed. */
  number: string;
  /** vatPrefix + number. This is the value to store/compare; it is the source identifier, not a derived one. */
  normalized: string;
  /** ISO 3166 country of the VAT prefix when known (EL -> GR, XI -> GB); "" when the prefix is not a known VAT prefix. */
  isoCountry: string;
  /** True when vatPrefix is a known EU VAT prefix (or XI). "GR" is NOT a VAT prefix; Greek VAT ids use EL. */
  knownVatPrefix: boolean;
  /** Format problems that need human review; the value itself is kept unchanged. */
  warnings: string[];
};

/**
 * Splits a VAT id / DIC into prefix + number. Never derives a DIC from an ICO, never adds a prefix that
 * was not written, never swaps EL/GR. Returns undefined when the input has no two-letter prefix.
 */
export function normalizeDic(input: string | undefined | null): VatIdParts | undefined {
  const raw = String(input ?? "").toUpperCase().replace(/[\s.\-/]/g, "");
  const match = /^([A-Z]{2})([0-9A-Z+*]{2,14})$/.exec(raw);
  if (!match) return undefined;
  const vatPrefix = match[1]!;
  const number = match[2]!;
  const isoCountry = VAT_PREFIX_TO_ISO[vatPrefix] ?? "";
  const warnings: string[] = [];
  if (isoCountry === "") {
    warnings.push(vatPrefix === "GR" ? "GR is not a VAT prefix; Greek VAT ids use EL. Value kept as written; review." : `Unknown VAT prefix ${vatPrefix}; value kept as written`);
  }
  if (vatPrefix === "CZ" && !/^\d{8,10}$/.test(number)) warnings.push("Czech DIC number must have 8-10 digits");
  return { vatPrefix, number, normalized: `${vatPrefix}${number}`, isoCountry, knownVatPrefix: isoCountry !== "", warnings };
}

/**
 * Comparison key used ONLY to detect probable duplicates (e.g. a contact typed as GR123 vs a source EL123).
 * Never store it and never link on it alone.
 */
export function vatIdAliasKey(input: string | undefined | null): string {
  const parts = normalizeDic(input);
  if (!parts) return "";
  return `${parts.vatPrefix === "GR" ? "EL" : parts.vatPrefix}${parts.number}`;
}

// ================================================================= text keys

const LEGAL_FORM_TOKENS = [
  "spol s r o", "s r o", "sro", "a s", "as", "v o s", "vos", "k s", "ks", "z s", "zs", "o p s", "ops", "z u", "s p", "se",
  "druzstvo", "odstepny zavod", "o z", "gmbh", "ag", "ltd", "limited", "inc", "bv", "b v", "sp z o o",
  "spolecnost s rucenim omezenym", "akciova spolecnost"
];

/** Deterministic company-name key: no diacritics, lowercase, punctuation-free, trailing legal form stripped. */
export function companyKey(name: string | undefined | null): string {
  let value = String(name ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  value = value.replace(/&/g, " a ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const token of LEGAL_FORM_TOKENS) {
      if (value !== token && value.endsWith(` ${token}`)) {
        value = value.slice(0, -token.length - 1).trim();
        changed = true;
      }
    }
  }
  return value;
}

export function zipKey(zip: string | number | undefined | null): string {
  return String(zip ?? "").replace(/\s+/g, "").toUpperCase();
}

function textKey(value: string | undefined | null): string {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function icoKey(value: string | undefined | null): string {
  const raw = String(value ?? "").replace(/\s+/g, "");
  return /^\d{1,8}$/.test(raw) ? raw.padStart(8, "0") : raw.toUpperCase();
}

// ================================================================= ARES address mapping

export type AresAddress = {
  kodStatu?: string; nazevStatu?: string; nazevObce?: string; kodObce?: number; nazevMestskehoObvodu?: string;
  nazevCastiObce?: string; nazevUlice?: string; cisloDomovni?: number; cisloOrientacni?: number;
  cisloOrientacniPismeno?: string; typCisloDomovni?: number; psc?: number; pscTxt?: string;
  textovaAdresa?: string; doplnekAdresy?: string;
};

export type PohodaAddressFields = {
  street: string; city: string; zip: string; country: string; sourceText: string;
  /** Fields that exceed POHODA XSD lengths. Never silently truncated. */
  overLength: Array<"street" | "city" | "zip">;
};

/** Maps an ARES seat address to POHODA typ:address street/city/zip/country. */
export function mapAresAddress(sidlo: AresAddress | undefined): PohodaAddressFields | undefined {
  if (!sidlo) return undefined;
  const house = sidlo.cisloDomovni !== undefined
    ? `${sidlo.typCisloDomovni === 2 ? "č.ev. " : ""}${sidlo.cisloDomovni}${sidlo.cisloOrientacni !== undefined ? `/${sidlo.cisloOrientacni}${sidlo.cisloOrientacniPismeno ?? ""}` : ""}`
    : "";
  const streetBase = sidlo.nazevUlice || sidlo.nazevCastiObce || sidlo.nazevObce || "";
  // Foreign seats in ARES often carry only textovaAdresa; structured parts are never invented from it.
  const street = [streetBase, house].filter(Boolean).join(" ").trim();
  const city = sidlo.kodObce === PRAGUE_KOD_OBCE && sidlo.nazevMestskehoObvodu ? sidlo.nazevMestskehoObvodu : (sidlo.nazevObce ?? "");
  const psc = sidlo.psc !== undefined ? String(sidlo.psc).padStart(5, "0") : "";
  const zip = psc !== "" ? `${psc.slice(0, 3)} ${psc.slice(3)}` : (sidlo.pscTxt ?? "");
  const overLength: PohodaAddressFields["overLength"] = [];
  if (street.length > POHODA_ADDRESS_LIMITS.street) overLength.push("street");
  if (city.length > POHODA_ADDRESS_LIMITS.city) overLength.push("city");
  if (zip.length > POHODA_ADDRESS_LIMITS.zip) overLength.push("zip");
  return { street, city, zip, country: sidlo.kodStatu ?? "", sourceText: sidlo.textovaAdresa ?? "", overLength };
}

// ================================================================= registry payloads

export type AresRegistrationStates = Record<string, string | undefined> & {
  stavZdrojeDph?: string; stavZdrojeSkDph?: string; stavZdrojeVr?: string; stavZdrojeRes?: string; stavZdrojeRzp?: string;
};

export type AresSubject = {
  ico: string;
  obchodniJmeno: string;
  sidlo?: AresAddress;
  /** DIC exactly as published by ARES (e.g. "CZ45274649"); undefined when ARES publishes none. */
  dic?: string;
  /** DIC of the VAT group the subject belongs to (skupinové DIČ). */
  dicSkDph?: string;
  pravniForma?: string;
  datumVzniku?: string;
  datumZaniku?: string;
  datumAktualizace?: string;
  seznamRegistraci?: AresRegistrationStates;
};

export type AdisSubjectStatus = {
  /** DIC number without the CZ prefix, as answered by ADIS. */
  dic: string;
  typSubjektu: "PLATCE_DPH" | "IDENTIFIKOVANA_OSOBA" | "SKUPINA_DPH" | "NENALEZEN" | "NESPOLEHLIVA_OSOBA" | (string & {});
  nespolehlivyPlatce: "ANO" | "NE" | "NENALEZEN" | (string & {});
  unreliableSince?: string;
  name: string;
  address: { street: string; part: string; city: string; zip: string; country: string } | undefined;
  /** Published bank accounts (zveřejněné účty), as "prefix-number/bank" or IBAN-like text. */
  accounts: string[];
  generatedOn: string;
};

export function parseAresSubject(raw: unknown): AresSubject {
  const r = (raw ?? {}) as Record<string, any>;
  if (typeof r.ico !== "string" || typeof r.obchodniJmeno !== "string") throw new RegistryError("Unexpected ARES payload", "PARSE");
  const out: AresSubject = { ico: r.ico, obchodniJmeno: r.obchodniJmeno };
  if (r.sidlo && typeof r.sidlo === "object") out.sidlo = r.sidlo as AresAddress;
  for (const key of ["dic", "dicSkDph", "pravniForma", "datumVzniku", "datumZaniku", "datumAktualizace"] as const) {
    if (typeof r[key] === "string" && r[key] !== "") out[key] = r[key];
  }
  if (r.seznamRegistraci && typeof r.seznamRegistraci === "object") out.seznamRegistraci = r.seznamRegistraci as AresRegistrationStates;
  return out;
}

const soapParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === "statusSubjektu" || name === "ucet"
});

export function parseAdisResponse(xml: string): AdisSubjectStatus[] {
  let doc: Record<string, any>;
  try {
    doc = soapParser.parse(xml) as Record<string, any>;
  } catch {
    throw new RegistryError("ADIS response is not XML", "PARSE");
  }
  const body = doc?.Envelope?.Body;
  if (!body) throw new RegistryError("ADIS response has no SOAP body", "PARSE");
  if (body.Fault) throw new RegistryError(`ADIS fault: ${String(body.Fault.faultstring ?? "unknown")}`, "HTTP");
  const response = body.StatusNespolehlivySubjektRozsirenyResponse;
  const status = response?.status;
  const code = String(status?.["@statusCode"] ?? "missing");
  if (code !== "0") {
    // 1 = more than 100 DICs (truncated), 2 = nightly outage 0:00-0:10, 3 = service unavailable.
    throw new RegistryError(`ADIS status ${code}: ${String(status?.["@statusText"] ?? "")}`, code === "2" || code === "3" ? "UNAVAILABLE" : "HTTP");
  }
  const generatedOn = String(status["@odpovedGenerovana"] ?? "");
  return ((response.statusSubjektu ?? []) as Array<Record<string, any>>).map((s) => {
    const adresa = s.adresa as Record<string, unknown> | undefined;
    const accounts = ((s.zverejneneUcty?.ucet ?? []) as Array<Record<string, any>>).map((u) => {
      if (u.standardniUcet) {
        const a = u.standardniUcet as Record<string, string>;
        return `${a["@predcisli"] ? `${a["@predcisli"]}-` : ""}${a["@cislo"] ?? ""}/${a["@kodBanky"] ?? ""}`;
      }
      return String(u.nestandardniUcet?.["@cislo"] ?? "");
    }).filter((a) => a !== "");
    const item: AdisSubjectStatus = {
      dic: String(s["@dic"] ?? ""),
      typSubjektu: String(s["@typSubjektu"] ?? ""),
      nespolehlivyPlatce: String(s["@nespolehlivyPlatce"] ?? ""),
      name: String(s.nazevSubjektu ?? "").trim(),
      address: adresa
        ? {
            street: String(adresa.uliceCislo ?? "").trim(), part: String(adresa.castObce ?? "").trim(),
            city: String(adresa.mesto ?? "").trim(), zip: String(adresa.psc ?? "").trim(), country: String(adresa.stat ?? "").trim()
          }
        : undefined,
      accounts,
      generatedOn
    };
    if (s["@datumZverejneniNespolehlivosti"]) item.unreliableSince = String(s["@datumZverejneniNespolehlivosti"]);
    return item;
  });
}

// ================================================================= VAT evidence

export type VatStatus =
  | "payer"
  | "vat-group-member"
  | "identified-person"
  /** NESPOLEHLIVA_OSOBA: not a VAT payer, but designated unreliable by the tax administrator. */
  | "unreliable-person"
  | "registry-non-payer"
  | "unknown";

export type VatEvidence = {
  /** Never "registry-non-payer" from a missing DIC alone. */
  status: VatStatus;
  unreliablePayer: boolean | undefined;
  /** DIC published by ARES, exactly as published; distinct from VAT-payer status. "" when none. */
  dic: string;
  groupDic: string;
  /** ARES stavZdrojeDph shows a past (ended) VAT registration. */
  formerVatRegistration: boolean;
  /** ARES subject has datumZaniku. */
  ceased: boolean;
  asOf: string;
  reasons: string[];
  /** Registries report only the current state, never the state on a past DUZP. */
  pointInTimeCaveat: true;
};

/**
 * DIC numbers (without CZ) to ask ADIS about for an ARES subject. `published` come from ARES. `probes`
 * are lookup-only candidates (the ICO, which legal entities normally use as their DIC number); a probe
 * hit is evidence of a registration ARES may lag behind on, but a probe value is NEVER stored as a DIC.
 */
export function adisCandidates(subject: AresSubject | undefined): { published: string[]; probes: string[] } {
  const published = new Set<string>();
  for (const value of [subject?.dic, subject?.dicSkDph]) {
    const parts = normalizeDic(value);
    if (parts?.vatPrefix === "CZ" && /^\d{8,10}$/.test(parts.number)) published.add(parts.number);
  }
  const probes = subject && /^\d{8}$/.test(subject.ico) && !published.has(subject.ico) ? [subject.ico] : [];
  return { published: [...published].sort(), probes };
}

/**
 * Combines ARES and ADIS. Only ADIS rows for this subject's candidate numbers are considered.
 * "registry-non-payer" requires: an active (not ceased) ARES subject, ARES stavZdrojeDph and
 * stavZdrojeSkDph not AKTIVNI, no group DIC, and ADIS answering NENALEZEN for every candidate it was
 * asked about (at least one). It is current-state evidence only.
 */
export function classifyVat(ares: AresSubject | undefined, adis: AdisSubjectStatus[] | undefined, checkedAt: string): VatEvidence {
  const reasons: string[] = [];
  const dic = ares?.dic ?? "";
  const groupDic = ares?.dicSkDph ?? "";
  const reg = ares?.seznamRegistraci ?? {};
  const candidates = adisCandidates(ares);
  const relevantNumbers = new Set([...candidates.published, ...candidates.probes]);
  const rows = (adis ?? []).filter((s) => ares === undefined || relevantNumbers.has(s.dic));
  const unreliable = rows.some((s) => s.nespolehlivyPlatce === "ANO" || s.typSubjektu === "NESPOLEHLIVA_OSOBA")
    ? true
    : rows.some((s) => s.nespolehlivyPlatce === "NE") ? false : undefined;
  const dphState = reg.stavZdrojeDph;
  const formerVatRegistration = dphState !== undefined && dphState !== "AKTIVNI" && dphState !== "NEEXISTUJICI";
  const ceased = Boolean(ares?.datumZaniku);
  const base = { unreliablePayer: unreliable, dic, groupDic, formerVatRegistration, ceased, asOf: checkedAt, pointInTimeCaveat: true as const };
  const result = (status: VatStatus): VatEvidence => ({ ...base, status, reasons });

  if (ceased) reasons.push(`ARES datumZaniku ${ares?.datumZaniku}; subject has ceased`);
  if (rows.some((s) => s.typSubjektu === "SKUPINA_DPH") || reg.stavZdrojeSkDph === "AKTIVNI" || groupDic !== "") {
    reasons.push("VAT group membership reported by ADIS/ARES");
    return result("vat-group-member");
  }
  if (rows.some((s) => s.typSubjektu === "PLATCE_DPH")) {
    reasons.push("ADIS typSubjektu PLATCE_DPH");
    return result("payer");
  }
  if (rows.some((s) => s.typSubjektu === "NESPOLEHLIVA_OSOBA")) {
    reasons.push("ADIS typSubjektu NESPOLEHLIVA_OSOBA (unreliable person, not a VAT payer)");
    return result("unreliable-person");
  }
  if (rows.some((s) => s.typSubjektu === "IDENTIFIKOVANA_OSOBA")) {
    reasons.push("ADIS typSubjektu IDENTIFIKOVANA_OSOBA (identified person, not a payer for domestic supplies)");
    return result("identified-person");
  }
  if (rows.some((s) => s.typSubjektu !== "NENALEZEN")) {
    reasons.push(`Unexpected ADIS typSubjektu ${rows.map((s) => s.typSubjektu).join(", ")}`);
    return result("unknown");
  }
  if (dphState === "AKTIVNI") {
    reasons.push("ARES stavZdrojeDph AKTIVNI but ADIS did not confirm a payer; review");
    return result("unknown");
  }
  if (ares === undefined) {
    reasons.push("No ARES subject");
    return result("unknown");
  }
  if (ceased) return result("unknown");
  if (dphState === undefined) {
    reasons.push("ARES does not report stavZdrojeDph");
    return result("unknown");
  }
  const asked = new Set(rows.map((s) => s.dic));
  const missing = [...relevantNumbers].filter((n) => !asked.has(n));
  if (rows.length === 0 || missing.length > 0) {
    reasons.push(rows.length === 0 ? "ADIS not queried" : `ADIS not queried for ${missing.join(", ")}`);
    return result("unknown");
  }
  reasons.push(`ARES stavZdrojeDph=${dphState}; ADIS NENALEZEN for ${rows.map((s) => s.dic).join(", ")}`);
  if (formerVatRegistration) reasons.push("Former VAT registration exists; status on the document DUZP may differ");
  return result("registry-non-payer");
}

export type NonPayerDecision = {
  /**
   * auto: confirmed Czech non-payer, document shows no VAT -> PN treatment may be applied automatically.
   * standard: document charges VAT and registry confirms a VAT subject -> normal VAT treatment.
   * explicit-decision: foreign supplier; the user must choose the treatment.
   * review: anything uncertain or conflicting; never apply PN.
   */
  pn: "auto" | "standard" | "explicit-decision" | "review";
  reasons: string[];
};

/**
 * Decides whether PN (non-payer) treatment may be applied without asking. Auto only when:
 * Czech supplier, documentChargesVat === false (explicitly read from the document), registry-non-payer,
 * no former VAT registration, not unreliable. A document that itself charges VAT is never auto-PN.
 */
export function decideNonPayerTreatment(input: {
  evidence: VatEvidence | undefined;
  /** Supplier country (ISO). "" or undefined counts as unknown. */
  supplierCountry: string | undefined;
  /** true when the source shows VAT amounts/rates, false when it explicitly shows none, undefined when unreadable. */
  documentChargesVat: boolean | undefined;
}): NonPayerDecision {
  const reasons: string[] = [];
  const country = String(input.supplierCountry ?? "").toUpperCase();
  const evidence = input.evidence;
  if (country !== "" && country !== "CZ") {
    reasons.push(`Foreign supplier (${country}); VAT treatment requires an explicit decision`);
    return { pn: "explicit-decision", reasons };
  }
  if (country === "") reasons.push("Supplier country unknown");
  if (input.documentChargesVat === undefined) reasons.push("Document VAT presence could not be read");
  if (!evidence) reasons.push("No registry evidence");
  if (reasons.length > 0) return { pn: "review", reasons };
  const ev = evidence!;
  if (input.documentChargesVat === true) {
    if (ev.status === "payer" || ev.status === "vat-group-member") {
      if (ev.unreliablePayer) return { pn: "review", reasons: ["Supplier is an unreliable VAT payer (ručení za DPH)"] };
      return { pn: "standard", reasons: ["Document charges VAT and registry confirms a VAT subject"] };
    }
    return { pn: "review", reasons: [`Document charges VAT but registry status is ${ev.status}`] };
  }
  if (ev.status !== "registry-non-payer") return { pn: "review", reasons: [`Document shows no VAT but registry status is ${ev.status}`] };
  if (ev.formerVatRegistration) return { pn: "review", reasons: ["Former VAT registration; registry cannot confirm status on the document date"] };
  if (ev.unreliablePayer === true) return { pn: "review", reasons: ["Unreliable flag reported"] };
  return { pn: "auto", reasons: ["Confirmed Czech non-payer (ARES + ADIS, current state) and document shows no VAT"] };
}

// ================================================================= deterministic name+address matching

export type SupplierQuery = { name: string; street?: string; city?: string; zip?: string };
export type MatchTier = "name+zip+house" | "name+zip" | "name+city" | "name" | "none";
export type ScoredCandidate = { ico: string; name: string; address: string; tier: MatchTier; ceased: boolean };
export type MatchResult =
  | { decision: "unique"; ico: string; tier: MatchTier; candidates: ScoredCandidate[] }
  | { decision: "ambiguous" | "none"; reason: string; candidates: ScoredCandidate[] };

const TIER_RANK: Record<MatchTier, number> = { "name+zip+house": 4, "name+zip": 3, "name+city": 2, name: 1, none: 0 };

function houseNumbers(text: string): string[] {
  return [...String(text ?? "").matchAll(/\d+[a-z]?(?:\/\d+[a-z]?)?/gi)].map((m) => m[0].toLowerCase());
}

/**
 * Tiered, explainable matching. A unique decision needs company-key equality AND at least name+zip
 * (name+city when the query has no zip), exactly one active candidate at the best tier, and no ceased
 * subject matching at the same or a better tier. Name-only hits are never accepted.
 */
export function matchSubjects(query: SupplierQuery, subjects: AresSubject[], totalReported = subjects.length): MatchResult {
  const qName = companyKey(query.name);
  const qZip = zipKey(query.zip);
  const qCity = textKey(query.city);
  const qHouses = houseNumbers(query.street ?? "");
  const scored: ScoredCandidate[] = subjects.map((s) => {
    const mapped = mapAresAddress(s.sidlo);
    const nameOk = qName !== "" && companyKey(s.obchodniJmeno) === qName;
    const zipOk = qZip !== "" && zipKey(s.sidlo?.psc !== undefined ? String(s.sidlo.psc).padStart(5, "0") : s.sidlo?.pscTxt) === qZip;
    const cityOk = qCity !== "" && [s.sidlo?.nazevObce, s.sidlo?.nazevMestskehoObvodu, s.sidlo?.nazevCastiObce].some((c) => c && textKey(c) === qCity);
    const candHouses = houseNumbers(mapped?.street ?? "");
    const houseOk = qHouses.length > 0 && qHouses.some((h) => candHouses.includes(h) || candHouses.some((c) => c.split("/").includes(h)));
    const tier: MatchTier = !nameOk ? "none" : zipOk && houseOk ? "name+zip+house" : zipOk ? "name+zip" : cityOk ? "name+city" : "name";
    return { ico: s.ico, name: s.obchodniJmeno, address: mapped?.sourceText || s.sidlo?.textovaAdresa || "", tier, ceased: Boolean(s.datumZaniku) };
  }).sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || Number(a.ceased) - Number(b.ceased) || a.ico.localeCompare(b.ico));

  const top = scored.slice(0, 10);
  if (totalReported > subjects.length) {
    return { decision: "ambiguous", reason: `ARES reported ${totalReported} hits, only ${subjects.length} inspected; refine name/address`, candidates: top };
  }
  const active = scored.filter((c) => !c.ceased && c.tier !== "none");
  if (active.length === 0) return { decision: "none", reason: "No active subject with a matching company name", candidates: top };
  const best = active[0]!;
  const minTier = qZip !== "" ? TIER_RANK["name+zip"] : TIER_RANK["name+city"];
  if (TIER_RANK[best.tier] < minTier) {
    return { decision: "ambiguous", reason: `Best evidence is ${best.tier}; address confirmation required`, candidates: top };
  }
  const sameTier = active.filter((c) => c.tier === best.tier);
  if (sameTier.length > 1) {
    return { decision: "ambiguous", reason: `${sameTier.length} active subjects tie at ${best.tier}`, candidates: top };
  }
  const ceasedRival = scored.find((c) => c.ceased && TIER_RANK[c.tier] >= TIER_RANK[best.tier]);
  if (ceasedRival) {
    return { decision: "ambiguous", reason: `Ceased subject ${ceasedRival.ico} matches at ${ceasedRival.tier}; possible successor, review`, candidates: top };
  }
  return { decision: "unique", ico: best.ico, tier: best.tier, candidates: top };
}

// ================================================================= normalized supplier

/** Registry-normalized supplier ready for contact planning. All strings are untruncated source values. */
export type NormalizedSupplier = {
  source: "ares" | "adis" | "document";
  ico: string;
  /** DIC exactly as published (ARES) or printed (document). "" when none. Never derived from ICO. */
  dic: string;
  company: string;
  street: string;
  city: string;
  zip: string;
  /** ISO country code for typ:country ("CZ"); "" when unknown. */
  country: string;
  vat: VatEvidence | undefined;
  /** ADIS published accounts for the subject's DIC(s), for payment-account cross-checks. */
  publishedAccounts: string[];
  fetchedAt: string;
  warnings: string[];
};

/** Builds a NormalizedSupplier from an ARES subject (+ optional ADIS rows). Pure. */
export function supplierFromAres(subject: AresSubject, adis: AdisSubjectStatus[] | undefined, fetchedAt: string): NormalizedSupplier {
  const address = mapAresAddress(subject.sidlo);
  const warnings: string[] = [];
  let dic = "";
  if (subject.dic) {
    const parts = normalizeDic(subject.dic);
    if (parts) {
      dic = parts.normalized;
      warnings.push(...parts.warnings);
    } else {
      warnings.push(`ARES DIC "${subject.dic}" has no VAT prefix; not used`);
    }
  }
  if (address && address.overLength.length > 0) warnings.push(`Address fields exceed POHODA limits: ${address.overLength.join(", ")}`);
  if (address && address.street === "" && address.city === "") warnings.push("ARES seat has no structured address; only textovaAdresa available");
  if (subject.datumZaniku) warnings.push(`Subject ceased on ${subject.datumZaniku}`);
  if (subject.obchodniJmeno.length > POHODA_ADDRESS_LIMITS.company) warnings.push("Company name exceeds POHODA limit");
  const vat = adis === undefined ? undefined : classifyVat(subject, adis, fetchedAt);
  const candidates = adisCandidates(subject);
  const numbers = new Set([...candidates.published, ...candidates.probes]);
  return {
    source: "ares",
    ico: subject.ico,
    dic,
    company: subject.obchodniJmeno,
    street: address?.street ?? "",
    city: address?.city ?? "",
    zip: address?.zip ?? "",
    country: address?.country ?? "",
    vat,
    publishedAccounts: (adis ?? []).filter((s) => numbers.has(s.dic)).flatMap((s) => s.accounts),
    fetchedAt,
    warnings
  };
}

/** Compares document-printed identity with the registry subject. Mismatches must be reviewed, not overwritten. */
export function compareDocumentWithRegistry(
  document: { ico?: string; dic?: string; name?: string },
  supplier: Pick<NormalizedSupplier, "ico" | "dic" | "company">
): Array<{ field: "ico" | "dic" | "name"; document: string; registry: string }> {
  const out: Array<{ field: "ico" | "dic" | "name"; document: string; registry: string }> = [];
  if (document.ico && icoKey(document.ico) !== icoKey(supplier.ico)) out.push({ field: "ico", document: document.ico, registry: supplier.ico });
  const docDic = normalizeDic(document.dic)?.normalized ?? String(document.dic ?? "").trim();
  if (docDic !== "" && docDic !== supplier.dic) out.push({ field: "dic", document: String(document.dic), registry: supplier.dic });
  if (document.name && companyKey(document.name) !== companyKey(supplier.company)) out.push({ field: "name", document: document.name, registry: supplier.company });
  return out;
}

// ================================================================= contact planning (no writes)

export type ExistingContact = {
  id: number; company: string; ico: string; dic: string; street: string; city: string; zip: string; country: string;
  /** adb:p1 (Dodavatel). undefined when the export did not include the flag. */
  p1: boolean | undefined;
  /** extId values as "exSystemName|ids". */
  extIds: string[];
};

export type FieldDifference = { field: "company" | "dic" | "street" | "city" | "zip" | "country"; pohoda: string; registry: string; pohodaEmpty: boolean };

export type ContactPlan =
  | {
      action: "link";
      partnerId: number;
      matchedBy: "ico" | "dic" | "extId";
      /** present: p1=true; missing: p1=false; unknown: flag not exported. Never changed by the planner. */
      supplierFlag: "present" | "missing" | "unknown";
      /** True unless p1 is known to be set. Caller may intentionally set p1 (without touching other fields). */
      needsSupplierFlag: boolean;
      /** Advisory only; existing contacts are not overwritten by default. */
      differences: FieldDifference[];
    }
  | {
      action: "create";
      /** Fields for create_address / adb:addressbookHeader. p1 marks the contact as a supplier. */
      address: { company: string; ico: string; dic: string; street: string; city: string; zip: string; country: string; p1: true };
      /** Stable key for partnerIdentity/typ:extId links inside the same dataPack. */
      extId: { ids: string; exSystemName: string };
      warnings: string[];
    }
  | { action: "review"; reason: string; contacts: Array<Pick<ExistingContact, "id" | "company" | "ico" | "dic">> };

export function registryExtIdKey(ico: string, dic: string): string {
  const i = normalizeIco(ico);
  if (i.ok) return `ICO:${i.ico}`;
  const d = normalizeDic(dic);
  return d ? `DIC:${d.normalized}` : "";
}

/**
 * Pure planner; never modifies existing contacts.
 * - exactly one contact by ICO (else by DIC, else by registry extId) -> link; differences are advisory.
 * - several contacts, ICO/DIC conflicts, EL/GR alias hits, or a same-name contact without ICO/DIC -> review.
 * - none -> create with p1 and a stable extId.
 */
export function planSupplierContact(input: {
  ico: string; dic: string; company: string; street: string; city: string; zip: string; country: string;
  existing: ExistingContact[]; source: "ares" | "adis" | "document";
}): ContactPlan {
  const icoCheck = normalizeIco(input.ico);
  const rawIco = String(input.ico ?? "").trim();
  if (rawIco !== "" && !icoCheck.ok) return { action: "review", reason: `Source ICO ${rawIco} is invalid (${icoCheck.reason})`, contacts: [] };
  const ico = icoCheck.ok ? icoCheck.ico : "";
  const dicParts = normalizeDic(input.dic);
  if (String(input.dic ?? "").trim() !== "" && !dicParts) return { action: "review", reason: `Source DIC ${input.dic} has no VAT prefix`, contacts: [] };
  const dic = dicParts?.normalized ?? "";
  const extKey = registryExtIdKey(ico, dic);
  const extFull = extKey ? `${REGISTRY_EXT_SYSTEM}|${extKey}` : "";

  const byIco = ico !== "" ? input.existing.filter((c) => icoKey(c.ico) === ico) : [];
  const byDic = dic !== "" ? input.existing.filter((c) => normalizeDic(c.dic)?.normalized === dic) : [];
  const byExt = extFull !== "" ? input.existing.filter((c) => c.extIds.includes(extFull)) : [];
  const ids = (list: ExistingContact[]) => new Set(list.map((c) => c.id));

  for (const [label, list] of [["ICO", byIco], ["DIC", byDic], ["extId", byExt]] as const) {
    if (list.length > 1) return { action: "review", reason: `${list.length} existing contacts share ${label} ${label === "ICO" ? ico : label === "DIC" ? dic : extKey}`, contacts: list.map(pickContact) };
  }
  const union = new Set([...ids(byIco), ...ids(byDic), ...ids(byExt)]);
  if (union.size > 1) {
    return { action: "review", reason: "ICO, DIC and extId point to different existing contacts", contacts: input.existing.filter((c) => union.has(c.id)).map(pickContact) };
  }
  const matched = byIco[0] ?? byDic[0] ?? byExt[0];
  if (matched) {
    const contactDic = normalizeDic(matched.dic)?.normalized ?? String(matched.dic ?? "").trim();
    if (dic !== "" && contactDic !== "" && contactDic !== dic) {
      return { action: "review", reason: `Existing contact ${matched.id} has DIC ${contactDic}, source says ${dic}`, contacts: [pickContact(matched)] };
    }
    const contactIco = icoKey(matched.ico);
    if (ico !== "" && contactIco !== "" && contactIco !== ico) {
      return { action: "review", reason: `Contact ${matched.id} has ICO ${matched.ico}, source says ${ico}`, contacts: [pickContact(matched)] };
    }
    const differences: FieldDifference[] = [];
    const compare = (field: FieldDifference["field"], pohoda: string, registry: string, key: (v: string) => string) => {
      if (registry !== "" && key(pohoda) !== key(registry)) differences.push({ field, pohoda, registry, pohodaEmpty: pohoda.trim() === "" });
    };
    compare("company", matched.company, input.company, companyKey);
    compare("dic", contactDic, dic, (v) => v);
    compare("street", matched.street, input.street, textKey);
    compare("city", matched.city, input.city, textKey);
    compare("zip", matched.zip, input.zip, zipKey);
    compare("country", matched.country, input.country, (v) => v.trim().toUpperCase());
    const supplierFlag = matched.p1 === true ? "present" : matched.p1 === false ? "missing" : "unknown";
    return {
      action: "link", partnerId: matched.id, matchedBy: byIco[0] ? "ico" : byDic[0] ? "dic" : "extId",
      supplierFlag, needsSupplierFlag: supplierFlag !== "present", differences
    };
  }

  // No keyed match: look for probable duplicates before creating.
  const alias = vatIdAliasKey(dic);
  const aliasHits = alias !== "" ? input.existing.filter((c) => c.dic.trim() !== "" && vatIdAliasKey(c.dic) === alias) : [];
  if (aliasHits.length > 0) {
    return { action: "review", reason: `Existing contact DIC differs only by VAT prefix spelling (EL/GR) from ${dic}`, contacts: aliasHits.map(pickContact) };
  }
  const nameKey = companyKey(input.company);
  const sameName = nameKey !== "" ? input.existing.filter((c) => companyKey(c.company) === nameKey) : [];
  if (sameName.length > 0) {
    return { action: "review", reason: `Existing contact(s) with the same company name but no matching ICO/DIC`, contacts: sameName.map(pickContact) };
  }
  if (extKey === "") return { action: "review", reason: "Neither ICO nor DIC available; refusing to create an unkeyed supplier", contacts: [] };

  const warnings: string[] = [...(dicParts?.warnings ?? [])];
  if (input.source === "document") warnings.push("Created from document data without registry confirmation");
  if (dic === "") warnings.push("No DIC on contact; VAT status must come from registry evidence, not from the empty field");
  const tooLong = (Object.keys(POHODA_ADDRESS_LIMITS) as Array<keyof typeof POHODA_ADDRESS_LIMITS>)
    .filter((field) => String(({ company: input.company, ico, dic, street: input.street, city: input.city, zip: input.zip })[field] ?? "").length > POHODA_ADDRESS_LIMITS[field]);
  if (tooLong.length > 0) return { action: "review", reason: `Fields exceed POHODA limits: ${tooLong.join(", ")}`, contacts: [] };
  if (String(input.company ?? "").trim() === "") return { action: "review", reason: "Company name is empty", contacts: [] };
  return {
    action: "create",
    extId: { ids: extKey, exSystemName: REGISTRY_EXT_SYSTEM },
    warnings,
    address: { company: input.company, ico, dic, street: input.street, city: input.city, zip: input.zip, country: input.country, p1: true }
  };
}

function pickContact(c: ExistingContact) {
  return { id: c.id, company: c.company, ico: c.ico, dic: c.dic };
}

// ================================================================= network client

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type RegistryClientOptions = {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Per attempt, including body download. Default 8000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt for timeouts, network errors, 429 and 5xx. Default 2. */
  retries?: number;
  maxResponseBytes?: number;
  maxConcurrent?: number;
  /** Minimum spacing between request starts across all callers. Default 250 ms (<= 240/min). */
  minIntervalMs?: number;
  maxCacheEntries?: number;
  ttl?: { found: number; notFound: number; vat: number };
  userAgent?: string;
};

export type RegistryErrorCode = "INPUT" | "NOT_FOUND" | "TOO_MANY" | "HTTP" | "TIMEOUT" | "NETWORK" | "PARSE" | "HOST" | "UNAVAILABLE";

export class RegistryError extends Error {
  public constructor(message: string, public readonly code: RegistryErrorCode, public readonly status = 0, public readonly retryAfterMs?: number) {
    super(message);
    this.name = "RegistryError";
  }
}

type CacheEntry<T> = { storedAt: number; ttlMs: number; value: T };

export type Fresh<T> = { value: T; fetchedAt: string; fromCache: boolean; ageSeconds: number };

export class CzechRegistryClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxResponseBytes: number;
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private readonly maxCacheEntries: number;
  private readonly ttl: { found: number; notFound: number; vat: number };
  private readonly userAgent: string;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<CacheEntry<unknown>>>();
  private active = 0;
  private nextStart = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(options: RegistryClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.retries = options.retries ?? 2;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.maxCacheEntries = options.maxCacheEntries ?? 2_000;
    this.ttl = options.ttl ?? { found: 24 * 3600_000, notFound: 3600_000, vat: 6 * 3600_000 };
    this.userAgent = options.userAgent ?? "pohoda-mcp-node registry client";
  }

  /** ARES subject by ICO; null when ARES has no such subject. maxAgeSeconds=0 forces a refetch. */
  public async getByIco(icoInput: string, maxAgeSeconds?: number): Promise<Fresh<AresSubject | null>> {
    const check = normalizeIco(icoInput);
    if (!check.ok) throw new RegistryError(`Invalid ICO (${check.reason}); not sent to ARES`, "INPUT");
    return this.cached(`ares:ico:${check.ico}`, maxAgeSeconds, async () => {
      try {
        const body = await this.request(`${ARES_BASE}/ekonomicke-subjekty/${check.ico}`, { method: "GET", headers: { Accept: "application/json" } });
        return { value: parseAresSubject(parseJson(body)), ttlMs: this.ttl.found };
      } catch (error) {
        if (error instanceof RegistryError && error.code === "NOT_FOUND") return { value: null, ttlMs: this.ttl.notFound };
        throw error;
      }
    });
  }

  /** ARES name (+ optional seat text) search, first 50 hits. Use matchSubjects() on the result. */
  public async search(query: SupplierQuery, maxAgeSeconds?: number): Promise<Fresh<{ total: number; subjects: AresSubject[] }>> {
    const name = String(query.name ?? "").trim();
    if (companyKey(name).length < 3) throw new RegistryError("Company name too short for ARES search", "INPUT");
    const body: Record<string, unknown> = { obchodniJmeno: name.slice(0, 2000), start: 0, pocet: 50 };
    const addressText = [query.street, query.city].map((v) => String(v ?? "").trim()).filter((v) => v !== "").join(", ");
    if (addressText !== "") body.sidlo = { textovaAdresa: addressText.slice(0, 1500) };
    return this.cached(`ares:search:${JSON.stringify(body)}`, maxAgeSeconds, async () => {
      try {
        const text = await this.request(`${ARES_BASE}/ekonomicke-subjekty/vyhledat`, {
          method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        const json = parseJson(text) as { pocetCelkem?: number; ekonomickeSubjekty?: unknown[] };
        const subjects = (json.ekonomickeSubjekty ?? []).map(parseAresSubject);
        return { value: { total: Number(json.pocetCelkem ?? subjects.length), subjects }, ttlMs: this.ttl.found };
      } catch (error) {
        if (error instanceof RegistryError && error.code === "NOT_FOUND") return { value: { total: 0, subjects: [] }, ttlMs: this.ttl.notFound };
        throw error;
      }
    });
  }

  /**
   * ADIS current VAT subject type + unreliable flag + published accounts.
   * Accepts Czech DICs with CZ prefix or bare 8-10 digit numbers; other prefixes are rejected, never rewritten.
   */
  public async vatStatus(dics: string[], maxAgeSeconds?: number): Promise<Fresh<AdisSubjectStatus[]>> {
    const numbers = [...new Set(dics.map((d) => {
      const value = String(d ?? "").trim();
      if (/^\d{8,10}$/.test(value)) return value;
      const parts = normalizeDic(value);
      return parts?.vatPrefix === "CZ" && /^\d{8,10}$/.test(parts.number) ? parts.number : "";
    }).filter((n) => n !== ""))].sort();
    if (numbers.length === 0) throw new RegistryError("No valid Czech DIC to check", "INPUT");
    if (numbers.length > 100) throw new RegistryError("ADIS accepts at most 100 DICs per request", "INPUT");
    return this.cached(`adis:${numbers.join(",")}`, maxAgeSeconds, async () => {
      const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:roz="http://adis.mfcr.cz/rozhraniCRPDPH/"><soapenv:Body><roz:StatusNespolehlivySubjektRozsirenyV2Request>${numbers.map((n) => `<roz:dic>${n}</roz:dic>`).join("")}</roz:StatusNespolehlivySubjektRozsirenyV2Request></soapenv:Body></soapenv:Envelope>`;
      const text = await this.request(ADIS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${ADIS_SOAP_ACTION}"` },
        body: envelope
      });
      return { value: parseAdisResponse(text), ttlMs: this.ttl.vat };
    });
  }

  /**
   * ICO -> ARES subject -> ADIS (published DICs + ICO probe) -> NormalizedSupplier.
   * ADIS failure does not fail the lookup: vat becomes "unknown" with the reason.
   */
  public async lookupSupplierByIco(icoInput: string, maxAgeSeconds?: number): Promise<
    | { found: true; supplier: NormalizedSupplier; subject: AresSubject }
    | { found: false; ico: string; fetchedAt: string }
  > {
    const ares = await this.getByIco(icoInput, maxAgeSeconds);
    if (!ares.value) {
      const check = normalizeIco(icoInput);
      return { found: false, ico: check.ok ? check.ico : String(icoInput), fetchedAt: ares.fetchedAt };
    }
    const subject = ares.value;
    const candidates = adisCandidates(subject);
    const numbers = [...candidates.published, ...candidates.probes];
    let rows: AdisSubjectStatus[] | undefined;
    let adisError = "";
    if (numbers.length > 0) {
      try {
        rows = (await this.vatStatus(numbers, maxAgeSeconds)).value;
      } catch (error) {
        adisError = error instanceof Error ? error.message : String(error);
      }
    }
    const supplier = supplierFromAres(subject, rows ?? [], ares.fetchedAt);
    if (adisError !== "" && supplier.vat) {
      supplier.vat = { ...supplier.vat, status: supplier.vat.status === "registry-non-payer" ? "unknown" : supplier.vat.status, reasons: [...supplier.vat.reasons, `ADIS unavailable: ${adisError}`] };
      supplier.warnings.push(`ADIS unavailable: ${adisError}`);
    }
    return { found: true, supplier, subject };
  }

  private async cached<T>(key: string, maxAgeSeconds: number | undefined, load: () => Promise<{ value: T; ttlMs: number }>): Promise<Fresh<T>> {
    const hit = this.cache.get(key) as CacheEntry<T> | undefined;
    if (hit) {
      const age = this.now() - hit.storedAt;
      const limit = maxAgeSeconds !== undefined ? Math.min(Math.max(0, maxAgeSeconds) * 1000, hit.ttlMs) : hit.ttlMs;
      if (age < limit) return { value: hit.value, fetchedAt: new Date(hit.storedAt).toISOString(), fromCache: true, ageSeconds: Math.floor(age / 1000) };
    }
    let pending = this.inflight.get(key) as Promise<CacheEntry<T>> | undefined;
    if (!pending) {
      pending = load().then((loaded) => {
        const entry: CacheEntry<T> = { storedAt: this.now(), ttlMs: loaded.ttlMs, value: loaded.value };
        this.cache.delete(key);
        this.cache.set(key, entry);
        while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value as string);
        return entry;
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending as Promise<CacheEntry<unknown>>);
    }
    const entry = await pending;
    return { value: entry.value, fetchedAt: new Date(entry.storedAt).toISOString(), fromCache: false, ageSeconds: 0 };
  }

  private async request(url: string, init: RequestInit): Promise<string> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) throw new RegistryError(`Host not allowed: ${parsed.hostname}`, "HOST");
    let attempt = 0;
    for (;;) {
      try {
        return await this.withSlot(() => this.once(url, init));
      } catch (error) {
        const retryable = error instanceof RegistryError && (error.code === "TIMEOUT" || error.code === "NETWORK"
          || (error.code === "HTTP" && (error.status === 429 || error.status >= 500)));
        if (!retryable || attempt >= this.retries) throw error;
        attempt++;
        const backoff = Math.min(4_000, 500 * 2 ** (attempt - 1)) + Math.floor(this.random() * 200);
        await this.sleep(Math.min(30_000, Math.max(backoff, error.retryAfterMs ?? 0)));
      }
    }
  }

  private async once(url: string, init: RequestInit): Promise<string> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), "User-Agent": this.userAgent }, redirect: "error", signal });
    } catch (error) {
      throw toTransportError(error);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > this.maxResponseBytes) throw new RegistryError("Registry response too large", "PARSE", response.status);
    let text: string;
    try {
      text = await readCapped(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      throw toTransportError(error);
    }
    if (response.ok) return text;
    let code = "";
    let subKod = "";
    try {
      const err = JSON.parse(text) as { kod?: string; subKod?: string };
      code = err.kod ?? "";
      subKod = err.subKod ?? "";
    } catch { /* non-JSON error body */ }
    if (response.status === 404 || code === "NENALEZENO") throw new RegistryError("Subject not found", "NOT_FOUND", 404);
    if (subKod === "VYSTUP_PRILIS_MNOHO_VYSLEDKU") throw new RegistryError("ARES search exceeds the 1000-result window; refine name/address", "TOO_MANY", response.status);
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now());
    throw new RegistryError(`Registry HTTP ${response.status}${subKod ? ` ${subKod}` : ""}`, response.status === 400 ? "INPUT" : "HTTP", response.status, retryAfter);
  }

  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    while (this.active >= this.maxConcurrent) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      // Reserve the start time synchronously so concurrent holders are spaced, not started together.
      const now = this.now();
      const start = Math.max(now, this.nextStart);
      this.nextStart = start + this.minIntervalMs;
      if (start > now) await this.sleep(start - now);
      return await run();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RegistryError("Registry response is not JSON", "PARSE");
  }
}

function toTransportError(error: unknown): RegistryError {
  const name = (error as { name?: string })?.name;
  return new RegistryError(`Registry request failed: ${name ?? "error"}`, name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK");
}

function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryError("Registry response too large", "PARSE", response.status);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}
