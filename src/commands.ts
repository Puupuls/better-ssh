import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  SAMPLE_CONFIG,
  TargetConfig,
  configUri,
  getWorkspaceRoot,
  loadConfigFromSftpFile,
  serializeBetterSshConfig,
  sftpConfigUri,
} from './config';
import { reloadConfig } from './configReload';
import { log, showLog } from './log';
import { isPreviewableRemotePath, remoteFsUri } from './remoteFs';
import { storeTargetSecrets } from './secrets';
import { BetterSshService } from './service';
import { HostKeyRejectedError } from './ssh/hostKey';
import { RemoteEntryNode, RemoteExplorerProvider, TargetNode } from './views/explorer';

function asUri(arg: unknown): vscode.Uri | undefined {
  if (!arg) {
    return undefined;
  }
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (typeof arg === 'object' && arg !== null && 'fsPath' in arg) {
    return arg as vscode.Uri;
  }
  return undefined;
}

function activeFileUri(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri;
}

/** VS Code multi-select: (clicked, selected[]). */
function collectRemoteEntries(arg: unknown, all?: unknown): RemoteEntryNode[] {
  if (Array.isArray(all) && all.length > 0) {
    const nodes = all.filter((x): x is RemoteEntryNode => x instanceof RemoteEntryNode);
    if (nodes.length > 0) {
      return uniqueRemoteEntries(nodes);
    }
  }
  if (arg instanceof RemoteEntryNode) {
    return [arg];
  }
  return [];
}

function uniqueRemoteEntries(nodes: RemoteEntryNode[]): RemoteEntryNode[] {
  const seen = new Set<string>();
  const out: RemoteEntryNode[] = [];
  for (const n of nodes) {
    const key = `${n.target.name}\0${n.remoteRelPath}\0${n.isDir}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(n);
  }
  return out;
}

function collectLocalUris(arg: unknown, all?: unknown): vscode.Uri[] {
  if (Array.isArray(all) && all.length > 0) {
    const uris = all
      .map((x) => asUri(x))
      .filter((u): u is vscode.Uri => !!u && u.scheme === 'file');
    if (uris.length > 0) {
      return uris;
    }
  }
  const one = asUri(arg);
  return one && one.scheme === 'file' ? [one] : [];
}

export function registerCommands(
  context: vscode.ExtensionContext,
  service: BetterSshService,
  explorer: RemoteExplorerProvider
): void {
  const wrap = (fn: (...args: unknown[]) => Promise<void> | void) => {
    return async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (e) {
        if (e instanceof HostKeyRejectedError) {
          log(e.message);
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        log(msg);
        vscode.window.showErrorMessage(`Better SSH: ${msg}`);
      }
    };
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'betterSsh.config',
      wrap(async () => {
        const root = getWorkspaceRoot();
        if (!root) {
          throw new Error('Open a workspace folder first');
        }
        const uri = configUri()!;
        const dir = path.dirname(uri.fsPath);
        fs.mkdirSync(dir, { recursive: true });

        if (!fs.existsSync(uri.fsPath)) {
          const sftpUri = sftpConfigUri();
          if (sftpUri && fs.existsSync(sftpUri.fsPath)) {
            const migrated = loadConfigFromSftpFile();
            await storeTargetSecrets(migrated.targets);
            fs.writeFileSync(uri.fsPath, serializeBetterSshConfig(migrated), 'utf8');
            log(`Generated better-ssh.json from ${sftpUri.fsPath} (secrets → SecretStorage)`);
            vscode.window.showInformationMessage(
              'Better SSH: created better-ssh.json from sftp.json (passwords stored securely, not in the file)'
            );
          } else {
            fs.writeFileSync(uri.fsPath, SAMPLE_CONFIG, 'utf8');
          }
        }

        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        await reloadConfig(service, explorer, context);
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.uploadActiveFile',
      wrap(async () => {
        const uri = activeFileUri();
        if (!uri || uri.scheme !== 'file') {
          throw new Error('No active file');
        }
        const config = service.requireConfig();
        const targets = await service.pickTargets(config, true, uri.fsPath);
        if (!targets || targets.length === 0) {
          return;
        }
        await service.uploadLocalPath(uri.fsPath, targets, false, { respectIgnore: false });
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.uploadFile',
      wrap(async (arg, all) => {
        const uris = collectLocalUris(arg, all);
        const fallback = uris.length ? uris : activeFileUri() ? [activeFileUri()!] : [];
        if (fallback.length === 0) {
          throw new Error('No file selected');
        }
        await uploadMany(service, fallback, false);
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.uploadFolder',
      wrap(async (arg, all) => {
        const uris = collectLocalUris(arg, all);
        if (uris.length === 0) {
          throw new Error('No folder selected');
        }
        await uploadMany(service, uris, true);
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.downloadActiveFile',
      wrap(async () => {
        const uri = activeFileUri();
        if (!uri || uri.scheme !== 'file') {
          throw new Error('No active file');
        }
        await service.downloadToLocal(uri.fsPath);
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.downloadFile',
      wrap(async (arg, all) => {
        const remotes = collectRemoteEntries(arg, all).filter((n) => !n.isDir);
        if (remotes.length > 0) {
          await downloadRemoteMany(service, remotes);
          return;
        }
        const uris = collectLocalUris(arg, all);
        const fallback = uris.length ? uris : activeFileUri() ? [activeFileUri()!] : [];
        if (fallback.length === 0) {
          throw new Error('No file selected');
        }
        for (const uri of fallback) {
          await service.downloadToLocal(uri.fsPath, undefined, false);
        }
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.downloadFolder',
      wrap(async (arg, all) => {
        const remotes = collectRemoteEntries(arg, all).filter((n) => n.isDir);
        if (remotes.length > 0) {
          await downloadRemoteMany(service, remotes);
          return;
        }
        const uris = collectLocalUris(arg, all);
        if (uris.length === 0) {
          throw new Error('No folder selected');
        }
        for (const uri of uris) {
          await service.downloadToLocal(uri.fsPath, undefined, true);
        }
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.previewRemote',
      wrap(async (arg, all) => {
        const remotes = collectRemoteEntries(arg, all).filter((n) => !n.isDir);
        if (remotes.length === 0) {
          throw new Error('Select a remote file to preview');
        }
        for (const node of remotes) {
          if (!isPreviewableRemotePath(node.remoteRelPath)) {
            vscode.window.showWarningMessage(
              `Better SSH: preview not supported for ${node.remoteRelPath} — use Download`
            );
            continue;
          }
          const uri = remoteFsUri(node.target.name, node.remoteRelPath);
          await vscode.commands.executeCommand('vscode.open', uri, {
            preview: true,
          });
        }
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.downloadRemote',
      wrap(async (arg, all) => {
        const remotes = collectRemoteEntries(arg, all);
        if (remotes.length === 0) {
          throw new Error('Select remote file(s) or folder(s) in Better SSH Remotes');
        }
        await downloadRemoteMany(service, remotes);
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.syncLocalToRemote',
      wrap(async (arg, all) => {
        const uris = collectLocalUris(arg, all);
        const folders =
          uris.length > 0
            ? uris
            : getWorkspaceRoot()
              ? [vscode.Uri.file(getWorkspaceRoot()!)]
              : [];
        if (folders.length === 0) {
          throw new Error('No folder selected');
        }
        await syncMany(service, folders, 'localToRemote');
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.syncRemoteToLocal',
      wrap(async (arg, all) => {
        const uris = collectLocalUris(arg, all);
        const folders =
          uris.length > 0
            ? uris
            : getWorkspaceRoot()
              ? [vscode.Uri.file(getWorkspaceRoot()!)]
              : [];
        if (folders.length === 0) {
          throw new Error('No folder selected');
        }
        await syncMany(service, folders, 'remoteToLocal');
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.check',
      wrap(async (arg) => {
        const uri = asUri(arg) ?? vscode.Uri.file(getWorkspaceRoot()!);
        await service.checkFolder(uri.fsPath);
        showLog();
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.diffActiveFile',
      wrap(async () => {
        const uri = activeFileUri();
        if (!uri || uri.scheme !== 'file') {
          throw new Error('No active file');
        }
        await service.diffLocalFile(uri.fsPath);
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.diffFile',
      wrap(async (arg) => {
        const uri = asUri(arg) ?? activeFileUri();
        if (!uri || uri.scheme !== 'file') {
          throw new Error('No file selected');
        }
        await service.diffLocalFile(uri.fsPath);
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.openTerminal',
      wrap(async () => {
        const config = service.requireConfig();
        const picked = await service.pickTargets(config, false);
        if (!picked || picked.length === 0) {
          return;
        }
        await service.openTerminal(picked[0], config.cdOnConnect);
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.openTerminal.target',
      wrap(async (arg) => {
        const config = service.requireConfig();
        let target: TargetConfig | undefined;
        if (arg instanceof TargetNode) {
          target = arg.target;
        } else if (arg && typeof arg === 'object' && 'name' in arg && 'remotePath' in arg) {
          target = arg as TargetConfig;
        }
        if (!target) {
          const picked = await service.pickTargets(config, false);
          target = picked?.[0];
        }
        if (!target) {
          return;
        }
        await service.openTerminal(target, config.cdOnConnect);
      })
    ),

    vscode.commands.registerCommand(
      'betterSsh.deleteRemote',
      wrap(async (arg, all) => {
        const remotes = collectRemoteEntries(arg, all);
        if (remotes.length === 0) {
          throw new Error('Select a remote file or folder in Better SSH Remotes');
        }
        const hasDir = remotes.some((n) => n.isDir);
        const label =
          remotes.length === 1
            ? `${remotes[0].isDir ? 'folder' : 'file'} “${remotes[0].remoteRelPath}” on ${remotes[0].target.name}`
            : `${remotes.length} items`;
        const confirm = await vscode.window.showWarningMessage(
          `Delete remote ${label}?${hasDir ? ' Folders are removed recursively.' : ''}`,
          { modal: true },
          'Delete'
        );
        if (confirm !== 'Delete') {
          return;
        }
        const ok: string[] = [];
        const failed: string[] = [];
        for (const node of remotes) {
          try {
            await service.deleteRemotePath(node.target, node.remoteRelPath, node.isDir);
            ok.push(node.remoteRelPath);
          } catch (e) {
            failed.push(node.remoteRelPath);
            log(
              `Delete failed ${node.target.name}:${node.remoteRelPath}: ${
                e instanceof Error ? e.message : e
              }`
            );
          }
        }
        explorer.refresh();
        if (failed.length && ok.length) {
          vscode.window.showWarningMessage(
            `Better SSH: deleted ${ok.length}, failed ${failed.length}`
          );
        } else if (failed.length) {
          throw new Error(`Delete failed for ${failed.join(', ')}`);
        }
      })
    ),

    vscode.commands.registerCommand('betterSsh.refreshExplorer', () => {
      void reloadConfig(service, explorer, context);
    }),
    vscode.commands.registerCommand('betterSsh.showOutput', () => showLog()),
    vscode.commands.registerCommand('betterSsh.showRemotes', async () => {
      await vscode.commands.executeCommand('betterSsh.explorer.focus');
    })
  );
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<{ ok: number; failed: string[]; errors: string[] }> {
  let ok = 0;
  const failed: string[] = [];
  const errors: string[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      const item = items[idx];
      try {
        await fn(item);
        ok++;
      } catch (e) {
        failed.push(String(idx));
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg);
        log(`Parallel task #${idx} failed: ${msg}`);
      }
    }
  });
  await Promise.all(workers);
  return { ok, failed, errors };
}

async function syncMany(
  service: BetterSshService,
  uris: vscode.Uri[],
  direction: 'localToRemote' | 'remoteToLocal'
): Promise<void> {
  const results = await Promise.allSettled(
    uris.map(async (uri) => {
      await service.syncFolder(uri.fsPath, direction);
      return uri.fsPath;
    })
  );
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? path.basename(uris[i].fsPath) : null))
    .filter((x): x is string => !!x);
  const ok = results.length - failed.length;
  if (failed.length && ok) {
    vscode.window.showWarningMessage(
      `Better SSH: synced ${ok}, failed ${failed.length} (${failed.join(', ')})`
    );
  } else if (failed.length) {
    throw new Error(`Sync failed for ${failed.join(', ')}`);
  }
}

async function uploadMany(
  service: BetterSshService,
  uris: vscode.Uri[],
  asFolderHint: boolean
): Promise<void> {
  const config = service.requireConfig();
  const targets = await service.pickTargets(config, true, uris[0]?.fsPath);
  if (!targets || targets.length === 0) {
    return;
  }
  const concurrency = Math.min(8, Math.max(1, uris.length));
  const labels = uris.map((u) => path.basename(u.fsPath));
  const { ok, failed } = await mapPool(uris, concurrency, async (uri) => {
    const isDir = asFolderHint || (await isDirectoryUri(uri));
    await service.uploadLocalPath(uri.fsPath, targets, isDir, { respectIgnore: false });
  });
  // Remap failed indices to names
  const failedNames = failed.map((idx) => labels[Number(idx)] ?? idx);
  if (failedNames.length && ok) {
    vscode.window.showWarningMessage(
      `Better SSH: uploaded ${ok}, failed ${failedNames.length} (${failedNames.join(', ')})`
    );
  } else if (failedNames.length) {
    throw new Error(`Upload failed for ${failedNames.join(', ')}`);
  }
}

async function downloadRemoteMany(
  service: BetterSshService,
  remotes: RemoteEntryNode[]
): Promise<void> {
  const concurrency = Math.min(8, Math.max(1, remotes.length));
  const labels = remotes.map((n) => n.remoteRelPath);
  const { ok, failed } = await mapPool(remotes, concurrency, async (node) => {
    const local = service.localPathForRemoteEntry(node.target, node.remoteRelPath);
    await service.downloadToLocal(local, [node.target], node.isDir);
  });
  const failedNames = failed.map((idx) => labels[Number(idx)] ?? idx);
  if (failedNames.length && ok) {
    vscode.window.showWarningMessage(
      `Better SSH: downloaded ${ok}, failed ${failedNames.length} (${failedNames.join(', ')})`
    );
  } else if (failedNames.length) {
    throw new Error(`Download failed for ${failedNames.join(', ')}`);
  }
}

async function isDirectoryUri(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}
