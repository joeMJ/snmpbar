import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export default class SnmpBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Panel Button Indicator
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        const box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
            vertical: false,
        });

        this._label = new St.Label({
            text: 'SNMP: --/--',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(this._label);
        this._indicator.add_child(box);

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        console.log(`[snmpbar] Extension ${this.uuid} aktiviert.`);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
        console.log(`[snmpbar] Extension ${this.uuid} deaktiviert.`);
    }
}
