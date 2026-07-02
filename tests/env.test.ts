import { describe, expect, it } from "vitest";
import { createConfigFromEnv } from "../src/config/env.js";

describe("createConfigFromEnv", () => {
  it("preserves explicit false-like environment values", () => {
    const config = createConfigFromEnv({
      POHODA_EXE_PATH: "C:\\Pohoda\\Pohoda.exe",
      POHODA_USERNAME: "Admin",
      POHODA_XML_CHECK_DUPLICITY: "0",
      POHODA_XML_KEEP_FAILED_JOBS: "0",
      POHODA_XML_KEEP_SUCCESSFUL_JOBS: "1",
      POHODA_XML_MAX_PARALLEL_PROCESSES: "8"
    }, "C:\\server");

    expect(config.transport.checkDuplicity).toBe(false);
    expect(config.transport.keepFailedJobs).toBe(false);
    expect(config.transport.keepSuccessfulJobs).toBe(true);
    expect(config.transport.maxParallelProcesses).toBe(8);
  });

  it("supports POHODA_DATABASE overriding POHODA_DEFAULT_DATABASE", () => {
    const config = createConfigFromEnv({
      POHODA_DATABASE: "Current",
      POHODA_DEFAULT_DATABASE: "Default"
    }, "/srv/xml");

    expect(config.database).toBe("Current");
  });
});
