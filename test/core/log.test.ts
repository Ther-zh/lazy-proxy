import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLogger, makeConsoleLogger, openCoreLog, shouldLog } from "../../src/core/log";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lazyproxy-log-"));
}

describe("shouldLog", () => {
  it("respects level ordering", () => {
    expect(shouldLog("info", "debug")).toBe(false);
    expect(shouldLog("info", "info")).toBe(true);
    expect(shouldLog("error", "warn")).toBe(false);
    expect(shouldLog("debug", "error")).toBe(true);
  });
});

describe("createFileLogger", () => {
  it("appends timestamped leveled lines and filters below the minimum level", () => {
    const dir = tempDir();
    const file = join(dir, "lazyproxy.log");
    const log = createFileLogger(file, "info");
    log("debug", "hidden");
    log("info", "hello");
    log("error", "boom");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("INFO hello");
    expect(text).toContain("ERROR boom");
    expect(text).not.toContain("hidden");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotates the file when it exceeds the size cap", () => {
    const dir = tempDir();
    const file = join(dir, "lazyproxy.log");
    const log = createFileLogger(file, "info", 60);
    log("info", "first-message-that-is-long-enough-to-cross-the-cap");
    log("info", "second");
    expect(statSync(`${file}.1`).size).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toContain("second");
    rmSync(dir, { recursive: true, force: true });
  });

  it("swallows filesystem errors instead of throwing", () => {
    const bad = join("Z:\\definitely-missing\\drive", "x.log");
    const log = createFileLogger(bad, "debug");
    expect(() => log("info", "noop")).not.toThrow();
  });
});

describe("openCoreLog", () => {
  it("opens an append fd and creates the file", () => {
    const dir = tempDir();
    const fd = openCoreLog(dir);
    expect(fd).not.toBeNull();
    writeFileSync(join(dir, "core.log"), "seed\n", { flag: "a" });
    rmSync(dir, { recursive: true, force: true });
    expect(fd).toBeTypeOf("number");
  });
});

describe("makeConsoleLogger", () => {
  it("returns a callable filtered logger", () => {
    const log = makeConsoleLogger("error");
    expect(() => log("info", "suppressed")).not.toThrow();
  });
});
