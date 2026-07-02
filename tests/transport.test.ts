import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliXmlTransport, defaultProcessRunner } from "../src/pohoda/transport.js";

const retainedDirs: string[] = [];

afterEach(async () => {
  await Promise.all(retainedDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CliXmlTransport", () => {
  it("renders official single-file INI fields", () => {
    expect(CliXmlTransport.renderIni({
      inputXml: "C:\\job\\request.xml",
      responseXml: "C:\\job\\response.xml",
      database: "StwPh_12345678_2026",
      checkDuplicity: true,
      formatOutput: false
    })).toBe("[XML]\r\n"
      + "input_xml=C:\\job\\request.xml\r\n"
      + "response_xml=C:\\job\\response.xml\r\n"
      + "database=StwPh_12345678_2026\r\n"
      + "check_duplicity=1\r\n"
      + "format_output=0\r\n");
  });

  it("omits database in no-database mode and includes XSLT fields only when configured", () => {
    const ini = CliXmlTransport.renderIni({
      inputXml: "in.xml",
      responseXml: "out.xml",
      database: "",
      checkDuplicity: false,
      formatOutput: false,
      xsltInput: "in.xslt",
      xsltOutput: "out.xslt"
    });

    expect(ini).not.toContain("database=");
    expect(ini).toContain("check_duplicity=0\r\n");
    expect(ini).toContain("XSLT_input=in.xslt\r\n");
    expect(ini).toContain("XSLT_output=out.xslt\r\n");
  });

  it("renders and validates directory INI mode", () => {
    expect(CliXmlTransport.renderDirectoryIni({
      inputDir: "C:\\in",
      responseDir: "C:\\out",
      database: "Db",
      checkDuplicity: true,
      actionAfterProcessing: "2",
      moveTo: "C:\\done"
    })).toContain("action_after_processing=2\r\nMove_to=C:\\done\r\n");

    expect(() => CliXmlTransport.renderDirectoryIni({
      inputDir: "C:\\in",
      database: "Db",
      checkDuplicity: true,
      actionAfterProcessing: "2"
    })).toThrow(/Move_to/);
  });

  it("writes isolated job files and parses a mocked Pohoda response", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pohoda-xml-"));
    retainedDirs.push(workDir);

    const transport = new CliXmlTransport({
      exePath: process.execPath,
      username: "Admin",
      password: "secret",
      workDir,
      keepSuccessfulJobs: true,
      processRunner: async ({ responseXml }) => {
        await writeFile(responseXml, '<rsp:responsePack state="ok" programVersion="x" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" />');
        return 0;
      }
    });

    const result = await transport.exchange("<xml />", "Db");
    expect(result.xml).toContain('state="ok"');
    expect(result.database).toBe("Db");
    expect(result.jobRetained).toBe(true);
    expect(existsSync(join(result.jobDir, "request.xml"))).toBe(true);
    expect(await readFile(join(result.jobDir, "xml_imp.ini"), "utf8")).toContain("database=Db");
  });

  it("writes request XML and decodes response XML as Windows-1250", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pohoda-xml-"));
    retainedDirs.push(workDir);
    const iconv = await import("iconv-lite");
    const responseNote = "Nov\u00e1k";
    const requestText = "\u017dlu\u0165ou\u010dk\u00fd k\u016f\u0148";
    const transport = new CliXmlTransport({
      exePath: process.execPath,
      username: "Admin",
      password: "",
      workDir,
      keepSuccessfulJobs: true,
      processRunner: async ({ responseXml }) => {
        await writeFile(responseXml, iconv.default.encode(`<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:responsePackItem id="i1" state="ok"><rsp:note>${responseNote}</rsp:note></rsp:responsePackItem></rsp:responsePack>`, "win1250"));
        return 0;
      }
    });

    const result = await transport.exchange(`<?xml version="1.0" encoding="Windows-1250"?><x>${requestText}</x>`, "Db");
    expect((await readFile(join(result.jobDir, "request.xml"))).includes(iconv.default.encode("\u017d", "win1250"))).toBe(true);
    expect(result.xml).toContain(responseNote);
  });

  it("serializes same-database calls while allowing different databases up to the global cap", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pohoda-xml-"));
    retainedDirs.push(workDir);
    const events: string[] = [];
    const activeByDatabase = new Map<string, number>();
    let activeTotal = 0;
    let maxActiveTotal = 0;
    let maxActiveSame = 0;
    const releaseFirstSame = deferred<void>();
    const releaseDifferentDatabase = deferred<void>();
    let firstSameStarted = false;

    const transport = new CliXmlTransport({
      exePath: process.execPath,
      username: "Admin",
      password: "",
      workDir,
      maxParallelProcesses: 2,
      keepSuccessfulJobs: false,
      processRunner: async ({ database, responseXml }) => {
        events.push(`start:${database}`);
        activeTotal += 1;
        activeByDatabase.set(database, (activeByDatabase.get(database) ?? 0) + 1);
        maxActiveTotal = Math.max(maxActiveTotal, activeTotal);
        maxActiveSame = Math.max(maxActiveSame, activeByDatabase.get("Same") ?? 0);
        if (database === "Same" && !firstSameStarted) {
          firstSameStarted = true;
          await releaseFirstSame.promise;
        } else if (database !== "Same") {
          await releaseDifferentDatabase.promise;
        }
        activeByDatabase.set(database, (activeByDatabase.get(database) ?? 1) - 1);
        activeTotal -= 1;
        events.push(`end:${database}`);
        await writeFile(responseXml, '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" />');
        return 0;
      }
    });

    const firstSame = transport.exchange("<a />", "Same");
    let other: Promise<unknown> | undefined;
    let secondSame: Promise<unknown> | undefined;
    let third: Promise<unknown> | undefined;
    try {
      await waitFor(() => events.includes("start:Same"));
      other = transport.exchange("<c />", "Other");
      await waitFor(() => activeTotal === 2);

      secondSame = transport.exchange("<b />", "Same");
      third = transport.exchange("<d />", "Third");
      releaseFirstSame.resolve();
      releaseDifferentDatabase.resolve();
      await Promise.all([firstSame, secondSame, other, third]);
    } catch (error) {
      releaseFirstSame.resolve();
      releaseDifferentDatabase.resolve();
      await Promise.allSettled([firstSame, other, secondSame, third].filter(Boolean) as Promise<unknown>[]);
      throw error;
    }

    expect(events.indexOf("end:Same")).toBeLessThan(events.lastIndexOf("start:Same"));
    expect(events).toContain("start:Other");
    expect(events).toContain("start:Third");
    expect(maxActiveSame).toBe(1);
    expect(maxActiveTotal).toBe(2);
  });

  it("surfaces queue timeout for same-database lock contention", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pohoda-xml-"));
    retainedDirs.push(workDir);

    const transport = new CliXmlTransport({
      exePath: process.execPath,
      username: "Admin",
      password: "",
      workDir,
      queueTimeoutSeconds: 0.02,
      processRunner: async ({ responseXml }) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        await writeFile(responseXml, '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" />');
        return 0;
      }
    });

    await expect(Promise.all([
      transport.exchange("<a />", "Same"),
      transport.exchange("<b />", "Same")
    ])).rejects.toThrow(/queue lock/);
  });

  it("passes argv-style Pohoda command to the default runner", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pohoda-xml-"));
    retainedDirs.push(workDir);
    const runner = vi.fn(async ({ command, responseXml }) => {
      await writeFile(responseXml, '<rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" />');
      expect(command[1]).toBe("/XML");
      expect(command[2]).toBe("Admin");
      expect(command[3]).toBe("secret");
      expect(command[4]).toMatch(/xml_imp\.ini$/);
      return 0;
    });

    const transport = new CliXmlTransport({
      exePath: process.execPath,
      username: "Admin",
      password: "secret",
      workDir,
      processRunner: runner
    });

    await transport.exchange("<xml />", "Db");
    expect(runner).toHaveBeenCalledOnce();
  });

  it("default runner waits for spawned process and pipes stdout and stderr to files", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pohoda-runner-"));
    retainedDirs.push(workDir);
    const scriptPath = join(workDir, "child.mjs");
    const responseXml = join(workDir, "response.xml");
    const stdoutPath = join(workDir, "stdout.log");
    const stderrPath = join(workDir, "stderr.log");
    await writeFile(scriptPath, [
      "import { writeFile } from 'node:fs/promises';",
      "await new Promise((resolve) => setTimeout(resolve, 75));",
      "console.log('stdout-ready');",
      "console.error('stderr-ready');",
      `await writeFile(${JSON.stringify(responseXml)}, '<rsp:responsePack state=\"ok\" />');`
    ].join("\n"));

    const started = performance.now();
    const exitCode = await defaultProcessRunner({
      command: [process.execPath, scriptPath, "Admin"],
      cwd: workDir,
      timeoutMs: 5_000,
      stdoutPath,
      stderrPath,
      responseXml,
      database: "Db"
    });

    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(exitCode).toBe(0);
    expect(await readFile(responseXml, "utf8")).toContain('state="ok"');
    expect(await readFile(stdoutPath, "utf8")).toContain("stdout-ready");
    expect(await readFile(stderrPath, "utf8")).toContain("stderr-ready");
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for transport test condition. Events did not reach expected state.`);
}
