import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const MAX_HISTORY = 20;

// Cairo Sparkline Mini-Graph mit dynamischen Hex-Farben
const SparklineGraph = GObject.registerClass(
class SparklineGraph extends St.DrawingArea {
    _init(width = 46, height = 20) {
        super._init({
            width,
            height,
            style: 'margin-left: 5px; margin-right: 2px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rxHistory = [];
        this._txHistory = [];
        this._rxColor = [0.21, 0.52, 0.89, 0.95]; // Default Blue
        this._txColor = [0.20, 0.82, 0.48, 0.95]; // Default Green
    }

    setColors(rxHex, txHex) {
        this._rxColor = this._hexToRgba(rxHex, 0.95);
        this._txColor = this._hexToRgba(txHex, 0.95);
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
            100000 // Mindestens 100 kbit/s als Referenz
        );

        const step = w / (MAX_HISTORY - 1);

        // 1. Download-Kurve
        cr.setLineWidth(1.6);
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
        cr.setLineWidth(1.3);
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

        // Minimalistisches Standard-Ubuntu-Icon
        this._mainIcon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelBox.add_child(this._mainIcon);

        // Zahlen-Labels (Schriftgröße erbt vom Panel, feste Mindestbreite gegen Wackeln)
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

        // Miniatur-Graph
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

    _buildMenu(data) {
        const menu = this._indicator.menu;
        menu.removeAll();

        const textColor = this._settings.get_string('menu-text-color') || '#1a1a1a';
        const styleText = `color: ${textColor}; font-weight: normal;`;
        const styleBold = `color: ${textColor}; font-weight: bold;`;
        const styleTitle = `color: ${textColor}; font-weight: 800; font-size: 13px;`;

        // 1. Header (Router / Host)
        const hostName = data ? data.host : (this._settings.get_string('host') || '192.0.2.1');
        const headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const headerBox = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const hostIcon = new St.Icon({
            icon_name: 'network-server-symbolic',
            icon_size: 16,
            style: `margin-right: 8px; color: ${textColor};`,
        });
        const headerLabel = new St.Label({
            text: `Gateway: ${hostName}`,
            style: styleTitle,
        });
        headerBox.add_child(hostIcon);
        headerBox.add_child(headerLabel);
        headerItem.add_child(headerBox);
        menu.addMenuItem(headerItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 2. Load-Balancer Gesamt
        const lbTotal = data ? data.load_balancer.total : null;
        const lbSectionItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const lbTitle = new St.Label({
            text: 'Load-Balancer (Gesamtdurchsatz)',
            style: styleBold,
        });
        lbSectionItem.add_child(lbTitle);
        menu.addMenuItem(lbSectionItem);

        const lbDownText = lbTotal ? `↓ Downstream: ${lbTotal.rx_formatted} (${lbTotal.rx_bytes_formatted})` : '↓ Downstream: --';
        const lbUpText = lbTotal ? `↑ Upstream:   ${lbTotal.tx_formatted} (${lbTotal.tx_bytes_formatted})` : '↑ Upstream:   --';

        const lbRatesItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const lbRatesBox = new St.BoxLayout({ vertical: true });
        lbRatesBox.add_child(new St.Label({ text: `  ${lbDownText}`, style: styleText }));
        lbRatesBox.add_child(new St.Label({ text: `  ${lbUpText}`, style: styleText }));
        lbRatesItem.add_child(lbRatesBox);
        menu.addMenuItem(lbRatesItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 3. Dynamische Schnittstellen-Liste
        const ifacesSectionItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const ifacesTitle = new St.Label({
            text: 'Schnittstellen',
            style: styleBold,
        });
        ifacesSectionItem.add_child(ifacesTitle);
        menu.addMenuItem(ifacesSectionItem);

        const interfaces = data ? data.load_balancer.interfaces : [];
        if (interfaces.length === 0) {
            const noIfaceItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            noIfaceItem.add_child(new St.Label({ text: '  Keine Schnittstellen konfiguriert', style: styleText }));
            menu.addMenuItem(noIfaceItem);
        } else {
            for (const iface of interfaces) {
                const ifaceItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
                const ifaceBox = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });

                // Minimalistisches Symbolic Icon
                const icon = new St.Icon({
                    icon_name: iface.icon || 'network-wired-symbolic',
                    icon_size: 15,
                    style: `margin-right: 8px; color: ${textColor};`,
                });
                ifaceBox.add_child(icon);

                const statusTag = iface.is_up ? '[UP]' : '[DOWN]';
                const labelText = `${iface.name}: ${statusTag}  ↓ ${iface.rx_formatted} | ↑ ${iface.tx_formatted}`;
                const ifaceLabel = new St.Label({
                    text: labelText,
                    style: styleText,
                });
                ifaceBox.add_child(ifaceLabel);

                ifaceItem.add_child(ifaceBox);
                menu.addMenuItem(ifaceItem);
            }
        }

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

        const host = this._settings.get_string('host') || '192.0.2.1';
        const comm = this._settings.get_string('community') || 'public';
        const ver = this._settings.get_string('snmp-version') || 'v2c';
        const ifacesJson = this._settings.get_string('interfaces-json') || '[]';

        try {
            const proc = Gio.Subprocess.new(
                ['/usr/bin/python3', this._backendScript, host, comm, ver, ifacesJson],
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

        const total = data.load_balancer.total;

        // Sichtbarkeiten prüfen
        const showNumbers = this._settings.get_boolean('show-numbers');
        const showGraph = this._settings.get_boolean('show-graph');

        this._labelBox.visible = showNumbers;
        this._sparkline.visible = showGraph;

        // Sparkline mit Daten füttern
        if (showGraph) {
            this._sparkline.addSample(total.rx_bps, total.tx_bps);
        }

        // Top-Bar Zahlen mit fester Dezimalstelle
        if (showNumbers) {
            this._downLabel.set_text(`↓ ${total.rx_formatted}`);
            this._upLabel.set_text(`↑ ${total.tx_formatted}`);
        }

        // Menü neu aufbauen mit satten Kontrast-Farben
        this._buildMenu(data);
    }
}
