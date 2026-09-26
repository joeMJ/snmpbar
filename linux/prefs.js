import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export default class SnmpBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const backendScript = GLib.build_filenamev([this.path, 'snmp_backend.py']);

        // ==========================================
        // SEITE 1: Allgemein & Bar-Design
        // ==========================================
        const generalPage = new Adw.PreferencesPage({
            title: _('Allgemein & Bar'),
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(generalPage);

        // --- Gruppe: SNMP-Verbindung ---
        const connGroup = new Adw.PreferencesGroup({
            title: _('SNMP-Verbindung'),
            description: _('Verbindungsdaten für das Gateway / den Router'),
        });
        generalPage.add(connGroup);

        const hostRow = new Adw.EntryRow({
            title: _('Router / Host IP'),
            text: settings.get_string('host'),
        });
        hostRow.connect('changed', (entry) => settings.set_string('host', entry.text));
        connGroup.add(hostRow);

        const commRow = new Adw.PasswordEntryRow({
            title: _('SNMP Community String'),
            text: settings.get_string('community'),
        });
        commRow.connect('changed', (entry) => settings.set_string('community', entry.text));
        connGroup.add(commRow);

        const verModel = Gtk.StringList.new(['v2c', 'v1', 'v3']);
        let verIdx = 0;
        const curVer = settings.get_string('snmp-version');
        if (curVer === 'v1') verIdx = 1;
        else if (curVer === 'v3') verIdx = 2;

        const verRow = new Adw.ComboRow({
            title: _('SNMP-Version'),
            model: verModel,
            selected: verIdx,
        });
        verRow.connect('notify::selected', () => {
            const v = verModel.get_string(verRow.selected);
            settings.set_string('snmp-version', v);
        });
        connGroup.add(verRow);

        const intervalRow = new Adw.SpinRow({
            title: _('Abfrageintervall (Sekunden)'),
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 60, step_increment: 1 }),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        connGroup.add(intervalRow);

        // --- Gruppe: Bar-Position & Darstellung ---
        const barGroup = new Adw.PreferencesGroup({
            title: _('GNOME Top-Bar Integration'),
            description: _('Position und Sichtbarkeit im oberen Panel'),
        });
        generalPage.add(barGroup);

        // Position: Rechts, Mitte (neben der Uhr), Links
        const posModel = Gtk.StringList.new([
            _('Rechts (neben System-Icons)'),
            _('Mitte (neben der Uhr)'),
            _('Links (bei Aktivitäten)')
        ]);
        const curPos = settings.get_string('panel-position');
        let posIdx = 0;
        if (curPos === 'center') posIdx = 1;
        else if (curPos === 'left') posIdx = 2;

        const posRow = new Adw.ComboRow({
            title: _('Position im Panel'),
            model: posModel,
            selected: posIdx,
        });
        posRow.connect('notify::selected', () => {
            const map = ['right', 'center', 'left'];
            settings.set_string('panel-position', map[posRow.selected]);
        });
        barGroup.add(posRow);

        const showNumRow = new Adw.SwitchRow({
            title: _('Zahlenwerte in der Bar anzeigen'),
            subtitle: _('Schriftgröße passt sich automatisch der Uhr an'),
        });
        settings.bind('show-numbers', showNumRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(showNumRow);

        const showGraphRow = new Adw.SwitchRow({
            title: _('Mini-Graph in der Bar anzeigen'),
            subtitle: _('Cairo-Echtzeit-Sparkline für Traffic-Verlauf'),
        });
        settings.bind('show-graph', showGraphRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(showGraphRow);

        // --- Gruppe: Farben & Styling ---
        const styleGroup = new Adw.PreferencesGroup({
            title: _('Farben & Design'),
            description: _('Farbanpassungen für Zahlen, Graphen und Dropdown'),
        });
        generalPage.add(styleGroup);

        const downColorRow = new Adw.EntryRow({
            title: _('Download-Farbe (Hex)'),
            text: settings.get_string('color-download'),
        });
        downColorRow.connect('changed', (entry) => {
            if (entry.text.startsWith('#') && entry.text.length >= 4) {
                settings.set_string('color-download', entry.text);
            }
        });
        styleGroup.add(downColorRow);

        const upColorRow = new Adw.EntryRow({
            title: _('Upload-Farbe (Hex)'),
            text: settings.get_string('color-upload'),
        });
        upColorRow.connect('changed', (entry) => {
            if (entry.text.startsWith('#') && entry.text.length >= 4) {
                settings.set_string('color-upload', entry.text);
            }
        });
        styleGroup.add(upColorRow);

        const menuTextColorRow = new Adw.EntryRow({
            title: _('Dropdown-Schriftfarbe (Hex)'),
            text: settings.get_string('menu-text-color'),
        });
        menuTextColorRow.connect('changed', (entry) => {
            if (entry.text.startsWith('#') && entry.text.length >= 4) {
                settings.set_string('menu-text-color', entry.text);
            }
        });
        styleGroup.add(menuTextColorRow);

        // ==========================================
        // SEITE 2: Schnittstellen & Discovery (SNMP Walk)
        // ==========================================
        const ifacesPage = new Adw.PreferencesPage({
            title: _('Schnittstellen & Discovery'),
            icon_name: 'network-workgroup-symbolic',
        });
        window.add(ifacesPage);

        // Helper: Interfaces aus Settings laden & speichern
        const loadInterfaces = () => {
            try {
                return JSON.parse(settings.get_string('interfaces-json'));
            } catch (e) {
                return [];
            }
        };

        const saveInterfaces = (list) => {
            settings.set_string('interfaces-json', JSON.stringify(list));
        };

        // Gruppe: Aktuell konfigurierte Interfaces
        const activeGroup = new Adw.PreferencesGroup({
            title: _('Aktive Überwachung'),
            description: _('Konfigurierte Schnittstellen für den Load Balancer'),
        });
        ifacesPage.add(activeGroup);

        const renderActiveInterfaces = () => {
            // Alte Zeilen entfernen
            const list = loadInterfaces();
            // Erstelle dynamische Zeilen
            while (activeGroup.get_first_child()) {
                activeGroup.remove(activeGroup.get_first_child());
            }

            if (list.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: _('Keine Interfaces konfiguriert'),
                    subtitle: _('Nutze die Discovery unten, um Schnittstellen hinzuzufügen.'),
                });
                activeGroup.add(emptyRow);
                return;
            }

            list.forEach((item, index) => {
                const row = new Adw.ActionRow({
                    title: item.name || `Index ${item.index}`,
                    subtitle: `SNMP ifIndex: ${item.index} | Icon: ${item.icon || 'network-wired-symbolic'}`,
                });

                // Switch: In Bar anzeigen
                const barSwitch = new Gtk.Switch({
                    active: !!item.show_in_bar,
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Separat in der Top-Bar anzeigen'),
                });
                barSwitch.connect('notify::active', () => {
                    item.show_in_bar = barSwitch.active;
                    saveInterfaces(list);
                });
                row.add_suffix(barSwitch);

                // Löschen-Button
                const delBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    has_frame: false,
                    tooltip_text: _('Schnittstelle entfernen'),
                });
                delBtn.connect('clicked', () => {
                    list.splice(index, 1);
                    saveInterfaces(list);
                    renderActiveInterfaces();
                });
                row.add_suffix(delBtn);

                activeGroup.add(row);
            });
        };

        renderActiveInterfaces();

        // Gruppe: Discovery (SNMP Walk)
        const discoveryGroup = new Adw.PreferencesGroup({
            title: _('Schnittstellen-Erkennung (SNMP Walk)'),
            description: _('Sucht automatisch alle verfügbaren Ports und Schnittstellen des Routers'),
        });
        ifacesPage.add(discoveryGroup);

        const walkButtonRow = new Adw.ActionRow({
            title: _('Jetzt SNMP Walk ausführen'),
            subtitle: _('Fragt ifTable / ifXTable live vom Gerät ab'),
        });

        const walkBtn = new Gtk.Button({
            label: _('Walk starten'),
            valign: Gtk.Align.CENTER,
        });

        const spinner = new Gtk.Spinner({
            valign: Gtk.Align.CENTER,
            visible: false,
        });

        walkButtonRow.add_suffix(spinner);
        walkButtonRow.add_suffix(walkBtn);
        discoveryGroup.add(walkButtonRow);

        // Gefundene Schnittstellen Container
        const resultsGroup = new Adw.PreferencesGroup({
            title: _('Gefundene Schnittstellen'),
            visible: false,
        });
        ifacesPage.add(resultsGroup);

        walkBtn.connect('clicked', () => {
            walkBtn.sensitive = false;
            spinner.visible = true;
            spinner.start();
            resultsGroup.visible = false;

            const host = settings.get_string('host');
            const comm = settings.get_string('community');
            const ver = settings.get_string('snmp-version');

            try {
                const proc = Gio.Subprocess.new(
                    ['/usr/bin/python3', backendScript, '--walk', host, comm, ver],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                proc.communicate_utf8_async(null, null, (source, res) => {
                    spinner.stop();
                    spinner.visible = false;
                    walkBtn.sensitive = true;

                    try {
                        const [, stdout] = source.communicate_utf8_finish(res);
                        if (stdout) {
                            const data = JSON.parse(stdout);
                            if (data.status === 'ok' && data.discovered_interfaces) {
                                // Gefundene Schnittstellen darstellen
                                while (resultsGroup.get_first_child()) {
                                    resultsGroup.remove(resultsGroup.get_first_child());
                                }

                                const curList = loadInterfaces();
                                const existingIndices = new Set(curList.map(i => i.index));

                                data.discovered_interfaces.forEach(iface => {
                                    const row = new Adw.ActionRow({
                                        title: iface.display_name,
                                        subtitle: `Index: ${iface.index} | Status: ${iface.is_up ? 'UP' : 'DOWN'} | Max Speed: ${iface.speed_mbps} Mbit/s`,
                                    });

                                    const isAdded = existingIndices.has(iface.index);
                                    const addBtn = new Gtk.Button({
                                        label: isAdded ? _('Hinzugefügt') : _('Überwachen'),
                                        sensitive: !isAdded,
                                        valign: Gtk.Align.CENTER,
                                    });

                                    addBtn.connect('clicked', () => {
                                        const updatedList = loadInterfaces();
                                        updatedList.push({
                                            id: `if_${iface.index}`,
                                            name: iface.alias || iface.name,
                                            index: iface.index,
                                            icon: iface.suggested_icon || 'network-wired-symbolic',
                                            show_in_bar: false,
                                        });
                                        saveInterfaces(updatedList);
                                        addBtn.label = _('Hinzugefügt');
                                        addBtn.sensitive = false;
                                        renderActiveInterfaces();
                                    });

                                    row.add_suffix(addBtn);
                                    resultsGroup.add(row);
                                });

                                resultsGroup.visible = true;
                            }
                        }
                    } catch (err) {
                        console.error(`[snmpbar] Fehler bei Discovery: ${err}`);
                    }
                });
            } catch (err) {
                spinner.stop();
                spinner.visible = false;
                walkBtn.sensitive = true;
                console.error(`[snmpbar] Konnte Discovery nicht starten: ${err}`);
            }
        });
    }
}
