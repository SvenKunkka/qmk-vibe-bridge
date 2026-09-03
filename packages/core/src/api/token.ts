/**
 * Local token management (round-17 §5.3): the API token is generated once and
 * stored in the OS security store when available:
 *   macOS: Keychain (security add-generic-password)
 *   Windows: Credential Manager (future; falls back)
 *   Linux: Secret Service (future; falls back)
 * Fallback: a 0600 file under the config dir, with an EXPLICIT degraded log.
 * The token is NEVER written to app logs.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export type TokenStorage = 'keychain' | 'file' | 'none';

const SERVICE = 'com.vibebridge.ai-console';
const ACCOUNT = 'local-api-token';

export function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function keychainGet(): string | null {
  try {
    if (process.platform !== 'darwin') return null;
    const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const token = out.toString('utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function keychainSet(token: string): boolean {
  try {
    if (process.platform !== 'darwin') return false;
    execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', token, '-U'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function filePath(configDir: string): string {
  return path.join(configDir, 'api-token');
}

function fileGet(configDir: string): string | null {
  try {
    const p = filePath(configDir);
    if (!fs.existsSync(p)) return null;
    const mode = fs.statSync(p).mode & 0o777;
    if (mode !== 0o600) {
      // tighten permissions on read if the file is too open
      try { fs.chmodSync(p, 0o600); } catch { /* ignore */ }
    }
    return fs.readFileSync(p, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function fileSet(configDir: string, token: string): boolean {
  try {
    const p = filePath(configDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, token, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load or create the API token. Returns { token, storage }. The degraded
 * file storage path is reported so the UI can tell the user; the token
 * itself is only ever handed to the API server and the UI on demand.
 */
export function loadOrCreateToken(configDir: string, onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void): { token: string; storage: TokenStorage } {
  const existing = keychainGet() ?? fileGet(configDir);
  if (existing) {
    return { token: existing, storage: process.platform === 'darwin' && keychainGet() ? 'keychain' : 'file' };
  }
  const token = generateToken();
  if (keychainSet(token)) {
    return { token, storage: 'keychain' };
  }
  if (fileSet(configDir, token)) {
    onLog?.(
      'warn',
      'OS secure storage unavailable — API token stored in a 0600 file under the config directory (degraded; macOS Keychain preferred)',
    );
    return { token, storage: 'file' };
  }
  onLog?.('error', 'unable to persist API token — local API disabled');
  return { token, storage: 'none' };
}

export function revokeToken(configDir: string): void {
  try {
    if (process.platform === 'darwin') {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], { stdio: 'ignore' });
    }
  } catch { /* not present */ }
  try {
    fs.rmSync(filePath(configDir), { force: true });
  } catch { /* ignore */ }
}
