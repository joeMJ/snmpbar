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

# Einstellungen (dconf) zurücksetzen – gsettings reset-recursively wirkt nicht, weil das Schema nur im
# Extension-Verzeichnis liegt (und oben gerade entfernt wurde).
if command -v dconf >/dev/null 2>&1; then
    echo "Setze Einstellungen in dconf zurück..."
    dconf reset -f /org/gnome/shell/extensions/snmpbar/ || true
fi

# Zugangsdaten (SNMP-Communities, ORB-Token, APIVoid-Key) aus dem GNOME-Schlüsselbund löschen.
# Läuft im Terminal – ein Entsperr-Dialog des Schlüsselbunds ist hier unkritisch.
if command -v secret-tool >/dev/null 2>&1; then
    echo "Lösche Zugangsdaten aus dem Schlüsselbund..."
    secret-tool clear xdg:schema org.gnome.shell.extensions.snmpbar || true
else
    echo "[HINWEIS] 'secret-tool' fehlt (Paket libsecret-tools). Einträge 'snmpbar – …' bitte in"
    echo "          'Passwörter und Verschlüsselung' (Seahorse) manuell löschen."
fi

# Flüchtige Caches (enthalten keine Zugangsdaten)
rm -f /dev/shm/snmpbar_*.json 2>/dev/null || true

echo "=== SNMP Bar wurde sauber deinstalliert. ==="
