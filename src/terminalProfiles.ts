import * as vscode from 'vscode';
import { tryLoadConfig } from './config';
import { log } from './log';
import { BetterSshService } from './service';
import { ensureHostKeyTrusted, diagnoseSshConnectFailure } from './ssh/hostKey';

const PROFILE_PREFIX = 'Better SSH: ';
const STATE_KEY = 'betterSsh.injectedTerminalProfiles';
const SSH_TERM_PREFIX = 'SSH: ';

function profilesSettingKey(): string {
  switch (process.platform) {
    case 'win32':
      return 'terminal.integrated.profiles.windows';
    case 'darwin':
      return 'terminal.integrated.profiles.osx';
    default:
      return 'terminal.integrated.profiles.linux';
  }
}

function injectEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('betterSsh')
    .get<boolean>('registerTerminalProfiles', true);
}

/**
 * Register the contributed terminal profile (shows as "Better SSH" in the profile list)
 * and optionally inject one named profile per remote into **workspace** terminal settings
 * so each remote appears under the New Terminal (+) dropdown for this window only.
 */
export function registerTerminalIntegration(
  context: vscode.ExtensionContext,
  service: BetterSshService
): void {
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('betterSsh.terminal', {
      async provideTerminalProfile() {
        const config = tryLoadConfig();
        if (!config || config.targets.length === 0) {
          throw new Error('No Better SSH / sftp.json remotes configured');
        }
        let target = config.targets[0];
        if (config.targets.length > 1) {
          const picked = await service.pickTargets(config, false);
          if (!picked?.[0]) {
            throw new Error('Cancelled');
          }
          target = picked[0];
        }
        await ensureHostKeyTrusted(target);
        return new vscode.TerminalProfile(service.terminalOptions(target, config.cdOnConnect));
      },
    })
  );

  // Injected dropdown profiles launch ssh directly — catch exit 255 host-key fails.
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((term) => {
      void handleClosedSshTerminal(term, service);
    })
  );

  const sync = () => {
    void syncInjectedProfiles(context, service);
  };
  sync();

  // Do not strip workspace profiles on deactivate — they belong to this
  // workspace and re-injecting/clearing on every window open/close thrash
  // .vscode/settings.json. Global leftovers are cleaned in syncInjectedProfiles.

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('betterSsh.registerTerminalProfiles') ||
        e.affectsConfiguration('betterSsh.sshPath')
      ) {
        sync();
      }
    })
  );
}

async function handleClosedSshTerminal(
  term: vscode.Terminal,
  service: BetterSshService
): Promise<void> {
  const code = term.exitStatus?.code;
  if (code !== 255) {
    return;
  }
  const name = term.name;
  if (!name.startsWith(SSH_TERM_PREFIX) && !name.startsWith(PROFILE_PREFIX)) {
    return;
  }
  const targetName = name.startsWith(SSH_TERM_PREFIX)
    ? name.slice(SSH_TERM_PREFIX.length)
    : name.slice(PROFILE_PREFIX.length);
  let config;
  try {
    config = service.requireConfig();
  } catch {
    return;
  }
  const target = config.targets.find((t) => t.name === targetName);
  if (!target) {
    return;
  }

  let trustedNew = false;
  try {
    trustedNew = await ensureHostKeyTrusted(target);
  } catch (e) {
    if (e instanceof Error) {
      log(`Host-key prompt after terminal exit: ${e.message}`);
    }
    return;
  }
  if (trustedNew) {
    const reopen = await vscode.window.showInformationMessage(
      `Host key trusted for ${target.name}. Reopen terminal?`,
      'Reopen'
    );
    if (reopen === 'Reopen') {
      await service.openTerminal(target, config.cdOnConnect);
    }
    return;
  }

  // Not a host-key issue — surface the real SSH error (auth, refused, …).
  const reason = await diagnoseSshConnectFailure(target);
  if (reason) {
    log(`SSH terminal ${target.name} failed: ${reason}`);
    void vscode.window.showErrorMessage(`${target.name}: ${reason}`);
  }
}

export async function syncInjectedProfiles(
  context: vscode.ExtensionContext,
  service: BetterSshService
): Promise<void> {
  // Old builds wrote profiles into user settings (shared by every window).
  // Strip those leftovers so Window A does not show Window B's remotes.
  await stripGlobalProfiles();

  if (!injectEnabled()) {
    await clearInjectedProfiles(context);
    return;
  }

  if (!vscode.workspace.workspaceFolders?.length) {
    await clearInjectedProfiles(context);
    return;
  }

  const config = tryLoadConfig();
  const key = profilesSettingKey();
  const section = vscode.workspace.getConfiguration();
  const inspect = section.inspect<Record<string, unknown>>(key);
  const existing = { ...(inspect?.workspaceValue ?? {}) };
  const previous = context.workspaceState.get<string[]>(STATE_KEY, []);

  for (const name of previous) {
    delete existing[name];
  }
  for (const name of Object.keys(existing)) {
    if (name.startsWith(PROFILE_PREFIX)) {
      delete existing[name];
    }
  }

  const injected: string[] = [];
  if (config) {
    for (const target of config.targets) {
      if (target.enabled === false) {
        continue;
      }
      const profileName = `${PROFILE_PREFIX}${target.name}`;
      const opts = service.terminalOptions(target, config.cdOnConnect);
      // Do not persist askpass env (secret file paths) into settings.json.
      // Password auth still works via “Open Terminal” which passes env ephemerally.
      existing[profileName] = {
        path: opts.shellPath,
        args: opts.shellArgs,
        icon: 'remote',
        overrideName: true,
      };
      injected.push(profileName);
    }
  }

  try {
    await section.update(
      key,
      Object.keys(existing).length > 0 ? existing : undefined,
      vscode.ConfigurationTarget.Workspace
    );
    await context.workspaceState.update(STATE_KEY, injected);
    if (injected.length) {
      log(`Registered terminal profiles (workspace settings): ${injected.join(', ')}`);
    }
  } catch (e) {
    log(
      `Could not write terminal profiles to workspace settings: ${
        e instanceof Error ? e.message : e
      }`
    );
  }
}

/** Remove Better SSH profiles previously written into user (global) settings. */
async function stripGlobalProfiles(): Promise<void> {
  const key = profilesSettingKey();
  const section = vscode.workspace.getConfiguration();
  const inspect = section.inspect<Record<string, unknown>>(key);
  const global = { ...(inspect?.globalValue ?? {}) };
  let changed = false;
  for (const name of Object.keys(global)) {
    if (name.startsWith(PROFILE_PREFIX)) {
      delete global[name];
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  try {
    await section.update(
      key,
      Object.keys(global).length > 0 ? global : undefined,
      vscode.ConfigurationTarget.Global
    );
    log('Removed Better SSH terminal profiles from user settings (multi-window fix)');
  } catch {
    /* ignore */
  }
}

async function clearInjectedProfiles(context: vscode.ExtensionContext): Promise<void> {
  const previous = context.workspaceState.get<string[]>(STATE_KEY, []);
  const key = profilesSettingKey();
  const section = vscode.workspace.getConfiguration();
  const inspect = section.inspect<Record<string, unknown>>(key);
  const existing = { ...(inspect?.workspaceValue ?? {}) };
  let changed = false;
  for (const name of [...previous, ...Object.keys(existing)]) {
    if (previous.includes(name) || name.startsWith(PROFILE_PREFIX)) {
      if (name in existing) {
        delete existing[name];
        changed = true;
      }
    }
  }
  if (changed) {
    try {
      await section.update(
        key,
        Object.keys(existing).length > 0 ? existing : undefined,
        vscode.ConfigurationTarget.Workspace
      );
    } catch {
      /* ignore */
    }
  }
  await context.workspaceState.update(STATE_KEY, []);
}
