// Zugangsdaten (SNMP-Communities, ORB-Token, APIVoid-Key) im GNOME-Schlüsselbund (libsecret).
//
// WICHTIG: Aus dem GNOME-Shell-Prozess (extension.js) NIE einen Entsperr-Dialog auslösen –
// bei gesperrtem Schlüsselbund (z. B. Login per YubiKey/FIDO) stürzt die Shell sonst ab.
// Deshalb: loadSecrets(), storeSecret() und migrateLegacy() (ohne allowUnlock) arbeiten dialogfrei.
// Nur prefs.js (eigener Prozess) darf unlockDefault() bzw. allowUnlock = true verwenden.
import Secret from 'gi://Secret';
import Gio from 'gi://Gio';

export const KEY_ORB = 'orb-token';
export const KEY_APIVOID = 'apivoid-key';
export const communityKey = connId => `snmp-community:${connId}`;

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.snmpbar',
    Secret.SchemaFlags.NONE,
    {key: Secret.SchemaAttributeType.STRING}
);

const LABELS = {
    [KEY_ORB]: 'snmpbar – ORB Cloud API-Token',
    [KEY_APIVOID]: 'snmpbar – APIVoid API-Key',
};
const labelFor = key => LABELS[key] ?? `snmpbar – SNMP-Community (${key.replace(/^snmp-community:/, '')})`;

Gio._promisify(Secret.Service, 'get', 'get_finish');
Gio._promisify(Secret.Service.prototype, 'search', 'search_finish');
Gio._promisify(Secret.Service.prototype, 'unlock', 'unlock_finish');
Gio._promisify(Secret.Collection, 'for_alias', 'for_alias_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

async function defaultCollection(service) {
    return Secret.Collection.for_alias(service, 'default', Secret.CollectionFlags.NONE, null);
}

/**
 * Liest alle snmpbar-Einträge OHNE Dialog.
 * @returns {Promise<{values: Object<string,string>, locked: boolean, available: boolean}>}
 */
export async function loadSecrets() {
    const result = {values: {}, locked: false, available: true};
    try {
        const service = await Secret.Service.get(Secret.ServiceFlags.NONE, null);
        const items = await service.search(
            SCHEMA, {},
            Secret.SearchFlags.ALL | Secret.SearchFlags.LOAD_SECRETS, null);
        for (const item of items) {
            if (item.get_locked()) {
                result.locked = true;
                continue;
            }
            const key = item.get_attributes()['key'];
            const value = item.get_secret()?.get_text();
            if (key && value !== null && value !== undefined)
                result.values[key] = value;
        }
        // Kein Treffer: entweder wirklich leer oder Schlüsselbund gesperrt → Sperrzustand direkt prüfen
        if (!result.locked) {
            const collection = await defaultCollection(service);
            if (!collection || collection.get_locked())
                result.locked = true;
        }
    } catch (e) {
        console.warn(`[snmpbar] Schlüsselbund nicht verfügbar: ${e}`);
        result.available = false;
        result.locked = true;
    }
    return result;
}

/** true, wenn der Standard-Schlüsselbund verfügbar und entsperrt ist (ohne Dialog). */
export async function isUnlocked() {
    try {
        const service = await Secret.Service.get(Secret.ServiceFlags.NONE, null);
        const collection = await defaultCollection(service);
        return !!collection && !collection.get_locked();
    } catch (e) {
        return false;
    }
}

/** Entsperren mit Dialog – ausschließlich aus prefs.js aufrufen! */
export async function unlockDefault() {
    try {
        const service = await Secret.Service.get(Secret.ServiceFlags.NONE, null);
        const collection = await defaultCollection(service);
        if (!collection) return false;
        if (collection.get_locked())
            await service.unlock([collection], null);
        return !collection.get_locked();
    } catch (e) {
        console.warn(`[snmpbar] Entsperren fehlgeschlagen: ${e}`);
        return false;
    }
}

/**
 * Speichert ein Secret. Ohne allowUnlock nur, wenn der Schlüsselbund bereits entsperrt ist.
 * @returns {Promise<boolean>} true = gespeichert
 */
export async function storeSecret(key, value, allowUnlock = false) {
    if (!(await isUnlocked())) {
        if (!allowUnlock || !(await unlockDefault()))
            return false;
    }
    try {
        await Secret.password_store(SCHEMA, {key}, Secret.COLLECTION_DEFAULT, labelFor(key), value, null);
        return true;
    } catch (e) {
        console.warn(`[snmpbar] Speichern im Schlüsselbund fehlgeschlagen: ${e}`);
        return false;
    }
}

/** Löscht ein Secret (nur wenn entsperrt bzw. mit allowUnlock). */
export async function clearSecret(key, allowUnlock = false) {
    if (!(await isUnlocked())) {
        if (!allowUnlock || !(await unlockDefault()))
            return false;
    }
    try {
        await Secret.password_clear(SCHEMA, {key}, null);
        return true;
    } catch (e) {
        console.warn(`[snmpbar] Löschen im Schlüsselbund fehlgeschlagen: ${e}`);
        return false;
    }
}

function parseConnections(settings) {
    try {
        const list = JSON.parse(settings.get_string('connections-json'));
        if (Array.isArray(list)) return list;
    } catch (e) {}
    return [];
}

/**
 * Einmalige Migration alter Klartext-Werte aus dconf in den Schlüsselbund.
 * Ablauf: speichern → zurücklesen und vergleichen → erst dann den dconf-Wert entfernen.
 * Solange der Schlüsselbund gesperrt ist (und allowUnlock nicht gesetzt), bleibt alles unverändert
 * und dconf dient weiter als Fallback.
 * @returns {Promise<{migrated: boolean, locked: boolean}>}
 */
export async function migrateLegacy(settings, allowUnlock = false) {
    const conns = parseConnections(settings);

    // Kandidaten: [Schlüsselbund-Key, Klartextwert]
    const legacy = [];
    const orb = settings.get_string('orb-api-token');
    if (orb) legacy.push([KEY_ORB, orb]);
    const apivoid = settings.get_string('apivoid-api-key');
    if (apivoid) legacy.push([KEY_APIVOID, apivoid]);
    for (const c of conns) {
        if (c && c.id && typeof c.community === 'string' && c.community !== '')
            legacy.push([communityKey(c.id), c.community]);
    }
    const legacyCommunityKey = settings.get_string('community');
    const hasLegacySingle = legacyCommunityKey !== '' && conns.length === 0;
    if (hasLegacySingle) legacy.push([communityKey('conn_1'), legacyCommunityKey]);

    const staleKeys = ['orb-api-token', 'apivoid-api-key', 'community'].filter(k => settings.get_string(k) !== '');
    if (legacy.length === 0 && staleKeys.length === 0)
        return {migrated: false, locked: false};

    if (!(await isUnlocked())) {
        if (!allowUnlock || !(await unlockDefault()))
            return {migrated: false, locked: true};
    }

    const before = await loadSecrets();
    if (before.locked) return {migrated: false, locked: true};

    const justStored = new Set();
    for (const [key, value] of legacy) {
        if (before.values[key] === undefined || before.values[key] === '') {
            if (await storeSecret(key, value, false))
                justStored.add(key);
        }
    }

    const after = await loadSecrets();
    const ok = new Set();
    for (const [key, value] of legacy) {
        const stored = after.values[key];
        if (stored === undefined || stored === '') continue;
        // frisch geschriebene Werte müssen exakt übereinstimmen, bestehende Keyring-Werte haben Vorrang
        if (!justStored.has(key) || stored === value)
            ok.add(key);
    }

    // dconf bereinigen – nur, was verifiziert im Schlüsselbund liegt
    if (ok.has(KEY_ORB) || !orb) settings.reset('orb-api-token');
    if (ok.has(KEY_APIVOID) || !apivoid) settings.reset('apivoid-api-key');

    const legacySingleDone = !hasLegacySingle || ok.has(communityKey('conn_1'));
    const allConnsDone = conns.every(c => !(c && c.id && c.community) || ok.has(communityKey(c.id)));
    if (allConnsDone && legacySingleDone) {
        if (conns.length > 0) {
            for (const c of conns) delete c.community;
            settings.set_string('connections-json', JSON.stringify(conns));
        }
        settings.reset('community');
    }

    // Extension/Prefs informieren, dass sich der Keyring geändert hat
    settings.set_int('secrets-revision', settings.get_int('secrets-revision') + 1);
    return {migrated: true, locked: false};
}
