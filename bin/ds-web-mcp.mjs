#!/usr/bin/env node
// Executable entry point.
//
// Node >= 22.18 (and >= 23.6) strips TypeScript types without a flag, so the
// source can ship as .ts and be run directly — no build step. On older 22.x
// the flag is still required, so it is added when the runtime does not enable
// stripping by default.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, '..', 'src', 'cli.ts');

const [major, minor] = process.versions.node.split('.').map(Number);
// Type stripping is on by default from 22.18.0 and 23.6.0 (and always in 24+).
const stripsByDefault = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);

const args = stripsByDefault
  ? [cliPath, ...process.argv.slice(2)]
  : ['--experimental-strip-types', cliPath, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});
child.on('error', (error) => {
  process.stderr.write(`ds-web-mcp: failed to start: ${error.message}\n`);
  process.exit(1);
});
