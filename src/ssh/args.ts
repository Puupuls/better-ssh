import * as vscode from 'vscode';
import { TargetConfig } from '../config';
import { ensureAskpassEnv, needsAskpass } from './askpass';

export interface SshInvocation {
  /** Absolute or PATH-resolved ssh binary */
  executable: string;
  /** Args for interactive terminal (includes destination) */
  terminalArgs: string[];
  /**
   * Full external-ssh command string for rclone `ssh` / `--sftp-ssh`.
   * Includes hardening so ~/.ssh/config TTY/RemoteCommand/ControlMaster
   * cannot break the SFTP subsystem.
   */
  rcloneSshCommand: string;
  /** Env for createTerminal / profiles when password/passphrase is configured */
  env?: Record<string, string>;
}

/**
 * Shared OpenSSH options for terminals + rclone.
 * Keepalives prevent idle NAT/firewall drops (exit 255 after inactivity).
 * StrictHostKeyChecking=yes — unknown keys are prompted via ensureHostKeyTrusted.
 */
function commonSshOptions(target: TargetConfig): string[] {
  const args = [
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=10',
    '-o',
    'TCPKeepAlive=yes',
  ];
  if (target.password && !target.privateKeyPath) {
    args.push(
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'PubkeyAuthentication=no'
    );
  }
  return args;
}

/**
 * Options that commonly break `ssh -s sftp` when inherited from ~/.ssh/config
 * (RequestTTY, RemoteCommand, shared ControlMaster sockets).
 * BatchMode is omitted when a password/passphrase is configured (needs askpass).
 */
function rcloneHardening(target: TargetConfig): string[] {
  const args = [
    ...commonSshOptions(target),
    '-o',
    'RequestTTY=no',
    '-o',
    'RemoteCommand=none',
    '-o',
    'ControlMaster=no',
    '-o',
    'ConnectTimeout=30',
  ];
  if (!needsAskpass(target)) {
    args.unshift('-o', 'BatchMode=yes');
  }
  return args;
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function sshExecutable(): string {
  return vscode.workspace.getConfiguration('betterSsh').get<string>('sshPath', 'ssh');
}

/** Reject values that OpenSSH would parse as options. */
function assertSafeSshToken(value: string, label: string): string {
  if (!value || value.startsWith('-')) {
    throw new Error(`Invalid ${label}: must not be empty or start with "-"`);
  }
  if (value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}: contains illegal characters`);
  }
  return value;
}

/** Destination / jump args shared by terminal and rclone (no hardening). */
function destinationArgs(target: TargetConfig): string[] {
  const args: string[] = [];
  if (target.sshConfigHost) {
    args.push('--', assertSafeSshToken(target.sshConfigHost, 'sshConfigHost'));
    return args;
  }
  if (!target.host) {
    throw new Error(`Target "${target.name}" is missing host`);
  }
  if (target.hop && target.hop.length > 0) {
    for (const hop of target.hop) {
      assertSafeSshToken(hop, 'hop');
    }
    args.push('-J', target.hop.join(','));
  }
  if (target.port && target.port !== 22) {
    args.push('-p', String(target.port));
  }
  if (target.privateKeyPath) {
    args.push('-i', target.privateKeyPath);
  }
  const dest = target.username
    ? `${assertSafeSshToken(target.username, 'username')}@${assertSafeSshToken(target.host, 'host')}`
    : assertSafeSshToken(target.host, 'host');
  args.push('--', dest);
  return args;
}

/**
 * True when we must use external OpenSSH (sshConfigHost / ProxyJump).
 * Otherwise prefer rclone's built-in SFTP client.
 */
export function usesExternalSsh(target: TargetConfig): boolean {
  return !!(target.sshConfigHost || (target.hop && target.hop.length > 0));
}

/**
 * Build OpenSSH argv for integrated terminals and rclone external-ssh mode.
 */
export function buildSshInvocation(
  target: TargetConfig,
  options?: { remoteCommand?: string }
): SshInvocation {
  const executable = sshExecutable();
  const dest = destinationArgs(target);
  const env = ensureAskpassEnv(target);

  // -t must come before `-- destination`; anything after `--` is dest/command.
  const terminalArgs = [...commonSshOptions(target)];
  if (options?.remoteCommand) {
    terminalArgs.push('-t');
  }
  terminalArgs.push(...dest);
  if (options?.remoteCommand) {
    terminalArgs.push(options.remoteCommand);
  }

  const sshParts = [executable, ...rcloneHardening(target), ...dest];
  let rcloneSshCommand = sshParts.map(quoteArg).join(' ');
  if (env?.SSH_ASKPASS) {
    // Prefix so rclone's external ssh child gets askpass without a TTY prompt
    if (process.platform === 'win32') {
      rcloneSshCommand = `cmd /c "set SSH_ASKPASS=${env.SSH_ASKPASS}&& set SSH_ASKPASS_REQUIRE=force&& set DISPLAY=${env.DISPLAY}&& ${sshParts
        .map((a) => (/\s/.test(a) ? `"${a}"` : a))
        .join(' ')}"`;
    } else {
      rcloneSshCommand = [
        'env',
        `SSH_ASKPASS=${quoteArg(env.SSH_ASKPASS)}`,
        'SSH_ASKPASS_REQUIRE=force',
        `DISPLAY=${quoteArg(env.DISPLAY)}`,
        ...sshParts.map(quoteArg),
      ].join(' ');
    }
  }

  return { executable, terminalArgs, rcloneSshCommand, env };
}

export function remoteCdCommand(remotePath: string): string {
  const escaped = remotePath.replace(/'/g, `'\\''`);
  return `cd '${escaped}' && exec "$SHELL" -l`;
}
