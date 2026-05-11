<p align="center">
  <img src="docs/images/logo.svg" alt="CaddyUI logo" width="96" height="96">
</p>

# CaddyUI

Manage your Caddyfile in a UI so you can stop speedrunning YAML-adjacent stress.

[![Stable release](https://img.shields.io/github/v/release/DrB0rk/CaddyUI?label=stable&sort=semver)](https://github.com/DrB0rk/CaddyUI/releases/latest)
[![Beta tag](https://img.shields.io/github/v/tag/DrB0rk/CaddyUI?filter=B_v*&label=beta&color=8b5cf6&sort=semver)](https://github.com/DrB0rk/CaddyUI/releases)
[![Last commit](https://img.shields.io/github/last-commit/DrB0rk/CaddyUI)](https://github.com/DrB0rk/CaddyUI/commits)
[![Stars](https://img.shields.io/github/stars/DrB0rk/CaddyUI?style=flat)](https://github.com/DrB0rk/CaddyUI/stargazers)

## ⚠️ Active development warning

CaddyUI is under active development.

- `main` = stable release lane
- `beta` = pre-release testing lane
- `dev` = fastest changes, least chill

Expect quick iteration, occasional breakage, and schema/behavior changes between versions.

## Quick install

### Stable
```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/CaddyUI/main/scripts/install.sh | bash
```

### Beta
```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/CaddyUI/beta/scripts/install.sh | bash
```

### Dev
```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/CaddyUI/dev/scripts/install.sh | bash
```

Installer prints your onboarding URL when done.  
Running the same command again = update mode.

> Yes, beta/dev can show `-dev` style app versions. That is intentional.

## What you get

- Proxy management (add, edit, disable/enable, delete)
- Middleware/snippet management
- Monaco editors for config + entries
- Caddy validate + reload
- Log viewer (files + `journalctl`)
- User auth + roles (`view`, `edit`, `admin`)
- Onboarding with Caddyfile/log discovery

## How it works

CaddyUI reads your configured `Caddyfile`, parses sites/proxies/imports, and shows them in the UI.
When you edit something, it writes the change back to the `Caddyfile`, validates it with `caddy validate`, and can reload Caddy.
It also reads Caddy logs, handles onboarding/auth/roles, and can update itself from the selected release channel (`stable`, `beta`, or `dev`).

## Looks like this

<p align="center">
  <img src="docs/images/screenshot.png" alt="CaddyUI screenshot" width="100%">
</p>

## Onboarding flow

1. Create admin user
2. Add setup token (if required)
3. Pick detected Caddyfile (or set path manually)
4. Pick detected log files (or add paths manually)

## UI pages

- **Proxies**: grouped view, search, sorting, imports, logging, tags, category
- **Middlewares**: create/edit/delete snippets
- **Configuration**: full raw Caddyfile editor
- **Logs**: Caddy logs in one place
- **Settings**: paths, scans, users, password, update channel

## Reverse proxy example

```caddyfile
caddyui.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## Links

- Repo: https://github.com/DrB0rk/CaddyUI
- Releases: https://github.com/DrB0rk/CaddyUI/releases
- Issues: https://github.com/DrB0rk/CaddyUI/issues
- Security policy: https://github.com/DrB0rk/CaddyUI/blob/main/docs/SECURITY.md
- Contributing: https://github.com/DrB0rk/CaddyUI/blob/main/docs/CONTRIBUTING.md
- Stable installer: https://raw.githubusercontent.com/DrB0rk/CaddyUI/main/scripts/install.sh
- Beta installer: https://raw.githubusercontent.com/DrB0rk/CaddyUI/beta/scripts/install.sh
- Dev installer: https://raw.githubusercontent.com/DrB0rk/CaddyUI/dev/scripts/install.sh

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/CaddyUI/main/scripts/uninstall.sh | bash
```

## Reset onboarding

```bash
sudo rm -rf /var/lib/caddyui
sudo systemctl restart caddyui
```
