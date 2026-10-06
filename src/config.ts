import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ignore from 'ignore';
import * as vscode from 'vscode';
import { applyCachedSecrets } from './credentialCache';
import { fromSftpJson, withVscodeSftpCompatIgnores } from './sftpCompat';

export interface TargetConfig {
  name: string;
  remotePath: string;
  /**
   * Local subdirectory (relative to workspace) this target owns.
   * Files outside it are not uploaded here. Same as vscode-sftp `context`.
   */
  context?: string;
  sshConfigHost?: string;
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  /** SSH/SFTP login password (also used for Open Terminal via SSH_ASKPASS). */
  password?: string;
  /** Passphrase for an encrypted private key. */
  passphrase?: string;
  hop?: string[];
  transfers?: number;
  checkers?: number;
  /** When false, skip automatic uploads. Default true. */
  enabled?: boolean;
}

export interface BetterSshConfig {
  uploadOnSave: boolean;
  cdOnConnect: boolean;
  transfers: number;
  checkers: number;
  defaultTargets: string[];
  ignore: string[];
  targets: TargetConfig[];
  /** Which file was loaded */
  source?: 'better-ssh.json' | 'sftp.json';
}

const DEFAULTS: Omit<BetterSshConfig, 'targets'> = {
  uploadOnSave: false,
  cdOnConnect: true,
  transfers: 16,
  checkers: 32,
  defaultTargets: ['*'],
  ignore: [],
};

export const CONFIG_REL = path.join('.vscode', 'better-ssh.json');
export const SFTP_CONFIG_REL = path.join('.vscode', 'sftp.json');

export function expandHome(p: string): string {
  if (!p) {
    return p;
  }
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function configUri(): vscode.Uri | undefined {
  const root = getWorkspaceRoot();
  if (!root) {
    return undefined;
  }
  return vscode.Uri.file(path.join(root, CONFIG_REL));
}

export function sftpConfigUri(): vscode.Uri | undefined {
  const root = getWorkspaceRoot();
  if (!root) {
    return undefined;
  }
  return vscode.Uri.file(path.join(root, SFTP_CONFIG_REL));
}

/** True when JSON is vscode-sftp-shaped (array / profiles / single entry) rather than native `{ targets }`. */
export function isSftpShapedConfig(raw: unknown): boolean {
  if (Array.isArray(raw)) {
    return true;
  }
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.targets)) {
    return false;
  }
  if (o.profiles && typeof o.profiles === 'object') {
    return true;
  }
  return typeof o.remotePath === 'string' && typeof o.host === 'string';
}

function parseBetterSsh(raw: unknown): BetterSshConfig {
  if (isSftpShapedConfig(raw)) {
    const cfg = fromSftpJson(raw);
    cfg.source = 'better-ssh.json';
    return cfg;
  }

  const data = raw as Partial<BetterSshConfig>;
  if (!Array.isArray(data.targets) || data.targets.length === 0) {
    throw new Error('better-ssh.json: targets[] is required');
  }
  for (const t of data.targets) {
    if (!t.name || !t.remotePath) {
      throw new Error('better-ssh.json: each target needs name and remotePath');
    }
    if (!t.sshConfigHost && !t.host) {
      throw new Error(`better-ssh.json: target "${t.name}" needs host or sshConfigHost`);
    }
  }
  const names = new Set(data.targets.map((t) => t.name));
  if (names.size !== data.targets.length) {
    throw new Error('better-ssh.json: target names must be unique');
  }

  // vscode-sftp often puts uploadOnSave / ignore on each target — fold into root.
  const targetExtras = data.targets as Array<
    TargetConfig & { uploadOnSave?: boolean; ignore?: string[] }
  >;
  const anyUpload = targetExtras.some((t) => t.uploadOnSave === true);
  const mergedIgnore = [
    ...(data.ignore ?? DEFAULTS.ignore),
    ...targetExtras.flatMap((t) => t.ignore ?? []),
  ];
  const ignore = [...new Set(mergedIgnore)];

  return {
    uploadOnSave: (data.uploadOnSave ?? DEFAULTS.uploadOnSave) || anyUpload,
    cdOnConnect: data.cdOnConnect ?? DEFAULTS.cdOnConnect,
    transfers: data.transfers ?? DEFAULTS.transfers,
    checkers: data.checkers ?? DEFAULTS.checkers,
    defaultTargets: data.defaultTargets ?? DEFAULTS.defaultTargets,
    ignore,
    targets: data.targets.map((t) => ({
      name: t.name,
      remotePath: t.remotePath,
      context: t.context ? normalizeContext(t.context) : undefined,
      sshConfigHost: t.sshConfigHost,
      host: t.host,
      port: t.port,
      username: t.username,
      privateKeyPath: t.privateKeyPath ? expandHome(t.privateKeyPath) : undefined,
      password: t.password,
      passphrase: t.passphrase,
      hop: t.hop,
      transfers: t.transfers,
      checkers: t.checkers,
      enabled: t.enabled,
    })),
    source: 'better-ssh.json',
  };
}

function readJsonFile(fsPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(fsPath, 'utf8'));
  } catch (e) {
    throw new Error(
      `${path.basename(fsPath)} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Prefer `.vscode/better-ssh.json`, else fall back to vscode-sftp `.vscode/sftp.json`.
 * When `sftp.json` is present, vscode-sftp compat ignores are merged in so uploads
 * don't suddenly include paths that plugin treated as off-limits.
 */
export function loadConfig(): BetterSshConfig | undefined {
  const betterUri = configUri();
  const sftpUri = sftpConfigUri();
  const hasSftp = !!(sftpUri && fs.existsSync(sftpUri.fsPath));

  if (betterUri && fs.existsSync(betterUri.fsPath)) {
    const cfg = parseBetterSsh(readJsonFile(betterUri.fsPath));
    if (hasSftp) {
      cfg.ignore = withVscodeSftpCompatIgnores(cfg.ignore);
    }
    return cfg;
  }

  if (hasSftp) {
    const cfg = fromSftpJson(readJsonFile(sftpUri!.fsPath));
    cfg.source = 'sftp.json';
    return cfg;
  }

  return undefined;
}

/** Soft load for UI enablement — never throws */
export function tryLoadConfig(): BetterSshConfig | undefined {
  try {
    const cfg = loadConfig();
    if (cfg) {
      applyCachedSecrets(cfg.targets);
    }
    return cfg;
  } catch {
    return undefined;
  }
}

export function hasAnyConfigFile(): boolean {
  const better = configUri();
  const sftp = sftpConfigUri();
  return !!(
    (better && fs.existsSync(better.fsPath)) ||
    (sftp && fs.existsSync(sftp.fsPath))
  );
}

export function resolveTargets(
  config: BetterSshConfig,
  selector?: string[] | 'default' | 'pick'
): TargetConfig[] {
  const active = config.targets.filter((t) => t.enabled !== false);
  if (!selector || selector === 'default') {
    if (config.defaultTargets.includes('*')) {
      return active;
    }
    return active.filter((t) => config.defaultTargets.includes(t.name));
  }
  if (selector === 'pick') {
    return active;
  }
  return active.filter((t) => selector.includes(t.name));
}

export function normalizeContext(context: string): string {
  return context.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Resolve context to an absolute directory (supports absolute or workspace-relative). */
export function contextAbsolutePath(context: string): string {
  const normalized = normalizeContext(context);
  if (path.isAbsolute(normalized)) {
    return path.normalize(normalized);
  }
  const root = getWorkspaceRoot();
  if (!root) {
    throw new Error('No workspace folder open');
  }
  return path.resolve(root, ...normalized.split('/').filter(Boolean));
}

export function isPathUnderContext(absolutePath: string, context: string): boolean {
  const ctxAbs = contextAbsolutePath(context);
  const rel = path.relative(ctxAbs, absolutePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Targets that should receive this local path.
 * - With `context`: only files under that folder (most-specific wins on overlap).
 * - Without `context`: used only when no contextual target matched.
 */
export function targetsForLocalPath(
  config: BetterSshConfig,
  absolutePath: string,
  selector: 'default' | 'pick' = 'default'
): TargetConfig[] {
  const pool = resolveTargets(config, selector);
  const contextual = pool.filter((t) => t.context);
  const global = pool.filter((t) => !t.context);

  if (contextual.length === 0) {
    return global;
  }

  const matching = contextual.filter((t) => isPathUnderContext(absolutePath, t.context!));
  if (matching.length === 0) {
    return global;
  }

  matching.sort(
    (a, b) => normalizeContext(b.context!).length - normalizeContext(a.context!).length
  );
  const bestLen = normalizeContext(matching[0].context!).length;
  return matching.filter((t) => normalizeContext(t.context!).length === bestLen);
}

/** Path relative to the target context (or workspace root), `/`-separated. */
export function localToRemoteRelative(absolutePath: string, target: TargetConfig): string {
  const root = getWorkspaceRoot();
  if (!root) {
    throw new Error('No workspace folder open');
  }
  const base = target.context ? contextAbsolutePath(target.context) : root;
  const rel = path.relative(base, absolutePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Path is outside target "${target.name}" context${
        target.context ? ` (${target.context})` : ''
      }`
    );
  }
  return rel.split(path.sep).join('/');
}

/**
 * Relative path used for ignore matching: prefer workspace-relative, else
 * relative to a matching target context (supports absolute sftp `context`).
 */
export function pathForIgnore(config: BetterSshConfig, absolutePath: string): string | undefined {
  const root = getWorkspaceRoot();
  if (root) {
    const rel = path.relative(root, absolutePath).split(path.sep).join('/');
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return rel || '.';
    }
  }
  for (const t of config.targets) {
    if (!t.context) {
      continue;
    }
    try {
      if (isPathUnderContext(absolutePath, t.context)) {
        return localToRemoteRelative(absolutePath, t) || '.';
      }
    } catch {
      /* continue */
    }
  }
  return undefined;
}

export function isIgnored(config: BetterSshConfig, absolutePath: string): boolean {
  return ignoreReason(config, absolutePath) !== undefined;
}

/** Why a path is skipped, for logging. */
export function ignoreReason(
  config: BetterSshConfig,
  absolutePath: string
): string | undefined {
  const rel = pathForIgnore(config, absolutePath);
  if (rel === undefined) {
    return 'outside workspace / target context';
  }
  if (!config.ignore.length) {
    return undefined;
  }
  const ig = ignore().add(config.ignore);
  if (ig.ignores(rel)) {
    return `matched ignore (as ${rel})`;
  }
  return undefined;
}

export const SAMPLE_CONFIG = `{
  "uploadOnSave": true,
  "cdOnConnect": true,
  "transfers": 16,
  "checkers": 32,
  "defaultTargets": ["*"],
  "ignore": [
    "**/.DS_Store",
    "**/.git",
    "**/.gitignore",
    "**/.vscode",
    "**/.cursor",
    "**/.idea",
    "**/.env",
    "**/.env.*",
    "**/.next",
    "**/.venv",
    "**/__pycache__",
    "**/node_modules",
    "**/*.code-workspace",
    "Thumbs.db"
  ],
  "targets": [
    {
      "name": "prod",
      "host": "example.com",
      "port": 22,
      "username": "deploy",
      "remotePath": "/var/www/app",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "hop": ["bastion.example.com"]
    },
    {
      "name": "staging",
      "sshConfigHost": "staging-jump",
      "remotePath": "/var/www/app"
    }
  ]
}
`;

/** Pretty-print config for writing better-ssh.json (drops runtime-only fields). */
export function serializeBetterSshConfig(config: BetterSshConfig): string {
  const targets = config.targets.map((t) => {
    const out: Record<string, unknown> = {
      name: t.name,
      remotePath: t.remotePath,
    };
    if (t.context) {
      out.context = t.context;
    }
    if (t.sshConfigHost) {
      out.sshConfigHost = t.sshConfigHost;
    }
    if (t.host) {
      out.host = t.host;
    }
    if (t.port !== undefined && t.port !== 22) {
      out.port = t.port;
    }
    if (t.username) {
      out.username = t.username;
    }
    if (t.privateKeyPath) {
      out.privateKeyPath = collapseHome(t.privateKeyPath);
    }
    // password / passphrase are never written — use VS Code SecretStorage
    if (t.hop && t.hop.length > 0) {
      out.hop = t.hop;
    }
    if (t.enabled === false) {
      out.enabled = false;
    }
    if (t.transfers !== undefined) {
      out.transfers = t.transfers;
    }
    if (t.checkers !== undefined) {
      out.checkers = t.checkers;
    }
    return out;
  });

  return (
    JSON.stringify(
      {
        uploadOnSave: config.uploadOnSave,
        cdOnConnect: config.cdOnConnect,
        transfers: config.transfers,
        checkers: config.checkers,
        defaultTargets: config.defaultTargets,
        ignore: config.ignore,
        targets,
      },
      null,
      2
    ) + '\n'
  );
}

function collapseHome(p: string): string {
  const home = os.homedir();
  if (p === home) {
    return '~';
  }
  if (p.startsWith(home + path.sep)) {
    return '~/' + p.slice(home.length + 1).split(path.sep).join('/');
  }
  return p;
}

/** Load and convert `.vscode/sftp.json` into a Better SSH config (throws if missing/invalid). */
export function loadConfigFromSftpFile(): BetterSshConfig {
  const sftpUri = sftpConfigUri();
  if (!sftpUri || !fs.existsSync(sftpUri.fsPath)) {
    throw new Error('No .vscode/sftp.json found');
  }
  const cfg = fromSftpJson(readJsonFile(sftpUri.fsPath));
  cfg.source = 'sftp.json';
  return cfg;
}
