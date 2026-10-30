#!/usr/bin/env node
// Install ds-web-mcp into each MCP client's own home directory.
//
//   node tools/install-to-mcp-homes.mjs [--clients openclaw,codex] [--dry-run] [--force]
//
// Why: the MCP registration in each client points at an absolute path. When the
// project lives on the Desktop, moving or deleting it silently breaks every
// client. Installing a private copy under each client's home directory makes the
// registration self-contained, so the working copy becomes disposable.
//
// The payload is copied verbatim (node_modules included). Every dependency is
// pure JavaScript -- there is no native module to rebuild or platform ABI to
// match -- so a copy stays runnable on another machine of any OS.
//
// What it does NOT do: touch credentials. The DeepSeek token and the browser
// profile stay in the user's home directory (~/.ds-web-mcp.json and
// ~/.ds-web-mcp-chrome), never in an install target, so every copy shares one
// login and deleting an install never logs the user out.
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const clientsArg = args.find((a) => a.startsWith('--clients='))?.slice('--clients='.length)
  ?? readClientsValue(args);
const selected = new Set(
  (clientsArg || 'openclaw,codex').split(',').map((s) => s.trim()).filter(Boolean),
);

/** Supports the spaced form `--clients openclaw,codex` as well as `--clients=...`. */
function readClientsValue(argv) {
  const at = argv.indexOf('--clients');
  const next = at >= 0 ? argv[at + 1] : undefined;
  return next && !next.startsWith('--') ? next : '';
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = homedir();
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));

// Resolve node to an absolute path so a client that lacks the npm shim
// directory on PATH can still spawn the server. Electron-embedded Node and
// system installs resolve through the same call.
const nodeExe = process.execPath;

const CLIENTS = {
  openclaw: {
    label: 'OpenClaw',
    // Registered under the established server name, so the Desktop entry is
    // replaced in place rather than a second, differently-named one appearing.
    // Tool names are derived from it, so changing it would break callers.
    serverName: 'deepseek-web',
    target: join(home, '.openclaw', 'mcp-servers', pkg.name),
    configPath: join(home, '.openclaw', 'openclaw.json'),
    entry: (target) => ({
      command: nodeExe,
      args: [join(target, 'bin', 'ds-web-mcp.mjs'), 'run'],
    }),
  },
  codex: {
    label: 'Codex',
    serverName: 'deepseek-web',
    target: join(home, '.codex', 'mcp-servers', pkg.name),
    configPath: join(home, '.codex', 'config.toml'),
    entry: (target) => ({
      command: nodeExe,
      args: [join(target, 'bin', 'ds-web-mcp.mjs'), 'run'],
    }),
  },
};

/** Directories that must never be copied into an install target, by name. */
const EXCLUDE = new Set(['.git', 'node_modules_backup', '.venv', '__pycache__']);

/**
 * Whether a path is left out of the payload. Only the project's own `.github`
 * (CI workflow definitions, useless to a local install) is dropped; a `.github`
 * inside `node_modules` belongs to a dependency and is copied like any other
 * package content.
 */
function isExcluded(src) {
  const name = src.split(/[\\/]/).pop();
  if (EXCLUDE.has(name)) return true;
  return src === join(projectRoot, '.github');
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** File count and byte total, skipping the excluded directories. */
function measure(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (isExcluded(full)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        try {
          bytes += statSync(full).size;
        } catch {
          // A file that vanished mid-walk does not invalidate the count.
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Copies the project into `target`, atomically enough to survive a failure. */
function installTo(target) {
  const staging = `${target}.installing-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });

  cpSync(projectRoot, staging, {
    recursive: true,
    filter: (src) => !isExcluded(src),
  });

  // Swap into place only once the copy succeeded, so a failure leaves the
  // previous install intact.
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
}

/** Registers (or re-registers) the server entry in a client's config. */
function register(client, target) {
  const entry = client.entry(target);

  if (client.configPath.endsWith('.json')) {
    return registerJson(client, entry);
  }
  return registerToml(client, entry);
}

function registerJson(client, entry) {
  let config = {};
  if (existsSync(client.configPath)) {
    config = JSON.parse(readFileSync(client.configPath, 'utf8'));
  }
  config.mcp ??= {};
  config.mcp.servers ??= {};

  // Drop any entry that points into an install target under a different name.
  // Without this, installing twice (or after a rename) would leave two servers
  // exposing the same tools.
  const installedRoot = join(home, '.openclaw', 'mcp-servers');
  for (const [key, value] of Object.entries(config.mcp.servers)) {
    if (key === client.serverName) continue;
    const joined = [value?.command, ...(value?.args ?? [])].filter(Boolean).join(' ');
    if (joined.includes(installedRoot)) delete config.mcp.servers[key];
  }

  config.mcp.servers[client.serverName] = entry;
  writeFileSync(client.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return `mcp.servers.${client.serverName}`;
}

/**
 * Rewrites only the `[mcp_servers.<name>]` block, leaving every other table
 * untouched. A regex is used instead of a TOML parser because the rest of the
 * file must be preserved byte for byte -- comments, formatting and all.
 */
function registerToml(client, entry) {
  const name = client.serverName;
  const block = [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
    '',
  ].join('\n');

  let text = existsSync(client.configPath) ? readFileSync(client.configPath, 'utf8') : '';

  // Remove blocks that point into an install target under a different name, so
  // a re-run or a rename cannot leave two servers exposing the same tools.
  const installedRoot = join(home, '.codex', 'mcp-servers');
  const legacyRe = /^\[mcp_servers\.([A-Za-z0-9_.-]+)\]\n(?:[^\[\n][^\n]*\n)*/gm;
  text = text.replace(legacyRe, (block, blockName) => {
    if (blockName === name || blockName.startsWith(`${name}.`)) return block;
    return block.includes(installedRoot) ? '' : block;
  });

  const headerRe = new RegExp(`^\\[mcp_servers\\.${escapeRe(name)}\\][^\\n]*\\n(?:[^\\[\\n][^\\n]*\\n)*`, 'm');

  if (headerRe.test(text)) {
    text = text.replace(headerRe, block);
  } else {
    // Insert after the bare `[mcp_servers]` table header when present, so the
    // entry lands in the right section instead of at end of file.
    const sectionRe = /^\[mcp_servers\]\n/m;
    if (sectionRe.test(text)) {
      text = text.replace(sectionRe, `[mcp_servers]\n\n${block}`);
    } else {
      text = `${text.replace(/\s*$/, '')}\n\n[mcp_servers]\n\n${block}`;
    }
  }

  // Collapse runs of blank lines left behind by a removed block.
  text = text.replace(/\n{3,}/g, '\n\n');
  writeFileSync(client.configPath, text, 'utf8');
  return `mcp_servers.${name}`;
}

function tomlString(value) {
  // Codex shows single-quoted literals in its own output; they avoid escaping
  // backslashes in Windows paths.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Verifies an install answers the MCP handshake before it is registered. */
function verify(target) {
  const entry = join(target, 'bin', 'ds-web-mcp.mjs');
  const probe = spawnSync(nodeExe, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(${JSON.stringify(nodeExe)}, [${JSON.stringify(entry)}, 'run'], { stdio: ['pipe','pipe','pipe'] });
    let out = '', err = '';
    const done = (ok, detail) => { child.kill(); console.log(JSON.stringify({ ok, detail })); process.exit(0); };
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('serverInfo')) done(true, /"name":"([^"]+)"/.exec(out)?.[1] ?? 'unknown');
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done(false, e.message));
    setTimeout(() => done(false, err.slice(0, 200) || 'no handshake within 20s'), 20000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install-check', version: '1' } } }) + '\\n');
  `], { encoding: 'utf8', timeout: 40_000 });

  try {
    return JSON.parse((probe.stdout || '').trim().split('\n').pop());
  } catch {
    return { ok: false, detail: probe.stderr?.slice(0, 200) || 'probe produced no result' };
  }
}

function main() {
  const source = measure(projectRoot);
  log(`ds-web-mcp ${pkg.version} -- install into MCP client homes`);
  log('');
  log(`  source       : ${projectRoot}`);
  log(`  payload      : ${source.files} files, ${(source.bytes / 1_048_576).toFixed(1)} MB`);
  log(`  node         : ${nodeExe}`);
  log(`  dry run      : ${dryRun}`);
  log('');

  let failures = 0;
  for (const [key, client] of Object.entries(CLIENTS)) {
    if (!selected.has(key)) continue;
    log(`--- ${client.label} ---`);
    log(`  target : ${client.target}`);

    if (dryRun) {
      log('  action : would copy payload and register');
      log('');
      continue;
    }

    if (existsSync(client.target) && !force) {
      log('  note   : target exists, refreshing in place');
    }

    try {
      installTo(client.target);
      const installed = measure(client.target);
      log(`  copied : ${installed.files} files, ${(installed.bytes / 1_048_576).toFixed(1)} MB`);

      const check = verify(client.target);
      if (!check.ok) {
        log(`  [!]    : handshake failed -- ${check.detail}`);
        log('  action : NOT registered (a broken entry would fail at runtime)');
        failures += 1;
        log('');
        continue;
      }
      log(`  probe  : handshake ok, server name "${check.detail}"`);

      const registered = register(client, client.target);
      log(`  config : ${client.configPath} -> ${registered}`);
    } catch (error) {
      log(`  [!]    : ${error instanceof Error ? error.message : String(error)}`);
      failures += 1;
    }
    log('');
  }

  log('Credentials are untouched: token and browser profile stay in your home');
  log('directory, so every client shares one login.');
  if (failures) {
    log('');
    log(`${failures} client(s) failed. Nothing was registered for them.`);
  }
  return failures ? 1 : 0;
}

process.exit(main());
