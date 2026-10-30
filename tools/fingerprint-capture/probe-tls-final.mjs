import net from "node:net";
import tls from "node:tls";

const EXT = {0:"sni",5:"status_request",10:"supported_groups",11:"ec_point_formats",13:"signature_algorithms",16:"alpn",18:"sct",21:"padding",23:"extended_master_secret",27:"compress_certificate",28:"record_size_limit",35:"session_ticket",41:"pre_shared_key",43:"supported_versions",44:"psk_key_exchange_modes",45:"early_data",49:"post_handshake_auth",50:"sig_algs_cert",51:"key_share",17513:"alps",65281:"renegotiation_info",65037:"ech"};
const GROUPS = {29:"x25519",23:"secp256r1",24:"secp384r1",25:"secp521r1",30:"x448",4588:"x25519_kyber768",25497:"x25519_mlkem768"};

function parse(buf) {
  let o = 5 + 4; o += 2; o += 32;
  const sidLen = buf[o]; o += 1 + sidLen;
  const csLen = buf.readUInt16BE(o); o += 2;
  const ciphers = []; for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(o + i));
  o += csLen;
  const compLen = buf[o]; o += 1; o += compLen;
  const extLen = buf.readUInt16BE(o); o += 2;
  const exts = []; const end = Math.min(o + extLen, buf.length);
  while (o + 4 <= end) { const t = buf.readUInt16BE(o), l = buf.readUInt16BE(o + 2); exts.push({ t, l, data: buf.subarray(o + 4, o + 4 + l) }); o += 4 + l; }
  return { ciphers, exts };
}

function capture(label, opts) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => { sock.once("data", (d) => { try { sock.destroy(); } catch {} srv.close();
      const ch = parse(d);
      console.log(`\n### ${label}`);
      console.log("  ciphers:", ch.ciphers.map((c) => "0x" + c.toString(16).padStart(4, "0")).join(" "));
      console.log("  exts:", ch.exts.map((e) => EXT[e.t] ?? "0x" + e.t.toString(16)).join(" > "));
      for (const e of ch.exts) {
        if (e.t === 10) { const g = []; for (let i = 2; i + 1 < e.data.length; i += 2) g.push(GROUPS[e.data.readUInt16BE(i)] ?? e.data.readUInt16BE(i)); console.log("    groups:", g.join(",")); }
        if (e.t === 51) { const g = []; let i = 2; while (i + 4 <= e.data.length) { const grp = e.data.readUInt16BE(i), kl = e.data.readUInt16BE(i + 2); g.push(`${GROUPS[grp] ?? grp}:${kl}b`); i += 4 + kl; } console.log("    key_share:", g.join(",")); }
        if (e.t === 13) { const l = e.data.readUInt16BE(0), s = []; for (let i = 2; i < 2 + l; i += 2) s.push("0x" + e.data.readUInt16BE(i).toString(16)); console.log("    sigalgs(" + s.length + "):", s.join(" ")); }
        if (e.t === 16) { const a = []; let i = 2; while (i < e.data.length) { const l = e.data[i]; a.push(e.data.subarray(i + 1, i + 1 + l).toString()); i += 1 + l; } console.log("    alpn:", a.join(",")); }
      }
      resolve();
    }); });
    srv.listen(0, "127.0.0.1", () => {
      try { const c = tls.connect({ host: "127.0.0.1", port: srv.address().port, rejectUnauthorized: false, ...opts }); c.on("error", () => {}); }
      catch (e) { console.log(`### ${label} — THREW: ${e.message.slice(0, 70)}`); srv.close(); resolve(); }
    });
  });
}

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const TLS13 = ["TLS_AES_128_GCM_SHA256","TLS_AES_256_GCM_SHA384","TLS_CHACHA20_POLY1305_SHA256"];
const TLS12_CHROME = ["ECDHE-ECDSA-AES128-GCM-SHA256","ECDHE-RSA-AES128-GCM-SHA256","ECDHE-ECDSA-AES256-GCM-SHA384","ECDHE-RSA-AES256-GCM-SHA384","ECDHE-ECDSA-CHACHA20-POLY1305","ECDHE-RSA-CHACHA20-POLY1305","ECDHE-RSA-AES128-SHA","ECDHE-RSA-AES256-SHA","AES128-GCM-SHA256","AES256-GCM-SHA384","AES128-SHA","AES256-SHA"];

await capture("chosen: TLS1.3 order + PQ group + chrome sigalgs + alpn", {
  minVersion: "TLSv1.2", maxVersion: "TLSv1.3",
  ciphers: [...TLS13, ...TLS12_CHROME].join(":"),
  ecdhCurve: "X25519MLKEM768:X25519:P-256:P-384",
  sigalgs: "ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha256:rsa_pss_rsae_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha256:rsa_pkcs1_sha384:rsa_pkcs1_sha512",
  ALPNProtocols: ["h2", "http/1.1"],
});
await capture("without PQ group (if unsupported)", {
  minVersion: "TLSv1.2", maxVersion: "TLSv1.3",
  ciphers: [...TLS13, ...TLS12_CHROME].join(":"),
  ecdhCurve: "X25519:P-256:P-384",
  sigalgs: "ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha256",
  ALPNProtocols: ["h2", "http/1.1"],
});
