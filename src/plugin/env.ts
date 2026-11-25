/**
 * 进程内代理 env 注入：只在 opencode 进程（及子进程）内生效，进程退出即消失。
 * 依赖事实：opencode 的 provider 链路（@ai-sdk/provider-utils FetchClient）在每次请求时
 * 读取 process.env.HTTPS_PROXY/HTTP_PROXY，并用 HttpsProxyAgent 以 CONNECT 方式走代理。
 */

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;
const ALL_KEYS = [...PROXY_KEYS, ...NO_PROXY_KEYS] as const;
const DEFAULT_NO_PROXY = ["localhost", "127.0.0.1", "::1"] as const;

/** 合并 NO_PROXY：保留已有条目 + 追加本地地址，去重（忽略大小写） */
export function mergeNoProxy(
  existing: string | undefined,
  extra: readonly string[] = DEFAULT_NO_PROXY,
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of `${existing ?? ""},${extra.join(",")}`.split(",")) {
    const v = part.trim();
    if (!v) continue;
    const lower = v.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(v);
  }
  return out.join(",");
}

export interface ProxyEnvHandle {
  proxyUrl: string;
  restore: () => void;
}

/** 将代理 env 指向本进程的 shim；返回 restore（恢复注入前的原值） */
export function injectProxyEnv(port: number, env: NodeJS.ProcessEnv = process.env): ProxyEnvHandle {
  const proxyUrl = `http://127.0.0.1:${port}`;
  // Windows 上 env 键大小写不敏感（HTTPS_PROXY 与 https_proxy 是同一个变量），
  // 因此必须在写入任何值之前先做完整快照，否则别名键会读到已注入的值。
  const saved = new Map<string, string | undefined>();
  for (const k of ALL_KEYS) saved.set(k, env[k]);
  const mergedNoProxy = mergeNoProxy(env["NO_PROXY"] ?? env["no_proxy"]);
  for (const k of PROXY_KEYS) env[k] = proxyUrl;
  for (const k of NO_PROXY_KEYS) env[k] = mergedNoProxy;
  return {
    proxyUrl,
    restore: () => {
      for (const [k, v] of saved) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    },
  };
}

interface ActiveProxyEnv {
  handle: ProxyEnvHandle;
  refs: number;
}

const ENV_REGISTRY_KEY = Symbol.for("lazy-proxy.env-registry");

function envRegistry(): WeakMap<NodeJS.ProcessEnv, ActiveProxyEnv> {
  const root = globalThis as typeof globalThis & {
    [ENV_REGISTRY_KEY]?: WeakMap<NodeJS.ProcessEnv, ActiveProxyEnv>;
  };
  root[ENV_REGISTRY_KEY] ??= new WeakMap();
  return root[ENV_REGISTRY_KEY];
}

/**
 * 引用计数的 env 注入：V2 会按 location 多次调用 setup，任一实例 dispose 时
 * 不能把其他实例仍在使用的代理 env 提前清掉。最后一个 handle restore 时才恢复原值。
 */
export function acquireProxyEnv(port: number, env: NodeJS.ProcessEnv = process.env): ProxyEnvHandle {
  const registry = envRegistry();
  const activeEnv = registry.get(env);
  if (activeEnv && activeEnv.handle.proxyUrl === `http://127.0.0.1:${port}`) {
    activeEnv.refs += 1;
    return consumerEnvHandle(registry, env, activeEnv);
  }
  const state: ActiveProxyEnv = { handle: injectProxyEnv(port, env), refs: 1 };
  registry.set(env, state);
  return consumerEnvHandle(registry, env, state);
}

function consumerEnvHandle(
  registry: WeakMap<NodeJS.ProcessEnv, ActiveProxyEnv>,
  env: NodeJS.ProcessEnv,
  state: ActiveProxyEnv,
): ProxyEnvHandle {
  let released = false;
  return {
    proxyUrl: state.handle.proxyUrl,
    restore: () => {
      if (released) return;
      released = true;
      state.refs -= 1;
      if (state.refs > 0) return;
      if (registry.get(env) === state) registry.delete(env);
      state.handle.restore();
    },
  };
}
