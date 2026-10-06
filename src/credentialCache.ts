/** Sync in-memory credential cache (avoids config ↔ secrets circular imports). */

export interface CachedTargetSecrets {
  password?: string;
  passphrase?: string;
}

const cache = new Map<string, CachedTargetSecrets>();

export function setCachedTargetSecrets(
  targetName: string,
  secrets: CachedTargetSecrets
): void {
  cache.set(targetName, {
    password: secrets.password,
    passphrase: secrets.passphrase,
  });
}

export function deleteCachedTargetSecrets(targetName: string): void {
  cache.delete(targetName);
}

export function pruneCachedTargetSecrets(activeNames: Iterable<string>): void {
  const names = new Set(activeNames);
  for (const key of cache.keys()) {
    if (!names.has(key)) {
      cache.delete(key);
    }
  }
}

export function applyCachedSecrets(
  targets: Array<{ name: string; password?: string; passphrase?: string }>
): void {
  for (const target of targets) {
    const cached = cache.get(target.name);
    if (!target.password && cached?.password) {
      target.password = cached.password;
    }
    if (!target.passphrase && cached?.passphrase) {
      target.passphrase = cached.passphrase;
    }
  }
}
