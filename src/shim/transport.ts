/** 明文 TCP → 本地代理核心（mihomo mixed-port）：绝对形式 HTTP/1.1 + chunked 解码。 */

export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function parseStatusLine(line: string): number {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(line);
  if (!m) throw new Error(`bad status line: ${line}`);
  return Number(m[1]);
}

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

/** HTTP/1.1 chunked 解码器（逐段喂入，返回解出的数据片） */
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
  corePort: number;
  upstream: string;
}

/** 读取请求体（MVP 直接缓冲，保证 Content-Length 可算） */
async function readBody(request: Request): Promise<Buffer | null> {
  if (request.body === null) return null;
  return Buffer.from(await request.arrayBuffer());
}

/**
 * 将 opencode 的请求经本地代理核心转发到上游。
 * 构造绝对形式 HTTP/1.1 请求写到核心 mixed-port，响应经 chunked 解码后
 * 以流式 Response 返回（SSE 保持流式）。
 */
export async function forwardViaCore(request: Request, opts: ForwardOptions): Promise<Response> {
  const bodyBuf = await readBody(request);
  const u = new URL(request.url);
  const target = `${opts.upstream}${u.pathname}${u.search}`;
  const host = new URL(opts.upstream).host;

  const headLines: string[] = [`${request.method} ${target} HTTP/1.1`, `Host: ${host}`];
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    headLines.push(`${k}: ${v}`);
  }
  if (bodyBuf) headLines.push(`Content-Length: ${bodyBuf.length}`);
  headLines.push("Connection: close");
  const head = headLines.join("\r\n") + "\r\n\r\n";

  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({ start(c) { streamController = c; } });

  const response = new Promise<Response>((resolve, reject) => {
    let headBuf = Buffer.alloc(0);
    let parsed: { status: number; headers: Headers; mode: "length" | "chunked" | "raw"; remaining: number } | null = null;
    let decoder: ChunkDecoder | null = null;
    let settled = false;

    const fail = (err: unknown) => {
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const feed = (chunk: Uint8Array) => {
      if (!parsed || !streamController) return;
      if (parsed.mode === "chunked") {
        try {
          decoder ??= new ChunkDecoder();
          for (const piece of decoder.push(chunk)) streamController.enqueue(piece);
          if (decoder.done) {
            try { streamController.close(); } catch { /* already closed */ }
          }
        } catch (e) {
          try { streamController.error(e); } catch { /* noop */ }
        }
      } else if (parsed.mode === "length") {
        const take = Math.min(chunk.length, parsed.remaining);
        if (take > 0) streamController.enqueue(chunk.subarray(0, take));
        parsed.remaining -= take;
        if (parsed.remaining <= 0) {
          try { streamController.close(); } catch { /* noop */ }
        }
      } else {
        streamController.enqueue(chunk);
      }
    };

    Bun.connect({
      hostname: "127.0.0.1",
      port: opts.corePort,
      socket: {
        open(s) {
          s.write(head);
          if (bodyBuf && bodyBuf.length) s.write(bodyBuf);
          s.flush?.();
        },
        data(_s, buf) {
          if (!parsed) {
            headBuf = Buffer.concat([headBuf, buf]);
            const idx = headBuf.indexOf("\r\n\r\n");
            if (idx !== -1) {
              const headStr = headBuf.subarray(0, idx).toString("latin1");
              const rest = headBuf.subarray(idx + 4);
              const status = parseStatusLine(headStr.split("\r\n")[0]);
              const pairs = parseHeaderLines(headStr);
              const headers = new Headers();
              for (const [k, v] of pairs) {
                const lk = k.toLowerCase();
                if (["transfer-encoding", "content-length", "connection", "keep-alive", "trailer", "upgrade"].includes(lk)) continue;
                headers.set(k, v);
              }
              const te = pairs.find(([k]) => k.toLowerCase() === "transfer-encoding")?.[1]?.toLowerCase() ?? "";
              const clRaw = pairs.find(([k]) => k.toLowerCase() === "content-length")?.[1];
              const mode: "length" | "chunked" | "raw" = te.includes("chunked") ? "chunked" : clRaw !== undefined ? "length" : "raw";
              parsed = { status, headers, mode, remaining: mode === "length" ? Number(clRaw) : 0 };
              if (!settled) {
                settled = true;
                resolve(new Response(stream, { status, headers }));
              }
              if (rest.length) feed(rest);
            }
            return;
          }
          feed(buf);
        },
        close() {
          if (!parsed || !streamController) return;
          if (parsed.mode === "raw") {
            try { streamController.close(); } catch { /* noop */ }
          } else if (parsed.mode === "length" && parsed.remaining > 0) {
            try { streamController.error(new Error("premature close from upstream")); } catch { /* noop */ }
          }
        },
        error(_s, err) {
          fail(new Error(`core tunnel error: ${err}`));
          try { streamController?.error(new Error("core tunnel error")); } catch { /* noop */ }
        },
      },
    }).catch((e) => {
      fail(e);
    });
  });

  return response;
}
