#!/usr/bin/env bash
#
# install.sh — idempotent installer for whatsapp-shell-bot.
#
# Run as root: `sudo bash scripts/install.sh`
#
# What it does:
#   1. Verifies it's running as root on Debian/Ubuntu.
#   2. Installs apt dependencies (Chromium for Puppeteer + system libs).
#   3. Installs Node.js 20 via NodeSource.
#   4. Creates the dedicated `wabot` system user.
#   5. Creates /opt/whatsapp-shell-bot and /var/log/whatsapp-shell-bot.
#   6. Copies project files into place.
#   7. Runs `npm ci --omit=dev` to install production dependencies.
#   8. Generates a config.json from config.example.json if none exists.
#   9. Sets correct ownership and permissions.
#  10. Installs + enables the systemd unit.
#
# It does NOT start the service — that is left to the operator so they can
# first review config.json and then start it manually for the QR scan.
#

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

APP_DIR="/opt/whatsapp-shell-bot"
LOG_DIR="/var/log/whatsapp-shell-bot"
SERVICE_USER="wabot"
SERVICE_GROUP="wabot"
NODE_MAJOR="20"

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    log_error "Dieses Script muss als root laufen. Bitte mit sudo aufrufen."
    exit 1
  fi
}

require_debian_ubuntu() {
  if [[ ! -f /etc/os-release ]]; then
    log_error "/etc/os-release nicht gefunden. Abbruch."
    exit 1
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  case "${ID:-}" in
    debian|ubuntu)
      log_info "OS erkannt: ${PRETTY_NAME:-$ID}"
      ;;
    *)
      log_error "Nicht unterstütztes OS: ${ID:-unbekannt}. Nur Debian/Ubuntu."
      exit 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

install_apt_dependencies() {
  log_info "Aktualisiere apt-Cache und installiere Abhängigkeiten …"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libxss1 \
    libasound2 \
    libgbm1
}

install_nodejs() {
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$current_major" -ge "$NODE_MAJOR" ]]; then
      log_info "Node.js $(node -v) bereits installiert."
      return
    fi
  fi

  log_info "Installiere Node.js ${NODE_MAJOR} via NodeSource …"
  local tmpdir
  tmpdir="$(mktemp -d)"
  pushd "$tmpdir" >/dev/null

  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o nodesource_setup.sh
  bash nodesource_setup.sh
  apt-get install -y --no-install-recommends nodejs
  popd >/dev/null
  rm -rf "$tmpdir"

  log_info "Node.js installiert: $(node -v)"
}

create_service_user() {
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log_info "User ${SERVICE_USER} existiert bereits."
    return
  fi
  log_info "Lege System-User ${SERVICE_USER} an …"
  useradd --system \
    --shell /usr/sbin/nologin \
    --home "$APP_DIR" \
    --no-create-home \
    "$SERVICE_USER"
}

create_directories() {
  log_info "Lege Verzeichnisse an …"
  mkdir -p "$APP_DIR"
  mkdir -p "$LOG_DIR"
}

copy_project_files() {
  log_info "Kopiere Projektdateien nach ${APP_DIR} …"

  # Resolve script's own directory so the script works no matter where it
  # is called from.
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local project_root
  project_root="$(cd "$script_dir/.." && pwd)"

  # Copy everything except node_modules, .git, logs, the .wwebjs_auth cache.
  rsync -a --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.wwebjs_auth' \
    --exclude='*.log' \
    --exclude='config.json' \
    "$project_root/" "$APP_DIR/"

  # Generate config.json from the example if absent.
  if [[ ! -f "$APP_DIR/config.json" ]]; then
    log_info "Erzeuge initiale config.json aus config.example.json …"
    cp "$APP_DIR/config.example.json" "$APP_DIR/config.json"
  else
    log_info "Bestehende config.json wird beibehalten."
  fi

  # Make sure .wwebjs_auth exists and is writable.
  mkdir -p "$APP_DIR/.wwebjs_auth"
}

install_npm_dependencies() {
  if [[ ! -f "$APP_DIR/package.json" ]]; then
    log_error "package.json fehlt in ${APP_DIR}. Abbruch."
    exit 1
  fi

  if [[ ! -f "$APP_DIR/package-lock.json" ]]; then
    log_warn "Keine package-lock.json gefunden — fallback auf 'npm install --omit=dev'."
    (cd "$APP_DIR" && npm install --omit=dev)
  else
    log_info "Installiere npm-Dependencies (npm ci --omit=dev) …"
    (cd "$APP_DIR" && npm ci --omit=dev)
  fi
}

set_permissions() {
  log_info "Setze Berechtigungen …"

  # The bot reads config but doesn't write it (only the admin does).
  # Owner: root, group: wabot, mode 0640. The wabot user can read but
  # not write, which prevents the running process from modifying the
  # whitelist at runtime — fs.watch only triggers on external writes.
  chown -R "root:${SERVICE_GROUP}" "$APP_DIR"
  find "$APP_DIR" -type d -exec chmod 750 {} +
  find "$APP_DIR" -type f -exec chmod 640 {} +
  chmod 750 "$APP_DIR/src" "$APP_DIR/scripts"

  # .wwebjs_auth must be writable by wabot so LocalAuth can persist
  # credentials.
  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$APP_DIR/.wwebjs_auth"
  find "$APP_DIR/.wwebjs_auth" -type d -exec chmod 750 {} +
  find "$APP_DIR/.wwebjs_auth" -type f -exec chmod 640 {} +

  # Log directory: owned by wabot so the process can write audit logs.
  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$LOG_DIR"
  find "$LOG_DIR" -type d -exec chmod 750 {} +
  find "$LOG_DIR" -type f -exec chmod 640 {} + 2>/dev/null || true

  # Make the helper scripts executable.
  if [[ -d "$APP_DIR/scripts" ]]; then
    chmod +x "$APP_DIR/scripts/"*.sh
  fi
}

install_systemd_unit() {
  local unit_src="$APP_DIR/systemd/whatsapp-shell-bot.service"
  local unit_dst="/etc/systemd/system/whatsapp-shell-bot.service"

  if [[ ! -f "$unit_src" ]]; then
    log_error "systemd-unit nicht gefunden: $unit_src"
    exit 1
  fi

  log_info "Installiere systemd-unit nach ${unit_dst} …"
  install -m 0644 "$unit_src" "$unit_dst"

  systemctl daemon-reload
  systemctl enable whatsapp-shell-bot.service
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

require_root
require_debian_ubuntu

install_apt_dependencies
install_nodejs
create_service_user
create_directories
copy_project_files
install_npm_dependencies
set_permissions
install_systemd_unit

echo
log_warn "Der Service startet jetzt noch nicht. Trage zuerst deine Nummer(n) in"
log_warn "${APP_DIR}/config.json ein und starte den Service dann manuell mit"
log_warn "    sudo systemctl start whatsapp-shell-bot"
log_warn "für den QR-Scan (alternativ einmalig im Vordergrund, siehe README)."
echo
log_warn "SMS-Kanal: dieser ist initial DEAKTIVIERT (sms.enabled=false)."
log_warn "Wenn du SMS nutzen willst:"
log_warn "  1. Twilio-Account anlegen, Nummer kaufen, Account-SID + Auth-Token notieren."
log_warn "  2. sms.enabled=true setzen und Credentials in config.json eintragen."
log_warn "  3. Reverse-Proxy mit HTTPS einrichten (Caddy/nginx/Cloudflare Tunnel)."
log_warn "  4. Webhook-URL https://<deine-domain><webhookPath> in Twilio konfigurieren."
log_warn "Siehe README → 'SMS via Twilio' für Details."
echo
log_info "✅ Installation abgeschlossen."