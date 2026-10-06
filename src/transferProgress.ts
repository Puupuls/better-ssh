import { RcloneRcClient, RcloneStats, RcloneTransferringFile } from './rclone/client';
import { log } from './log';
import { StatusBar } from './statusBar';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return '—';
  }
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const s = Math.round(seconds);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) {
    return `${m}m ${rem}s`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function progressMessage(stats: RcloneStats, fallback: string): string {
  const active = stats.transferring ?? [];
  if (active.length === 1) {
    const f = active[0];
    const name = shortName(f.name);
    const pct = f.percentage ?? 0;
    return `${name}  ${pct}%  ${formatBytes(f.bytes)}/${formatBytes(f.size)}  ${formatSpeed(
      f.speedAvg || f.speed
    )}  ETA ${formatEta(f.eta)}`;
  }
  if (active.length > 1) {
    const lines = active.slice(0, 3).map((f) => {
      const pct = f.percentage ?? 0;
      return `${shortName(f.name)} ${pct}%`;
    });
    const more = active.length > 3 ? ` +${active.length - 3}` : '';
    return `${lines.join(' · ')}${more}  ${formatSpeed(stats.speed)}  ETA ${formatEta(stats.eta)}`;
  }
  if (stats.totalBytes > 0) {
    const pct =
      stats.percentage ??
      Math.min(100, Math.round((100 * stats.bytes) / stats.totalBytes));
    return `${fallback}  ${pct}%  ${formatBytes(stats.bytes)}/${formatBytes(
      stats.totalBytes
    )}  ${formatSpeed(stats.speed)}`;
  }
  return fallback;
}

function shortName(name: string): string {
  const base = name.split(/[/\\]/).pop() || name;
  return base.length > 40 ? base.slice(0, 37) + '…' : base;
}

/** One status-bar line shared by all concurrent transfers (no notification popups). */
type ActiveSlot = {
  title: string;
  summary: string;
  seen: Set<string>;
  lastByName: Map<string, RcloneTransferringFile>;
};

const activeSlots = new Map<string, ActiveSlot>();
let paintTimer: ReturnType<typeof setTimeout> | undefined;
let statusOwner: StatusBar | undefined;

function paintStatusBar(): void {
  if (!statusOwner || activeSlots.size === 0) {
    return;
  }
  if (activeSlots.size === 1) {
    const only = [...activeSlots.values()][0];
    statusOwner.setBusy(only.summary);
    return;
  }
  const parts = [...activeSlots.values()].map((s) => shortName(s.title));
  const shown = parts.slice(0, 2).join(', ');
  const more = parts.length > 2 ? ` +${parts.length - 2}` : '';
  statusOwner.setBusy(`Transferring ${activeSlots.size}: ${shown}${more}`);
}

function schedulePaint(status: StatusBar): void {
  statusOwner = status;
  if (paintTimer) {
    return;
  }
  paintTimer = setTimeout(() => {
    paintTimer = undefined;
    paintStatusBar();
  }, 120);
}

function fileLine(f: RcloneTransferringFile): string {
  const pct = f.percentage ?? 0;
  return `${shortName(f.name)}  ${pct}%  ${formatBytes(f.bytes)}/${formatBytes(f.size)}  ${formatSpeed(
    f.speedAvg || f.speed
  )}`;
}

function logFileDeltas(slot: ActiveSlot, stats: RcloneStats): void {
  const active = stats.transferring ?? [];
  const now = new Set(active.map((f) => f.name));

  for (const f of active) {
    slot.lastByName.set(f.name, f);
    if (!slot.seen.has(f.name)) {
      slot.seen.add(f.name);
      log(`${slot.title}: ${fileLine(f)}`);
    }
  }

  for (const name of [...slot.seen]) {
    if (now.has(name)) {
      continue;
    }
    const last = slot.lastByName.get(name);
    if (last) {
      log(`${slot.title}: done ${shortName(name)}  ${formatBytes(last.size || last.bytes)}`);
      slot.lastByName.delete(name);
    } else {
      log(`${slot.title}: done ${shortName(name)}`);
    }
    slot.seen.delete(name);
  }
}

/**
 * Run an rclone RC call with a single shared status-bar progress.
 * Per-file detail goes to the Better SSH output channel only.
 */
export async function withTransferProgress(
  client: RcloneRcClient,
  status: StatusBar,
  opts: {
    title: string;
    rcPath: string;
    params: Record<string, unknown>;
  }
): Promise<Record<string, unknown>> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slot: ActiveSlot = {
    title: opts.title,
    summary: `${opts.title}: starting…`,
    seen: new Set(),
    lastByName: new Map(),
  };
  activeSlots.set(id, slot);
  log(`${opts.title}: starting…`);
  schedulePaint(status);

  try {
    return await client.runWithProgress(opts.rcPath, opts.params, {
      onProgress: (stats) => {
        slot.summary = progressMessage(stats, opts.title);
        logFileDeltas(slot, stats);
        schedulePaint(status);
      },
    });
  } finally {
    for (const name of slot.seen) {
      const last = slot.lastByName.get(name);
      log(
        last
          ? `${opts.title}: done ${shortName(name)}  ${formatBytes(last.size || last.bytes)}`
          : `${opts.title}: done ${shortName(name)}`
      );
    }
    activeSlots.delete(id);
    if (activeSlots.size === 0) {
      if (paintTimer) {
        clearTimeout(paintTimer);
        paintTimer = undefined;
      }
    } else {
      schedulePaint(status);
    }
  }
}
