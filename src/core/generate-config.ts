import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dump, load } from "js-yaml";
import type { LazyProxyConfig } from "../config/schema";

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
export async function fetchSubscription(url: string, fetcher: Fetcher = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetcher(url, { headers: { "user-agent": "lazy-proxy/0.1" } });
  } catch (e) {
    throw new SubscriptionError(`subscription fetch failed: ${(e as Error).message}`);
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

/** 生成最小 mihomo config.yaml（内联节点 + PROXY/AUTO 组 + MATCH 规则） */
export function buildMihomoConfig(cfg: LazyProxyConfig, nodes: ProxyNode[]): string {
  if (nodes.length === 0) {
    throw new SubscriptionError("cannot build config without proxies");
  }
  const names = nodes.map((n) => n.name);
  const config = {
    "mixed-port": cfg.corePort,
    "bind-address": "127.0.0.1",
    mode: "rule",
    "log-level": "warning",
    proxies: nodes,
    "proxy-groups": [
      { name: "PROXY", type: "select", proxies: ["AUTO", ...names] },
      {
        name: "AUTO",
        type: "url-test",
        proxies: names,
        url: "http://www.gstatic.com/generate_204",
        interval: 300,
      },
    ],
    rules: ["MATCH,PROXY"],
  };
  return dump(config, { noRefs: true, lineWidth: 200 });
}

/** 抓取订阅 → 生成 config.yaml → 写入 dataDir，返回文件路径 */
export async function ensureConfig(
  dataDir: string,
  cfg: LazyProxyConfig,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const raw = await fetchSubscription(cfg.subscriptionUrl, fetcher);
  const nodes = extractProxies(raw);
  const yaml = buildMihomoConfig(cfg, nodes);
  const p = join(dataDir, "config.yaml");
  writeFileSync(p, yaml, "utf8");
  return p;
}
