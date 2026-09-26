import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

// History-Buffer für Sparklines (letzte 20 Messpunkte)
const MAX_HISTORY = 20;

// Mini Sparkline Graph mit Cairo
const SparklineGraph = GObject.registerClass(
class SparklineGraph extends St.DrawingArea {
    _init(width = 48, height = 18) {
        super._init({
            width,
            height,
            style: 'margin-left: 4px; margin-right: 4px;',
        });
        this._rxHistory = [];
        this._txHistory = [];
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

        // Hintergrund abdunkeln
        cr.setSourceRGBA(0, 0, 0, 0.2);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        if (this._rxHistory.length < 2) return;

        // Maximalen Wert zur Skalierung ermitteln (min. 100 kbit/s als Basis)
        const maxVal = Math.max(
            ...this._rxHistory,
            ...this._txHistory,
            100000
        );

        const step = w / (MAX_HISTORY - 1);

        // 1. Download-Kurve (Blau / Cyan)
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(0.2, 0.7, 1.0, 0.9);
        const rxOffset = MAX_HISTORY - this._rxHistory.length;
        for (let i = 0; i < this._rxHistory.length; i++) {
            const x = (rxOffset + i) * step;
            const y = h - (this._rxHistory[i] / maxVal) * (h - 2) - 1;
            if (i === 0) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
        cr.stroke();

        // 2. Upload-Kurve (Grün / Gelbgrün)
        cr.setLineWidth(1.2);
        cr.setSourceRGBA(0.3, 0.9, 0.4, 0.85);
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

        // Panel-Indikator anlegen
        this._buildIndicator();

        // Initiales Polling starten
        this._schedulePoll(1);

        // Einstellungen überwachen
        this._settingsChangedId = this._settings.connect('changed', () => {
            this._updatePanelDisplay(null);
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

        // Haupt-Container in der Top-Bar
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
            y_align: Clutter.ActorAlign.CENTER,
            vertical: false,
        });

        // Icon
        this._icon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelBox.add_child(this._icon);

        // Numerische Labels in der Bar
        this._labelBox = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._downLabel = new St.Label({
            text: '↓ --',
            style_class: 'snmpbar-down-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._upLabel = new St.Label({
            text: ' ↑ --',
            style_class: 'snmpbar-up-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._labelBox.add_child(this._downLabel);
        this._labelBox.add_child(this._upLabel);
        this._panelBox.add_child(this._labelBox);

        // Miniatur-Graph
        this._sparkline = new SparklineGraph(48, 18);
        this._panelBox.add_child(this._sparkline);

        this._indicator.add_child(this._panelBox);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Dropdown-Menü aufbauen
        this._buildMenu();
    }

    _buildMenu() {
        const menu = this._indicator.menu;
        menu.removeAll();

        // Header: Host Information
        this._menuHeader = new PopupMenu.PopupMenuItem('Lancom: Verbindung wird hergestellt...', { reactive: false });
        this._menuHeader.label.clutter_text.set_markup('<b>Lancom 1803VA-5G</b> (192.0.2.1)');
        menu.addMenuItem(this._menuHeader);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Sektion: Load Balancer Gesamt
        const lbSection = new PopupMenu.PopupMenuItem('Load-Balancer (Gesamt)', { reactive: false });
        lbSection.label.clutter_text.set_markup('<b>Load-Balancer (WIZ_LOADBAL Gesamt)</b>');
        menu.addMenuItem(lbSection);

        this._menuLbDown = new PopupMenu.PopupMenuItem('  ↓ Downstream: --', { reactive: false });
        this._menuLbUp = new PopupMenu.PopupMenuItem('  ↑ Upstream:   --', { reactive: false });
        menu.addMenuItem(this._menuLbDown);
        menu.addMenuItem(this._menuLbUp);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Sektion: Schnittstellen
        const ifacesSection = new PopupMenu.PopupMenuItem('Schnittstellen', { reactive: false });
        ifacesSection.label.clutter_text.set_markup('<b>WAN-Schnittstellen</b>');
        menu.addMenuItem(ifacesSection);

        // VDSL
        this._menuVdsl = new PopupMenu.PopupMenuItem('  🌐 VDSL (INTERNET): --', { reactive: false });
        menu.addMenuItem(this._menuVdsl);

        // 5G WWAN
        this._menuWwan = new PopupMenu.PopupMenuItem('  📶 5G (INET_WWAN): --', { reactive: false });
        menu.addMenuItem(this._menuWwan);

        // GPON
        this._menuGpon = new PopupMenu.PopupMenuItem('  ⚡ Glasfaser (GPON): Inaktiv (DOWN)', { reactive: false });
        menu.addMenuItem(this._menuGpon);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Aktionen
        const refreshItem = new PopupMenu.PopupMenuItem('Jetzt aktualisieren');
        refreshItem.connect('activate', () => {
            this._pollNow();
        });
        menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Einstellungen...');
        prefsItem.connect('activate', () => {
            this.openPreferences();
        });
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

        try {
            const proc = Gio.Subprocess.new(
                ['/usr/bin/python3', this._backendScript, host, comm, ver],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (source, res) => {
                this._isPolling = false;
                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(res);
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
            return;
        }

        const lb = data.load_balancer;
        const total = lb.total;

        // Sparkline mit neuem Datenpunkt füttern
        this._sparkline.addSample(total.rx_bps, total.tx_bps);

        // Top-Bar aktualisieren
        const mode = this._settings.get_string('display-mode');
        this._labelBox.visible = (mode === 'both' || mode === 'numeric');
        this._sparkline.visible = (mode === 'both' || mode === 'graph');

        this._downLabel.set_text(`↓ ${total.rx_formatted}`);
        this._upLabel.set_text(` ↑ ${total.tx_formatted}`);

        // Dropdown-Menü aktualisieren
        this._menuHeader.label.clutter_text.set_markup(
            `<b>LANCOM 1803VA-5G</b> (${data.host})`
        );

        this._menuLbDown.label.set_text(`  ↓ Downstream: ${total.rx_formatted} (${total.rx_bytes_formatted})`);
        this._menuLbUp.label.set_text(`  ↑ Upstream:   ${total.tx_formatted} (${total.tx_bytes_formatted})`);

        // Interfaces aktualisieren
        for (const iface of lb.interfaces) {
            if (iface.id === 'vdsl') {
                const s = iface.is_up ? 'UP' : 'DOWN';
                this._menuVdsl.label.set_text(
                    `  🌐 VDSL: [${s}] ↓ ${iface.rx_formatted} | ↑ ${iface.tx_formatted}`
                );
            } else if (iface.id === 'wwan') {
                const s = iface.is_up ? 'UP' : 'DOWN';
                this._menuWwan.label.set_text(
                    `  📶 5G WWAN: [${s}] ↓ ${iface.rx_formatted} | ↑ ${iface.tx_formatted}`
                );
            } else if (iface.id === 'gpon') {
                const s = iface.is_up ? 'UP' : 'DOWN (Wartend)';
                this._menuGpon.label.set_text(
                    `  ⚡ Glasfaser (GPON): [${s}] ↓ ${iface.rx_formatted} | ↑ ${iface.tx_formatted}`
                );
            }
        }
    }
}
