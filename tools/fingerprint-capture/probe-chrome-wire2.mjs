import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const dir = `${process.env.TEMP}\\dswmcp-cert`;
const cert = readFileSync(`${dir}\\cert.pem`);
const key = readFileSync(`${dir}\\key.pem`);
const PORT = 8444;

const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title><body>ok</body><script>
(async () => {
  const s = await fetch('/api/v0/chat_session/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer TOKENVALUE', 'x-client-version': '2.5.0' },
    body: '{}',
  }).then(r => r.status).catch(e => 'err:' + e.message);
  document.title = 'done:' + s;
})();
</script>`;

const results = [];
const srv = http2.createSecureServer({ cert, key, allowHTTP1: false });
srv.on("stream", (stream, headers) => {
  const path = headers[":path"];
  console.log("STREAM:", path);
  if (path.startsWith("/api/")) results.push({ path, order: Object.keys(headers), all: { ...headers } });
  stream.respond({ ":status": 200, "content-type": path.startsWith("/api/") ? "application/json" : "text/html; charset=utf-8" });
  stream.end(path.startsWith("/api/") ? JSON.stringify({ data: { biz_code: 0, biz_data: {} } }) : PAGE);
});
srv.on("session", (s) => s.on("remoteSettings", (x) => console.log("Chrome SETTINGS:", JSON.stringify(x))));
srv.on("error", (e) => console.log("srv error:", e.message));
await new Promise((r) => srv.listen(PORT, "0.0.0.0", r));
console.log("impersonator on " + PORT);

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = `${process.env.TEMP}\\chrome-map2-${Date.now()}`;
const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--ignore-certificate-errors", "--disable-features=HttpsUpgrades,HTTPSFirstMode",
  `--host-resolver-rules=MAP chat.deepseek.com 127.0.0.1:${PORT},MAP fe-static.deepseek.com 127.0.0.1:${PORT}`,
  "https://chat.deepseek.com/",
], { stdio: "ignore" });
child.stdout?.on("data", d => process.stdout.write("[chrome] " + d));
child.stderr?.on("data", d => process.stdout.write("[chrome-err] " + d));

await new Promise((r) => setTimeout(r, 10000));
try { child.kill(); } catch {}
console.log("\napi captured:", results.length);
for (const r of results) {
  console.log(`\n=== REAL-WIRE ${r.path} ===`);
  console.log("ORDER:", JSON.stringify(r.order));
  for (const [k, v] of Object.entries(r.all)) console.log(`  ${k}: ${String(v).slice(0, 150)}`);
}
srv.close();
process.exit(0);
