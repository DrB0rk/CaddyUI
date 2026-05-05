#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="CaddyUI"
SCRIPT_VERSION="2026.05.05-2"
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

SERVICE_NAME="caddyui"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
DRY_RUN="${CADDYUI_DRY_RUN:-0}"
LOG_TARGET="${LOG_DIR}/uninstall.log"

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
  printf "%b\n" "${NC}${BOLD}Uninstall${NC}"
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
confirm() {
  local prompt="$1"
  local answer=""
  if [[ "${CADDYUI_ASSUME_YES:-0}" == "1" ]]; then return 0; fi
  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt [y/N] " answer < /dev/tty
  elif [[ -t 0 ]]; then
    read -r -p "$prompt [y/N] " answer
  else
    fail "Missing interactive terminal. Re-run with CADDYUI_ASSUME_YES=1 to continue."
  fi
  [[ "$answer" =~ ^[Yy]$|^[Yy][Ee][Ss]$ ]]
}
systemd_available() { [[ "$(command -v systemctl || true)" != "" && -d /run/systemd/system ]]; }

stop_background_process() {
  if [[ -f "$INSTALL_DIR/caddyui.pid" ]]; then
    local pid
    pid="$(cat "$INSTALL_DIR/caddyui.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      if [[ "$DRY_RUN" == "1" ]]; then
        printf '[dry-run] kill %s\n' "$pid" >> "$LOG_TARGET"
      else
        kill "$pid" >/dev/null 2>&1 || true
      fi
    fi
  fi
}

remove_path() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] rm -rf %s\n' "$target" >> "$LOG_TARGET"
    return 0
  fi
  if [[ -w "$target" || -w "$(dirname "$target")" ]]; then
    rm -rf "$target"
  else
    sudo_cmd rm -rf "$target"
  fi
}

logo
mkdir -p "$LOG_DIR"
: > "$LOG_TARGET"
step "Confirming uninstall"
confirm "Remove CaddyUI, its data, logs, and service?" || fail "Uninstall cancelled."
ok "Continuing"

step "Stopping service"
if systemd_available && { systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service" || [[ -f "$SERVICE_FILE" ]]; }; then
  run_quiet sudo_cmd systemctl disable --now "$SERVICE_NAME"
  run_quiet sudo_cmd systemctl daemon-reload
  ok "Service stopped"
else
  stop_background_process
  ok "Background process stopped"
fi

step "Removing service file"
if [[ -f "$SERVICE_FILE" ]]; then
  remove_path "$SERVICE_FILE"
  if systemd_available; then run_quiet sudo_cmd systemctl daemon-reload; fi
  ok "Service file removed"
else
  ok "No service file found"
fi

step "Removing files"
remove_path "$INSTALL_DIR"
remove_path "$DATA_DIR"
remove_path "$LOG_DIR"
ok "Files removed"

warn "Caddyfile entries were not changed. Remove any CaddyUI reverse proxy blocks manually if needed."
printf "\n%b\n" "${GREEN}${BOLD}CaddyUI removed.${NC}"
printf "%b\n" "Uninstall log: $LOG_TARGET"
