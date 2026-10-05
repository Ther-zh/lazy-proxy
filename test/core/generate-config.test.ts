import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  buildMihomoConfig,
  ensureConfig,
  extractProxies,
  fetchSubscription,
  SubscriptionError,
  type Fetcher,
} from "../../src/core/generate-config";
import { DEFAULTS } from "../../src/config/schema";

const FIXTURE = readFileSync(join(process.cwd(), "test", "fixtures", "subscription-sample.yml"), "utf8");

const cfg = {
  subscriptionUrl: "https://sub.example.com/api?token=x",
  shimPort: DEFAULTS.shimPort,
  corePort: 17890,
  idleMs: DEFAULTS.idleMs,
  mihomoVersion: DEFAULTS.mihomoVersion,
  upstream: DEFAULTS.upstream,
  logLevel: "info",
} as const;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lazyproxy-cfg-"));
}

describe("fetchSubscription", () => {
  it("returns body on ok", async () => {
    const fetcher = (async () => new Response("PROXIES", { status: 200 })) as Fetcher;
    await expect(fetchSubscription("https://x", fetcher)).resolves.toBe("PROXIES");
  });
  it("throws on http error", async () => {
    const fetcher = (async () => new Response("err", { status: 403 })) as Fetcher;
    await expect(fetchSubscription("https://x", fetcher)).rejects.toThrow(/HTTP 403/);
  });
  it("throws on network error", async () => {
    const fetcher = (async () => {
      throw new Error("ECONNREFUSED");
    }) as Fetcher;
    await expect(fetchSubscription("https://x", fetcher)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("extractProxies", () => {
  it("extracts nodes and drops ⚠️ rows", () => {
    const nodes = extractProxies(FIXTURE);
    expect(nodes).toHaveLength(3);
    expect(nodes[0].name).toBe("HK-01");
    expect(nodes[0].type).toBe("ss");
    expect(nodes[0].server).toBe("edge.example.com");
  });
  it("throws when proxies key missing", () => {
    expect(() => extractProxies("mode: global")).toThrow(/no `proxies`/);
  });
  it("throws on invalid yaml", () => {
    expect(() => extractProxies("{{{{")).toThrow(/not valid YAML/);
  });
  it("throws when all nodes filtered out", () => {
    expect(() => extractProxies("proxies:\n  - { name: '⚠️ xxx' }")).toThrow(/no usable proxies/);
  });
});

describe("buildMihomoConfig", () => {
  it("golden: minimal structure", () => {
    const nodes = extractProxies(FIXTURE);
    const yaml = buildMihomoConfig(cfg, nodes);
    const doc = load(yaml) as Record<string, unknown>;
    expect(doc["mixed-port"]).toBe(17890);
    expect(doc["bind-address"]).toBe("127.0.0.1");
    expect(doc.mode).toBe("rule");
    expect(doc.rules).toEqual(["MATCH,PROXY"]);
    const groups = doc["proxy-groups"] as Array<Record<string, unknown>>;
    expect(groups.map((g) => g.name)).toEqual(["PROXY", "AUTO"]);
    expect(groups[1]).toMatchObject({ type: "url-test", url: "http://www.gstatic.com/generate_204" });
  });
  it("golden: node names round-trip with emoji/中文 intact", () => {
    const nodes = extractProxies(FIXTURE);
    const yaml = buildMihomoConfig(cfg, nodes);
    const doc = load(yaml) as { proxies: Array<{ name: string }> };
    expect(doc.proxies.map((p) => p.name)).toEqual([
      "HK-01",
      "JP-01",
      "US-01",
    ]);
  });
  it("throws with zero nodes", () => {
    expect(() => buildMihomoConfig(cfg, [])).toThrow(/without proxies/);
  });
});

describe("ensureConfig", () => {
  it("fetches, writes config.yaml, returns path", async () => {
    const dir = tempDir();
    const fetcher = (async () => new Response(FIXTURE, { status: 200 })) as Fetcher;
    const p = await ensureConfig(dir, cfg, fetcher);
    expect(p).toBe(join(dir, "config.yaml"));
    const doc = load(readFileSync(p, "utf8")) as { "mixed-port": number };
    expect(doc["mixed-port"]).toBe(17890);
    rmSync(dir, { recursive: true, force: true });
  });
  it("does not leak fetch errors", async () => {
    const dir = tempDir();
    const fetcher = (async () => new Response("err", { status: 500 })) as Fetcher;
    await expect(ensureConfig(dir, cfg, fetcher)).rejects.toThrow(/HTTP 500/);
    rmSync(dir, { recursive: true, force: true });
  });
});
