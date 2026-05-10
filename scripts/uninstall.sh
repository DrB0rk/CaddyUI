#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="CaddyUI"
UNINSTALLER_VERSION="2026.05.10-1"
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
  printf "%b\n" "uninstaller ${UNINSTALLER_VERSION}\n"
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


find_caddyfiles() {
  local paths=(
    "${CADDYFILE_PATH:-}"
    "/etc/caddy/Caddyfile"
    "/config/Caddyfile"
    "/data/caddy/Caddyfile"
    "/srv/caddy/Caddyfile"
    "/usr/local/etc/caddy/Caddyfile"
  )
  printf '%s\n' "${paths[@]}" | awk 'NF && !seen[$0]++' | while read -r file; do
    [[ -f "$file" && -r "$file" ]] && printf '%s\n' "$file"
  done
}
valid_domain() {
  [[ "$1" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]
}
remove_proxy_block() {
  local file="$1"
  local host="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v target="$host" '
    BEGIN { skip=0; depth=0 }
    {
      line=$0
      trimmed=line
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", trimmed)
      if (!skip && trimmed == target " {") {
        skip=1
        depth=1
        next
      }
      if (skip) {
        opens=gsub(/\{/, "{", line)
        closes=gsub(/\}/, "}", line)
        depth += opens - closes
        if (depth <= 0) skip=0
        next
      }
      print $0
    }
  ' "$file" > "$tmp"
  if cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] remove proxy block %s from %s\n' "$host" "$file" >> "$LOG_TARGET"
    rm -f "$tmp"
    return 0
  fi
  if [[ -w "$file" ]]; then
    cp "$tmp" "$file"
  else
    sudo_cmd cp "$tmp" "$file"
  fi
  rm -f "$tmp"
  return 0
}
cleanup_caddy_proxy() {
  local files=() domain="${CADDYUI_PROXY_DOMAIN:-}" subdomain="${CADDYUI_PROXY_SUBDOMAIN:-caddyui}" host removed=0
  mapfile -t files < <(find_caddyfiles)
  [[ "${#files[@]}" -gt 0 ]] || { warn "No readable Caddyfile found for proxy cleanup."; return 0; }
  if [[ -z "$domain" ]]; then
    if [[ -r /dev/tty ]]; then
      read -r -p 'Domain for CaddyUI proxy cleanup: ' domain < /dev/tty
    elif [[ -t 0 ]]; then
      read -r -p 'Domain for CaddyUI proxy cleanup: ' domain
    fi
  fi
  valid_domain "$domain" || { warn "Skipping proxy cleanup."; return 0; }
  host="${subdomain}.${domain}"
  for file in "${files[@]}"; do
    if remove_proxy_block "$file" "$host"; then
      ok "Removed proxy: $host from $file"
      removed=1
    fi
  done
  if [[ "$removed" -eq 1 ]]; then
    if has_cmd caddy; then
      if confirm "Reload Caddy now?"; then
        if [[ "$DRY_RUN" == "1" ]]; then
          printf '[dry-run] caddy reload --config %s --adapter caddyfile\n' "${files[0]}" >> "$LOG_TARGET"
        else
          caddy reload --config "${files[0]}" --adapter caddyfile >> "$LOG_TARGET" 2>&1 || warn "Caddy reload failed."
        fi
      else
        warn "Reload Caddy manually."
      fi
    fi
  else
    ok "No CaddyUI proxy block found"
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

step "Removing CaddyUI proxy"
cleanup_caddy_proxy

printf "\n%b\n" "${GREEN}${BOLD}CaddyUI removed.${NC}"
printf "%b\n" "Uninstall log: $LOG_TARGET"
