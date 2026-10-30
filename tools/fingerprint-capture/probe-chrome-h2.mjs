import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const dir = `${process.env.TEMP}\\dswmcp-cert`;
const cert = readFileSync(`${dir}\\cert.pem`);
const key = readFileSync(`${dir}\\key.pem`);

const seen = [];
const srv = http2.createSecureServer({ cert, key, allowHTTP1: false });
srv.on("stream", (stream, headers) => {
  seen.push({ headers, raw: stream.session ? null : null });
  console.log("\n=== Chrome h2 stream ===");
  console.log("ORDER:", JSON.stringify(Object.keys(headers)));
  for (const [k, v] of Object.entries(headers)) console.log(`  ${k}: ${String(v).slice(0, 140)}`);
  stream.respond({ ":status": 200, "content-type": "application/json" });
  stream.end(JSON.stringify({ ok: true }));
});
srv.on("session", (s) => {
  s.on("remoteSettings", (x) => console.log("Chrome client SETTINGS:", JSON.stringify(x)));
});
srv.on("error", (e) => console.log("srv error", e.message));

await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = `${process.env.TEMP}\\chrome-h2probe-${Date.now()}`;
const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--ignore-certificate-errors", "--allow-insecure-localhost",
  `https://127.0.0.1:${port}/api/v0/page`,
], { stdio: "ignore" });

await new Promise((r) => setTimeout(r, 8000));
try { child.kill(); } catch {}
console.log("\nstreams observed:", seen.length);
srv.close();
process.exit(0);
