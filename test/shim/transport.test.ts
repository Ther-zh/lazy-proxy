import { describe, expect, it } from "vitest";
import { ChunkDecoder, parseHeaderLines, parseStatusLine } from "../../src/shim/transport";

const enc = new TextEncoder();

describe("parseStatusLine", () => {
  it("parses 200 and 4xx", () => {
    expect(parseStatusLine("HTTP/1.1 200 OK")).toBe(200);
    expect(parseStatusLine("HTTP/1.1 404 Not Found")).toBe(404);
  });
  it("throws on garbage", () => {
    expect(() => parseStatusLine("not-http")).toThrow(/bad status line/);
  });
});

describe("parseHeaderLines", () => {
  it("parses header pairs after status line", () => {
    const h = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nX-A: 1";
    const pairs = parseHeaderLines(h);
    expect(pairs).toEqual([
      ["Content-Type", "text/event-stream"],
      ["X-A", "1"],
    ]);
  });
});

describe("ChunkDecoder", () => {
  it("decodes a single chunk", () => {
    const d = new ChunkDecoder();
    const out = d.push(enc.encode("5\r\nhello\r\n0\r\n\r\n"));
    expect(new TextDecoder().decode(out[0])).toBe("hello");
    expect(d.done).toBe(true);
  });

  it("decodes multiple chunks split across pushes", () => {
    const d = new ChunkDecoder();
    const all = new Uint8Array([
      ...enc.encode("5\r\n"),
      ...enc.encode("hello\r\n"),
      ...enc.encode("6\r\nworld!\r\n"),
      ...enc.encode("0\r\n\r\n"),
    ]);
    let text = "";
    for (let i = 0; i < all.length; i += 3) {
      for (const p of d.push(all.slice(i, i + 3))) text += new TextDecoder().decode(p);
    }
    expect(text).toBe("helloworld!");
    expect(d.done).toBe(true);
  });

  it("supports chunk extensions", () => {
    const d = new ChunkDecoder();
    const out = d.push(enc.encode("4;foo=bar\r\ntest\r\n0\r\n\r\n"));
    expect(new TextDecoder().decode(out[0])).toBe("test");
    expect(d.done).toBe(true);
  });

  it("throws on invalid chunk size", () => {
    const d = new ChunkDecoder();
    expect(() => d.push(enc.encode("zz\r\nabc\r\n"))).toThrow(/bad chunk size/);
  });

  it("buffers partial head", () => {
    const d = new ChunkDecoder();
    const a = d.push(enc.encode("5\r\n"));
    expect(a).toHaveLength(0);
    const b = d.push(enc.encode("he"));
    expect(new TextDecoder().decode(b[0])).toBe("he");
    const c = d.push(enc.encode("llo\r\n0\r\n\r\n"));
    expect(new TextDecoder().decode(c[0])).toBe("llo");
    expect(d.done).toBe(true);
  });
});
