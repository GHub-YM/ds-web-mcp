import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const dir = `${process.env.TEMP}\\dswmcp-cert`;
const cert = readFileSync(`${dir}\\cert.pem`);
const key = readFileSync(`${dir}\\key.pem`);
const PORT = 8443;

const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title><body>ok</body><script>
(async () => {
  const j = await fetch('/api/v0/chat_session/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer TOKENVALUE', 'x-client-version': '2.5.0' },
    body: '{}',
  }).then(r => r.status).catch(() => 'err');
  document.title = 'done:' + j;
})();
</script>`;

const results = [];
const srv = http2.createSecureServer({ cert, key, allowHTTP1: false });
srv.on("stream", (stream, headers) => {
  const path = headers[":path"];
  if (path === "/api/v0/chat_session/create") {
    results.push({ path, order: Object.keys(headers), all: { ...headers } });
  }
  stream.respond({ ":status": 200, "content-type": path.startsWith("/api/") ? "application/json" : "text/html; charset=utf-8" });
  stream.end(path.startsWith("/api/") ? JSON.stringify({ data: { biz_code: 0, biz_data: {} } }) : PAGE);
});
srv.on("session", (s) => s.on("remoteSettings", (x) => console.log("Chrome SETTINGS:", JSON.stringify(x))));
srv.on("error", (e) => console.log("srv error:", e.message));
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
console.log("local chat.deepseek.com impersonator on 127.0.0.1:" + PORT);

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = `${process.env.TEMP}\\chrome-map-${Date.now()}`;
const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--ignore-certificate-errors",
  `--host-resolver-rules=MAP chat.deepseek.com 127.0.0.1:${PORT}`,
  "https://chat.deepseek.com/",
], { stdio: "ignore" });

await new Promise((r) => setTimeout(r, 9000));
try { child.kill(); } catch {}

console.log("\napi requests captured:", results.length);
for (const r of results) {
  console.log(`\n=== REAL-WIRE ${r.path} ===`);
  console.log("ORDER:", JSON.stringify(r.order));
  for (const [k, v] of Object.entries(r.all)) console.log(`  ${k}: ${String(v).slice(0, 150)}`);
}
srv.close();
process.exit(0);
