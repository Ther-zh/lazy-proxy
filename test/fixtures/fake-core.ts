/** 测试用假"核心代理"：TCP 监听，把绝对形式 HTTP/1.1 请求转发到目标主机。 */

function pipe(socketA: any, socketB: any) {
  return {
    data(_s: any, b: Uint8Array) {
      socketB.write(b);
    },
    close() {
      try {
        socketB.end();
      } catch {
        /* noop */
      }
    },
    error() {
      try {
        socketB.end();
      } catch {
        /* noop */
      }
    },
  };
}

export function startFakeCoreProxy(port: number): Promise<{ port: number; hits: () => number; stop: () => void }> {
  return new Promise((resolve) => {
    let hits = 0;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(s: any) {
          s.data = { buffer: "" };
        },
        data(socket: any, buf: Uint8Array) {
          const d = socket.data;
          d.buffer += new TextDecoder("latin1").decode(buf);
          const idx = d.buffer.indexOf("\r\n\r\n");
          if (idx === -1) return;
          const head = d.buffer.slice(0, idx);
          const rest = d.buffer.slice(idx + 4);
          d.buffer = "";
          const firstLine = head.split("\r\n")[0];
          const [method, url] = firstLine.split(" ");
          hits++;
          let u: URL;
          try {
            u = new URL(url);
          } catch {
            try {
              socket.end();
            } catch {
              /* noop */
            }
            return;
          }
          Bun.connect({ hostname: u.hostname, port: Number(u.port || 80), socket: pipe(socket, socket) })
            .then((up: any) => {
              d.up = up;
              up.write(head + "\r\n\r\n" + rest);
            })
            .catch(() => {
              try {
                socket.end();
              } catch {
                /* noop */
              }
            });
        },
        close(socket: any) {
          try {
            socket.data?.up?.end?.();
          } catch {
            /* noop */
          }
        },
        error() {
          /* noop */
        },
      },
    });
    resolve({ port: server.port!, hits: () => hits, stop: () => server.stop() });
  });
}
