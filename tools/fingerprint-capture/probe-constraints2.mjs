import http2 from "node:http2";
import tls from "node:tls";
import net from "node:net";

// 1) h2 flat-array header list: wire order of pseudo-headers?
await new Promise((resolve) => {
  const s = http2.createServer();
  s.on("stream", (stream, headers) => {
    console.log("h2 flat-array order:", JSON.stringify(Object.keys(headers)));
    stream.respond({ ":status": 200 }); stream.end("ok");
    s.close(); resolve();
  });
  s.listen(0, "127.0.0.1", () => {
    const c = http2.connect(`http://127.0.0.1:${s.address().port}`);
    c.on("error", (e) => { console.log("h2 err", e.message); resolve(); });
    const req = c.request([
      ":method", "POST", ":authority", "chat.deepseek.com", ":scheme", "https", ":path", "/api/v0/chat/completion",
      "sec-ch-ua-platform", "\"Windows\"", "user-agent", "UA", "sec-ch-ua", "SC", "content-type", "application/json",
    ]);
    req.on("response", () => {}); req.on("end", () => c.close()); req.end("{}");
  });
});

// 2) Which curve names does Node accept?
for (const name of ["X25519MLKEM768:X25519:P-256:P-384", "x25519_mlkem768:X25519:P-256:P-384", "X25519:P-256:P-384", "X25519:P-256:P-384:P-521"]) {
  try {
    await new Promise((res, rej) => {
      const srv = net.createServer((sock) => { sock.once("data", () => { sock.destroy(); srv.close(); res(); }); });
      srv.listen(0, "127.0.0.1", () => {
        const c = tls.connect({ host: "127.0.0.1", port: srv.address().port, rejectUnauthorized: false, ecdhCurve: name });
        c.on("error", (e) => { srv.close(); rej(e); });
      });
    });
    console.log(`curve "${name}": ACCEPTED`);
  } catch (e) { console.log(`curve "${name}": REJECTED -> ${e.message.slice(0, 80)}`); }
}

// 3) http2.connect against an http/1.1-only TLS endpoint: ALPN mismatch behaviour?
await new Promise((resolve) => {
  const srv = net.createServer((sock) => { sock.on("data", () => { try { sock.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"); } catch {} }); });
  srv.listen(0, "127.0.0.1", () => {
    const c = http2.connect(`https://127.0.0.1:${srv.address().port}`, { rejectUnauthorized: false });
    let done = false;
    const finish = (tag) => { if (done) return; done = true; console.log("h2 -> h1-only server:", tag, "| alpn:", JSON.stringify(c.alpnProtocol)); try { c.destroy(); } catch {} srv.close(); resolve(); };
    c.on("error", (e) => finish("error " + e.code + " " + e.message.slice(0, 60)));
    c.on("connect", () => console.log("   connect event, alpn =", JSON.stringify(c.alpnProtocol)));
    const r = c.request({ ":method": "POST", ":path": "/x" });
    r.on("error", (e) => finish("reqerror " + e.code));
    r.on("response", () => finish("response"));
    r.end("{}");
    setTimeout(() => finish("timeout"), 4000);
  });
});
