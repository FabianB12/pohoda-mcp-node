import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ExportRecord = {
  index: number;
  id: number | string;
  number: string;
  date: string;
  partner: string;
  ico: string;
  text: string;
  total: number;
  currency: string;
  homeCurrency?: CurrencyTotal;
  foreignCurrency?: CurrencyTotal;
  raw: Record<string, any>;
};

export type CurrencyTotal = {
  currency: string;
  total: number;
};

export type ExportSummary = {
  count: number;
  homeCurrency: CurrencyTotal;
  foreignCurrency: Record<string, { count: number; total: number }>;
  total: number;
  byCurrency: Record<string, { count: number; total: number }>;
  byPartner: Record<string, { count: number; total: number }>;
  byMonth: Record<string, { count: number; total: number }>;
};

export type ExportSnapshot = {
  exportId: string;
  kind: string;
  agenda: string;
  subtype: string;
  database: string;
  ico: string;
  createdAt: string;
  expiresAt: string;
  filters: Record<string, unknown>;
  paging: {
    requestedPageSize: number;
    maxRecords: number;
    fetchedPages: number;
    complete: boolean;
  };
  resources: ExportResources;
  summary: ExportSummary;
  records: ExportRecord[];
};

export type ExportResources = {
  metadata: string;
  recordsJson: string;
  recordsNdjson: string;
  summaryJson: string;
};

export type ExportPage = {
  exportId: string;
  offset: number;
  limit: number;
  returned: number;
  total: number;
  nextCursor: string;
  records: ExportRecord[];
  resources: ExportResources;
  summary: ExportSummary;
};

export class ExportStore {
  public constructor(private readonly baseDir: string, private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  public async save(input: Omit<ExportSnapshot, "exportId" | "createdAt" | "expiresAt" | "resources"> & { exportId?: string }): Promise<ExportSnapshot> {
    await mkdir(this.baseDir, { recursive: true });
    const now = new Date();
    const exportId = input.exportId ?? this.createId(input);
    const resources = resourcesFor(exportId);
    const snapshot: ExportSnapshot = {
      ...input,
      exportId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      resources
    };
    await this.writeSnapshot(snapshot);
    return snapshot;
  }

  public async get(exportId: string): Promise<ExportSnapshot> {
    assertExportId(exportId);
    const raw = JSON.parse(await readFile(this.snapshotPath(exportId), "utf8")) as ExportSnapshot;
    if (Date.parse(raw.expiresAt) < Date.now()) {
      await this.delete(exportId);
      throw new Error(`Export '${exportId}' has expired. Create a new export.`);
    }
    return raw;
  }

  public async page(exportId: string, cursor = "", limit = 50): Promise<ExportPage> {
    const snapshot = await this.get(exportId);
    const offset = cursor === "" ? 0 : decodeCursor(cursor, exportId);
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const records = snapshot.records.slice(offset, offset + safeLimit);
    const nextOffset = offset + records.length;
    return {
      exportId,
      offset,
      limit: safeLimit,
      returned: records.length,
      total: snapshot.records.length,
      nextCursor: nextOffset < snapshot.records.length ? encodeCursor(exportId, nextOffset) : "",
      records,
      resources: snapshot.resources,
      summary: snapshot.summary
    };
  }

  public async readResource(exportId: string, file: string): Promise<{ mimeType: string; text: string }> {
    assertExportId(exportId);
    const allowed = new Set(["metadata.json", "records.json", "records.ndjson", "summary.json"]);
    if (!allowed.has(file)) {
      throw new Error(`Unknown export resource '${file}'.`);
    }
    const path = join(this.exportDir(exportId), file);
    return {
      mimeType: file.endsWith(".ndjson") ? "application/x-ndjson" : "application/json",
      text: await readFile(path, "utf8")
    };
  }

  public async delete(exportId: string): Promise<void> {
    assertExportId(exportId);
    await rm(this.exportDir(exportId), { recursive: true, force: true });
  }

  private async writeSnapshot(snapshot: ExportSnapshot): Promise<void> {
    const dir = this.exportDir(snapshot.exportId);
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, "metadata.json"), {
      ...snapshot,
      records: undefined
    });
    await writeJson(join(dir, "records.json"), snapshot.records);
    await writeFile(join(dir, "records.ndjson"), `${snapshot.records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await writeJson(join(dir, "summary.json"), snapshot.summary);
    await writeJson(this.snapshotPath(snapshot.exportId), snapshot);
  }

  private createId(input: { kind: string; agenda: string; database: string; filters: Record<string, unknown> }): string {
    const digest = createHash("sha256").update(JSON.stringify({
      kind: input.kind,
      agenda: input.agenda,
      database: input.database,
      filters: input.filters,
      nonce: randomBytes(8).toString("hex")
    })).digest("hex").slice(0, 16);
    return `exp_${digest}`;
  }

  private exportDir(exportId: string): string {
    return join(this.baseDir, exportId);
  }

  private snapshotPath(exportId: string): string {
    return join(this.exportDir(exportId), "snapshot.json");
  }
}

export function resourcesFor(exportId: string): ExportResources {
  return {
    metadata: `pohoda://exports/${exportId}/metadata.json`,
    recordsJson: `pohoda://exports/${exportId}/records.json`,
    recordsNdjson: `pohoda://exports/${exportId}/records.ndjson`,
    summaryJson: `pohoda://exports/${exportId}/summary.json`
  };
}

export function summarizeRecords(records: ExportRecord[]): ExportSummary {
  const summary: ExportSummary = {
    count: records.length,
    homeCurrency: { currency: "CZK", total: 0 },
    foreignCurrency: {},
    total: 0,
    byCurrency: {},
    byPartner: {},
    byMonth: {}
  };
  for (const record of records) {
    const home = record.homeCurrency ?? { currency: record.currency || "CZK", total: Number.isFinite(record.total) ? record.total : 0 };
    const homeTotal = Number.isFinite(home.total) ? home.total : 0;
    summary.homeCurrency.currency = home.currency || summary.homeCurrency.currency || "CZK";
    summary.homeCurrency.total += homeTotal;
    summary.total += homeTotal;
    addBucket(summary.byCurrency, home.currency || "CZK", homeTotal);
    addBucket(summary.byPartner, record.partner || "(unknown)", homeTotal);
    addBucket(summary.byMonth, monthOf(record.date), homeTotal);
    if (record.foreignCurrency && record.foreignCurrency.currency !== "") {
      addBucket(summary.foreignCurrency, record.foreignCurrency.currency, record.foreignCurrency.total);
    }
  }
  summary.total = round2(summary.total);
  summary.homeCurrency.total = round2(summary.homeCurrency.total);
  return summary;
}

export function encodeCursor(exportId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ exportId, offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, expectedExportId: string): number {
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid export cursor.");
  }
  if (parsed?.exportId !== expectedExportId || !Number.isInteger(parsed?.offset) || parsed.offset < 0) {
    throw new Error("Invalid export cursor.");
  }
  return parsed.offset;
}

function addBucket(target: Record<string, { count: number; total: number }>, key: string, total: number): void {
  target[key] ??= { count: 0, total: 0 };
  target[key].count += 1;
  target[key].total = round2(target[key].total + total);
}

function monthOf(date: string): string {
  return /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : "(unknown)";
}

function assertExportId(exportId: string): void {
  if (!/^exp_[A-Fa-f0-9]{16}$/.test(exportId)) {
    throw new Error(`Invalid export id '${exportId}'.`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
