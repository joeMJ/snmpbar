#!/usr/bin/env bash
set -euo pipefail

EXTENSION_UUID="snmpbar@johnlose.de"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "=== SNMP Bar Deinstallation ==="

if command -v gnome-extensions >/dev/null 2>&1; then
    echo "Deaktiviere Extension '$EXTENSION_UUID'..."
    gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true
fi

if [ -d "$TARGET_DIR" ]; then
    echo "Entferne $TARGET_DIR..."
    rm -rf "$TARGET_DIR"
fi

echo "=== SNMP Bar wurde sauber deinstalliert. ==="
