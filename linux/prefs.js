import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export default class SnmpBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const backendScript = GLib.build_filenamev([this.path, 'snmp_backend.py']);

        // CSS Provider für GTK-Anzeige (Breitere Dropdown-Menüs / Popovers)
        try {
            const cssProvider = new Gtk.CssProvider();
            cssProvider.load_from_string(`
                popover.menu contents {
                    min-width: 440px;
                }
                row.combo .suffixes {
                    min-width: 250px;
                }
            `);
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(),
                cssProvider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );
        } catch (e) {
            console.warn('[snmpbar] Konnte CSS-Provider für Preferences nicht laden:', e);
        }

        // Helper: Farb-Zeile mit Hex-Input und interaktivem Colorpicker-Button (optional mit Alpha)
        const createColorRow = (title, subtitle, key, defaultHex, withAlpha = false) => {
            const row = new Adw.ActionRow({
                title: title,
                subtitle: subtitle,
            });

            const currentHex = settings.get_string(key) || defaultHex;

            const entry = new Gtk.Entry({
                text: currentHex,
                max_length: withAlpha ? 9 : 7,
                width_chars: withAlpha ? 10 : 8,
                valign: Gtk.Align.CENTER,
            });

            const dialog = new Gtk.ColorDialog({ with_alpha: withAlpha });
            const colorBtn = new Gtk.ColorDialogButton({
                dialog: dialog,
                valign: Gtk.Align.CENTER,
            });

            const parseHexToRgba = (hex) => {
                if (!hex) return null;
                const h = hex.trim();
                if (h === 'transparent' || h === 'none') {
                    const rgba = new Gdk.RGBA();
                    rgba.red = rgba.green = rgba.blue = rgba.alpha = 0;
                    return rgba;
                }
                if (h.startsWith('#')) {
                    if (h.length === 9) { // #rrggbbaa
                        const r = parseInt(h.slice(1, 3), 16) / 255.0;
                        const g = parseInt(h.slice(3, 5), 16) / 255.0;
                        const b = parseInt(h.slice(5, 7), 16) / 255.0;
                        const a = parseInt(h.slice(7, 9), 16) / 255.0;
                        const rgba = new Gdk.RGBA();
                        rgba.red = r; rgba.green = g; rgba.blue = b; rgba.alpha = a;
                        return rgba;
                    } else if (h.length === 7) { // #rrggbb
                        const rgba = new Gdk.RGBA();
                        if (rgba.parse(h)) return rgba;
                    }
                }
                return null;
            };

            const updateButtonFromHex = (hex) => {
                const rgba = parseHexToRgba(hex);
                if (rgba) {
                    colorBtn.set_rgba(rgba);
                }
            };

            updateButtonFromHex(currentHex);

            entry.connect('changed', () => {
                const hex = entry.text.trim();
                const rgba = parseHexToRgba(hex);
                if (rgba) {
                    settings.set_string(key, hex);
                    colorBtn.set_rgba(rgba);
                }
            });

            colorBtn.connect('notify::rgba', () => {
                const rgba = colorBtn.get_rgba();
                const r = Math.round(rgba.red * 255).toString(16).padStart(2, '0');
                const g = Math.round(rgba.green * 255).toString(16).padStart(2, '0');
                const b = Math.round(rgba.blue * 255).toString(16).padStart(2, '0');
                let hex = `#${r}${g}${b}`;
                if (withAlpha) {
                    const a = Math.round(rgba.alpha * 255).toString(16).padStart(2, '0');
                    hex = `#${r}${g}${b}${a}`;
                }
                entry.text = hex;
                settings.set_string(key, hex);
            });

            row.add_suffix(entry);
            row.add_suffix(colorBtn);
            return row;
        };

        // Helper: Connections laden & speichern
        const loadConnections = () => {
            try {
                const raw = settings.get_string('connections-json');
                const list = JSON.parse(raw);
                if (Array.isArray(list) && list.length > 0) return list;
            } catch (e) {}

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

        let cachedOrbDevices = null;

        const loadOrbDevices = () => {
            if (cachedOrbDevices && cachedOrbDevices.length > 0) {
                return cachedOrbDevices;
            }
            const devFile = '/dev/shm/snmpbar_orb_cache.json';
            const devSet = new Map();
            if (GLib.file_test(devFile, GLib.FileTest.EXISTS)) {
                try {
                    const [ok, content] = GLib.file_get_contents(devFile);
                    if (ok) {
                        const json = JSON.parse(new TextDecoder().decode(content));
                        for (const k of Object.keys(json)) {
                            const d = json[k];
                            if (d && d.name && !devSet.has(d.name)) {
                                devSet.set(d.name, {
                                    id: d.orb_id || d.name,
                                    name: d.name,
                                    is_connected: d.is_connected !== false,
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`[snmpbar] Fehler beim Lesen von ${devFile}: ${e}`);
                }
            }
            const arr = Array.from(devSet.values());
            if (arr.length > 0) cachedOrbDevices = arr;
            return arr;
        };

        const refreshOrbDevices = (onDone) => {
            const token = settings.get_string('orb-api-token') || '';
            if (!token) {
                if (onDone) onDone([]);
                return;
            }
            try {
                const proc = Gio.Subprocess.new(
                    ['/usr/bin/python3', backendScript, '--list-orbs', token],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.communicate_utf8_async(null, null, (source, res) => {
                    try {
                        const [, stdout] = source.communicate_utf8_finish(res);
                        if (stdout) {
                            const list = JSON.parse(stdout);
                            if (Array.isArray(list) && list.length > 0) {
                                cachedOrbDevices = list;
                            }
                            if (onDone) onDone(list);
                            return;
                        }
                    } catch (e) {
                        console.warn(`[snmpbar] Fehler bei --list-orbs: ${e}`);
                    }
                    if (onDone) onDone([]);
                });
            } catch (err) {
                console.warn(`[snmpbar] Fehler beim Start von --list-orbs: ${err}`);
                if (onDone) onDone([]);
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

        // Top-Bar Quelle auswählen
        const conns = loadConnections();
        const sourceKeys = [];
        const sourceLabels = [];

        conns.forEach(c => {
            const hasAgg = typeof c.show_aggregated === 'boolean'
                ? c.show_aggregated
                : ((c.interfaces || []).length > 1);

            if (hasAgg) {
                sourceKeys.push(`${c.id}:total`);
                if (conns.length > 1) {
                    sourceLabels.push(`${c.aggregated_name || 'Gesamtsumme'} — [${c.name}]`);
                } else {
                    sourceLabels.push(`${c.aggregated_name || 'Gesamtsumme'}`);
                }
            }

            (c.interfaces || []).forEach(iface => {
                sourceKeys.push(`if_${iface.index}`);
                if (conns.length > 1) {
                    sourceLabels.push(`${iface.name} — [${c.name}]`);
                } else {
                    sourceLabels.push(`${iface.name}`);
                }
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

        // Position: Rechts, Mitte, Links
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

        // Abfrage-Intervall
        const intervalRow = new Adw.SpinRow({
            title: _('Abfrage-Intervall (Sekunden)'),
            subtitle: _('Häufigkeit der SNMP-Aktualisierung (1 bis 60 Sekunden)'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(intervalRow);

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

        // --- Gruppe 2: Einheiten-Formatierung (Punkt c) ---
        const unitGroup = new Adw.PreferencesGroup({
            title: _('Einheiten & Formatierung'),
            description: _('Wähle die gewünschte Darstellung der Durchsatzwerte'),
        });
        displayPage.add(unitGroup);

        const unitModel = Gtk.StringList.new([
            _('Beides: Bits und Bytes (z. B. Mbit und MB)'),
            _('Nur Bits (kbit, Mbit, Gbit)'),
            _('Nur Bytes (KB, MB, GB)')
        ]);
        const curUnit = settings.get_string('unit-display') || 'both';
        let unitIdx = 0;
        if (curUnit === 'bits') unitIdx = 1;
        else if (curUnit === 'bytes') unitIdx = 2;

        const unitRow = new Adw.ComboRow({
            title: _('Einheiten-Auswahl'),
            subtitle: _('Wähle zwischen Bits, Bytes oder beidem'),
            model: unitModel,
            selected: unitIdx,
        });
        unitRow.connect('notify::selected', () => {
            const map = ['both', 'bits', 'bytes'];
            settings.set_string('unit-display', map[unitRow.selected]);
        });
        unitGroup.add(unitRow);

        const formatModel = Gtk.StringList.new([
            _('Variante A: Ultra-kompakt (z. B. 10.6 M / 6.3 M)'),
            _('Variante B: Kompakte IT-Norm (z. B. 10.6 Mb / 6.3 Mb)'),
            _('Variante C: Schlankes Vollformat (z. B. 10.6 Mbit / 6.3 Mbit)')
        ]);
        const curFormat = settings.get_string('bar-unit-format') || 'compact';
        let formatIdx = 0;
        if (curFormat === 'short') formatIdx = 1;
        else if (curFormat === 'full') formatIdx = 2;

        const formatRow = new Adw.ComboRow({
            title: _('Top-Bar Darstellungsformat'),
            subtitle: _('Format der Einheiten in der Menüleiste (ohne /s oder /sec)'),
            model: formatModel,
            selected: formatIdx,
        });
        formatRow.connect('notify::selected', () => {
            const map = ['compact', 'short', 'full'];
            settings.set_string('bar-unit-format', map[formatRow.selected]);
        });
        unitGroup.add(formatRow);

        // --- Gruppe 3: Dropdown-Menü Einstellungen ---
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

        const showUptimeRow = new Adw.SwitchRow({
            title: _('Geräte-Laufzeit (Uptime) anzeigen'),
            subtitle: _('Zeigt die Betriebszeit im Menü-Header (z. B. „Online seit 16 Tagen, 7 Std.“)'),
        });
        settings.bind('show-uptime', showUptimeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(showUptimeRow);

        const showGatewayIpRow = new Adw.SwitchRow({
            title: _('Interne Gateway-IP anzeigen'),
            subtitle: _('Zeigt die IP-Adresse des Routers im Kopf der Standort-Karte (z. B. „(192.0.2.1)“)'),
        });
        settings.bind('show-gateway-ip', showGatewayIpRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(showGatewayIpRow);

        const showIfaceUptimeRow = new Adw.SwitchRow({
            title: _('Leitungs-Laufzeit der Schnittstellen anzeigen'),
            subtitle: _('Zeigt bei jeder aktiven Leitung die Online-Dauer (z. B. „seit 3 Tagen, 6 Std.“)'),
        });
        settings.bind('show-iface-uptime', showIfaceUptimeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(showIfaceUptimeRow);

        const showHoverPopoutRow = new Adw.SwitchRow({
            title: _('Detail-Popout bei Graph-Hover anzeigen'),
            subtitle: _('Öffnet ein schwebendes Fenster mit zwei skalierten Graphen, WAN-IP, CGNAT & Sync/QoS'),
        });
        settings.bind('show-hover-popout', showHoverPopoutRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(showHoverPopoutRow);

        // ==========================================
        // SEITE 2: Farbdarstellung
        // ==========================================
        const colorPage = new Adw.PreferencesPage({
            title: _('Farbdarstellung'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(colorPage);

        // Gruppe 1: GNOME Top-Bar Farben
        const barColorGroup = new Adw.PreferencesGroup({
            title: _('GNOME Top-Bar'),
            description: _('Farben für Text und Mini-Sparkline im oberen Panel'),
        });
        colorPage.add(barColorGroup);

        barColorGroup.add(createColorRow(
            _('Top-Bar Download-Textfarbe'),
            _('Standard: Weiß für dunkle Menüleiste'),
            'bar-color-download',
            '#ffffff',
            false
        ));

        barColorGroup.add(createColorRow(
            _('Top-Bar Upload-Textfarbe'),
            _('Standard: Extrem helles Grau'),
            'bar-color-upload',
            '#d0d0d0',
            false
        ));

        barColorGroup.add(createColorRow(
            _('Top-Bar Mini-Graph Download'),
            _('Farbe der Sparkline-Verlaufskurve in der Leiste'),
            'bar-graph-color-download',
            '#3584e4',
            false
        ));

        barColorGroup.add(createColorRow(
            _('Top-Bar Mini-Graph Upload'),
            _('Farbe der Sparkline-Verlaufskurve in der Leiste'),
            'bar-graph-color-upload',
            '#33d17a',
            false
        ));

        barColorGroup.add(createColorRow(
            _('Top-Bar Mini-Graph Hintergrund'),
            _('Hintergrundfarbe oder Transparenz der Sparkline-Box'),
            'bar-graph-bg-color',
            '#00000040',
            true
        ));

        // Gruppe 2: Dropdown-Menü Farben (Helles Design)
        const dropLightColorGroup = new Adw.PreferencesGroup({
            title: _('Dropdown-Menü (Helles Design)'),
            description: _('Farben bei aktivem hellen GNOME-Design (helle Menüoberfläche)'),
        });
        colorPage.add(dropLightColorGroup);

        dropLightColorGroup.add(createColorRow(
            _('Schriftfarbe (Hell)'),
            _('Textfarbe für hellen Menühintergrund (Standard: Dunkel/Schwarz)'),
            'menu-text-color',
            '#1a1a1a',
            false
        ));

        dropLightColorGroup.add(createColorRow(
            _('Graph Download (Hell)'),
            _('Farbe der Download-Verlaufskurven im hellen Menü'),
            'dropdown-graph-color-download',
            '#3584e4',
            false
        ));

        dropLightColorGroup.add(createColorRow(
            _('Graph Upload (Hell)'),
            _('Farbe der Upload-Verlaufskurven im hellen Menü'),
            'dropdown-graph-color-upload',
            '#33d17a',
            false
        ));

        dropLightColorGroup.add(createColorRow(
            _('Graph Hintergrund (Hell)'),
            _('Hintergrundfarbe oder Transparenz der Verlaufskurven (Standard: Dezent dunkel/transparent)'),
            'dropdown-graph-bg-color',
            '#00000018',
            true
        ));

        dropLightColorGroup.add(createColorRow(
            _('Standort-Box Rahmen (Hell)'),
            _('Rahmenfarbe der Kacheln im hellen Menü (inkl. Transparenz)'),
            'dropdown-card-border-color',
            '#00000022',
            true
        ));

        dropLightColorGroup.add(createColorRow(
            _('Standort-Box Hintergrund (Hell)'),
            _('Optionale Hintergrundfarbe oder Transparenz der Kacheln (Standard: transparent)'),
            'dropdown-card-bg-color',
            '#00000000',
            true
        ));

        dropLightColorGroup.add(createColorRow(
            _('Graph Hover-Abdunklung (Hell)'),
            _('Überlagerungsfarbe und Transparenz bei Maus-Hover über einen Graphen'),
            'dropdown-hover-dim-color',
            '#00000025',
            true
        ));

        // Gruppe 3: Dropdown-Menü Farben (Dunkles Design)
        const dropDarkColorGroup = new Adw.PreferencesGroup({
            title: _('Dropdown-Menü (Dunkles Design)'),
            description: _('Farben bei aktivem dunklen GNOME-Design (dunkle Menüoberfläche)'),
        });
        colorPage.add(dropDarkColorGroup);

        dropDarkColorGroup.add(createColorRow(
            _('Schriftfarbe (Dunkel)'),
            _('Textfarbe für dunklen Menühintergrund (Standard: Fast Weiß)'),
            'dropdown-dark-text-color',
            '#f6f6f6',
            false
        ));

        dropDarkColorGroup.add(createColorRow(
            _('Graph Download (Dunkel)'),
            _('Farbe der Download-Verlaufskurven im dunklen Menü'),
            'dropdown-dark-graph-color-download',
            '#3584e4',
            false
        ));

        dropDarkColorGroup.add(createColorRow(
            _('Graph Upload (Dunkel)'),
            _('Farbe der Upload-Verlaufskurven im dunklen Menü'),
            'dropdown-dark-graph-color-upload',
            '#33d17a',
            false
        ));

        dropDarkColorGroup.add(createColorRow(
            _('Graph Hintergrund (Dunkel)'),
            _('Hintergrundfarbe oder Transparenz der Verlaufskurven (Standard: Dezent abgedunkeltes Inset)'),
            'dropdown-dark-graph-bg-color',
            '#00000040',
            true
        ));

        dropDarkColorGroup.add(createColorRow(
            _('Standort-Box Rahmen (Dunkel)'),
            _('Rahmenfarbe der Kacheln im dunklen Menü (inkl. Transparenz)'),
            'dropdown-dark-card-border-color',
            '#ffffff25',
            true
        ));

        dropDarkColorGroup.add(createColorRow(
            _('Standort-Box Hintergrund (Dunkel)'),
            _('Optionale Hintergrundfarbe oder Transparenz der Kacheln (Standard: transparent)'),
            'dropdown-dark-card-bg-color',
            '#00000000',
            true
        ));

        dropDarkColorGroup.add(createColorRow(
            _('Graph Hover-Abdunklung (Dunkel)'),
            _('Überlagerungsfarbe und Transparenz bei Maus-Hover über einen Graphen'),
            'dropdown-dark-hover-dim-color',
            '#ffffff20',
            true
        ));

        // ==========================================
        // SEITE 3: SNMP-Verbindungen & Schnittstellen
        // ==========================================
        const snmpPage = new Adw.PreferencesPage({
            title: _('SNMP & Schnittstellen'),
            icon_name: 'network-workgroup-symbolic',
        });
        window.add(snmpPage);

        const headerGroup = new Adw.PreferencesGroup({
            title: _('SNMP-Geräte & Verbindungen'),
            description: _('Hinterlege ein oder mehrere Gateways/Router und deren Schnittstellen'),
        });
        snmpPage.add(headerGroup);

        const addConnRow = new Adw.ActionRow({
            title: _('Neues SNMP-Gerät hinzufügen'),
            subtitle: _('Erstelle eine weitere SNMP-Verbindung für Router / Gateways'),
        });
        const addConnBtn = new Gtk.Button({
            label: _('+ Router hinzufügen'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addConnRow.add_suffix(addConnBtn);
        headerGroup.add(addConnRow);

        const localHostName = GLib.get_host_name() || 'Lokaler PC';
        const addLocalRow = new Adw.ActionRow({
            title: _(`Lokaler Rechner (${localHostName})`),
            subtitle: _('Lokale Schnittstellen (Ethernet, WLAN, 5G) direkt ohne SNMP überwachen'),
        });
        const addLocalBtn = new Gtk.Button({
            label: _(`+ ${localHostName} hinzufügen`),
            icon_name: 'computer-symbolic',
            valign: Gtk.Align.CENTER,
        });
        addLocalRow.add_suffix(addLocalBtn);
        headerGroup.add(addLocalRow);

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

                // 2b. Schalter für Aggregierte Gesamtleistung
                const defaultAggActive = typeof conn.show_aggregated === 'boolean'
                    ? conn.show_aggregated
                    : ((conn.interfaces || []).length > 1);

                const showAggRow = new Adw.SwitchRow({
                    title: _('Aggregierte Gesamtleistung anzeigen'),
                    subtitle: _('Summenzeile & Summengraph aller Schnittstellen (empfohlen bei mehreren Schnittstellen)'),
                    active: defaultAggActive,
                });
                aggRow.set_sensitive(showAggRow.active);

                showAggRow.connect('notify::active', () => {
                    conn.show_aggregated = showAggRow.active;
                    aggRow.set_sensitive(showAggRow.active);
                    saveConnections(list);
                });
                connExpander.add_row(showAggRow);

                // 2c. Zugeordneter ORB-Sensor (Dropdown-Auswahl)
                const knownOrbs = loadOrbDevices();
                const orbLabels = [_('— Kein ORB-Sensor —')];
                const orbValues = [''];

                for (const o of knownOrbs) {
                    const statusDot = o.is_connected ? '●' : '○';
                    orbLabels.push(`${o.name}  ${statusDot}`);
                    orbValues.push(o.name);
                }

                let curOrbIdx = orbValues.indexOf(conn.orb_name || '');
                if (curOrbIdx < 0 && conn.orb_name) {
                    const base = conn.orb_name.split('(')[0].trim().toLowerCase();
                    for (let i = 1; i < orbValues.length; i++) {
                        const valBase = orbValues[i].split('(')[0].trim().toLowerCase();
                        if (valBase === base) {
                            curOrbIdx = i;
                            break;
                        }
                    }
                }

                if (curOrbIdx < 0 && conn.orb_name) {
                    orbLabels.push(conn.orb_name);
                    orbValues.push(conn.orb_name);
                    curOrbIdx = orbValues.length - 1;
                } else if (curOrbIdx < 0) {
                    curOrbIdx = 0;
                }

                const orbModel = Gtk.StringList.new(orbLabels);
                const orbComboRow = new Adw.ComboRow({
                    title: _('Zugeordneter ORB-Sensor'),
                    subtitle: _('Wähle den an diesem Standort aktiven ORB-Sensor aus'),
                    model: orbModel,
                    selected: curOrbIdx,
                });
                orbComboRow.connect('notify::selected', () => {
                    conn.orb_name = orbValues[orbComboRow.selected] || '';
                    saveConnections(list);
                });
                connExpander.add_row(orbComboRow);

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

                    // Minimalistische GNOME-Symbolic-Icon-Auswahl
                    const MINIMAL_ICONS = [
                        { id: 'network-wired-symbolic', label: _('Kabel / DSL / Ethernet') },
                        { id: 'network-cellular-signal-excellent-symbolic', label: _('5G / LTE / Mobilfunk') },
                        { id: 'network-transmit-receive-symbolic', label: _('Glasfaser / Fiber / SFP') },
                        { id: 'network-wireless-symbolic', label: _('WLAN / Wi-Fi') },
                        { id: 'network-vpn-symbolic', label: _('VPN / Tunnel') },
                        { id: 'computer-symbolic', label: _('Lokaler Computer / PC') },
                        { id: 'security-high-symbolic', label: _('Firewall / Schutz') },
                        { id: 'drive-harddisk-symbolic', label: _('Server / Storage') },
                        { id: 'applications-internet-symbolic', label: _('Internet / WAN') },
                    ];

                    const curIcon = iface.icon || 'network-wired-symbolic';
                    let selIconIdx = MINIMAL_ICONS.findIndex(i => i.id === curIcon);
                    if (selIconIdx < 0) selIconIdx = 0;

                    const iconListModel = Gtk.StringList.new(MINIMAL_ICONS.map(i => i.label));
                    const iconComboRow = new Adw.ComboRow({
                        title: _('Symbol / Icon'),
                        subtitle: _('Minimalistisches GNOME-Symbolic-Icon für diese Leitung'),
                        model: iconListModel,
                        selected: selIconIdx,
                    });

                    const iconPreview = new Gtk.Image({
                        icon_name: curIcon,
                        pixel_size: 18,
                        valign: Gtk.Align.CENTER,
                    });
                    iconComboRow.add_suffix(iconPreview);

                    iconComboRow.connect('notify::selected', () => {
                        const picked = MINIMAL_ICONS[iconComboRow.selected];
                        if (picked) {
                            iface.icon = picked.id;
                            iconPreview.set_from_icon_name(picked.id);
                            saveConnections(list);
                        }
                    });
                    ifaceExpander.add_row(iconComboRow);

                    const ifaceGraphRow = new Adw.SwitchRow({
                        title: _('Graph im Dropdown anzeigen'),
                        active: iface.show_graph !== false,
                    });
                    ifaceGraphRow.connect('notify::active', () => {
                        iface.show_graph = ifaceGraphRow.active;
                        saveConnections(list);
                    });
                    ifaceExpander.add_row(ifaceGraphRow);

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

                // Walk-Discovery
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
                                                subtitle: `Index: ${discIface.index} | Status: ${discIface.is_up ? '{Online}' : '{Offline}'} | Speed: ${discIface.speed_mbps} Mbit`,
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

        addLocalBtn.connect('clicked', () => {
            const list = loadConnections();
            const newId = `local_${Date.now()}`;
            list.push({
                id: newId,
                name: localHostName,
                aggregated_name: `${localHostName} Gesamt`,
                host: 'localhost',
                community: 'public',
                version: 'v2c',
                is_local: true,
                interval: 2,
                interfaces: [
                    {
                        id: 'eth_enp7s0',
                        name: 'Ethernet',
                        index: 'enp7s0',
                        icon: 'network-wired-symbolic',
                        show_graph: true
                    },
                    {
                        id: 'wifi_wlo1',
                        name: 'WLAN',
                        index: 'wlo1',
                        icon: 'network-wireless-symbolic',
                        show_graph: true
                    }
                ]
            });
            saveConnections(list);
            renderConnections();
        });

        renderConnections();

        // ==========================================
        // SEITE 4: Sicherheit & Speedtest
        // ==========================================
        const toolsPage = new Adw.PreferencesPage({
            title: _('Sicherheit & Speedtest'),
            icon_name: 'security-high-symbolic',
        });
        window.add(toolsPage);

        // Gruppe 1: IP-Reputation & Bot-Erkennung
        const repGroup = new Adw.PreferencesGroup({
            title: _('Bot- & IP-Reputationsprüfung'),
            description: _('Automatische Prüfung externer WAN-IPs gegen Botnet-, Malware- und Brute-Force-Listen'),
        });
        toolsPage.add(repGroup);

        const repSwitch = new Adw.SwitchRow({
            title: _('IP-Reputationsprüfung aktivieren'),
            subtitle: _('Prüft externe IPs im 4h-Cache über Blocklist.de, StopForumSpam, DroneBL, Spamhaus und Barracuda'),
            active: settings.get_boolean('enable-ip-reputation'),
        });
        repSwitch.connect('notify::active', () => {
            settings.set_boolean('enable-ip-reputation', repSwitch.active);
        });
        repGroup.add(repSwitch);

        const apiKeyRow = new Adw.EntryRow({
            title: _('APIVoid API-Schlüssel (Optional)'),
            text: settings.get_string('apivoid-api-key') || '',
            show_apply_button: true,
        });
        apiKeyRow.connect('apply', () => {
            settings.set_string('apivoid-api-key', apiKeyRow.text.trim());
        });
        repGroup.add(apiKeyRow);

        // Gruppe 2: Ookla Speedtest
        const speedtestGroup = new Adw.PreferencesGroup({
            title: _('Speedtest (Ookla CLI)'),
            description: _('Manueller Bandbreitentest für das primäre Gateway direkt im Dropdown-Menü'),
        });
        toolsPage.add(speedtestGroup);

        const ooklaInstalled = GLib.find_program_in_path('speedtest') !== null ||
            GLib.file_test(GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'speedtest']), GLib.FileTest.IS_EXECUTABLE);

        const stStatusRow = new Adw.ActionRow({
            title: _('Ookla Speedtest CLI Status'),
            subtitle: ooklaInstalled
                ? _('Installiert und einsatzbereit (~/.local/bin/speedtest)')
                : _('Nicht gefunden. Kann über ./install_speedtest.sh installiert werden.'),
        });
        const stBadge = new Gtk.Label({
            label: ooklaInstalled ? _('Bereit') : _('Fehlt'),
            css_classes: [ooklaInstalled ? 'success' : 'warning'],
            valign: Gtk.Align.CENTER,
        });
        stStatusRow.add_suffix(stBadge);
        speedtestGroup.add(stStatusRow);

        const stInfoRow = new Adw.ActionRow({
            title: _('Manueller Aufruf'),
            subtitle: _('Der Speedtest wird niemals automatisch ausgeführt, sondern ausschließlich bei manuellem Klick auf "Speedtest durchführen" im Menü.'),
        });
        speedtestGroup.add(stInfoRow);

        // Gruppe 3: ORB Cloud Integration
        const orbGroup = new Adw.PreferencesGroup({
            title: _('ORB Cloud Integration (orb.net)'),
            description: _('Automatische Abfrage von Netzwerk-Experience, Latenz und Stabilität über die zentrale ORB Cloud'),
        });
        toolsPage.add(orbGroup);

        const orbTokenRow = new Adw.PasswordEntryRow({
            title: _('ORB Cloud API-Token (Bearer Token)'),
            text: settings.get_string('orb-api-token') || '',
        });
        orbTokenRow.connect('changed', () => {
            settings.set_string('orb-api-token', orbTokenRow.text.trim());
        });
        orbGroup.add(orbTokenRow);

        // Zeitfenster für ORB-Scores (5m, 1h, 24h, 1m)
        const TIMESPAN_OPTIONS = [
            { id: '24h', label: _('24 Stunden (24h) — Standard / Ausgeglichen') },
            { id: '1h', label: _('1 Stunde (1h) — Mittelfristig') },
            { id: '5m', label: _('5 Minuten (5m) — Kurzfristig / Reaktiv') },
            { id: '1m', label: _('1 Minute (1m) — Live / Echtzeit') },
        ];
        const curTimespan = settings.get_string('orb-timespan') || '24h';
        let selTimespanIdx = TIMESPAN_OPTIONS.findIndex(t => t.id === curTimespan);
        if (selTimespanIdx < 0) selTimespanIdx = 0;

        const timespanModel = Gtk.StringList.new(TIMESPAN_OPTIONS.map(t => t.label));
        const timespanRow = new Adw.ComboRow({
            title: _('Berechnungszeitfenster für Orbscores'),
            subtitle: _('Zeitraum für Gesamt-Score, Responsiveness, Zuverlässigkeit und Speed'),
            model: timespanModel,
            selected: selTimespanIdx,
        });
        timespanRow.connect('notify::selected', () => {
            const picked = TIMESPAN_OPTIONS[timespanRow.selected];
            if (picked) {
                settings.set_string('orb-timespan', picked.id);
            }
        });
        orbGroup.add(timespanRow);

        const fetchOrbsRow = new Adw.ActionRow({
            title: _('ORB-Sensoren synchronisieren'),
            subtitle: _('Ruft alle in der Organisation registrierten Sensoren ab und aktualisiert die Auswahllisten'),
        });
        const fetchOrbsBtn = new Gtk.Button({
            label: _('Sensoren laden'),
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
        });
        const orbSyncSpinner = new Gtk.Spinner({
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        fetchOrbsRow.add_suffix(orbSyncSpinner);
        fetchOrbsRow.add_suffix(fetchOrbsBtn);

        fetchOrbsBtn.connect('clicked', () => {
            fetchOrbsBtn.sensitive = false;
            orbSyncSpinner.visible = true;
            orbSyncSpinner.start();
            fetchOrbsRow.subtitle = _('Sensoren werden aus der ORB Cloud abgerufen...');

            refreshOrbDevices((devs) => {
                orbSyncSpinner.stop();
                orbSyncSpinner.visible = false;
                fetchOrbsBtn.sensitive = true;
                if (devs && devs.length > 0) {
                    fetchOrbsRow.subtitle = _(`${devs.length} Sensor(en) erfolgreich synchronisiert und verfügbar.`);
                } else {
                    fetchOrbsRow.subtitle = _('Keine Sensoren gefunden oder API-Token ungültig.');
                }
                renderConnections();
            });
        });
        orbGroup.add(fetchOrbsRow);

        const orbInfoRow = new Adw.ActionRow({
            title: _('Sensor-Auswahl & Zuordnung'),
            subtitle: _('Nach dem Laden der Sensoren können diese im Reiter „SNMP & Schnittstellen“ direkt per Auswahlliste dem jeweiligen Gateway zugeordnet werden.'),
        });
        orbGroup.add(orbInfoRow);

        // Automatisches Vorladen der Sensoren im Hintergrund beim Öffnen der Einstellungen
        if (settings.get_string('orb-api-token')) {
            refreshOrbDevices((devs) => {
                if (devs && devs.length > 0) {
                    renderConnections();
                }
            });
        }
    }
}
