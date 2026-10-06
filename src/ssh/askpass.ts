import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TargetConfig } from '../config';
import { logDebug } from '../log';

let storageRoot: string | undefined;

export function configureAskpassStorage(globalStoragePath: string): void {
  storageRoot = path.join(globalStoragePath, 'askpass');
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(storageRoot, 0o700);
  } catch {
    /* ignore */
  }
}

function targetKey(target: TargetConfig): string {
  return crypto.createHash('sha256').update(target.name).digest('hex').slice(0, 16);
}

function secretPaths(target: TargetConfig): {
  dir: string;
  passwordFile: string;
  passphraseFile: string;
  script: string;
} {
  if (!storageRoot) {
    throw new Error('Askpass storage not configured');
  }
  const dir = path.join(storageRoot, targetKey(target));
  const isWin = process.platform === 'win32';
  return {
    dir,
    passwordFile: path.join(dir, 'password'),
    passphraseFile: path.join(dir, 'passphrase'),
    script: path.join(dir, isWin ? 'askpass.cmd' : 'askpass.sh'),
  };
}

/** True when terminal/rclone should use SSH_ASKPASS for this target. */
export function needsAskpass(target: TargetConfig): boolean {
  return !!(target.password || target.passphrase);
}

/**
 * Write per-target askpass helper + secret files (0600).
 * Returns env vars for OpenSSH (SSH_ASKPASS / SSH_ASKPASS_REQUIRE).
 *
 * Host-key prompts are answered "no" (fail closed). Trust is handled up-front
 * via ensureHostKeyTrusted (VS Code modal) before terminals/rclone connect.
 */
export function ensureAskpassEnv(target: TargetConfig): Record<string, string> | undefined {
  if (!needsAskpass(target)) {
    return undefined;
  }
  const paths = secretPaths(target);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(paths.dir, 0o700);
  } catch {
    /* ignore */
  }

  writeSecret(paths.passwordFile, target.password ?? '');
  writeSecret(paths.passphraseFile, target.passphrase ?? '');

  if (process.platform === 'win32') {
    const script = [
      '@echo off',
      'set "PROMPT=%~1"',
      // Fail closed on host-key confirmation (MITM / TOFU prompts)
      'echo.%PROMPT%| findstr /I /C:"authenticity" /C:"fingerprint" /C:"continue connecting" /C:"yes/no" >nul',
      'if not errorlevel 1 (echo no& exit /b 0)',
      'echo.%PROMPT%| findstr /I /C:"passphrase" >nul',
      `if not errorlevel 1 (type "${paths.passphraseFile}" & exit /b 0)`,
      `type "${paths.passwordFile}"`,
      '',
    ].join('\r\n');
    fs.writeFileSync(paths.script, script, { encoding: 'utf8' });
  } else {
    const script = [
      '#!/bin/sh',
      'prompt="${1-}"',
      'case "$prompt" in',
      '  *[Aa]uthenticity*|*[Ff]ingerprint*|*continue connecting*|*yes/no*|*Yes/No*)',
      "    printf '%s\\n' no",
      '    ;;',
      `  *[Pp]assphrase*) cat '${escapeSh(paths.passphraseFile)}' ;;`,
      `  *) cat '${escapeSh(paths.passwordFile)}' ;;`,
      'esac',
      '',
    ].join('\n');
    fs.writeFileSync(paths.script, script, { encoding: 'utf8', mode: 0o700 });
    try {
      fs.chmodSync(paths.script, 0o700);
    } catch {
      /* ignore */
    }
  }

  logDebug(`Askpass ready for target ${target.name}`);

  return {
    SSH_ASKPASS: paths.script,
    SSH_ASKPASS_REQUIRE: 'force',
    // Required on some platforms for OpenSSH to invoke askpass without a TTY display
    DISPLAY: process.env.DISPLAY || 'localhost:0',
  };
}

/** Remove askpass secret files from disk (call on deactivate). */
export function clearAskpassStorage(): void {
  if (!storageRoot || !fs.existsSync(storageRoot)) {
    return;
  }
  try {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  } catch {
    /* ignore */
  }
}

function writeSecret(filePath: string, value: string): void {
  fs.writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore */
  }
}

function escapeSh(p: string): string {
  return p.replace(/'/g, `'\\''`);
}
