import * as http from 'http';
import * as vscode from 'vscode';
import { logDebug } from '../log';
import { RcdHandle, RcdManager } from './rcd';

export interface RcloneTransferringFile {
  name: string;
  bytes: number;
  size: number;
  percentage: number;
  speed: number;
  speedAvg: number;
  eta: number | null;
}

export interface RcloneStats {
  bytes: number;
  totalBytes: number;
  speed: number;
  eta: number | null;
  percentage?: number;
  transferring?: RcloneTransferringFile[];
  transfers?: number;
  errors?: number;
}

export class RcloneRcClient {
  constructor(private readonly rcd: RcdManager) {}

  async call<T = Record<string, unknown>>(
    path: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const handle = await this.rcd.ensure();
    return this.post<T>(handle, path, params);
  }

  async callAsync(
    path: string,
    params: Record<string, unknown> = {}
  ): Promise<{ jobid: number }> {
    const out = await this.call<{ jobid: number }>(path, { ...params, _async: true });
    if (typeof out.jobid !== 'number') {
      throw new Error(`rclone ${path} did not return jobid`);
    }
    return out;
  }

  async getStats(group?: string): Promise<RcloneStats> {
    const raw = await this.call<Record<string, unknown>>(
      'core/stats',
      group ? { group } : {}
    );
    return normalizeStats(raw);
  }

  async waitJob(jobid: number, timeoutMs = 600_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.call<{
        finished?: boolean;
        success?: boolean;
        error?: string;
        output?: Record<string, unknown>;
      }>('job/status', { jobid });
      if (status.finished) {
        if (status.success === false) {
          throw new Error(status.error || `rclone job ${jobid} failed`);
        }
        return status.output ?? {};
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`rclone job ${jobid} timed out`);
  }

  /**
   * Run an RC method as an async job with a dedicated stats group,
   * polling core/stats for per-file progress until the job finishes.
   */
  async runWithProgress(
    path: string,
    params: Record<string, unknown>,
    options: {
      onProgress?: (stats: RcloneStats) => void;
      token?: vscode.CancellationToken;
      pollMs?: number;
      timeoutMs?: number;
      retries?: number;
    } = {}
  ): Promise<Record<string, unknown>> {
    const retries = options.retries ?? 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (options.token?.isCancellationRequested) {
        throw new Error('Transfer cancelled');
      }
      try {
        return await this.runWithProgressOnce(path, params, options);
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (options.token?.isCancellationRequested || !isTransientSftpError(msg)) {
          throw e;
        }
        if (attempt >= retries) {
          break;
        }
        const delay = 500 * attempt;
        logDebug(`Transient SFTP error (attempt ${attempt}/${retries}), retry in ${delay}ms: ${msg}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async runWithProgressOnce(
    path: string,
    params: Record<string, unknown>,
    options: {
      onProgress?: (stats: RcloneStats) => void;
      token?: vscode.CancellationToken;
      pollMs?: number;
      timeoutMs?: number;
    }
  ): Promise<Record<string, unknown>> {
    const group = `bssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pollMs = options.pollMs ?? 400;
    const timeoutMs = options.timeoutMs ?? 600_000;
    const { jobid } = await this.callAsync(path, { ...params, _group: group });
    const deadline = Date.now() + timeoutMs;

    try {
      while (Date.now() < deadline) {
        if (options.token?.isCancellationRequested) {
          try {
            await this.call('job/stop', { jobid });
          } catch {
            /* ignore */
          }
          throw new Error('Transfer cancelled');
        }

        const status = await this.call<{
          finished?: boolean;
          success?: boolean;
          error?: string;
          output?: Record<string, unknown>;
        }>('job/status', { jobid });

        try {
          const stats = await this.getStats(group);
          options.onProgress?.(stats);
        } catch {
          /* stats may not exist yet */
        }

        if (status.finished) {
          if (status.success === false) {
            throw new Error(status.error || `rclone job ${jobid} failed`);
          }
          return status.output ?? {};
        }

        await new Promise((r) => setTimeout(r, pollMs));
      }
      throw new Error(`rclone job ${jobid} timed out`);
    } finally {
      try {
        await this.call('core/stats-delete', { group });
      } catch {
        /* ignore */
      }
    }
  }

  async run(
    path: string,
    params: Record<string, unknown> = {},
    asyncPreferred = true
  ): Promise<Record<string, unknown>> {
    if (asyncPreferred) {
      const { jobid } = await this.callAsync(path, params);
      return this.waitJob(jobid);
    }
    return this.call(path, params);
  }

  private post<T>(handle: RcdHandle, rcPath: string, params: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(params);
    const auth = Buffer.from(`${handle.user}:${handle.pass}`).toString('base64');
    logDebug(`RC POST /${rcPath} ${redactRcBody(params)}`);

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: handle.port,
          path: `/${rcPath}`,
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: Record<string, unknown> = {};
            if (text) {
              try {
                parsed = JSON.parse(text) as Record<string, unknown>;
              } catch {
                reject(new Error(`Invalid JSON from rclone rc /${rcPath}: ${text}`));
                return;
              }
            }
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed as T);
              return;
            }
            const errMsg =
              (parsed.error as string) ||
              (parsed.message as string) ||
              text ||
              `HTTP ${res.statusCode}`;
            reject(new Error(`rclone rc /${rcPath}: ${errMsg}`));
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

const SENSITIVE_PARAM_KEYS = new Set([
  'pass',
  'password',
  'key_file_pass',
  'passphrase',
  'token',
  'secret',
  'authorization',
]);

/** Redact secrets from RC request params before debug logging. */
function redactRcBody(params: Record<string, unknown>): string {
  return JSON.stringify(params, (key, value) => {
    if (typeof key === 'string' && SENSITIVE_PARAM_KEYS.has(key.toLowerCase())) {
      return '***';
    }
    if (key === 'parameters' && value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const k of Object.keys(out)) {
        if (SENSITIVE_PARAM_KEYS.has(k.toLowerCase()) || k === 'pass' || k === 'key_file_pass') {
          out[k] = '***';
        }
      }
      return out;
    }
    return value;
  });
}

function isTransientSftpError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('unexpected eof') ||
    m.includes('connection reset') ||
    m.includes('connection refused') ||
    m.includes('i/o timeout') ||
    m.includes('timed out') ||
    m.includes('server unexpectedly closed') ||
    m.includes("couldn't initialise sftp") ||
    m.includes('ssh: handshake failed') ||
    m.includes('connection lost')
  );
}

function normalizeStats(raw: Record<string, unknown>): RcloneStats {
  const transferring = Array.isArray(raw.transferring)
    ? (raw.transferring as Record<string, unknown>[]).map((f) => ({
        name: String(f.name ?? ''),
        bytes: Number(f.bytes ?? 0),
        size: Number(f.size ?? 0),
        percentage: Number(f.percentage ?? 0),
        speed: Number(f.speed ?? 0),
        speedAvg: Number(f.speedAvg ?? f.speed ?? 0),
        eta: f.eta === null || f.eta === undefined ? null : Number(f.eta),
      }))
    : [];

  const bytes = Number(raw.bytes ?? 0);
  const totalBytes = Number(raw.totalBytes ?? 0);
  let percentage: number | undefined =
    typeof raw.percentage === 'number' ? raw.percentage : undefined;
  if (percentage === undefined && totalBytes > 0) {
    percentage = Math.min(100, Math.round((100 * bytes) / totalBytes));
  }

  return {
    bytes,
    totalBytes,
    speed: Number(raw.speed ?? 0),
    eta: raw.eta === null || raw.eta === undefined ? null : Number(raw.eta),
    percentage,
    transferring,
    transfers: typeof raw.transfers === 'number' ? raw.transfers : undefined,
    errors: typeof raw.errors === 'number' ? raw.errors : undefined,
  };
}
