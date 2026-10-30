import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";

const dir = `${process.env.TEMP}\\dswmcp-cert`;
const cert = readFileSync(`${dir}\\cert.pem`);
const key = readFileSync(`${dir}\\key.pem`);

// --- A: exact group code Node emits for X25519MLKEM768 ---
const helloBytes = await new Promise((resolve) => {
  const srv = net.createServer((s) => { s.once("data", (d) => { resolve(d); s.destroy(); srv.close(); }); });
  srv.listen(0, "127.0.0.1", async () => {
    const { default: tls } = await import("node:tls");
    const c = tls.connect({ host: "127.0.0.1", port: srv.address().port, rejectUnauthorized: false, ecdhCurve: "X25519MLKEM768:X25519:P-256:P-384" });
    c.on("error", () => {});
  });
});
{
  const b = helloBytes; let o = 5 + 4 + 2 + 32;
  const sl = b[o]; o += 1 + sl;
  const cl = b.readUInt16BE(o); o += 2 + cl;
  o += 1 + b[o];
  const el = b.readUInt16BE(o); o += 2;
  const end = o + el;
  while (o + 4 <= end) {
    const t = b.readUInt16BE(o), l = b.readUInt16BE(o + 2);
    if (t === 10) { const g = []; for (let i = o + 6; i + 1 < o + 4 + l; i += 2) g.push("0x" + b.readUInt16BE(i).toString(16) + "(" + b.readUInt16BE(i) + ")"); console.log("NODE supported_groups:", g.join(" ")); }
    if (t === 51) { const g = []; let i = o + 6; while (i + 4 <= o + 4 + l) { const grp = b.readUInt16BE(i), kl = b.readUInt16BE(i + 2); g.push("0x" + grp.toString(16) + "(" + grp + "):" + kl + "b"); i += 4 + kl; } console.log("NODE key_share:", g.join(" ")); }
    o += 4 + l;
  }
}

// --- B: h2 explicit content-length placement + raw header order ---
await new Promise((resolve) => {
  const s = http2.createServer();
  s.on("stream", (stream, headers) => {
    console.log("\nH2 server sees order:", JSON.stringify(Object.keys(headers)));
    stream.respond({ ":status": 200 }); stream.end("ok");
  });
  s.on("session", (sess) => console.log("H2 server remoteSettings:", JSON.stringify(sess.remoteSettings)));
  s.listen(0, "127.0.0.1", () => {
    const c = http2.connect(`http://127.0.0.1:${s.address().port}`, {
      settings: { headerTableSize: 65536, enablePush: false, maxConcurrentStreams: 4294967295, initialWindowSize: 6291456, maxFrameSize: 16384, maxHeaderListSize: 262144 },
    });
    c.on("error", () => {});
    const req = c.request([
      ":method", "POST", ":authority", "chat.deepseek.com", ":scheme", "https", ":path", "/api/v0/chat/completion",
      "content-length", "2",
      "sec-ch-ua-platform", "\"Windows\"", "user-agent", "UA", "sec-ch-ua", "SC", "content-type", "application/json",
      "sec-ch-ua-mobile", "?0", "accept", "*/*", "origin", "https://chat.deepseek.com",
      "sec-fetch-site", "same-origin", "sec-fetch-mode", "cors", "sec-fetch-dest", "empty",
      "referer", "https://chat.deepseek.com/", "accept-encoding", "gzip, deflate, br, zstd",
      "accept-language", "zh-CN,zh;q=0.9", "priority", "u=1, i",
    ]);
    req.on("response", (h) => console.log("resp:", h[":status"]));
    req.on("end", () => { c.close(); s.close(); resolve(); });
    req.end("{}");
  });
});

// --- C: Chrome's granted connection window (server-side state) ---
await new Promise((resolve) => {
  const srv = http2.createSecureServer({ cert, key });
  srv.on("stream", (stream) => { stream.respond({ ":status": 200, "content-type": "text/html" }); stream.end("<b>ok</b>"); });
  srv.on("session", (s) => {
    setTimeout(() => {
      const st = s.state ?? {};
      console.log("\nCHROME server-side session state keys:", JSON.stringify(Object.keys(st)));
      console.log("  localWindowSize (granted by Chrome):", st.localWindowSize ?? "(n/a)");
      console.log("  remoteWindowSize:", st.remoteWindowSize ?? "(n/a)");
      console.log("  remoteSettings:", JSON.stringify(s.remoteSettings));
      resolve();
    }, 2500);
  });
  srv.listen(0, "127.0.0.1", () => {
    const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const p = `${process.env.TEMP}\\chrome-cc-${Date.now()}`;
    spawn(CHROME, ["--headless=new", `--user-data-dir=${p}`, "--no-first-run", "--ignore-certificate-errors", "--no-proxy-server", `https://127.0.0.1:${srv.address().port}/`], { stdio: "ignore" });
  });
});
process.exit(0);
