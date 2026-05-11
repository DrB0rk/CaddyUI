# Changelog

## 0.1.3 - 2026-05-11

### Added
- Mobile layout with bottom navigation.
- Log source selector with `journalctl -u caddy` support.
- Settings scan buttons for Caddyfiles and log files.
- Per-proxy logging selector (`none`, `default`, `stdout`, `stderr`, `file`).

### Changed
- Frontend split into smaller page/component files.
- Middleware editor now uses automatic indentation handling.
- Installer now doubles as updater when CaddyUI is already installed.
- Script versioning separated from app versioning.

### Fixed
- Proxy action buttons clipping/disappearing on narrower displays.
- Monaco CSP/style loading and editor rendering issues.
- Proxy health state drift after proxy mutations.

### Security
- Added username format validation.
- Added password length bounds and validation consistency.
- Prevented deletion/demotion of the last admin user.
- Bounded log line query size on logs API.

## 0.1.1 - 2026-05-10

### Added
- Installer, updater, and uninstaller scripts.
- Optional Caddy reverse proxy setup during install.
- Optional proxy cleanup during uninstall.
- Setup token support for first-run account creation.
- Local test mode for frontend work.
- Proxy and middleware create, edit, and delete actions.
- Search for configured proxies.
- Proxy health checks for local upstreams.
- Raw proxy block editor inside proxy edit.

### Changed
- Split onboarding into account setup and Caddy config steps.
- Proxies view uses grouped full-width rows.
- Import selection uses a multi-select dropdown.
- Theme updated with dark/light mode and grayscale base styling.
- Header shows app version.
- Scripts print their version.

### Fixed
- Production server startup route handling.
- Proxy import placement for snippets like `pass_host_header`.
- Login flow when setup is complete but the session is missing.
- Cookie handling for direct HTTP onboarding before HTTPS proxying.
- Installer domain detection and manual domain fallback.

### Security
- Stronger cookie settings.
- Required production secret.
- Login rate limiting.
- Origin checks on write actions.
- Revocable JWT sessions.
- Log path allowlist.
- Basic CSP and security headers.
- Pinned dependency versions.
