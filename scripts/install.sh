#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="CaddyUI"
SCRIPT_VERSION="2026.05.05-6"
REPO_URL="https://github.com/DrB0rk/CaddyUI.git"
BRANCH="${CADDYUI_BRANCH:-main}"
START_PORT="${CADDYUI_PORT:-8787}"
PORT_SCAN_LIMIT="${CADDYUI_PORT_SCAN_LIMIT:-100}"
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

INSTALL_LOG="$LOG_DIR/install.log"
APP_LOG="$LOG_DIR/caddyui.log"
SERVICE_NAME="caddyui"
DRY_RUN="${CADDYUI_DRY_RUN:-0}"
PENDING_CADDY_RELOAD=0
PENDING_PROXY_HOST=""
PENDING_CADDYFILE=""

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
  printf "%b\n" "${NC}${BOLD}Automated installer${NC}"
  printf "%b\n" "version ${SCRIPT_VERSION}\n"
}

step() { printf "%b\n" "${BLUE}▶${NC} ${BOLD}$*${NC}"; }
ok() { printf "%b\n" "${GREEN}✓${NC} $*"; }
warn() { printf "%b\n" "${YELLOW}!${NC} $*"; }
fail() { printf "%b\n" "${RED}✗${NC} $*" >&2; exit 1; }
run_quiet() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*" >> "$INSTALL_LOG"
    return 0
  fi
  printf '\n$ %s\n' "$*" >> "$INSTALL_LOG"
  "$@" >> "$INSTALL_LOG" 2>&1
}
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }
confirm() {
  local prompt="$1"
  local default="${2:-no}"
  local answer=""
  local suffix="[y/N]"
  [[ "$default" == "yes" ]] && suffix="[Y/n]"
  if [[ "${CADDYUI_ASSUME_YES:-0}" == "1" ]]; then return 0; fi
  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt $suffix " answer < /dev/tty
  elif [[ -t 0 ]]; then
    read -r -p "$prompt $suffix " answer
  else
    fail "Missing interactive terminal. Re-run with CADDYUI_ASSUME_YES=1 to accept prompts automatically."
  fi
  if [[ -z "$answer" ]]; then [[ "$default" == "yes" ]]; return; fi
  [[ "$answer" =~ ^[Yy]$|^[Yy][Ee][Ss]$ ]]
}
sudo_cmd() {
  if [[ "$IS_ROOT" -eq 1 ]]; then "$@"; else sudo "$@"; fi
}
detect_package_manager() {
  if has_cmd apt-get; then echo apt; return; fi
  if has_cmd dnf; then echo dnf; return; fi
  if has_cmd yum; then echo yum; return; fi
  if has_cmd pacman; then echo pacman; return; fi
  if has_cmd zypper; then echo zypper; return; fi
  if has_cmd apk; then echo apk; return; fi
  if has_cmd brew; then echo brew; return; fi
  echo none
}
install_system_packages() {
  local pm="$1"; shift
  local packages=("$@")
  case "$pm" in
    apt)
      run_quiet sudo_cmd apt-get update -y
      run_quiet sudo_cmd apt-get install -y "${packages[@]}"
      ;;
    dnf) run_quiet sudo_cmd dnf install -y "${packages[@]}" ;;
    yum) run_quiet sudo_cmd yum install -y "${packages[@]}" ;;
    pacman) run_quiet sudo_cmd pacman -Sy --noconfirm "${packages[@]}" ;;
    zypper) run_quiet sudo_cmd zypper --non-interactive install "${packages[@]}" ;;
    apk) run_quiet sudo_cmd apk add --no-cache "${packages[@]}" ;;
    brew) run_quiet brew install "${packages[@]}" ;;
    *) fail "No supported package manager found. Install missing dependencies manually." ;;
  esac
}
check_and_install_prerequisites() {
  local missing=()
  local pm packages=()
  has_cmd git || missing+=(git)
  has_cmd curl || missing+=(curl)
  has_cmd node || missing+=(node)
  has_cmd npm || missing+=(npm)

  if [[ "${#missing[@]}" -gt 0 ]]; then
    warn "Missing dependencies: ${missing[*]}"
    confirm "Install missing dependencies now?" || fail "Install cancelled. Missing: ${missing[*]}"
    pm="$(detect_package_manager)"
    if [[ "$IS_ROOT" -ne 1 && "$pm" != "brew" ]] && ! has_cmd sudo; then
      fail "sudo is required to install system dependencies. Install sudo or run this installer as root."
    fi
    case "$pm" in
      apt|dnf|yum|zypper) for dep in "${missing[@]}"; do [[ "$dep" == node ]] && packages+=(nodejs) || packages+=("$dep"); done ;;
      pacman|apk|brew) for dep in "${missing[@]}"; do [[ "$dep" == node || "$dep" == npm ]] && packages+=(nodejs npm) || packages+=("$dep"); done ;;
      *) fail "No supported package manager found. Install missing dependencies manually: ${missing[*]}" ;;
    esac
    mapfile -t packages < <(printf '%s\n' "${packages[@]}" | awk 'NF && !seen[$0]++')
    install_system_packages "$pm" "${packages[@]}"
  fi

  need_cmd git
  need_cmd curl
  need_cmd node
  need_cmd npm
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$NODE_MAJOR" -lt 20 ]]; then
    warn "Node.js 20+ is required. Found $(node -v)."
    confirm "Try to upgrade/install Node.js with the system package manager?" || fail "Node.js 20+ is required."
    pm="$(detect_package_manager)"
    case "$pm" in
      apt)
        run_quiet sudo_cmd apt-get update -y
        run_quiet sudo_cmd apt-get install -y ca-certificates curl gnupg
        if [[ "$DRY_RUN" != "1" ]]; then
          curl -fsSL https://deb.nodesource.com/setup_22.x | sudo_cmd bash - >> "$INSTALL_LOG" 2>&1
        else
          printf '[dry-run] curl -fsSL https://deb.nodesource.com/setup_22.x | bash\n' >> "$INSTALL_LOG"
        fi
        run_quiet sudo_cmd apt-get install -y nodejs
        ;;
      dnf|yum) install_system_packages "$pm" nodejs npm ;;
      pacman|apk|zypper|brew) install_system_packages "$pm" nodejs npm ;;
      *) fail "No supported package manager found for Node.js upgrade." ;;
    esac
    NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    [[ "$NODE_MAJOR" -ge 20 ]] || fail "Node.js 20+ is still not available after install attempt. Found $(node -v)."
  fi
}

listen_check() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${port}$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
  else
    (echo > "/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
  fi
}
find_free_port() {
  local port="$START_PORT"
  local max=$((START_PORT + PORT_SCAN_LIMIT))
  while [[ "$port" -le "$max" ]]; do
    if ! listen_check "$port"; then echo "$port"; return 0; fi
    port=$((port + 1))
  done
  fail "No free TCP port found from $START_PORT to $max"
}
primary_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [[ -z "$ip" ]] && command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
  fi
  [[ -n "$ip" ]] && echo "$ip" || echo "127.0.0.1"
}
write_env() {
  cat > "$INSTALL_DIR/.env" <<ENV
NODE_ENV=production
CADDY_UI_PORT=$PORT
CADDY_UI_DATA_DIR=$DATA_DIR
CADDY_UI_SECRET=$SECRET
CADDY_UI_SETUP_TOKEN=$SETUP_TOKEN_VALUE
ENV
  chmod 600 "$INSTALL_DIR/.env" || true
  if [[ "$IS_ROOT" -eq 1 ]]; then chown "$RUN_USER":"$RUN_USER" "$INSTALL_DIR/.env" 2>/dev/null || true; fi
}
systemd_available() { [[ "$(command -v systemctl || true)" != "" && -d /run/systemd/system ]]; }
want_systemd_service() {
  if ! systemd_available; then return 1; fi
  if [[ "${CADDYUI_SYSTEMD:-}" == "1" ]]; then return 0; fi
  if [[ "${CADDYUI_SYSTEMD:-}" == "0" ]]; then return 1; fi
  confirm "Install CaddyUI as a systemd service so it auto-starts after reboot?" yes
}
start_with_systemd() {
  local service_path="/etc/systemd/system/${SERVICE_NAME}.service"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] write %s\n' "$service_path" >> "$INSTALL_LOG"
    return 0
  fi
  cat > "$service_path" <<SERVICE
[Unit]
Description=CaddyUI web interface
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=5
StandardOutput=append:$APP_LOG
StandardError=append:$APP_LOG

[Install]
WantedBy=multi-user.target
SERVICE
  run_quiet systemctl daemon-reload
  run_quiet systemctl enable "$SERVICE_NAME"
  run_quiet systemctl restart "$SERVICE_NAME"
}
start_with_nohup() {
  local runner="$INSTALL_DIR/start-caddyui.sh"
  cat > "$runner" <<RUNNER
#!/usr/bin/env bash
set -a
source "$INSTALL_DIR/.env"
set +a
cd "$INSTALL_DIR"
exec "$(command -v node)" server/index.js
RUNNER
  chmod +x "$runner"
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
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  warn "Service did not answer yet. Check $APP_LOG"
}

read_tty() {
  local prompt="$1"
  local answer=""
  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt" answer < /dev/tty
  elif [[ -t 0 ]]; then
    read -r -p "$prompt" answer
  else
    return 1
  fi
  printf '%s' "$answer"
}
valid_domain() {
  [[ "$1" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]
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
extract_domains() {
  local file="$1"
  sed -nE 's/^[[:space:]]*([^#][^{]*)\{[[:space:]]*$/\1/p' "$file" \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s#^https?://##; s/:.*$//' \
    | grep -E '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' \
    | awk 'NF && $0 !~ /^\(/ && !seen[$0]++'
}
base_domain() {
  local host="$1"
  awk -F. '{ if (NF>=2) print $(NF-1) "." $NF; else print $0 }' <<< "$host"
}
choose_proxy_target() {
  local files=()
  local options=()
  local file host domain answer index subdomain manual_domain explicit_domain
  mapfile -t files < <(find_caddyfiles)
  if [[ "${#files[@]}" -eq 0 ]]; then
    printf "%b\n" "${YELLOW}!${NC} No readable Caddyfile found for reverse proxy setup." >&2
    return 1
  fi
  if [[ -n "${CADDYUI_PROXY_DOMAIN:-}" ]]; then
    explicit_domain="${CADDYUI_PROXY_DOMAIN}"
    valid_domain "$explicit_domain" || return 1
    subdomain="${CADDYUI_PROXY_SUBDOMAIN:-caddyui}"
    echo "${files[0]}|${explicit_domain}|$subdomain"
    return 0
  fi
  for file in "${files[@]}"; do
    while read -r host; do
      [[ -n "$host" ]] || continue
      domain="$(base_domain "$host")"
      [[ -n "$domain" ]] && options+=("$file|$domain")
    done < <(extract_domains "$file")
  done
  if [[ "${#options[@]}" -eq 0 ]]; then
    printf "%b\n" "${YELLOW}!${NC} No domains found in detected Caddyfiles." >&2
    if [[ "${CADDYUI_PROXY:-}" == "0" ]]; then return 1; fi
    manual_domain="$(read_tty "Domain: " || true)"
    valid_domain "$manual_domain" || return 1
    subdomain="$(read_tty "Subdomain [caddyui]: " || true)"
    subdomain="${subdomain:-caddyui}"
    echo "${files[0]}|${manual_domain}|$subdomain"
    return 0
  fi
  mapfile -t options < <(printf '%s\n' "${options[@]}" | awk 'NF && !seen[$0]++')
  printf "%b\n" "${BLUE}▶${NC} ${BOLD}Caddy reverse proxy${NC}" >&2
  printf 'Detected Caddyfiles:\n' >&2
  for file in "${files[@]}"; do
    printf '  - %s\n' "$file" >&2
  done
  printf 'Choose domain:\n' >&2
  for i in "${!options[@]}"; do
    printf '  %s) %s\n' "$((i+1))" "${options[$i]#*|}" >&2
  done
  printf '  m) manual domain\n' >&2
  if [[ "${CADDYUI_PROXY:-}" == "0" ]]; then return 1; fi
  if [[ "${CADDYUI_PROXY:-}" == "1" ]]; then
    subdomain="${CADDYUI_PROXY_SUBDOMAIN:-caddyui}"
    echo "${options[0]}|$subdomain"
    return 0
  fi
  answer="$(read_tty "Add a Caddy reverse proxy entry? [1]: " || true)"
  answer="${answer:-1}"
  if [[ "$answer" == "m" || "$answer" == "M" ]]; then
    manual_domain="$(read_tty "Domain: " || true)"
    valid_domain "$manual_domain" || return 1
    subdomain="$(read_tty "Subdomain [caddyui]: " || true)"
    subdomain="${subdomain:-caddyui}"
    echo "${files[0]}|${manual_domain}|$subdomain"
    return 0
  fi
  [[ "$answer" =~ ^[0-9]+$ ]] || return 1
  index=$((answer-1))
  [[ "$index" -ge 0 && "$index" -lt "${#options[@]}" ]] || return 1
  subdomain="$(read_tty "Subdomain [caddyui]: " || true)"
  subdomain="${subdomain:-caddyui}"
  echo "${options[$index]}|$subdomain"
}
write_caddyfile() {
  local file="$1"
  local content="$2"
  if [[ -w "$file" ]]; then
    printf '%s\n' "$content" >> "$file"
  else
    printf '%s\n' "$content" | sudo_cmd tee -a "$file" >/dev/null
  fi
}
copy_caddyfile() {
  local from="$1"
  local to="$2"
  if [[ -r "$from" && -w "$(dirname "$to")" ]]; then
    cp "$from" "$to"
  else
    sudo_cmd cp "$from" "$to"
  fi
}
setup_caddy_proxy() {
  local target file domain_sub domain subdomain host block backup validation
  target="$(choose_proxy_target || true)"
  [[ -n "$target" ]] || { ok "Caddy reverse proxy skipped"; return 0; }
  file="${target%%|*}"
  domain_sub="${target#*|}"
  domain="${domain_sub%%|*}"
  subdomain="${domain_sub#*|}"
  host="${subdomain}.${domain}"
  if grep -Eq "^[[:space:]]*$host[[:space:]]*\{" "$file"; then
    ok "Caddy reverse proxy already exists: $host"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    ok "Would add Caddy reverse proxy: $host"
    return 0
  fi
  block="
$host {
    reverse_proxy 127.0.0.1:$PORT
}"
  backup="$file.caddyui.$(date +%Y%m%d%H%M%S).bak"
  copy_caddyfile "$file" "$backup"
  write_caddyfile "$file" "$block"
  if has_cmd caddy; then
    validation="$(caddy validate --config "$file" --adapter caddyfile 2>&1 || true)"
    if [[ -n "$validation" ]]; then printf '%s\n' "$validation" >> "$INSTALL_LOG"; fi
    if ! caddy validate --config "$file" --adapter caddyfile >> "$INSTALL_LOG" 2>&1; then
      copy_caddyfile "$backup" "$file"
      warn "Caddy validation failed. Restored backup."
      return 0
    fi
    PENDING_CADDY_RELOAD=1
    PENDING_PROXY_HOST="$host"
    PENDING_CADDYFILE="$file"
    ok "Caddy reverse proxy added: https://$host"
  else
    ok "Caddy reverse proxy added: $host"
  fi
}

prompt_caddy_reload() {
  [[ "$PENDING_CADDY_RELOAD" -eq 1 ]] || return 0
  if ! has_cmd caddy; then
    warn "Reload Caddy manually to activate $PENDING_PROXY_HOST."
    return 0
  fi
  if confirm "Reload Caddy now?" yes; then
    if caddy reload --config "$PENDING_CADDYFILE" --adapter caddyfile >> "$INSTALL_LOG" 2>&1; then
      ok "Caddy reloaded"
    else
      warn "Caddy reload failed. Reload it manually."
    fi
  else
    warn "Reload Caddy manually to activate $PENDING_PROXY_HOST."
  fi
}

logo
mkdir -p "$LOG_DIR"
: > "$INSTALL_LOG"
step "Checking prerequisites"
check_and_install_prerequisites
ok "Required tools are available"

if [[ -f "$INSTALL_DIR/.env" && -z "${CADDYUI_PORT:-}" ]]; then
  existing_port="$(awk -F= '$1=="CADDY_UI_PORT" {print $2}' "$INSTALL_DIR/.env" 2>/dev/null | tail -1)"
  if [[ -n "$existing_port" ]]; then START_PORT="$existing_port"; fi
fi

step "Selecting an available port"
PORT="$(find_free_port)"
ok "Selected port $PORT"

step "Preparing install directories"
mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
if [[ "$IS_ROOT" -eq 1 ]]; then
  chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR" 2>/dev/null || true
fi
ok "Install directory: $INSTALL_DIR"

step "Downloading CaddyUI from GitHub"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  run_quiet git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  run_quiet git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
  run_quiet git -C "$INSTALL_DIR" pull --ff-only --quiet origin "$BRANCH"
else
  rm -rf "$INSTALL_DIR"
  run_quiet git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
if [[ "$DRY_RUN" == "1" ]]; then mkdir -p "$INSTALL_DIR"; fi
ok "Source is ready"

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

step "Writing runtime configuration"
if command -v openssl >/dev/null 2>&1; then
  SECRET="$(openssl rand -hex 32)"
  SETUP_TOKEN_VALUE="$(openssl rand -hex 12)"
else
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  SETUP_TOKEN_VALUE="$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
fi
write_env
ok "Runtime environment configured"

step "Starting CaddyUI"
if want_systemd_service; then
  if [[ "$IS_ROOT" -ne 1 ]] && ! has_cmd sudo; then
    warn "sudo is required to install a systemd service. Falling back to background process."
    start_with_nohup
    ok "Started in the background"
  else
    start_with_systemd
    ok "Systemd service installed and started: $SERVICE_NAME"
  fi
else
  start_with_nohup
  ok "Started in the background"
fi
wait_for_app
setup_caddy_proxy
prompt_caddy_reload

IP="$(primary_ip)"
URL="http://$IP:$PORT"
printf "\n%b\n" "${GREEN}${BOLD}CaddyUI installation complete.${NC}"
printf "%b\n" "Open onboarding: ${BOLD}$URL${NC}"
printf "%b\n" "Install log: $INSTALL_LOG"
printf "%b\n" "App log:     $APP_LOG"
