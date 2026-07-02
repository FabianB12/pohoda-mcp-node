import { join } from "node:path";
import type { CliXmlTransportConfig } from "../pohoda/transport.js";

export type RuntimeConfig = {
  transport: Omit<CliXmlTransportConfig, "processRunner">;
  ico: string;
  database: string;
  databasesFile: string;
  dataDir: string;
};

export function createConfigFromEnv(env: NodeJS.ProcessEnv = process.env, baseDir = process.cwd()): RuntimeConfig {
  const get = (name: string, fallback = ""): string => env[name] ?? fallback;
  const getInt = (name: string, fallback: number): number => {
    const value = env[name];
    return value === undefined || value === "" ? fallback : Number.parseInt(value, 10);
  };
  const getBool = (name: string, fallback: boolean): boolean => {
    const value = env[name];
    if (value === undefined || value === "") {
      return fallback;
    }
    if (/^(1|true|yes|on)$/i.test(value)) {
      return true;
    }
    if (/^(0|false|no|off)$/i.test(value)) {
      return false;
    }
    return fallback;
  };

  return {
    transport: {
      exePath: get("POHODA_EXE_PATH"),
      username: get("POHODA_USERNAME"),
      password: get("POHODA_PASSWORD"),
      workDir: get("POHODA_XML_WORK_DIR", join(baseDir, "var", "xml")),
      timeoutSeconds: Math.max(1, getInt("POHODA_XML_TIMEOUT", 120)),
      checkDuplicity: getBool("POHODA_XML_CHECK_DUPLICITY", true),
      keepSuccessfulJobs: getBool("POHODA_XML_KEEP_SUCCESSFUL_JOBS", false),
      keepFailedJobs: getBool("POHODA_XML_KEEP_FAILED_JOBS", true),
      maxParallelProcesses: Math.max(1, getInt("POHODA_XML_MAX_PARALLEL_PROCESSES", 4)),
      queueTimeoutSeconds: Math.max(0.001, Number(env.POHODA_XML_QUEUE_TIMEOUT ?? 300))
    },
    ico: get("POHODA_ICO"),
    database: get("POHODA_DATABASE", get("POHODA_DEFAULT_DATABASE")),
    databasesFile: get("POHODA_XML_DATABASES_FILE"),
    dataDir: get("POHODA_DATA_DIR")
  };
}
