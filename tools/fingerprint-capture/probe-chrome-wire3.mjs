import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const dir = `${process.env.TEMP}\\dswmcp-cert`;
const cert = readFileSync(`${dir}\\cert.pem`);
const key = readFileSync(`${dir}\\key.pem`);
const PORT = 8446;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>ok
<script>
window.__done = 'no';
fetch('/api/v0/chat_session/create', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': 'Bearer TOKENVALUE', 'x-client-version': '2.5.0' },
  body: '{}',
}).then(r => { window.__done = 'status:' + r.status; }).catch(e => { window.__done = 'err:' + e.message; });
</script></body></html>`;

const results = [];
const srv = http2.createSecureServer({ cert, key, allowHTTP1: false });
srv.on("stream", (stream, headers) => {
  const path = headers[":path"];
  if (path.startsWith("/api/")) { results.push({ path, order: Object.keys(headers), all: { ...headers } }); console.log("API:", path); }
  const isApi = path.startsWith("/api/");
  stream.respond({ ":status": 200, "content-type": isApi ? "application/json" : "text/html; charset=utf-8" });
  stream.end(isApi ? JSON.stringify({ data: { biz_code: 0, biz_data: {} } }) : PAGE);
});
srv.on("session", (s) => s.on("remoteSettings", (x) => console.log("Chrome SETTINGS:", JSON.stringify(x))));
srv.on("error", (e) => console.log("srv error:", e.message));
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = `${process.env.TEMP}\\chrome-wire3-${Date.now()}`;
const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--ignore-certificate-errors", "--no-proxy-server",
  `--host-resolver-rules=MAP chat.deepseek.com 127.0.0.1:${PORT}`,
  "https://chat.deepseek.com/",
], { stdio: "ignore" });

await new Promise((r) => setTimeout(r, 9000));
try { child.kill(); } catch {}
console.log("\napi captured:", results.length);
for (const r of results) {
  console.log(`\n=== TRUE CHROME WIRE ORDER: POST ${r.path} ===`);
  console.log(JSON.stringify(r.order));
  for (const [k, v] of Object.entries(r.all)) console.log(`  ${k}: ${String(v).slice(0, 160)}`);
}
srv.close();
process.exit(0);
