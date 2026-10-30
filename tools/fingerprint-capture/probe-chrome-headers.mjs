import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const captured = [];

const srv = createServer((req, res) => {
  if (req.url.startsWith("/probe")) {
    captured.push({ url: req.url, raw: req.rawHeaders, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>probe</title><script>
  (async () => {
    await fetch('/probe/one', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await fetch('/probe/two', { method: 'GET' });
    document.title = 'done';
  })();
  </script>ok`);
});

await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;
const profile = `${process.env.TEMP}\\chrome-probe-${Date.now()}`;

const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking", `${base}/`,
], { stdio: "ignore" });

await new Promise((r) => setTimeout(r, 6000));
try { child.kill(); } catch {}

for (const c of captured) {
  console.log(`\n=== ${c.url} ===`);
  console.log("ORDER:", JSON.stringify(c.raw.filter((_, i) => i % 2 === 0)));
  for (let i = 0; i < c.raw.length; i += 2) console.log(`  ${c.raw[i]}: ${c.raw[i + 1]}`);
}
console.log("\ncaptured:", captured.length);
srv.close();
process.exit(0);
