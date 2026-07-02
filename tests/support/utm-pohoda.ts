import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import iconv from "iconv-lite";
import { CliXmlTransport, type CliXmlJobResult, type ProcessRunner, type TransportOptions, type XmlTransport } from "../../src/pohoda/transport.js";

export type UtmPohodaOptions = {
  vm: string;
  utmctl: string;
  exePath: string;
  username: string;
  password: string;
  ico: string;
  database: string;
  timeoutMs: number;
  keepGuestJobs: boolean;
};

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): UtmPohodaOptions | undefined {
  const vm = env.POHODA_UTM_VM;
  if (!vm) {
    return undefined;
  }
  return {
    vm,
    utmctl: env.POHODA_UTMCTL ?? "/Applications/UTM.app/Contents/MacOS/utmctl",
    exePath: env.POHODA_UTM_EXE_PATH ?? "C:\\Program Files (x86)\\STORMWARE\\POHODA\\Pohoda.exe",
    username: env.POHODA_UTM_USERNAME ?? "Admin",
    password: env.POHODA_UTM_PASSWORD ?? "",
    ico: env.POHODA_UTM_ICO ?? "12345678",
    database: env.POHODA_UTM_DATABASE ?? "",
    timeoutMs: Number(env.POHODA_UTM_TIMEOUT_MS ?? 120_000),
    keepGuestJobs: /^(1|true|yes|on)$/i.test(env.POHODA_UTM_KEEP_JOBS ?? "")
  };
}

export class UtmPohodaTransport implements XmlTransport {
  public readonly results: CliXmlJobResult[] = [];
  private readonly guestBase: string;
  private localDirPromise: Promise<string> | undefined;

  public constructor(private readonly options: UtmPohodaOptions) {
    this.guestBase = `C:\\Users\\Public\\pohoda-mcp-it-${Date.now()}-${randomBytes(2).toString("hex")}`;
  }

  public async exchange(xml: string, database: string, transportOptions: TransportOptions = {}): Promise<CliXmlJobResult> {
    const localDir = await this.localDir();
    const jobId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
    const started = performance.now();
    const responseXml = await runPohodaJob({
      ...this.options,
      localDir,
      guestDir: `${this.guestBase}\\${jobId}`,
      xml,
      database,
      checkDuplicity: Boolean(transportOptions.checkDuplicity ?? true),
      formatOutput: Boolean(transportOptions.formatOutput),
      timeoutMs: Number(transportOptions.timeoutSeconds ?? 0) > 0 ? Number(transportOptions.timeoutSeconds) * 1000 : this.options.timeoutMs
    });
    const result = {
      xml: responseXml,
      jobId,
      database,
      jobDir: `${this.guestBase}\\${jobId}`,
      queueWaitMs: 0,
      processSlotWaitMs: 0,
      durationMs: Math.round(performance.now() - started),
      exitCode: 0,
      jobRetained: this.options.keepGuestJobs
    };
    this.results.push(result);
    return result;
  }

  public status(database = ""): Record<string, unknown> {
    return {
      transport: "utm_xml",
      vm: this.options.vm,
      utmctl: this.options.utmctl,
      exePath: this.options.exePath,
      usernameConfigured: this.options.username !== "",
      database,
      timeoutMs: this.options.timeoutMs
    };
  }

  public async cleanup(): Promise<void> {
    if (this.localDirPromise) {
      await rm(await this.localDirPromise, { recursive: true, force: true });
    }
    if (!this.options.keepGuestJobs) {
      await execa(this.options.utmctl, ["exec", this.options.vm, "--cmd", "cmd.exe", "/c", `rmdir /S /Q ${this.guestBase} 2>NUL`], { reject: false, timeout: 30_000 });
    }
  }

  private async localDir(): Promise<string> {
    this.localDirPromise ??= mkdir(join(tmpdir(), `pohoda-utm-${randomBytes(4).toString("hex")}`), { recursive: true });
    return this.localDirPromise;
  }
}

export type UtmProcessRunner = ProcessRunner & { cleanup: () => Promise<void> };

export function createUtmProcessRunner(options: UtmPohodaOptions): UtmProcessRunner {
  const guestBase = `C:\\Users\\Public\\pohoda-mcp-runner-${Date.now()}-${randomBytes(2).toString("hex")}`;
  const runner = (async (context) => {
    const jobId = dirname(context.responseXml).split(/[\\/]/).pop() || randomBytes(3).toString("hex");
    const guestDir = `${guestBase}\\${jobId}`;
    const localDir = dirname(context.responseXml);
    const guestRequest = `${guestDir}\\request.xml`;
    const guestResponse = `${guestDir}\\response.xml`;
    const guestIni = `${guestDir}\\xml_imp.ini`;
    const guestRun = `${guestDir}\\run.cmd`;
    const localRequest = join(localDir, "request.xml");
    const localIni = join(localDir, "xml_imp.ini");
    const localRun = join(localDir, "run.cmd");
    const ini = (await readFile(localIni, "utf8"))
      .replace(/^input_xml=.*$/m, `input_xml=${guestRequest}`)
      .replace(/^response_xml=.*$/m, `response_xml=${guestResponse}`);

    await writeFile(localIni, ini);
    await writeFile(localRun, `@echo off\r\ncd /d "${dirnameWin(options.exePath)}"\r\n"${options.exePath}" /XML "${options.username}" "${options.password}" "${guestIni}" > "${guestDir}\\stdout.log" 2> "${guestDir}\\stderr.log"\r\necho %ERRORLEVEL% > "${guestDir}\\exitcode.txt"\r\n`);
    await utm(options.utmctl, ["exec", options.vm, "--cmd", "cmd.exe", "/c", `mkdir ${guestDir} 2>NUL`], "create guest job dir");
    await push(options.utmctl, options.vm, localRequest, guestRequest);
    await push(options.utmctl, options.vm, localIni, guestIni);
    await push(options.utmctl, options.vm, localRun, guestRun);
    await execa(options.utmctl, ["exec", options.vm, "--cmd", "cmd.exe", "/c", guestRun], { reject: false, timeout: context.timeoutMs });
    await waitForGuestFile(options.utmctl, options.vm, `${guestDir}\\exitcode.txt`, context.timeoutMs);
    await waitForGuestFile(options.utmctl, options.vm, guestResponse, context.timeoutMs);
    await pullToFile(options.utmctl, options.vm, guestResponse, context.responseXml, {
      utmctl: options.utmctl,
      vm: options.vm,
      stdoutPath: `${guestDir}\\stdout.log`,
      stderrPath: `${guestDir}\\stderr.log`,
      exitCodePath: `${guestDir}\\exitcode.txt`
    });
    return 0;
  }) as UtmProcessRunner;
  runner.cleanup = async () => {
    if (!options.keepGuestJobs) {
      await execa(options.utmctl, ["exec", options.vm, "--cmd", "cmd.exe", "/c", `rmdir /S /Q ${guestBase} 2>NUL`], { reject: false, timeout: 30_000 });
    }
  };
  return runner;
}

export async function runPohodaJob(options: UtmPohodaOptions & {
  localDir: string;
  guestDir: string;
  xml: string;
  database: string;
  checkDuplicity?: boolean;
  formatOutput?: boolean;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const requestPath = join(options.localDir, "request.xml");
  const iniPath = join(options.localDir, "xml_imp.ini");
  const runPath = join(options.localDir, "run.cmd");
  const responsePath = join(options.localDir, "response.xml");
  const guestRequest = `${options.guestDir}\\request.xml`;
  const guestIni = `${options.guestDir}\\xml_imp.ini`;
  const guestResponse = `${options.guestDir}\\response.xml`;

  await writeFile(requestPath, iconv.encode(options.xml, "win1250"));
  await writeFile(iniPath, CliXmlTransport.renderIni({
    inputXml: guestRequest,
    responseXml: guestResponse,
    database: options.database,
    checkDuplicity: Boolean(options.checkDuplicity),
    formatOutput: Boolean(options.formatOutput)
  }));
  await writeFile(runPath, `@echo off\r\ncd /d "${dirnameWin(options.exePath)}"\r\n"${options.exePath}" /XML "${options.username}" "${options.password}" "${guestIni}" > "${options.guestDir}\\stdout.log" 2> "${options.guestDir}\\stderr.log"\r\necho %ERRORLEVEL% > "${options.guestDir}\\exitcode.txt"\r\n`);

  await utm(options.utmctl, ["exec", options.vm, "--cmd", "cmd.exe", "/c", `mkdir ${options.guestDir} 2>NUL`], "create guest job dir");
  await push(options.utmctl, options.vm, requestPath, guestRequest);
  await push(options.utmctl, options.vm, iniPath, guestIni);
  await push(options.utmctl, options.vm, runPath, `${options.guestDir}\\run.cmd`);
  await execa(options.utmctl, ["exec", options.vm, "--cmd", "cmd.exe", "/c", `${options.guestDir}\\run.cmd`], { reject: false, timeout: timeoutMs });
  await waitForGuestFile(options.utmctl, options.vm, `${options.guestDir}\\exitcode.txt`, timeoutMs);
  await waitForGuestFile(options.utmctl, options.vm, guestResponse, timeoutMs);
  await pullToFile(options.utmctl, options.vm, guestResponse, responsePath, {
    utmctl: options.utmctl,
    vm: options.vm,
    stdoutPath: `${options.guestDir}\\stdout.log`,
    stderrPath: `${options.guestDir}\\stderr.log`,
    exitCodePath: `${options.guestDir}\\exitcode.txt`
  });
  return iconv.decode(await readFile(responsePath), "win1250");
}

async function waitForGuestFile(utmctl: string, vm: string, guestPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const result = await execa(utmctl, ["file", "pull", vm, guestPath], { encoding: "buffer", reject: false, timeout: 10_000 });
    const error = utmError(result.stderr) || utmError(result.stdout);
    if (!error) {
      return;
    }
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for guest file ${guestPath}: ${lastError}`);
}

async function push(utmctl: string, vm: string, localPath: string, guestPath: string): Promise<void> {
  const result = await execa(utmctl, ["file", "push", vm, guestPath], {
    input: await readFile(localPath),
    encoding: "buffer",
    reject: false,
    timeout: 30_000
  });
  const error = utmError(result.stderr) || utmError(result.stdout);
  if (result.exitCode !== 0 || error) {
    throw new Error(`utmctl file push failed for ${guestPath}: ${error || result.stderr.toString()}`);
  }
}

async function pullToFile(utmctl: string, vm: string, guestPath: string, localPath: string, diagnostics?: {
  utmctl: string;
  vm: string;
  stdoutPath: string;
  stderrPath: string;
  exitCodePath: string;
}): Promise<void> {
  let lastSize = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await execa("bash", ["-lc", `${shellQuote(utmctl)} file pull ${shellQuote(vm)} ${shellQuote(guestPath)} > ${shellQuote(localPath)}`], { reject: false, timeout: 30_000 });
    lastError = utmError(result.stderr) || utmError(result.stdout) || (result.exitCode === 0 ? "" : result.stderr);
    lastSize = statSync(localPath).size;
    if (!lastError && lastSize > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const stdout = diagnostics ? await pullOptionalText(diagnostics.utmctl, diagnostics.vm, diagnostics.stdoutPath) : "";
  const stderr = diagnostics ? await pullOptionalText(diagnostics.utmctl, diagnostics.vm, diagnostics.stderrPath) : "";
  const exitCode = diagnostics ? await pullOptionalText(diagnostics.utmctl, diagnostics.vm, diagnostics.exitCodePath) : "";
  throw new Error(`Pulled empty guest file ${guestPath} after retries (lastSize=${lastSize}).`
    + (lastError ? ` pullError=${lastError}` : "")
    + (exitCode.trim() ? ` exitCode=${exitCode.trim()}` : "")
    + (stderr.trim() ? ` stderr=${stderr.trim()}` : "")
    + (stdout.trim() ? ` stdout=${stdout.trim()}` : ""));
}

async function pullOptionalText(utmctl: string, vm: string, guestPath: string): Promise<string> {
  const result = await execa(utmctl, ["file", "pull", vm, guestPath], { encoding: "buffer", reject: false, timeout: 30_000 });
  if (result.exitCode !== 0 || utmError(result.stderr) || utmError(result.stdout)) {
    return "";
  }
  return iconv.decode(result.stdout, "win1250");
}

async function utm(utmctl: string, args: string[], action: string, timeout = 30_000): Promise<void> {
  const attempts = action === "create guest job dir" ? 5 : 1;
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await execa(utmctl, args, { encoding: "buffer", reject: false, timeout });
    const error = utmError(result.stderr) || utmError(result.stdout);
    if (result.exitCode === 0 && !error) {
      return;
    }
    lastError = error || outputText(result.stderr) || outputText(result.stdout);
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error(`utmctl ${action} failed: ${lastError}`);
}

function utmError(stderr: Buffer | Uint8Array | string): string {
  const text = outputText(stderr);
  return /Error from event|failed to |cannot find|cannot be found|The system cannot find|Access is denied/i.test(text) ? text.trim() : "";
}

function outputText(value: Buffer | Uint8Array | string): string {
  return typeof value === "string" ? value : Buffer.from(value).toString();
}

function dirnameWin(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
