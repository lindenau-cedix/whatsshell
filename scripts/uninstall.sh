#!/usr/bin/env bash
#
# uninstall.sh — remove the whatsapp-shell-bot installation.
#
# By default this KEEPS the user data (logs + WhatsApp session + config)
# so you can re-install without re-scanning the QR code.
#
# Flags:
#   --purge        Also delete /var/log/whatsapp-shell-bot
#   --full         Delete everything: logs, app dir, user
#   --yes          Skip the interactive confirmation prompt
#

set -euo pipefail

APP_DIR="/opt/whatsapp-shell-bot"
LOG_DIR="/var/log/whatsapp-shell-bot"
SERVICE_NAME="whatsapp-shell-bot"

PURGE=false
FULL=false
ASSUME_YES=false

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=true ;;
    --full)  FULL=true; PURGE=true ;;
    --yes|-y) ASSUME_YES=true ;;
    -h|--help)
      cat <<EOF
Usage: sudo bash scripts/uninstall.sh [--purge] [--full] [--yes]

  --purge   Also remove /var/log/whatsapp-shell-bot
  --full    Remove app dir, logs, and the wabot user
  --yes     Skip the interactive confirmation
EOF
      exit 0
      ;;
    *)
      echo "Unbekanntes Argument: $arg" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "Dieses Script muss als root laufen. Bitte mit sudo aufrufen." >&2
  exit 1
fi

if ! $ASSUME_YES; then
  echo "Dieses Script wird den Service '${SERVICE_NAME}' deaktivieren und entfernen."
  if $FULL; then
    echo "  -- FULL MODE: App-Verzeichnis, Logs UND System-User werden gelöscht."
  elif $PURGE; then
    echo "  -- PURGE MODE: Logs werden mit gelöscht."
  else
    echo "  (Logs + Session bleiben erhalten — nutze --purge oder --full zum Entfernen.)"
  fi
  echo
  read -rp "Fortfahren? [j/N] " ans
  if [[ ! "$ans" =~ ^[jJyY]$ ]]; then
    echo "Abgebrochen."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------

if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  echo "[INFO]  Stoppe Service ${SERVICE_NAME} …"
  systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
  echo "[INFO]  Deaktiviere Service ${SERVICE_NAME} …"
  systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
fi

if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
fi

if $FULL; then
  echo "[INFO]  Lösche ${APP_DIR} …"
  rm -rf "$APP_DIR"
fi

if $PURGE && [[ -d "$LOG_DIR" ]]; then
  echo "[INFO]  Lösche ${LOG_DIR} …"
  rm -rf "$LOG_DIR"
fi

if $FULL; then
  if id -u wabot >/dev/null 2>&1; then
    echo "[INFO]  Lösche User wabot …"
    userdel wabot 2>/dev/null || true
  fi
fi

echo "[INFO]  ✅ Deinstallation abgeschlossen."