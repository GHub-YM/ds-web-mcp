import http from "node:http";
import http2 from "node:http2";
import tls from "node:tls";
import net from "node:net";

// 1) Does node:http preserve header insertion order verbatim?
await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    console.log("http1 raw order:", JSON.stringify(req.rawHeaders.filter((_, i) => i % 2 === 0)));
    console.log("http1 has connection:", JSON.stringify(req.headers.connection), "has accept-encoding:", JSON.stringify(req.headers["accept-encoding"]));
    res.writeHead(200).end("ok");
    s.close(); resolve();
  });
  s.listen(0, "127.0.0.1", () => {
    const r = http.request({ host: "127.0.0.1", port: s.address().port, method: "POST", path: "/x",
      headers: {
        "sec-ch-ua-platform": "\"Windows\"", "User-Agent": "UA", "sec-ch-ua": "SC", "content-type": "application/json",
        "sec-ch-ua-mobile": "?0", Accept: "*/*", Origin: "https://chat.deepseek.com",
        "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
        Referer: "https://chat.deepseek.com/", "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh-CN,zh;q=0.9",
      } });
    r.on("error", (e) => { console.log("http1 err", e.message); resolve(); });
    r.end("{}");
  });
});

// 2) Pseudo-header wire order with an ARRAY-form header list.
await new Promise((resolve) => {
  const s = http2.createServer();
  s.on("stream", (stream, headers) => {
    console.log("h2 array-form order:", JSON.stringify(Object.keys(headers)));
    stream.respond({ ":status": 200 }); stream.end("ok");
    s.close(); resolve();
  });
  s.listen(0, "127.0.0.1", () => {
    const c = http2.connect(`http://127.0.0.1:${s.address().port}`);
    const req = c.request([
      [":method", "POST"], [":authority", "chat.deepseek.com"], [":scheme", "https"], [":path", "/api/v0/chat/completion"],
      ["sec-ch-ua-platform", "\"Windows\""], ["user-agent", "UA"], ["sec-ch-ua", "SC"], ["content-type", "application/json"],
    ]);
    req.on("response", () => {}); req.on("end", () => c.close()); req.end("{}");
  });
});

// 3) h2 keys accepted by Node's curve list?
for (const name of ["X25519MLKEM768:X25519:P-256:P-384", "x25519_mlkem768:X25519:P-256:P-384", "X25519:P-256:P-384"]) {
  try {
    await new Promise((res, rej) => {
      const srv = net.createServer((sock) => { sock.once("data", () => { sock.destroy(); srv.close(); res(); }); });
      srv.listen(0, "127.0.0.1", () => {
        const c = tls.connect({ host: "127.0.0.1", port: srv.address().port, rejectUnauthorized: false, ecdhCurve: name });
        c.on("error", (e) => { srv.close(); rej(e); });
      });
    });
    console.log(`curve "${name}": ACCEPTED`);
  } catch (e) { console.log(`curve "${name}": REJECTED -> ${e.message.slice(0, 90)}`); }
}

// 4) http2.connect against an http/1.1-only TLS server: does ALPN mismatch degrade cleanly?
await new Promise((resolve) => {
  const srv = net.createServer((sock) => {
    sock.on("data", () => { try { sock.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"); } catch {} });
  });
  srv.listen(0, "127.0.0.1", () => {
    const c = http2.connect(`https://127.0.0.1:${srv.address().port}`, { rejectUnauthorized: false });
    let done = false;
    const finish = (tag) => { if (done) return; done = true; console.log("h2 vs h1 server ->", tag, "| alpn:", c.alpnProtocol); try { c.destroy(); } catch {} srv.close(); resolve(); };
    c.on("error", (e) => finish("error: " + e.code + " " + e.message.slice(0, 60)));
    c.on("connect", () => { console.log("h2 connect event, alpn =", JSON.stringify(c.alpnProtocol)); });
    const r = c.request({ ":method": "POST", ":path": "/x" });
    r.on("error", (e) => finish("reqerror: " + e.code));
    r.on("response", () => finish("response"));
    r.end("{}");
    setTimeout(() => finish("timeout"), 4000);
  });
});
