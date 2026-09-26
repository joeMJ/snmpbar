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
        // SEITE 1: Design & Anzeige
        // ==========================================
        const displayPage = new Adw.PreferencesPage({
            title: _('Design & Anzeige'),
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(displayPage);

        // --- Gruppe 1: Top-Bar Darstellung ---
        const barGroup = new Adw.PreferencesGroup({
            title: _('GNOME Top-Bar'),
            description: _('Position und Darstellungsweise im oberen Panel'),
        });
        displayPage.add(barGroup);

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
            subtitle: _('Cairo-Echtzeit-Sparkline für Traffic-Verlauf im Panel'),
        });
        settings.bind('show-graph', showGraphRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(showGraphRow);

        // --- Gruppe 2: Dropdown-Menü Einstellungen ---
        const menuGroup = new Adw.PreferencesGroup({
            title: _('Dropdown-Menü'),
            description: _('Optionen für das aufklappbare Detailmenü'),
        });
        displayPage.add(menuGroup);

        const showDropGraphsRow = new Adw.SwitchRow({
            title: _('Graphen im Dropdown-Menü anzeigen'),
            subtitle: _('Zeigt Mini-Verlaufskurven für Gesamtleistung und Schnittstellen im Menü'),
        });
        settings.bind('show-dropdown-graphs', showDropGraphsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(showDropGraphsRow);

        const menuTextColorRow = new Adw.EntryRow({
            title: _('Schriftfarbe im Dropdown (Hex)'),
            text: settings.get_string('menu-text-color'),
        });
        menuTextColorRow.connect('changed', (entry) => {
            if (entry.text.startsWith('#') && entry.text.length >= 4) {
                settings.set_string('menu-text-color', entry.text);
            }
        });
        menuGroup.add(menuTextColorRow);

        // --- Gruppe 3: Farben ---
        const styleGroup = new Adw.PreferencesGroup({
            title: _('Farben für Datenströme'),
            description: _('Farbkodierung für Download und Upload (Zahlen und Graphen)'),
        });
        displayPage.add(styleGroup);

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

        // ==========================================
        // SEITE 2: SNMP-Verbindung & Schnittstellen
        // ==========================================
        const snmpPage = new Adw.PreferencesPage({
            title: _('SNMP & Schnittstellen'),
            icon_name: 'network-workgroup-symbolic',
        });
        window.add(snmpPage);

        // --- Gruppe 1: Verbindungsdaten & Bezeichnungen ---
        const connGroup = new Adw.PreferencesGroup({
            title: _('SNMP-Verbindung'),
            description: _('Verbindungsdaten und Bezeichnungen für dieses Gateway'),
        });
        snmpPage.add(connGroup);

        const connNameRow = new Adw.EntryRow({
            title: _('Verbindungs- / Gerätename'),
            text: settings.get_string('connection-name'),
        });
        connNameRow.connect('changed', (entry) => settings.set_string('connection-name', entry.text));
        connGroup.add(connNameRow);

        const aggNameRow = new Adw.EntryRow({
            title: _('Name der aggregierten Leistung'),
            text: settings.get_string('aggregated-name'),
        });
        aggNameRow.connect('changed', (entry) => settings.set_string('aggregated-name', entry.text));
        connGroup.add(aggNameRow);

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

        // --- Gruppe 2: Schnittstellenverwaltung mit Editierbarkeit ---
        const ifacesGroup = new Adw.PreferencesGroup({
            title: _('Konfigurierte Schnittstellen'),
            description: _('Schnittstellennamen editieren und Anzeigeoptionen anpassen'),
        });
        snmpPage.add(ifacesGroup);

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

        let activeRows = [];
        const clearActiveRows = () => {
            for (const r of activeRows) {
                ifacesGroup.remove(r);
            }
            activeRows = [];
        };

        const renderActiveInterfaces = () => {
            clearActiveRows();
            const list = loadInterfaces();

            if (list.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: _('Keine Schnittstellen konfiguriert'),
                    subtitle: _('Führe die Discovery unten aus, um Schnittstellen hinzuzufügen.'),
                });
                ifacesGroup.add(emptyRow);
                activeRows.push(emptyRow);
                return;
            }

            list.forEach((item, index) => {
                const expander = new Adw.ExpanderRow({
                    title: item.name || `Index ${item.index}`,
                    subtitle: `SNMP ifIndex: ${item.index} | Icon: ${item.icon || 'network-wired-symbolic'}`,
                    show_enable_switch: false,
                });

                // 1. Name editieren
                const nameRow = new Adw.EntryRow({
                    title: _('Schnittstellen-Name'),
                    text: item.name || '',
                });
                nameRow.connect('changed', (entry) => {
                    item.name = entry.text;
                    expander.title = entry.text || `Index ${item.index}`;
                    saveInterfaces(list);
                });
                expander.add_row(nameRow);

                // 2. Schalter: In Bar anzeigen
                const barRow = new Adw.SwitchRow({
                    title: _('In GNOME Top-Bar anzeigen'),
                    active: !!item.show_in_bar,
                });
                barRow.connect('notify::active', () => {
                    item.show_in_bar = barRow.active;
                    saveInterfaces(list);
                });
                expander.add_row(barRow);

                // 3. Schalter: Graph im Dropdown anzeigen
                const graphRow = new Adw.SwitchRow({
                    title: _('Graph im Dropdown-Menü anzeigen'),
                    active: item.show_graph !== false,
                });
                graphRow.connect('notify::active', () => {
                    item.show_graph = graphRow.active;
                    saveInterfaces(list);
                });
                expander.add_row(graphRow);

                // 4. Löschen
                const delRow = new Adw.ActionRow({
                    title: _('Schnittstelle entfernen'),
                });
                const delBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    has_frame: false,
                });
                delBtn.connect('clicked', () => {
                    list.splice(index, 1);
                    saveInterfaces(list);
                    renderActiveInterfaces();
                });
                delRow.add_suffix(delBtn);
                expander.add_row(delRow);

                ifacesGroup.add(expander);
                activeRows.push(expander);
            });
        };

        renderActiveInterfaces();

        // --- Gruppe 3: Discovery (SNMP Walk) ---
        const discoveryGroup = new Adw.PreferencesGroup({
            title: _('Schnittstellen-Erkennung (SNMP Walk)'),
            description: _('Sucht live alle verfügbaren Ports und Schnittstellen des Routers'),
        });
        snmpPage.add(discoveryGroup);

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

        const resultsGroup = new Adw.PreferencesGroup({
            title: _('Gefundene Schnittstellen'),
            visible: false,
        });
        snmpPage.add(resultsGroup);

        let resultRows = [];
        const clearResultRows = () => {
            for (const r of resultRows) {
                resultsGroup.remove(r);
            }
            resultRows = [];
        };

        walkBtn.connect('clicked', () => {
            walkBtn.sensitive = false;
            spinner.visible = true;
            spinner.start();
            resultsGroup.visible = false;
            clearResultRows();

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
                                clearResultRows();
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
                                            show_graph: true,
                                        });
                                        saveInterfaces(updatedList);
                                        addBtn.label = _('Hinzugefügt');
                                        addBtn.sensitive = false;
                                        renderActiveInterfaces();
                                    });

                                    row.add_suffix(addBtn);
                                    resultsGroup.add(row);
                                    resultRows.push(row);
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
