import { spawn } from "node:child_process";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9334;
const profile = `${process.env.TEMP}\\chrome-cdp-${Date.now()}`;
const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--window-size=1280,900",
  "--remote-debugging-port=" + port, "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3500);
async function j(path, method = "GET") { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method }); return r.json(); }
let version;
for (let i = 0; i < 20; i++) { try { version = await j("/json/version"); break; } catch { await sleep(500); } }
console.log("browser:", version?.Browser);

const target = await j("/json/new?about:blank", "PUT");
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); });
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Network.enable");
await send("Page.navigate", { url: "https://chat.deepseek.com/" });
await sleep(12000);

const reqs = events.filter((e) => e.method === "Network.requestWillBeSent");
const extras = events.filter((e) => e.method === "Network.requestWillBeSentExtraInfo");
const api = reqs.filter((r) => r.params.request.url.includes("/api/") || r.params.request.url.includes("deepseek"));

console.log("total network requests:", reqs.length, "| api-ish:", api.length);
for (const e of api.slice(0, 6)) {
  const u = e.params.request.url;
  const match = extras.find((x) => x.params.requestId === e.params.requestId);
  const hdrs = match?.params?.headers ?? e.params.request.headers;
  console.log(`\n=== ${e.params.request.method} ${u} ===`);
  console.log("ORDER:", JSON.stringify(Object.keys(hdrs)));
  for (const [k, v] of Object.entries(hdrs)) console.log(`  ${k}: ${v}`);
}
if (!api.length) {
  console.log("\nno /api requests; dumping first 8 request URLs + their header order:");
  for (const e of reqs.slice(0, 8)) {
    const match = extras.find((x) => x.params.requestId === e.params.requestId);
    const hdrs = match?.params?.headers ?? e.params.request.headers;
    console.log(`\n=== ${e.params.request.method} ${e.params.request.url.slice(0, 110)} ===`);
    console.log("ORDER:", JSON.stringify(Object.keys(hdrs)));
    for (const [k, v] of Object.entries(hdrs)) console.log(`  ${k}: ${String(v).slice(0, 160)}`);
  }
}
try { child.kill(); } catch {}
process.exit(0);
