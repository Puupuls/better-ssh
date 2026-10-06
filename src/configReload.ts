import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_REL, SFTP_CONFIG_REL, tryLoadConfig } from './config';
import { log } from './log';
import { invalidateRemoteCache } from './rclone/remotes';
import { hydrateConfigSecrets } from './secrets';
import { BetterSshService } from './service';
import { syncInjectedProfiles } from './terminalProfiles';
import { RemoteExplorerProvider } from './views/explorer';

function isConfigPath(fsPath: string): boolean {
  const base = path.basename(fsPath);
  const parent = path.basename(path.dirname(fsPath));
  if (parent !== '.vscode') {
    return false;
  }
  return base === 'better-ssh.json' || base === 'sftp.json' || base === path.basename(CONFIG_REL) || base === path.basename(SFTP_CONFIG_REL);
}

/**
 * Full hot-reload: invalidate rclone remotes, re-apply connections, refresh UI + terminal profiles.
 */
export async function reloadConfig(
  service: BetterSshService,
  explorer: RemoteExplorerProvider,
  extensionContext?: vscode.ExtensionContext
): Promise<void> {
  invalidateRemoteCache();
  const config = tryLoadConfig();
  if (config) {
    try {
      await hydrateConfigSecrets(config);
    } catch (e) {
      log(`Secret hydrate failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  await vscode.commands.executeCommand('setContext', 'betterSsh.enabled', !!config);

  if (config) {
    try {
      await service.reapplyRemotes(config);
      log(
        `Config reloaded (${config.source ?? 'config'}): ${config.targets
          .map((t) => {
            const flags = [
              t.enabled === false ? 'off' : undefined,
              t.context ? `@${t.context}` : undefined,
              t.password ? 'password' : t.privateKeyPath ? 'key' : 'agent?',
            ].filter(Boolean);
            return `${t.name}[${flags.join(',')}]`;
          })
          .join(', ')}`
      );
    } catch (e) {
      log(`Config reload: remotes apply failed: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    log('Config reloaded: no better-ssh.json / sftp.json');
  }

  explorer.refresh();
  if (extensionContext) {
    await syncInjectedProfiles(extensionContext, service);
  }
}

export function watchConfig(
  service: BetterSshService,
  explorer: RemoteExplorerProvider,
  extensionContext: vscode.ExtensionContext
): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  const schedule = (reason: string) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      log(`Config change detected (${reason})`);
      void reloadConfig(service, explorer, extensionContext);
    }, 150);
  };

  const betterWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/better-ssh.json');
  const sftpWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/sftp.json');
  for (const watcher of [betterWatcher, sftpWatcher]) {
    watcher.onDidCreate(() => schedule('create'));
    watcher.onDidChange(() => schedule('change'));
    watcher.onDidDelete(() => schedule('delete'));
  }

  // FileSystemWatcher can miss in-editor saves; onDidSave is reliable.
  const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme === 'file' && isConfigPath(doc.uri.fsPath)) {
      schedule('save');
    }
  });

  return {
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
      betterWatcher.dispose();
      sftpWatcher.dispose();
      saveSub.dispose();
    },
  };
}
