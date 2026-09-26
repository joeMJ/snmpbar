import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const MAX_HISTORY = 25;

// Cairo Sparkline Graph mit anpassbarer Breite, Höhe und Hex-Farben
const SparklineGraph = GObject.registerClass(
class SparklineGraph extends St.DrawingArea {
    _init(width = 46, height = 20) {
        super._init({
            width,
            height,
            style: 'margin-left: 2px; margin-right: 2px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rxHistory = [];
        this._txHistory = [];
        this._rxColor = [0.21, 0.52, 0.89, 0.95];
        this._txColor = [0.20, 0.82, 0.48, 0.95];
        this._bgColor = [0, 0, 0, 0.25];
    }

    setColors(rxHex, txHex, bgHex = null) {
        this._rxColor = this._hexToRgba(rxHex, 0.95);
        this._txColor = this._hexToRgba(txHex, 0.95);
        if (bgHex !== null) {
            this._bgColor = this._hexToRgba(bgHex, 0.25);
        }
        this.queue_repaint();
    }

    setHistory(rxList, txList) {
        this._rxHistory = [...rxList];
        this._txHistory = [...txList];
        this.queue_repaint();
    }

    _hexToRgba(hex, alpha = 1.0) {
        if (!hex || hex === 'transparent' || hex === 'none') {
            return [0, 0, 0, 0];
        }
        if (!hex.startsWith('#')) {
            return [0.5, 0.5, 0.5, alpha];
        }
        if (hex.length === 9) {
            const r = parseInt(hex.slice(1, 3), 16) / 255.0;
            const g = parseInt(hex.slice(3, 5), 16) / 255.0;
            const b = parseInt(hex.slice(5, 7), 16) / 255.0;
            const a = parseInt(hex.slice(7, 9), 16) / 255.0;
            return [r, g, b, a];
        }
        if (hex.length >= 7) {
            const r = parseInt(hex.slice(1, 3), 16) / 255.0;
            const g = parseInt(hex.slice(3, 5), 16) / 255.0;
            const b = parseInt(hex.slice(5, 7), 16) / 255.0;
            return [r, g, b, alpha];
        }
        return [0.5, 0.5, 0.5, alpha];
    }

    addSample(rx, tx) {
        this._rxHistory.push(rx);
        if (this._rxHistory.length > MAX_HISTORY) this._rxHistory.shift();

        this._txHistory.push(tx);
        if (this._txHistory.length > MAX_HISTORY) this._txHistory.shift();

        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();

        if (this._bgColor && this._bgColor[3] > 0.001) {
            cr.setSourceRGBA(...this._bgColor);
            cr.rectangle(0, 0, w, h);
            cr.fill();
        }

        if (this._rxHistory.length < 2) return;

        const maxVal = Math.max(
            ...this._rxHistory,
            ...this._txHistory,
            50000
        );

        const step = w / (MAX_HISTORY - 1);

        // Download
        cr.setLineWidth(1.8);
        cr.setSourceRGBA(...this._rxColor);
        const rxOffset = MAX_HISTORY - this._rxHistory.length;
        for (let i = 0; i < this._rxHistory.length; i++) {
            const x = (rxOffset + i) * step;
            const y = h - (this._rxHistory[i] / maxVal) * (h - 2) - 1;
            if (i === 0) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
        cr.stroke();

        // Upload
        cr.setLineWidth(1.4);
        cr.setSourceRGBA(...this._txColor);
        const txOffset = MAX_HISTORY - this._txHistory.length;
        for (let i = 0; i < this._txHistory.length; i++) {
            const x = (txOffset + i) * step;
            const y = h - (this._txHistory[i] / maxVal) * (h - 2) - 1;
            if (i === 0) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
        cr.stroke();

        cr.$dispose();
    }
});

export default class SnmpBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._timeoutId = null;
        this._isPolling = false;
        this._backendScript = GLib.build_filenamev([this.path, 'snmp_backend.py']);

        this._histories = {};

        // Dark-Mode Erkennung über GNOME Interface Settings
        try {
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            this._interfaceSettingsChangedId = this._interfaceSettings.connect('changed::color-scheme', () => {
                this._updateColors();
            });
        } catch (e) {
            this._interfaceSettings = null;
            this._interfaceSettingsChangedId = null;
        }

        this._buildIndicator();
        this._schedulePoll(1);

        this._settingsChangedId = this._settings.connect('changed', (s, key) => {
            if (key === 'panel-position') {
                this._repositionIndicator();
            } else if (key.includes('color')) {
                this._updateColors();
            } else if (key === 'unit-display' || key === 'bar-unit-format') {
                this._applyLayoutClasses();
            }
            this._schedulePoll(1);
        });

        console.log(`[snmpbar] Extension ${this.uuid} aktiviert.`);
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._interfaceSettings && this._interfaceSettingsChangedId) {
            this._interfaceSettings.disconnect(this._interfaceSettingsChangedId);
            this._interfaceSettingsChangedId = null;
        }
        this._interfaceSettings = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
        console.log(`[snmpbar] Extension ${this.uuid} deaktiviert.`);
    }

    _getStr(key, fallback = '') {
        try {
            if (this._settings && this._settings.settings_schema && this._settings.settings_schema.has_key(key)) {
                return this._settings.get_string(key);
            }
        } catch (e) {}
        return fallback;
    }

    _getBool(key, fallback = false) {
        try {
            if (this._settings && this._settings.settings_schema && this._settings.settings_schema.has_key(key)) {
                return this._settings.get_boolean(key);
            }
        } catch (e) {}
        return fallback;
    }

    _getInt(key, fallback = 3) {
        try {
            if (this._settings && this._settings.settings_schema && this._settings.settings_schema.has_key(key)) {
                return this._settings.get_int(key);
            }
        } catch (e) {}
        return fallback;
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        this._panelBox = new St.BoxLayout({
            style_class: 'snmpbar-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
            vertical: false,
        });

        this._mainIcon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelBox.add_child(this._mainIcon);

        this._labelBox = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._downLabel = new St.Label({
            text: '↓ --.-',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._upLabel = new St.Label({
            text: '↑ --.-',
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (this._downLabel.clutter_text) {
            this._downLabel.clutter_text.set_line_wrap(false);
            this._downLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        }
        if (this._upLabel.clutter_text) {
            this._upLabel.clutter_text.set_line_wrap(false);
            this._upLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        }

        this._labelBox.add_child(this._downLabel);
        this._labelBox.add_child(this._upLabel);
        this._panelBox.add_child(this._labelBox);

        this._sparkline = new SparklineGraph(46, 20);
        this._panelBox.add_child(this._sparkline);

        this._indicator.add_child(this._panelBox);

        this._applyLayoutClasses();
        this._updateColors();
        this._addToPanel();
    }

    _addToPanel() {
        const pos = this._getStr('panel-position', 'right');
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, pos);
    }

    _repositionIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._buildIndicator();
    }

    _applyLayoutClasses() {
        const unitMode = this._getStr('unit-display', 'both');
        const unitFmt = this._getStr('bar-unit-format', 'compact');

        if (this._labelBox) {
            this._labelBox.set_style_class_name(
                `snmpbar-label-box snmpbar-box-${unitFmt} snmpbar-boxmode-${unitMode}`
            );
        }
        if (this._downLabel) {
            this._downLabel.set_style_class_name(
                `snmpbar-down-label snmpbar-fmt-${unitFmt} snmpbar-mode-${unitMode}`
            );
        }
        if (this._upLabel) {
            this._upLabel.set_style_class_name(
                `snmpbar-up-label snmpbar-fmt-${unitFmt} snmpbar-mode-${unitMode}`
            );
        }
    }

    _updateColors() {
        // Bar-Textfarben (Default: Weiß und extrem helles Grau)
        const barDownColor = this._getStr('bar-color-download', '#ffffff');
        const barUpColor = this._getStr('bar-color-upload', '#d0d0d0');

        this._downLabel.set_style(`color: ${barDownColor};`);
        this._upLabel.set_style(`color: ${barUpColor};`);

        // Top-Bar Graph-Farben (Default: Blau und Grün)
        const barGraphDownColor = this._getStr('bar-graph-color-download',
                                  this._getStr('graph-color-download', '#3584e4'));
        const barGraphUpColor = this._getStr('bar-graph-color-upload',
                                this._getStr('graph-color-upload', '#33d17a'));
        const barGraphBgColor = this._getStr('bar-graph-bg-color', '#00000040');
        this._sparkline.setColors(barGraphDownColor, barGraphUpColor, barGraphBgColor);

        // Auch Dropdown-Menü bei Farbänderung direkt neu rendern
        if (this._lastData) {
            this._buildMenu(this._lastData);
        }
    }

    _getOrCreateHistory(key) {
        if (!this._histories[key]) {
            this._histories[key] = { rx: [], tx: [] };
        }
        return this._histories[key];
    }

    _pushSample(key, rx, tx) {
        const h = this._getOrCreateHistory(key);
        h.rx.push(rx);
        if (h.rx.length > MAX_HISTORY) h.rx.shift();
        h.tx.push(tx);
        if (h.tx.length > MAX_HISTORY) h.tx.shift();
    }

    _formatText(metric, unitMode, unitFmt = 'compact') {
        if (!metric) {
            if (unitFmt === 'compact') {
                if (unitMode === 'bits') return { down: '↓   --.- b', up: '↑   --.- b', combined: '↓   --.- b    ↑   --.- b' };
                if (unitMode === 'bytes') return { down: '↓   --.- B', up: '↑   --.- B', combined: '↓   --.- B    ↑   --.- B' };
                return { down: '↓   --.- b (  --.- B)', up: '↑   --.- b (  --.- B)', combined: '↓   --.- b (  --.- B)    ↑   --.- b (  --.- B)' };
            } else if (unitFmt === 'short') {
                if (unitMode === 'bits') return { down: '↓   --.-  b', up: '↑   --.-  b', combined: '↓   --.-  b    ↑   --.-  b' };
                if (unitMode === 'bytes') return { down: '↓   --.-  B', up: '↑   --.-  B', combined: '↓   --.-  B    ↑   --.-  B' };
                return { down: '↓   --.-  b (  --.-  B)', up: '↑   --.-  b (  --.-  B)', combined: '↓   --.-  b (  --.-  B)    ↑   --.-  b (  --.-  B)' };
            } else {
                if (unitMode === 'bits') return { down: '↓   --.-  bit', up: '↑   --.-  bit', combined: '↓   --.-  bit    ↑   --.-  bit' };
                if (unitMode === 'bytes') return { down: '↓   --.-  B', up: '↑   --.-  B', combined: '↓   --.-  B    ↑   --.-  B' };
                return {
                    down: '↓   --.-  bit (  --.-  B)',
                    up: '↑   --.-  bit (  --.-  B)',
                    combined: '↓   --.-  bit (  --.-  B)    ↑   --.-  bit (  --.-  B)'
                };
            }
        }

        let rx = '';
        let tx = '';
        let rxB = '';
        let txB = '';

        if (unitFmt === 'compact') {
            rx = metric.rx_compact || metric.rx_formatted;
            tx = metric.tx_compact || metric.tx_formatted;
            rxB = metric.rx_bytes_compact || metric.rx_bytes_formatted;
            txB = metric.tx_bytes_compact || metric.tx_bytes_formatted;
        } else if (unitFmt === 'short') {
            rx = metric.rx_short || metric.rx_formatted;
            tx = metric.tx_short || metric.tx_formatted;
            rxB = metric.rx_bytes_short || metric.rx_bytes_formatted;
            txB = metric.tx_bytes_short || metric.tx_bytes_formatted;
        } else {
            rx = metric.rx_formatted;
            tx = metric.tx_formatted;
            rxB = metric.rx_bytes_formatted;
            txB = metric.tx_bytes_formatted;
        }

        let down = '';
        let up = '';

        if (unitMode === 'bits') {
            down = `↓ ${rx}`;
            up = `↑ ${tx}`;
        } else if (unitMode === 'bytes') {
            down = `↓ ${rxB}`;
            up = `↑ ${txB}`;
        } else {
            // 'both'
            down = `↓ ${rx} (${rxB})`;
            up = `↑ ${tx} (${txB})`;
        }

        return { down, up, combined: `${down}    ${up}` };
    }

    _buildMenu(data) {
        this._lastData = data;
        const menu = this._indicator.menu;
        menu.removeAll();

        const isDarkMode = (this._interfaceSettings && this._interfaceSettings.get_string('color-scheme') === 'prefer-dark');

        let textColor, graphDownColor, graphUpColor, graphBgColor;

        if (isDarkMode) {
            textColor = this._getStr('dropdown-dark-text-color', '#f6f6f6');
            graphDownColor = this._getStr('dropdown-dark-graph-color-download',
                             this._getStr('dropdown-graph-color-download', '#3584e4'));
            graphUpColor = this._getStr('dropdown-dark-graph-color-upload',
                           this._getStr('dropdown-graph-color-upload', '#33d17a'));
            graphBgColor = this._getStr('dropdown-dark-graph-bg-color', '#00000040');
        } else {
            textColor = this._getStr('menu-text-color', '#1a1a1a');
            graphDownColor = this._getStr('dropdown-graph-color-download',
                             this._getStr('graph-color-download', '#3584e4'));
            graphUpColor = this._getStr('dropdown-graph-color-upload',
                           this._getStr('graph-color-upload', '#33d17a'));
            graphBgColor = this._getStr('dropdown-graph-bg-color', '#00000018');
        }
        const showDropdownGraphs = this._getBool('show-dropdown-graphs', true);
        const showUptime = this._getBool('show-uptime', true);
        const showIfaceUptime = this._getBool('show-iface-uptime', true);
        const unitMode = this._getStr('unit-display', 'both');
        const unitFmt = this._getStr('bar-unit-format', 'compact');

        const styleTitle = `color: ${textColor}; font-weight: 800; font-size: 13px;`;
        const styleSection = `color: ${textColor}; font-weight: bold; font-size: 12px;`;
        const styleNormal = `color: ${textColor}; font-size: 11px;`;

        const connections = (data && data.connections && data.connections.length > 0)
            ? data.connections
            : [{
                name: this._getStr('connection-name', 'Gateway'),
                host: this._getStr('host', '192.0.2.1'),
                aggregated_name: this._getStr('aggregated-name', 'Load-Balancer Gesamt'),
                total: null,
                interfaces: []
            }];

        connections.forEach((conn, cIdx) => {
            if (cIdx > 0) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }

            // 1. Header (Verbindungsname, Host & Uptime)
            const headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            const headerBox = new St.BoxLayout({
                style_class: 'snmpbar-menu-box',
                vertical: true,
            });
            const titleRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
            const hostIcon = new St.Icon({
                icon_name: 'network-server-symbolic',
                icon_size: 16,
                style: `margin-right: 8px; color: ${textColor};`,
            });
            const headerLabel = new St.Label({
                text: `${conn.name} (${conn.host})`,
                style: styleTitle,
            });
            titleRow.add_child(hostIcon);
            titleRow.add_child(headerLabel);
            headerBox.add_child(titleRow);

            if (showUptime && conn.uptime_formatted) {
                const uptimeRow = new St.BoxLayout({
                    vertical: false,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'margin-left: 24px; margin-top: 2px;',
                });
                const uptimeIcon = new St.Icon({
                    icon_name: 'preferences-system-time-symbolic',
                    icon_size: 12,
                    style: `margin-right: 5px; color: ${textColor}; opacity: 0.7;`,
                });
                const uptimeLabel = new St.Label({
                    text: conn.uptime_formatted,
                    style: `color: ${textColor}; font-size: 11px; opacity: 0.85; font-weight: 500;`,
                });
                uptimeRow.add_child(uptimeIcon);
                uptimeRow.add_child(uptimeLabel);
                headerBox.add_child(uptimeRow);
            }

            headerItem.add_child(headerBox);
            menu.addMenuItem(headerItem);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // 2. Aggregierte Gesamtleistung (nur wenn aktiv oder standardmäßig bei mehr als 1 Interface)
            const ifaces = conn.interfaces || [];
            const showAggregated = conn.show_aggregated !== undefined
                ? conn.show_aggregated
                : (ifaces.length > 1);

            if (showAggregated && ifaces.length > 0) {
                const total = conn.total;
                const totalKey = `${conn.id || 'conn_1'}:total`;
                const totalHist = this._getOrCreateHistory(totalKey);

                const lbItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
                const lbContainer = new St.BoxLayout({
                    style_class: 'snmpbar-menu-box',
                    vertical: true,
                });

                // Titel
                const lbTitle = new St.Label({
                    text: conn.aggregated_name || 'Load-Balancer Gesamt',
                    style: styleSection,
                });
                lbContainer.add_child(lbTitle);

                // Großer Graph über den Werten
                if (showDropdownGraphs) {
                    const totalGraph = new SparklineGraph(320, 36);
                    totalGraph.setColors(graphDownColor, graphUpColor, graphBgColor);
                    totalGraph.setHistory(totalHist.rx, totalHist.tx);
                    lbContainer.add_child(totalGraph);
                }

                // Ratenzeile gemäß unit-display & bar-unit-format
                const totalFmt = this._formatText(total, unitMode, unitFmt);
                const lbRatesLabel = new St.Label({
                    text: totalFmt.combined,
                    style: styleNormal,
                });
                lbContainer.add_child(lbRatesLabel);

                lbItem.add_child(lbContainer);
                menu.addMenuItem(lbItem);

                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }

            // 3. Schnittstellen dieser Verbindung
            const ifacesItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            const ifacesContainer = new St.BoxLayout({
                style_class: 'snmpbar-menu-box',
                vertical: true,
            });

            const ifacesTitle = new St.Label({
                text: 'Schnittstellen',
                style: styleSection,
            });
            ifacesContainer.add_child(ifacesTitle);

            const ifaces = conn.interfaces || [];
            if (ifaces.length === 0) {
                ifacesContainer.add_child(new St.Label({
                    text: '  Keine Schnittstellen konfiguriert',
                    style: styleNormal,
                }));
            } else {
                ifaces.forEach((iface) => {
                    const ifaceKey = `${conn.id || 'conn_1'}:${iface.index}`;
                    const ifaceHist = this._getOrCreateHistory(ifaceKey);

                    const singleIfaceBox = new St.BoxLayout({
                        vertical: true,
                        style: 'margin-top: 6px; margin-bottom: 4px;',
                    });

                    // Kopfzeile: Icon + Name + Status {Online}/{Offline}
                    const topRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
                    const icon = new St.Icon({
                        icon_name: iface.icon || 'network-wired-symbolic',
                        icon_size: 14,
                        style: `margin-right: 6px; color: ${textColor};`,
                    });
                    const nameLabel = new St.Label({
                        text: `${iface.name} `,
                        style: `font-weight: 600; color: ${textColor}; font-size: 12px;`,
                    });
                    const statusColor = iface.is_up
                        ? (isDarkMode ? '#33d17a' : '#26a269')
                        : (isDarkMode ? '#f66151' : '#c01c28');
                    const statusLabel = new St.Label({
                        text: iface.is_up ? '{Online}' : '{Offline}',
                        style: `font-weight: bold; color: ${statusColor}; font-size: 11px;`,
                    });
                    topRow.add_child(icon);
                    topRow.add_child(nameLabel);
                    topRow.add_child(statusLabel);

                    if (showIfaceUptime && iface.is_up && iface.uptime_str) {
                        const ifaceUptimeLabel = new St.Label({
                            text: ` (${iface.uptime_str})`,
                            style: `color: ${textColor}; font-size: 11px; opacity: 0.75; margin-left: 4px;`,
                        });
                        topRow.add_child(ifaceUptimeLabel);
                    }

                    singleIfaceBox.add_child(topRow);

                    // Großer Graph über den Schnittstellenwerten
                    if (showDropdownGraphs && iface.show_graph !== false) {
                        const ifaceGraph = new SparklineGraph(320, 28);
                        ifaceGraph.setColors(graphDownColor, graphUpColor, graphBgColor);
                        ifaceGraph.setHistory(ifaceHist.rx, ifaceHist.tx);
                        singleIfaceBox.add_child(ifaceGraph);
                    }

                    // Zahlenzeile gemäß unit-display & bar-unit-format
                    const ifaceFmt = this._formatText(iface, unitMode, unitFmt);
                    const ifaceRatesLabel = new St.Label({
                        text: ifaceFmt.combined,
                        style: styleNormal,
                    });
                    singleIfaceBox.add_child(ifaceRatesLabel);

                    ifacesContainer.add_child(singleIfaceBox);
                });
            }

            ifacesItem.add_child(ifacesContainer);
            menu.addMenuItem(ifacesItem);
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 4. Aktionen
        const refreshItem = new PopupMenu.PopupMenuItem('Jetzt aktualisieren');
        refreshItem.connect('activate', () => this._pollNow());
        menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Einstellungen...');
        prefsItem.connect('activate', () => this.openPreferences());
        menu.addMenuItem(prefsItem);
    }

    _schedulePoll(delaySeconds = 3) {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delaySeconds, () => {
            this._pollNow();
            const interval = this._getInt('refresh-interval', 3);
            this._schedulePoll(Math.max(1, interval));
            return GLib.SOURCE_REMOVE;
        });
    }

    _pollNow() {
        if (this._isPolling || !this._settings) return;
        this._isPolling = true;

        let connsJson = this._getStr('connections-json', '[]');
        if (!connsJson || connsJson === '[]') {
            const single = [{
                id: 'conn_1',
                name: this._getStr('connection-name', 'Gateway'),
                aggregated_name: this._getStr('aggregated-name', 'Load-Balancer Gesamt'),
                host: this._getStr('host', '192.0.2.1'),
                community: this._getStr('community', 'public'),
                version: this._getStr('snmp-version', 'v2c'),
                interfaces: JSON.parse(this._getStr('interfaces-json', '[]'))
            }];
            connsJson = JSON.stringify(single);
        }

        try {
            const proc = Gio.Subprocess.new(
                ['/usr/bin/python3', this._backendScript, '--connections', connsJson],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (source, res) => {
                this._isPolling = false;
                try {
                    const [, stdout] = source.communicate_utf8_finish(res);
                    if (stdout) {
                        const data = JSON.parse(stdout);
                        this._updateUi(data);
                    }
                } catch (e) {
                    console.warn(`[snmpbar] Fehler beim Verarbeiten von SNMP-Daten: ${e}`);
                }
            });
        } catch (err) {
            this._isPolling = false;
            console.error(`[snmpbar] Konnte Backend nicht starten: ${err}`);
        }
    }

    _updateUi(data) {
        this._applyLayoutClasses();

        if (!data || data.status !== 'ok') {
            this._downLabel.set_text('↓  Offline');
            this._upLabel.set_text('↑  Offline');
            this._buildMenu(null);
            return;
        }

        const connections = data.connections || [];
        if (connections.length === 0) return;

        // Historien puffern
        connections.forEach(conn => {
            const totalKey = `${conn.id || 'conn_1'}:total`;
            this._pushSample(totalKey, conn.total.rx_bps, conn.total.tx_bps);

            conn.interfaces.forEach(iface => {
                const ifaceKey = `${conn.id || 'conn_1'}:${iface.index}`;
                this._pushSample(ifaceKey, iface.rx_bps, iface.tx_bps);
            });
        });

        // Top-Bar Quelle ermitteln
        const topbarSource = this._getStr('topbar-source', 'total');
        const primaryConn = connections[0];
        let targetMetric = primaryConn.total;

        if (topbarSource !== 'total') {
            for (const conn of connections) {
                const found = conn.interfaces.find(i => `if_${i.index}` === topbarSource || String(i.index) === topbarSource);
                if (found) {
                    targetMetric = found;
                    break;
                }
            }
        }

        const showNumbers = this._getBool('show-numbers', true);
        const showGraph = this._getBool('show-graph', true);
        const unitMode = this._getStr('unit-display', 'both');
        const unitFmt = this._getStr('bar-unit-format', 'compact');

        this._labelBox.visible = showNumbers;
        this._sparkline.visible = showGraph;

        if (showGraph) {
            this._sparkline.addSample(targetMetric.rx_bps, targetMetric.tx_bps);
        }

        if (showNumbers) {
            const fmt = this._formatText(targetMetric, unitMode, unitFmt);
            this._downLabel.set_text(fmt.down);
            this._upLabel.set_text(fmt.up);
        }

        this._buildMenu(data);
    }
}
