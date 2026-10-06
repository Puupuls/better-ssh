import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { log, logDebug } from '../log';
import { getRcloneStorageRoot, resolveRcloneBinary } from './binary';

export interface RcdHandle {
  port: number;
  user: string;
  pass: string;
  configPath: string;
  process: ChildProcess;
}

async function waitForRc(port: number, user: string, pass: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/rc/noop',
            method: 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/json',
              'Content-Length': 2,
            },
            timeout: 1000,
          },
          (res) => {
            res.resume();
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`rc noop status ${res.statusCode}`));
            }
          }
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
        req.write('{}');
        req.end();
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('rclone rcd did not become ready in time');
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not allocate RC port'));
        return;
      }
      const { port } = addr;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
    server.on('error', reject);
  });
}

export async function ensureRcloneAvailable(): Promise<string> {
  return resolveRcloneBinary();
}

export class RcdManager {
  private handle: RcdHandle | undefined;
  private starting: Promise<RcdHandle> | undefined;

  async ensure(): Promise<RcdHandle> {
    if (this.handle && !this.handle.process.killed) {
      return this.handle;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<RcdHandle> {
    const bin = await ensureRcloneAvailable();
    const storage = getRcloneStorageRoot();
    const confDir = storage
      ? path.join(storage, 'rcd')
      : path.join(os.tmpdir(), 'better-ssh-rcd');
    fs.mkdirSync(confDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(confDir, 0o700);
    } catch {
      /* ignore */
    }

    const configPath = path.join(
      confDir,
      `rclone-${process.pid}-${crypto.randomBytes(4).toString('hex')}.conf`
    );
    fs.writeFileSync(configPath, '', { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      /* ignore */
    }

    const user = 'better-ssh';
    const pass = crypto.randomBytes(16).toString('hex');
    const port = await allocateLoopbackPort();

    // Pass RC password via env so it does not appear in `ps` argv.
    // --copy-links: follow local symlinks and upload the target file contents
    // (rclone default skips them / refuses without -L).
    const args = [
      'rcd',
      '--rc-addr',
      `127.0.0.1:${port}`,
      '--rc-user',
      user,
      '--config',
      configPath,
      '--copy-links',
      '--transfers',
      '16',
      '--checkers',
      '32',
    ];

    log(`Starting rclone rcd (${bin}) on 127.0.0.1:${port}`);
    logDebug(`rclone ${args.join(' ')} (RCLONE_RC_PASS=<redacted>)`);

    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RCLONE_RC_PASS: pass,
      },
    });

    child.stdout.on('data', (d) => logDebug(`rcd stdout: ${d.toString().trim()}`));
    child.stderr.on('data', (d) => log(`rcd: ${d.toString().trim()}`));
    child.on('exit', (code, signal) => {
      log(`rclone rcd exited code=${code} signal=${signal}`);
      if (this.handle && this.handle.process.pid === child.pid) {
        this.handle = undefined;
      }
      try {
        fs.unlinkSync(configPath);
      } catch {
        /* ignore */
      }
    });

    try {
      await waitForRc(port, user, pass);
    } catch (e) {
      child.kill('SIGTERM');
      throw e;
    }

    const handle: RcdHandle = { port, user, pass, configPath, process: child };
    this.handle = handle;
    return handle;
  }

  async stop(): Promise<void> {
    const h = this.handle;
    this.handle = undefined;
    if (!h) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      h.process.once('exit', done);
      h.process.kill('SIGTERM');
      setTimeout(() => {
        if (!h.process.killed) {
          h.process.kill('SIGKILL');
        }
        done();
      }, 3000);
    });
    try {
      fs.unlinkSync(h.configPath);
    } catch {
      /* ignore */
    }
  }
}
