import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { tryLoadConfig } from './config';
import { watchConfig } from './configReload';
import { log } from './log';
import { configureAskpassStorage, clearAskpassStorage } from './ssh/askpass';
import { configureRcloneStorage } from './rclone/binary';
import { registerRemoteFs } from './remoteFs';
import { configureSecrets, hydrateConfigSecrets } from './secrets';
import { BetterSshService } from './service';
import { registerTerminalIntegration } from './terminalProfiles';
import { RemoteExplorerProvider } from './views/explorer';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log('Better SSH activating');
  configureRcloneStorage(context.globalStorageUri.fsPath);
  configureAskpassStorage(context.globalStorageUri.fsPath);
  configureSecrets(context.secrets);

  const service = new BetterSshService();
  registerRemoteFs(context, service);
  const explorer = new RemoteExplorerProvider(service);

  const treeView = vscode.window.createTreeView('betterSsh.explorer', {
    treeDataProvider: explorer,
    canSelectMany: true,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,
    watchConfig(service, explorer, context),
    {
      dispose: () => {
        clearAskpassStorage();
        void service.dispose();
      },
    }
  );

  registerCommands(context, service, explorer);
  registerTerminalIntegration(context, service);

  const config = tryLoadConfig();
  if (config) {
    try {
      await hydrateConfigSecrets(config);
    } catch (e) {
      log(`Secret hydrate failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const enabled = !!config;
  await vscode.commands.executeCommand('setContext', 'betterSsh.enabled', enabled);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file') {
        service.scheduleUploadOnSave(doc.uri.fsPath);
      }
    })
  );

  const source = config?.source;
  log(
    `Better SSH ready (config ${enabled ? `from ${source}` : 'missing'} — remotes also under Terminal ▾ New Terminal)`
  );
}

export function deactivate(): void {
  clearAskpassStorage();
}
