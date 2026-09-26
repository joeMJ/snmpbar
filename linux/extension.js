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
    }

    setColors(rxHex, txHex) {
        this._rxColor = this._hexToRgba(rxHex, 0.95);
        this._txColor = this._hexToRgba(txHex, 0.95);
        this.queue_repaint();
    }

    setHistory(rxList, txList) {
        this._rxHistory = [...rxList];
        this._txHistory = [...txList];
        this.queue_repaint();
    }

    _hexToRgba(hex, alpha = 1.0) {
        if (!hex || !hex.startsWith('#') || hex.length < 7) {
            return [0.5, 0.5, 0.5, alpha];
        }
        const r = parseInt(hex.slice(1, 3), 16) / 255.0;
        const g = parseInt(hex.slice(3, 5), 16) / 255.0;
        const b = parseInt(hex.slice(5, 7), 16) / 255.0;
        return [r, g, b, alpha];
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

        cr.setSourceRGBA(0, 0, 0, 0.25);
        cr.rectangle(0, 0, w, h);
        cr.fill();

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

        this._buildIndicator();
        this._schedulePoll(1);

        this._settingsChangedId = this._settings.connect('changed', (s, key) => {
            if (key === 'panel-position') {
                this._repositionIndicator();
            } else if (key.startsWith('bar-color') || key.startsWith('graph-color')) {
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

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
        console.log(`[snmpbar] Extension ${this.uuid} deaktiviert.`);
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
        const pos = this._settings.get_string('panel-position') || 'right';
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
        const unitMode = this._settings.get_string('unit-display') || 'both';
        const unitFmt = this._settings.get_string('bar-unit-format') || 'compact';

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
        const barDownColor = this._settings.get_string('bar-color-download') || '#ffffff';
        const barUpColor = this._settings.get_string('bar-color-upload') || '#d0d0d0';

        this._downLabel.set_style(`color: ${barDownColor};`);
        this._upLabel.set_style(`color: ${barUpColor};`);

        // Graph-Farben (Default: Blau und Grün)
        const graphDownColor = this._settings.get_string('graph-color-download') || '#3584e4';
        const graphUpColor = this._settings.get_string('graph-color-upload') || '#33d17a';
        this._sparkline.setColors(graphDownColor, graphUpColor);
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
                if (unitMode === 'bits') return { down: '↓   --.-  b/s', up: '↑   --.-  b/s', combined: '↓   --.-  b/s    ↑   --.-  b/s' };
                if (unitMode === 'bytes') return { down: '↓   --.-  B/s', up: '↑   --.-  B/s', combined: '↓   --.-  B/s    ↑   --.-  B/s' };
                return { down: '↓   --.-  b/s (  --.-  B/s)', up: '↑   --.-  b/s (  --.-  B/s)', combined: '↓   --.-  b/s (  --.-  B/s)    ↑   --.-  b/s (  --.-  B/s)' };
            } else {
                if (unitMode === 'bits') return { down: '↓   --.-  bit/s', up: '↑   --.-  bit/s', combined: '↓   --.-  bit/s    ↑   --.-  bit/s' };
                if (unitMode === 'bytes') return { down: '↓   --.-  B/s', up: '↑   --.-  B/s', combined: '↓   --.-  B/s    ↑   --.-  B/s' };
                return {
                    down: '↓   --.-  bit/s (  --.-  B/s)',
                    up: '↑   --.-  bit/s (  --.-  B/s)',
                    combined: '↓   --.-  bit/s (  --.-  B/s)    ↑   --.-  bit/s (  --.-  B/s)'
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
        const menu = this._indicator.menu;
        menu.removeAll();

        const textColor = this._settings.get_string('menu-text-color') || '#1a1a1a';
        const graphDownColor = this._settings.get_string('graph-color-download') || '#3584e4';
        const graphUpColor = this._settings.get_string('graph-color-upload') || '#33d17a';
        const showDropdownGraphs = this._settings.get_boolean('show-dropdown-graphs');
        const unitMode = this._settings.get_string('unit-display') || 'both';

        const styleTitle = `color: ${textColor}; font-weight: 800; font-size: 13px;`;
        const styleSection = `color: ${textColor}; font-weight: bold; font-size: 12px;`;
        const styleNormal = `color: ${textColor}; font-size: 11px;`;

        const connections = (data && data.connections && data.connections.length > 0)
            ? data.connections
            : [{
                name: this._settings.get_string('connection-name') || 'Gateway',
                host: this._settings.get_string('host') || '192.0.2.1',
                aggregated_name: this._settings.get_string('aggregated-name') || 'Load-Balancer Gesamt',
                total: null,
                interfaces: []
            }];

        connections.forEach((conn, cIdx) => {
            if (cIdx > 0) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }

            // 1. Header (Verbindungsname & Host)
            const headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            const headerBox = new St.BoxLayout({
                style_class: 'snmpbar-menu-box',
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const hostIcon = new St.Icon({
                icon_name: 'network-server-symbolic',
                icon_size: 16,
                style: `margin-right: 8px; color: ${textColor};`,
            });
            const headerLabel = new St.Label({
                text: `${conn.name} (${conn.host})`,
                style: styleTitle,
            });
            headerBox.add_child(hostIcon);
            headerBox.add_child(headerLabel);
            headerItem.add_child(headerBox);
            menu.addMenuItem(headerItem);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // 2. Aggregierte Gesamtleistung
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
                totalGraph.setColors(graphDownColor, graphUpColor);
                totalGraph.setHistory(totalHist.rx, totalHist.tx);
                lbContainer.add_child(totalGraph);
            }

            // Ratenzeile gemäß unit-display
            const totalFmt = this._formatText(total, unitMode);
            const lbRatesLabel = new St.Label({
                text: totalFmt.combined,
                style: styleNormal,
            });
            lbContainer.add_child(lbRatesLabel);

            lbItem.add_child(lbContainer);
            menu.addMenuItem(lbItem);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

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

                    // Kopfzeile: Icon + Name + Status [UP/DOWN]
                    const topRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
                    const icon = new St.Icon({
                        icon_name: iface.icon || 'network-wired-symbolic',
                        icon_size: 14,
                        style: `margin-right: 6px; color: ${textColor};`,
                    });
                    const statusTag = iface.is_up ? '[UP]' : '[DOWN]';
                    const nameLabel = new St.Label({
                        text: `${iface.name} ${statusTag}`,
                        style: `font-weight: 600; color: ${textColor}; font-size: 12px;`,
                    });
                    topRow.add_child(icon);
                    topRow.add_child(nameLabel);
                    singleIfaceBox.add_child(topRow);

                    // Großer Graph über den Schnittstellenwerten
                    if (showDropdownGraphs && iface.show_graph !== false) {
                        const ifaceGraph = new SparklineGraph(320, 28);
                        ifaceGraph.setColors(graphDownColor, graphUpColor);
                        ifaceGraph.setHistory(ifaceHist.rx, ifaceHist.tx);
                        singleIfaceBox.add_child(ifaceGraph);
                    }

                    // Zahlenzeile gemäß unit-display
                    const ifaceFmt = this._formatText(iface, unitMode);
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
            const interval = this._settings ? this._settings.get_int('refresh-interval') : 3;
            this._schedulePoll(Math.max(1, interval));
            return GLib.SOURCE_REMOVE;
        });
    }

    _pollNow() {
        if (this._isPolling || !this._settings) return;
        this._isPolling = true;

        let connsJson = this._settings.get_string('connections-json');
        if (!connsJson || connsJson === '[]') {
            const single = [{
                id: 'conn_1',
                name: this._settings.get_string('connection-name') || 'Gateway',
                aggregated_name: this._settings.get_string('aggregated-name') || 'Load-Balancer Gesamt',
                host: this._settings.get_string('host') || '192.0.2.1',
                community: this._settings.get_string('community') || 'public',
                version: this._settings.get_string('snmp-version') || 'v2c',
                interfaces: JSON.parse(this._settings.get_string('interfaces-json') || '[]')
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
        const topbarSource = this._settings.get_string('topbar-source') || 'total';
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

        const showNumbers = this._settings.get_boolean('show-numbers');
        const showGraph = this._settings.get_boolean('show-graph');
        const unitMode = this._settings.get_string('unit-display') || 'both';
        const unitFmt = this._settings.get_string('bar-unit-format') || 'compact';

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
