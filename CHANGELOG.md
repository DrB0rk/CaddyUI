# Changelog

## 0.2.0 - 2026-05-11

### Added
- Stable release of runtime version-sync improvements and sidebar feedback shortcut.

### Changed
- Version badge updates now follow runtime status during and after updates.
- Stable installer channel default is set to `main`.

## 0.2.0-beta - 2026-05-11

### Added
- Sidebar feedback shortcut that opens GitHub issue creation.

### Changed
- Header and sidebar version badges now prefer runtime version data during update flow.
- Update completion message and UI version state are synchronized before reload.
- Beta installer channel default now points to `beta`.

## 0.1.8 - 2026-05-11

### Added
- Stable release of the latest proxy/mobile/update improvements from the beta lane.

### Changed
- Installer default channel on `main` now targets `main`.
- Tags and category metadata are stored in SQLite instead of Caddyfile comments.
- Update UX now keeps an updating screen visible until the new version is actually ready.
- Mobile proxy row layout improved for better readability and action-button access.

### Security
- Changing the configured Caddyfile path now requires `admin` permission.

## 0.1.8-beta - 2026-05-11

### Added
- Full-screen update progress overlay that stays visible until the new app version is ready.
- SQLite-backed proxy metadata table for tags and categories.

### Changed
- Tags and category are no longer written into Caddyfile comments for proxy create/edit.
- Proxy rows on mobile now use a clearer label/value layout with more reliable action button visibility.

### Fixed
- Update flow now waits for branch/commit/version readiness checks before reporting success.

## 0.1.7-beta - 2026-05-11

### Added
- Beta build with latest dev updates for proxy management, settings, and security controls.

### Changed
- README stable badge now tracks stable `v*` tags only.
- Tag autocomplete now continues suggestions after commas.
- Beta package version now reports `0.1.7-beta`.

## 0.1.5-dev - 2026-05-11

### Added
- Security settings in the Settings page:
  - trusted proxy hops
  - cookie mode (`auto`, `secure`, `insecure`)
  - allow remote first-time setup toggle
  - additional allowed origins list

### Changed
- Security-related runtime behavior now follows saved settings without requiring env-only configuration.
- Settings and status API responses now include security configuration fields.

### Security
- Editing security settings now requires `admin` permission.
- Trusted forward headers are only used when trusted proxy hops are enabled.

## 0.1.4 - 2026-05-11

### Added
- SQLite file database for settings/session state and parsed config cache.
- Proxy category support (single category per proxy).
- Proxies view mode switcher (sections by domain or by category).
- Dynamic while-typing autocomplete for proxy category and tags.

### Changed
- Proxy sorting moved to clickable table headers with direction indicators.
- Default proxy sorting set to host A-Z.
- Proxies table column naming and layout consistency updates.

### Fixed
- View selector alignment/spacing in the proxies toolbar.
- Top-level feedback visibility via fixed header popup.

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
