#!/usr/bin/env bash
#
# update-whitelist.sh — safely edit the whitelist without a text editor.
#
# Why does this exist?
#   The config.json is owned by root: wabot with mode 0640. Editing it
#   directly as root with vi/nano works, but a small dedicated helper
#   avoids the "oops I broke the JSON" failure mode by validating the
#   file before saving.
#
# Usage:
#   sudo bash scripts/update-whitelist.sh add-number 491701234567
#   sudo bash scripts/update-whitelist.sh remove-number 491701234567
#   sudo bash scripts/update-whitelist.sh add-command NAME "echo hi"
#   sudo bash scripts/update-whitelist.sh remove-command NAME
#   sudo bash scripts/update-whitelist.sh list
#

set -euo pipefail

CONFIG="${WABOT_CONFIG:-/opt/whatsapp-shell-bot/config.json}"

# ---------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "Dieses Script muss als root laufen." >&2
  exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "config.json nicht gefunden: $CONFIG" >&2
  exit 1
fi

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "jq wird benötigt. Installiere mit: apt-get install -y jq" >&2
    exit 1
  fi
}

validate_config() {
  if ! jq empty "$CONFIG" >/dev/null 2>&1; then
    echo "config.json ist ungültiges JSON. Abbruch." >&2
    exit 1
  fi
  if ! jq -e '.whitelist.numbers and .whitelist.commands' "$CONFIG" >/dev/null; then
    echo "Pflichtfelder whitelist.numbers / whitelist.commands fehlen." >&2
    exit 1
  fi
}

backup() {
  cp -a "$CONFIG" "${CONFIG}.bak.$(date +%Y%m%d-%H%M%S)"
}

# ---------------------------------------------------------------------------

cmd="${1:-}"

case "$cmd" in
  list)
    require_jq
    validate_config
    echo "=== Whitelist-Nummern ==="
    jq -r '.whitelist.numbers[]' "$CONFIG"
    echo
    echo "=== Whitelist-Kommandos ==="
    jq -r '.whitelist.commands[] | "  \(.name)\t\(.command)\t— \(.description // "")"' "$CONFIG"
    ;;

  add-number)
    require_jq
    num="${2:?Nummer fehlt}"
    # Strip non-digits, remove leading +.
    num="$(echo "$num" | tr -d '+' | tr -cd '0-9')"
    [[ -z "$num" ]] && { echo "Ungültige Nummer." >&2; exit 1; }
    validate_config
    backup
    tmp="$(mktemp)"
    jq --arg n "$num" '.whitelist.numbers |= ((. + [$n]) | unique)' "$CONFIG" > "$tmp"
    mv "$tmp" "$CONFIG"
    chmod 640 "$CONFIG"
    chown root:wabot "$CONFIG"
    echo "✅ Nummer ${num} hinzugefügt."
    ;;

  remove-number)
    require_jq
    num="${2:?Nummer fehlt}"
    num="$(echo "$num" | tr -d '+' | tr -cd '0-9')"
    validate_config
    backup
    tmp="$(mktemp)"
    jq --arg n "$num" '.whitelist.numbers |= map(select(. != $n))' "$CONFIG" > "$tmp"
    mv "$tmp" "$CONFIG"
    chmod 640 "$CONFIG"
    chown root:wabot "$CONFIG"
    echo "✅ Nummer ${num} entfernt."
    ;;

  add-command)
    require_jq
    name="${2:?Name fehlt}"
    cmdstr="${3:?Kommando fehlt}"
    desc="${4:-}"
    validate_config
    backup
    tmp="$(mktemp)"
    jq --arg n "$name" --arg c "$cmdstr" --arg d "$desc" \
      '.whitelist.commands |= ((. + [{name: $n, command: $c, description: $d}]) | unique_by(.command))' \
      "$CONFIG" > "$tmp"
    mv "$tmp" "$CONFIG"
    chmod 640 "$CONFIG"
    chown root:wabot "$CONFIG"
    echo "✅ Kommando '${cmdstr}' (name=${name}) hinzugefügt."
    ;;

  remove-command)
    require_jq
    name="${2:?Name fehlt}"
    validate_config
    backup
    tmp="$(mktemp)"
    jq --arg n "$name" '.whitelist.commands |= map(select(.name != $n))' "$CONFIG" > "$tmp"
    mv "$tmp" "$CONFIG"
    chmod 640 "$CONFIG"
    chown root:wabot "$CONFIG"
    echo "✅ Kommando '${name}' entfernt."
    ;;

  *)
    cat <<EOF
Usage: sudo bash scripts/update-whitelist.sh <subcommand> [args]

Subcommands:
  list                           List all whitelisted numbers + commands
  add-number <e164>              Add a phone number (without '+')
  remove-number <e164>           Remove a phone number
  add-command <name> <cmd> [desc]  Add a whitelisted command
  remove-command <name>          Remove a command by its name
EOF
    exit 1
    ;;
esac

echo "ℹ️  Die config.json wird vom laufenden Service per fs.watch automatisch neu geladen."