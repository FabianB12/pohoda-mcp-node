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
  error?: string;
};

const options = optionsFromEnv();
if (!options) {
  throw new Error("Set POHODA_UTM_VM=Windows to run the real POHODA benchmark.");
}

const iterations = Math.max(1, Number(process.env.POHODA_BENCH_ITERATIONS ?? 5));
const workDir = await mkdtemp(join(tmpdir(), "pohoda-utm-bench-"));
const runner = createUtmProcessRunner(options);
const transport = new CliXmlTransport({
  exePath: options.exePath,
  username: options.username,
  password: options.password,
  workDir,
  checkDuplicity: false,
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
  const accounting = await measure("accounting_units:cold", () => client.listAccountingUnits());
  const units = extractAccountingUnits(assertOk(accounting), 100);
  const database = options.database || units[0]?.database || "";
  if (database === "") {
    throw new Error("No POHODA database discovered.");
  }
  client.setContext(database, units.find((unit) => unit.database === database)?.ico ?? options.ico);

  await measure("stock:warmup", () => client.listRecords("stock", {}, "", { count: 1 }));
  for (let i = 0; i < iterations; i++) {
    await measure(`stock:sequential:${i + 1}`, () => client.listRecords("stock", {}, "", { count: 1 }));
  }
  for (let i = 0; i < iterations; i++) {
    await measure(`contacts:sequential:${i + 1}`, () => client.listRecords("addressbook", {}, "", { count: 1 }));
  }

  const stockXml = '<lStk:listStockRequest version="2.0" stockVersion="2.0"><lStk:limit><ftr:count>1</ftr:count></lStk:limit><lStk:requestStock/></lStk:listStockRequest>';
  const contactsXml = '<lAdb:listAddressBookRequest version="2.0" addressBookVersion="2.0"><lAdb:limit><ftr:count>1</ftr:count></lAdb:limit><lAdb:requestAddressBook/></lAdb:listAddressBookRequest>';
  const storeXml = '<lst:listStoreRequest version="2.0" storeVersion="2.0"><lst:limit><ftr:count>1</ftr:count></lst:limit><lst:requestStore/></lst:listStoreRequest>';

  await measure("raw_batch:stock_contacts_store", () => client.sendRawXmlBatch([stockXml, contactsXml, storeXml], "benchmark batch", "bench-batch", {
    databaseOverride: database,
    checkDuplicity: false
  }));

  const concurrent = await Promise.all([
    measure("stock:concurrent_same_db:1", () => client.listRecords("stock", {}, "", { count: 1 })),
    measure("stock:concurrent_same_db:2", () => client.listRecords("stock", {}, "", { count: 1 })),
    measure("stock:concurrent_same_db:3", () => client.listRecords("stock", {}, "", { count: 1 }))
  ]);
  for (const response of concurrent) {
    assertOk(response);
  }

  const report = buildReport(metrics, { database, iterations });
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
    jobId: String(transportData.jobId ?? "")
  };
}

function buildReport(metrics: Metric[], meta: Record<string, unknown>): Record<string, unknown> {
  const successful = metrics.filter((metric) => metric.ok);
  const byPrefix = Object.fromEntries([...new Set(successful.map((metric) => metric.name.split(":").slice(0, 2).join(":")))]
    .map((prefix) => [prefix, summarize(successful.filter((metric) => metric.name.startsWith(prefix)))])
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
      byPrefix
    },
    metrics
  };
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
    maxProcessSlotWaitMs: Math.max(0, ...items.map((item) => item.processSlotWaitMs))
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}
