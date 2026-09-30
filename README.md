# snmpbar – SNMP-Durchsatz in der GNOME-Top-Bar

> [!WARNING]
> **Privates Hobbyprojekt – nicht gepflegt / unmaintained.**
> Dieses Repository ist für meinen eigenen Gebrauch gedacht und wird nur aus Bequemlichkeit öffentlich bereitgestellt.
>
> * **Keine Unterstützung:** Issues und Pull Requests werden nicht bearbeitet, Feature-Wünsche nicht umgesetzt. Bitte keine Issues eröffnen.
> * **Keine Garantie:** Bereitstellung „wie besehen“, ohne jede Gewährleistung und Haftung. Nutzung auf eigenes Risiko.
> * **Eigene Umgebung:** Entwickelt und getestet nur auf meinen eigenen Ubuntu-Rechnern (GNOME Shell unter Wayland) mit meinen eigenen Routern (u. a. LANCOM). Auf anderen Systemen oder Geräten kann es fehlschlagen. Windows- und macOS-Varianten existieren bisher nur als Planung.
> * **Zugangsdaten & Netzwerk:** Die Extension läuft mit den Rechten deiner GNOME-Sitzung. SNMP-Communities, ein optionales ORB-Cloud-Token und ein optionaler APIVoid-Key werden im GNOME-Schlüsselbund (libsecret) gespeichert – verschlüsselt, solange du abgemeldet bist; während der Sitzung können Programme deines Benutzers sie lesen. SNMP v1/v2c überträgt die Community unverschlüsselt im Netzwerk. Die Extension fragt deine Geräte per SNMP (UDP 161) ab; optional ruft sie `panel.orb.net` (ORB Cloud) ab und prüft die öffentliche WAN-IP über externe Reputationsdienste (Blocklist.de, StopForumSpam, DroneBL, Spamhaus, Barracuda, optional APIVoid) – **dabei verlässt deine öffentliche IP-Adresse dein Netz** (abschaltbar in den Einstellungen). Ein Speedtest nutzt die Ookla-CLI, falls installiert. Für die Versionsprüfung wird regelmäßig die `metadata.json` von `raw.githubusercontent.com` abgerufen (abschaltbar im Reiter *Updates*); die Installation per `curl … | bash` führt das geladene Skript direkt aus. **Lies den Code, bevor du ihn installierst.**
> * **Keine Updates zugesichert:** Es kann jederzeit ohne Ankündigung Änderungen, Brüche oder die Löschung des Repos geben. Gern selbst forken und anpassen.
>
> *Private hobby project, unmaintained, provided as-is. No support, no issues, no warranty. Fork it if you like.*

> **Echtzeit-Überwachung von Up- und Downstream-Durchsatz per SNMP direkt im GNOME-Panel**

---

## Plattform-Übersicht

| Plattform | Status | Verzeichnis | Tech Stack |
| :--- | :--- | :--- | :--- |
| **Linux (GNOME Shell)** | Aktiv | [`linux/`](linux/) | GNOME Shell 45–50 ESM, GTK4/Libadwaita, Python-Backend |
| **Windows** | Geplant | [`windows/`](windows/) | – |
| **macOS** | Geplant | [`macos/`](macos/) | – |

---

## Funktionen

* **SNMP v1 / v2c** Abfragen von Gateway, Load Balancer (gesamt) und einzelnen Interfaces (SNMP v3 ist noch nicht umgesetzt).
* **Top-Bar:** Zahlenwerte und/oder Sparkline-Graphen, frei wählbar; Dropdown-Menü mit Verlaufsgraphen, Einheitenskalierung und Farbeinstellungen (inkl. automatischer Dark-Mode-Anpassung).
* **Einrichtung:** Interface-Discovery per `snmpwalk`-artiger Abfrage direkt in den Einstellungen.
* **Lokales Monitoring** der eigenen Netzwerkschnittstellen über `/proc/net/dev`.
* **Optional:** ORB-Cloud-Scores (orb.net), Speedtest inkl. Verlauf, IP-Reputationsprüfung, Verbindungsdauer für LANCOM-Geräte.

---

## Installation Linux (Ubuntu / GNOME)

**Voraussetzungen:** GNOME Shell 45–50, `curl`, `tar`, `python3`, `glib-compile-schemas` (Paket `libglib2.0-bin`, auf Ubuntu vorinstalliert) und `gir1.2-secret-1` (libsecret, für den Schlüsselbund). Kein `sudo` nötig – alles läuft im eigenen Benutzerkonto.

### Installieren

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/snmpbar/main/install.sh | bash
```

Das Skript lädt den aktuellen Stand per HTTPS von GitHub in ein temporäres Verzeichnis, installiert die Extension nach `~/.local/share/gnome-shell/extensions/` und räumt danach auf.

> [!NOTE]
> Unter Wayland lädt GNOME Shell neue oder aktualisierte Extension-Dateien erst nach dem **Ab- und wieder Anmelden**.

### Aktualisieren

Denselben Befehl erneut ausführen oder in den Einstellungen im Reiter *Updates* auf **Jetzt aktualisieren** klicken (der Knopf ist nur aktiv, wenn eine neuere Version vorliegt) – die Einstellungen und Zugangsdaten bleiben erhalten. Liegt eine neue Version vor, zeigt auch das Menü einen Hinweis.

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/snmpbar/main/install.sh | bash
```

### Deinstallieren

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/snmpbar/main/install.sh | bash -s -- --uninstall
```

Entfernt die Extension, alle Einstellungen (dconf) und die Zugangsdaten aus dem Schlüsselbund. (Über den Extension-Manager deinstalliert, bleiben Einstellungen und Schlüsselbund-Einträge erhalten.)

### Erst ansehen, dann ausführen

```bash
curl -fsSLO https://raw.githubusercontent.com/joeMJ/snmpbar/main/install.sh
less install.sh
bash install.sh
```

### Einstellungen

Über das Menü der Extension oder:

```bash
gnome-extensions prefs snmpbar@johnlose.de
```

### Alternative: Git-Klon (für Entwicklung)

```bash
git clone https://github.com/joeMJ/snmpbar.git
cd snmpbar
./install.sh
```

Update mit `./update.sh` (führt `git pull` aus), Deinstallation mit `./uninstall.sh`.

---

## Lizenz

[Apache License 2.0](LICENSE)
