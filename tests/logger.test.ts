import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger", () => {
  const originalEnv = process.env.LOG_LEVEL;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.env.LOG_LEVEL = originalEnv;
    vi.resetModules();
  });

  async function importLogger() {
    const mod = await import("../src/logger.js");
    return mod.logger;
  }

  it("logs at info level by default", async () => {
    delete process.env.LOG_LEVEL;
    const logger = await importLogger();
    logger.info("test", "hello world");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const output = consoleErrorSpy.mock.calls[0][0] as string;
    expect(output).toContain("[INFO]");
    expect(output).toContain("[test]");
    expect(output).toContain("hello world");
  });

  it("includes timestamp in output", async () => {
    delete process.env.LOG_LEVEL;
    const logger = await importLogger();
    logger.info("tag", "message");
    const output = consoleErrorSpy.mock.calls[0][0] as string;
    // ISO 8601 timestamp pattern
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes JSON data when provided", async () => {
    delete process.env.LOG_LEVEL;
    const logger = await importLogger();
    logger.warn("tag", "something", { count: 42 });
    const output = consoleErrorSpy.mock.calls[0][0] as string;
    expect(output).toContain("[WARN]");
    expect(output).toContain('"count":42');
  });

  it("uses console.error for all levels", async () => {
    process.env.LOG_LEVEL = "debug";
    const logger = await importLogger();
    logger.debug("t", "d");
    logger.info("t", "i");
    logger.warn("t", "w");
    logger.error("t", "e");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(4);
  });

  it("suppresses debug when level is info", async () => {
    delete process.env.LOG_LEVEL;
    const logger = await importLogger();
    logger.debug("test", "should not appear");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
