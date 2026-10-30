import http2 from "node:http2";
import tls from "node:tls";
import net from "node:net";

// 1) which ecdhCurve names Node accepts (guard the sync throw)
function tryCurve(name) {
  const srv = net.createServer((sock) => { sock.once("data", () => { sock.destroy(); }); });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      try {
        const c = tls.connect({ host: "127.0.0.1", port: srv.address().port, rejectUnauthorized: false, ecdhCurve: name });
        c.on("error", () => { srv.close(); resolve("connect-error"); });
        c.on("secureConnect", () => { c.destroy(); srv.close(); resolve("ACCEPTED"); });
      } catch (e) { srv.close(); resolve("REJECTED: " + e.message.slice(0, 60)); }
    });
  });
}
for (const n of ["X25519MLKEM768:X25519:P-256:P-384", "x25519_mlkem768:X25519:P-256:P-384", "X25519:P-256:P-384", "X25519Kyber768Draft00:X25519:P-256"]) {
  console.log(`curve "${n}" -> ${await tryCurve(n)}`);
}

// 2) h2 -> http/1.1-only endpoint: ALPN mismatch outcome
await new Promise((resolve) => {
  const srv = net.createServer((sock) => { sock.on("data", () => { try { sock.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"); } catch {} }); });
  srv.listen(0, "127.0.0.1", () => {
    const c = http2.connect(`https://127.0.0.1:${srv.address().port}`, { rejectUnauthorized: false, ALPNProtocols: ["h2", "http/1.1"] });
    let done = false;
    const finish = (tag) => { if (done) return; done = true; console.log("h2 -> h1-only:", tag, "| alpn:", JSON.stringify(c.alpnProtocol)); try { c.destroy(); } catch {} srv.close(); resolve(); };
    c.on("error", (e) => finish("error " + e.code));
    const r = c.request({ ":method": "POST", ":path": "/x" });
    r.on("error", (e) => finish("reqerror " + e.code));
    r.on("response", () => finish("response"));
    r.end("{}");
    setTimeout(() => finish("timeout"), 4000);
  });
});

// 3) does tls.connect ALPN list "h2,http/1.1" negotiate h2 with the real host, and h1 elsewhere?
for (const host of ["chat.deepseek.com", "www.google.com"]) {
  const r = await new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ["h2", "http/1.1"] }, () => resolve({ host, alpn: s.alpnProtocol, proto: s.getProtocol() }));
    s.on("error", (e) => resolve({ host, error: e.message }));
    setTimeout(() => resolve({ host, error: "timeout" }), 12000);
  });
  console.log("ALPN:", JSON.stringify(r));
}
