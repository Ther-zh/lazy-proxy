import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  buildMihomoConfig,
  ensureConfig,
  extractProfileDns,
  extractProxies,
  fetchSubscription,
  loadSubscriptionSource,
  SUBSCRIPTION_CACHE_TTL_MS,
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
    expect(doc["keep-alive-idle"]).toBe(15);
    expect(doc["keep-alive-interval"]).toBe(15);
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

  it("excludeNodes filters nodes from AUTO", () => {
    const nodes = extractProxies(FIXTURE);
    const yaml = buildMihomoConfig({ ...cfg, excludeNodes: "hk|tw" }, nodes);
    const doc = load(yaml) as { "proxy-groups": Array<{ name: string; proxies: string[] }> };
    const auto = doc["proxy-groups"].find((g) => g.name === "AUTO");
    expect(auto?.proxies.every((p) => !p.includes("HK") && !p.includes("TW"))).toBe(true);
    expect(auto?.proxies).toContain("JP-01");
  });

  it("pinNode prefers the pinned node with automatic fallback to AUTO", () => {
    const nodes = extractProxies(FIXTURE);
    const yaml = buildMihomoConfig({ ...cfg, pinNode: "JP-01" }, nodes);
    const doc = load(yaml) as {
      "proxy-groups": Array<{ name: string; type: string; proxies: string[]; url?: string; interval?: number }>;
    };
    const groups = doc["proxy-groups"];
    expect(groups.map((g) => g.name)).toEqual(["PROXY", "AUTO"]);
    expect(groups[0]).toMatchObject({
      name: "PROXY",
      type: "fallback",
      proxies: ["JP-01", "AUTO"],
      url: "http://www.gstatic.com/generate_204",
      interval: 300,
    });
    expect(groups[1].proxies).toContain("JP-01");
  });

  it("fallbackNodes builds an ordered fallback pool (no AUTO member)", () => {
    const nodes = extractProxies(FIXTURE);
    const yaml = buildMihomoConfig({ ...cfg, fallbackNodes: ["JP-01", "US-01"] }, nodes);
    const doc = load(yaml) as {
      "proxy-groups": Array<{ name: string; type: string; proxies: string[]; url?: string; interval?: number }>;
    };
    const groups = doc["proxy-groups"];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: "PROXY",
      type: "fallback",
      proxies: ["JP-01", "US-01"],
      url: "http://www.gstatic.com/generate_204",
      interval: 300,
    });
  });

  it("pinNode + fallbackNodes: pin first, deduped, invalid names ignored", () => {
    const nodes = extractProxies(FIXTURE);
    const yaml = buildMihomoConfig(
      { ...cfg, pinNode: "JP-01", fallbackNodes: ["JP-01", "不存在", "US-01"] },
      nodes,
    );
    const doc = load(yaml) as { "proxy-groups": Array<{ name: string; type: string; proxies: string[] }> };
    expect(doc["proxy-groups"]).toHaveLength(1);
    expect(doc["proxy-groups"][0]).toMatchObject({
      name: "PROXY",
      type: "fallback",
      proxies: ["JP-01", "US-01"],
    });
  });

  it("fallbackNodes respect excludeNodes; all invalid falls back to broad AUTO behavior", () => {
    const nodes = extractProxies(FIXTURE);
    const excluded = buildMihomoConfig(
      { ...cfg, excludeNodes: "hk", fallbackNodes: ["HK-01", "JP-01"] },
      nodes,
    );
    const d1 = load(excluded) as { "proxy-groups": Array<{ name: string; type: string; proxies: string[] }> };
    expect(d1["proxy-groups"][0]).toMatchObject({ name: "PROXY", type: "fallback", proxies: ["JP-01"] });

    const noneValid = buildMihomoConfig({ ...cfg, fallbackNodes: ["不存在"] }, nodes);
    const d2 = load(noneValid) as { "proxy-groups": Array<{ name: string; type: string; proxies: string[] }> };
    expect(d2["proxy-groups"].map((g) => g.name)).toEqual(["PROXY", "AUTO"]);
    expect(d2["proxy-groups"][0]).toMatchObject({ name: "PROXY", type: "select" });
  });

  it("healthCheckUrl override applies to fallback and AUTO groups", () => {
    const nodes = extractProxies(FIXTURE);
    const custom = "https://chatgpt.com/cdn-cgi/trace";
    const pinOnly = buildMihomoConfig({ ...cfg, pinNode: "JP-01", healthCheckUrl: custom }, nodes);
    const d1 = load(pinOnly) as { "proxy-groups": Array<{ name: string; url?: string }> };
    expect(d1["proxy-groups"].find((g) => g.name === "PROXY")?.url).toBe(custom);
    expect(d1["proxy-groups"].find((g) => g.name === "AUTO")?.url).toBe(custom);

    const pool = buildMihomoConfig({ ...cfg, fallbackNodes: ["JP-01"], healthCheckUrl: custom }, nodes);
    const d2 = load(pool) as { "proxy-groups": Array<{ name: string; url?: string }> };
    expect(d2["proxy-groups"][0].url).toBe(custom);
  });

  it("invalid pinNode falls back to AUTO", () => {
    const nodes = extractProxies(FIXTURE);
    const yaml = buildMihomoConfig({ ...cfg, pinNode: "不存在的节点" }, nodes);
    const doc = load(yaml) as { "proxy-groups": Array<{ name: string }> };
    expect(doc["proxy-groups"].map((g) => g.name)).toEqual(["PROXY", "AUTO"]);
  });

  it("throws when excludeNodes removes everything", () => {
    const nodes = extractProxies(FIXTURE);
    expect(() => buildMihomoConfig({ ...cfg, excludeNodes: "." }, nodes)).toThrow(/excluded/);
  });
});

describe("loadSubscriptionSource", () => {
  it("reads local file when subscriptionFile set (no network)", async () => {
    const dir = tempDir();
    const file = join(dir, "sub.yml");
    writeFileSync(file, FIXTURE, "utf8");
    const raw = await loadSubscriptionSource({ ...cfg, subscriptionFile: file });
    expect(raw).toContain("proxies:");
    rmSync(dir, { recursive: true, force: true });
  });
  it("throws a combined error when the file is missing and the URL fails", async () => {
    const fetcher = (async () => {
      throw new Error("ENOTFOUND sub.example.com");
    }) as Fetcher;
    await expect(
      loadSubscriptionSource({ ...cfg, subscriptionFile: "C:/nope.yml" }, fetcher),
    ).rejects.toThrow(/read subscription file failed.*ENOTFOUND/);
  });
  it("falls back to fetch when no file", async () => {
    const fetcher = (async () => new Response("proxies: []", { status: 200 })) as Fetcher;
    await expect(loadSubscriptionSource(cfg, fetcher)).resolves.toBe("proxies: []");
  });
});

describe("subscription freshness / offline fallback", () => {
  it("never touches the network while the local file is fresh", async () => {
    const dir = tempDir();
    const file = join(dir, "sub.yml");
    writeFileSync(file, FIXTURE, "utf8");
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response("proxies: []", { status: 200 });
    }) as Fetcher;

    const raw = await loadSubscriptionSource({ ...cfg, subscriptionFile: file }, fetcher, {
      dataDir: dir,
      now: () => Date.now(),
      refreshCooldownMs: 0,
    });
    expect(raw).toContain("proxies:");
    expect(calls).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refreshes a stale file from the URL and writes the cache for next time", async () => {
    const dir = tempDir();
    const file = join(dir, "sub.yml");
    writeFileSync(file, "proxies:\n  - name: OLD\n    type: ss\n", "utf8");
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(FIXTURE, { status: 200 });
    }) as Fetcher;
    const staleNow = Date.now() + SUBSCRIPTION_CACHE_TTL_MS + 1000;

    const raw = await loadSubscriptionSource({ ...cfg, subscriptionFile: file }, fetcher, {
      dataDir: dir,
      now: () => staleNow,
      refreshCooldownMs: 0,
    });
    expect(raw).toBe(FIXTURE);
    expect(calls).toBe(1);
    expect(readFileSync(join(dir, "subscription.cache.yml"), "utf8")).toBe(FIXTURE);

    // 第二次：缓存已新鲜 → 不再联网
    const raw2 = await loadSubscriptionSource({ ...cfg, subscriptionFile: file }, fetcher, {
      dataDir: dir,
      now: () => Date.now(),
      refreshCooldownMs: 0,
    });
    expect(raw2).toBe(FIXTURE);
    expect(calls).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the stale file when the URL is unreachable (and warns)", async () => {
    const dir = tempDir();
    const file = join(dir, "sub.yml");
    writeFileSync(file, FIXTURE, "utf8");
    const fetcher = (async () => {
      throw new Error("ECONNREFUSED");
    }) as Fetcher;
    const warnings: string[] = [];

    const raw = await loadSubscriptionSource({ ...cfg, subscriptionFile: file }, fetcher, {
      dataDir: dir,
      now: () => Date.now() + SUBSCRIPTION_CACHE_TTL_MS + 1000,
      refreshCooldownMs: 0,
      log: (_level, message) => warnings.push(message),
    });
    expect(raw).toContain("HK-01");
    expect(warnings.join("\n")).toMatch(/using stale/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the stale file when no URL is configured", async () => {
    const dir = tempDir();
    const file = join(dir, "sub.yml");
    writeFileSync(file, FIXTURE, "utf8");
    const raw = await loadSubscriptionSource(
      { ...cfg, subscriptionUrl: "", subscriptionFile: file },
      undefined,
      { now: () => Date.now() + SUBSCRIPTION_CACHE_TTL_MS + 1000, refreshCooldownMs: 0 },
    );
    expect(raw).toContain("proxies:");
    rmSync(dir, { recursive: true, force: true });
  });

  it("backs off from repeated refresh attempts after a network failure", async () => {
    const dir = tempDir();
    const file = join(dir, "sub.yml");
    writeFileSync(file, FIXTURE, "utf8");
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw new Error("ENOTFOUND sub.example.com");
    }) as Fetcher;
    const staleBase = Date.now() + SUBSCRIPTION_CACHE_TTL_MS + 1000;

    await loadSubscriptionSource({ ...cfg, subscriptionFile: file }, failing, {
      dataDir: dir,
      now: () => staleBase,
      refreshCooldownMs: 0,
    });
    expect(calls).toBe(1);

    const notes: string[] = [];
    const raw = await loadSubscriptionSource({ ...cfg, subscriptionFile: file }, failing, {
      dataDir: dir,
      now: () => staleBase + 60_000,
      log: (_level, message) => notes.push(message),
    });
    expect(raw).toContain("HK-01");
    expect(calls).toBe(1);
    expect(notes.join(" ")).toMatch(/skipped|cooldown/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

const PROFILE_WITH_DNS = `dns:
  enable: true
  listen: 127.0.0.1:1053
  ipv6: false
  default-nameserver: [223.5.5.5, 119.29.29.29]
  enhanced-mode: fake-ip
  fake-ip-range: 28.0.0.1/8
  fake-ip-filter: ['*.lan']
  nameserver: [https://doh.pub/dns-query]
  nameserver-policy:
    gd.bjnet2.com: https://api.edgequery.cc:40443/dns-query
  fallback: [https://223.5.5.5/dns-query]
  fallback-filter:
    geoip: false
proxies:
  - { name: HK-01, type: ss, server: edge.example.com, port: 10002, cipher: aes-128-gcm, password: p1 }
`;

describe("profile DNS pass-through", () => {
  it("extracts the dns section (null when absent or invalid)", () => {
    const dns = extractProfileDns(PROFILE_WITH_DNS);
    expect(dns).toMatchObject({
      enable: true,
      "nameserver-policy": { "gd.bjnet2.com": "https://api.edgequery.cc:40443/dns-query" },
    });
    expect(extractProfileDns("proxies: []")).toBeNull();
    expect(extractProfileDns("{{{{")).toBeNull();
  });

  it("sanitizes profile dns for a non-TUN HTTP proxy", () => {
    const nodes = extractProxies(FIXTURE);
    const yaml = buildMihomoConfig(cfg, nodes, { dns: extractProfileDns(PROFILE_WITH_DNS) });
    const doc = load(yaml) as { dns?: Record<string, unknown> };
    expect(doc.dns).toBeDefined();
    expect(doc.dns?.enable).toBe(true);
    expect(doc.dns?.["enhanced-mode"]).toBe("normal");
    expect(doc.dns?.["nameserver-policy"]).toEqual({
      "gd.bjnet2.com": "https://api.edgequery.cc:40443/dns-query",
    });
    expect(doc.dns?.listen).toBeUndefined();
    expect(doc.dns?.["fake-ip-range"]).toBeUndefined();
    expect(doc.dns?.["fake-ip-filter"]).toBeUndefined();
  });

  it("omits dns entirely when the profile has none", () => {
    const yaml = buildMihomoConfig(cfg, extractProxies(FIXTURE));
    const doc = load(yaml) as { dns?: unknown };
    expect(doc.dns).toBeUndefined();
  });

  it("ensureConfig writes the sanitized dns section", async () => {
    const dir = tempDir();
    const fetcher = (async () => new Response(PROFILE_WITH_DNS, { status: 200 })) as Fetcher;
    const p = await ensureConfig(dir, cfg, fetcher, { refreshCooldownMs: 0 });
    const doc = load(readFileSync(p, "utf8")) as { dns?: Record<string, unknown> };
    expect(doc.dns?.["nameserver-policy"]).toEqual({
      "gd.bjnet2.com": "https://api.edgequery.cc:40443/dns-query",
    });
    expect(doc.dns?.["enhanced-mode"]).toBe("normal");
    rmSync(dir, { recursive: true, force: true });
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
