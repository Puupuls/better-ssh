import * as path from 'path';

/**
 * Normalize a relative path and reject traversal / absolute / NUL.
 * Returns `/`-separated path with no leading slash ('' for root).
 */
export function assertSafeRelativePath(rel: string, label = 'path'): string {
  if (rel == null) {
    return '';
  }
  if (rel.includes('\0')) {
    throw new Error(`Invalid ${label}: contains NUL`);
  }
  const trimmed = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!trimmed || trimmed === '.') {
    return '';
  }
  if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    throw new Error(`Invalid ${label}: absolute paths are not allowed`);
  }
  const parts: string[] = [];
  for (const part of trimmed.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      throw new Error(`Invalid ${label}: path traversal is not allowed`);
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** Ensure pathResolved stays under rootAbs (after normalize). */
export function assertPathUnderRoot(rootAbs: string, pathAbs: string, label = 'path'): string {
  const root = path.resolve(rootAbs);
  const resolved = path.resolve(pathAbs);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Invalid ${label}: escapes allowed root`);
  }
  return resolved;
}
