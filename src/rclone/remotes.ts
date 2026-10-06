import * as path from 'path';
import { BetterSshConfig, TargetConfig, getWorkspaceRoot } from '../config';
import { log, logDebug } from '../log';
import { assertSafeRelativePath } from '../paths';
import { buildSshInvocation, usesExternalSsh } from '../ssh/args';
import { ensureHostKeyTrusted, offerHostKeyFix } from '../ssh/hostKey';
import { RcloneRcClient } from './client';

/** Sanitize target name for rclone remote name */
export function remoteNameFor(target: TargetConfig): string {
  return `bssh_${target.name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function fingerprint(target: TargetConfig): string {
  return JSON.stringify({
    name: target.name,
    host: target.host,
    port: target.port ?? 22,
    username: target.username,
    privateKeyPath: target.privateKeyPath,
    password: target.password ?? '',
    passphrase: target.passphrase ?? '',
    sshConfigHost: target.sshConfigHost,
    hop: target.hop,
    remotePath: target.remotePath,
    context: target.context,
    enabled: target.enabled !== false,
  });
}

let configLock: Promise<void> = Promise.resolve();

function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = configLock.then(fn, fn);
  configLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const ensured = new Map<string, string>(); // remoteName -> fingerprint

export function invalidateRemoteCache(): void {
  ensured.clear();
}

export function listCachedRemoteNames(): string[] {
  return [...ensured.keys()];
}

/**
 * Drop rclone remotes that are no longer in config, then (re)create current ones.
 */
export async function reapplyAllRemotes(
  client: RcloneRcClient,
  targets: TargetConfig[]
): Promise<void> {
  invalidateRemoteCache();

  let existing: string[] = [];
  try {
    const out = await client.call<{ remotes?: string[] }>('config/listremotes', {});
    existing = (out.remotes ?? []).map((r) => r.replace(/:$/, ''));
  } catch {
    existing = [];
  }

  const wanted = new Set(
    targets.filter((t) => t.enabled !== false).map((t) => remoteNameFor(t))
  );

  await withConfigLock(async () => {
    for (const name of existing) {
      if (!name.startsWith('bssh_')) {
        continue;
      }
      if (!wanted.has(name)) {
        try {
          await client.call('config/delete', { name });
          log(`Removed stale rclone remote ${name}`);
        } catch {
          /* ignore */
        }
      }
    }
  });

  for (const target of targets) {
    if (target.enabled === false) {
      continue;
    }
    await ensureRemote(client, target);
  }
}

export async function ensureRemote(
  client: RcloneRcClient,
  target: TargetConfig
): Promise<string> {
  const name = remoteNameFor(target);
  const fp = fingerprint(target);
  if (ensured.get(name) === fp) {
    return name;
  }

  return withConfigLock(async () => {
    if (ensured.get(name) === fp) {
      return name;
    }

    try {
      await client.call('config/delete', { name });
    } catch {
      /* may not exist */
    }

    const parameters = buildRemoteParameters(target);
    logDebug(`Creating rclone remote ${name}: ${JSON.stringify(redactParams(parameters))}`);

    await client.call('config/create', {
      name,
      type: 'sftp',
      parameters,
      opt: { nonInteractive: true, obscure: true },
    });

    ensured.set(name, fp);
    log(`Configured rclone remote ${name} (${usesExternalSsh(target) ? 'external ssh' : 'native sftp'})`);
    return name;
  });
}

/**
 * Run an rclone op, prompting to trust the host key and retrying once on failure.
 */
export async function withHostKeyRetry<T>(
  client: RcloneRcClient,
  target: TargetConfig,
  fn: (remote: string) => Promise<T>
): Promise<T> {
  await ensureHostKeyTrusted(target);
  const remote = await ensureRemote(client, target);
  try {
    return await fn(remote);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!(await offerHostKeyFix(target, msg))) {
      throw e;
    }
    ensured.delete(remoteNameFor(target));
    const remote2 = await ensureRemote(client, target);
    return await fn(remote2);
  }
}

function redactParams(parameters: Record<string, string>): Record<string, string> {
  const out = { ...parameters };
  if (out.pass) {
    out.pass = '***';
  }
  if (out.key_file_pass) {
    out.key_file_pass = '***';
  }
  return out;
}

function buildRemoteParameters(target: TargetConfig): Record<string, string> {
  // External OpenSSH: required for ProxyJump / ssh config Host aliases
  if (usesExternalSsh(target)) {
    const inv = buildSshInvocation(target);
    return {
      type: 'sftp',
      ssh: inv.rcloneSshCommand,
      shell_type: 'unix',
      md5sum_command: 'none',
      sha1sum_command: 'none',
    };
  }

  // Built-in SFTP — better connection reuse, fewer EOF races than spawning ssh
  if (!target.host) {
    throw new Error(`Target "${target.name}" is missing host`);
  }
  const parameters: Record<string, string> = {
    type: 'sftp',
    host: target.host,
    port: String(target.port ?? 22),
    shell_type: 'unix',
    md5sum_command: 'none',
    sha1sum_command: 'none',
    // Match OpenSSH StrictHostKeyChecking=yes (extension prompts on first trust)
    known_hosts_file: '~/.ssh/known_hosts',
  };
  if (target.username) {
    parameters.user = target.username;
  }
  if (target.password) {
    // Password auth: set pass and do not rely on ssh-agent / key_file
    parameters.pass = target.password;
  }
  if (target.privateKeyPath && !target.password) {
    parameters.key_file = target.privateKeyPath;
  } else if (target.privateKeyPath && target.password) {
    // Both configured: try key first, password as fallback
    parameters.key_file = target.privateKeyPath;
  }
  if (target.passphrase) {
    parameters.key_file_pass = target.passphrase;
  }
  return parameters;
}

export function joinRemotePath(remotePath: string, relative: string): string {
  const base = remotePath.replace(/\/+$/, '');
  const rel = assertSafeRelativePath(relative, 'remote path');
  if (!rel) {
    return base || '/';
  }
  return `${base}/${rel}`;
}

export function localToRelative(localPath: string): string {
  const root = getWorkspaceRoot();
  if (!root) {
    throw new Error('No workspace folder open');
  }
  const rel = path.relative(root, localPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path is outside the workspace');
  }
  return rel.split(path.sep).join('/');
}

export function fsParam(remote: string, remoteFsPath: string): string {
  const p = remoteFsPath.startsWith('/') ? remoteFsPath : `/${remoteFsPath}`;
  return `${remote}:${p}`;
}

/**
 * Local path as an rclone Fs that follows symlinks (−L / copy_links).
 * Bare paths skip symlinks; this uploads the pointed-to file contents.
 */
export function localFsParam(localPath: string): string {
  const abs = path.resolve(localPath);
  // Forward slashes keep Windows drive paths unambiguous in connection strings.
  const normalized = abs.split(path.sep).join('/');
  return `:local,copy_links=true:${normalized}`;
}

export function transferConfig(
  config: BetterSshConfig,
  target: TargetConfig
): Record<string, unknown> {
  return {
    Transfers: target.transfers ?? config.transfers,
    Checkers: target.checkers ?? config.checkers,
    // Parallel streams for large individual files (SFTP range support varies)
    MultiThreadStreams: 4,
    MultiThreadCutoff: '64M',
  };
}
