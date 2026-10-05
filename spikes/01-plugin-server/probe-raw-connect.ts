// Probe fallback: raw CONNECT tunnel over Bun.connect + raw HTTP/1.1 request.
// Targets the fake-upstream (http 17990) through the CONNECT proxy to prove the
// shim's fallback plumbing works without Bun.fetch proxy support.
const socket = await Bun.connect({
  hostname: "127.0.0.1",
  port: 17989,
  socket: {
    data(s, buf) { s.data.buffer += buf.toString("latin1"); },
    open(s) { s.data = { buffer: "" }; },
    close() {}, error() {},
  },
});
socket.data = { buffer: "" };

socket.write("CONNECT 127.0.0.1:17990 HTTP/1.1\r\nHost: 127.0.0.1:17990\r\n\r\n");
const deadline = Date.now() + 5000;
while (socket.data.buffer.indexOf("200 Connection Established") === -1) {
  if (Date.now() > deadline) { console.log("RAW: FAIL no 200"); process.exit(1); }
  await Bun.sleep(50);
}
socket.write("GET /raw-probe HTTP/1.1\r\nHost: 127.0.0.1:17990\r\nConnection: close\r\n\r\n");

const end = Date.now() + 5000;
while (socket.data.buffer.indexOf("FAKE-OK") === -1 && socket.data.buffer.indexOf("PLUGIN") === -1 && socket.data.buffer.indexOf("\"content\"") === -1) {
  if (Date.now() > end) { console.log(`RAW: FAIL body=${socket.data.buffer.slice(0, 200)}`); process.exit(1); }
  await Bun.sleep(50);
}
console.log(`RAW-OK: got upstream bytes len=${socket.data.buffer.length}`);
socket.end();
process.exit(0);
