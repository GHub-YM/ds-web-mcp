import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const dir = `${process.env.TEMP}\\dswmcp-cert`;
const cert = readFileSync(`${dir}\\cert.pem`);
const key = readFileSync(`${dir}\\key.pem`);
const PORT = 8448;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>ok
<script>
document.cookie = "ds_session_id=abc123; path=/";
document.cookie = "HWWAFSESID=def456; path=/";
setTimeout(() => {
  fetch('/api/v0/chat/completion', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': 'Bearer T',
      'x-client-version': '2.5.0',
      'x-client-platform': 'web',
      'x-app-version': '2.5.0',
      'x-client-locale': 'zh_CN',
      'x-client-timezone-offset': '28800',
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-device-id': 'dev-1',
      'X-DPP-Bypass-Hook': '1',
      'X-DS-PoW-Response': 'POW',
    },
    body: JSON.stringify({ prompt: 'x' }),
  }).then(r => r.status).catch(() => 0);
}, 200);
</script></body></html>`;

const results = [];
const srv = http2.createSecureServer({ cert, key, allowHTTP1: false });
srv.on("stream", (stream, headers) => {
  const path = headers[":path"];
  if (path.startsWith("/api/")) { results.push({ order: Object.keys(headers), all: { ...headers } }); }
  const isApi = path.startsWith("/api/");
  stream.respond({ ":status": 200, "content-type": isApi ? "text/event-stream" : "text/html; charset=utf-8", "set-cookie": ["ds_session_id=abc123; Path=/; Secure"] });
  stream.end(isApi ? "data: {}\n\n" : PAGE);
});
srv.on("error", (e) => console.log("srv error:", e.message));
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = `${process.env.TEMP}\\chrome-cookie-${Date.now()}`;
const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--ignore-certificate-errors", "--no-proxy-server",
  `--host-resolver-rules=MAP chat.deepseek.com 127.0.0.1:${PORT}`,
  "https://chat.deepseek.com/",
], { stdio: "ignore" });

await new Promise((r) => setTimeout(r, 10000));
try { child.kill(); } catch {}
for (const r of results) {
  console.log("=== CHROME WIRE ORDER (with cookies present) ===");
  console.log(JSON.stringify(r.order));
  for (const [k, v] of Object.entries(r.all)) console.log(`  ${k}: ${String(v).slice(0, 130)}`);
}
srv.close();
process.exit(0);
