// Probe: full real path offline — Bun.connect → CONNECT via fake proxy → tls.connect
// over the tunnel → raw HTTP/1.1 GET to the TLS upstream. Proves the shim's raw
// CONNECT + TLS transport without depending on external network.
import tls from "node:tls";

const socket = await Bun.connect({
  hostname: "127.0.0.1",
  port: 17989,
  socket: { open(s) { s.data = {}; }, data() {}, close() {}, error() {} },
});

socket.write("CONNECT 127.0.0.1:17991 HTTP/1.1\r\nHost: 127.0.0.1:17991\r\n\r\n");

const waitFor = async (check, timeoutMs) => {
  const end = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > end) return false; await Bun.sleep(50); }
  return true;
};

let plain = "";
const tlsSock = tls.connect({ socket, servername: "localhost", rejectUnauthorized: false });
tlsSock.on("data", (d) => { plain += d.toString("latin1"); });
tlsSock.on("secureConnect", () => {
  tlsSock.write("GET /tls-probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
});
tlsSock.on("error", (e) => { console.log(`TLS: ERR ${e.message}`); process.exit(1); });

const ok = await waitFor(() => plain.includes("FAKE-TLS-OK"), 6000);
if (ok) { console.log(`TLS-TUNNEL-OK: got ${plain.length} bytes`); process.exit(0); }
console.log(`TLS-TUNNEL-FAIL: plain=${plain.slice(0, 200)}`);
process.exit(1);
