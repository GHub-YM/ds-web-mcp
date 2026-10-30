// Cross-platform Chromium discovery.
//
// The token auto-refresh needs a Chromium-family browser that owns a logged-in
// chat.deepseek.com session. Chrome is preferred, but any compatible build the
// user actually logged into will work, so discovery is deliberately broad.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BrowserCandidate {
  /** Human-readable label used in diagnostics. */
  name: string;
  /** Absolute path to the executable. */
  path: string;
}

function windowsCandidates(): BrowserCandidate[] {
  const local = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';

  return [
    { name: 'Chrome', path: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome', path: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome', path: join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome Beta', path: join(local, 'Google', 'Chrome Beta', 'Application', 'chrome.exe') },
    { name: 'Chromium', path: join(local, 'Chromium', 'Application', 'chrome.exe') },
    { name: 'Edge', path: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Edge', path: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Brave', path: join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    { name: 'Brave', path: join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    { name: 'Vivaldi', path: join(local, 'Vivaldi', 'Application', 'vivaldi.exe') },
  ];
}

function macOSCandidates(): BrowserCandidate[] {
  const home = homedir();
  return [
    { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { name: 'Chrome', path: join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') },
    { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    { name: 'Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { name: 'Vivaldi', path: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi' },
  ];
}

function linuxCandidates(): BrowserCandidate[] {
  const paths: Array<[string, string]> = [
    ['Chrome', '/usr/bin/google-chrome'],
    ['Chrome', '/usr/bin/google-chrome-stable'],
    ['Chromium', '/usr/bin/chromium'],
    ['Chromium', '/usr/bin/chromium-browser'],
    ['Edge', '/usr/bin/microsoft-edge'],
    ['Edge', '/usr/bin/microsoft-edge-stable'],
    ['Brave', '/usr/bin/brave-browser'],
    ['Vivaldi', '/usr/bin/vivaldi'],
    ['Chrome', '/snap/bin/chromium'],
    ['Chrome', '/opt/google/chrome/chrome'],
  ];
  return paths.map(([name, path]) => ({ name, path }));
}

/** Every plausible browser location for the current platform, in priority order. */
export function browserCandidates(): BrowserCandidate[] {
  if (process.platform === 'win32') return windowsCandidates();
  if (process.platform === 'darwin') return macOSCandidates();
  return linuxCandidates();
}

/** The first installed browser, or null when none is present. */
export function findBrowser(): BrowserCandidate | null {
  for (const candidate of browserCandidates()) {
    if (candidate.path && existsSync(candidate.path)) return candidate;
  }
  return null;
}

/**
 * Chromium derives its profile directory from the browser brand, so a profile
 * created by one build is not portable to another. When the user has not
 * pinned a path we prefer Chrome's location because that is what the capture
 * flow documents, and fall back to the detected brand otherwise.
 */
export function defaultProfileDir(browserName?: string): string {
  const home = homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    if (browserName === 'Edge') return join(local, 'Microsoft', 'Edge', 'User Data');
    if (browserName === 'Brave') return join(local, 'BraveSoftware', 'Brave-Browser', 'User Data');
    return join(local, 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    if (browserName === 'Edge') return join(base, 'Microsoft Edge');
    if (browserName === 'Brave') return join(base, 'BraveSoftware', 'Brave-Browser');
    if (browserName === 'Chromium') return join(base, 'Chromium');
    return join(base, 'Google', 'Chrome');
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  if (browserName === 'Edge') return join(config, 'microsoft-edge');
  if (browserName === 'Brave') return join(config, 'BraveSoftware', 'Brave-Browser');
  if (browserName === 'Chromium') return join(config, 'chromium');
  return join(config, 'google-chrome');
}

/**
 * Dedicated profile for this tool.
 *
 * Using the user's real browser profile is not an option: Chromium refuses to
 * open a second debugging session against an already-running profile, and
 * hijacking the daily browser would be hostile. A dedicated profile keeps the
 * DeepSeek login isolated and reusable.
 */
export function dedicatedProfileDir(): string {
  if (process.env.DS_CHROME_PROFILE) return process.env.DS_CHROME_PROFILE;

  const current = join(homedir(), '.ds-web-mcp-chrome');
  if (existsSync(current)) return current;

  // Releases before the rename used a different directory; keep using it so an
  // existing login survives the upgrade.
  const legacy = join(homedir(), '.deepseek-web-mcp-chrome');
  return existsSync(legacy) ? legacy : current;
}
