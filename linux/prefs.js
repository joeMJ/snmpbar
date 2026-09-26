import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

export default class SnmpBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Haupt-Einstellungsseite
        const page = new Adw.PreferencesPage({
            title: _('Allgemein'),
            icon_name: 'network-server-symbolic',
        });
        window.add(page);

        // Gruppe: Aktualisierung & Anzeige
        const generalGroup = new Adw.PreferencesGroup({
            title: _('Anzeige & Aktualisierung'),
            description: _('Einstellungen für die Darstellung im GNOME-Panel'),
        });
        page.add(generalGroup);

        // SpinRow: Refresh Interval
        const intervalRow = new Adw.SpinRow({
            title: _('Abfrageintervall (Sekunden)'),
            subtitle: _('Häufigkeit der SNMP-Aktualisierung'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(intervalRow);

        // SwitchRow: Gateway in Bar
        const gwRow = new Adw.SwitchRow({
            title: _('Gateway in Top-Bar anzeigen'),
            subtitle: _('Zeigt Up- und Downstream des Gateways direkt in der Leiste an'),
        });
        settings.bind('show-in-bar-gateway', gwRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(gwRow);

        // SwitchRow: LB Total in Bar
        const lbTotalRow = new Adw.SwitchRow({
            title: _('Load Balancer Gesamt in Top-Bar anzeigen'),
            subtitle: _('Zeigt aggregierten Durchsatz des Load Balancers an'),
        });
        settings.bind('show-in-bar-lb-total', lbTotalRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(lbTotalRow);

        // SwitchRow: LB Interfaces in Bar
        const lbIfacesRow = new Adw.SwitchRow({
            title: _('Load Balancer Interfaces in Top-Bar anzeigen'),
            subtitle: _('Zeigt einzelne Interfaces in der Leiste an'),
        });
        settings.bind('show-in-bar-lb-interfaces', lbIfacesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(lbIfacesRow);
    }
}
