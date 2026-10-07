/**
 * 进程内 fetch 拦截（Desktop/CLI 通用）：
 * - 白名单域名（proxyHosts + upstream，后缀匹配）→ 经本进程 shim(127.0.0.1) CONNECT 隧道转发，
 *   由 shim 触发内核懒启动；请求结束即断开，不影响系统与其他进程；
 * - 其余 URL → 原样交还原生 fetch，零影响。
 *
 * 背景（OpenCode Desktop 1.18.35 实测）：provider 链路最终调用 Node 全局 fetch（undici），
 * undici 不读取 HTTPS_PROXY/HTTP_PROXY（env 注入对其无效），只有进程内替换 fetch 才能拦截。
 * Bun 运行时优先使用其原生 { proxy } 选项；Node/Electron 走 node:http/https + 自建 CONNECT 隧道。
 */
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { connect as netConnect, isIP, type Socket } from "node:net";
import type { Readable, Transform } from "node:stream";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isProxyHost } from "../shim/server";

export interface FetchPatchHandle {
  restore: () => void;
}

/** 被替换 fetch 的宿主（默认为 globalThis，测试可注入） */
export interface FetchScope {
  fetch?: typeof fetch;
}

export interface FetchPatchOptions {
  shimPort: number;
  hosts: readonly string[];
  scope?: FetchScope;
  /** 显式指定被包装的原始 fetch（默认取 scope.fetch） */
  originalFetch?: typeof fetch;
}

const STATE_KEY = Symbol.for("lazy-proxy.fetch-patch");
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface PatchState {
  originalFetch: typeof fetch;
  opts: FetchPatchOptions;
  patched: typeof fetch;
  refs: number;
}

/** 安装 fetch 补丁；返回 restore（引用计数，最后一个 handle 释放时才真正还原） */
export function installFetchPatch(options: FetchPatchOptions): FetchPatchHandle {
  const scope: FetchScope = options.scope ?? (globalThis as FetchScope);
  const registry = scope as unknown as Record<symbol, PatchState | undefined>;
  const existing = registry[STATE_KEY];
  if (existing) {
    existing.opts = { ...options, scope };
    existing.refs += 1;
    return { restore: () => release(registry, existing) };
  }
  const originalFetch = options.originalFetch ?? scope.fetch ?? globalThis.fetch;
  if (typeof originalFetch !== "function") return { restore: () => {} };
  const state: PatchState = {
    originalFetch,
    opts: { ...options, scope },
    patched: undefined as unknown as typeof fetch,
    refs: 1,
  };
  state.patched = makePatchedFetch(state);
  registry[STATE_KEY] = state;
  scope.fetch = state.patched;
  return { restore: () => release(registry, state) };
}

function release(registry: Record<symbol, PatchState | undefined>, state: PatchState): void {
  if (state.refs > 0) state.refs -= 1;
  if (state.refs > 0) return;
  if (registry[STATE_KEY] === state) delete registry[STATE_KEY];
  // 仅当当前 fetch 仍是我们的补丁时才恢复，避免踩掉其他插件的替换
  const scope = state.opts.scope ?? (globalThis as FetchScope);
  if (scope.fetch === state.patched) scope.fetch = state.originalFetch;
}

function makePatchedFetch(state: PatchState): typeof fetch {
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (!url || !isHttpUrl(url)) return state.originalFetch(input, init);
    if (!isProxyHost(url.hostname, state.opts.hosts)) return state.originalFetch(input, init);

    if (hasBun()) {
      // Bun 原生 fetch 支持 { proxy }，直接复用其 CONNECT/TLS 实现
      const proxiedInit = {
        ...(init as Record<string, unknown> | undefined),
        proxy: `http://127.0.0.1:${state.opts.shimPort}`,
      };
      return state.originalFetch(input, proxiedInit as RequestInit);
    }
    return fetchViaShim(toRequest(input, init), url, state.opts);
  };
  return patched as typeof fetch;
}

function urlOf(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    const raw = (input as Request).url;
    return raw ? new URL(raw) : null;
  } catch {
    return null;
  }
}

function isHttpUrl(u: URL): boolean {
  return u.protocol === "https:" || u.protocol === "http:";
}

function hasBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** 构造标准 Request；流式 body 需要 duplex: "half"（Node undici 要求） */
function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  try {
    return new Request(input, init);
  } catch (e) {
    if (init && (init as { body?: unknown }).body && !(init as { duplex?: unknown }).duplex) {
      try {
        return new Request(input, { ...(init as object), duplex: "half" } as RequestInit);
      } catch {
        /* fall through to original error */
      }
    }
    throw e;
  }
}

async function fetchViaShim(req: Request, url: URL, opts: FetchPatchOptions): Promise<Response> {
  const isTls = url.protocol === "https:";
  const targetHost = url.hostname;
  const targetPort = url.port ? Number(url.port) : isTls ? 443 : 80;

  const headers: Record<string, string | string[]> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  headers["accept-encoding"] = "identity";

  const createConn = (_options: unknown, cb: (err: Error | null, socket?: Socket) => void): void => {
    tunnelToShim({ shimPort: opts.shimPort, host: targetHost, port: targetPort, isTls })
      .then((sock) => cb(null, sock as unknown as Socket))
      .catch((e: unknown) => cb(e instanceof Error ? e : new Error(String(e))));
  };
  const agent = isTls ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
  (agent as unknown as { createConnection: unknown }).createConnection = createConn;

  // provider 请求体都是小型 JSON；缓冲后显式 content-length，避免 chunked 分帧差异
  const bodyBuf = req.body ? Buffer.from(await req.arrayBuffer()) : null;
  if (bodyBuf) headers["content-length"] = String(bodyBuf.length);

  const reqOptions = {
    method: req.method,
    headers,
    agent,
    signal: req.signal as unknown as AbortSignal | undefined,
  };

  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const r = (isTls ? httpsRequest : httpRequest)(url, reqOptions as never, resolve);
    r.once("error", reject);
    r.end(bodyBuf ?? undefined);
  });
  return toWebResponse(res);
}

/** 经 shim 建立 CONNECT 隧道：net → CONNECT → 200 → （TLS）→ 返回可写 socket */
function tunnelToShim(target: {
  shimPort: number;
  host: string;
  port: number;
  isTls: boolean;
}): Promise<Socket | TLSSocket> {
  const { shimPort, host, port, isTls } = target;
  return new Promise<Socket | TLSSocket>((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port: shimPort });
    let settled = false;
    let buf = Buffer.alloc(0);
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.destroy();
      reject(e);
    };
    const ok = (s: Socket | TLSSocket): void => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      resolve(s);
    };
    sock.setTimeout(30_000, () => fail(new Error(`lazy-proxy tunnel timeout (shim 127.0.0.1:${shimPort})`)));
    sock.once("error", fail);
    sock.once("close", () => fail(new Error("lazy-proxy tunnel closed before established")));
    sock.once("connect", () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      sock.removeListener("data", onData);
      const rest = buf.subarray(idx + 4);
      const line = buf.subarray(0, idx).toString("latin1").split("\r\n")[0] ?? "";
      const status = Number(/^HTTP\/1\.[01] (\d{3})/i.exec(line)?.[1] ?? 0);
      if (status !== 200) {
        let bodyBuf = rest;
        const onMore = (c: Buffer): void => {
          bodyBuf = Buffer.concat([bodyBuf, c]);
        };
        const finish = (): void => {
          sock.removeListener("data", onMore);
          fail(new Error(extractShimError(status, bodyBuf)));
        };
        sock.on("data", onMore);
        sock.setTimeout(2000, finish);
        sock.once("end", finish);
        sock.once("close", finish);
        return;
      }
      if (rest.length > 0) sock.unshift(rest);
      if (!isTls) {
        ok(sock);
        return;
      }
      const tls = tlsConnect({
        socket: sock,
        ...(isIP(host) ? {} : { servername: host }),
        ALPNProtocols: ["http/1.1"],
      });
      tls.once("secureConnect", () => ok(tls));
      tls.once("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
    };
    sock.on("data", onData);
  });
}

function extractShimError(status: number, body: Buffer): string {
  const text = body.toString("utf8").trim();
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      const msg = parsed?.error?.message;
      if (typeof msg === "string" && msg) return msg;
    } catch {
      /* not json */
    }
  }
  return text
    ? `lazy-proxy shim error (${status}): ${text.slice(0, 200)}`
    : `lazy-proxy shim error (${status})`;
}

function toWebResponse(res: IncomingMessage): Response {
  const status = res.statusCode ?? 502;
  const headers = new Headers();
  let encoding: string | null = null;
  for (const [rawKey, rawValue] of Object.entries(res.headers)) {
    if (rawValue === undefined) continue;
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "content-encoding") {
      encoding = String(Array.isArray(rawValue) ? rawValue.join(",") : rawValue).toLowerCase();
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const v of rawValue) headers.append(key, v);
    } else {
      headers.set(key, rawValue);
    }
  }
  let source: Readable = res;
  const decoder = pickDecoder(encoding);
  if (decoder) {
    headers.delete("content-length");
    source = res.pipe(decoder);
  } else if (encoding) {
    headers.set("content-encoding", encoding);
  }
  const noBody = status === 204 || status === 304;
  return new Response(noBody ? null : nodeToWebStream(source), {
    status,
    statusText: res.statusMessage ?? "",
    headers,
  });
}

function pickDecoder(encoding: string | null): Transform | null {
  if (!encoding || encoding === "identity") return null;
  if (encoding.includes("gzip")) return createGunzip();
  if (encoding.includes("deflate")) return createInflate();
  if (encoding.includes("br")) return createBrotliDecompress();
  return null;
}

/** node Readable → WHATWG ReadableStream（含反压：desiredSize<=0 时 pause，pull 时 resume） */
function nodeToWebStream(source: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on("data", (chunk: Buffer | string) => {
        try {
          controller.enqueue(new Uint8Array(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
        } catch {
          return; // stream already closed
        }
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      source.on("error", (e: unknown) => {
        try {
          controller.error(e);
        } catch {
          /* already closed */
        }
      });
    },
    pull() {
      source.resume();
    },
    cancel() {
      source.destroy();
    },
  });
}
