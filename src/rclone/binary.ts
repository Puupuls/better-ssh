import AdmZip from 'adm-zip';
import { execFileSync, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { log, logDebug } from '../log';

/** Pinned rclone release — bump intentionally when upgrading the managed binary. */
export const MANAGED_RCLONE_VERSION = 'v1.75.1';

const DOWNLOADS_BASE = 'https://downloads.rclone.org';

let storageRoot: string | undefined;
let resolveInFlight: Promise<string> | undefined;

export function configureRcloneStorage(globalStoragePath: string): void {
  storageRoot = globalStoragePath;
}

export function getRcloneStorageRoot(): string | undefined {
  return storageRoot;
}

/**
 * Resolve rclone binary path:
 * 1. Non-default `betterSsh.rclonePath` → use as-is
 * 2. `rclone` on PATH → use it
 * 3. Else download/pin managed binary into extension global storage
 */
export async function resolveRcloneBinary(): Promise<string> {
  if (resolveInFlight) {
    return resolveInFlight;
  }
  resolveInFlight = resolveRcloneBinaryInner().finally(() => {
    resolveInFlight = undefined;
  });
  return resolveInFlight;
}

async function resolveRcloneBinaryInner(): Promise<string> {
  const configured = vscode.workspace
    .getConfiguration('betterSsh')
    .get<string>('rclonePath', 'rclone')
    .trim();

  if (configured && configured !== 'rclone') {
    await assertRunnable(configured, `betterSsh.rclonePath ("${configured}")`);
    return configured;
  }

  if (await tryRunnable('rclone')) {
    logDebug('Using rclone from PATH');
    return 'rclone';
  }

  if (!storageRoot) {
    throw new Error(
      'rclone not found on PATH and extension storage is not configured. Install rclone or set betterSsh.rclonePath.'
    );
  }

  const managed = managedBinaryPath(storageRoot);
  if (fs.existsSync(managed) && (await tryRunnable(managed))) {
    logDebug(`Using managed rclone at ${managed}`);
    return managed;
  }

  await downloadManagedRclone(storageRoot);
  await assertRunnable(managed, 'managed rclone');
  return managed;
}

function managedBinaryPath(root: string): string {
  const name = process.platform === 'win32' ? 'rclone.exe' : 'rclone';
  return path.join(root, 'rclone', MANAGED_RCLONE_VERSION, name);
}

function platformAsset(): { os: string; arch: string; zipName: string } {
  let os: string;
  switch (process.platform) {
    case 'darwin':
      os = 'osx';
      break;
    case 'linux':
      os = 'linux';
      break;
    case 'win32':
      os = 'windows';
      break;
    default:
      throw new Error(
        `No managed rclone build for platform ${process.platform}. Install rclone or set betterSsh.rclonePath.`
      );
  }

  let arch: string;
  switch (process.arch) {
    case 'x64':
      arch = 'amd64';
      break;
    case 'arm64':
      arch = 'arm64';
      break;
    case 'ia32':
      arch = '386';
      break;
    default:
      throw new Error(
        `No managed rclone build for arch ${process.arch}. Install rclone or set betterSsh.rclonePath.`
      );
  }

  const zipName = `rclone-${MANAGED_RCLONE_VERSION}-${os}-${arch}.zip`;
  return { os, arch, zipName };
}

async function downloadManagedRclone(root: string): Promise<void> {
  const { zipName } = platformAsset();
  const versionDir = path.join(root, 'rclone', MANAGED_RCLONE_VERSION);
  const tmpDir = path.join(root, 'rclone', '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(versionDir, { recursive: true });

  const zipPath = path.join(tmpDir, zipName);
  const sumsUrl = `${DOWNLOADS_BASE}/${MANAGED_RCLONE_VERSION}/SHA256SUMS`;
  const zipUrl = `${DOWNLOADS_BASE}/${MANAGED_RCLONE_VERSION}/${zipName}`;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Better SSH: downloading rclone ${MANAGED_RCLONE_VERSION}`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Fetching checksums…' });
      const sumsText = (await downloadBuffer(sumsUrl)).toString('utf8');
      const expected = parseSha256(sumsText, zipName);
      if (!expected) {
        throw new Error(`SHA256SUMS has no entry for ${zipName}`);
      }

      progress.report({ message: `Downloading ${zipName}…` });
      log(`Downloading managed rclone ${MANAGED_RCLONE_VERSION} (${zipName})`);
      await downloadToFile(zipUrl, zipPath, (bytes, total) => {
        if (total > 0) {
          const pct = Math.min(100, Math.round((100 * bytes) / total));
          progress.report({ message: `${pct}% (${formatMb(bytes)} / ${formatMb(total)})` });
        } else {
          progress.report({ message: formatMb(bytes) });
        }
      });

      progress.report({ message: 'Verifying SHA-256…' });
      const actual = await sha256File(zipPath);
      if (actual !== expected) {
        try {
          fs.unlinkSync(zipPath);
        } catch {
          /* ignore */
        }
        throw new Error(
          `rclone download checksum mismatch for ${zipName} (expected ${expected}, got ${actual})`
        );
      }

      progress.report({ message: 'Extracting…' });
      const exeName = process.platform === 'win32' ? 'rclone.exe' : 'rclone';
      const dest = path.join(versionDir, exeName);
      extractBinaryFromZip(zipPath, exeName, dest);

      if (process.platform !== 'win32') {
        fs.chmodSync(dest, 0o755);
      }
      clearMacQuarantine(dest);

      try {
        fs.unlinkSync(zipPath);
      } catch {
        /* ignore */
      }

      log(`Managed rclone ready: ${dest}`);
    }
  );
}

function extractBinaryFromZip(zipPath: string, exeName: string, dest: string): void {
  const zip = new AdmZip(zipPath);
  const entry = zip
    .getEntries()
    .find((e) => !e.isDirectory && (e.entryName === exeName || e.entryName.endsWith(`/${exeName}`)));
  if (!entry) {
    throw new Error(`rclone archive missing ${exeName}`);
  }
  fs.writeFileSync(dest, entry.getData());
}

function clearMacQuarantine(filePath: string): void {
  if (process.platform !== 'darwin') {
    return;
  }
  try {
    execFileSync('xattr', ['-d', 'com.apple.quarantine', filePath], {
      stdio: 'ignore',
    });
  } catch {
    /* no quarantine attr or xattr unavailable */
  }
}

function parseSha256(sumsText: string, zipName: string): string | undefined {
  for (const line of sumsText.split(/\r?\n/)) {
    const m = line.match(/^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/);
    if (m && m[2] === zipName) {
      return m[1].toLowerCase();
    }
  }
  return undefined;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    getFollowRedirects(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }, reject);
  });
}

function downloadToFile(
  url: string,
  dest: string,
  onProgress: (bytes: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    getFollowRedirects(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let bytes = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        onProgress(bytes, total);
      });
      res.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', reject);
      res.on('error', reject);
    }, reject);
  });
}

function getFollowRedirects(
  url: string,
  onResponse: (res: http.IncomingMessage) => void,
  onError: (err: Error) => void,
  redirects = 0
): void {
  if (redirects > 5) {
    onError(new Error(`Too many redirects for ${url}`));
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    onError(new Error(`Invalid download URL: ${url}`));
    return;
  }
  if (parsed.protocol !== 'https:') {
    onError(new Error(`Refusing non-HTTPS download URL: ${url}`));
    return;
  }
  https
    .get(url, { headers: { 'User-Agent': 'better-ssh-vscode' } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          res.resume();
          onError(new Error(`Invalid redirect location from ${url}`));
          return;
        }
        if (next.protocol !== 'https:') {
          res.resume();
          onError(new Error(`Refusing non-HTTPS redirect to ${next}`));
          return;
        }
        res.resume();
        getFollowRedirects(next.toString(), onResponse, onError, redirects + 1);
        return;
      }
      onResponse(res);
    })
    .on('error', onError);
}

async function tryRunnable(bin: string): Promise<boolean> {
  try {
    await runVersion(bin);
    return true;
  } catch {
    return false;
  }
}

async function assertRunnable(bin: string, label: string): Promise<void> {
  try {
    await runVersion(bin);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`${label} is not runnable: ${detail}`);
  }
}

function runVersion(bin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(err || `exit ${code}`));
      }
    });
  });
}

function formatMb(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
