import http2 from "node:http2";
import net from "node:net";

const NAMES = { 0: "DATA", 1: "HEADERS", 2: "PRIORITY", 3: "RST_STREAM", 4: "SETTINGS", 5: "PUSH_PROMISE", 6: "PING", 7: "GOAWAY", 8: "WINDOW_UPDATE", 9: "CONTINUATION" };
const SETTINGS = { 1: "HEADER_TABLE_SIZE", 2: "ENABLE_PUSH", 3: "MAX_CONCURRENT_STREAMS", 4: "INITIAL_WINDOW_SIZE", 5: "MAX_FRAME_SIZE", 6: "MAX_HEADER_LIST_SIZE" };

function dumpFrames(buf, tag) {
  console.log(`--- ${tag} (${buf.length} bytes) ---`);
  let off = 0;
  while (off + 9 <= buf.length) {
    const len = buf.readUIntBE(off, 3), type = buf[off + 3], flags = buf[off + 4];
    const sid = buf.readUInt32BE(off + 5) & 0x7fffffff;
    const p = buf.subarray(off + 9, off + 9 + len);
    let extra = "";
    if (type === 4) {
      if (flags & 1) extra = " ACK";
      else { const a = []; for (let i = 0; i + 6 <= p.length; i += 6) a.push(`${SETTINGS[p.readUInt16BE(i)] ?? p.readUInt16BE(i)}=${p.readUInt32BE(i + 2)}`); extra = " " + a.join(" "); }
    }
    if (type === 8) extra = " delta=" + (p.readUInt32BE(0) & 0x7fffffff);
    if (type === 2) extra = ` dep=0x${(p.readUInt32BE(0) & 0x7fffffff).toString(16)} excl=${(p.readUInt32BE(0) >>> 31) ? 1 : 0} weight=${p[4] + 1}`;
    if (type === 1) extra = " (hpack, " + len + "b)";
    console.log(`  ${NAMES[type] ?? type} flags=0x${flags.toString(16)} sid=${sid} len=${len}${extra}`);
    off += 9 + len;
  }
}

const srv = net.createServer((sock) => {
  const chunks = [];
  sock.on("data", (d) => chunks.push(d));
  setTimeout(() => { dumpFrames(Buffer.concat(chunks), "client->server raw"); sock.destroy(); }, 900);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

// Node's default connect: what SETTINGS does it advertise?
const s1 = http2.connect(`http://127.0.0.1:${port}`);
s1.on("error", () => {});
await new Promise((r) => setTimeout(r, 400));
s1.close();
await new Promise((r) => setTimeout(r, 700));

// With explicit Chrome-style settings + local window size.
const s2 = http2.connect(`http://127.0.0.1:${port}`, {
  settings: { headerTableSize: 65536, enablePush: false, initialWindowSize: 6291456, maxConcurrentStreams: 1000, maxHeaderListSize: 262144 },
});
s2.on("error", () => {});
await new Promise((r) => setTimeout(r, 300));
s2.setLocalWindowSize(15663105);
await new Promise((r) => setTimeout(r, 700));
s2.close();
srv.close();
