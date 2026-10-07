export interface LazyProxyConfig {
  /** 机场 Clash/mihomo 格式订阅 URL（含 token） */
  subscriptionUrl: string;
  /** 本地订阅文件路径（存在时优先于 subscriptionUrl，避免订阅端点不可达） */
  subscriptionFile?: string;
  /** 排除节点正则（如 hk|tw）；命中名称的节点不进 AUTO/PROXY 组 */
  excludeNodes?: string;
  /** 钉死使用指定节点（精确节点名，最高优先） */
  pinNode?: string;
  /** opencode 插件 shim 监听端口 */
  shimPort: number;
  /** mihomo mixed-port */
  corePort: number;
  /** 空闲关闭阈值（毫秒） */
  idleMs: number;
  /** 手动指定 mihomo 二进制路径（覆盖自动下载） */
  corePath?: string;
  /** GitHub 镜像下载地址覆盖（如 ghproxy 前缀） */
  downloadBaseUrl?: string;
  /** mihomo 版本（release tag，如 v1.19.32） */
  mihomoVersion: string;
  /** 上游 OpenAI-compatible 基地址 */
  upstream: string;
  /** 需要经内核代理的域名（后缀匹配，如 chatgpt.com 覆盖 *.chatgpt.com）；其余域名直连。缺省时用 DEFAULTS.proxyHosts */
  proxyHosts?: string[];
  logLevel: "debug" | "info" | "warn" | "error";
}

export const DEFAULT_PROXY_HOSTS = ["chatgpt.com", "openai.com"] as const;

export const DEFAULTS = {
  shimPort: 17891,
  corePort: 17890,
  idleMs: 180_000,
  mihomoVersion: "v1.19.32",
  upstream: "https://api.openai.com",
  proxyHosts: [...DEFAULT_PROXY_HOSTS],
  logLevel: "info",
} as const;

const LOG_LEVELS: readonly LazyProxyConfig["logLevel"][] = ["debug", "info", "warn", "error"];

/** 日志/报错时脱敏 URL（隐藏 token / userinfo） */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "***";
    }
    for (const key of ["token", "key", "secret", "password"]) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "***");
    }
    return u.toString();
  } catch {
    return url.replace(/([?&](?:token|key|secret|password)=)[^&]+/gi, "$1***");
  }
}
