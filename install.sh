#!/usr/bin/env bash
set -euo pipefail

EXTENSION_UUID="snmpbar@johnlose.de"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/linux"

echo "=== SNMP Bar Installer ==="

# Abhängigkeits-Prüfung für SNMP CLI Tools
if ! command -v snmpget >/dev/null 2>&1 || ! command -v snmpwalk >/dev/null 2>&1; then
    echo "[HINWEIS] 'snmpwalk' und 'snmpget' sind nicht installiert."
    echo "          Für die SNMP-Funktionalität und Geräte-Discovery bitte installieren:"
    echo "          sudo apt install snmp snmp-mibs-downloader"
    echo ""
fi

# Optionale Ookla Speedtest CLI Prüfung & Installation
if ! command -v speedtest >/dev/null 2>&1; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    echo "Optional: Das offizielle Ookla Speedtest CLI wurde nicht gefunden."
    read -r -p "Möchten Sie Ookla Speedtest nach ~/.local/bin installieren? [j/N]: " install_st || install_st="n"
    if [[ "$install_st" =~ ^[jJyY]$ ]] && [ -f "$SCRIPT_DIR/install_speedtest.sh" ]; then
        bash "$SCRIPT_DIR/install_speedtest.sh"
    fi
    echo ""
fi

echo "1. Kompiliere GSettings-Schemas..."
if [ -d "$SRC_DIR/schemas" ]; then
    glib-compile-schemas "$SRC_DIR/schemas"
fi

echo "2. Installiere Extension nach $TARGET_DIR..."
mkdir -p "$TARGET_DIR"
cp -r "$SRC_DIR"/* "$TARGET_DIR/"

echo "3. Aktiviere Extension..."
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "$EXTENSION_UUID" 2>/dev/null || true
    echo "Extension '$EXTENSION_UUID' aktiviert."
else
    echo "gnome-extensions CLI nicht gefunden. Bitte über den Erweiterungs-Manager aktivieren."
fi

echo "=== Installation erfolgreich abgeschlossen! ==="
echo "Hinweis: Unter Wayland ggf. einmal ab- und wieder anmelden, damit GNOME die neue Erweiterung lädt."
