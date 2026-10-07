/** 测试用假"核心代理"：TCP 监听。
 *  - CONNECT host:port → 回 200 后进入隧道模式（echo，模拟已建立的上游隧道）；
 *  - 绝对形式 HTTP/1.1 → 直连目标并双向透传。 */
import { createServer as createTcpServer, connect as netConnect } from "node:net";

export interface FakeCoreHandle {
  port: number;
  hits: () => number;
  connectHits: () => number;
  stop: () => void;
}

export function startFakeCoreProxy(port: number): Promise<FakeCoreHandle> {
  let hits = 0;
  let connectHits = 0;
  const server = createTcpServer((socket) => {
    let buf = Buffer.alloc(0);
    let mode: "head" | "tunnel" | "http" = "head";
    socket.on("error", () => {
      /* noop */
    });
    socket.on("data", (chunk: string | Buffer) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (mode === "tunnel") {
        socket.write(data);
        return;
      }
      if (mode === "http") return;
      buf = Buffer.concat([buf, data]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = buf.subarray(0, idx).toString("latin1");
      const rest = buf.subarray(idx + 4);
      const [method, url] = head.split("\r\n")[0].split(" ");
      hits++;
      if (method === "CONNECT") {
        mode = "tunnel";
        connectHits++;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) socket.write(rest);
        return;
      }
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        socket.end();
        return;
      }
      mode = "http";
      const up = netConnect({ host: u.hostname, port: Number(u.port || 80) }, () => {
        up.write(head + "\r\n\r\n");
        if (rest.length) up.write(rest);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on("error", () => socket.destroy());
      socket.on("close", () => up.destroy());
    });
  });
  return new Promise<FakeCoreHandle>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr !== null ? addr.port : port;
      resolve({
        port: actual,
        hits: () => hits,
        connectHits: () => connectHits,
        stop: () => server.close(),
      });
    });
  });
}
