/**
 * Parallels Desktop harness for running POHODA `/XML` jobs inside a local Windows VM.
 *
 * Transport design (no shared folders required):
 *   host -> `prlctl exec <vm> powershell -EncodedCommand <script>` with a JSON job on stdin.
 *   The guest script writes request.xml + xml_imp.ini, runs `Pohoda.exe /XML`, and prints
 *   one JSON line containing the base64 response. Secrets travel only via stdin, never via
 *   host argv, so they do not appear in `ps` output or in thrown errors.
 *
 * Safety: write experiments must go through `selectVerifiedDemoUnit`, which requires an
 * explicit database name AND live demo/test metadata. It never falls back to units[0].
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import iconv from "iconv-lite";
// Deliberately NOT importing PohodaClient: it pulls in in-flight policy/archive modules. The harness
// uses the same envelope builder + response parser that PohodaClient.sendRawXml uses.
import { PohodaResponse } from "../../src/pohoda/response.js";
import { CliXmlTransport, type CliXmlJobResult, type TransportOptions, type XmlTransport } from "../../src/pohoda/transport.js";
import { XmlBuilder } from "../../src/pohoda/xml-builder.js";

export type ParallelsPohodaOptions = {
  vm: string;
  prlctl: string;
  /** Empty => discover via `discoverPohodaInstall`. */
  exePath: string;
  username: string;
  password: string;
  /** ICO used for the listAccountingUnits dataPack before a unit is selected. */
  bootstrapIco: string;
  /** Explicit demo database file name (e.g. `StwPh_12345678_2026.mdb`). Required for writes. */
  demoDatabase: string;
  /** Optional explicit ICO the demo unit must have. */
  demoIco: string;
  /** Run guest commands as the logged-in guest user instead of SYSTEM. */
  currentUser: boolean;
  timeoutMs: number;
  keepGuestJobs: boolean;
  allowWrites: boolean;
  startVm: boolean;
  /** Host directory receiving one request/response XML pair per exchange (no credentials inside). */
  evidenceDir: string;
};

const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value ?? "");

export function parallelsOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ParallelsPohodaOptions | undefined {
  const vm = env.POHODA_PRL_VM;
  if (!vm) {
    return undefined;
  }
  return {
    vm,
    prlctl: env.POHODA_PRLCTL ?? "/usr/local/bin/prlctl",
    exePath: env.POHODA_PRL_EXE_PATH ?? "",
    username: env.POHODA_PRL_USERNAME ?? "Admin",
    password: env.POHODA_PRL_PASSWORD ?? "",
    bootstrapIco: env.POHODA_PRL_BOOTSTRAP_ICO ?? env.POHODA_PRL_DEMO_ICO ?? "12345678",
    demoDatabase: env.POHODA_PRL_DEMO_DATABASE ?? "",
    demoIco: env.POHODA_PRL_DEMO_ICO ?? "",
    currentUser: truthy(env.POHODA_PRL_CURRENT_USER),
    timeoutMs: Number(env.POHODA_PRL_TIMEOUT_MS ?? 180_000),
    keepGuestJobs: truthy(env.POHODA_PRL_KEEP_JOBS),
    allowWrites: truthy(env.POHODA_PRL_ALLOW_WRITES),
    startVm: truthy(env.POHODA_PRL_START_VM),
    evidenceDir: env.POHODA_PRL_EVIDENCE_DIR ?? ""
  };
}

// ---------------------------------------------------------------------------
// prlctl primitives
// ---------------------------------------------------------------------------

export type ParallelsVm = { uuid: string; name: string; status: string };

export async function listVms(prlctl = "/usr/local/bin/prlctl"): Promise<ParallelsVm[]> {
  const result = await execa(prlctl, ["list", "-a", "-j"], { timeout: 30_000 });
  return (JSON.parse(result.stdout) as any[]).map((vm) => ({ uuid: String(vm.uuid), name: String(vm.name), status: String(vm.status) }));
}

export async function vmStatus(prlctl: string, vm: string): Promise<string> {
  const result = await execa(prlctl, ["status", vm], { timeout: 30_000, reject: false });
  return result.stdout.match(/\b(running|stopped|suspended|paused|starting|stopping|resuming)\b/)?.[1] ?? "unknown";
}

/** Starts/resumes the VM (reversible) and waits until guest exec works. */
export async function ensureVmRunning(options: Pick<ParallelsPohodaOptions, "prlctl" | "vm" | "currentUser">, timeoutMs = 300_000): Promise<string> {
  const before = await vmStatus(options.prlctl, options.vm);
  if (before === "suspended" || before === "paused") {
    await execa(options.prlctl, ["resume", options.vm], { timeout: 120_000 });
  } else if (before === "stopped") {
    await execa(options.prlctl, ["start", options.vm], { timeout: 120_000 });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await guestPowerShell(options, "'ready'", "", 30_000).catch(() => undefined);
    if (probe?.stdout.includes("ready")) {
      return before;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`Parallels VM '${options.vm}' did not accept guest commands within ${timeoutMs} ms (initial status ${before}).`);
}

/**
 * Runs a PowerShell script in the guest. The script is passed as -EncodedCommand (no quoting
 * issues); `stdin` is delivered to the script via [Console]::In.
 */
export async function guestPowerShell(
  options: Pick<ParallelsPohodaOptions, "prlctl" | "vm" | "currentUser">,
  script: string,
  stdin = "",
  timeoutMs = 120_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const prelude = "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop;";
  const encoded = Buffer.from(prelude + script, "utf16le").toString("base64");
  const args = ["exec", options.vm, ...(options.currentUser ? ["--current-user"] : []), "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];
  const result = await execa(options.prlctl, args, { input: stdin, reject: false, timeout: timeoutMs, stripFinalNewline: true });
  return { stdout: result.stdout, stderr: stripClixml(result.stderr), exitCode: result.exitCode ?? -1 };
}

function stripClixml(stderr: string): string {
  return stderr.startsWith("#< CLIXML") ? stderr.replace(/^#< CLIXML\s*/, "").replace(/<Obj S="progress"[\s\S]*?<\/Obj>/g, "").replace(/<[^>]+>/g, " ").replace(/_x000D__x000A_/g, "\n").trim() : stderr.trim();
}

// ---------------------------------------------------------------------------
// Discovery (never prints secrets)
// ---------------------------------------------------------------------------

export type PohodaInstallDiscovery = {
  exePaths: string[];
  uninstallEntries: Array<{ name: string; version: string; location: string }>;
  stormwareRegistry: boolean;
  programDataStormware: boolean;
};

export async function discoverPohodaInstall(options: Pick<ParallelsPohodaOptions, "prlctl" | "vm" | "currentUser">): Promise<PohodaInstallDiscovery> {
  const script = String.raw`
$ErrorActionPreference='SilentlyContinue'
$roots = @('C:\Program Files (x86)\STORMWARE','C:\Program Files\STORMWARE','C:\STORMWARE','D:\STORMWARE','C:\POHODA','D:\POHODA')
$exe = @()
foreach ($r in $roots) { if (Test-Path $r) { $exe += Get-ChildItem $r -Recurse -Filter 'Pohoda.exe' -Depth 4 | ForEach-Object FullName } }
$keys = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
$un = @(Get-ItemProperty $keys | Where-Object { $_.DisplayName -match 'pohoda|stormware' } | ForEach-Object { [pscustomobject]@{ name=[string]$_.DisplayName; version=[string]$_.DisplayVersion; location=[string]$_.InstallLocation } })
foreach ($u in $un) { if ($u.location -and (Test-Path (Join-Path $u.location 'Pohoda.exe'))) { $exe += (Join-Path $u.location 'Pohoda.exe') } }
[pscustomobject]@{
  exePaths = @($exe | Sort-Object -Unique)
  uninstallEntries = $un
  stormwareRegistry = (Test-Path 'HKLM:\SOFTWARE\WOW6432Node\STORMWARE') -or (Test-Path 'HKLM:\SOFTWARE\STORMWARE')
  programDataStormware = Test-Path 'C:\ProgramData\STORMWARE'
} | ConvertTo-Json -Compress -Depth 4
`;
  const result = await guestPowerShell(options, script, "", 180_000);
  const line = result.stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
  if (!line) {
    throw new Error(`POHODA discovery produced no JSON (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
  }
  const parsed = JSON.parse(line);
  return {
    exePaths: toArray(parsed.exePaths).map(String),
    uninstallEntries: toArray(parsed.uninstallEntries),
    stormwareRegistry: Boolean(parsed.stormwareRegistry),
    programDataStormware: Boolean(parsed.programDataStormware)
  };
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const JOB_SCRIPT = String.raw`
$job = [Console]::In.ReadToEnd() | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $job.dir | Out-Null
$req = Join-Path $job.dir 'request.xml'; $ini = Join-Path $job.dir 'xml_imp.ini'; $resp = Join-Path $job.dir 'response.xml'
[IO.File]::WriteAllBytes($req, [Convert]::FromBase64String($job.requestB64))
[IO.File]::WriteAllText($ini, $job.ini, [Text.Encoding]::GetEncoding(1250))
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $job.exe
$psi.WorkingDirectory = Split-Path $job.exe
$psi.UseShellExecute = $false
$psi.Arguments = '/XML "' + $job.user + '" "' + $job.pass + '" "' + $ini + '"'
$p = [Diagnostics.Process]::Start($psi)
$done = $p.WaitForExit([int]$job.timeoutMs)
if (-not $done) { try { $p.Kill() } catch {} }
$code = if ($done) { $p.ExitCode } else { -999 }
$b64 = if (Test-Path $resp) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($resp)) } else { '' }
if (-not $job.keep) { Remove-Item -Recurse -Force $job.dir -ErrorAction SilentlyContinue }
'@@JOB@@' + ([pscustomobject]@{ exitCode = $code; timedOut = (-not $done); responseB64 = $b64 } | ConvertTo-Json -Compress)
`;

export class ParallelsPohodaTransport implements XmlTransport {
  public readonly results: Array<CliXmlJobResult & { request: string; requestPath?: string; responsePath?: string }> = [];
  /** Label applied to the next exchange's evidence files (set by the test before each call). */
  public label = "exchange";
  private sequence = 0;
  private readonly runTag = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  private readonly guestBase = `C:\\Users\\Public\\pohoda-mcp-prl-${Date.now()}-${randomBytes(2).toString("hex")}`;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: ParallelsPohodaOptions & { exePath: string }) {
    if (!options.exePath) {
      throw new Error("ParallelsPohodaTransport needs exePath; run discoverPohodaInstall first.");
    }
  }

  /** Jobs are serialized: POHODA must not run concurrently against one database. */
  public exchange(xml: string, database: string, transportOptions: TransportOptions = {}): Promise<CliXmlJobResult> {
    const run = this.queue.then(() => this.run(xml, database, transportOptions));
    this.queue = run.catch(() => undefined);
    return run;
  }

  public status(database = ""): Record<string, unknown> {
    return {
      transport: "parallels_xml",
      vm: this.options.vm,
      exePath: this.options.exePath,
      usernameConfigured: this.options.username !== "",
      currentUser: this.options.currentUser,
      database,
      timeoutMs: this.options.timeoutMs
    };
  }

  public async cleanup(): Promise<void> {
    if (!this.options.keepGuestJobs) {
      await guestPowerShell(this.options, `Remove-Item -Recurse -Force '${this.guestBase}' -ErrorAction SilentlyContinue`, "", 60_000).catch(() => undefined);
    }
  }

  private async run(xml: string, database: string, transportOptions: TransportOptions): Promise<CliXmlJobResult> {
    const normalized = database.trim();
    if (normalized === "" && !transportOptions.allowNoDatabase) {
      throw new Error("Pohoda database is required for XML transport.");
    }
    const jobId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
    const dir = `${this.guestBase}\\${jobId}`;
    const timeoutMs = Number(transportOptions.timeoutSeconds ?? 0) > 0 ? Number(transportOptions.timeoutSeconds) * 1000 : this.options.timeoutMs;
    const ini = CliXmlTransport.renderIni({
      inputXml: `${dir}\\request.xml`,
      responseXml: `${dir}\\response.xml`,
      database: normalized,
      checkDuplicity: Boolean(transportOptions.checkDuplicity ?? true),
      formatOutput: Boolean(transportOptions.formatOutput)
    });
    const payload = JSON.stringify({
      dir,
      ini,
      exe: this.options.exePath,
      user: this.options.username,
      pass: this.options.password,
      timeoutMs,
      keep: this.options.keepGuestJobs,
      requestB64: iconv.encode(xml, "win1250").toString("base64")
    });
    const started = performance.now();
    const result = await guestPowerShell(this.options, JOB_SCRIPT, payload, timeoutMs + 60_000);
    const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("@@JOB@@"));
    if (!marker) {
      throw new Error(redact(`Guest POHODA job produced no result (prlctl exit ${result.exitCode}): ${result.stderr.slice(0, 800)}`, this.options.password));
    }
    const job = JSON.parse(marker.slice("@@JOB@@".length)) as { exitCode: number; timedOut: boolean; responseB64: string };
    if (!job.responseB64) {
      throw new Error(`POHODA /XML wrote no response.xml (exitCode=${job.exitCode}, timedOut=${job.timedOut}, database='${normalized}').`);
    }
    const responseXml = iconv.decode(Buffer.from(job.responseB64, "base64"), "win1250");
    const paths = this.writeEvidence(xml, responseXml);
    const jobResult = {
      xml: responseXml,
      jobId,
      database: normalized,
      jobDir: dir,
      queueWaitMs: 0,
      processSlotWaitMs: 0,
      durationMs: Math.round(performance.now() - started),
      exitCode: job.exitCode,
      jobRetained: this.options.keepGuestJobs
    };
    this.results.push({ ...jobResult, request: xml, ...paths });
    return { ...jobResult, ...paths };
  }

  private writeEvidence(requestXml: string, responseXml: string): { requestPath?: string; responsePath?: string } {
    if (!this.options.evidenceDir) {
      return {};
    }
    mkdirSync(this.options.evidenceDir, { recursive: true });
    const base = `${this.runTag}-${String(++this.sequence).padStart(3, "0")}-${this.label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`;
    const requestPath = join(this.options.evidenceDir, `${base}.request.xml`);
    const responsePath = join(this.options.evidenceDir, `${base}.response.xml`);
    // Stored as UTF-8 text for review; the wire format sent to POHODA is Windows-1250.
    writeFileSync(requestPath, requestXml);
    writeFileSync(responsePath, responseXml);
    return { requestPath, responsePath };
  }
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("***") : text;
}

// ---------------------------------------------------------------------------
// Demo-unit guard
// ---------------------------------------------------------------------------

export type LiveUnit = {
  database: string;
  name: string;
  ico?: string | undefined;
  dic?: string | undefined;
  city?: string | undefined;
  year?: number | undefined;
  personName?: string | undefined;
  unitType?: string | undefined;
  stateType?: string | undefined;
};

/** Live-metadata markers that identify a sandbox unit (POHODA ships the "Novák" sample data). */
export const DEMO_MARKERS = /(demo|uk[aá]zk|test|mcptest|sandbox|nov[aá]k|cvi[cč]n|[sš]kol|education|v[yý]uk)/i;

export type DemoSelection = { ok: true; unit: LiveUnit; evidence: string[] } | { ok: false; reason: string; candidates: LiveUnit[] };

/**
 * Requires BOTH an explicit database name AND live metadata that looks like a demo unit.
 * Never chooses implicitly; returns a reason the parent agent can relay for clarification.
 */
export function selectVerifiedDemoUnit(units: LiveUnit[], explicitDatabase: string, explicitIco = ""): DemoSelection {
  const candidates = units.filter((unit) => DEMO_MARKERS.test([unit.name, unit.personName, unit.database, unit.city].filter(Boolean).join(" ")));
  if (explicitDatabase.trim() === "") {
    return { ok: false, reason: "POHODA_PRL_DEMO_DATABASE is not set; refusing to infer a write target.", candidates };
  }
  const unit = units.find((u) => u.database.toLowerCase() === explicitDatabase.trim().toLowerCase());
  if (!unit) {
    return { ok: false, reason: `Database '${explicitDatabase}' is not among live accounting units.`, candidates };
  }
  const evidence: string[] = [];
  const text = [unit.name, unit.personName, unit.database, unit.city].filter(Boolean).join(" ");
  const marker = text.match(DEMO_MARKERS)?.[0];
  if (!marker) {
    return { ok: false, reason: `Live metadata of '${unit.database}' (${unit.name}) has no demo/test marker.`, candidates };
  }
  evidence.push(`metadata marker '${marker}' in "${text}"`);
  if (explicitIco !== "") {
    if (unit.ico !== explicitIco) {
      return { ok: false, reason: `ICO mismatch for '${unit.database}': live=${unit.ico ?? "(none)"} expected=${explicitIco}.`, candidates };
    }
    evidence.push(`ICO ${unit.ico} matches POHODA_PRL_DEMO_ICO`);
  }
  return { ok: true, unit, evidence };
}

/** Prefix for every record written by live experiments so they are searchable and removable. */
export const MCPTEST_PREFIX = "MCPTEST";

export function mcptestId(suite: string, name: string): string {
  return `${MCPTEST_PREFIX}-${suite}-${name}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
}

/** Minimal listAccountingUnits parser (decoupled from src/mcp/tools.ts, which is under active change). */
export function extractLiveUnits(data: Record<string, any>): LiveUnit[] {
  const raw = data.items?.[0]?.data?.itemAccountingUnit ?? [];
  return toArray<any>(raw).map((item, index) => {
    const dataFile = String(item.dataFile ?? "");
    const address = item.accountingUnitIdentity?.address ?? {};
    const database = dataFile ? dataFile.split(/[\\/]/).pop()! : `accounting-unit-${index + 1}`;
    return {
      database,
      name: String(address.company || address.name || database),
      ico: address.ico ? String(address.ico) : undefined,
      dic: address.dic ? String(address.dic) : undefined,
      city: address.city ? String(address.city) : undefined,
      personName: address.name ? String(address.name) : undefined,
      year: item.year ? Number(item.year) : undefined,
      unitType: item.unitType ? String(item.unitType) : undefined,
      stateType: item.stateType ? String(item.stateType) : undefined
    };
  });
}

// ---------------------------------------------------------------------------
// Harness XML client (raw experiments only)
// ---------------------------------------------------------------------------

/**
 * Minimal raw-XML client mirroring PohodaClient.sendRawXml (same XmlBuilder envelope, same
 * PohodaResponse parser). Test-only bypass: production imports must keep their own guards.
 */
export class HarnessXmlClient {
  private database = "";
  private builder: XmlBuilder;

  public constructor(private readonly transport: XmlTransport & { label?: string }, private ico: string) {
    this.builder = new XmlBuilder(ico, "MCPTEST harness");
  }

  public setContext(database: string, ico: string): void {
    this.database = database;
    this.ico = ico;
    this.builder = new XmlBuilder(ico, "MCPTEST harness");
  }

  public getDatabase(): string {
    return this.database;
  }

  public getIco(): string {
    return this.ico;
  }

  public async sendRawXml(inner: string | string[], label: string, dataPackId = "", options: TransportOptions = {}): Promise<PohodaResponse> {
    const xml = this.builder.buildRawMany(Array.isArray(inner) ? inner : [inner], `MCPTEST ${label}`.slice(0, 200), dataPackId);
    this.transport.label = label;
    const result = await this.transport.exchange(xml, options.omitDatabase ? "" : this.database, options);
    return new PohodaResponse(result.xml, result as unknown as Record<string, unknown>);
  }

  public listAccountingUnits(): Promise<PohodaResponse> {
    return this.sendRawXml(`<acu:listAccountingUnitRequest version="1.6"/>`, "listAccountingUnits", "", {
      allowNoDatabase: true,
      omitDatabase: true,
      checkDuplicity: false
    });
  }

  public list(inner: string, label: string): Promise<PohodaResponse> {
    return this.sendRawXml(inner, label, "", { checkDuplicity: false });
  }
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type RawListFilter = { id?: number; extId?: { ids: string; exSystemName: string }; ico?: string };

function rawFilter(filter: RawListFilter, agenda: "invoice" | "voucher" | "addressbook"): string {
  const parts: string[] = [];
  if (filter.id) parts.push(`<ftr:id>${filter.id}</ftr:id>`);
  if (filter.extId) parts.push(`<ftr:extId><typ:ids>${esc(filter.extId.ids)}</typ:ids><typ:exSystemName>${esc(filter.extId.exSystemName)}</typ:exSystemName></ftr:extId>`);
  if (filter.ico) parts.push(agenda === "addressbook" ? `<ftr:ico>${esc(filter.ico)}</ftr:ico>` : `<ftr:selectedIco><ftr:ico>${esc(filter.ico)}</ftr:ico></ftr:selectedIco>`);
  return parts.length ? `<ftr:filter>${parts.join("")}</ftr:filter>` : "";
}

/**
 * Raw list builders following list.xsd element order (limit?, request*, restrictionData?).
 * Live finding (POHODA 14302.10): ftr:extId inside requestInvoice is accepted but IGNORED for invoices
 * (the whole agenda/type is returned). Read back by the produced numeric id; `extSystem` only makes
 * POHODA export the stored external IDs so they can be compared.
 */
const restriction = (attachments: boolean) => (attachments ? `<lst:restrictionData><lst:attachments>true</lst:attachments></lst:restrictionData>` : "");
const extSystemAttr = (extSystem: string) => (extSystem ? ` extSystem="${esc(extSystem)}"` : "");
export const rawList = {
  invoice: (type: string, filter: RawListFilter, attachments = false, extSystem = "") =>
    `<lst:listInvoiceRequest version="2.0" invoiceVersion="2.0" invoiceType="${type}"${extSystemAttr(extSystem)}><lst:requestInvoice>${rawFilter(filter, "invoice")}</lst:requestInvoice>${restriction(attachments)}</lst:listInvoiceRequest>`,
  /** listVoucherRequest has no voucherType attribute (schema rejects it). */
  voucher: (filter: RawListFilter, attachments = false, extSystem = "") =>
    `<lst:listVoucherRequest version="2.0" voucherVersion="2.0"${extSystemAttr(extSystem)}><lst:requestVoucher>${rawFilter(filter, "voucher")}</lst:requestVoucher>${restriction(attachments)}</lst:listVoucherRequest>`,
  addressbook: (filter: RawListFilter) =>
    `<lAdb:listAddressBookRequest version="2.0" addressBookVersion="2.0"><lAdb:requestAddressBook>${rawFilter(filter, "addressbook")}</lAdb:requestAddressBook></lAdb:listAddressBookRequest>`,
  numericalSeries: () => `<lst:listNumericalSeriesRequest version="2.0" numericalSeriesVersion="2.0"><lst:requestNumericalSeries/></lst:listNumericalSeriesRequest>`,
  classificationVAT: () => `<lst:listClassificationVATRequest version="2.0" classificationVATVersion="2.0"><lst:requestClassificationVAT/></lst:listClassificationVATRequest>`
};

/** The XmlBuilder envelope does not declare every agenda namespace; declare it on the element itself. */
export const NMS_NS = "http://www.stormware.cz/schema/version_2/numericalSeries.xsd";

/** First produced record id (rdc:producedDetails/rdc:id) of a write response, or 0. */
export function producedId(response: PohodaResponse): number {
  const match = String((response.transport as { xml?: string })?.xml ?? "").match(/<rdc:producedDetails>\s*<rdc:id>(\d+)<\/rdc:id>/);
  return match ? Number(match[1]) : 0;
}

/** Flattens agenda records (invoice / voucher / addressbook / numericalSeries ...) out of a list response. */
export function listedRecords(response: PohodaResponse, key: RegExp = /^(invoice|voucher|addressbook|numericalSeries|classificationVAT)$/): any[] {
  const out: any[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    for (const [k, value] of Object.entries(node)) {
      if (key.test(k)) out.push(...(Array.isArray(value) ? value : [value]));
      else walk(value);
    }
  };
  for (const item of response.items) walk(item.data);
  return out;
}
