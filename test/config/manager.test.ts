import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, configFilePath, loadConfig, validateConfig } from "../../src/config/manager";
import { DEFAULTS, redactUrl } from "../../src/config/schema";

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lazyproxy-cfg-"));
  return d;
}

const valid = {
  subscriptionUrl: "https://sub.example.com/api/v1/client/subscribe?token=abc123",
};

describe("validateConfig", () => {
  it("rejects non-object", () => {
    expect(() => validateConfig(null)).toThrow(ConfigError);
    expect(() => validateConfig("x")).toThrow(ConfigError);
  });

  it("requires subscriptionUrl", () => {
    expect(() => validateConfig({})).toThrow(/subscriptionUrl/);
    expect(() => validateConfig({ subscriptionUrl: "  " })).toThrow(/subscriptionUrl/);
  });

  it("applies defaults and overrides", () => {
    const c = validateConfig({ ...valid, shimPort: 9999, idleMs: 5000 });
    expect(c.shimPort).toBe(9999);
    expect(c.idleMs).toBe(5000);
    expect(c.corePort).toBe(DEFAULTS.corePort);
    expect(c.upstream).toBe(DEFAULTS.upstream);
    expect(c.mihomoVersion).toBe(DEFAULTS.mihomoVersion);
    expect(c.logLevel).toBe(DEFAULTS.logLevel);
  });

  it("sanitizes bad values back to defaults", () => {
    const c = validateConfig({ ...valid, shimPort: -1, idleMs: "x", logLevel: "loud" });
    expect(c.shimPort).toBe(DEFAULTS.shimPort);
    expect(c.idleMs).toBe(DEFAULTS.idleMs);
    expect(c.logLevel).toBe(DEFAULTS.logLevel);
  });

  it("trims and keeps optional fields", () => {
    const c = validateConfig({ ...valid, corePath: " C:\\x\\mihomo.exe ", downloadBaseUrl: " https://mirror " });
    expect(c.corePath).toBe("C:\\x\\mihomo.exe");
    expect(c.downloadBaseUrl).toBe("https://mirror");
  });
});

describe("loadConfig", () => {
  it("writes defaults when missing", () => {
    const dir = tempDir();
    const c = loadConfig(dir);
    expect(c.subscriptionUrl).toBe("");
    expect(c.shimPort).toBe(DEFAULTS.shimPort);
    expect(existsSync(configFilePath(dir))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads existing valid config", () => {
    const dir = tempDir();
    writeFileSync(configFilePath(dir), JSON.stringify(valid), "utf8");
    const c = loadConfig(dir);
    expect(c.subscriptionUrl).toBe(valid.subscriptionUrl);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws on invalid JSON", () => {
    const dir = tempDir();
    writeFileSync(configFilePath(dir), "{nope", "utf8");
    expect(() => loadConfig(dir)).toThrow(/not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws on missing subscriptionUrl in existing file", () => {
    const dir = tempDir();
    writeFileSync(configFilePath(dir), JSON.stringify({}), "utf8");
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("redactUrl", () => {
  it("masks token query param", () => {
    expect(redactUrl("https://sub.example.com/api?token=abc123")).toBe(
      "https://sub.example.com/api?token=***",
    );
  });
  it("masks userinfo", () => {
    expect(redactUrl("http://u:p@proxy.example.com:8080")).toBe(
      "http://***:***@proxy.example.com:8080/",
    );
  });
  it("falls back on unparseable input", () => {
    expect(redactUrl("x?token=1&key=2").includes("***")).toBe(true);
  });
  it("keeps normal urls unchanged", () => {
    expect(redactUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
  });
});

describe("configFilePath", () => {
  it("points into the given dir", () => {
    expect(configFilePath("C:/x")).toBe(join("C:/x", "config.json"));
    expect(readFileSync).toBeTruthy();
  });
});
