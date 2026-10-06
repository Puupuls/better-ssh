import * as vscode from 'vscode';
import { showLog } from './log';

export class StatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'betterSsh.showOutput';
    this.item.text = '$(cloud) Better SSH';
    this.item.tooltip = 'Better SSH';
    this.item.show();
  }

  setIdle(message?: string): void {
    this.item.text = message ? `$(cloud) ${message}` : '$(cloud) Better SSH';
    this.item.backgroundColor = undefined;
  }

  setBusy(message: string): void {
    this.item.text = `$(sync~spin) ${message}`;
    this.item.backgroundColor = undefined;
  }

  setError(message: string): void {
    this.item.text = `$(error) ${message}`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  setOk(message: string): void {
    this.item.text = `$(check) ${message}`;
    this.item.backgroundColor = undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}

export function wireStatusBarClick(): vscode.Disposable {
  return vscode.commands.registerCommand('betterSsh.showOutput', () => showLog());
}
