import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { TargetConfig } from '../config';
import { log, logDebug } from '../log';
import { buildSshInvocation } from './args';

const execFileAsync = promisify(execFile);

export class HostKeyRejectedError extends Error {
  constructor(alias: string) {
    super(`Host key not trusted for ${alias}`);
    this.name = 'HostKeyRejectedError';
  }
}

interface Endpoint {
  host: string;
  port: number;
}

interface HostKeyLine {
  alias: string;
  type: string;
  key: string;
  line: string;
}

/** In-flight prompts keyed by known_hosts alias — avoid stacked modals. */
const inflight = new Map<string, Promise<boolean>>();

function knownHostsPath(): string {
  return path.join(os.homedir(), '.ssh', 'known_hosts');
}

export function knownHostsAlias(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export function isHostKeyFailureMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('host key verification failed') ||
    m.includes('no ed25519 host key is known') ||
    m.includes('no ecdsa host key is known') ||
    m.includes('no rsa host key is known') ||
    m.includes('not found in known_hosts') ||
    m.includes("couldn't find host key") ||
    m.includes('ssh: handshake failed: knownhosts:') ||
    (m.includes('host key') && (m.includes('mismatch') || m.includes('changed') || m.includes('unknown')))
  );
}

/**
 * Resolve host+port for host-key checks.
 * Uses `ssh -G` when sshConfigHost is set; otherwise target.host/port.
 * ProxyJump hops are not pre-checked (OpenSSH still validates them).
 */
export async function resolveEndpoint(target: TargetConfig): Promise<Endpoint | undefined> {
  const sshPath = vscode.workspace.getConfiguration('betterSsh').get<string>('sshPath', 'ssh');

  if (target.sshConfigHost) {
    try {
      const { stdout } = await execFileAsync(sshPath, ['-G', target.sshConfigHost], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      });
      let host = '';
      let port = 22;
      for (const line of stdout.split(/\r?\n/)) {
        const sp = line.indexOf(' ');
        if (sp < 0) {
          continue;
        }
        const key = line.slice(0, sp).toLowerCase();
        const val = line.slice(sp + 1).trim();
        if (key === 'hostname') {
          host = val;
        } else if (key === 'port') {
          const n = Number(val);
          if (Number.isFinite(n) && n > 0) {
            port = n;
          }
        }
      }
      if (host) {
        return { host, port };
      }
    } catch (e) {
      logDebug(
        `ssh -G ${target.sshConfigHost} failed: ${e instanceof Error ? e.message : e}`
      );
    }
    return undefined;
  }

  if (!target.host) {
    return undefined;
  }
  return { host: target.host, port: target.port && target.port > 0 ? target.port : 22 };
}

function fingerprintSha256(type: string, keyB64: string): string {
  const raw = Buffer.from(keyB64, 'base64');
  const digest = crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
  return `${type} SHA256:${digest}`;
}

async function lookupKnownKeys(alias: string): Promise<HostKeyLine[]> {
  const file = knownHostsPath();
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-F', alias, '-f', file], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return parseKeygenFOutput(stdout, alias);
  } catch (e: unknown) {
    // ssh-keygen -F exits 1 when not found
    const err = e as { code?: number; stdout?: string };
    if (err.stdout) {
      return parseKeygenFOutput(err.stdout, alias);
    }
    return [];
  }
}

function parseKeygenFOutput(stdout: string, alias: string): HostKeyLine[] {
  const out: HostKeyLine[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    const type = parts[1];
    const key = parts[2];
    if (!type || !key) {
      continue;
    }
    out.push({ alias, type, key, line: `${alias} ${type} ${key}` });
  }
  return out;
}

async function scanRemoteKeys(host: string, port: number): Promise<HostKeyLine[]> {
  const alias = knownHostsAlias(host, port);
  const args = ['-T', '5', '-t', 'ed25519,ecdsa,rsa', host];
  if (port !== 22) {
    args.unshift('-p', String(port));
  }
  try {
    const { stdout, stderr } = await execFileAsync('ssh-keyscan', args, {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    if (stderr) {
      logDebug(`ssh-keyscan ${alias}: ${stderr.trim()}`);
    }
    return parseKeyscanOutput(stdout, alias);
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    if (err.stdout) {
      const keys = parseKeyscanOutput(err.stdout, alias);
      if (keys.length) {
        return keys;
      }
    }
    throw new Error(
      `Could not read host key for ${alias}${err.stderr ? `: ${err.stderr.trim()}` : ''}`
    );
  }
}

function parseKeyscanOutput(stdout: string, alias: string): HostKeyLine[] {
  const out: HostKeyLine[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    // keyscan may print hostname or [host]:port as first field
    const type = parts[1];
    const key = parts[2];
    if (!type || !key || type.startsWith('#')) {
      continue;
    }
    out.push({ alias, type, key, line: `${alias} ${type} ${key}` });
  }
  return out;
}

const KEY_PREF = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];

function pickPreferred(keys: HostKeyLine[]): HostKeyLine | undefined {
  for (const t of KEY_PREF) {
    const hit = keys.find((k) => k.type === t);
    if (hit) {
      return hit;
    }
  }
  return keys[0];
}

function sameKey(a: HostKeyLine, b: HostKeyLine): boolean {
  return a.type === b.type && a.key === b.key;
}

async function removeKnownHost(alias: string): Promise<void> {
  const file = knownHostsPath();
  if (!fs.existsSync(file)) {
    return;
  }
  try {
    await execFileAsync('ssh-keygen', ['-R', alias, '-f', file], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    logDebug(`ssh-keygen -R ${alias}: ${e instanceof Error ? e.message : e}`);
  }
  // OpenSSH leaves known_hosts.old — fine
}

function appendKnownHosts(lines: HostKeyLine[]): void {
  const file = knownHostsPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = lines.map((k) => k.line).join('\n') + '\n';
  fs.appendFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

/**
 * Ensure the remote host key is in ~/.ssh/known_hosts.
 * Prompts to trust (or replace) when missing / mismatched.
 * Throws HostKeyRejectedError if the user declines.
 * @returns true if a key was newly trusted/replaced; false if already trusted.
 */
export async function ensureHostKeyTrusted(target: TargetConfig): Promise<boolean> {
  const endpoint = await resolveEndpoint(target);
  if (!endpoint) {
    logDebug(`Host-key preflight skipped for ${target.name} (no resolvable host)`);
    return false;
  }

  const alias = knownHostsAlias(endpoint.host, endpoint.port);
  const existing = inflight.get(alias);
  if (existing) {
    return existing;
  }

  const run = (async (): Promise<boolean> => {
    const known = await lookupKnownKeys(alias);
    const scanned = await scanRemoteKeys(endpoint.host, endpoint.port);
    if (!scanned.length) {
      throw new Error(`No host keys returned for ${alias}`);
    }

    const preferred = pickPreferred(scanned)!;
    const matched = known.filter((k) => scanned.some((s) => sameKey(k, s)));

    if (matched.length > 0) {
      logDebug(`Host key OK for ${alias} (${matched.map((k) => k.type).join(', ')})`);
      return false;
    }

    const fp = fingerprintSha256(preferred.type, preferred.key);
    const changed = known.length > 0;

    const detail = changed
      ? `Host key changed for ${alias}.\n${fp}`
      : `Unknown host for ${alias}.\n${fp}`;

    const trustLabel = changed ? 'Replace' : 'Trust';
    const choice = await vscode.window.showWarningMessage(
      detail,
      { modal: true, detail: `Target: ${target.name}` },
      trustLabel
    );

    if (choice !== trustLabel) {
      throw new HostKeyRejectedError(alias);
    }

    if (changed) {
      await removeKnownHost(alias);
    }
    // Store all scanned algos so OpenSSH/rclone can negotiate any of them
    appendKnownHosts(scanned);
    log(`${changed ? 'Replaced' : 'Trusted'} host key for ${alias} (${fp})`);
    return true;
  })();

  inflight.set(alias, run);
  try {
    return await run;
  } finally {
    inflight.delete(alias);
  }
}

/**
 * After a failed SSH/rclone call: if it looks like a host-key problem,
 * prompt and return true when the caller should retry.
 */
export async function offerHostKeyFix(
  target: TargetConfig,
  errorMessage: string
): Promise<boolean> {
  if (!isHostKeyFailureMessage(errorMessage)) {
    return false;
  }
  try {
    await ensureHostKeyTrusted(target);
    return true;
  } catch (e) {
    if (e instanceof HostKeyRejectedError) {
      return false;
    }
    // ensureHostKeyTrusted may throw if keyscan fails — surface once
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Better SSH: ${msg}`);
    return false;
  }
}

/**
 * Re-run a BatchMode probe to extract a short reason for exit 255
 * (auth failure, refused, timeout, etc.).
 */
export async function diagnoseSshConnectFailure(
  target: TargetConfig
): Promise<string | undefined> {
  const inv = buildSshInvocation(target);
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    ...inv.terminalArgs,
    'true',
  ];
  try {
    await execFileAsync(inv.executable, args, {
      timeout: 12_000,
      maxBuffer: 256 * 1024,
      env: { ...process.env, ...(inv.env ?? {}) },
    });
    return undefined;
  } catch (e: unknown) {
    const err = e as { stderr?: string | Buffer; stdout?: string | Buffer };
    const text = `${err.stderr?.toString() ?? ''}\n${err.stdout?.toString() ?? ''}`.trim();
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('debug'));
    const hit = [...lines]
      .reverse()
      .find((l) =>
        /permission denied|host key|connection refused|timed out|could not resolve|no route|connection reset|authentication|network is unreachable/i.test(
          l
        )
      );
    return hit || lines[lines.length - 1] || 'SSH exited 255';
  }
}
