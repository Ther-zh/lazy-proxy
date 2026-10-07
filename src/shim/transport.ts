import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";

/** HTTP/1.1 逐跳头（不可透传） */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 保留工具：解析 HTTP/1.1 状态行（供隧道握手与测试使用）。 */
export function parseStatusLine(line: string): number {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(line);
  if (!m) throw new Error(`bad status line: ${line}`);
  return Number(m[1]);
}

/** 保留工具：解析头部行。 */
export function parseHeaderLines(head: string): Array<[string, string]> {
  const lines = head.split("\r\n");
  const out: Array<[string, string]> = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(":");
    if (c <= 0) continue;
    out.push([lines[i].slice(0, c).trim(), lines[i].slice(c + 1).trim()]);
  }
  return out;
}

/** 保留工具：HTTP/1.1 chunked 解码器（逐段喂入，返回解出的数据片）。 */
export class ChunkDecoder {
  done = false;
  private buf = Buffer.alloc(0);
  private state: "size" | "data" | "data-crlf" = "size";
  private size = 0;

  push(input: Uint8Array): Uint8Array[] {
    if (this.done) return [];
    this.buf = Buffer.concat([this.buf, Buffer.from(input)]);
    const out: Uint8Array[] = [];
    let i = 0;
    while (i < this.buf.length) {
      if (this.state === "size") {
        const nl = this.buf.indexOf("\r\n", i);
        if (nl === -1) {
          this.buf = this.buf.subarray(i);
          return out;
        }
        const line = this.buf.subarray(i, nl).toString("latin1");
        const hex = line.split(";")[0].trim();
        if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`bad chunk size: ${line}`);
        this.size = parseInt(hex, 16);
        i = nl + 2;
        if (this.size === 0) {
          this.done = true;
          this.buf = Buffer.alloc(0);
          return out;
        }
        this.state = "data";
      } else if (this.state === "data") {
        const avail = this.buf.length - i;
        const take = Math.min(avail, this.size);
        if (take > 0) {
          out.push(Uint8Array.from(this.buf.subarray(i, i + take)));
          i += take;
          this.size -= take;
        }
        if (this.size === 0) this.state = "data-crlf";
        else if (avail === 0) {
          this.buf = this.buf.subarray(i);
          return out;
        }
      } else {
        if (this.buf.length - i < 2) {
          this.buf = this.buf.subarray(i);
          return out;
        }
        if (this.buf[i] !== 13 || this.buf[i + 1] !== 10) {
          throw new Error("bad chunk terminator");
        }
        i += 2;
        this.state = "size";
      }
    }
    this.buf = this.buf.subarray(i);
    return out;
  }
}

export interface ForwardOptions {
  /** null → 直连目标；数字 → 以绝对形式 request-target 经 127.0.0.1:<corePort> 转发 */
  corePort: number | null;
  /** 目标绝对 URL */
  targetUrl: string;
}

/**
 * 转发一个 HTTP 请求（流式）：经核心（mihomo mixed-port）或直连。
 * node:http 客户端自动处理 chunked/content-length 与 SSE 流式。
 */
export function forwardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ForwardOptions,
): Promise<void> {
  const target = new URL(opts.targetUrl);
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers["host"] = target.host;

  const viaCore = opts.corePort !== null;
  const send = (viaCore || target.protocol !== "https:" ? httpRequest : httpsRequest) as typeof httpRequest;
  const requestOptions: RequestOptions = viaCore
    ? { host: "127.0.0.1", port: opts.corePort ?? undefined, method: req.method, path: opts.targetUrl, headers, agent: false }
    : {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        agent: false,
      };

  return new Promise<void>((resolve, reject) => {
    const upstream = send(
      requestOptions,
      (upRes) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined) continue;
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          outHeaders[k] = v;
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(res);
        upRes.on("end", () => resolve());
        upRes.on("error", (e) => {
          res.destroy();
          reject(e);
        });
      },
    );
    upstream.on("error", reject);
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  });
}
