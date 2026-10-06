import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Better SSH');
  }
  return channel;
}

export function log(message: string): void {
  getLog().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logDebug(message: string): void {
  const debug = vscode.workspace.getConfiguration('betterSsh').get<boolean>('debug', false);
  if (debug) {
    log(`DEBUG ${message}`);
  }
}

export function showLog(): void {
  getLog().show(true);
}
