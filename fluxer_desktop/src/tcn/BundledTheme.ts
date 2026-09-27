// SPDX-License-Identifier: AGPL-3.0-or-later
import tcnThemeCss from '../../../tcn/themes/TCN.theme.css';

// Compatibility boundary: Fluxer ThemeLibraryDb v1 and ThemeStudioBroadcast.
const DATABASE = 'fluxer-theme-library';
const MARKER = 'tcn:bundled-theme:1';
export const TCN_THEME_ID = 'tcn-bundled-theme-v1';
const stores = ['themes', 'assets', 'localFiles', 'meta'] as const;
export type RegistrationResult = 'added' | 'existing' | 'remembered' | 'unsupported' | 'skipped';

export function isTcnThemeTarget(origin: string, selected: {origin: string; branding: boolean}, mainFrame: boolean): boolean {
    return mainFrame && selected.branding === true && origin === selected.origin;
}

function openLibrary(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = factory.open(DATABASE, 1);
        let abandoned = false;
        request.onupgradeneeded = event => {
            // Only initialize a new library; never migrate another schema.
            if (event.oldVersion !== 0) { request.transaction?.abort(); return; }
            for (const name of stores) request.result.createObjectStore(name, name === 'meta' ? undefined : {keyPath: 'id'});
        };
        request.onsuccess = () => {
            if (abandoned) { request.result.close(); return; }
            resolve(request.result);
        };
        request.onerror = () => reject(request.error ?? new Error('Theme library unavailable'));
        request.onblocked = () => { abandoned = true; reject(new Error('Theme library is busy')); };
    });
}

function matchesSchema(db: IDBDatabase): boolean {
    if (db.version !== 1 || db.objectStoreNames.length !== stores.length || stores.some(name => !db.objectStoreNames.contains(name))) return false;
    const tx = db.transaction(stores, 'readonly');
    return stores.every(name => {
        const store = tx.objectStore(name);
        return store.keyPath === (name === 'meta' ? null : 'id') && !store.autoIncrement;
    });
}

export async function registerTcnTheme(factory: IDBFactory): Promise<RegistrationResult> {
    let db: IDBDatabase;
    try { db = await openLibrary(factory); }
    catch (error) {
        if (error instanceof DOMException && error.name === 'VersionError') return 'unsupported';
        throw error;
    }
    try {
        if (!matchesSchema(db)) return 'unsupported';
        return await new Promise<RegistrationResult>((resolve, reject) => {
            // Serialize concurrent windows and commit the theme plus marker atomically.
            // enabledThemeIds is deliberately never read or written here.
            const tx = db.transaction(['themes', 'meta'], 'readwrite');
            const themes = tx.objectStore('themes');
            const meta = tx.objectStore('meta');
            let result: RegistrationResult = 'remembered';
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error ?? new Error('Theme registration aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('Theme registration failed'));
            const marker = meta.get(MARKER);
            marker.onsuccess = () => {
                // A later deletion/edit is the user's choice; never restore/overwrite it.
                if (marker.result !== undefined) return;
                const all = themes.getAll();
                all.onsuccess = () => {
                    const previous = all.result.find(theme => theme?.id === TCN_THEME_ID || theme?.css === tcnThemeCss);
                    if (previous) {
                        meta.put({themeId: previous.id}, MARKER);
                        result = 'existing';
                        return;
                    }
                    const timestamp = Date.now();
                    themes.add({
                        id: TCN_THEME_ID, name: 'TCN',
                        description: 'Optional blue-charcoal, teal and gold palette for the Dark base theme. Other base themes remain unchanged.',
                        author: 'The Cantina Network', version: '1.0.0', tags: ['dark', 'tcn'],
                        css: tcnThemeCss, fileName: 'TCN.theme.css', source: 'import',
                        createdAt: timestamp, updatedAt: timestamp,
                    });
                    meta.put({themeId: TCN_THEME_ID}, MARKER);
                    result = 'added';
                };
            };
        });
    } finally { db.close(); }
}

export async function installBundledTcnTheme(selected: {origin: string; branding: boolean}, mainFrame: boolean): Promise<RegistrationResult> {
    if (!isTcnThemeTarget(location.origin, selected, mainFrame)) return 'skipped';
    const result = await registerTcnTheme(indexedDB);
    if (result === 'added') {
        // Reload an already-hydrated renderer through its existing cross-window protocol.
        const channel = new BroadcastChannel('fluxer-theme-studio');
        channel.postMessage({type: 'themeLibrary', revision: Date.now(), origin: 'tcn-bundled-theme'});
        channel.close();
    }
    return result;
}
