// Minimal TCP forward proxy (CONNECT + absolute-form HTTP) for spike.
// Logs each CONNECT/http line to spike-proxy.log so we can detect whether
// Bun.fetch honored the proxy (option / env) for https.
import { appendFileSync } from "node:fs";
const LOG = "D:/LearnMT/lazy-proxy/spikes/01-plugin-server/spike-proxy.log";
function log(msg) { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); }

function pipe(socketA, socketB) {
  return { data(s, b) { socketB.write(b); }, close() { try { socketB.end(); } catch {} }, error() { try { socketB.end(); } catch {} } };
}

const server = Bun.listen({
  hostname: "127.0.0.1",
  port: 17989,
  socket: {
    open(socket) { socket.data = { buffer: "" }; },
    data(socket, buf) {
      const d = socket.data;
      if (d.tunneled) { if (d.up) d.up.write(buf); return; }
      d.buffer += buf.toString("latin1");
      const idx = d.buffer.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = d.buffer.slice(0, idx);
      const rest = d.buffer.slice(idx + 4);
      d.buffer = "";
      const firstLine = head.split("\r\n")[0];
      if (firstLine.startsWith("CONNECT ")) {
        const [, hostport] = firstLine.split(" ");
        log(`CONNECT ${hostport}`);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const [host, port] = hostport.split(":");
        d.tunneled = true;
        Bun.connect({ hostname: host, port: Number(port), socket: pipe(socket, socket) })
          .then((up) => { d.up = up; if (rest.length) up.write(rest); })
          .catch(() => { try { socket.end(); } catch {} });
      } else {
        log(`HTTP ${firstLine}`);
        const [method, url] = firstLine.split(" ");
        let u;
        try { u = new URL(url); } catch (e) { log(`ERR ${e}`); try { socket.end(); } catch {} return; }
        Bun.connect({ hostname: u.hostname, port: Number(u.port || 80), socket: pipe(socket, socket) })
          .then((up) => { d.up = up; up.write(head + "\r\n\r\n" + rest); })
          .catch(() => { try { socket.end(); } catch {} });
      }
    },
    close(socket) { try { socket.data?.up?.end?.(); } catch {} },
    error(socket, err) { log(`ERR ${err}`); },
  },
});
console.log(`FAKE-PROXY-TCP READY pid=${process.pid} port=17989`);
