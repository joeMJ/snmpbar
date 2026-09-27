#!/usr/bin/env bash
set -euo pipefail

echo "=== Ookla Speedtest CLI Installer für snmpbar ==="

ARCH="$(uname -m)"
TARGET_DIR="$HOME/.local/bin"
mkdir -p "$TARGET_DIR"

if [ "$ARCH" = "x86_64" ]; then
    OOKLA_URL="https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-x86_64.tgz"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    OOKLA_URL="https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-aarch64.tgz"
elif [[ "$ARCH" =~ armv7 ]]; then
    OOKLA_URL="https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-armhf.tgz"
else
    echo "Unbekannte Architektur '$ARCH'. Bitte installieren Sie speedtest oder speedtest-cli manuell über Ihren Paketmanager."
    exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "1. Lade offizielles Ookla Speedtest CLI ($ARCH) herunter..."
curl -sSL "$OOKLA_URL" -o "$TMP_DIR/speedtest.tgz"

echo "2. Entpacke Binary nach $TARGET_DIR/speedtest..."
tar -xzf "$TMP_DIR/speedtest.tgz" -C "$TMP_DIR" speedtest
install -m 755 "$TMP_DIR/speedtest" "$TARGET_DIR/speedtest"

echo "3. Prüfe Installation..."
if "$TARGET_DIR/speedtest" --version >/dev/null 2>&1; then
    VER="$("$TARGET_DIR/speedtest" --version | head -n 1)"
    echo "✓ Erfolgreich installiert: $VER in $TARGET_DIR/speedtest"
else
    echo "Warnung: Binary konnte nicht ausgeführt werden."
    exit 1
fi

echo "=== Fertig! Das Ookla Speedtest CLI steht snmpbar sofort zur Verfügung. ==="
