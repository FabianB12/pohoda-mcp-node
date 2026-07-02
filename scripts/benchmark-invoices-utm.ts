import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PohodaClient } from "../src/pohoda/client.js";
import type { PohodaResponse } from "../src/pohoda/response.js";
import { CliXmlTransport } from "../src/pohoda/transport.js";
import { assertOk, extractAccountingUnits } from "../src/mcp/tools.js";
import { createUtmProcessRunner, optionsFromEnv } from "../tests/support/utm-pohoda.js";

type Metric = {
  name: string;
  ok: boolean;
  wallMs: number;
  transportDurationMs: number;
  queueWaitMs: number;
  processSlotWaitMs: number;
  jobId: string;
  responseItemCount: number;
  exportedRecordCount: number;
  error?: string;
};

const options = optionsFromEnv();
if (!options) {
  throw new Error("Set POHODA_UTM_VM=Windows to run the invoice benchmark.");
}

const iterations = Math.max(1, Number(process.env.POHODA_BENCH_ITERATIONS ?? 5));
const createIterations = Math.max(0, Number(process.env.POHODA_BENCH_CREATE_ITERATIONS ?? iterations));
const readCount = Math.max(1, Number(process.env.POHODA_BENCH_READ_COUNT ?? 10));
const workDir = await mkdtemp(join(tmpdir(), "pohoda-utm-invoice-bench-"));
const runner = createUtmProcessRunner(options);
const transport = new CliXmlTransport({
  exePath: options.exePath,
  username: options.username,
  password: options.password,
  workDir,
  checkDuplicity: true,
  keepSuccessfulJobs: false,
  keepFailedJobs: true,
  maxParallelProcesses: Math.max(1, Number(process.env.POHODA_XML_MAX_PARALLEL_PROCESSES ?? 4)),
  queueTimeoutSeconds: Math.max(1, Number(process.env.POHODA_XML_QUEUE_TIMEOUT ?? 300)),
  timeoutSeconds: Math.max(1, Math.ceil(options.timeoutMs / 1000)),
  processRunner: runner
});
const client = new PohodaClient({ transport, ico: options.ico, database: options.database });
const metrics: Metric[] = [];

try {
  const accounting = await measure("setup:accounting_units", () => client.listAccountingUnits());
  const units = extractAccountingUnits(assertOk(accounting), 100);
  const database = options.database || units[0]?.database || "";
  if (database === "") {
    throw new Error("No POHODA database discovered.");
  }
  client.setContext(database, units.find((unit) => unit.database === database)?.ico ?? options.ico);

  await measure("read_issued_invoice:warmup", () => client.listRecords("invoice", {}, "issuedInvoice", { count: 1 }));
  for (let i = 0; i < iterations; i++) {
    await measure(`read_issued_invoice:count1:${i + 1}`, () => client.listRecords("invoice", {}, "issuedInvoice", { count: 1 }));
  }
  for (let i = 0; i < iterations; i++) {
    await measure(`read_issued_invoice:count${readCount}:${i + 1}`, () => client.listRecords("invoice", {}, "issuedInvoice", { count: readCount }));
  }
  for (let i = 0; i < iterations; i++) {
    await measure(`read_received_invoice:count1:${i + 1}`, () => client.listRecords("invoice", {}, "receivedInvoice", { count: 1 }));
  }

  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  for (let i = 0; i < createIterations; i++) {
    const marker = `MCPBENCH-${stamp}-${String(i + 1).padStart(2, "0")}`;
    await measure(`create_issued_invoice:${i + 1}`, () => client.createInvoice({
      type: "issuedInvoice",
      partnerName: `${marker} Partner`,
      partnerIco: `78${stamp.slice(-6)}`,
      date: today(),
      dateTax: today(),
      dateAccounting: today(),
      dateDue: today(),
      text: `${marker} invoice benchmark`,
      note: "Created by automated MCP /XML invoice benchmark."
    }, [{
      text: `${marker} invoice item`,
      quantity: 1,
      unit: "ks",
      unitPrice: 123,
      vatRate: "high"
    }], `${marker}-invoice`, database));
  }

  if (createIterations > 0) {
    await measure("read_issued_invoice:after_create_count1", () => client.listRecords("invoice", {}, "issuedInvoice", { count: 1 }));
    await measure(`read_issued_invoice:after_create_count${readCount}`, () => client.listRecords("invoice", {}, "issuedInvoice", { count: readCount }));
  }

  const report = buildReport(metrics, { database, iterations, createIterations, readCount });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runner.cleanup();
  await rm(workDir, { recursive: true, force: true });
}

async function measure(name: string, fn: () => Promise<PohodaResponse>): Promise<PohodaResponse> {
  const started = performance.now();
  try {
    const response = await fn();
    const wallMs = Math.round(performance.now() - started);
    metrics.push(metricFromResponse(name, response, wallMs));
    assertOk(response);
    return response;
  } catch (error) {
    metrics.push({
      name,
      ok: false,
      wallMs: Math.round(performance.now() - started),
      transportDurationMs: 0,
      queueWaitMs: 0,
      processSlotWaitMs: 0,
      jobId: "",
      responseItemCount: 0,
      exportedRecordCount: 0,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function metricFromResponse(name: string, response: PohodaResponse, wallMs: number): Metric {
  const transportData = response.transport as Record<string, unknown>;
  return {
    name,
    ok: response.isOk(),
    wallMs,
    transportDurationMs: Number(transportData.durationMs ?? 0),
    queueWaitMs: Number(transportData.queueWaitMs ?? 0),
    processSlotWaitMs: Number(transportData.processSlotWaitMs ?? 0),
    jobId: String(transportData.jobId ?? ""),
    responseItemCount: response.items.length,
    exportedRecordCount: countExportedRecords(response)
  };
}

function countExportedRecords(response: PohodaResponse): number {
  let count = 0;
  for (const item of response.items) {
    for (const value of Object.values(item.data)) {
      if (Array.isArray(value)) {
        count += value.length;
      }
    }
  }
  return count;
}

function buildReport(metrics: Metric[], meta: Record<string, unknown>): Record<string, unknown> {
  const successful = metrics.filter((metric) => metric.ok);
  const byScenario = Object.fromEntries([...new Set(successful.map((metric) => scenarioName(metric.name)))]
    .map((scenario) => [scenario, summarize(successful.filter((metric) => scenarioName(metric.name) === scenario))])
    .filter(([, value]) => value.count > 0));
  return {
    meta: {
      ...meta,
      vm: options!.vm,
      generatedAt: new Date().toISOString()
    },
    summary: {
      total: metrics.length,
      ok: successful.length,
      failed: metrics.length - successful.length,
      byScenario
    },
    metrics
  };
}

function scenarioName(name: string): string {
  if (name.startsWith("read_issued_invoice:count1:")) {
    return "read_issued_invoice:count1";
  }
  if (name.startsWith("read_issued_invoice:count")) {
    return name.split(":").slice(0, 2).join(":");
  }
  if (name.startsWith("read_received_invoice:count1:")) {
    return "read_received_invoice:count1";
  }
  if (name.startsWith("create_issued_invoice:")) {
    return "create_issued_invoice";
  }
  return name;
}

function summarize(items: Metric[]): Record<string, number> {
  const wall = items.map((item) => item.wallMs).sort((a, b) => a - b);
  const transportDurations = items.map((item) => item.transportDurationMs).sort((a, b) => a - b);
  return {
    count: items.length,
    wallMinMs: wall[0] ?? 0,
    wallMedianMs: percentile(wall, 0.5),
    wallP95Ms: percentile(wall, 0.95),
    wallMaxMs: wall.at(-1) ?? 0,
    transportMedianMs: percentile(transportDurations, 0.5),
    maxQueueWaitMs: Math.max(0, ...items.map((item) => item.queueWaitMs)),
    maxProcessSlotWaitMs: Math.max(0, ...items.map((item) => item.processSlotWaitMs)),
    medianExportedRecordCount: percentile(items.map((item) => item.exportedRecordCount).sort((a, b) => a - b), 0.5)
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
