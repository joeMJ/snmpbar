#!/usr/bin/env bash
set -euo pipefail

EXTENSION_UUID="snmpbar@johnlose.de"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$REPO_DIR/linux"

echo "=== SNMP Bar Updater ==="
cd "$REPO_DIR"

echo "1. Sichere Extension-Deaktivierung vor Datei-Aktualisierung..."
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true
    sleep 0.5
fi

echo "2. Kompiliere GSettings-Schemas in Quelle..."
if [ -d "$SRC_DIR/schemas" ]; then
    glib-compile-schemas "$SRC_DIR/schemas"
fi

echo "3. Synchronisiere Dateien nach $TARGET_DIR..."
mkdir -p "$TARGET_DIR"
cp -r "$SRC_DIR"/* "$TARGET_DIR/"

echo "4. Kompiliere Schemas im Zielverzeichnis..."
if [ -d "$TARGET_DIR/schemas" ]; then
    glib-compile-schemas "$TARGET_DIR/schemas"
    sleep 0.5
fi

echo "5. Starte Extension wieder sauber..."
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "$EXTENSION_UUID" 2>/dev/null || true
    echo "Extension '$EXTENSION_UUID' erfolgreich neu geladen."
fi

echo "=== Update erfolgreich abgeschlossen! ==="
