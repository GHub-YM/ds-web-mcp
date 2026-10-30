import net from "node:net";
import tls from "node:tls";

const EXT = {0:"server_name",5:"status_request",10:"supported_groups",11:"ec_point_formats",13:"signature_algorithms",16:"alpn",18:"sct",21:"padding",23:"extended_master_secret",24:"token_binding",27:"compress_certificate",28:"record_size_limit",34:"delegated_credentials",35:"session_ticket",41:"pre_shared_key",43:"supported_versions",44:"psk_key_exchange_modes",45:"early_data",49:"post_handshake_auth",50:"signature_algorithms_cert",51:"key_share",17513:"alps(0x4469)",65281:"renegotiation_info"};
const GROUPS = {29:"x25519",23:"secp256r1",24:"secp384r1",25:"secp521r1",30:"x448",256:"ffdhe2048",257:"ffdhe3072",4588:"x25519_kyber768",25497:"x25519_mlkem768"};

function parseClientHello(buf) {
  let o = 0;
  const rec = { type: buf[0], ver: buf.readUInt16BE(1), len: buf.readUInt16BE(3) };
  o = 5;
  const hsType = buf[o];
  const hsLen = buf.readUIntBE(o + 1, 3);
  o += 4;
  const legacyVer = buf.readUInt16BE(o); o += 2;
  const random = buf.subarray(o, o + 32).toString("hex"); o += 32;
  const sidLen = buf[o]; o += 1 + sidLen;
  const csLen = buf.readUInt16BE(o); o += 2;
  const ciphers = [];
  for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(o + i));
  o += csLen;
  const compLen = buf[o]; o += 1;
  const compression = [...buf.subarray(o, o + compLen)]; o += compLen;
  const extLen = buf.readUInt16BE(o); o += 2;
  const end = o + extLen;
  const exts = [];
  while (o + 4 <= end) {
    const t = buf.readUInt16BE(o); const l = buf.readUInt16BE(o + 2);
    const data = buf.subarray(o + 4, o + 4 + l);
    exts.push({ t, l, data });
    o += 4 + l;
  }
  return { rec, hsType, hsLen, legacyVer, random, ciphers, compression, exts };
}

function describe(ch, extra) {
  console.log("=== " + extra + " ===");
  console.log("record ver:", "0x" + ch.rec.ver.toString(16), "legacy_version:", "0x" + ch.legacyVer.toString(16));
  console.log("ciphers(" + ch.ciphers.length + "):", ch.ciphers.map((c) => "0x" + c.toString(16).padStart(4, "0")).join(" "));
  console.log("grease ciphers:", ch.ciphers.filter((c) => (c & 0x0f0f) === 0x0a0a).length);
  console.log("compression:", ch.compression.join(","));
  console.log("ext order(" + ch.exts.length + "):", ch.exts.map((e) => {
    const grease = (e.t & 0x0f0f) === 0x0a0a;
    return (grease ? "GREASE(0x" + e.t.toString(16) + ")" : (EXT[e.t] ?? "0x" + e.t.toString(16)));
  }).join(" > "));
  for (const e of ch.exts) {
    if (e.t === 10) { const g = []; for (let i = 2; i + 1 < e.data.length; i += 2) g.push(GROUPS[e.data.readUInt16BE(i)] ?? e.data.readUInt16BE(i)); console.log("  supported_groups:", g.join(",")); }
    if (e.t === 16) { const alpn = []; let i = 2; while (i < e.data.length) { const l2 = e.data[i]; alpn.push(e.data.subarray(i + 1, i + 1 + l2).toString()); i += 1 + l2; } console.log("  alpn:", alpn.join(",")); }
    if (e.t === 51) { const g = []; let i = 2; while (i + 4 <= e.data.length) { const grp = e.data.readUInt16BE(i); const kl = e.data.readUInt16BE(i + 2); g.push(`${GROUPS[grp] ?? grp}:${kl}b`); i += 4 + kl; } console.log("  key_share:", g.join(",")); }
    if (e.t === 43) { console.log("  supported_versions:", e.data.subarray(1).reduce((a, _, i, arr) => i % 2 ? a : a.concat("0x" + arr.readUInt16BE(i).toString(16)), []).join(",")); }
    if (e.t === 13) { const l = e.data.readUInt16BE(0); const s = []; for (let i = 2; i < 2 + l; i += 2) s.push("0x" + e.data.readUInt16BE(i).toString(16)); console.log("  sig_algs(" + s.length + "):", s.slice(0, 12).join(" ") + (s.length > 12 ? " ..." : "")); }
    if ((e.t & 0x0f0f) === 0x0a0a) console.log("  GREASE ext len:", e.l);
  }
}

async function capture(label, tlsOptions) {
  const buf = await new Promise((resolve) => {
    const srv = net.createServer((sock) => { sock.once("data", (d) => { resolve(d); sock.destroy(); srv.close(); }); });
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      const sock = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...tlsOptions });
      sock.on("error", () => {});
    });
  });
  describe(parseClientHello(buf), label);
}

await capture("node default", {});
await capture("node + chrome-ish ciphers/groups/sigalgs/alpn", {
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.3",
  ALPNProtocols: ["h2", "http/1.1"],
  ciphers: [
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
    "ECDHE-RSA-AES128-SHA",
    "ECDHE-RSA-AES256-SHA",
    "AES128-GCM-SHA256",
    "AES256-GCM-SHA384",
    "AES128-SHA",
    "AES256-SHA",
  ].join(":"),
  ecdhCurve: "X25519:P-256:P-384",
  sigalgs: "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
});
