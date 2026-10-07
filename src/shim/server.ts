import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { DEFAULTS, type LazyProxyConfig } from "../config/schema";
import type { CoreManager } from "../core/manager";
import { forwardRequest, parseStatusLine } from "./transport";

export interface ShimHandlers {
  ensureUp: () => Promise<void>;
  onRequestStart: () => void;
  onRequestEnd: () => void;
  log: (msg: string) => void;
}

export interface ShimHandle {
  port: number;
  close: () => void;
}

/** 域名是否命中代理白名单（后缀匹配：chatgpt.com 覆盖 *.chatgpt.com） */
export function isProxyHost(host: string, patterns: readonly string[]): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase().replace(/^\*\./, "");
    if (!pat) return false;
    return h === pat || h.endsWith(`.${pat}`);
  });
}

/** 生效的白名单 = 配置的 proxyHosts + upstream 主机（shim 自身的上游永远经核心） */
export function effectiveProxyHosts(cfg: LazyProxyConfig): string[] {
  const list = [...(cfg.proxyHosts ?? DEFAULTS.proxyHosts)];
  try {
    list.push(new URL(cfg.upstream).hostname);
  } catch {
    /* upstream 非法时忽略 */
  }
  return [...new Set(list.map((s) => s.toLowerCase()))];
}

function connect502Body(msg: string): string {
  return JSON.stringify({ error: { message: `lazy-proxy core unavailable: ${msg}` } });
}

function raw502(msg: string): string {
  const body = connect502Body(msg);
  return [
    "HTTP/1.1 502 Bad Gateway",
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(body)}`,
    "connection: close",
    "",
    body,
  ].join("\r\n");
}

/**
 * 启动 shim 服务器（仅监听 127.0.0.1，node:http，Desktop/CLI 通用）。
 * - request：origin-form（baseURL 路径）→ 经核心转发；absolute-form → 白名单经核心、其余直连；
 * - connect：白名单域名 → 懒启动核心并隧道；其余域名 → 直连隧道；
 * - 只有经核心的流量计入 idle 生命周期。
 */
export function startShimServer(cfg: LazyProxyConfig, core: CoreManager): Promise<ShimHandle> {
  const handlers: ShimHandlers = {
    ensureUp: () => core.ensureUp(),
    onRequestStart: () => core.onRequestStart(),
    onRequestEnd: () => core.onRequestEnd(),
    log: (m) => console.log(`[lazy-proxy] ${m}`),
  };

  const server = createServer((req, res) => {
    void handleHttp(req, res, cfg, handlers);
  });
  server.on("connect", (req, clientSocket, head) => {
    void handleConnect(req, clientSocket as Socket, head, cfg, handlers);
  });

  return new Promise<ShimHandle>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      server.on("error", (err) => handlers.log(`server error: ${err.message}`));
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : cfg.shimPort;
      resolve({
        port,
        close: () => {
          try {
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          } catch {
            /* not supported in this runtime */
          }
          server.close();
        },
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(cfg.shimPort, "127.0.0.1");
  });
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: LazyProxyConfig,
  handlers: ShimHandlers,
): Promise<void> {
  handlers.onRequestStart();
  try {
    const raw = req.url ?? "/";
    const whitelist = effectiveProxyHosts(cfg);
    let targetUrl: string;
    let viaCore: boolean;
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      const isSelf =
        (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
        (u.port === "" || u.port === String(cfg.shimPort));
      if (isSelf) {
        targetUrl = cfg.upstream + u.pathname + u.search;
        viaCore = true;
      } else {
        targetUrl = u.toString();
        viaCore = isProxyHost(u.hostname, whitelist);
      }
    } else {
      targetUrl = cfg.upstream + raw;
      viaCore = true;
    }
    if (viaCore) {
      await handlers.ensureUp();
    }
    await forwardRequest(req, res, { corePort: viaCore ? cfg.corePort : null, targetUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    handlers.log(`forward failed: ${msg}`);
    if (!res.headersSent) {
      const body = connect502Body(msg);
      res.writeHead(502, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      res.destroy();
    }
  } finally {
    handlers.onRequestEnd();
  }
}

async function handleConnect(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  cfg: LazyProxyConfig,
  handlers: ShimHandlers,
): Promise<void> {
  const raw = req.url ?? "";
  const idx = raw.lastIndexOf(":");
  const host = (idx > 0 ? raw.slice(0, idx) : raw).replace(/^\[/, "").replace(/\]$/, "");
  const port = Number(idx > 0 ? raw.slice(idx + 1) : "443") || 443;

  if (!isProxyHost(host, effectiveProxyHosts(cfg))) {
    tunnelDirect(host, port, clientSocket, head, handlers);
    return;
  }

  handlers.onRequestStart();
  let ended = false;
  const endOnce = () => {
    if (!ended) {
      ended = true;
      handlers.onRequestEnd();
    }
  };
  clientSocket.on("close", endOnce);
  clientSocket.on("error", () => {
    /* 由 close 统一收尾 */
  });

  try {
    await handlers.ensureUp();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    handlers.log(`ensureUp failed: ${msg}`);
    if (!clientSocket.destroyed) clientSocket.end(raw502(msg));
    endOnce();
    return;
  }
  if (clientSocket.destroyed) {
    endOnce();
    return;
  }

  const coreSock = netConnect({ host: "127.0.0.1", port: cfg.corePort });
  let established = false;
  let failed = false;
  const fail = (why: string) => {
    if (failed) return;
    failed = true;
    handlers.log(`core tunnel failed (${host}:${port}): ${why}`);
    if (!clientSocket.destroyed) clientSocket.end(raw502(`core tunnel failed: ${why}`));
    coreSock.destroy();
    endOnce();
  };

  coreSock.on("error", (e) => fail(e.message));
  coreSock.on("close", () => {
    if (!established) fail("closed before tunnel established");
    else {
      if (!clientSocket.destroyed) clientSocket.destroy();
      endOnce();
    }
  });
  clientSocket.on("close", () => coreSock.destroy());
  coreSock.once("connect", () => {
    coreSock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });

  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const hdrEnd = buf.indexOf("\r\n\r\n");
    if (hdrEnd === -1) return;
    let status = 0;
    try {
      status = parseStatusLine(buf.subarray(0, hdrEnd).toString("latin1").split("\r\n")[0]);
    } catch {
      /* 保持 status=0 → 走失败分支 */
    }
    const rest = buf.subarray(hdrEnd + 4);
    coreSock.removeListener("data", onData);
    if (status !== 200) {
      fail(`core replied ${status || "bad status"}`);
      return;
    }
    established = true;
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) coreSock.write(head);
    if (rest.length) clientSocket.write(rest);
    clientSocket.pipe(coreSock);
    coreSock.pipe(clientSocket);
  };
  coreSock.on("data", onData);
}

/** 非白名单域名：直连隧道（透明穿透，不触发核心） */
function tunnelDirect(
  host: string,
  port: number,
  clientSocket: Socket,
  head: Buffer,
  handlers: ShimHandlers,
): void {
  const up = netConnect({ host, port });
  up.once("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) up.write(head);
    clientSocket.pipe(up);
    up.pipe(clientSocket);
  });
  up.on("error", (e) => {
    handlers.log(`direct tunnel failed (${host}:${port}): ${e.message}`);
    if (!clientSocket.destroyed) clientSocket.end(raw502(`direct tunnel failed: ${e.message}`));
    up.destroy();
  });
  clientSocket.on("error", () => up.destroy());
  clientSocket.on("close", () => up.destroy());
}
