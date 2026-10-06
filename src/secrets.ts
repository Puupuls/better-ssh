import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  BetterSshConfig,
  TargetConfig,
  configUri,
  serializeBetterSshConfig,
} from './config';
import {
  applyCachedSecrets,
  deleteCachedTargetSecrets,
  pruneCachedTargetSecrets,
  setCachedTargetSecrets,
} from './credentialCache';
import { log } from './log';

export { applyCachedSecrets } from './credentialCache';

let secrets: vscode.SecretStorage | undefined;

export function configureSecrets(store: vscode.SecretStorage): void {
  secrets = store;
}

function passwordKey(targetName: string): string {
  return `betterSsh.target.${targetName}.password`;
}

function passphraseKey(targetName: string): string {
  return `betterSsh.target.${targetName}.passphrase`;
}

/**
 * Merge SecretStorage into targets. Plaintext password/passphrase from JSON
 * are migrated into SecretStorage; better-ssh.json is rewritten without them.
 */
export async function hydrateConfigSecrets(config: BetterSshConfig): Promise<void> {
  if (!secrets) {
    applyCachedSecrets(config.targets);
    return;
  }

  let migratedFromFile = false;

  for (const target of config.targets) {
    const fromFilePassword = target.password;
    const fromFilePassphrase = target.passphrase;

    if (fromFilePassword) {
      await secrets.store(passwordKey(target.name), fromFilePassword);
      if (config.source === 'better-ssh.json') {
        migratedFromFile = true;
      }
    } else {
      target.password = (await secrets.get(passwordKey(target.name))) || undefined;
    }

    if (fromFilePassphrase) {
      await secrets.store(passphraseKey(target.name), fromFilePassphrase);
      if (config.source === 'better-ssh.json') {
        migratedFromFile = true;
      }
    } else {
      target.passphrase = (await secrets.get(passphraseKey(target.name))) || undefined;
    }

    setCachedTargetSecrets(target.name, {
      password: target.password,
      passphrase: target.passphrase,
    });
  }

  pruneCachedTargetSecrets(config.targets.map((t) => t.name));

  if (migratedFromFile && config.source === 'better-ssh.json') {
    const uri = configUri();
    if (uri && fs.existsSync(uri.fsPath)) {
      fs.writeFileSync(uri.fsPath, serializeBetterSshConfig(config), 'utf8');
      log(
        'Moved plaintext password/passphrase from better-ssh.json into VS Code SecretStorage'
      );
      void vscode.window.showInformationMessage(
        'Better SSH: passwords moved from better-ssh.json into secure storage (removed from the file).'
      );
    }
  }
}

/** Store secrets for targets when generating better-ssh.json from sftp.json. */
export async function storeTargetSecrets(targets: TargetConfig[]): Promise<void> {
  if (!secrets) {
    return;
  }
  for (const target of targets) {
    if (target.password) {
      await secrets.store(passwordKey(target.name), target.password);
    }
    if (target.passphrase) {
      await secrets.store(passphraseKey(target.name), target.passphrase);
    }
    setCachedTargetSecrets(target.name, {
      password: target.password,
      passphrase: target.passphrase,
    });
  }
}

export async function deleteTargetSecrets(targetName: string): Promise<void> {
  if (!secrets) {
    return;
  }
  await secrets.delete(passwordKey(targetName));
  await secrets.delete(passphraseKey(targetName));
  deleteCachedTargetSecrets(targetName);
}
