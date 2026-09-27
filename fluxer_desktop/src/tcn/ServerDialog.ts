// SPDX-License-Identifier: AGPL-3.0-or-later
import {randomUUID} from 'node:crypto';
import {getMainWindow} from '@electron/main/Window';
import {BrowserWindow, session} from 'electron';
import {getSelectedServer, selectServer} from './ServerState';
import {PRESET_SERVERS} from './Servers.mjs';

let chooser: BrowserWindow | null = null;
const escape = (text: string): string => text.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

// Locally owned, scriptless fallback: server choice remains available when the hosted page cannot load.
export function openServerDialog(): void {
    if (chooser && !chooser.isDestroyed()) { chooser.show(); chooser.focus(); return; }
    const current = getSelectedServer();
    let choice = PRESET_SERVERS.find(server => server.origin === current.origin)?.id ?? 'custom';
    let customOrigin = choice === 'custom' ? current.origin : '';
    let busy = false;
    const isolated = session.fromPartition(`tcn-server-dialog-${randomUUID()}`, {cache: false});
    isolated.protocol.handle('tcn-server-choice', () => new Response('Not found', {status: 404}));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setDevicePermissionHandler(() => false);
    isolated.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    isolated.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (_details, callback) => callback({cancel: true}));
    const parent = getMainWindow() ?? undefined;
    const window = new BrowserWindow({title: 'TCN Chat — Choose server', parent, modal: !!parent, width: 480, height: 450,
        resizable: false, show: false, backgroundColor: '#0b151c', autoHideMenuBar: true,
        webPreferences: {session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true}});
    chooser = window;
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.on('closed', () => { if (chooser === window) chooser = null; });
    window.once('ready-to-show', () => window.show());
    async function render(message = ''): Promise<void> {
        if (window.isDestroyed()) return;
        const options = [['tcn','Prod'],['tcn-staging','Staging'],['fluxer','Fluxer'],['custom','Custom']]
            .map(([id,label]) => `<option value="${id}"${id === choice ? ' selected' : ''}>${label}</option>`).join('');
        const disabled = busy ? ' disabled' : '';
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action tcn-server-choice:; base-uri 'none'"><style>
            body{margin:28px;background:#0b151c;color:#edf3f4;font:14px/1.5 system-ui,sans-serif}h1{font-size:20px;margin:0 0 12px}p{color:#a3b0b6}label{display:block;margin:12px 0 4px}select,input,button{box-sizing:border-box;width:100%;font:inherit;border:1px solid #33454e;border-radius:6px;padding:8px;background:#111d25;color:#edf3f4}button{margin-top:14px;background:#175251;cursor:pointer}:focus-visible{outline:2px solid #59c8c4;outline-offset:2px}.custom{display:none}form:has(option[value=custom]:checked) .custom{display:block}.status{font-size:12px;margin:8px 0}body:has(.custom input:focus){user-select:auto}
        </style></head><body><h1>Choose server</h1><p>Each server keeps its own sign-in. Switching restarts the client.</p><form action="tcn-server-choice://select" method="get"><label for="server">Server</label><select id="server" name="server"${disabled}>${options}</select><div class="custom"><label for="origin">Custom server URL</label><input id="origin" name="origin" type="url" maxlength="2048" placeholder="https://chat.example.org" value="${escape(customOrigin)}"${disabled}></div><button type="submit"${disabled}>${busy ? 'Connecting…' : 'Connect'}</button><p class="status" role="status">${escape(message)}</p></form></body></html>`;
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    }
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.on('will-navigate', (event, target) => {
        event.preventDefault();
        if (busy) return;
        const url = new URL(target);
        if (url.protocol !== 'tcn-server-choice:' || url.host !== 'select') return;
        choice = url.searchParams.get('server') ?? '';
        customOrigin = (url.searchParams.get('origin') ?? '').slice(0,2048);
        const origin = choice === 'custom' ? customOrigin : PRESET_SERVERS.find(server => server.id === choice)?.origin;
        busy = true;
        void (async () => {
            try {
                await render();
                const result = await selectServer(origin, () => { if (window.isDestroyed()) throw new Error('Chooser closed'); });
                if (result.ok) { if (!window.isDestroyed()) window.close(); return; }
                busy = false; await render(result.error);
            } catch { busy = false; await render('Could not change servers. Please try again.'); }
        })();
    });
    void render().catch(() => { if (!window.isDestroyed()) window.close(); });
}
