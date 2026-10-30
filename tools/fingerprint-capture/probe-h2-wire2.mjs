import http2 from "node:http2";
import net from "node:net";

const NAMES = { 0: "DATA", 1: "HEADERS", 2: "PRIORITY", 3: "RST_STREAM", 4: "SETTINGS", 5: "PUSH_PROMISE", 6: "PING", 7: "GOAWAY", 8: "WINDOW_UPDATE", 9: "CONTINUATION" };
const SETTINGS = { 1: "HEADER_TABLE_SIZE", 2: "ENABLE_PUSH", 3: "MAX_CONCURRENT_STREAMS", 4: "INITIAL_WINDOW_SIZE", 5: "MAX_FRAME_SIZE", 6: "MAX_HEADER_LIST_SIZE", 8: "ENABLE_CONNECT_PROTOCOL" };
const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "ascii");

function dumpFrames(buf, tag) {
  console.log(`--- ${tag} (${buf.length} bytes) ---`);
  let off = 0;
  if (buf.subarray(0, 24).equals(PREFACE)) off = 24;
  else console.log("  NO PREFACE");
  while (off + 9 <= buf.length) {
    const len = buf.readUIntBE(off, 3), type = buf[off + 3], flags = buf[off + 4];
    const sid = buf.readUInt32BE(off + 5) & 0x7fffffff;
    const p = buf.subarray(off + 9, off + 9 + len);
    let extra = "";
    if (type === 4) {
      if (flags & 1) extra = " ACK";
      else { const a = []; for (let i = 0; i + 6 <= p.length; i += 6) a.push(`${SETTINGS[p.readUInt16BE(i)] ?? "0x" + p.readUInt16BE(i).toString(16)}=${p.readUInt32BE(i + 2)}`); extra = " " + a.join(" "); }
    }
    if (type === 8) extra = " delta=" + (p.readUInt32BE(0) & 0x7fffffff);
    console.log(`  ${NAMES[type] ?? type} flags=0x${flags.toString(16)} sid=${sid} len=${len}${extra}`);
    off += 9 + len;
  }
}

function capture(label, opts, extraCalls) {
  return new Promise(async (resolve) => {
    const srv = net.createServer((sock) => {
      const chunks = [];
      sock.on("data", (d) => chunks.push(d));
      setTimeout(() => { dumpFrames(Buffer.concat(chunks), label); sock.destroy(); srv.close(); resolve(); }, 1100);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const s = http2.connect(`http://127.0.0.1:${port}`, opts);
    s.on("error", () => {});
    await new Promise((r) => setTimeout(r, 350));
    try { extraCalls?.(s); } catch (e) { console.log("  call err:", e.message); }
  });
}

await capture("A: node default", {});
await capture("B: chrome settings + setLocalWindowSize(15663105)", {
  settings: { headerTableSize: 65536, enablePush: false, initialWindowSize: 6291456, maxConcurrentStreams: 1000, maxHeaderListSize: 262144 },
});
await capture("C: chrome settings + setLocalWindowSize called", {
  settings: { headerTableSize: 65536, enablePush: false, initialWindowSize: 6291456, maxConcurrentStreams: 1000, maxHeaderListSize: 262144 },
}, (s) => { s.setLocalWindowSize(15663105); console.log("  setLocalWindowSize returned ok"); });
