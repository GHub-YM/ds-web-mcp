import net from "node:net";
import tls from "node:tls";
import { spawn } from "node:child_process";

const EXT = {0:"server_name",5:"status_request",10:"supported_groups",11:"ec_point_formats",13:"signature_algorithms",16:"alpn",18:"sct",21:"padding",23:"extended_master_secret",24:"token_binding",27:"compress_certificate",28:"record_size_limit",34:"delegated_credentials",35:"session_ticket",41:"pre_shared_key",42:"early_data_dup",43:"supported_versions",44:"psk_key_exchange_modes",45:"early_data",49:"post_handshake_auth",50:"signature_algorithms_cert",51:"key_share",17513:"application_settings(alps)",65281:"renegotiation_info",65037:"encrypted_client_hello"};
const GROUPS = {29:"x25519",23:"secp256r1",24:"secp384r1",25:"secp521r1",30:"x448",256:"ffdhe2048",257:"ffdhe3072",4588:"x25519_kyber768",25497:"x25519_mlkem768",4587:"x25519_kyber768_old"};

function parse(buf) {
  let o = 5;
  o += 4;
  const legacyVer = buf.readUInt16BE(o); o += 2;
  const random = buf.subarray(o, o + 32); o += 32;
  const sidLen = buf[o]; o += 1 + sidLen;
  const csLen = buf.readUInt16BE(o); o += 2;
  const ciphers = []; for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(o + i));
  o += csLen;
  const compLen = buf[o]; o += 1;
  const compression = [...buf.subarray(o, o + compLen)]; o += compLen;
  // session_id length on the wire is after ciphers in TLS1.2 style; handle both
  const extLen = buf.readUInt16BE(o); o += 2;
  const exts = []; const end = Math.min(o + extLen, buf.length);
  while (o + 4 <= end) {
    const t = buf.readUInt16BE(o), l = buf.readUInt16BE(o + 2);
    exts.push({ t, l, data: buf.subarray(o + 4, o + 4 + l) }); o += 4 + l;
  }
  return { legacyVer, random, ciphers, compression, exts };
}

function summarize(tag, ch) {
  const greaseC = ch.ciphers.filter((c) => (c & 0x0f0f) === 0x0a0a);
  console.log(`\n### ${tag}`);
  console.log("  record/legacy ver:", "0x" + ch.legacyVer.toString(16));
  console.log("  random ends 0x0a0a (GREASE):", (ch.random[31] === 0x0a && ch.random[30] === 0x0a));
  console.log("  GREASE ciphers:", greaseC.map((c) => "0x" + c.toString(16)).join(",") || "none");
  console.log("  ciphers(" + ch.ciphers.length + "):", ch.ciphers.map((c) => "0x" + c.toString(16).padStart(4, "0")).join(" "));
  console.log("  ext order(" + ch.exts.length + "):", ch.exts.map((e) => (e.t & 0x0f0f) === 0x0a0a ? "GREASE" : (EXT[e.t] ?? "0x" + e.t.toString(16))).join(" > "));
  for (const e of ch.exts) {
    if (e.t === 10) { const g = []; for (let i = 2; i + 1 < e.data.length; i += 2) g.push(GROUPS[e.data.readUInt16BE(i)] ?? e.data.readUInt16BE(i)); console.log("    groups:", g.join(",")); }
    if (e.t === 16) { const a = []; let i = 2; while (i < e.data.length) { const l = e.data[i]; a.push(e.data.subarray(i + 1, i + 1 + l).toString()); i += 1 + l; } console.log("    alpn:", a.join(",")); }
    if (e.t === 51) { const g = []; let i = 2; while (i + 4 <= e.data.length) { const grp = e.data.readUInt16BE(i), kl = e.data.readUInt16BE(i + 2); g.push(`${GROUPS[grp] ?? grp}:${kl}b`); i += 4 + kl; } console.log("    key_share:", g.join(",")); }
    if (e.t === 13) { const l = e.data.readUInt16BE(0), s = []; for (let i = 2; i < 2 + l; i += 2) s.push("0x" + e.data.readUInt16BE(i).toString(16)); console.log("    sig_algs(" + s.length + "):", s.join(" ")); }
    if (e.t === 43) { const s = []; for (let i = 1; i + 1 < e.data.length; i += 2) s.push("0x" + e.data.readUInt16BE(i).toString(16)); console.log("    versions:", s.join(",")); }
    if (e.t === 11) console.log("    ec_point_formats:", [...e.data.subarray(1)].join(","));
    if (e.t === 0) console.log("    sni:", e.data.subarray(5).toString());
    if (e.t === 17513) console.log("    alps:", e.data.subarray(5).toString());
  }
}

// --- Capture real Chrome ClientHello by pointing it at a local TLS listener ---
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const captured = await new Promise((resolve) => {
  const srv = net.createServer((sock) => { sock.once("data", (d) => { resolve(d); sock.destroy(); srv.close(); }); });
  srv.listen(0, "127.0.0.1", async () => {
    const port = srv.address().port;
    const profile = `${process.env.TEMP}\\chrome-hello-${Date.now()}`;
    spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--ignore-certificate-errors", "--disable-extensions", `https://127.0.0.1:${port}/`], { stdio: "ignore" });
    setTimeout(() => { try { srv.close(); } catch {} }, 12000);
  });
});
summarize("REAL Chrome 153 ClientHello (captured on this host)", parse(captured));
