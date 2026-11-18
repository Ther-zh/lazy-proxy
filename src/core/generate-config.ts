import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dump, load } from "js-yaml";
import { DEFAULT_HEALTH_CHECK_URL, type LazyProxyConfig } from "../config/schema";

/** 本地订阅/缓存的最长可信时间：超过后尝试从 subscriptionUrl 刷新 */
export const SUBSCRIPTION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 订阅抓取超时（避免离线时每次冷启动都长时间等待） */
export const SUBSCRIPTION_FETCH_TIMEOUT_MS = 5_000;
/** 抓取失败后的重试冷却（进程内），避免离线时每次冷启动都等超时 */
export const SUBSCRIPTION_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
export const SUBSCRIPTION_CACHE_FILENAME = "subscription.cache.yml";

let lastRefreshFailureAt = 0;

export type SubscriptionLogLevel = "debug" | "info" | "warn" | "error";
export type SubscriptionLogger = (level: SubscriptionLogLevel, message: string) => void;

export interface SubscriptionSourceOptions {
  /** 缓存写入目录（通常为 dataDir）；提供后启用订阅缓存 */
  dataDir?: string;
  now?: () => number;
  ttlMs?: number;
  fetchTimeoutMs?: number;
  /** 抓取失败后的重试冷却；0 表示禁用冷却 */
  refreshCooldownMs?: number;
  log?: SubscriptionLogger;
}

export interface ProxyNode {
  name: string;
  [key: string]: unknown;
}

export class SubscriptionError extends Error {}

/** 订阅抓取器签名（测试可注入，避免依赖 typeof fetch 的完整结构） */
export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** 抓取机场订阅（默认使用全局 fetch，可注入用于测试） */
export async function fetchSubscription(
  url: string,
  fetcher: Fetcher = fetch,
  timeoutMs: number = SUBSCRIPTION_FETCH_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { "user-agent": "lazy-proxy/0.1" },
      signal: controller.signal,
    });
  } catch (e) {
    const err = e as Error;
    const detail =
      err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : err.message;
    throw new SubscriptionError(`subscription fetch failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new SubscriptionError(`subscription fetch failed: HTTP ${res.status}`);
  }
  return res.text();
}

/** 从 Clash/mihomo 格式 YAML 提取 proxies 列表；过滤 ⚠️ 前缀的异常/提示线路 */
export function extractProxies(raw: string): ProxyNode[] {
  let doc: unknown;
  try {
    doc = load(raw);
  } catch (e) {
    throw new SubscriptionError(`subscription is not valid YAML: ${(e as Error).message}`);
  }
  const list = (doc as Record<string, unknown> | null)?.proxies;
  if (!Array.isArray(list)) {
    throw new SubscriptionError("subscription has no `proxies` list (is it Clash/mihomo format?)");
  }
  const nodes = list.filter((p): p is ProxyNode => {
    const n = p as ProxyNode;
    return (
      typeof n === "object" && n !== null && typeof n.name === "string" && n.name.length > 0
    );
  });
  const clean = nodes.filter((n) => !n.name.startsWith("⚠️"));
  if (clean.length === 0) {
    throw new SubscriptionError("no usable proxies found in subscription");
  }
  return clean;
}

const DNS_ALLOWED_KEYS = new Set([
  "default-nameserver",
  "nameserver",
  "nameserver-policy",
  "fallback",
  "fallback-filter",
  "ipv6",
  "use-hosts",
  "prefer-h3",
  "respect-rules",
]);

/** 从订阅 profile 提取 dns 段（机场常用专用 DoH 解决节点域名污染） */
export function extractProfileDns(raw: string): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = load(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const dns = (doc as Record<string, unknown>).dns;
  if (!dns || typeof dns !== "object" || Array.isArray(dns)) return null;
  return dns as Record<string, unknown>;
}

/**
 * 清洗 profile DNS 供“无 TUN 的 HTTP 代理”使用：
 * - 删除 listen（避免与 Clash Verge 等实例抢端口）
 * - 强制 normal 模式（fake-ip 会让 HTTP 代理拿到假 IP）
 * - 只保留与解析相关的键
 */
function sanitizeProfileDns(dns: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dns)) {
    if (DNS_ALLOWED_KEYS.has(key)) out[key] = value;
  }
  out.enable = true;
  out["enhanced-mode"] = "normal";
  return out;
}

/** 生成最小 mihomo config.yaml（内联节点 + PROXY/AUTO 组 + MATCH 规则） */
export function buildMihomoConfig(
  cfg: LazyProxyConfig,
  nodes: ProxyNode[],
  opts: { dns?: Record<string, unknown> | null } = {},
): string {
  if (nodes.length === 0) {
    throw new SubscriptionError("cannot build config without proxies");
  }
  let usable = nodes;
  if (cfg.excludeNodes) {
    try {
      const re = new RegExp(cfg.excludeNodes, "i");
      usable = usable.filter((n) => !re.test(n.name));
    } catch {
      /* 非法正则忽略 */
    }
  }
  if (usable.length === 0) {
    throw new SubscriptionError("all proxies excluded by excludeNodes");
  }
  const names = usable.map((n) => n.name);
  const pin = cfg.pinNode && names.includes(cfg.pinNode) ? cfg.pinNode : undefined;
  const healthCheck = { url: cfg.healthCheckUrl ?? DEFAULT_HEALTH_CHECK_URL, interval: 300 };
  const auto = { name: "AUTO", type: "url-test", proxies: names, ...healthCheck };
  const fallbackPool = [...new Set((cfg.fallbackNodes ?? []).filter((n) => names.includes(n)))];
  const preferred = [...new Set([...(pin ? [pin] : []), ...fallbackPool])];

  let proxyGroups: Array<Record<string, unknown>>;
  if (fallbackPool.length > 0) {
    // 显式回退池：按顺序自动切换；不再混入 AUTO，避免回退到被 OpenAI 屏蔽的节点
    proxyGroups = [{ name: "PROXY", type: "fallback", proxies: preferred, ...healthCheck }];
  } else if (pin) {
    // 只钉了单节点：保留兜底 AUTO 作为最后手段
    proxyGroups = [{ name: "PROXY", type: "fallback", proxies: [pin, "AUTO"], ...healthCheck }, auto];
  } else {
    proxyGroups = [{ name: "PROXY", type: "select", proxies: ["AUTO", ...names] }, auto];
  }

  const config: Record<string, unknown> = {
    "mixed-port": cfg.corePort,
    "bind-address": "127.0.0.1",
    mode: "rule",
    "log-level": "warning",
    proxies: usable,
    "proxy-groups": proxyGroups,
    rules: ["MATCH,PROXY"],
  };
  if (opts.dns) config.dns = sanitizeProfileDns(opts.dns);
  return dump(config, { noRefs: true, lineWidth: 200 });
}

interface SubscriptionCandidate {
  raw: string;
  mtimeMs: number;
  label: string;
}

/**
 * 获取订阅原始内容（带 TTL + 缓存 + 离线回退）：
 * - 本地 subscriptionFile 与 dataDir 缓存中取最新的一份；
 * - 未超过 TTL → 直接用，不联网；
 * - 超过 TTL → 尝试 subscriptionUrl 刷新，成功则写入缓存；失败则回退到最新本地副本并告警；
 * - 两者都不可用 → 抛出组合错误。
 */
export async function loadSubscriptionSource(
  cfg: Pick<LazyProxyConfig, "subscriptionUrl" | "subscriptionFile">,
  fetcher: Fetcher = fetch,
  opts: SubscriptionSourceOptions = {},
): Promise<string> {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? SUBSCRIPTION_CACHE_TTL_MS;
  const log: SubscriptionLogger = opts.log ?? (() => {});

  const candidates: SubscriptionCandidate[] = [];
  let fileError: Error | null = null;
  if (cfg.subscriptionFile) {
    try {
      const st = statSync(cfg.subscriptionFile);
      candidates.push({
        raw: readFileSync(cfg.subscriptionFile, "utf8"),
        mtimeMs: st.mtimeMs,
        label: "subscriptionFile",
      });
    } catch (e) {
      fileError = e as Error;
    }
  }
  const cachePath = opts.dataDir ? join(opts.dataDir, SUBSCRIPTION_CACHE_FILENAME) : null;
  if (cachePath) {
    try {
      const st = statSync(cachePath);
      candidates.push({ raw: readFileSync(cachePath, "utf8"), mtimeMs: st.mtimeMs, label: "cache" });
    } catch {
      /* 无缓存 */
    }
  }
  // mtime 相同（同一毫秒写入）时缓存优先：它只会在 URL 刷新成功后生成
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.label === "cache" ? -1 : 1));
  const newest = candidates[0];

  if (newest && now() - newest.mtimeMs < ttlMs) {
    log("debug", `using fresh subscription from ${newest.label}`);
    return newest.raw;
  }

  if (cfg.subscriptionUrl) {
    const cooldownMs = opts.refreshCooldownMs ?? SUBSCRIPTION_REFRESH_COOLDOWN_MS;
    if (newest && cooldownMs > 0 && lastRefreshFailureAt > 0 && now() - lastRefreshFailureAt < cooldownMs) {
      log("debug", `subscription refresh skipped (recent failure); using stale ${newest.label}`);
      return newest.raw;
    }
    try {
      const raw = await fetchSubscription(cfg.subscriptionUrl, fetcher, opts.fetchTimeoutMs);
      lastRefreshFailureAt = 0;
      if (cachePath) {
        try {
          const tmp = `${cachePath}.tmp`;
          writeFileSync(tmp, raw, "utf8");
          renameSync(tmp, cachePath);
        } catch (e) {
          log("warn", `write subscription cache failed: ${(e as Error).message}`);
        }
      }
      log("info", `refreshed subscription from subscriptionUrl`);
      return raw;
    } catch (e) {
      lastRefreshFailureAt = now();
      const msg = (e as Error).message;
      if (newest) {
        log(
          "warn",
          `subscription refresh failed (${msg}); using stale ${newest.label} from ${new Date(newest.mtimeMs).toISOString()}`,
        );
        return newest.raw;
      }
      if (fileError) {
        throw new SubscriptionError(
          `read subscription file failed: ${fileError.message}; ${msg}`,
        );
      }
      throw e;
    }
  }

  if (newest) {
    log("warn", `using stale ${newest.label} (no subscriptionUrl configured)`);
    return newest.raw;
  }
  if (fileError) {
    throw new SubscriptionError(`read subscription file failed: ${fileError.message}`);
  }
  throw new SubscriptionError("no subscription source configured");
}

/** 抓取订阅 → 生成 config.yaml → 写入 dataDir，返回文件路径 */
export async function ensureConfig(
  dataDir: string,
  cfg: LazyProxyConfig,
  fetcher: Fetcher = fetch,
  opts: Omit<SubscriptionSourceOptions, "dataDir"> = {},
): Promise<string> {
  const raw = await loadSubscriptionSource(cfg, fetcher, { ...opts, dataDir });
  const nodes = extractProxies(raw);
  const yaml = buildMihomoConfig(cfg, nodes, { dns: extractProfileDns(raw) });
  const p = join(dataDir, "config.yaml");
  writeFileSync(p, yaml, "utf8");
  return p;
}
