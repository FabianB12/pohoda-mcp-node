import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export type XmlDatabase = {
  id: string;
  name: string;
  database: string;
  ico?: string;
  dic?: string;
  city?: string;
  personName?: string;
  street?: string;
  zip?: string;
  dateFrom?: string;
  dateTo?: string;
  unitType?: string;
  stateType?: string;
  path?: string;
  source: "registry" | "filesystem-guess" | "official-xml" | "direct";
  year?: number;
};

const registryItemSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().optional(),
  database: z.string().trim().min(1),
  ico: z.string().trim().optional(),
  dic: z.string().trim().optional(),
  city: z.string().trim().optional(),
  personName: z.string().trim().optional(),
  street: z.string().trim().optional(),
  zip: z.string().trim().optional(),
  path: z.string().trim().optional(),
  year: z.number().int().optional()
});

export class XmlDatabaseRegistry {
  public constructor(private readonly options: { registryPath?: string; dataDir?: string } = {}) {}

  public async all(): Promise<XmlDatabase[]> {
    const byId = new Map<string, XmlDatabase>();
    for (const item of await this.fromRegistry()) {
      byId.set(item.id, item);
    }
    for (const item of await this.fromFilesystem()) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
    return [...byId.values()];
  }

  public async get(idOrDatabase: string): Promise<XmlDatabase> {
    for (const item of await this.all()) {
      if (item.id === idOrDatabase || item.database === idOrDatabase) {
        return item;
      }
    }
    throw new Error(`Unknown Pohoda XML database '${idOrDatabase}'. Use list_xml_databases first.`);
  }

  private async fromRegistry(): Promise<XmlDatabase[]> {
    const registryPath = this.options.registryPath ?? "";
    if (registryPath === "") {
      return [];
    }
    let json: string;
    try {
      json = await readFile(registryPath, "utf8");
    } catch (error) {
      throw new Error(`Pohoda XML database registry not found: ${registryPath}`, { cause: error });
    }
    const parsed: unknown = JSON.parse(json.replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed)) {
      throw new Error("Pohoda XML database registry must be a JSON array.");
    }
    return parsed.map((raw, index) => {
      const item = registryItemSchema.parse(raw);
      const id = item.id && item.id !== "" ? item.id : idFromDatabase(item.database);
      assertId(id);
      return compact({
        id,
        name: item.name && item.name !== "" ? item.name : item.database,
        database: item.database,
        ico: item.ico,
        dic: item.dic,
        city: item.city,
        personName: item.personName,
        street: item.street,
        zip: item.zip,
        path: item.path,
        year: item.year,
        source: "registry" as const
      }, `Pohoda XML database registry item #${index}`);
    });
  }

  private async fromFilesystem(): Promise<XmlDatabase[]> {
    const dataDir = this.options.dataDir ?? "";
    if (dataDir === "") {
      return [];
    }
    try {
      if (!(await stat(dataDir)).isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }
    const result: XmlDatabase[] = [];
    await walk(dataDir, async (path) => {
      const extension = path.split(".").pop()?.toLowerCase() ?? "";
      if (!["mdb", "accdb", "db", "sqlite"].includes(extension)) {
        return;
      }
      const database = path.split(/[\\/]/).pop() ?? path;
      if (database === "") {
        return;
      }
      const year = database.match(/(20\d{2})/)?.[1];
      result.push(compact({
        id: idFromDatabase(database),
        name: database,
        database,
        path,
        source: "filesystem-guess" as const,
        year: year ? Number(year) : undefined
      }, "filesystem database guess"));
    });
    return result;
  }
}

export function idFromDatabase(database: string): string {
  const id = database.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return id === "" ? createHash("sha256").update(database).digest("hex") : id;
}

function assertId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Pohoda XML database id '${id}' may contain only letters, numbers, dot, underscore, and dash.`);
  }
}

function compact<T extends Record<string, unknown>>(item: T, label: string): any {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value !== undefined && value !== "") {
      result[key] = value;
    }
  }
  if (typeof result.database !== "string" || result.database === "") {
    throw new Error(`${label} is missing 'database'.`);
  }
  return result;
}

async function walk(dir: string, callback: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, callback);
    } else if (entry.isFile()) {
      await callback(path);
    }
  }
}
