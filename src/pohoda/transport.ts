import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import iconv from "iconv-lite";
import lockfile from "proper-lockfile";

export type CliXmlJobResult = {
  xml: string;
  jobId: string;
  database: string;
  jobDir: string;
  queueWaitMs: number;
  processSlotWaitMs: number;
  durationMs: number;
  exitCode: number;
  jobRetained: boolean;
};

export type ProcessRunnerContext = {
  command: string[];
  cwd: string;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  responseXml: string;
  database: string;
};

export type ProcessRunner = (context: ProcessRunnerContext) => Promise<number>;

export type TransportOptions = {
  allowNoDatabase?: boolean;
  checkDuplicity?: boolean;
  formatOutput?: boolean;
  xsltInput?: string;
  xsltOutput?: string;
  timeoutSeconds?: number;
  databaseOverride?: string;
  omitDatabase?: boolean;
  [key: string]: unknown;
};

export interface XmlTransport {
  exchange(xml: string, database: string, options?: TransportOptions): Promise<CliXmlJobResult>;
  status(database?: string): Record<string, unknown>;
}

export type CliXmlTransportConfig = {
  exePath: string;
  username: string;
  password: string;
  workDir: string;
  timeoutSeconds?: number;
  checkDuplicity?: boolean;
  keepSuccessfulJobs?: boolean;
  keepFailedJobs?: boolean;
  maxParallelProcesses?: number;
  queueTimeoutSeconds?: number;
  processRunner?: ProcessRunner;
};

export class CliXmlTransport implements XmlTransport {
  private readonly timeoutSeconds: number;
  private readonly checkDuplicity: boolean;
  private readonly keepSuccessfulJobs: boolean;
  private readonly keepFailedJobs: boolean;
  private readonly maxParallelProcesses: number;
  private readonly queueTimeoutSeconds: number;
  private readonly processRunner: ProcessRunner;

  public constructor(private readonly config: CliXmlTransportConfig) {
    if (config.workDir.trim() === "") {
      throw new Error("POHODA_XML_WORK_DIR is required for XML transport.");
    }
    this.timeoutSeconds = config.timeoutSeconds ?? 120;
    this.checkDuplicity = config.checkDuplicity ?? true;
    this.keepSuccessfulJobs = config.keepSuccessfulJobs ?? false;
    this.keepFailedJobs = config.keepFailedJobs ?? true;
    this.maxParallelProcesses = Math.max(1, config.maxParallelProcesses ?? 4);
    this.queueTimeoutSeconds = config.queueTimeoutSeconds ?? 300;
    this.processRunner = config.processRunner ?? defaultProcessRunner;
  }

  public async exchange(xml: string, database: string, options: TransportOptions = {}): Promise<CliXmlJobResult> {
    if (xml.trim() === "") {
      throw new Error("XML request body must not be empty.");
    }
    const normalizedDatabase = database.trim();
    if (normalizedDatabase === "" && !options.allowNoDatabase) {
      throw new Error("Pohoda database is required for XML transport. Select a database first.");
    }

    await this.ensureRuntimeDirs();
    const lockPath = this.lockPath(normalizedDatabase);
    const queueStarted = performance.now();
    try {
      return await withLock(lockPath, this.queueTimeoutSeconds * 1000, async () => {
        const queueWaitMs = Math.round(performance.now() - queueStarted);
        return this.runLocked(xml, normalizedDatabase, queueWaitMs, options);
      });
    } catch (error) {
      if (String(error).includes("Lock file is already being held")) {
        const waitMs = Math.round(performance.now() - queueStarted);
        throw new Error(`Timed out waiting for POHODA database queue lock after ${this.queueTimeoutSeconds} seconds (database='${normalizedDatabase}', waitMs=${waitMs}, lock=${lockPath}).`);
      }
      throw error;
    }
  }

  public status(database = ""): Record<string, unknown> {
    return {
      transport: "cli_xml",
      exePath: this.config.exePath,
      exeConfigured: this.config.exePath !== "",
      exeExists: this.config.exePath !== "" && existsSync(this.config.exePath),
      usernameConfigured: this.config.username !== "",
      workDir: this.config.workDir,
      workDirExists: existsSync(this.config.workDir),
      workDirWritable: existsSync(this.config.workDir) && isWritableDirectory(this.config.workDir),
      database,
      timeoutSeconds: this.timeoutSeconds,
      checkDuplicity: this.checkDuplicity,
      keepSuccessfulJobs: this.keepSuccessfulJobs,
      keepFailedJobs: this.keepFailedJobs,
      maxParallelProcesses: this.maxParallelProcesses,
      queueTimeoutSeconds: this.queueTimeoutSeconds
    };
  }

  public static renderIni(options: {
    inputXml: string;
    responseXml: string;
    database: string;
    checkDuplicity: boolean;
    formatOutput?: boolean;
    xsltInput?: string;
    xsltOutput?: string;
  }): string {
    const lines = [
      "[XML]",
      `input_xml=${options.inputXml}`,
      `response_xml=${options.responseXml}`
    ];
    if (options.database !== "") {
      lines.push(`database=${options.database}`);
    }
    lines.push(`check_duplicity=${options.checkDuplicity ? "1" : "0"}`);
    lines.push(`format_output=${options.formatOutput ? "1" : "0"}`);
    if (options.xsltInput) {
      lines.push(`XSLT_input=${options.xsltInput}`);
    }
    if (options.xsltOutput) {
      lines.push(`XSLT_output=${options.xsltOutput}`);
    }
    return `${lines.join("\r\n")}\r\n`;
  }

  public static renderDirectoryIni(options: {
    inputDir: string;
    responseDir?: string;
    database: string;
    checkDuplicity: boolean;
    formatOutput?: boolean;
    actionAfterProcessing?: "" | "0" | "1" | "2";
    moveTo?: string;
  }): string {
    const action = options.actionAfterProcessing ?? "";
    if (action !== "" && !["0", "1", "2"].includes(action)) {
      throw new Error("actionAfterProcessing must be empty or one of 0, 1, 2.");
    }
    if (action === "2" && !options.moveTo) {
      throw new Error("Move_to is required when actionAfterProcessing is 2.");
    }
    const lines = ["[XML]", `input_dir=${options.inputDir}`];
    if (options.responseDir) {
      lines.push(`response_dir=${options.responseDir}`);
    }
    if (options.database !== "") {
      lines.push(`database=${options.database}`);
    }
    lines.push(`check_duplicity=${options.checkDuplicity ? "1" : "0"}`);
    lines.push(`format_output=${options.formatOutput ? "1" : "0"}`);
    if (action !== "") {
      lines.push(`action_after_processing=${action}`);
    }
    if (options.moveTo) {
      lines.push(`Move_to=${options.moveTo}`);
    }
    return `${lines.join("\r\n")}\r\n`;
  }

  private async runLocked(xml: string, database: string, queueWaitMs: number, options: TransportOptions): Promise<CliXmlJobResult> {
    const jobId = `${timestamp()}-${randomBytes(4).toString("hex")}`;
    const jobDir = join(this.config.workDir, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });

    const requestXml = join(jobDir, "request.xml");
    const responseXml = join(jobDir, "response.xml");
    const iniPath = join(jobDir, "xml_imp.ini");
    const metadataPath = join(jobDir, "metadata.json");
    const stdoutPath = join(jobDir, "stdout.log");
    const stderrPath = join(jobDir, "stderr.log");
    await writeAtomicBuffer(requestXml, iconv.encode(xml, "win1250"));
    await writeAtomic(iniPath, CliXmlTransport.renderIni({
      inputXml: requestXml,
      responseXml,
      database,
      checkDuplicity: options.checkDuplicity ?? this.checkDuplicity,
      formatOutput: Boolean(options.formatOutput),
      xsltInput: String(options.xsltInput ?? ""),
      xsltOutput: String(options.xsltOutput ?? "")
    }));

    const command = [this.config.exePath, "/XML", this.config.username, this.config.password, iniPath];
    const timeoutSeconds = Number(options.timeoutSeconds ?? this.timeoutSeconds);
    const started = performance.now();
    let exitCode = -1;
    let processError = "";
    let slotWaitMs = 0;
    try {
      const slotStarted = performance.now();
      exitCode = await this.withProcessSlot(timeoutSeconds * 1000, async () => {
        slotWaitMs = Math.round(performance.now() - slotStarted);
        return this.processRunner({
          command,
          cwd: this.config.exePath ? dirname(this.config.exePath) : process.cwd(),
          timeoutMs: timeoutSeconds * 1000,
          stdoutPath,
          stderrPath,
          responseXml,
          database
        });
      });
    } catch (error) {
      processError = error instanceof Error ? error.message : String(error);
    }
    const durationMs = Math.round(performance.now() - started);
    const response = existsSync(responseXml) ? iconv.decode(await readFile(responseXml), "win1250") : "";
    const metadata = {
      jobId,
      database,
      queueWaitMs,
      processSlotWaitMs: slotWaitMs,
      durationMs,
      exitCode,
      processError,
      requestXml,
      responseXml,
      iniPath,
      stdoutPath,
      stderrPath,
      createdAt: new Date().toISOString()
    };
    await writeAtomic(metadataPath, JSON.stringify(metadata, null, 2));

    if (processError !== "" || response.trim() === "") {
      if (!this.keepFailedJobs) {
        await rm(jobDir, { recursive: true, force: true });
      }
      const stderr = existsSync(stderrPath) ? (await readFile(stderrPath, "utf8")).trim() : "";
      const stdout = existsSync(stdoutPath) ? (await readFile(stdoutPath, "utf8")).trim() : "";
      throw new Error(`Pohoda /XML job failed (jobId=${jobId}, exitCode=${exitCode}, durationMs=${durationMs}, queueWaitMs=${queueWaitMs}, processSlotWaitMs=${slotWaitMs}).`
        + (processError ? ` error: ${processError}` : "")
        + (stderr ? ` stderr: ${stderr}` : "")
        + (stdout ? ` stdout: ${stdout}` : "")
        + ` Job directory: ${jobDir}`);
    }

    const result = { xml: response, jobId, database, jobDir, queueWaitMs, processSlotWaitMs: slotWaitMs, durationMs, exitCode, jobRetained: this.keepSuccessfulJobs };
    if (!this.keepSuccessfulJobs) {
      await rm(jobDir, { recursive: true, force: true });
    }
    return result;
  }

  private async ensureRuntimeDirs(): Promise<void> {
    await Promise.all([
      this.config.workDir,
      join(this.config.workDir, "locks"),
      join(this.config.workDir, "process-slots"),
      join(this.config.workDir, "jobs")
    ].map((dir) => mkdir(dir, { recursive: true })));
  }

  private lockPath(database: string): string {
    const key = database === "" ? "__accounting_units__" : database;
    return join(this.config.workDir, "locks", `${createHash("sha256").update(key).digest("hex")}.lock`);
  }

  private async withProcessSlot<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
      for (let i = 0; i < this.maxParallelProcesses; i++) {
        const path = join(this.config.workDir, "process-slots", `slot-${i}.lock`);
        try {
          return await withLock(path, 1, fn);
        } catch (error) {
          if (!String(error).includes("Lock file is already being held")) {
            throw error;
          }
        }
      }
      await sleep(25);
    }
    throw new Error(`Timed out waiting for a POHODA /XML process slot (maxParallelProcesses=${this.maxParallelProcesses}).`);
  }
}

export async function defaultProcessRunner(context: ProcessRunnerContext): Promise<number> {
  if (!existsSync(context.command[0] ?? "")) {
    throw new Error(context.command[0] ? `Pohoda executable not found: ${context.command[0]}` : "POHODA_EXE_PATH is required for XML transport.");
  }
  if ((context.command[2] ?? "") === "") {
    throw new Error("POHODA_USERNAME is required for XML transport.");
  }
  const stdout = createWriteStream(context.stdoutPath);
  const stderr = createWriteStream(context.stderrPath);
  const stdoutDone = finished(stdout);
  const stderrDone = finished(stderr);
  const subprocess = spawn(context.command[0]!, context.command.slice(1), {
    cwd: context.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  subprocess.stdout?.pipe(stdout);
  subprocess.stderr?.pipe(stderr);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    subprocess.kill();
  }, context.timeoutMs);

  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      subprocess.once("error", (error) => {
        stdout.destroy();
        stderr.destroy();
        reject(error);
      });
      subprocess.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (timedOut) {
      throw new Error(`Pohoda process timed out after ${context.timeoutMs} ms.`);
    }
    return code ?? (signal ? -1 : 0);
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled([stdoutDone, stderrDone]);
  }
}

async function withLock<T>(path: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  await writeFile(path, "", { flag: "a" });
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: {
      retries: Math.max(0, Math.ceil(timeoutMs / 25)),
      factor: 1,
      minTimeout: 25,
      maxTimeout: 25
    }
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await writeAtomicBuffer(path, Buffer.from(content));
}

async function writeAtomicBuffer(path: string, content: Buffer): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, content);
  await rm(path, { force: true });
  await import("node:fs/promises").then(({ rename }) => rename(tmp, path));
}

function isWritableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
