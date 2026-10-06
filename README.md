# Better SSH

Fast multi-target SFTP sync for VS Code / Cursor, powered by [rclone](https://rclone.org/). Inspired by [vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), with multi-server fan-out, ProxyJump hopping, local↔remote diff, and one-click SSH terminals.

## Requirements

- OpenSSH `ssh` client (or set `betterSsh.sshPath`)
- **rclone** — optional. Resolution order:
  1. `betterSsh.rclonePath` if set
  2. `rclone` on `PATH`
  3. Auto-download a pinned release into extension storage on first use (SHA-256 verified)

## Install

Search **Better SSH** (`puupuls.better-ssh`) in the Extensions view, or:

- **VS Code:** [marketplace.visualstudio.com](https://marketplace.visualstudio.com/items?itemName=puupuls.better-ssh)
- **Cursor / Open VSX:** [open-vsx.org/extension/puupuls/better-ssh](https://open-vsx.org/extension/puupuls/better-ssh)
- **VSIX:** [GitHub Releases](https://github.com/Puupuls/better-ssh/releases) → **Extensions: Install from VSIX…**

## Quick start

1. Open a workspace folder.
2. Either:
   - Command Palette → **Better SSH: Config** (creates `.vscode/better-ssh.json`), or
   - Keep an existing vscode-sftp **`.vscode/sftp.json`** (loaded automatically; `better-ssh.json` wins if both exist).
3. Open the **Better SSH** activity-bar icon, or run **Better SSH: Show Remotes**.
4. Upload / diff / **Open Terminal**.

## Remote Explorer

The **Remotes** view lives in the **Better SSH** activity bar (not the native file explorer).

- **View: Show Better SSH** or **Better SSH: Show Remotes**
- Expand a target to browse remote files (via rclone)
- Click a text/image file to **preview** (read-only; cached locally)
- Right-click → **Download from Remote** / **Delete on Remote**
- Right-click a target root → **Open Terminal (Target)**

Empty view: create config, or ensure `.vscode/sftp.json` is valid SFTP (FTP entries are skipped).

## Config

`.vscode/better-ssh.json` example:

```json
{
  "uploadOnSave": true,
  "cdOnConnect": true,
  "transfers": 16,
  "checkers": 32,
  "defaultTargets": ["*"],
  "ignore": [".venv", "node_modules/", "secrets/"],
  "targets": [
    {
      "name": "prod",
      "host": "example.com",
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
```

- **`ignore`**: globs skipped on upload-on-save, sync, and folder-upload children. Explicit Upload of an ignored path still goes through (like vscode-sftp). New configs get a starter list (`.git`, `.vscode`, `.cursor`, `*.code-workspace`, …).
- **`defaultTargets`**: names for upload-on-save / default uploads. Use `["*"]` for all.
- **`sshConfigHost`**: preferred — uses `~/.ssh/config` (ProxyJump, IdentityFile, etc.).
- **`hop`**: ProxyJump list when not using `sshConfigHost`.

### Multi-context (separate local folders)

Each target can own a local subdirectory via `context`. Saves under that folder only upload to that target.

```json
{
  "uploadOnSave": true,
  "targets": [
    {
      "name": "frontend",
      "context": "apps/web",
      "host": "web.example.com",
      "username": "deploy",
      "remotePath": "/var/www/web"
    },
    {
      "name": "api",
      "context": "apps/api",
      "host": "api.example.com",
      "username": "deploy",
      "remotePath": "/var/www/api"
    }
  ]
}
```

`sftp.json` array entries with `context` map automatically.

## Commands

| Command | What it does |
|---------|----------------|
| Better SSH: Config | Create / open `better-ssh.json` |
| Upload Active File | Upload to default targets (parallel) |
| Download Active File | Pick a target and download |
| Diff Active File with Remote | Fetch remote copy and open VS Code diff |
| Sync Local → Remote / Remote → Local | Folder sync via rclone |
| Check Local vs Remote | rclone check report (Output channel) |
| Open Terminal | Interactive SSH (optional `cd` to `remotePath`) |
| Show Remotes | Focus the Remotes view |

Remotes also appear under the terminal **+** dropdown as `Better SSH: <name>`, plus a **Better SSH** profile (written into workspace settings so windows stay independent). Disable with `betterSsh.registerTerminalProfiles`.

Context menus on Explorer files/folders and on Remotes tree roots (Open Terminal).

## How it works

The extension starts a local **`rclone rcd`** daemon and drives transfers over the [rclone RC API](https://rclone.org/rc/). Remotes are created dynamically with an external `ssh` command so hopping matches your terminal sessions. If rclone is missing from `PATH`, a pinned release is downloaded once into extension storage (checksum-verified).

Interactive shells use the same SSH argv builder (`createTerminal` + system `ssh`) — not VS Code Remote-SSH.

## Migrating from vscode-sftp

No migration needed for day-to-day use — if `.vscode/sftp.json` exists and there is no `better-ssh.json`, Better SSH loads it (including `profiles`, multi-context arrays, and `hop`). While `sftp.json` is present, vscode-sftp’s usual ignores are merged (`.vscode`, `.git`, `.DS_Store`, and `sftp.json` itself).

Optional: create `better-ssh.json` for multi-target fan-out and rclone tuning. When both files exist, **`better-ssh.json` takes precedence**.

| sftp.json | better-ssh.json |
|-----------|-----------------|
| `host` / `port` / `username` | same |
| `remotePath` | same |
| `privateKeyPath` | same |
| `hop` (object/array) | mapped to ProxyJump `hop[]` + final `host` |
| `profiles` / multi-context | multiple `targets` |
| `defaultProfile` | `defaultTargets` |

Passwords / passphrases in JSON are migrated into VS Code SecretStorage on load and stripped from the file. Prefer keys or ssh-agent; avoid committing secrets.

## Settings

- `betterSsh.rclonePath` — default `rclone` (PATH, else managed download)
- `betterSsh.sshPath` — default `ssh`
- `betterSsh.debug` — verbose Output channel logs
- `betterSsh.registerTerminalProfiles` — inject per-target profiles into the Terminal **+** menu (default `true`)

Config `transfers` / `checkers` (default **16** / **32**) control rclone file parallelism. Multiple selected folders sync in parallel; multi-select uploads run up to 8 at once.

## Develop

```bash
npm install
npm run watch
```

Then **Run Extension** from a VS Code / Cursor Extension Development Host, or:

```bash
npm run build
npm run package
```

## License

MIT
