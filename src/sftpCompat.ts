import { BetterSshConfig, TargetConfig, expandHome } from './config';

/**
 * Effective ignores vscode-sftp users rely on when switching to Better SSH.
 *
 * - `.vscode` / `.git` / `.DS_Store` — every Natizyskunk/vscode-sftp README & wiki example
 * - `sftp.json` — vscode-sftp never upload-on-saves its config (`isConfigFile`), even when
 *   `ignore` is empty (the real `newConfig` default)
 *
 * Merged ahead of user patterns so user entries (incl. `!` negations) still win.
 */
export const VSCODE_SFTP_COMPAT_IGNORES: readonly string[] = [
  '.vscode',
  '.git',
  '.DS_Store',
  'sftp.json',
  '**/.vscode/sftp.json',
];

/** Subset of Natizyskunk/vscode-sftp config we care about */
interface SftpHop {
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  hop?: SftpHop | SftpHop[];
}

interface SftpEntry extends SftpHop {
  name?: string;
  protocol?: string;
  remotePath?: string;
  uploadOnSave?: boolean;
  ignore?: string[];
  context?: string;
  profiles?: Record<string, Partial<SftpEntry>>;
  defaultProfile?: string;
  agent?: string | boolean;
  password?: string;
  passphrase?: string;
}

function hopIdentity(entry: SftpHop): string {
  if (!entry.host) {
    throw new Error('sftp hop/entry missing host');
  }
  return entry.username ? `${entry.username}@${entry.host}` : entry.host;
}

/**
 * vscode-sftp hop layout: outer fields = first jump, hop = next hop(s) / final target.
 * Map to OpenSSH ProxyJump: hop[] = intermediates, host = final destination.
 */
function flattenConnection(entry: SftpEntry): {
  host: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  hop?: string[];
} {
  if (!entry.hop) {
    if (!entry.host) {
      throw new Error('sftp entry missing host');
    }
    return {
      host: entry.host,
      port: entry.port,
      username: entry.username,
      privateKeyPath: entry.privateKeyPath ? expandHome(entry.privateKeyPath) : undefined,
    };
  }

  const chain: SftpHop[] = [entry];
  let node: SftpHop | SftpHop[] | undefined = entry.hop;
  while (node) {
    if (Array.isArray(node)) {
      for (const part of node) {
        chain.push(part);
      }
      break;
    }
    chain.push(node);
    node = node.hop;
  }

  const intermediates = chain.slice(0, -1);
  const final = chain[chain.length - 1];
  if (!final.host) {
    throw new Error('sftp hop chain missing final host');
  }

  return {
    host: final.host,
    port: final.port ?? entry.port,
    username: final.username ?? entry.username,
    privateKeyPath: expandHome(
      final.privateKeyPath ?? entry.privateKeyPath ?? ''
    ) || undefined,
    hop: intermediates.map(hopIdentity),
  };
}

function entryToTarget(entry: SftpEntry, fallbackName: string): TargetConfig {
  const protocol = (entry.protocol ?? 'sftp').toLowerCase();
  if (protocol !== 'sftp' && protocol !== 'ssh') {
    throw new Error(`sftp.json protocol "${protocol}" is not supported (SFTP/SSH only)`);
  }
  if (!entry.remotePath) {
    throw new Error(`sftp entry "${fallbackName}" missing remotePath`);
  }
  const conn = flattenConnection(entry);
  return {
    name: entry.name || fallbackName,
    remotePath: entry.remotePath,
    context: entry.context ? entry.context.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') : undefined,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    privateKeyPath: conn.privateKeyPath,
    password: entry.password,
    passphrase: entry.passphrase,
    hop: conn.hop,
  };
}

function mergeProfile(root: SftpEntry, profile: Partial<SftpEntry>): SftpEntry {
  return {
    ...root,
    ...profile,
    // nested hop from profile replaces root hop
    hop: profile.hop !== undefined ? profile.hop : root.hop,
    profiles: undefined,
    defaultProfile: undefined,
  };
}

/**
 * Convert vscode-sftp `.vscode/sftp.json` (object, profiles, or multi-context array)
 * into Better SSH config.
 */
export function fromSftpJson(raw: unknown): BetterSshConfig {
  if (raw === null || raw === undefined) {
    throw new Error('sftp.json is empty');
  }

  if (Array.isArray(raw)) {
    const targets = (raw as SftpEntry[]).map((entry, i) => {
      if (!entry.name) {
        throw new Error(`sftp.json multi-context entry #${i + 1} requires name`);
      }
      return entryToTarget(entry, entry.name);
    });
    const uploadOnSave = (raw as SftpEntry[]).some((e) => e.uploadOnSave);
    const ignore = mergeIgnore(raw as SftpEntry[]);
    return finalize(targets, uploadOnSave, ignore, ['*']);
  }

  const root = raw as SftpEntry;

  if (root.profiles && typeof root.profiles === 'object') {
    const names = Object.keys(root.profiles);
    if (names.length === 0) {
      throw new Error('sftp.json profiles is empty');
    }
    const targets = names.map((name) =>
      entryToTarget(mergeProfile(root, { ...root.profiles![name], name }), name)
    );
    const defaultTargets = root.defaultProfile
      ? [root.defaultProfile]
      : ['*'];
    return finalize(
      targets,
      !!root.uploadOnSave,
      root.ignore ?? [],
      defaultTargets
    );
  }

  const name = root.name || root.host || 'default';
  return finalize(
    [entryToTarget(root, name)],
    !!root.uploadOnSave,
    root.ignore ?? [],
    ['*']
  );
}

function mergeIgnore(entries: SftpEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    for (const i of e.ignore ?? []) {
      set.add(i);
    }
  }
  return [...set];
}

/** Union vscode-sftp compat ignores with user patterns (dedupe, user order preserved after). */
export function withVscodeSftpCompatIgnores(userIgnore: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of [...VSCODE_SFTP_COMPAT_IGNORES, ...userIgnore]) {
    if (!pattern || seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

function uniquifyTargetNames(targets: TargetConfig[]): TargetConfig[] {
  const counts = new Map<string, number>();
  for (const t of targets) {
    counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  }
  if ([...counts.values()].every((c) => c === 1)) {
    return targets;
  }

  const used = new Set<string>();
  return targets.map((t) => {
    if ((counts.get(t.name) ?? 0) === 1) {
      used.add(t.name);
      return t;
    }
    const suffix =
      t.username ||
      (t.port != null ? String(t.port) : undefined) ||
      t.host ||
      'remote';
    let name = `${t.name}:${suffix}`;
    let n = 2;
    while (used.has(name)) {
      name = `${t.name}:${suffix}:${n++}`;
    }
    used.add(name);
    return { ...t, name };
  });
}

function finalize(
  targets: TargetConfig[],
  uploadOnSave: boolean,
  ignore: string[],
  defaultTargets: string[]
): BetterSshConfig {
  const unique = uniquifyTargetNames(targets);
  return {
    uploadOnSave,
    cdOnConnect: true,
    transfers: 16,
    checkers: 32,
    defaultTargets,
    ignore: withVscodeSftpCompatIgnores(ignore),
    targets: unique,
  };
}
