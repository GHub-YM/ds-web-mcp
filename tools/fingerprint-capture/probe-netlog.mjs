import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const netlog = `${process.env.TEMP}\\chrome-netlog-${Date.now()}.json`;
const profile = `${process.env.TEMP}\\chrome-netlog-profile-${Date.now()}`;

const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--net-log-capture-mode=Everything", `--log-net-log=${netlog}`,
  "https://chat.deepseek.com/",
], { stdio: "ignore" });

await new Promise((r) => setTimeout(r, 14000));
try { child.kill(); } catch {}
await new Promise((r) => setTimeout(r, 2500));

console.log("netlog exists:", existsSync(netlog));
if (!existsSync(netlog)) process.exit(1);
const raw = JSON.parse(readFileSync(netlog, "utf8"));
const events = raw.events ?? [];
console.log("netlog events:", events.length, "| constants:", Object.keys(raw.constants ?? {}).length);

const typeName = (t) => raw.constants?.logEventTypes?.[t] ?? String(t);
const srcName = (s) => raw.constants?.logSourceType?.[s] ?? String(s);

const interesting = events.filter((e) => {
  const n = typeName(e.type);
  return n === "HTTP2_SESSION_SEND_HEADERS" || n === "HTTP2_SESSION_RECV_SETTINGS" || n === "HTTP2_SESSION_SEND_SETTINGS" || n === "HTTP2_SESSION_UPDATE_RECV_WINDOW" || n === "HTTP2_SESSION_UPDATE_SEND_WINDOW" || n === "HTTP2_SESSION_SEND_WINDOW_UPDATE";
});
console.log("interesting h2 events:", interesting.length);

const headers = interesting.filter((e) => typeName(e.type) === "HTTP2_SESSION_SEND_HEADERS");
console.log("sendHeaders events:", headers.length);
for (const h of headers.slice(0, 4)) {
  const p = h.params ?? {};
  console.log(`\n=== HTTP2_SESSION_SEND_HEADERS stream_id=${p.stream_id} ===`);
  console.log("keys:", Object.keys(p));
  console.log("headers type:", typeof p.headers, Array.isArray(p.headers) ? "array" : "");
  console.log("raw headers:", JSON.stringify(p.headers).slice(0, 1200));
}

const others = interesting.filter((e) => typeName(e.type) !== "HTTP2_SESSION_SEND_HEADERS");
for (const o of others.slice(0, 8)) console.log("  ", typeName(o.type), JSON.stringify(o.params).slice(0, 300));
