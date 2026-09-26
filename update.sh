#!/usr/bin/env bash
set -euo pipefail

EXTENSION_UUID="snmpbar@johnlose.de"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$REPO_DIR/linux"

echo "=== SNMP Bar Updater ==="
cd "$REPO_DIR"

echo "1. Hole neueste Änderungen aus dem Git-Repository..."
git pull origin main || echo "[Hinweis] Git pull nicht erfolgreich oder keine Netzwerkverbindung."

echo "2. Kompiliere GSettings-Schemas neu..."
if [ -d "$SRC_DIR/schemas" ]; then
    glib-compile-schemas "$SRC_DIR/schemas"
fi

echo "3. Synchronisiere Dateien nach $TARGET_DIR..."
mkdir -p "$TARGET_DIR"
cp -r "$SRC_DIR"/* "$TARGET_DIR/"

echo "4. Starte Extension neu..."
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true
    sleep 0.5
    gnome-extensions enable "$EXTENSION_UUID" 2>/dev/null || true
    echo "Extension '$EXTENSION_UUID' neu geladen."
fi

echo "=== Update erfolgreich abgeschlossen! ==="
