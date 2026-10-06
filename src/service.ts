import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  BetterSshConfig,
  TargetConfig,
  contextAbsolutePath,
  getWorkspaceRoot,
  ignoreReason,
  loadConfig,
  localToRemoteRelative,
  resolveTargets,
  targetsForLocalPath,
} from './config';
import { log } from './log';
import { assertPathUnderRoot, assertSafeRelativePath } from './paths';
import { applyCachedSecrets } from './credentialCache';
import { RcloneRcClient } from './rclone/client';
import { RcdManager } from './rclone/rcd';
import {
  fsParam,
  joinRemotePath,
  localFsParam,
  reapplyAllRemotes,
  transferConfig,
  withHostKeyRetry,
} from './rclone/remotes';
import { StatusBar } from './statusBar';
import { buildSshInvocation, remoteCdCommand } from './ssh/args';
import { ensureHostKeyTrusted } from './ssh/hostKey';
import { withTransferProgress } from './transferProgress';

export class BetterSshService {
  readonly rcd = new RcdManager();
  readonly client = new RcloneRcClient(this.rcd);
  readonly status: StatusBar;
  private saveTimer: NodeJS.Timeout | undefined;
  private pendingSaves = new Set<string>();

  constructor() {
    this.status = new StatusBar();
  }

  requireConfig(): BetterSshConfig {
    const cfg = loadConfig();
    if (!cfg) {
      throw new Error(
        'No .vscode/better-ssh.json or .vscode/sftp.json — run “Better SSH: Config”'
      );
    }
    applyCachedSecrets(cfg.targets);
    return cfg;
  }

  /** Rebuild rclone remotes from the given config (hot reload). */
  async reapplyRemotes(config: BetterSshConfig): Promise<void> {
    await this.rcd.ensure();
    await reapplyAllRemotes(this.client, config.targets);
  }

  async pickTargets(
    config: BetterSshConfig,
    multi = true,
    localPath?: string
  ): Promise<TargetConfig[] | undefined> {
    let active = config.targets.filter((t) => t.enabled !== false);
    if (localPath) {
      const matched = targetsForLocalPath(config, localPath, 'pick');
      if (matched.length > 0) {
        active = matched;
      }
    }
    if (active.length === 0) {
      throw new Error('No enabled targets — set enabled:true on at least one');
    }
    if (active.length === 1) {
      return active;
    }
    const items = active.map((t) => ({
      label: t.name,
      description: [t.context, t.sshConfigHost || t.host].filter(Boolean).join(' · '),
      target: t,
    }));
    if (multi) {
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select remote targets',
      });
      return picked?.map((p) => p.target);
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select remote target',
    });
    return picked ? [picked.target] : undefined;
  }

  defaultOrPick(config: BetterSshConfig): TargetConfig[] {
    return resolveTargets(config, 'default');
  }

  /** Targets for this path: respects per-target `context` (multi-folder / vscode-sftp style). */
  targetsForPath(config: BetterSshConfig, localPath: string): TargetConfig[] {
    return targetsForLocalPath(config, localPath, 'default');
  }

  /**
   * Upload a local file or folder.
   * `respectIgnore: false` only forces the *selected* path through when it itself
   * is ignored (explicit Upload). Directory transfers still apply ignore filters
   * to children — same as vscode-sftp.
   */
  async uploadLocalPath(
    localPath: string,
    targets?: TargetConfig[],
    isDirectory = false,
    options?: { respectIgnore?: boolean }
  ): Promise<void> {
    const config = this.requireConfig();
    const respectIgnore = options?.respectIgnore !== false;
    if (respectIgnore) {
      const reason = ignoreReason(config, localPath);
      if (reason) {
        log(`Skipped ${localPath} — ${reason}`);
        return;
      }
    } else {
      const reason = ignoreReason(config, localPath);
      if (reason) {
        log(`Uploading ${localPath} despite ignore (${reason}) — explicit request`);
      }
    }
    const chosen = targets ?? this.targetsForPath(config, localPath);
    if (chosen.length === 0) {
      log(`No target context matches ${localPath} — skip upload`);
      return;
    }
    this.status.setBusy(`Uploading → ${chosen.map((t) => t.name).join(', ')}`);

    // Always filter children on folder uploads; bypass only applies to the root path above.
    const filter = rcloneIgnoreFilter(config.ignore);

    const results = await Promise.allSettled(
      chosen.map(async (target) => {
        const rel = localToRemoteRelative(localPath, target);
        const remotePath = joinRemotePath(target.remotePath, rel);
        const cfg = transferConfig(config, target);
        const title = `Upload → ${target.name}`;
        await withHostKeyRetry(this.client, target, async (remote) => {
          if (isDirectory) {
            await withTransferProgress(this.client, this.status, {
              title,
              rcPath: 'sync/copy',
              params: {
                srcFs: localFsParam(localPath),
                dstFs: fsParam(remote, remotePath),
                _config: cfg,
                ...(filter ? { _filter: filter } : {}),
              },
            });
          } else {
            const remoteDir = path.posix.dirname(remotePath);
            const remoteName = path.posix.basename(remotePath);
            await withTransferProgress(this.client, this.status, {
              title: `${title}: ${path.basename(localPath)}`,
              rcPath: 'operations/copyfile',
              params: {
                srcFs: localFsParam(path.dirname(localPath)),
                srcRemote: path.basename(localPath),
                dstFs: fsParam(remote, remoteDir === '.' ? target.remotePath : remoteDir),
                dstRemote: remoteName,
                _config: cfg,
              },
            });
          }
        });
        log(`Uploaded ${rel} → ${target.name}:${remotePath}`);
        return target.name;
      })
    );

    const ok: string[] = [];
    const failed: string[] = [];
    results.forEach((r, i) => {
      const name = chosen[i].name;
      if (r.status === 'fulfilled') {
        ok.push(name);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        failed.push(name);
        log(`Upload failed → ${name}: ${msg}`);
      }
    });

    if (ok.length && failed.length) {
      this.status.setOk(`Uploaded → ${ok.join(', ')} (failed ${failed.join(', ')})`);
      vscode.window.showWarningMessage(
        `Better SSH: uploaded to ${ok.join(', ')}; failed on ${failed.join(', ')}`
      );
      return;
    }
    if (ok.length) {
      this.status.setOk(`Uploaded → ${ok.join(', ')}`);
      return;
    }
    this.status.setError('Upload failed');
    throw new Error(`Upload failed on ${failed.join(', ')}`);
  }

  async downloadToLocal(
    localPath: string,
    targets?: TargetConfig[],
    isDirectory = false
  ): Promise<void> {
    const config = this.requireConfig();
    let chosen = targets;
    if (!chosen) {
      chosen = await this.pickTargets(config, false, localPath);
    }
    if (!chosen || chosen.length === 0) {
      return;
    }
    const target = chosen[0];
    const rel = localToRemoteRelative(localPath, target);
    const remotePath = joinRemotePath(target.remotePath, rel);
    this.status.setBusy(`Downloading ← ${target.name}`);
    try {
      const cfg = transferConfig(config, target);
      const title = `Download ← ${target.name}`;
      await withHostKeyRetry(this.client, target, async (remote) => {
        if (isDirectory) {
          fs.mkdirSync(localPath, { recursive: true });
          await withTransferProgress(this.client, this.status, {
            title,
            rcPath: 'sync/copy',
            params: {
              srcFs: fsParam(remote, remotePath),
              dstFs: localPath,
              _config: cfg,
            },
          });
        } else {
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          await withTransferProgress(this.client, this.status, {
            title: `${title}: ${path.basename(localPath)}`,
            rcPath: 'operations/copyfile',
            params: {
              srcFs: fsParam(remote, path.posix.dirname(remotePath)),
              srcRemote: path.posix.basename(remotePath),
              dstFs: path.dirname(localPath),
              dstRemote: path.basename(localPath),
              _config: cfg,
            },
          });
        }
      });
      log(`Downloaded ${target.name}:${remotePath} → ${rel}`);
      this.status.setOk(`Downloaded ← ${target.name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.status.setError('Download failed');
      log(`Download failed: ${msg}`);
      throw e;
    }
  }

  async syncFolder(localFolder: string, direction: 'localToRemote' | 'remoteToLocal'): Promise<void> {
    const config = this.requireConfig();
    const targets =
      direction === 'localToRemote'
        ? this.targetsForPath(config, localFolder)
        : (await this.pickTargets(config, false)) ?? [];
    if (targets.length === 0) {
      log(`No target context matches ${localFolder} — skip sync`);
      return;
    }
    this.status.setBusy(`Sync ${direction}…`);

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const rel = localToRemoteRelative(localFolder, target);
        const remotePath = joinRemotePath(target.remotePath, rel);
        const cfg = transferConfig(config, target);
        const filter = rcloneIgnoreFilter(config.ignore);
        const title =
          direction === 'localToRemote'
            ? `Sync → ${target.name}`
            : `Sync ← ${target.name}`;
        await withHostKeyRetry(this.client, target, async (remote) => {
          if (direction === 'localToRemote') {
            await withTransferProgress(this.client, this.status, {
              title,
              rcPath: 'sync/sync',
              params: {
                srcFs: localFsParam(localFolder),
                dstFs: fsParam(remote, remotePath),
                _config: cfg,
                ...(filter ? { _filter: filter } : {}),
              },
            });
          } else {
            fs.mkdirSync(localFolder, { recursive: true });
            await withTransferProgress(this.client, this.status, {
              title,
              rcPath: 'sync/sync',
              params: {
                srcFs: fsParam(remote, remotePath),
                dstFs: localFolder,
                _config: cfg,
              },
            });
          }
        });
        log(`Synced ${direction} ${rel} ↔ ${target.name}`);
        return target.name;
      })
    );

    const ok: string[] = [];
    const failed: string[] = [];
    results.forEach((r, i) => {
      const name = targets[i].name;
      if (r.status === 'fulfilled') {
        ok.push(name);
      } else {
        failed.push(name);
        log(
          `Sync failed → ${name}: ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }`
        );
      }
    });

    if (ok.length && failed.length) {
      this.status.setOk(`Sync done → ${ok.join(', ')} (failed ${failed.join(', ')})`);
      vscode.window.showWarningMessage(
        `Better SSH: synced ${ok.join(', ')}; failed on ${failed.join(', ')}`
      );
      return;
    }
    if (ok.length) {
      this.status.setOk('Sync done');
      return;
    }
    this.status.setError('Sync failed');
    throw new Error(`Sync failed on ${failed.join(', ')}`);
  }

  async checkFolder(localFolder: string): Promise<void> {
    const config = this.requireConfig();
    const targets = await this.pickTargets(config, false);
    if (!targets || targets.length === 0) {
      return;
    }
    const target = targets[0];
    const rel = localToRemoteRelative(localFolder, target);
    const remotePath = joinRemotePath(target.remotePath, rel);
    this.status.setBusy(`Checking vs ${target.name}`);
    try {
      const result = await withHostKeyRetry(this.client, target, async (remote) =>
        this.client.call<{
          differ?: string[];
          missingOnSrc?: string[];
          missingOnDst?: string[];
          error?: string[];
          status?: string;
        }>('operations/check', {
          srcFs: localFsParam(localFolder),
          dstFs: fsParam(remote, remotePath),
          download: false,
          differ: true,
          missingOnSrc: true,
          missingOnDst: true,
          error: true,
          match: false,
          _config: transferConfig(config, target),
        })
      );
      const lines = [
        `Check ${rel} vs ${target.name}:${remotePath}`,
        `differ: ${(result.differ ?? []).length}`,
        `missing on remote: ${(result.missingOnDst ?? []).length}`,
        `missing on local: ${(result.missingOnSrc ?? []).length}`,
        `errors: ${(result.error ?? []).length}`,
      ];
      for (const d of result.differ ?? []) {
        lines.push(`  differ: ${d}`);
      }
      for (const d of result.missingOnDst ?? []) {
        lines.push(`  missing remote: ${d}`);
      }
      for (const d of result.missingOnSrc ?? []) {
        lines.push(`  missing local: ${d}`);
      }
      log(lines.join('\n'));
      vscode.window.showInformationMessage(lines.slice(0, 5).join(' — '));
      this.status.setOk(`Check ${target.name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.status.setError('Check failed');
      log(`Check failed: ${msg}`);
      throw e;
    }
  }

  async diffLocalFile(localPath: string): Promise<void> {
    const config = this.requireConfig();
    const matched = this.targetsForPath(config, localPath);
    let targets = matched.length === 1 ? matched : await this.pickTargets(config, false);
    if (matched.length > 1) {
      // Prefer contextual matches in the picker by filtering to matched set
      const picked = await vscode.window.showQuickPick(
        matched.map((t) => ({
          label: t.name,
          description: t.context || t.sshConfigHost || t.host,
          target: t,
        })),
        { placeHolder: 'Select remote for diff' }
      );
      targets = picked ? [picked.target] : undefined;
    }
    if (!targets || targets.length === 0) {
      return;
    }
    const target = targets[0];
    const rel = localToRemoteRelative(localPath, target);
    const remotePath = joinRemotePath(target.remotePath, rel);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-ssh-diff-'));
    const tmpFile = path.join(tmpDir, path.basename(localPath));
    this.status.setBusy(`Diff ${target.name}`);
    try {
      await withHostKeyRetry(this.client, target, async (remote) => {
        await withTransferProgress(this.client, this.status, {
          title: `Diff fetch ← ${target.name}: ${path.basename(localPath)}`,
          rcPath: 'operations/copyfile',
          params: {
            srcFs: fsParam(remote, path.posix.dirname(remotePath)),
            srcRemote: path.posix.basename(remotePath),
            dstFs: tmpDir,
            dstRemote: path.basename(localPath),
          },
        });
      });
      const left = vscode.Uri.file(localPath);
      const right = vscode.Uri.file(tmpFile);
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${path.basename(localPath)} (local ↔ ${target.name})`
      );
      this.status.setOk(`Diff ${target.name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.status.setError('Diff failed');
      log(`Diff failed: ${msg}`);
      throw e;
    }
  }

  async openTerminal(target: TargetConfig, cdOnConnect: boolean): Promise<vscode.Terminal> {
    await ensureHostKeyTrusted(target);
    const opts = this.terminalOptions(target, cdOnConnect);
    const term = vscode.window.createTerminal(opts);
    term.show();
    const inv = buildSshInvocation(target, {
      remoteCommand:
        cdOnConnect && target.remotePath ? remoteCdCommand(target.remotePath) : undefined,
    });
    log(`Opened terminal SSH: ${target.name} → ${inv.rcloneSshCommand}`);
    return term;
  }

  terminalOptions(target: TargetConfig, cdOnConnect: boolean): vscode.TerminalOptions {
    const sshPath = vscode.workspace.getConfiguration('betterSsh').get<string>('sshPath', 'ssh');
    let remoteCommand: string | undefined;
    if (cdOnConnect && target.remotePath) {
      remoteCommand = remoteCdCommand(target.remotePath);
    }
    const inv = buildSshInvocation(target, { remoteCommand });
    return {
      name: `SSH: ${target.name}`,
      shellPath: inv.executable || sshPath,
      shellArgs: inv.terminalArgs,
      env: inv.env,
      iconPath: new vscode.ThemeIcon('remote'),
    };
  }

  scheduleUploadOnSave(fsPath: string): void {
    let config: BetterSshConfig;
    try {
      config = this.requireConfig();
    } catch {
      return;
    }
    if (!config.uploadOnSave) {
      return;
    }
    // Match vscode-sftp: never upload-on-save the config file itself.
    const base = path.basename(fsPath);
    if (base === 'sftp.json' || base === 'better-ssh.json') {
      return;
    }
    if (ignoreReason(config, fsPath)) {
      return;
    }
    this.pendingSaves.add(fsPath);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      const files = [...this.pendingSaves];
      this.pendingSaves.clear();
      void (async () => {
        for (const f of files) {
          try {
            await this.uploadLocalPath(f, undefined, false, { respectIgnore: true });
          } catch (e) {
            vscode.window.showErrorMessage(
              `Better SSH upload failed: ${e instanceof Error ? e.message : e}`
            );
          }
        }
      })();
    }, 400);
  }

  async listRemote(target: TargetConfig, remoteSubPath: string): Promise<RemoteListItem[]> {
    const config = this.requireConfig();
    const safeSub = assertSafeRelativePath(remoteSubPath, 'remote path');
    const result = await withHostKeyRetry(this.client, target, async (remote) => {
      // operations/list: fs = remote root, remote = path relative to that root
      const baseFs = fsParam(remote, target.remotePath.replace(/\/+$/, '') || '/');
      return this.client.call<{
        list?: Array<{ Path: string; Name: string; IsDir: boolean; Size: number }>;
      }>('operations/list', {
        fs: baseFs,
        remote: safeSub,
        _config: transferConfig(config, target),
      });
    });
    return (result.list ?? [])
      .map((e) => {
        try {
          return {
            name: e.Name,
            path: assertSafeRelativePath(e.Path || e.Name, 'remote list entry'),
            isDir: e.IsDir,
            size: e.Size,
          };
        } catch {
          log(`Skipping unsafe remote list entry under ${target.name}: ${e.Path || e.Name}`);
          return undefined;
        }
      })
      .filter((e): e is RemoteListItem => !!e);
  }

  /** Stat a path relative to target.remotePath. */
  async statRemote(
    target: TargetConfig,
    remoteRelPath: string
  ): Promise<{ isDir: boolean; size: number; modTimeMs: number }> {
    const config = this.requireConfig();
    const remotePath = assertSafeRelativePath(remoteRelPath, 'remote path');
    try {
      return await withHostKeyRetry(this.client, target, async (remote) => {
        const baseFs = fsParam(remote, target.remotePath.replace(/\/+$/, '') || '/');
        const result = await this.client.call<{
          item?: { IsDir?: boolean; Size?: number; ModTime?: string };
          IsDir?: boolean;
          Size?: number;
          ModTime?: string;
        }>('operations/stat', {
          fs: baseFs,
          remote: remotePath,
          _config: transferConfig(config, target),
        });
        const item = result.item ?? result;
        let modTimeMs = Date.now();
        if (item.ModTime) {
          const t = Date.parse(item.ModTime);
          if (!Number.isNaN(t)) {
            modTimeMs = t;
          }
        }
        return {
          isDir: !!item.IsDir,
          size: typeof item.Size === 'number' ? item.Size : 0,
          modTimeMs,
        };
      });
    } catch {
      // Fall back: list parent and find the entry
      const parent = path.posix.dirname(remotePath);
      const name = path.posix.basename(remotePath);
      const parentRel = parent === '.' ? '' : parent;
      const entries = await this.listRemote(target, parentRel);
      const hit = entries.find((e) => e.name === name || e.path === remotePath);
      if (!hit) {
        throw new Error(`Remote path not found: ${remoteRelPath}`);
      }
      return { isDir: hit.isDir, size: hit.size, modTimeMs: Date.now() };
    }
  }

  /**
   * Download a remote file into the preview cache and return its bytes.
   */
  async fetchRemoteBytes(
    target: TargetConfig,
    remoteRelPath: string,
    cacheDir: string
  ): Promise<Uint8Array> {
    const safeRel = assertSafeRelativePath(remoteRelPath, 'remote path');
    const hash = crypto
      .createHash('sha1')
      .update(`${target.name}\0${safeRel}`)
      .digest('hex')
      .slice(0, 24);
    const base = path.posix.basename(safeRel) || 'file';
    const safe = base.replace(/[^\w.\-()+ ]+/g, '_').slice(0, 80);
    const dest = path.join(cacheDir, `${hash}-${safe}`);
    assertPathUnderRoot(cacheDir, dest, 'preview cache path');
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const config = this.requireConfig();
    const full = joinRemotePath(target.remotePath, safeRel);
    const remoteDir = path.posix.dirname(full);
    const remoteName = path.posix.basename(full);
    const localDir = path.dirname(dest);
    const localName = path.basename(dest);

    this.status.setBusy(`Preview ← ${target.name}:${safeRel}`);
    try {
      await withHostKeyRetry(this.client, target, async (remote) => {
        await this.client.run('operations/copyfile', {
          srcFs: fsParam(remote, remoteDir === '.' ? target.remotePath : remoteDir),
          srcRemote: remoteName,
          dstFs: localDir,
          dstRemote: localName,
          _config: transferConfig(config, target),
        });
      });
      const data = fs.readFileSync(dest);
      this.status.setOk(`Preview ${target.name}:${path.posix.basename(safeRel)}`);
      return new Uint8Array(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.status.setError('Preview failed');
      log(`Preview fetch failed: ${msg}`);
      throw e;
    }
  }

  /**
   * Delete a file or directory on the remote (relative to target.remotePath).
   * Directories use purge (recursive).
   */
  async deleteRemotePath(
    target: TargetConfig,
    remoteRelPath: string,
    isDirectory: boolean
  ): Promise<void> {
    const config = this.requireConfig();
    const remotePath = assertSafeRelativePath(remoteRelPath, 'remote path');
    if (!remotePath) {
      throw new Error('Refusing to delete remote root');
    }
    const full = joinRemotePath(target.remotePath, remotePath);
    this.status.setBusy(`Delete → ${target.name}:${remotePath}`);
    try {
      await withHostKeyRetry(this.client, target, async (remote) => {
        const baseFs = fsParam(remote, target.remotePath.replace(/\/+$/, '') || '/');
        if (isDirectory) {
          await withTransferProgress(this.client, this.status, {
            title: `Delete folder → ${target.name}: ${remotePath}`,
            rcPath: 'operations/purge',
            params: {
              fs: baseFs,
              remote: remotePath,
              _config: transferConfig(config, target),
            },
          });
        } else {
          await this.client.call('operations/deletefile', {
            fs: baseFs,
            remote: remotePath,
            _config: transferConfig(config, target),
          });
        }
      });
      log(`Deleted remote ${target.name}:${full}`);
      this.status.setOk(`Deleted → ${target.name}:${remotePath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.status.setError('Delete failed');
      log(`Delete failed: ${msg}`);
      throw e;
    }
  }

  workspaceRelativeToAbsolute(rel: string): string {
    const root = getWorkspaceRoot();
    if (!root) {
      throw new Error('No workspace');
    }
    const safe = assertSafeRelativePath(rel, 'workspace path');
    const abs = safe ? path.join(root, ...safe.split('/')) : root;
    return assertPathUnderRoot(root, abs, 'workspace path');
  }

  /** Map a remote path (relative to remotePath) to the local path for this target. */
  localPathForRemoteEntry(target: TargetConfig, remoteRelPath: string): string {
    const root = getWorkspaceRoot();
    if (!root) {
      throw new Error('No workspace');
    }
    const base = target.context ? contextAbsolutePath(target.context) : root;
    const rel = assertSafeRelativePath(remoteRelPath, 'remote path');
    const abs = rel ? path.join(base, ...rel.split('/')) : base;
    return assertPathUnderRoot(base, abs, 'local download path');
  }

  async dispose(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.status.dispose();
    await this.rcd.stop();
  }
}

export interface RemoteListItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

// Map gitignore-style ignore globs to rclone RC ExcludeRule.
//
// Important: rclone does NOT imply directory filter rules from patterns that
// contain `**` (see rclone filtering docs). So `**/postgres_data` alone still
// *lists* that directory — and unreadable remote dirs fail with permission
// denied. Also emit bare `dirname/` rules so rclone skips the tree entirely.
function rcloneIgnoreFilter(
  patterns: string[]
): { ExcludeRule: string[] } | undefined {
  if (!patterns.length) {
    return undefined;
  }
  const rules: string[] = [];
  const seen = new Set<string>();
  const add = (rule: string) => {
    if (!rule || seen.has(rule)) {
      return;
    }
    seen.add(rule);
    rules.push(rule);
  };

  for (const raw of patterns) {
    const p = raw.trim().replace(/^\.\//, '');
    if (!p) {
      continue;
    }
    add(p);

    // File globs like **/*.log — keep original only (stars beyond a **/ prefix)
    const withoutGlobstar = p.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
    if (withoutGlobstar.includes('*') && /\.\w+$/.test(withoutGlobstar)) {
      continue;
    }

    // Derive a concrete directory name for rclone directory exclusion.
    let dir = p;
    if (dir.startsWith('**/')) {
      dir = dir.slice(3);
    }
    if (dir.endsWith('/**')) {
      dir = dir.slice(0, -3);
    }
    if (dir.endsWith('/')) {
      dir = dir.slice(0, -1);
    }
    // Still has globs or empty → cannot form a directory rule
    if (!dir || /[*?[ ]/.test(dir)) {
      continue;
    }

    // Explicit directory rules (no `**`) — rclone skips listing these entirely
    add(`${dir}/`);
    add(`/${dir}/`);
  }

  return rules.length ? { ExcludeRule: rules } : undefined;
}
