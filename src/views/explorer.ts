import * as vscode from 'vscode';
import { TargetConfig, tryLoadConfig } from '../config';
import { isPreviewableRemotePath, remoteFsUri } from '../remoteFs';
import { BetterSshService } from '../service';

export type ExplorerNode = TargetNode | RemoteEntryNode;

export class TargetNode extends vscode.TreeItem {
  constructor(public readonly target: TargetConfig) {
    super(target.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'targetRoot';
    this.iconPath = new vscode.ThemeIcon('server');
    const bits = [target.context, target.sshConfigHost || target.host].filter(Boolean);
    this.description = bits.join(' → ');
    this.tooltip = [
      target.name,
      target.context ? `local: ${target.context}` : undefined,
      `remote: ${target.remotePath}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}

export class RemoteEntryNode extends vscode.TreeItem {
  constructor(
    public readonly target: TargetConfig,
    public readonly remoteRelPath: string,
    public readonly isDir: boolean,
    label: string
  ) {
    super(
      label,
      isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.contextValue = isDir ? 'remoteFolder' : 'remoteFile';
    this.tooltip = `${target.name}:${remoteRelPath}`;

    if (!isDir) {
      const uri = remoteFsUri(target.name, remoteRelPath);
      this.resourceUri = uri;
      if (isPreviewableRemotePath(remoteRelPath)) {
        this.command = {
          command: 'betterSsh.previewRemote',
          title: 'Preview',
          arguments: [this],
        };
        this.contextValue = 'remoteFilePreviewable';
      } else {
        this.iconPath = new vscode.ThemeIcon('file');
      }
    } else {
      this.iconPath = new vscode.ThemeIcon('folder');
    }
  }
}

export class RemoteExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExplorerNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly service: BetterSshService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    const config = tryLoadConfig();
    if (!config) {
      return [];
    }
    if (!element) {
      return config.targets.map((t) => {
        const node = new TargetNode(t);
        if (t.enabled === false) {
          node.description = `${node.description || ''} (disabled)`.trim();
          node.iconPath = new vscode.ThemeIcon('debug-disconnect');
        }
        return node;
      });
    }
    if (element instanceof TargetNode) {
      return this.list(element.target, '');
    }
    if (element instanceof RemoteEntryNode && element.isDir) {
      return this.list(element.target, element.remoteRelPath);
    }
    return [];
  }

  private async list(target: TargetConfig, remoteRel: string): Promise<RemoteEntryNode[]> {
    try {
      const entries = await this.service.listRemote(target, remoteRel);
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) {
          return a.isDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      return entries.map((e) => new RemoteEntryNode(target, e.path, e.isDir, e.name));
    } catch (e) {
      vscode.window.showErrorMessage(
        `Better SSH list failed: ${e instanceof Error ? e.message : e}`
      );
      return [];
    }
  }
}
