#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="CaddyUI"
SCRIPT_CHANNEL="dev"
SCRIPT_VERSION="0.1.1"
REPO_URL="https://github.com/DrB0rk/CaddyUI.git"
BRANCH="${CADDYUI_BRANCH:-$SCRIPT_CHANNEL}"
RUN_USER="${SUDO_USER:-${USER:-caddyui}}"
IS_ROOT=0
[[ "${EUID:-$(id -u)}" -eq 0 ]] && IS_ROOT=1

if [[ "$IS_ROOT" -eq 1 ]]; then
  INSTALL_DIR="${CADDYUI_INSTALL_DIR:-/opt/caddyui}"
  DATA_DIR="${CADDY_UI_DATA_DIR:-/var/lib/caddyui}"
  LOG_DIR="${CADDYUI_LOG_DIR:-/var/log/caddyui}"
else
  INSTALL_DIR="${CADDYUI_INSTALL_DIR:-$HOME/.local/share/caddyui/app}"
  DATA_DIR="${CADDY_UI_DATA_DIR:-$HOME/.local/share/caddyui/data}"
  LOG_DIR="${CADDYUI_LOG_DIR:-$HOME/.local/share/caddyui/logs}"
fi

LOG_TARGET="$LOG_DIR/update.log"
APP_LOG="$LOG_DIR/caddyui.log"
SERVICE_NAME="caddyui"
DRY_RUN="${CADDYUI_DRY_RUN:-0}"

BLUE='\033[0;34m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

logo() {
  printf "%b\n" "${CYAN}"
  cat <<'ART'
   ______          __    __      __  ______
  / ____/___ _____/ /___/ /_  __/ / / /  _/
 / /   / __ `/ __  / __  / / / / / / // /  
/ /___/ /_/ / /_/ / /_/ / /_/ / /_/ // /   
\____/\__,_/\__,_/\__,_/\__, /\____/___/   
                        /____/             
ART
  printf "%b\n" "${NC}${BOLD}Updater${NC}"
  printf "%b\n" "version ${SCRIPT_VERSION}\n"
}

step() { printf "%b\n" "${BLUE}▶${NC} ${BOLD}$*${NC}"; }
ok() { printf "%b\n" "${GREEN}✓${NC} $*"; }
warn() { printf "%b\n" "${YELLOW}!${NC} $*"; }
fail() { printf "%b\n" "${RED}✗${NC} $*" >&2; exit 1; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }
sudo_cmd() { if [[ "$IS_ROOT" -eq 1 ]]; then "$@"; else sudo "$@"; fi }
run_quiet() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*" >> "$LOG_TARGET"
    return 0
  fi
  printf '\n$ %s\n' "$*" >> "$LOG_TARGET"
  "$@" >> "$LOG_TARGET" 2>&1
}
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }
systemd_available() { [[ "$(command -v systemctl || true)" != "" && -d /run/systemd/system ]]; }

start_with_systemd() {
  run_quiet systemctl daemon-reload
  run_quiet systemctl restart "$SERVICE_NAME"
}

start_with_nohup() {
  local runner="$INSTALL_DIR/start-caddyui.sh"
  if [[ ! -x "$runner" ]]; then
    cat > "$runner" <<RUNNER
#!/usr/bin/env bash
set -a
source "$INSTALL_DIR/.env"
set +a
cd "$INSTALL_DIR"
exec "$(command -v node)" server/index.js
RUNNER
    chmod +x "$runner"
  fi
  if [[ "$DRY_RUN" == "1" ]]; then return 0; fi
  if [[ -f "$INSTALL_DIR/caddyui.pid" ]]; then
    old_pid="$(cat "$INSTALL_DIR/caddyui.pid" 2>/dev/null || true)"
    if [[ -n "$old_pid" ]]; then kill "$old_pid" >/dev/null 2>&1 || true; fi
  fi
  nohup "$runner" >> "$APP_LOG" 2>&1 &
  echo $! > "$INSTALL_DIR/caddyui.pid"
}

wait_for_app() {
  if [[ "$DRY_RUN" == "1" ]]; then return 0; fi
  local port="$(awk -F= '$1=="CADDY_UI_PORT" {print $2}' "$INSTALL_DIR/.env" 2>/dev/null | tail -1)"
  port="${port:-8787}"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:$port/api/status" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  warn "Service did not answer yet. Check $APP_LOG"
}

logo
mkdir -p "$LOG_DIR"
: > "$LOG_TARGET"
step "Checking prerequisites"
need_cmd git
need_cmd node
need_cmd npm
ok "Required tools are available"
if [[ "$BRANCH" == "dev" ]]; then
  warn "Development branch. Not stable."
fi

[[ -d "$INSTALL_DIR/.git" ]] || fail "No existing CaddyUI install found at $INSTALL_DIR"

step "Updating source"
run_quiet git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
run_quiet git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
run_quiet git -C "$INSTALL_DIR" pull --ff-only --quiet origin "$BRANCH"
ok "Source updated"

step "Installing dependencies"
if [[ -f "$INSTALL_DIR/package-lock.json" ]]; then
  run_quiet npm --prefix "$INSTALL_DIR" ci
else
  run_quiet npm --prefix "$INSTALL_DIR" install
fi
ok "Dependencies installed"

step "Building web interface"
run_quiet npm --prefix "$INSTALL_DIR" run build
ok "Production build complete"

step "Restarting CaddyUI"
if systemd_available && { systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service" || [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; }; then
  start_with_systemd
  ok "Systemd service restarted"
else
  start_with_nohup
  ok "Background process restarted"
fi
wait_for_app

printf "\n%b\n" "${GREEN}${BOLD}CaddyUI updated.${NC}"
printf "%b\n" "Update log: $LOG_TARGET"
printf "%b\n" "App log:    $APP_LOG"
