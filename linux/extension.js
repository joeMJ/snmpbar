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
import Cairo from 'cairo';

const MAX_HISTORY = 25;

function getNiceScaleMax(maxVal) {
    if (maxVal <= 0) maxVal = 10000;
    const steps = [
        25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000,
        10000000, 25000000, 50000000, 100000000, 250000000, 500000000, 1000000000, 2500000000, 10000000000
    ];
    for (const s of steps) {
        if (maxVal <= s) return s;
    }
    return Math.ceil(maxVal * 1.2);
}

// Cairo Sparkline Graph mit anpassbarer Breite, Höhe, Hex-Farben und Hover-Abdunklung
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
        this._isHovered = false;
        this._hoverDimColor = [0, 0, 0, 0.2];
    }

    setColors(rxHex, txHex, bgHex = null) {
        this._rxColor = this._hexToRgba(rxHex, 0.95);
        this._txColor = this._hexToRgba(txHex, 0.95);
        if (bgHex !== null) {
            this._bgColor = this._hexToRgba(bgHex, 0.25);
        }
        this.queue_repaint();
    }

    setHoverDimColor(dimHex) {
        this._hoverDimColor = this._hexToRgba(dimHex, 0.25);
        this.queue_repaint();
    }

    setHovered(bool) {
        if (this._isHovered !== bool) {
            this._isHovered = bool;
            this.queue_repaint();
        }
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

        if (this._rxHistory.length < 2) {
            cr.$dispose();
            return;
        }

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

        // Hover-Dimming Überlagerung
        if (this._isHovered && this._hoverDimColor && this._hoverDimColor[3] > 0.001) {
            cr.setSourceRGBA(...this._hoverDimColor);
            cr.rectangle(0, 0, w, h);
            cr.fill();
        }

        cr.$dispose();
    }
});

// Großer, skalierter Cairo-Graph für das Hover-Popout-Fenster
const ScaledDetailGraph = GObject.registerClass(
class ScaledDetailGraph extends St.DrawingArea {
    _init(width = 440, height = 95) {
        super._init({
            width: width,
            height: height,
            style: `width: ${width}px; height: ${height}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._history = [];
        this._color = [0.2, 0.5, 0.9, 0.95];
        this._isDark = true;
    }

    setData(history, colorHex, isDark) {
        this._history = [...history];
        this._color = this._hexToRgba(colorHex, 0.95);
        this._isDark = isDark;
        this.queue_repaint();
    }

    _hexToRgba(hex, alpha = 1.0) {
        if (!hex || hex === 'transparent' || hex === 'none') return [0, 0, 0, 0];
        if (!hex.startsWith('#')) return [0.5, 0.5, 0.5, alpha];
        if (hex.length === 9) {
            return [
                parseInt(hex.slice(1, 3), 16) / 255.0,
                parseInt(hex.slice(3, 5), 16) / 255.0,
                parseInt(hex.slice(5, 7), 16) / 255.0,
                parseInt(hex.slice(7, 9), 16) / 255.0,
            ];
        }
        if (hex.length >= 7) {
            return [
                parseInt(hex.slice(1, 3), 16) / 255.0,
                parseInt(hex.slice(3, 5), 16) / 255.0,
                parseInt(hex.slice(5, 7), 16) / 255.0,
                alpha,
            ];
        }
        return [0.5, 0.5, 0.5, alpha];
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();

        // 1. Hintergrund-Box (100% deckend / solide)
        const bgR = this._isDark ? 0.11 : 0.96;
        const bgG = this._isDark ? 0.11 : 0.96;
        const bgB = this._isDark ? 0.11 : 0.97;
        cr.setSourceRGBA(bgR, bgG, bgB, 1.0);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        // Subtiler Rahmen
        cr.setLineWidth(1.0);
        cr.setSourceRGBA(this._isDark ? 1.0 : 0.0, this._isDark ? 1.0 : 0.0, this._isDark ? 1.0 : 0.0, this._isDark ? 0.14 : 0.08);
        cr.rectangle(0.5, 0.5, w - 1.0, h - 1.0);
        cr.stroke();

        const plotLeft = 40;
        const plotRight = w - 10;
        const plotTop = 10;
        const plotBottom = h - 18;
        const plotWidth = plotRight - plotLeft;
        const plotHeight = plotBottom - plotTop;

        const maxHist = this._history.length > 0 ? Math.max(...this._history) : 0;
        const scaleMax = getNiceScaleMax(maxHist);

        const gridAlpha = this._isDark ? 0.15 : 0.12;
        const textR = this._isDark ? 0.85 : 0.20;
        const textG = this._isDark ? 0.85 : 0.20;
        const textB = this._isDark ? 0.85 : 0.20;

        // Horizontale Grid-Linien (0%, 50%, 100%)
        cr.selectFontFace('Cantarell', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
        cr.setFontSize(8.5);

        const levels = [
            { ratio: 1.0, val: scaleMax },
            { ratio: 0.5, val: scaleMax * 0.5 },
            { ratio: 0.0, val: 0 },
        ];

        for (const lvl of levels) {
            const y = Math.round(plotBottom - (lvl.ratio * plotHeight)) + 0.5;

            cr.setDash(lvl.ratio === 0 ? [] : [2, 3], 0);
            cr.setLineWidth(0.8);
            cr.setSourceRGBA(textR, textG, textB, gridAlpha);
            cr.moveTo(plotLeft, y);
            cr.lineTo(plotRight, y);
            cr.stroke();

            let lbl = '0';
            if (lvl.val >= 1e9) lbl = `${(lvl.val / 1e9).toFixed(0)}G`;
            else if (lvl.val >= 1e6) lbl = `${(lvl.val / 1e6).toFixed(0)}M`;
            else if (lvl.val >= 1e3) lbl = `${(lvl.val / 1e3).toFixed(0)}k`;

            cr.setSourceRGBA(textR, textG, textB, 0.75);
            cr.moveTo(4, y + 3);
            cr.showText(lbl.padStart(4, ' '));
        }

        // Zeitachsen-Markierungen
        cr.setFontSize(8.0);
        cr.setSourceRGBA(textR, textG, textB, 0.55);
        cr.moveTo(plotLeft, h - 4);
        cr.showText('-60s');
        cr.moveTo(Math.round(plotLeft + plotWidth / 2 - 10), h - 4);
        cr.showText('-30s');
        cr.moveTo(plotRight - 22, h - 4);
        cr.showText('jetzt');

        if (this._history.length < 2) {
            cr.$dispose();
            return;
        }

        const step = plotWidth / (MAX_HISTORY - 1);
        const offset = MAX_HISTORY - this._history.length;

        // Transparente Flächenfüllung
        cr.setSourceRGBA(this._color[0], this._color[1], this._color[2], 0.22);
        let firstX = plotLeft + offset * step;
        let firstY = plotBottom - (this._history[0] / scaleMax) * plotHeight;
        cr.moveTo(firstX, plotBottom);
        cr.lineTo(firstX, firstY);

        for (let i = 1; i < this._history.length; i++) {
            const x = plotLeft + (offset + i) * step;
            const y = plotBottom - (this._history[i] / scaleMax) * plotHeight;
            cr.lineTo(x, y);
        }
        const lastX = plotLeft + (offset + this._history.length - 1) * step;
        cr.lineTo(lastX, plotBottom);
        cr.closePath();
        cr.fill();

        // Haupt-Verlaufslinie
        cr.setDash([], 0);
        cr.setLineWidth(2.0);
        cr.setSourceRGBA(...this._color);
        cr.moveTo(firstX, firstY);
        let lastY = firstY;
        for (let i = 1; i < this._history.length; i++) {
            const x = plotLeft + (offset + i) * step;
            lastY = plotBottom - (this._history[i] / scaleMax) * plotHeight;
            cr.lineTo(x, lastY);
        }
        cr.stroke();

        // Live-Endpunkt hervorheben
        cr.setSourceRGBA(...this._color);
        cr.arc(lastX, lastY, 2.8, 0, 2 * Math.PI);
        cr.fill();

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
        this._hoverSidecar = null;
        this._sidecarHideTimeout = null;

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

        if (this._sidecarHideTimeout) {
            GLib.source_remove(this._sidecarHideTimeout);
            this._sidecarHideTimeout = null;
        }

        if (this._hoverSidecar) {
            if (this._hoverSidecar.get_parent()) {
                this._hoverSidecar.get_parent().remove_child(this._hoverSidecar);
            }
            this._hoverSidecar.destroy();
            this._hoverSidecar = null;
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
        this._indicator.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen) {
                this._hideHoverSidecar(true);
            }
        });

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

    _formatSingleBps(bps, unitMode = 'both', unitFmt = 'compact') {
        const bytesSec = bps / 8.0;
        let bitStr = '';
        let byteStr = '';

        if (unitFmt === 'compact') {
            if (bps >= 1e9) bitStr = `${(bps / 1e9).toFixed(1)} G`;
            else if (bps >= 1e6) bitStr = `${(bps / 1e6).toFixed(1)} M`;
            else if (bps >= 1e3) bitStr = `${(bps / 1e3).toFixed(1)} k`;
            else bitStr = `${Math.round(bps)} b`;

            if (bytesSec >= 1e9) byteStr = `${(bytesSec / 1e9).toFixed(1)} GB`;
            else if (bytesSec >= 1e6) byteStr = `${(bytesSec / 1e6).toFixed(1)} MB`;
            else if (bytesSec >= 1e3) byteStr = `${(bytesSec / 1e3).toFixed(1)} KB`;
            else byteStr = `${Math.round(bytesSec)} B`;
        } else if (unitFmt === 'short') {
            if (bps >= 1e9) bitStr = `${(bps / 1e9).toFixed(1)} Gb`;
            else if (bps >= 1e6) bitStr = `${(bps / 1e6).toFixed(1)} Mb`;
            else if (bps >= 1e3) bitStr = `${(bps / 1e3).toFixed(1)} kb`;
            else bitStr = `${Math.round(bps)} b`;

            if (bytesSec >= 1e9) byteStr = `${(bytesSec / 1e9).toFixed(1)} GB`;
            else if (bytesSec >= 1e6) byteStr = `${(bytesSec / 1e6).toFixed(1)} MB`;
            else if (bytesSec >= 1e3) byteStr = `${(bytesSec / 1e3).toFixed(1)} KB`;
            else byteStr = `${Math.round(bytesSec)} B`;
        } else {
            // full
            if (bps >= 1e9) bitStr = `${(bps / 1e9).toFixed(1)} Gbit/s`;
            else if (bps >= 1e6) bitStr = `${(bps / 1e6).toFixed(1)} Mbit/s`;
            else if (bps >= 1e3) bitStr = `${(bps / 1e3).toFixed(1)} kbit/s`;
            else bitStr = `${Math.round(bps)} bit/s`;

            if (bytesSec >= 1e9) byteStr = `${(bytesSec / 1e9).toFixed(1)} GB/s`;
            else if (bytesSec >= 1e6) byteStr = `${(bytesSec / 1e6).toFixed(1)} MB/s`;
            else if (bytesSec >= 1e3) byteStr = `${(bytesSec / 1e3).toFixed(1)} KB/s`;
            else byteStr = `${Math.round(bytesSec)} B/s`;
        }

        if (unitMode === 'bits') return bitStr;
        if (unitMode === 'bytes') return byteStr;
        return `${bitStr} (${byteStr})`;
    }

    _getHoverSidecar() {
        if (!this._hoverSidecar) {
            this._hoverSidecar = new St.BoxLayout({
                vertical: true,
                style_class: 'snmpbar-sidecar',
                reactive: false,
                can_focus: false,
            });
            Main.uiGroup.add_child(this._hoverSidecar);
            this._hoverSidecar.hide();
        }
        return this._hoverSidecar;
    }

    _hideHoverSidecar(immediate = false) {
        if (this._sidecarHideTimeout) {
            GLib.source_remove(this._sidecarHideTimeout);
            this._sidecarHideTimeout = null;
        }

        if (immediate) {
            if (this._hoverSidecar) {
                this._hoverSidecar.hide();
            }
            return;
        }

        this._sidecarHideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            if (this._hoverSidecar) {
                this._hoverSidecar.hide();
            }
            this._sidecarHideTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _showHoverSidecar(conn, iface, targetActor, hist, isDarkMode) {
        if (!this._getBool('show-hover-popout', true)) return;
        if (!this._indicator || !this._indicator.menu || !this._indicator.menu.isOpen) return;

        if (this._sidecarHideTimeout) {
            GLib.source_remove(this._sidecarHideTimeout);
            this._sidecarHideTimeout = null;
        }

        const sidecar = this._getHoverSidecar();
        sidecar.destroy_all_children();

        const unitMode = this._getStr('unit-display', 'both');
        const unitFmt = this._getStr('bar-unit-format', 'compact');
        const graphDownColor = isDarkMode
            ? this._getStr('dropdown-dark-graph-color-download', this._getStr('dropdown-graph-color-download', '#3584e4'))
            : this._getStr('dropdown-graph-color-download', '#3584e4');
        const graphUpColor = isDarkMode
            ? this._getStr('dropdown-dark-graph-color-upload', this._getStr('dropdown-graph-color-upload', '#33d17a'))
            : this._getStr('dropdown-graph-color-upload', '#33d17a');

        this._populateSidecar(sidecar, conn, iface, hist, isDarkMode, unitMode, unitFmt, graphDownColor, graphUpColor);

        sidecar.show();

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._hoverSidecar || !this._indicator || !this._indicator.menu || !this._indicator.menu.isOpen) {
                return GLib.SOURCE_REMOVE;
            }

            try {
                if (!targetActor || !targetActor.get_stage || !targetActor.get_stage()) {
                    return GLib.SOURCE_REMOVE;
                }
                const [menuX, menuY] = this._indicator.menu.actor.get_transformed_position();
                const [menuW, menuH] = this._indicator.menu.actor.get_transformed_size();
                const [targetX, targetY] = targetActor.get_transformed_position();

                const monitor = Main.layoutManager.findMonitorForActor(this._indicator.menu.actor) || Main.layoutManager.primaryMonitor;
                const monitorRight = monitor.x + monitor.width;
                const monitorBottom = monitor.y + monitor.height;

                const sidecarW = sidecar.width > 0 ? sidecar.width : 460;
                const sidecarH = sidecar.height > 0 ? sidecar.height : 360;

                let posX = menuX + menuW + 8;
                if (posX + sidecarW > monitorRight - 10) {
                    posX = menuX - sidecarW - 8;
                }
                if (posX < monitor.x + 8) {
                    posX = monitor.x + 8;
                }

                const panelH = Main.panel ? Main.panel.height : 32;
                const minY = monitor.y + panelH + 8;
                const maxY = monitorBottom - sidecarH - 12;

                let posY = targetY - 20;
                if (posY < minY) posY = minY;
                if (posY > maxY) posY = Math.max(minY, maxY);

                sidecar.set_position(Math.round(posX), Math.round(posY));
                Main.uiGroup.set_child_above_sibling(sidecar, null);
            } catch (e) {
                console.error(`[snmpbar] Fehler bei Sidecar-Positionierung: ${e}`);
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    _populateSidecar(sidecar, conn, iface, hist, isDarkMode, unitMode, unitFmt, graphDownColor, graphUpColor) {
        const sidecarBg = isDarkMode ? '#242424' : '#ffffff';
        const sidecarBorder = isDarkMode ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.14)';
        const cardTextColor = isDarkMode ? '#f6f6f6' : '#1a1a1a';
        const sectionColor = isDarkMode ? '#ffffff' : '#111111';
        const mutedColor = isDarkMode ? '#9a9a9a' : '#555555';
        const badgeBg = isDarkMode ? '#1c1c1f' : '#f4f4f6';
        const detailBorder = isDarkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';

        sidecar.style = `background-color: ${sidecarBg}; border: 1px solid ${sidecarBorder}; border-radius: 12px; padding: 14px 16px; min-width: 460px; max-width: 500px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.15);`;

        // 1. Header
        const headerRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const isLocalConn = conn.is_local || ['localhost', 'local', '127.0.0.1'].includes(String(conn.host).toLowerCase());
        const headerIconName = iface ? (iface.icon || 'network-wired-symbolic') : (isLocalConn ? 'computer-symbolic' : 'network-server-symbolic');
        const headerIcon = new St.Icon({
            icon_name: headerIconName,
            icon_size: 18,
            style: `margin-right: 8px; color: ${cardTextColor};`,
        });
        headerRow.add_child(headerIcon);

        const titleText = iface
            ? `${conn.name} · ${iface.name}`
            : `${conn.name} · ${conn.aggregated_name || 'Load-Balancer Gesamt'}`;
        const titleLabel = new St.Label({
            text: titleText,
            style: `color: ${sectionColor}; font-weight: 800; font-size: 13px;`,
        });
        headerRow.add_child(titleLabel);

        const isUp = iface ? iface.is_up : conn.is_online;
        const statusColor = isUp ? (isDarkMode ? '#33d17a' : '#26a269') : (isDarkMode ? '#f66151' : '#c01c28');
        const statusBadge = new St.Label({
            text: isUp ? '  {Online}' : '  {Offline}',
            style: `color: ${statusColor}; font-weight: bold; font-size: 11px; margin-left: 6px;`,
        });
        headerRow.add_child(statusBadge);

        const uptimeStr = iface ? iface.uptime_str : conn.uptime_formatted;
        if (isUp && uptimeStr) {
            const cleanUptime = uptimeStr.startsWith('Online ') ? uptimeStr : `(${uptimeStr})`;
            const uptimeLabel = new St.Label({
                text: ` ${cleanUptime}`,
                style: `color: ${mutedColor}; font-size: 11px; margin-left: 4px;`,
            });
            headerRow.add_child(uptimeLabel);
        }
        sidecar.add_child(headerRow);

        // 2. Leitungs- & Netzwerk-Details (Telemetry Box)
        const hasDetails = iface && (
            (iface.is_up && iface.external_ip) ||
            !iface.is_up ||
            (iface.is_up && iface.dns_servers && iface.dns_servers.length > 0) ||
            (iface.is_up && iface.sync_formatted) ||
            (iface.is_up && iface.qos_formatted) ||
            iface.ip_type === 'Lokal'
        );

        if (hasDetails) {
            const detailBox = new St.BoxLayout({
                vertical: true,
                style: `background-color: ${badgeBg}; border: 1px solid ${detailBorder}; border-radius: 8px; padding: 8px 12px; margin-top: 8px; margin-bottom: 8px;`,
            });

            // Externe WAN-IP & CGNAT / Public Badge oder Offline-Hinweis
            if (iface.is_up && iface.external_ip) {
                const ipRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 3px;' });
                const ipLbl = new St.Label({
                    text: 'Externe IP:  ',
                    style: `color: ${mutedColor}; font-weight: 600; font-size: 11px;`,
                });
                const ipVal = new St.Label({
                    text: iface.external_ip,
                    style: `color: ${sectionColor}; font-weight: bold; font-size: 11px;`,
                });
                ipRow.add_child(ipLbl);
                ipRow.add_child(ipVal);

                const cgnatText = iface.is_cgnat ? '[CGNAT]' : '[Public IPv4]';
                const cgnatColor = iface.is_cgnat ? (isDarkMode ? '#f8e45c' : '#b36b00') : (isDarkMode ? '#62a0ea' : '#1c71d8');
                const cgnatBg = iface.is_cgnat ? (isDarkMode ? 'rgba(248, 228, 92, 0.15)' : 'rgba(198, 120, 0, 0.10)') : (isDarkMode ? 'rgba(98, 160, 234, 0.15)' : 'rgba(28, 113, 216, 0.10)');
                const cgnatBadge = new St.Label({
                    text: ` ${cgnatText} `,
                    style: `color: ${cgnatColor}; background-color: ${cgnatBg}; border-radius: 4px; font-weight: bold; font-size: 10px; margin-left: 6px; padding: 1px 4px;`,
                });
                ipRow.add_child(cgnatBadge);
                detailBox.add_child(ipRow);
            } else if (!iface.is_up && iface.ip_type !== 'Lokal') {
                const ipRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 3px;' });
                const ipLbl = new St.Label({
                    text: 'Externe IP:  ',
                    style: `color: ${mutedColor}; font-weight: 600; font-size: 11px;`,
                });
                const ipVal = new St.Label({
                    text: 'Offline (keine Verbindung)',
                    style: `color: ${isDarkMode ? '#f66151' : '#c01c28'}; font-weight: 600; font-size: 11px;`,
                });
                ipRow.add_child(ipLbl);
                ipRow.add_child(ipVal);
                detailBox.add_child(ipRow);
            }

            // DNS-Server (nur anzeigen wenn Interface Online ist)
            if (iface.is_up && iface.dns_servers && iface.dns_servers.length > 0) {
                const dnsRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 3px;' });
                const dnsLbl = new St.Label({
                    text: 'DNS:  ',
                    style: `color: ${mutedColor}; font-weight: 600; font-size: 11px;`,
                });
                const dnsVal = new St.Label({
                    text: iface.dns_servers.join(', '),
                    style: `color: ${sectionColor}; font-size: 11px;`,
                });
                dnsRow.add_child(dnsLbl);
                dnsRow.add_child(dnsVal);
                detailBox.add_child(dnsRow);
            }

            // Sync-Aushandlung (nur wenn Online)
            if (iface.is_up && iface.sync_formatted) {
                const syncRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 3px;' });
                const syncLbl = new St.Label({
                    text: 'Sync-Leitung:  ',
                    style: `color: ${mutedColor}; font-weight: 600; font-size: 11px;`,
                });
                const syncVal = new St.Label({
                    text: iface.sync_formatted,
                    style: `color: ${sectionColor}; font-weight: 500; font-size: 11px;`,
                });
                syncRow.add_child(syncLbl);
                syncRow.add_child(syncVal);
                detailBox.add_child(syncRow);
            }

            // QoS-Aushandlung (BNG/BRAS Shaper) (nur wenn Online)
            if (iface.is_up && iface.qos_formatted) {
                const qosRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 2px;' });
                const qosLbl = new St.Label({
                    text: 'QoS-Aushandlung:  ',
                    style: `color: ${mutedColor}; font-weight: 600; font-size: 11px;`,
                });
                const qosVal = new St.Label({
                    text: iface.qos_formatted,
                    style: `color: ${sectionColor}; font-weight: 500; font-size: 11px;`,
                });
                qosRow.add_child(qosLbl);
                qosRow.add_child(qosVal);
                detailBox.add_child(qosRow);
            }

            // Lokale Schnittstelle Details
            if (iface.ip_type === 'Lokal') {
                const locRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 2px;' });
                const locLbl = new St.Label({
                    text: 'Schnittstelle:  ',
                    style: `color: ${mutedColor}; font-weight: 600; font-size: 11px;`,
                });
                const locVal = new St.Label({
                    text: `${iface.index} (Lokales Linux-System /proc/net/dev)`,
                    style: `color: ${sectionColor}; font-size: 11px;`,
                });
                locRow.add_child(locLbl);
                locRow.add_child(locVal);
                detailBox.add_child(locRow);
            }

            sidecar.add_child(detailBox);
        } else if (!iface) {
            // Aggregated Gateway Summary
            const detailBox = new St.BoxLayout({
                vertical: true,
                style: `background-color: ${badgeBg}; border: 1px solid ${sidecarBorder}; border-radius: 6px; padding: 6px 10px; margin-top: 8px; margin-bottom: 8px;`,
            });
            const aggRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
            const aggLbl = new St.Label({
                text: 'Aggregierter Durchsatz:  ',
                style: `color: ${mutedColor}; font-weight: 600; font-size: 11px;`,
            });
            const aggVal = new St.Label({
                text: `${(conn.interfaces || []).length} Schnittstellen gesamt`,
                style: `color: ${sectionColor}; font-size: 11px;`,
            });
            aggRow.add_child(aggLbl);
            aggRow.add_child(aggVal);
            detailBox.add_child(aggRow);
            sidecar.add_child(detailBox);
        }

        // 3. Download Graph
        const dlBox = new St.BoxLayout({ vertical: true, style: 'margin-top: 4px; margin-bottom: 8px;' });
        const dlHead = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const dlIcon = new St.Icon({
            icon_name: 'go-down-symbolic',
            icon_size: 13,
            style: `color: ${graphDownColor}; margin-right: 5px;`,
        });
        const dlTitle = new St.Label({
            text: 'Download (Empfang)',
            style: `color: ${sectionColor}; font-weight: bold; font-size: 12px;`,
        });
        dlHead.add_child(dlIcon);
        dlHead.add_child(dlTitle);

        const rxCurrent = (hist && hist.rx && hist.rx.length > 0) ? hist.rx[hist.rx.length - 1] : 0;
        const rxPeak = (hist && hist.rx && hist.rx.length > 0) ? Math.max(...hist.rx) : 0;
        const rxFmt = this._formatSingleBps(rxCurrent, unitMode, unitFmt);
        const rxPeakFmt = this._formatSingleBps(rxPeak, unitMode, unitFmt);

        const dlStatsLabel = new St.Label({
            text: `  Aktuell: ${rxFmt}  ·  Peak: ${rxPeakFmt}`,
            style: `color: ${mutedColor}; font-size: 11px; margin-left: 8px;`,
        });
        dlHead.add_child(dlStatsLabel);
        dlBox.add_child(dlHead);

        const dlGraph = new ScaledDetailGraph(440, 95);
        dlGraph.setData((hist && hist.rx) ? hist.rx : [], graphDownColor, isDarkMode);
        dlBox.add_child(dlGraph);
        sidecar.add_child(dlBox);

        // 4. Upload Graph
        const ulBox = new St.BoxLayout({ vertical: true, style: 'margin-top: 4px; margin-bottom: 4px;' });
        const ulHead = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const ulIcon = new St.Icon({
            icon_name: 'go-up-symbolic',
            icon_size: 13,
            style: `color: ${graphUpColor}; margin-right: 5px;`,
        });
        const ulTitle = new St.Label({
            text: 'Upload (Senden)',
            style: `color: ${sectionColor}; font-weight: bold; font-size: 12px;`,
        });
        ulHead.add_child(ulIcon);
        ulHead.add_child(ulTitle);

        const txCurrent = (hist && hist.tx && hist.tx.length > 0) ? hist.tx[hist.tx.length - 1] : 0;
        const txPeak = (hist && hist.tx && hist.tx.length > 0) ? Math.max(...hist.tx) : 0;
        const txFmt = this._formatSingleBps(txCurrent, unitMode, unitFmt);
        const txPeakFmt = this._formatSingleBps(txPeak, unitMode, unitFmt);

        const ulStatsLabel = new St.Label({
            text: `  Aktuell: ${txFmt}  ·  Peak: ${txPeakFmt}`,
            style: `color: ${mutedColor}; font-size: 11px; margin-left: 8px;`,
        });
        ulHead.add_child(ulStatsLabel);
        ulBox.add_child(ulHead);

        const ulGraph = new ScaledDetailGraph(440, 95);
        ulGraph.setData((hist && hist.tx) ? hist.tx : [], graphUpColor, isDarkMode);
        ulBox.add_child(ulGraph);
        sidecar.add_child(ulBox);
    }

    _buildMenu(data) {
        this._lastData = data;
        this._hideHoverSidecar(true);
        const menu = this._indicator.menu;
        menu.removeAll();

        const isDarkMode = (this._interfaceSettings && this._interfaceSettings.get_string('color-scheme') === 'prefer-dark');

        let textColor, graphDownColor, graphUpColor, graphBgColor, cardBorderColor, cardBgColor;

        if (isDarkMode) {
            textColor = this._getStr('dropdown-dark-text-color', '#f6f6f6');
            graphDownColor = this._getStr('dropdown-dark-graph-color-download',
                             this._getStr('dropdown-graph-color-download', '#3584e4'));
            graphUpColor = this._getStr('dropdown-dark-graph-color-upload',
                           this._getStr('dropdown-graph-color-upload', '#33d17a'));
            graphBgColor = this._getStr('dropdown-dark-graph-bg-color', '#00000040');
            cardBorderColor = this._getStr('dropdown-dark-card-border-color', '#ffffff25');
            cardBgColor = this._getStr('dropdown-dark-card-bg-color', '#00000000');
        } else {
            textColor = this._getStr('menu-text-color', '#1a1a1a');
            graphDownColor = this._getStr('dropdown-graph-color-download',
                             this._getStr('graph-color-download', '#3584e4'));
            graphUpColor = this._getStr('dropdown-graph-color-upload',
                           this._getStr('graph-color-upload', '#33d17a'));
            graphBgColor = this._getStr('dropdown-graph-bg-color', '#00000018');
            cardBorderColor = this._getStr('dropdown-card-border-color', '#00000022');
            cardBgColor = this._getStr('dropdown-card-bg-color', '#00000000');
        }

        const hexToCssColor = (hex) => {
            if (!hex || hex === 'transparent' || hex === 'none') return 'transparent';
            const h = hex.trim();
            if (h.startsWith('#') && h.length === 9) {
                const r = parseInt(h.slice(1, 3), 16);
                const g = parseInt(h.slice(3, 5), 16);
                const b = parseInt(h.slice(5, 7), 16);
                const a = (parseInt(h.slice(7, 9), 16) / 255.0).toFixed(2);
                return `rgba(${r}, ${g}, ${b}, ${a})`;
            }
            return h;
        };

        const cssCardBorder = hexToCssColor(cardBorderColor);
        const cssCardBg = hexToCssColor(cardBgColor);

        const showDropdownGraphs = this._getBool('show-dropdown-graphs', true);
        const showHoverPopout = this._getBool('show-hover-popout', true);
        const hoverDimHex = isDarkMode
            ? this._getStr('dropdown-dark-hover-dim-color', '#ffffff20')
            : this._getStr('dropdown-hover-dim-color', '#00000025');
        const showUptime = this._getBool('show-uptime', true);
        const showGatewayIp = this._getBool('show-gateway-ip', true);
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
            const cardItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'snmpbar-card-item',
            });

            const cardBox = new St.BoxLayout({
                style_class: 'snmpbar-card-box',
                vertical: true,
                style: `border: 1px solid ${cssCardBorder}; background-color: ${cssCardBg}; border-radius: 8px; padding: 10px 12px; margin: 4px 6px; min-width: 360px; max-width: 440px;`,
            });

            // 1. Header (Verbindungsname, Host & Uptime)
            const titleRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
            const isLocalConn = conn.is_local || ['localhost', 'local', '127.0.0.1'].includes(String(conn.host).toLowerCase());
            const hostIcon = new St.Icon({
                icon_name: isLocalConn ? 'computer-symbolic' : 'network-server-symbolic',
                icon_size: 16,
                style: `margin-right: 8px; color: ${textColor};`,
            });
            const titleText = (showGatewayIp && conn.host)
                ? `${conn.name} (${conn.host})`
                : conn.name;
            const headerLabel = new St.Label({
                text: titleText,
                style: styleTitle,
            });
            titleRow.add_child(hostIcon);
            titleRow.add_child(headerLabel);
            cardBox.add_child(titleRow);

            if (showUptime && conn.uptime_formatted) {
                const uptimeRow = new St.BoxLayout({
                    vertical: false,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'margin-left: 24px; margin-top: 2px; margin-bottom: 6px;',
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
                cardBox.add_child(uptimeRow);
            } else {
                titleRow.style = (titleRow.style || '') + ' margin-bottom: 6px;';
            }

            // 2. Aggregierte Gesamtleistung (nur wenn aktiv oder standardmäßig bei mehr als 1 Interface)
            const ifaces = conn.interfaces || [];
            const showAggregated = typeof conn.show_aggregated === 'boolean'
                ? conn.show_aggregated
                : (ifaces.length > 1);

            if (showAggregated && ifaces.length > 0) {
                const total = conn.total;
                const totalKey = `${conn.id || 'conn_1'}:total`;
                const totalHist = this._getOrCreateHistory(totalKey);

                const lbContainer = new St.BoxLayout({
                    vertical: true,
                    style: 'margin-top: 4px; margin-bottom: 8px;',
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
                    totalGraph.setHoverDimColor(hoverDimHex);
                    totalGraph.setHistory(totalHist.rx, totalHist.tx);
                    totalGraph.reactive = true;
                    totalGraph.track_hover = true;

                    if (showHoverPopout) {
                        totalGraph.connect('enter-event', () => {
                            totalGraph.setHovered(true);
                            this._showHoverSidecar(conn, null, totalGraph, totalHist, isDarkMode);
                            return Clutter.EVENT_PROPAGATE;
                        });
                        totalGraph.connect('leave-event', () => {
                            totalGraph.setHovered(false);
                            this._hideHoverSidecar();
                            return Clutter.EVENT_PROPAGATE;
                        });
                    }

                    lbContainer.add_child(totalGraph);
                }

                // Ratenzeile gemäß unit-display & bar-unit-format
                const totalFmt = this._formatText(total, unitMode, unitFmt);
                const lbRatesLabel = new St.Label({
                    text: totalFmt.combined,
                    style: styleNormal,
                });
                lbContainer.add_child(lbRatesLabel);

                cardBox.add_child(lbContainer);
            }

            // 3. Schnittstellen dieser Verbindung
            const ifacesContainer = new St.BoxLayout({
                vertical: true,
                style: 'margin-top: 4px;',
            });

            const ifacesTitle = new St.Label({
                text: 'Schnittstellen',
                style: styleSection,
            });
            ifacesContainer.add_child(ifacesTitle);

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
                        ifaceGraph.setHoverDimColor(hoverDimHex);
                        ifaceGraph.setHistory(ifaceHist.rx, ifaceHist.tx);
                        ifaceGraph.reactive = true;
                        ifaceGraph.track_hover = true;

                        if (showHoverPopout) {
                            ifaceGraph.connect('enter-event', () => {
                                ifaceGraph.setHovered(true);
                                this._showHoverSidecar(conn, iface, ifaceGraph, ifaceHist, isDarkMode);
                                return Clutter.EVENT_PROPAGATE;
                            });
                            ifaceGraph.connect('leave-event', () => {
                                ifaceGraph.setHovered(false);
                                this._hideHoverSidecar();
                                return Clutter.EVENT_PROPAGATE;
                            });
                        }

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

            cardBox.add_child(ifacesContainer);
            cardItem.add_child(cardBox);
            menu.addMenuItem(cardItem);
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
                    if (stdout && this._indicator) {
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
        if (!this._indicator) return;
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
