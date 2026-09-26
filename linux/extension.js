import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
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

        // Subtiler dunkler Hintergrundrahmen
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

        // 1. Download-Kurve
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

        // 2. Upload-Kurve
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

        this._histories = {}; // Map von key -> { rx: [], tx: [] }

        this._buildIndicator();
        this._schedulePoll(1);

        this._settingsChangedId = this._settings.connect('changed', (s, key) => {
            if (key === 'panel-position') {
                this._repositionIndicator();
            } else if (key === 'color-download' || key === 'color-upload') {
                this._updateColors();
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
            style_class: 'snmpbar-down-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._upLabel = new St.Label({
            text: '↑ --.-',
            style_class: 'snmpbar-up-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._labelBox.add_child(this._downLabel);
        this._labelBox.add_child(this._upLabel);
        this._panelBox.add_child(this._labelBox);

        this._sparkline = new SparklineGraph(46, 20);
        this._panelBox.add_child(this._sparkline);

        this._indicator.add_child(this._panelBox);

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

    _updateColors() {
        const downColor = this._settings.get_string('color-download') || '#3584e4';
        const upColor = this._settings.get_string('color-upload') || '#33d17a';

        this._downLabel.set_style(`color: ${downColor};`);
        this._upLabel.set_style(`color: ${upColor};`);
        this._sparkline.setColors(downColor, upColor);
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

    _buildMenu(data) {
        const menu = this._indicator.menu;
        menu.removeAll();

        const textColor = this._settings.get_string('menu-text-color') || '#1a1a1a';
        const downColor = this._settings.get_string('color-download') || '#3584e4';
        const upColor = this._settings.get_string('color-upload') || '#33d17a';
        const showDropdownGraphs = this._settings.get_boolean('show-dropdown-graphs');

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
                totalGraph.setColors(downColor, upColor);
                totalGraph.setHistory(totalHist.rx, totalHist.tx);
                lbContainer.add_child(totalGraph);
            }

            // Text-Zeile mit Raten
            const downText = total ? `↓ ${total.rx_formatted} (${total.rx_bytes_formatted})` : '↓ --';
            const upText = total ? `↑ ${total.tx_formatted} (${total.tx_bytes_formatted})` : '↑ --';
            const lbRatesLabel = new St.Label({
                text: `${downText}    ${upText}`,
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
                        ifaceGraph.setColors(downColor, upColor);
                        ifaceGraph.setHistory(ifaceHist.rx, ifaceHist.tx);
                        singleIfaceBox.add_child(ifaceGraph);
                    }

                    // Zahlenzeile
                    const ifaceRatesLabel = new St.Label({
                        text: `↓ ${iface.rx_formatted} (${iface.rx_bytes_formatted})    ↑ ${iface.tx_formatted} (${iface.tx_bytes_formatted})`,
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

        // Connections laden (oder fallback)
        let connsJson = this._settings.get_string('connections-json');
        if (!connsJson || connsJson === '[]') {
            // Aus Einzelfeldern generieren
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
        if (!data || data.status !== 'ok') {
            this._downLabel.set_text('↓ Offline');
            this._upLabel.set_text('');
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
        let targetKey = `${primaryConn.id || 'conn_1'}:total`;

        if (topbarSource !== 'total') {
            // Spezifisches Interface suchen
            for (const conn of connections) {
                const found = conn.interfaces.find(i => `if_${i.index}` === topbarSource || String(i.index) === topbarSource);
                if (found) {
                    targetMetric = found;
                    targetKey = `${conn.id || 'conn_1'}:${found.index}`;
                    break;
                }
            }
        }

        const showNumbers = this._settings.get_boolean('show-numbers');
        const showGraph = this._settings.get_boolean('show-graph');

        this._labelBox.visible = showNumbers;
        this._sparkline.visible = showGraph;

        if (showGraph) {
            this._sparkline.addSample(targetMetric.rx_bps, targetMetric.tx_bps);
        }

        if (showNumbers) {
            this._downLabel.set_text(`↓ ${targetMetric.rx_formatted}`);
            this._upLabel.set_text(`↑ ${targetMetric.tx_formatted}`);
        }

        this._buildMenu(data);
    }
}
