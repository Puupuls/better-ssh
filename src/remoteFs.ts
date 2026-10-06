import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TargetConfig, tryLoadConfig } from './config';
import { log, logDebug } from './log';
import { assertSafeRelativePath } from './paths';
import { BetterSshService } from './service';

export const REMOTE_FS_SCHEME = 'better-ssh';

/** Soft cap for in-editor preview (download-to-workspace still unlimited). */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
  '.avif',
  '.tif',
  '.tiff',
]);

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.vue',
  '.svelte',
  '.py',
  '.rb',
  '.php',
  '.java',
  '.kt',
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  '.sql',
  '.graphql',
  '.gql',
  '.csv',
  '.tsv',
  '.log',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.dockerfile',
  '.makefile',
  '.cmake',
  '.gradle',
  '.properties',
  '.plist',
  '.svg', // also image; VS Code handles either way
  '.lock',
  '.npmrc',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.rtf',
  '.tex',
  '.latex',
  '.r',
  '.lua',
  '.pl',
  '.pm',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.scala',
  '.dart',
  '.zig',
  '.nim',
  '.ml',
  '.mli',
  '.hs',
  '.elm',
  '.proto',
  '.tf',
  '.hcl',
  '.nix',
  '.vim',
  '.diff',
  '.patch',
]);

const TEXT_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'gemfile',
  'rakefile',
  'procfile',
  'cmakelists.txt',
  'readme',
  'license',
  'changelog',
  'authors',
  'copying',
  'jenkinsfile',
  'vagrantfile',
]);

export function isPreviewableRemotePath(remoteRelPath: string): boolean {
  const base = path.posix.basename(remoteRelPath).toLowerCase();
  const ext = path.posix.extname(base).toLowerCase();
  if (IMAGE_EXT.has(ext) || TEXT_EXT.has(ext)) {
    return true;
  }
  if (!ext && TEXT_BASENAMES.has(base)) {
    return true;
  }
  // Extensionless / unknown: still allow small files (opened as text)
  return !ext || !isLikelyBinaryExt(ext);
}

function isLikelyBinaryExt(ext: string): boolean {
  return [
    '.zip',
    '.gz',
    '.tgz',
    '.bz2',
    '.xz',
    '.7z',
    '.rar',
    '.tar',
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.bin',
    '.o',
    '.a',
    '.wasm',
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.wasm',
    '.pyc',
    '.class',
    '.jar',
    '.war',
    '.apk',
    '.dmg',
    '.iso',
    '.mp3',
    '.mp4',
    '.mov',
    '.avi',
    '.mkv',
    '.wav',
    '.flac',
    '.ogg',
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
    '.eot',
    '.sqlite',
    '.db',
    '.parquet',
    '.pkl',
    '.pt',
    '.onnx',
  ].includes(ext);
}

export function remoteFsUri(targetName: string, remoteRelPath: string): vscode.Uri {
  const rel = remoteRelPath.replace(/^\/+/, '');
  return vscode.Uri.from({
    scheme: REMOTE_FS_SCHEME,
    authority: encodeURIComponent(targetName),
    path: '/' + rel,
  });
}

export function parseRemoteFsUri(uri: vscode.Uri): { targetName: string; remoteRelPath: string } {
  if (uri.scheme !== REMOTE_FS_SCHEME) {
    throw vscode.FileSystemError.Unavailable(`Not a ${REMOTE_FS_SCHEME} URI`);
  }
  const targetName = decodeURIComponent(uri.authority);
  const remoteRelPath = assertSafeRelativePath(uri.path.replace(/^\/+/, ''), 'remote URI path');
  return { targetName, remoteRelPath };
}

export class BetterSshFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  private readonly cacheDir: string;

  constructor(private readonly service: BetterSshService, globalStoragePath: string) {
    this.cacheDir = path.join(globalStoragePath, 'preview-cache');
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { target, remoteRelPath } = this.resolve(uri);
    if (!remoteRelPath) {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: Date.now(),
        size: 0,
      };
    }
    const info = await this.service.statRemote(target, remoteRelPath);
    return {
      type: info.isDir ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: info.modTimeMs || Date.now(),
      size: info.size,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { target, remoteRelPath } = this.resolve(uri);
    const entries = await this.service.listRemote(target, remoteRelPath);
    return entries.map((e) => [
      e.name,
      e.isDir ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { target, remoteRelPath } = this.resolve(uri);
    if (!remoteRelPath) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    if (!isPreviewableRemotePath(remoteRelPath)) {
      throw vscode.FileSystemError.Unavailable(
        `Preview not supported for this file type — use Download instead (${remoteRelPath})`
      );
    }
    const info = await this.service.statRemote(target, remoteRelPath);
    if (info.isDir) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    if (info.size > PREVIEW_MAX_BYTES) {
      throw vscode.FileSystemError.Unavailable(
        `File too large for preview (${formatSize(info.size)}; max ${formatSize(PREVIEW_MAX_BYTES)}). Use Download.`
      );
    }
    log(`Preview ${target.name}:${remoteRelPath}`);
    const data = await this.service.fetchRemoteBytes(target, remoteRelPath, this.cacheDir);
    return data;
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Remote preview is read-only');
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions(
      'Remote preview is read-only — download the file to edit locally'
    );
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Remote preview is read-only');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Remote preview is read-only');
  }

  private resolve(uri: vscode.Uri): { target: TargetConfig; remoteRelPath: string } {
    const { targetName, remoteRelPath } = parseRemoteFsUri(uri);
    const config = tryLoadConfig();
    const target = config?.targets.find((t) => t.name === targetName);
    if (!target) {
      throw vscode.FileSystemError.FileNotFound(`Unknown remote target "${targetName}"`);
    }
    return { target, remoteRelPath };
  }
}

function formatSize(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Stable cache filename for a remote file (kept for tests / callers). */
export function previewCachePath(
  cacheDir: string,
  targetName: string,
  remoteRelPath: string
): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${targetName}\0${remoteRelPath}`)
    .digest('hex')
    .slice(0, 24);
  const base = path.posix.basename(remoteRelPath) || 'file';
  const safe = base.replace(/[^\w.\-()+ ]+/g, '_').slice(0, 80);
  return path.join(cacheDir, `${hash}-${safe}`);
}

export function registerRemoteFs(
  context: vscode.ExtensionContext,
  service: BetterSshService
): void {
  const provider = new BetterSshFileSystemProvider(service, context.globalStorageUri.fsPath);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(REMOTE_FS_SCHEME, provider, {
      isReadonly: true,
      isCaseSensitive: true,
    })
  );
  logDebug(`Registered ${REMOTE_FS_SCHEME}: FileSystemProvider`);
}
