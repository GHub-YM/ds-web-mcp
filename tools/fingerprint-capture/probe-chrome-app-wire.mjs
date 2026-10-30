import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const dir = `${process.env.TEMP}\\dswmcp-cert`;
const cert = readFileSync(`${dir}\\cert.pem`);
const key = readFileSync(`${dir}\\key.pem`);
const PORT = 8447;

// Mirror the exact header set src/deepseek-client.ts sends today.
const APP_HEADERS = {
  "Authorization": "Bearer TOKENVALUE",
  "X-App-Version": "2.5.0",
  "x-client-platform": "web",
  "x-client-version": "2.5.0",
  "x-client-locale": "zh_CN",
  "x-client-timezone-offset": "28800",
  "x-client-bundle-id": "com.deepseek.chat",
  "x-device-id": "1cf61b18-3e92-4c0a-a5fa-e93b2ec14b43",
  "content-type": "application/json",
  "X-DPP-Bypass-Hook": "1",
  "X-DS-PoW-Response": "BASE64POW",
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>ok
<script>
const H = ${JSON.stringify(APP_HEADERS)};
fetch('/api/v0/chat/completion', { method: 'POST', headers: H, body: JSON.stringify({prompt:'x'}) })
  .then(r => r.status).catch(() => 0);
fetch('/api/v0/chat/history_messages?chat_session_id=abc', {
  method: 'GET',
  headers: Object.fromEntries(Object.entries(H).filter(([k]) => !['content-type','X-DPP-Bypass-Hook','X-DS-PoW-Response'].includes(k)).concat([['accept','application/json']])),
}).then(r => r.status).catch(() => 0);
</script></body></html>`;

const results = [];
const srv = http2.createSecureServer({ cert, key, allowHTTP1: false });
srv.on("stream", (stream, headers) => {
  const path = headers[":path"];
  if (path.startsWith("/api/")) { results.push({ m: headers[":method"], path, order: Object.keys(headers), all: { ...headers } }); console.log("API:", headers[":method"], path); }
  const isApi = path.startsWith("/api/");
  stream.respond({ ":status": 200, "content-type": isApi ? (path.includes("completion") ? "text/event-stream" : "application/json") : "text/html; charset=utf-8" });
  stream.end(isApi ? (path.includes("completion") ? "data: {}\n\n" : JSON.stringify({ data: { biz_code: 0, biz_data: {} } })) : PAGE);
});
srv.on("error", (e) => console.log("srv error:", e.message));
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = `${process.env.TEMP}\\chrome-app-${Date.now()}`;
const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--ignore-certificate-errors", "--no-proxy-server",
  `--host-resolver-rules=MAP chat.deepseek.com 127.0.0.1:${PORT}`,
  "https://chat.deepseek.com/",
], { stdio: "ignore" });

await new Promise((r) => setTimeout(r, 9000));
try { child.kill(); } catch {}
for (const r of results) {
  console.log(`\n=== CHROME WIRE: ${r.m} ${r.path} ===`);
  console.log(JSON.stringify(r.order));
  for (const [k, v] of Object.entries(r.all)) console.log(`  ${k}: ${String(v).slice(0, 170)}`);
}
srv.close();
process.exit(0);
