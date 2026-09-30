#!/usr/bin/env bash
# uninstall.sh - Deinstallation von snmpbar (Extension, dconf, Schlüsselbund)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/linux/install.sh" --uninstall "$@"
