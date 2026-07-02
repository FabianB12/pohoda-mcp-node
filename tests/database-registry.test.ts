import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { XmlDatabaseRegistry } from "../src/pohoda/database-registry.js";

describe("XmlDatabaseRegistry", () => {
  it("loads explicit registry entries and resolves by id or database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-registry-"));
    try {
      const path = join(dir, "databases.json");
      await writeFile(path, JSON.stringify([
        { id: "client-a", name: "Client A", database: "StwPh_12345678_2026", ico: "12345678", year: 2026 }
      ]));

      const registry = new XmlDatabaseRegistry({ registryPath: path });
      expect((await registry.get("client-a")).database).toBe("StwPh_12345678_2026");
      expect((await registry.get("StwPh_12345678_2026")).name).toBe("Client A");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers database-like files as fallback guesses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-data-"));
    try {
      await mkdir(join(dir, "Data"));
      await writeFile(join(dir, "Data", "StwPh_87654321_2025.mdb"), "");
      await writeFile(join(dir, "Data", "ignore.txt"), "");

      const registry = new XmlDatabaseRegistry({ dataDir: dir });
      const items = await registry.all();
      expect(items).toHaveLength(1);
      expect(items[0]?.database).toBe("StwPh_87654321_2025.mdb");
      expect(items[0]?.source).toBe("filesystem-guess");
      expect(items[0]?.year).toBe(2025);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refreshes registry and filesystem data on each lookup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-refresh-"));
    try {
      const registryPath = join(dir, "databases.json");
      const dataDir = join(dir, "Data");
      await mkdir(dataDir);
      await writeFile(registryPath, JSON.stringify([
        { id: "client-a", name: "Client A", database: "StwPh_11111111_2026.mdb", ico: "11111111", year: 2026 }
      ]));
      const registry = new XmlDatabaseRegistry({ registryPath, dataDir });

      expect((await registry.all()).map((item) => item.database)).toEqual(["StwPh_11111111_2026.mdb"]);

      await writeFile(registryPath, JSON.stringify([
        { id: "client-a", name: "Client A renamed", database: "StwPh_11111111_2026.mdb", ico: "11111111", year: 2026 }
      ]));
      await writeFile(join(dataDir, "StwPh_22222222_2026.mdb"), "");

      const refreshed = await registry.all();
      expect(refreshed.map((item) => item.database).sort()).toEqual(["StwPh_11111111_2026.mdb", "StwPh_22222222_2026.mdb"]);
      expect((await registry.get("client-a")).name).toBe("Client A renamed");
      expect((await registry.get("StwPh_22222222_2026.mdb")).source).toBe("filesystem-guess");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid registry shapes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pohoda-registry-"));
    try {
      const path = join(dir, "databases.json");
      await writeFile(path, JSON.stringify([{ id: "bad id", database: "Db" }]));
      await expect(new XmlDatabaseRegistry({ registryPath: path }).all()).rejects.toThrow(/may contain only/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
