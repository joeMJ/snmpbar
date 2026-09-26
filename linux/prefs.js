import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export default class SnmpBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const backendScript = GLib.build_filenamev([this.path, 'snmp_backend.py']);

        // Helper: Connections laden & speichern
        const loadConnections = () => {
            try {
                const raw = settings.get_string('connections-json');
                const list = JSON.parse(raw);
                if (Array.isArray(list) && list.length > 0) return list;
            } catch (e) {}

            // Fallback auf initiale Standard-Verbindung
            return [{
                id: 'conn_1',
                name: settings.get_string('connection-name') || 'Gateway',
                aggregated_name: settings.get_string('aggregated-name') || 'Load-Balancer Gesamt',
                host: settings.get_string('host') || '192.0.2.1',
                community: settings.get_string('community') || 'public',
                version: settings.get_string('snmp-version') || 'v2c',
                interval: settings.get_int('refresh-interval') || 3,
                interfaces: [
                    { id: 'vdsl', name: 'VDSL (INTERNET)', index: 65, icon: 'network-wired-symbolic', show_graph: true },
                    { id: 'wwan', name: '5G (INET_WWAN)', index: 93, icon: 'network-cellular-signal-excellent-symbolic', show_graph: true },
                    { id: 'gpon', name: 'Glasfaser (GPON)', index: 400010, icon: 'network-transmit-receive-symbolic', show_graph: true }
                ]
            }];
        };

        const saveConnections = (list) => {
            settings.set_string('connections-json', JSON.stringify(list));
            if (list.length > 0) {
                const first = list[0];
                settings.set_string('connection-name', first.name || '');
                settings.set_string('aggregated-name', first.aggregated_name || '');
                settings.set_string('host', first.host || '');
                settings.set_string('community', first.community || '');
                settings.set_string('snmp-version', first.version || 'v2c');
                settings.set_string('interfaces-json', JSON.stringify(first.interfaces || []));
            }
        };

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
            description: _('Quelle, Position und Darstellungsweise im oberen Panel'),
        });
        displayPage.add(barGroup);

        // Top-Bar Quelle auswählen (Punkt a)
        const conns = loadConnections();
        const sourceKeys = [];
        const sourceLabels = [];

        conns.forEach(c => {
            sourceKeys.push(`${c.id}:total`);
            sourceLabels.push(`[${c.name}] ${c.aggregated_name || 'Gesamtsumme'}`);

            (c.interfaces || []).forEach(iface => {
                sourceKeys.push(`if_${iface.index}`);
                sourceLabels.push(`[${c.name}] ${iface.name}`);
            });
        });

        const curSource = settings.get_string('topbar-source') || 'total';
        let curSourceIdx = 0;
        if (curSource !== 'total') {
            const foundIdx = sourceKeys.indexOf(curSource);
            if (foundIdx >= 0) curSourceIdx = foundIdx;
        }

        const sourceModel = Gtk.StringList.new(sourceLabels.length > 0 ? sourceLabels : [_('Standard-Gesamtsumme')]);
        const sourceRow = new Adw.ComboRow({
            title: _('Quelle für Top-Bar Anzeige'),
            subtitle: _('Wähle die Verbindung oder Einzelschnittstelle für die Leiste'),
            model: sourceModel,
            selected: curSourceIdx,
        });
        sourceRow.connect('notify::selected', () => {
            if (sourceKeys[sourceRow.selected]) {
                settings.set_string('topbar-source', sourceKeys[sourceRow.selected]);
            }
        });
        barGroup.add(sourceRow);

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
            subtitle: _('Große Verlaufskurven über Gesamtleistung und Schnittstellen'),
        });
        settings.bind('show-dropdown-graphs', showDropGraphsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(showDropGraphsRow);

        const menuTextColorRow = new Adw.EntryRow({
            title: _('Dropdown-Schriftfarbe (Hex)'),
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
        // SEITE 2: SNMP-Verbindungen & Schnittstellen (Punkt c)
        // ==========================================
        const snmpPage = new Adw.PreferencesPage({
            title: _('SNMP & Schnittstellen'),
            icon_name: 'network-workgroup-symbolic',
        });
        window.add(snmpPage);

        // Header-Gruppe mit "+ Neue Verbindung hinzufügen"
        const headerGroup = new Adw.PreferencesGroup({
            title: _('SNMP-Geräte & Verbindungen'),
            description: _('Hinterlege ein oder mehrere Gateways/Router und deren Schnittstellen'),
        });
        snmpPage.add(headerGroup);

        const addConnRow = new Adw.ActionRow({
            title: _('Neues Gerät hinzufügen'),
            subtitle: _('Erstelle eine weitere SNMP-Verbindung'),
        });
        const addConnBtn = new Gtk.Button({
            label: _('+ Verbindung hinzufügen'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addConnRow.add_suffix(addConnBtn);
        headerGroup.add(addConnRow);

        // Container für Verbindungs-Zeilen
        const connsGroup = new Adw.PreferencesGroup();
        snmpPage.add(connsGroup);

        let connRows = [];
        const clearConnRows = () => {
            for (const r of connRows) {
                connsGroup.remove(r);
            }
            connRows = [];
        };

        const renderConnections = () => {
            clearConnRows();
            const list = loadConnections();

            list.forEach((conn, cIdx) => {
                const connExpander = new Adw.ExpanderRow({
                    title: conn.name || `Gerät ${cIdx + 1}`,
                    subtitle: `Host: ${conn.host || '--'} | ${conn.interfaces ? conn.interfaces.length : 0} Schnittstellen`,
                    show_enable_switch: false,
                });

                // Nach oben verschieben Button (▲)
                if (cIdx > 0) {
                    const upBtn = new Gtk.Button({
                        icon_name: 'go-up-symbolic',
                        valign: Gtk.Align.CENTER,
                        has_frame: false,
                        tooltip_text: _('Nach oben verschieben'),
                    });
                    upBtn.connect('clicked', () => {
                        const temp = list[cIdx];
                        list[cIdx] = list[cIdx - 1];
                        list[cIdx - 1] = temp;
                        saveConnections(list);
                        renderConnections();
                    });
                    connExpander.add_suffix(upBtn);
                }

                // Nach unten verschieben Button (▼)
                if (cIdx < list.length - 1) {
                    const downBtn = new Gtk.Button({
                        icon_name: 'go-down-symbolic',
                        valign: Gtk.Align.CENTER,
                        has_frame: false,
                        tooltip_text: _('Nach unten verschieben'),
                    });
                    downBtn.connect('clicked', () => {
                        const temp = list[cIdx];
                        list[cIdx] = list[cIdx + 1];
                        list[cIdx + 1] = temp;
                        saveConnections(list);
                        renderConnections();
                    });
                    connExpander.add_suffix(downBtn);
                }

                // Löschen-Button (nur wenn mehr als 1 Verbindung)
                if (list.length > 1) {
                    const delConnBtn = new Gtk.Button({
                        icon_name: 'user-trash-symbolic',
                        valign: Gtk.Align.CENTER,
                        has_frame: false,
                        tooltip_text: _('Verbindung entfernen'),
                    });
                    delConnBtn.connect('clicked', () => {
                        list.splice(cIdx, 1);
                        saveConnections(list);
                        renderConnections();
                    });
                    connExpander.add_suffix(delConnBtn);
                }

                // --- Felder innerhalb des Expanders ---

                // 1. Verbindungsname
                const nameRow = new Adw.EntryRow({
                    title: _('Verbindungs- / Gerätename'),
                    text: conn.name || '',
                });
                nameRow.connect('changed', (entry) => {
                    conn.name = entry.text;
                    connExpander.title = entry.text || `Gerät ${cIdx + 1}`;
                    saveConnections(list);
                });
                connExpander.add_row(nameRow);

                // 2. Name der aggregierten Leistung
                const aggRow = new Adw.EntryRow({
                    title: _('Name der aggregierten Leistung'),
                    text: conn.aggregated_name || 'Load-Balancer Gesamt',
                });
                aggRow.connect('changed', (entry) => {
                    conn.aggregated_name = entry.text;
                    saveConnections(list);
                });
                connExpander.add_row(aggRow);

                // 3. Host IP
                const hostRow = new Adw.EntryRow({
                    title: _('Router / Host IP'),
                    text: conn.host || '',
                });
                hostRow.connect('changed', (entry) => {
                    conn.host = entry.text;
                    connExpander.subtitle = `Host: ${entry.text} | ${conn.interfaces ? conn.interfaces.length : 0} Schnittstellen`;
                    saveConnections(list);
                });
                connExpander.add_row(hostRow);

                // 4. Community String
                const commRow = new Adw.PasswordEntryRow({
                    title: _('SNMP Community String'),
                    text: conn.community || 'public',
                });
                commRow.connect('changed', (entry) => {
                    conn.community = entry.text;
                    saveConnections(list);
                });
                connExpander.add_row(commRow);

                // 5. SNMP Version
                const verRow = new Adw.ComboRow({
                    title: _('SNMP-Version'),
                    model: Gtk.StringList.new(['v2c', 'v1', 'v3']),
                    selected: conn.version === 'v1' ? 1 : (conn.version === 'v3' ? 2 : 0),
                });
                verRow.connect('notify::selected', () => {
                    const map = ['v2c', 'v1', 'v3'];
                    conn.version = map[verRow.selected];
                    saveConnections(list);
                });
                connExpander.add_row(verRow);

                // --- Schnittstellen-Liste dieser Verbindung ---
                const ifacesHeader = new Adw.ActionRow({
                    title: _('Schnittstellen dieses Geräts'),
                    subtitle: _('Konfigurierte Ports für Traffic-Messung'),
                });
                connExpander.add_row(ifacesHeader);

                if (!conn.interfaces) conn.interfaces = [];

                conn.interfaces.forEach((iface, iIdx) => {
                    const ifaceExpander = new Adw.ExpanderRow({
                        title: iface.name || `Index ${iface.index}`,
                        subtitle: `SNMP ifIndex: ${iface.index}`,
                        show_enable_switch: false,
                    });

                    // Name editieren (Punkt 3)
                    const ifaceNameRow = new Adw.EntryRow({
                        title: _('Schnittstellen-Name'),
                        text: iface.name || '',
                    });
                    ifaceNameRow.connect('changed', (entry) => {
                        iface.name = entry.text;
                        ifaceExpander.title = entry.text || `Index ${iface.index}`;
                        saveConnections(list);
                    });
                    ifaceExpander.add_row(ifaceNameRow);

                    // Graph-Schalter
                    const ifaceGraphRow = new Adw.SwitchRow({
                        title: _('Graph im Dropdown anzeigen'),
                        active: iface.show_graph !== false,
                    });
                    ifaceGraphRow.connect('notify::active', () => {
                        iface.show_graph = ifaceGraphRow.active;
                        saveConnections(list);
                    });
                    ifaceExpander.add_row(ifaceGraphRow);

                    // Schnittstelle löschen
                    const delIfaceRow = new Adw.ActionRow({ title: _('Schnittstelle entfernen') });
                    const delIfaceBtn = new Gtk.Button({
                        icon_name: 'user-trash-symbolic',
                        valign: Gtk.Align.CENTER,
                        has_frame: false,
                    });
                    delIfaceBtn.connect('clicked', () => {
                        conn.interfaces.splice(iIdx, 1);
                        saveConnections(list);
                        renderConnections();
                    });
                    delIfaceRow.add_suffix(delIfaceBtn);
                    ifaceExpander.add_row(delIfaceRow);

                    connExpander.add_row(ifaceExpander);
                });

                // Walk-Discovery für diese Verbindung
                const walkRow = new Adw.ActionRow({
                    title: _('SNMP Walk für dieses Gerät'),
                    subtitle: _('Sucht live alle Schnittstellen auf diesem Host'),
                });
                const walkBtn = new Gtk.Button({
                    label: _('Walk starten'),
                    valign: Gtk.Align.CENTER,
                });
                const spinner = new Gtk.Spinner({
                    valign: Gtk.Align.CENTER,
                    visible: false,
                });
                walkRow.add_suffix(spinner);
                walkRow.add_suffix(walkBtn);
                connExpander.add_row(walkRow);

                // Container für Walk-Ergebnisse
                const walkResultsExpander = new Adw.ExpanderRow({
                    title: _('Gefundene Schnittstellen'),
                    visible: false,
                    show_enable_switch: false,
                });
                connExpander.add_row(walkResultsExpander);

                walkBtn.connect('clicked', () => {
                    walkBtn.sensitive = false;
                    spinner.visible = true;
                    spinner.start();
                    walkResultsExpander.visible = false;

                    try {
                        const proc = Gio.Subprocess.new(
                            ['/usr/bin/python3', backendScript, '--walk', conn.host || '192.0.2.1', conn.community || 'public', conn.version || 'v2c'],
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
                                        const curIndices = new Set((conn.interfaces || []).map(i => i.index));

                                        data.discovered_interfaces.forEach(discIface => {
                                            const discRow = new Adw.ActionRow({
                                                title: discIface.display_name,
                                                subtitle: `Index: ${discIface.index} | Status: ${discIface.is_up ? 'UP' : 'DOWN'} | Speed: ${discIface.speed_mbps} Mbit/s`,
                                            });

                                            const isAdded = curIndices.has(discIface.index);
                                            const addBtn = new Gtk.Button({
                                                label: isAdded ? _('Hinzugefügt') : _('Überwachen'),
                                                sensitive: !isAdded,
                                                valign: Gtk.Align.CENTER,
                                            });

                                            addBtn.connect('clicked', () => {
                                                conn.interfaces.push({
                                                    id: `if_${discIface.index}`,
                                                    name: discIface.alias || discIface.name,
                                                    index: discIface.index,
                                                    icon: discIface.suggested_icon || 'network-wired-symbolic',
                                                    show_graph: true,
                                                });
                                                saveConnections(list);
                                                addBtn.label = _('Hinzugefügt');
                                                addBtn.sensitive = false;
                                                renderConnections();
                                            });

                                            discRow.add_suffix(addBtn);
                                            walkResultsExpander.add_row(discRow);
                                        });

                                        walkResultsExpander.visible = true;
                                        walkResultsExpander.expanded = true;
                                    }
                                }
                            } catch (e) {
                                console.error(`[snmpbar] Fehler bei Discovery: ${e}`);
                            }
                        });
                    } catch (e) {
                        spinner.stop();
                        spinner.visible = false;
                        walkBtn.sensitive = true;
                    }
                });

                connsGroup.add(connExpander);
                connRows.push(connExpander);
            });
        };

        addConnBtn.connect('clicked', () => {
            const list = loadConnections();
            const newId = `conn_${list.length + 1}`;
            list.push({
                id: newId,
                name: `Gerät ${list.length + 1}`,
                aggregated_name: 'Gesamtleistung',
                host: '192.168.1.1',
                community: 'public',
                version: 'v2c',
                interval: 3,
                interfaces: []
            });
            saveConnections(list);
            renderConnections();
        });

        renderConnections();
    }
}
