import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LazyProxyPlugin } from "../../src/plugin/index";
import { resolveConfigDir, startLazyProxy } from "../../src/plugin/runtime";

describe("plugin entry", () => {
  it("exports an async plugin function", () => {
    expect(typeof LazyProxyPlugin).toBe("function");
    expect(LazyProxyPlugin.constructor.name).toBe("AsyncFunction");
  });

  it("resolveConfigDir honors env override", () => {
    const old = process.env.LAZYPROXY_CONFIG_DIR;
    process.env.LAZYPROXY_CONFIG_DIR = "C:/tmp/lazyproxy-cfg";
    expect(resolveConfigDir()).toBe("C:/tmp/lazyproxy-cfg");
    if (old === undefined) delete process.env.LAZYPROXY_CONFIG_DIR;
    else process.env.LAZYPROXY_CONFIG_DIR = old;
  });

  it("startLazyProxy returns null and writes default config when subscription missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lazyproxy-plug-"));
    const h = startLazyProxy(dir);
    expect(h).toBeNull();
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain("subscriptionUrl");
    rmSync(dir, { recursive: true, force: true });
  });

  it("plugin runs without throwing when config is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lazyproxy-plug-"));
    const old = process.env.LAZYPROXY_CONFIG_DIR;
    process.env.LAZYPROXY_CONFIG_DIR = dir;
    await expect(LazyProxyPlugin({} as never)).resolves.toEqual({});
    if (old === undefined) delete process.env.LAZYPROXY_CONFIG_DIR;
    else process.env.LAZYPROXY_CONFIG_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  });
});
