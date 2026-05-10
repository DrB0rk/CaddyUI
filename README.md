# CaddyUI

Web UI for managing a Caddy `Caddyfile`.

CaddyUI shows reverse proxies, snippets, the raw config editor, validation, reload, and logs.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/CaddyUI/main/scripts/install.sh | bash
```

Open the URL printed by the installer. The installer can also add a Caddy reverse proxy entry for CaddyUI.

## Requirements

- Node.js 20+
- git
- npm
- curl
- access to the Caddyfile
- `caddy` in PATH for validation and reload

## First run

1. Create the admin user.
2. Select a detected Caddyfile or enter the path.
3. Select detected log files or add paths manually.

## Pages

- **Proxies**: reverse proxies and quick proxy creation
- **Middlewares**: snippets and imports
- **Configuration**: raw Caddyfile editor
- **Logs**: Caddy logs
- **Settings**: Caddyfile and log paths

Edit flow: edit, validate, save, reload.

CaddyUI creates a backup before saving.

## Reverse proxy

```caddyfile
caddyui.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## Reset onboarding

```bash
sudo rm -rf /var/lib/caddyui
sudo systemctl restart caddyui
```


## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/CaddyUI/main/scripts/uninstall.sh | bash
```


## Update

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/CaddyUI/main/scripts/update.sh | bash
```
