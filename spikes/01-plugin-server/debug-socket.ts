const s = Bun.connect({ hostname: "127.0.0.1", port: 17989, socket: { open(x){}, data(){}, close(){}, error(){} } });
console.log("write typeof:", typeof s.write, "| end typeof:", typeof s.end, "| data setter:", typeof Object.getOwnPropertyDescriptor(s, "data"));
const p = Object.getPrototypeOf(s);
console.log("proto keys:", Object.getOwnPropertyNames(p).join(","));
s.end();
setTimeout(()=>process.exit(0), 200);
