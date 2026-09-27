// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import {setRuntimeAppUrlOverride} from '@electron/common/DesktopConfig';
import {requirePrivilegedRendererDocumentSender} from '@electron/main/PrivilegedRendererDocuments';
import {getMainWindow} from '@electron/main/Window';
import {app, ipcMain, type IpcMainInvokeEvent} from 'electron';
import {loadServerPreferences, PRESET_SERVERS, resolveServer, saveServerPreferences, serverFromOrigin, type ServerPreferences} from './Servers.mjs';

let preferences: ServerPreferences = {selectedOrigin: PRESET_SERVERS[0].origin, customOrigins: []};
let preferencesPath: string;
let changing = false;
export function getSelectedServer() { return serverFromOrigin(preferences.selectedOrigin); }
export async function initializeServerSelection(userDataPath: string): Promise<void> {
    preferencesPath = path.join(userDataPath, 'servers.json');
    preferences = await loadServerPreferences(preferencesPath);
    setRuntimeAppUrlOverride(getSelectedServer().origin);
}
function requireMainDocument(event: IpcMainInvokeEvent): void {
    requirePrivilegedRendererDocumentSender(event, 'tcn-server-selection');
    if (event.sender !== getMainWindow()?.webContents) throw new Error('Server selection requires the main window.');
}
export function registerServerSelection(): void {
    ipcMain.handle('tcn-server-state', event => {
        requireMainDocument(event);
        return {selected: getSelectedServer(), presets: PRESET_SERVERS};
    });
    ipcMain.handle('tcn-server-select', (event, origin: unknown) =>
        selectServer(origin, () => requireMainDocument(event)));
}

// Native menu callers own their own local document; remote callers must supply the IPC guard.
export async function selectServer(origin: unknown, validateCaller: () => void): Promise<{ok: boolean; error?: string}> {
    validateCaller();
    if (changing) return {ok: false, error: 'A server change is already in progress.'};
    if (typeof origin !== 'string' || origin.length > 2048) return {ok: false, error: 'Enter a complete HTTPS server address.'};
    changing = true;
    try {
        const candidate = await resolveServer(origin);
        validateCaller();
        if (candidate.origin === preferences.selectedOrigin) return {ok: true};
        const customOrigins = candidate.id.startsWith('custom-')
            ? [candidate.origin, ...preferences.customOrigins.filter(value => value !== candidate.origin)].slice(0, 32)
            : preferences.customOrigins;
        await saveServerPreferences(preferencesPath, {selectedOrigin: candidate.origin, customOrigins});
        // Keep current trust/partition until restart clears upstream native voice state.
        app.relaunch();
        app.quit();
        return {ok: true};
    } catch {
        return {ok: false, error: 'Could not connect. Check the HTTPS address and try again.'};
    } finally { changing = false; }
}
