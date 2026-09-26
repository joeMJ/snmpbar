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

        // --- Gruppe 1: Verbindung & SNMP-Konfiguration ---
        const connGroup = new Adw.PreferencesGroup({
            title: _('SNMP-Verbindung'),
            description: _('Verbindungsdaten für das Gateway / den Load Balancer'),
        });
        page.add(connGroup);

        // Host IP
        const hostRow = new Adw.EntryRow({
            title: _('Router / Gateway IP'),
            text: settings.get_string('host'),
        });
        hostRow.connect('changed', (entry) => {
            settings.set_string('host', entry.text);
        });
        connGroup.add(hostRow);

        // Community String
        const commRow = new Adw.PasswordEntryRow({
            title: _('SNMP Community String'),
            text: settings.get_string('community'),
        });
        commRow.connect('changed', (entry) => {
            settings.set_string('community', entry.text);
        });
        connGroup.add(commRow);

        // SNMP Version Dropdown
        const verModel = Gtk.StringList.new(['v2c', 'v1', 'v3']);
        const currentVer = settings.get_string('snmp-version');
        let selectedIdx = 0;
        if (currentVer === 'v1') selectedIdx = 1;
        else if (currentVer === 'v3') selectedIdx = 2;

        const verRow = new Adw.ComboRow({
            title: _('SNMP-Version'),
            model: verModel,
            selected: selectedIdx,
        });
        verRow.connect('notify::selected', () => {
            const val = verModel.get_string(verRow.selected);
            settings.set_string('snmp-version', val);
        });
        connGroup.add(verRow);

        // Refresh Interval
        const intervalRow = new Adw.SpinRow({
            title: _('Abfrageintervall (Sekunden)'),
            subtitle: _('Empfohlen: 2 bis 5 Sekunden'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        connGroup.add(intervalRow);

        // --- Gruppe 2: Darstellung in der GNOME Top-Bar ---
        const displayGroup = new Adw.PreferencesGroup({
            title: _('Top-Bar Anzeige (Selektiv)'),
            description: _('Wähle aus, welche Werte und Graphen direkt im Systempanel erscheinen sollen'),
        });
        page.add(displayGroup);

        // Darstellungsmodus (Zahl / Graph / Beides)
        const modeModel = Gtk.StringList.new([_('Zahl und Graph'), _('Nur Zahl'), _('Nur Graph')]);
        const curMode = settings.get_string('display-mode');
        let modeIdx = 0;
        if (curMode === 'numeric') modeIdx = 1;
        else if (curMode === 'graph') modeIdx = 2;

        const modeRow = new Adw.ComboRow({
            title: _('Darstellungsart'),
            model: modeModel,
            selected: modeIdx,
        });
        modeRow.connect('notify::selected', () => {
            const mapping = ['both', 'numeric', 'graph'];
            settings.set_string('display-mode', mapping[modeRow.selected]);
        });
        displayGroup.add(modeRow);

        // Switch: Load Balancer Gesamt
        const lbTotalRow = new Adw.SwitchRow({
            title: _('Load Balancer Gesamt'),
            subtitle: _('Aggregierter Durchsatz aller aktiven WAN-Verbindungen'),
        });
        settings.bind('show-in-bar-lb-total', lbTotalRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(lbTotalRow);

        // Switch: VDSL
        const vdslRow = new Adw.SwitchRow({
            title: _('VDSL (INTERNET) separat anzeigen'),
            subtitle: _('Eigenes Element für VDSL-Durchsatz in der Leiste'),
        });
        settings.bind('show-in-bar-vdsl', vdslRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(vdslRow);

        // Switch: 5G WWAN
        const wwanRow = new Adw.SwitchRow({
            title: _('5G Mobilfunk (INET_WWAN) separat anzeigen'),
            subtitle: _('Eigenes Element für Mobilfunk-Durchsatz in der Leiste'),
        });
        settings.bind('show-in-bar-wwan', wwanRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(wwanRow);

        // Switch: GPON
        const gponRow = new Adw.SwitchRow({
            title: _('Glasfaser (GPON) separat anzeigen'),
            subtitle: _('Eigenes Element für Glasfaser in der Leiste'),
        });
        settings.bind('show-in-bar-gpon', gponRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(gponRow);
    }
}
