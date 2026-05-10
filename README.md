# CaddyUI

Web UI for managing a Caddy `Caddyfile`.

CaddyUI includes proxy management, middleware/snippet management, Monaco editors, validation, reload, logs, user roles, and onboarding.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/CaddyUI/main/scripts/install.sh | bash
```

Open the URL printed by the installer.

`install.sh` is also used for updates.  
If CaddyUI is already installed, running the same install command updates and restarts it.

## Requirements

- Node.js 20+
- git
- npm
- curl
- access to the Caddyfile
- `caddy` in PATH for validation and reload

## First run

1. Create the admin user.
2. Enter setup token if required.
2. Select a detected Caddyfile or enter the path.
3. Select detected log files or add paths manually.

## Pages

- **Proxies**
  - grouped by domain
  - add/edit/delete
  - import multi-select
  - per-site logging selector (`none`, `default`, `stdout`, `stderr`, `file`)
  - quick search
- **Middlewares**
  - add/edit/delete snippets
  - Monaco editor
- **Configuration**
  - raw Caddyfile Monaco editor
- **Logs**
  - log viewer with line selector
- **Settings**
  - Caddyfile/log path settings
  - scan buttons for Caddyfiles and log files
  - user management (admin)
  - password change

## Roles

- `view`: read-only access
- `edit`: config/proxy/middleware/settings edits
- `admin`: full access, user management, in-app update

## Validate and reload

Global **Validate** and **Reload Caddy** buttons are in the top bar.

CaddyUI creates a backup before saving config changes.

## Reverse proxy example

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

## Force fresh install (skip auto-update mode)

```bash
CADDYUI_FORCE_INSTALL=1 curl -fsSL https://raw.githubusercontent.com/DrB0rk/CaddyUI/main/scripts/install.sh | bash
```
