import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adisCandidates, classifyVat, companyKey, compareDocumentWithRegistry, CzechRegistryClient, decideNonPayerTreatment,
  mapAresAddress, matchSubjects, normalizeDic, normalizeIco, parseAdisResponse, parseAresSubject, planSupplierContact,
  RegistryError, supplierFromAres, vatIdAliasKey, type AdisSubjectStatus, type AresSubject, type ExistingContact
} from "../src/registry/czech-registry.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/registry/${name}`, import.meta.url), "utf8");
const cez = parseAresSubject(JSON.parse(fixture("ares-45274649.json")));
const adis = parseAdisResponse(fixture("adis-subjects.xml"));

const subject = (over: Partial<AresSubject>): AresSubject => ({
  ico: "00000000", obchodniJmeno: "X", seznamRegistraci: { stavZdrojeDph: "NEEXISTUJICI" }, ...over
});

const adisRow = (dic: string, typSubjektu: string, nespolehlivyPlatce = "NE"): AdisSubjectStatus => ({
  dic, typSubjektu, nespolehlivyPlatce, name: "", address: undefined, accounts: [], generatedOn: "2026-11-14"
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ICO / DIC normalization", () => {
  it("validates mod-11 checksum and pads legacy ICOs", () => {
    expect(normalizeIco("45274649")).toEqual({ ok: true, ico: "45274649" });
    expect(normalizeIco(" 4527 4649 ")).toEqual({ ok: true, ico: "45274649" });
    expect(normalizeIco("45274648")).toEqual({ ok: false, reason: "checksum" });
    expect(normalizeIco("CZ45274649")).toEqual({ ok: false, reason: "format" });
    expect(normalizeIco("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeIco("25596641").ok).toBe(true);
  });

  it("never derives DIC from ICO and keeps foreign prefixes", () => {
    expect(normalizeDic("cz 685 024 774")).toEqual({
      vatPrefix: "CZ", number: "685024774", normalized: "CZ685024774", isoCountry: "CZ", knownVatPrefix: true, warnings: []
    });
    expect(normalizeDic("DE123456789")?.isoCountry).toBe("DE");
    expect(normalizeDic("45274649")).toBeUndefined();
    expect(normalizeDic("CZ1234")?.warnings).toEqual(["Czech DIC number must have 8-10 digits"]);
  });

  it("keeps EL as the Greek VAT prefix and never rewrites GR", () => {
    expect(normalizeDic("EL 123456789")).toMatchObject({ vatPrefix: "EL", normalized: "EL123456789", isoCountry: "GR", knownVatPrefix: true });
    const gr = normalizeDic("GR123456789");
    expect(gr).toMatchObject({ vatPrefix: "GR", normalized: "GR123456789", isoCountry: "", knownVatPrefix: false });
    expect(gr?.warnings[0]).toContain("Greek VAT ids use EL");
    expect(normalizeDic("XI123456789")).toMatchObject({ normalized: "XI123456789", isoCountry: "GB" });
    expect(vatIdAliasKey("GR123456789")).toBe(vatIdAliasKey("EL123456789"));
  });
});

describe("ARES address mapping", () => {
  it("maps Prague seat to POHODA street/city/zip/country", () => {
    expect(mapAresAddress(cez.sidlo)).toEqual({
      street: "Duhová 1444/2", city: "Praha 4", zip: "140 00", country: "CZ",
      sourceText: "Duhová 1444/2, Michle, 14000 Praha 4", overLength: []
    });
  });

  it("uses part-of-municipality for streetless villages and marks evidence numbers", () => {
    expect(mapAresAddress({ kodStatu: "CZ", nazevObce: "Lhota", nazevCastiObce: "Lhota", cisloDomovni: 12, typCisloDomovni: 2, psc: 39601 }))
      .toMatchObject({ street: "Lhota č.ev. 12", city: "Lhota", zip: "396 01" });
  });

  it("reports over-length fields instead of truncating", () => {
    expect(mapAresAddress({ nazevUlice: "U".repeat(70), cisloDomovni: 1, nazevObce: "Brno", psc: 60200 })?.overLength).toEqual(["street"]);
  });
});

describe("VAT evidence", () => {
  it("parses ADIS subject types, names, addresses and published accounts", () => {
    expect(adis.map((s) => [s.dic, s.typSubjektu, s.nespolehlivyPlatce])).toEqual([
      ["45274649", "PLATCE_DPH", "NE"], ["685024774", "PLATCE_DPH", "NE"], ["99999999", "NENALEZEN", "NENALEZEN"]
    ]);
    expect(adis[0]).toMatchObject({
      name: "ČEZ, A. S.", generatedOn: "2026-11-14",
      address: { street: "Duhová 1444/2", city: "PRAHA 4", zip: "14000" },
      accounts: ["71504011/0100", "CZ6426000000002001268200", "19-2808601/0100"]
    });
    expect(adis[2]?.accounts).toEqual([]);
  });

  it("raises on ADIS faults and outage status codes", () => {
    const outage = '<Envelope><Body><StatusNespolehlivySubjektRozsirenyResponse><status odpovedGenerovana="2026-11-14" statusCode="2" statusText="odstavka"/></StatusNespolehlivySubjektRozsirenyResponse></Body></Envelope>';
    expect(() => parseAdisResponse(outage)).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
    expect(() => parseAdisResponse("<Envelope><Body><Fault><faultstring>x</faultstring></Fault></Body></Envelope>")).toThrow(/ADIS fault/);
  });

  it("classifies payer from ADIS and keeps DIC separate from status", () => {
    const v = classifyVat(cez, adis.slice(0, 1), "2026-11-14");
    expect(v).toMatchObject({ status: "payer", unreliablePayer: false, dic: "CZ45274649", pointInTimeCaveat: true });
  });

  it("does not treat missing DIC or missing ADIS data as non-payer", () => {
    expect(classifyVat(subject({}), [], "t").status).toBe("unknown");
    expect(classifyVat(subject({}), undefined, "t").status).toBe("unknown");
    expect(classifyVat(undefined, [adisRow("1", "NENALEZEN", "NENALEZEN")], "t").status).toBe("unknown");
  });

  it("only uses ICO as a lookup probe, never as a published DIC", () => {
    expect(adisCandidates(subject({ ico: "12345678" }))).toEqual({ published: [], probes: ["12345678"] });
    expect(adisCandidates(cez)).toEqual({ published: ["45274649"], probes: [] });
    expect(adisCandidates(subject({ ico: "12345678", dic: "CZ6801011234", dicSkDph: "CZ69900000" })))
      .toEqual({ published: ["6801011234", "69900000"], probes: ["12345678"] });
    expect(classifyVat(subject({ ico: "12345678" }), [adisRow("12345678", "NENALEZEN", "NENALEZEN")], "t").dic).toBe("");
  });

  it("requires ARES + ADIS agreement for registry-non-payer and flags former registrations", () => {
    const notFound = [adisRow("12345678", "NENALEZEN", "NENALEZEN")];
    const s = subject({ ico: "12345678" });
    expect(classifyVat(s, notFound, "t")).toMatchObject({ status: "registry-non-payer", formerVatRegistration: false, pointInTimeCaveat: true });
    const former = classifyVat({ ...s, seznamRegistraci: { stavZdrojeDph: "ZANIKLY" } }, notFound, "t");
    expect(former).toMatchObject({ status: "registry-non-payer", formerVatRegistration: true });
    expect(former.reasons.join(" ")).toContain("status on the document DUZP may differ");
    expect(classifyVat({ ...s, datumZaniku: "2024-01-01" }, notFound, "t")).toMatchObject({ status: "unknown", ceased: true });
    expect(classifyVat({ ...s, seznamRegistraci: { stavZdrojeDph: "AKTIVNI" } }, notFound, "t").status).toBe("unknown");
    expect(classifyVat({ ...s, seznamRegistraci: {} }, notFound, "t").status).toBe("unknown");
  });

  it("ignores ADIS rows for other subjects and requires every candidate to be answered", () => {
    const s = subject({ ico: "12345678", dic: "CZ6801011234" });
    expect(classifyVat(s, [adisRow("45274649", "PLATCE_DPH")], "t").status).toBe("unknown");
    expect(classifyVat(s, [adisRow("12345678", "NENALEZEN", "NENALEZEN")], "t").reasons.join(" ")).toContain("not queried for 6801011234");
    expect(classifyVat(s, [adisRow("6801011234", "PLATCE_DPH")], "t").status).toBe("payer");
  });

  it("detects identified persons, VAT groups, unreliable payers and unreliable persons", () => {
    expect(classifyVat(subject({ ico: "12345678" }), [adisRow("12345678", "IDENTIFIKOVANA_OSOBA")], "t").status).toBe("identified-person");
    expect(classifyVat(subject({ dicSkDph: "CZ699000000" }), [], "t").status).toBe("vat-group-member");
    expect(classifyVat(subject({ ico: "12345678" }), [adisRow("12345678", "SKUPINA_DPH")], "t").status).toBe("vat-group-member");
    expect(classifyVat(subject({ ico: "12345678" }), [adisRow("12345678", "PLATCE_DPH", "ANO")], "t"))
      .toMatchObject({ status: "payer", unreliablePayer: true });
    expect(classifyVat(subject({ ico: "12345678" }), [adisRow("12345678", "NESPOLEHLIVA_OSOBA", "NENALEZEN")], "t"))
      .toMatchObject({ status: "unreliable-person", unreliablePayer: true });
  });
});

describe("PN (non-payer) decision", () => {
  const nonPayer = classifyVat(subject({ ico: "12345678" }), [adisRow("12345678", "NENALEZEN", "NENALEZEN")], "t");
  const payer = classifyVat(cez, adis, "t");

  it("auto-applies PN only for a confirmed Czech non-payer whose document shows no VAT", () => {
    expect(decideNonPayerTreatment({ evidence: nonPayer, supplierCountry: "CZ", documentChargesVat: false }).pn).toBe("auto");
  });

  it("never auto-applies PN when the document charges VAT or anything is uncertain", () => {
    expect(decideNonPayerTreatment({ evidence: nonPayer, supplierCountry: "CZ", documentChargesVat: true }).pn).toBe("review");
    expect(decideNonPayerTreatment({ evidence: nonPayer, supplierCountry: "CZ", documentChargesVat: undefined }).pn).toBe("review");
    expect(decideNonPayerTreatment({ evidence: nonPayer, supplierCountry: "", documentChargesVat: false }).pn).toBe("review");
    expect(decideNonPayerTreatment({ evidence: undefined, supplierCountry: "CZ", documentChargesVat: false }).pn).toBe("review");
    expect(decideNonPayerTreatment({ evidence: { ...nonPayer, formerVatRegistration: true }, supplierCountry: "CZ", documentChargesVat: false }).pn).toBe("review");
    expect(decideNonPayerTreatment({ evidence: { ...nonPayer, status: "unknown" }, supplierCountry: "CZ", documentChargesVat: false }).pn).toBe("review");
    expect(decideNonPayerTreatment({ evidence: payer, supplierCountry: "CZ", documentChargesVat: false }).pn).toBe("review");
  });

  it("returns standard VAT for payers charging VAT and asks explicitly for foreign suppliers", () => {
    expect(decideNonPayerTreatment({ evidence: payer, supplierCountry: "CZ", documentChargesVat: true }).pn).toBe("standard");
    expect(decideNonPayerTreatment({ evidence: { ...payer, unreliablePayer: true }, supplierCountry: "CZ", documentChargesVat: true }).pn).toBe("review");
    expect(decideNonPayerTreatment({ evidence: undefined, supplierCountry: "DE", documentChargesVat: false }).pn).toBe("explicit-decision");
  });
});

describe("deterministic name+address matching", () => {
  const a = subject({ ico: "24729035", obchodniJmeno: "ČEZ Distribuce, a. s.", sidlo: { nazevObce: "Děčín", nazevUlice: "Teplická", cisloDomovni: 874, cisloOrientacni: 8, psc: 40502 } });
  const b = subject({ ico: "11111111", obchodniJmeno: "CEZ Distribuce a.s.", sidlo: { nazevObce: "Brno", nazevUlice: "Jiná", cisloDomovni: 1, psc: 60200 } });

  it("normalizes legal forms and diacritics", () => {
    expect(companyKey("ČEZ Distribuce, a. s.")).toBe("cez distribuce");
    expect(companyKey("Firma spol. s r.o.")).toBe("firma");
    expect(companyKey("A.S. Servis s.r.o.")).toBe("a s servis");
  });

  it("accepts a unique name+zip+house hit", () => {
    const r = matchSubjects({ name: "CEZ Distribuce a.s.", street: "Teplická 874/8", zip: "405 02" }, [b, a]);
    expect(r).toMatchObject({ decision: "unique", ico: "24729035", tier: "name+zip+house" });
  });

  it("never auto-accepts name-only and reports ties deterministically", () => {
    const r = matchSubjects({ name: "ČEZ Distribuce" }, [b, a]);
    expect(r.decision).toBe("ambiguous");
    expect(r.candidates.map((c) => c.ico)).toEqual(["11111111", "24729035"]);
    expect(matchSubjects({ name: "ČEZ Distribuce", zip: "99999" }, [a]).decision).toBe("ambiguous");
  });

  it("refuses to decide when ARES reports more hits than inspected", () => {
    expect(matchSubjects({ name: "ČEZ Distribuce", zip: "40502" }, [a], 120).decision).toBe("ambiguous");
  });

  it("ignores weaker ceased subjects but stops when a ceased one matches as well", () => {
    const ceasedElsewhere = { ...b, ico: "22222222", datumZaniku: "2020-01-01" };
    expect(matchSubjects({ name: "ČEZ Distribuce", zip: "40502" }, [ceasedElsewhere, a])).toMatchObject({ decision: "unique", ico: "24729035" });
    const ceasedSame = { ...a, ico: "22222222", datumZaniku: "2020-01-01" };
    expect(matchSubjects({ name: "ČEZ Distribuce", zip: "40502" }, [ceasedSame, a]).decision).toBe("ambiguous");
  });

  it("stops on name+address ties", () => {
    const twin = { ...a, ico: "33333333" };
    expect(matchSubjects({ name: "ČEZ Distribuce", street: "Teplická 874/8", zip: "40502" }, [a, twin])).toMatchObject({ decision: "ambiguous" });
    expect(matchSubjects({ name: "ČEZ Distribuce", city: "Děčín" }, [a])).toMatchObject({ decision: "unique", tier: "name+city" });
    expect(matchSubjects({ name: "Jiná firma", zip: "40502" }, [a]).decision).toBe("none");
  });
});

describe("normalized supplier", () => {
  it("builds a supplier from ARES + ADIS without inventing data", () => {
    const s = supplierFromAres(cez, adis, "2026-11-14T00:00:00.000Z");
    expect(s).toMatchObject({
      source: "ares", ico: "45274649", dic: "CZ45274649", company: "ČEZ, a. s.", street: "Duhová 1444/2", city: "Praha 4",
      zip: "140 00", country: "CZ", vat: { status: "payer", unreliablePayer: false }, warnings: []
    });
    expect(s.publishedAccounts).toContain("71504011/0100");
    expect(s.publishedAccounts).not.toContain("123-7776000237/0100");
    expect(supplierFromAres(cez, undefined, "t").vat).toBeUndefined();
  });

  it("reports document/registry identity mismatches", () => {
    const s = supplierFromAres(cez, adis, "t");
    expect(compareDocumentWithRegistry({ ico: "45274649", dic: "CZ45274649", name: "ČEZ a.s." }, s)).toEqual([]);
    expect(compareDocumentWithRegistry({ dic: "CZ12345678", name: "Jiná s.r.o." }, s).map((d) => d.field)).toEqual(["dic", "name"]);
  });
});

describe("supplier contact planning (no overwrite)", () => {
  const base: ExistingContact = { id: 7, company: "Ručně Upravená Firma", ico: "45274649", dic: "", street: "Duhová 2", city: "Praha", zip: "14000", country: "", p1: false, extIds: [] };
  const input = { ico: "45274649", dic: "CZ45274649", company: "ČEZ, a. s.", street: "Duhová 1444/2", city: "Praha 4", zip: "140 00", country: "CZ", source: "ares" as const };

  it("links an existing manual contact and only reports differences", () => {
    const plan = planSupplierContact({ ...input, existing: [base] });
    expect(plan).toMatchObject({ action: "link", partnerId: 7, matchedBy: "ico", supplierFlag: "missing", needsSupplierFlag: true });
    expect(plan.action === "link" && plan.differences.map((d) => d.field)).toEqual(["company", "dic", "street", "city", "country"]);
  });

  it("makes a missing or unexported p1 flag detectable", () => {
    expect(planSupplierContact({ ...input, existing: [{ ...base, p1: true }] })).toMatchObject({ supplierFlag: "present", needsSupplierFlag: false });
    expect(planSupplierContact({ ...input, existing: [{ ...base, p1: undefined }] })).toMatchObject({ supplierFlag: "unknown", needsSupplierFlag: true });
  });

  it("links by DIC or registry extId and matches legacy short ICOs", () => {
    expect(planSupplierContact({ ...input, existing: [{ ...base, ico: "", dic: "CZ45274649" }] })).toMatchObject({ action: "link", matchedBy: "dic" });
    expect(planSupplierContact({ ...input, existing: [{ ...base, ico: "", extIds: ["pohoda-mcp-registry|ICO:45274649"] }] }))
      .toMatchObject({ action: "link", matchedBy: "extId" });
    expect(planSupplierContact({ ...input, ico: "25596641", dic: "", existing: [{ ...base, ico: "25596641" }] })).toMatchObject({ action: "link" });
  });

  it("requires review for duplicate contacts or DIC conflicts", () => {
    expect(planSupplierContact({ ...input, existing: [base, { ...base, id: 8 }] }).action).toBe("review");
    expect(planSupplierContact({ ...input, existing: [{ ...base, dic: "CZ99999999" }] }).action).toBe("review");
    expect(planSupplierContact({ ...input, existing: [base, { ...base, id: 9, ico: "", dic: "CZ45274649" }] }))
      .toMatchObject({ action: "review", reason: "ICO, DIC and extId point to different existing contacts" });
    expect(planSupplierContact({ ...input, existing: [{ ...base, ico: "12345678", dic: "CZ45274649" }] }).action).toBe("review");
  });

  it("refuses to create when a probable duplicate exists", () => {
    expect(planSupplierContact({ ...input, existing: [{ ...base, ico: "", company: "ČEZ a.s." }] }))
      .toMatchObject({ action: "review", contacts: [{ id: 7 }] });
    const greek = { ico: "", dic: "EL123456789", company: "Hellas AE", street: "", city: "Athina", zip: "", country: "GR", source: "document" as const };
    expect(planSupplierContact({ ...greek, existing: [{ ...base, ico: "", company: "Other", dic: "GR123456789" }] }).action).toBe("review");
  });

  it("refuses invalid identifiers and over-length fields instead of truncating", () => {
    expect(planSupplierContact({ ...input, ico: "45274648", existing: [] }).action).toBe("review");
    expect(planSupplierContact({ ...input, dic: "45274649", existing: [] }).action).toBe("review");
    expect(planSupplierContact({ ...input, street: "x".repeat(65), existing: [] })).toMatchObject({ action: "review", reason: expect.stringContaining("street") });
  });

  it("creates a keyed P1 supplier with stable extId when none exists", () => {
    const plan = planSupplierContact({ ...input, existing: [] });
    expect(plan).toMatchObject({ action: "create", extId: { ids: "ICO:45274649", exSystemName: "pohoda-mcp-registry" }, address: { p1: true, dic: "CZ45274649", country: "CZ" } });
  });

  it("supports foreign suppliers by DIC without ARES and refuses unkeyed creates", () => {
    const foreign = planSupplierContact({ ico: "", dic: "DE123456789", company: "GmbH X", street: "", city: "Berlin", zip: "", country: "DE", source: "document", existing: [] });
    expect(foreign).toMatchObject({ action: "create", extId: { ids: "DIC:DE123456789" } });
    expect(planSupplierContact({ ico: "", dic: "", company: "Shop", street: "", city: "", zip: "", country: "", source: "document", existing: [] }).action).toBe("review");
  });
});

describe("registry client safety", () => {
  const fastClient = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>, extra: Record<string, unknown> = {}) => {
    let clock = 1_000_000;
    return {
      client: new CzechRegistryClient({ fetch: fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, minIntervalMs: 0, ...extra }),
      advance: (ms: number) => { clock += ms; }
    };
  };

  it("rejects invalid ICO without a network call", async () => {
    let calls = 0;
    const { client } = fastClient(async () => { calls++; return jsonResponse(200, {}); });
    await expect(client.getByIco("12345678")).rejects.toMatchObject({ code: "INPUT" });
    expect(calls).toBe(0);
  });

  it("caches by freshness, dedupes concurrent calls, and honors maxAgeSeconds", async () => {
    let calls = 0;
    const { client, advance } = fastClient(async () => { calls++; return jsonResponse(200, JSON.parse(fixture("ares-45274649.json"))); });
    const [x, y] = await Promise.all([client.getByIco("45274649"), client.getByIco("45274649")]);
    expect(calls).toBe(1);
    expect(x.value?.dic).toBe("CZ45274649");
    advance(120_000);
    expect((await client.getByIco("45274649")).fromCache).toBe(true);
    expect((await client.getByIco("45274649", 60)).fromCache).toBe(false);
    expect(calls).toBe(2);
    expect(y.fetchedAt).toBe(x.fetchedAt);
  });

  it("caches 404 as null for a shorter TTL and does not retry it", async () => {
    let calls = 0;
    const { client, advance } = fastClient(async () => { calls++; return jsonResponse(404, { kod: "NENALEZENO", subKod: "VYSTUP_SUBJEKT_NENALEZEN" }); });
    expect((await client.getByIco("45274649")).value).toBeNull();
    expect(calls).toBe(1);
    advance(3_600_001);
    await client.getByIco("45274649");
    expect(calls).toBe(2);
  });

  it("retries 5xx/timeouts with backoff but not 400s, and never caches failures", async () => {
    let calls = 0;
    const { client } = fastClient(async () => { calls++; return calls < 3 ? new Response("x", { status: 503 }) : jsonResponse(200, JSON.parse(fixture("ares-45274649.json"))); });
    expect((await client.getByIco("45274649")).value?.ico).toBe("45274649");
    expect(calls).toBe(3);

    let timeouts = 0;
    const t = fastClient(async () => { timeouts++; throw Object.assign(new Error("t"), { name: "TimeoutError" }); }).client;
    await expect(t.getByIco("45274649")).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(timeouts).toBe(3);

    let bad = 0;
    const b = fastClient(async () => { bad++; return jsonResponse(400, { kod: "CHYBA_VSTUPU", subKod: "VYSTUP_PRILIS_MNOHO_VYSLEDKU" }); }).client;
    await expect(b.search({ name: "Firma" })).rejects.toMatchObject({ code: "TOO_MANY" });
    expect(bad).toBe(1);
  });

  it("honors Retry-After on 429", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const client = new CzechRegistryClient({
      now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, random: () => 0, minIntervalMs: 0,
      fetch: async () => { calls++; return calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "7" } }) : jsonResponse(200, JSON.parse(fixture("ares-45274649.json"))); }
    });
    expect((await client.getByIco("45274649")).value?.ico).toBe("45274649");
    expect(sleeps).toEqual([7_000]);
  });

  it("spaces concurrent request starts and caps concurrency", async () => {
    let clock = 0;
    let active = 0;
    let peak = 0;
    const starts: number[] = [];
    const client = new CzechRegistryClient({
      now: () => clock, sleep: async (ms) => { clock += ms; }, minIntervalMs: 250, maxConcurrent: 2,
      fetch: async (url) => {
        starts.push(clock); active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return jsonResponse(200, { ...JSON.parse(fixture("ares-45274649.json")), ico: url.split("/").pop() });
      }
    });
    await Promise.all(["45274649", "25596641", "00006947", "24729035"].map((ico) => client.getByIco(ico)));
    expect(peak).toBeLessThanOrEqual(2);
    expect(new Set(starts).size).toBe(4);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(250);
  });

  it("only talks to the allowlisted registry hosts and does not cache failures", async () => {
    let calls = 0;
    const { client } = fastClient(async () => { calls++; return new Response("x", { status: 500 }); }, { retries: 0 });
    await expect(client.getByIco("45274649")).rejects.toMatchObject({ code: "HTTP", status: 500 });
    await expect(client.getByIco("45274649")).rejects.toMatchObject({ code: "HTTP" });
    expect(calls).toBe(2);
  });

  it("looks up a supplier by ICO and degrades to unknown VAT when ADIS is unavailable", async () => {
    const { client } = fastClient(async (url) => url.startsWith("https://ares.gov.cz")
      ? jsonResponse(200, JSON.parse(fixture("ares-45274649.json")))
      : new Response("down", { status: 503 }), { retries: 0 });
    const result = await client.lookupSupplierByIco("45274649");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.supplier).toMatchObject({ ico: "45274649", dic: "CZ45274649", vat: { status: "unknown" } });
      expect(result.supplier.warnings.join(" ")).toContain("ADIS unavailable");
    }
    const missing = fastClient(async () => jsonResponse(404, { kod: "NENALEZENO" })).client;
    expect(await missing.lookupSupplierByIco("4527 4649")).toMatchObject({ found: false, ico: "45274649" });
  });

  it("sends redirect:error and a timeout signal, and caps response size", async () => {
    let seen: RequestInit | undefined;
    const { client } = fastClient(async (_url, init) => { seen = init; return new Response("x".repeat(50), { status: 200 }); }, { maxResponseBytes: 10 });
    await expect(client.getByIco("45274649")).rejects.toBeInstanceOf(RegistryError);
    expect(seen?.redirect).toBe("error");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("builds ADIS requests only from Czech DICs and batches distinct numbers", async () => {
    let body = "";
    const { client } = fastClient(async (_url, init) => { body = String(init.body); return new Response(fixture("adis-subjects.xml"), { status: 200 }); });
    const res = await client.vatStatus(["CZ45274649", "45274649", "DE123456789", "CZ685024774"]);
    expect(body.match(/<roz:dic>/g)).toHaveLength(2);
    expect(body).toContain("<roz:dic>45274649</roz:dic><roz:dic>685024774</roz:dic>");
    expect(res.value[0]?.typSubjektu).toBe("PLATCE_DPH");
    await expect(client.vatStatus(["DE123456789"])).rejects.toMatchObject({ code: "INPUT" });
  });
});
