// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden, credential-free integration harness. OS registration/UI is suppressed only in this test process.
const {app, BrowserWindow, dialog, Menu} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const originalFs = require('original-fs');
const {pathToFileURL} = require('node:url');
const root = path.resolve(process.env.TCN_SMOKE_PACKAGE || path.join(__dirname, '..'));
const output = path.resolve(process.env.TCN_SMOKE_OUTPUT || path.join(os.tmpdir(), 'tcn-native-smoke-output'));
fs.mkdirSync(output, {recursive: true});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tcn-native-smoke-'));
const offline = process.env.TCN_SMOKE_OFFLINE === '1';
const expectedError = process.env.TCN_SMOKE_EXPECT_ERROR || null;
assert.ok(expectedError === null || expectedError === 'missing-bridge-version');
const origin = process.env.TCN_SMOKE_ORIGIN || 'https://chat.server60.the-cantina.net';
const allowed = new Set(['https://chat.the-cantina.net', 'https://chat.server60.the-cantina.net', 'https://web.fluxer.app']);
assert.ok(allowed.has(origin), 'Smoke test accepts only the documented public presets.');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const channel = process.env.TCN_EXPECT_CHANNEL || 'stable';
assert.ok(['stable', 'canary'].includes(channel));
assert.equal(metadata.name, root.endsWith('.asar') ? (channel === 'canary' ? 'tcn_chat_desktop_canary' : 'tcn_chat_desktop') : 'fluxer_desktop');
if (process.env.TCN_EXPECT_VERSION) assert.equal(metadata.version, process.env.TCN_EXPECT_VERSION);
const receipt = {packageRoot: root, version: metadata.version, channel, asarSha256: root.endsWith('.asar') ? crypto.createHash('sha256').update(originalFs.readFileSync(root)).digest('hex') : null, origin, profileIsTemporary: true, fullPreload: true, registrationSuppressed: true, errors: [], protocolRequests: [], autostartRequestsSuppressed: 0};
app.setPath('appData', profile);
app.getAppPath = () => root;
app.getVersion = () => metadata.version;
Object.defineProperty(app, 'isPackaged', {get: () => true});
if (root.endsWith('.asar')) Object.defineProperty(process, 'resourcesPath', {value: path.dirname(root)});
const userData = path.join(profile, channel === 'canary' ? 'tcn-chat-desktop-canary' : 'tcn-chat-desktop');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'servers.json'), JSON.stringify({selectedOrigin: origin, customOrigins: []}));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({window_behavior: {showTrayIcon: false, closeToTray: false, useNativeTitleBar: true}}));
app.setAsDefaultProtocolClient = protocol => { receipt.protocolRequests.push(protocol); return true; };
app.setUserTasks = () => true;
app.setJumpList = () => 'ok';
app.setLoginItemSettings = () => { receipt.autostartRequestsSuppressed++; };
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
dialog.showErrorBox = (title, message) => { receipt.errors.push({title, message}); };
dialog.showMessageBox = async () => { throw new Error('Unexpected interactive dialog during hidden smoke test'); };
const quit = app.quit.bind(app);
if (expectedError) {
    app.relaunch = () => { receipt.relaunchRequested = true; };
    app.quit = () => { receipt.quitRequested = true; };
}
let completed = false;
function save() { fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)); }
process.on('exit', code => { receipt.exitCode = code; save(); });
const timeout = setTimeout(() => { receipt.errors.push('Native startup timed out'); save(); app.exit(1); }, 90000);
app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (event, level, message) => { const value=message ?? event.message; if (typeof value==='string' && value.includes('TCN optional theme')) receipt.errors.push(value); });
    contents.on('preload-error', (_event, preloadPath, error) => receipt.errors.push({preloadPath, error: error.message}));
});
app.on('browser-window-created', (_event, window) => {
    if (offline && !completed) window.webContents.session.webRequest.onBeforeRequest({urls: ['https://*/*', 'http://*/*']}, (_details, callback) => callback({cancel: true}));
    const run = async () => {
        if (completed || (!offline && !window.webContents.getURL().startsWith(origin))) return;
        completed = true;
        try {
            await new Promise(resolve => setTimeout(resolve, offline ? 500 : 4500));
            if (!offline) {
            receipt.page = await window.webContents.executeJavaScript(`(async () => ({
                title: document.title, url: location.href, native: typeof window.electron,
                platform: window.electron?.platform,
                info: await window.electron?.getDesktopInfo(),
                settings: await window.electron?.getDesktopWindowBehaviorSettings(),
                selectorPresent: !!document.querySelector('tcn-server-selector'),
                selectorHidden: document.querySelector('tcn-server-selector')?.hidden,
                warning: [...document.querySelectorAll('[data-flx*="corrupted-installation"]')].some(node => node.getBoundingClientRect().height > 0),
                bodyLength: document.body.innerText.length,
                logo: (() => { const el=document.querySelector('tcn-brand-logo');if(!el)return null; const r=el.getBoundingClientRect();return {width:r.width,height:r.height,label:el.getAttribute('aria-label')};})(),
                upstreamStatusVisible: !![...document.querySelectorAll('[data-flx="app.bootstrap-error-screen.a"]')].find(el=>el.checkVisibility()),
                retryPresent: [...document.querySelectorAll('[data-flx="app.bootstrap-error-screen.error-fallback-container"] button')].some(el=>el.checkVisibility() && el.textContent.trim() === "Try again"),
                resetPresent: [...document.querySelectorAll('[data-flx="app.bootstrap-error-screen.error-fallback-container"] button')].some(el=>el.checkVisibility() && el.textContent.trim() === "Reset app data"),
                bootstrapError: !!document.querySelector('[data-flx="app.bootstrap-error-screen.error-fallback-container"]')?.checkVisibility(),
                startupDiagnostic: document.querySelector('[data-flx="app.bootstrap-error-screen.error-fallback-description--2"]')?.textContent || null,
                startupError: document.body.innerText.includes('missing-bridge-version') ? 'missing-bridge-version' : null
            }))()`);
            fs.writeFileSync(path.join(output, 'startup-page.png'), (await window.webContents.capturePage()).toPNG());
            receipt.updater = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
                const timer = setTimeout(() => {dispose();reject(new Error('Updater event timed out'));}, 5000);
                const dispose = window.electron.onUpdaterEvent(event => {clearTimeout(timer);dispose();resolve(event);});
                window.electron.updaterCheck('background').catch(reject);
            })`);
            assert.equal(receipt.updater.type, 'unsupported');
            assert.equal(receipt.updater.reason, 'managed-package');
            assert.equal(receipt.updater.downloadUrl, undefined);
            assert.equal(receipt.page.native, 'object');
            assert.equal(receipt.page.platform, 'win32');
            assert.equal(receipt.page.info.version, metadata.version);
            assert.equal(receipt.page.warning, false, 'Full preload must remove the missing-bridge warning.');
            assert.equal(receipt.page.selectorPresent, true);
            if (origin.includes('the-cantina.net')) {
                assert.ok(receipt.page.logo);
                assert.ok(Math.abs(receipt.page.logo.width / receipt.page.logo.height - 571 / 422) < 0.002, 'Approved logo must preserve its native ratio');
                assert.equal(receipt.page.upstreamStatusVisible, false);
            } else assert.equal(receipt.page.logo, null, 'Official Fluxer retains its own branding');
            assert.ok(receipt.page.bodyLength > 60, 'Login page must not be blank.');
            }
            assert.equal(window.isVisible(), false);
            assert.equal(receipt.errors.length, 0);
            const marker = JSON.parse(fs.readFileSync(path.join(userData, 'native-module-preflight-v1.json'), 'utf8'));
            receipt.preflight = {version: marker.version, fingerprint: marker.fingerprint, completedAt: marker.completedAt};
            assert.equal(marker.version, 1);
            assert.deepEqual(receipt.protocolRequests, ['tcnchat']);
            if (!offline && !receipt.page.selectorHidden) fs.writeFileSync(path.join(output, 'login.png'), (await window.webContents.capturePage()).toPNG());
            receipt.nativeStartupPassed = true;

            if (!offline && process.env.TCN_SMOKE_THEME_LIBRARY === '1') {
                const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
                const waitFor = async expression => {
                    for (let attempt=0; attempt<150; attempt++) {
                        const value = await window.webContents.executeJavaScript(expression);
                        if (value) return value;
                        await pause(100);
                    }
                    throw new Error('Theme Studio UI condition timed out: ' + expression);
                };
                const click = async expression => {
                    const point = await waitFor(`(() => { const el=${expression}; if(!el || !el.checkVisibility())return null;const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
                    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
                    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
                };
                const openLibrary = async () => {
                    await window.loadURL(origin + '/theme-studio');
                    await waitFor('document.querySelector("[data-flx=\\"theme-studio.theme-studio-standalone-app.standalone-app-root\\"]") !== null');
                    await click('[...document.querySelectorAll("button")].find(el=>el.textContent.trim()==="Library")');
                    await waitFor('document.querySelector("[data-flx=\\"theme-studio.library-section.section\\"]") !== null');
                    if (origin.includes('the-cantina.net')) await waitFor("document.querySelector('[role=\"switch\"][aria-label=\"Enable TCN\"]') !== null");
                };
                const toggle = 'document.querySelector("[role=\\"switch\\"][aria-label=\\"Enable TCN\\"]")';
                const state = async () => window.webContents.executeJavaScript(`(() => ({
                    count: document.querySelectorAll('[data-flx="theme-studio.library-section.list-item"]').length,
                    tcnCount: [...document.querySelectorAll('[data-flx="theme-studio.library-section.list-item-name"]')].filter(el=>el.textContent.trim()==='TCN').length,
                    checked: ${toggle}?.getAttribute('aria-checked'),
                    url: location.href
                }))()`);
                await openLibrary();
                const branded = origin.includes('the-cantina.net');
                if (branded) await waitFor(toggle + " !== null");
                else await waitFor("document.querySelector('[data-flx=\"theme-studio.library-section.list-empty\"]') !== null");
                receipt.themeLibrary = {credentialFree:true, actualHostedReact:true, trustedPointer:true, fresh:await state()};
                assert.equal(receipt.themeLibrary.fresh.tcnCount, branded ? 1 : 0);
                await pause(750);
                await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
                fs.writeFileSync(path.join(output,'theme-library-default.png'), (await window.webContents.capturePage()).toPNG());
                if (branded) {
                    assert.equal(receipt.themeLibrary.fresh.checked,'false');
                    await click(toggle);
                    await waitFor(`${toggle}?.getAttribute('aria-checked') === 'true'`);
                    await openLibrary();
                    receipt.themeLibrary.afterEnabledReload = await state();
                    assert.equal(receipt.themeLibrary.afterEnabledReload.checked,'true');
                    assert.equal(receipt.themeLibrary.afterEnabledReload.tcnCount,1);
                await pause(750);
                await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
                    fs.writeFileSync(path.join(output,'theme-library-enabled.png'),(await window.webContents.capturePage()).toPNG());
                    await click(toggle);
                    await waitFor(`${toggle}?.getAttribute('aria-checked') === 'false'`);
                    await openLibrary();
                    receipt.themeLibrary.afterDisabledReload = await state();
                    assert.equal(receipt.themeLibrary.afterDisabledReload.checked,'false');
                    assert.equal(receipt.themeLibrary.afterDisabledReload.tcnCount,1);
                }
                receipt.themeLibrary.passed=true;
                await window.loadURL(origin);
                await pause(1200);
            }

            const menuItem = Menu.getApplicationMenu().getMenuItemById('tcn-select-server');
            assert.ok(menuItem);
            const created = new Promise(resolve => app.once('browser-window-created', (_event, chooser) => resolve(chooser)));
            menuItem.click();
            const chooser = await created;
            await new Promise(resolve => chooser.webContents.once('did-finish-load', resolve));
            receipt.chooser = await chooser.webContents.executeJavaScript(`(() => {
                const select = document.querySelector('select'); select.value = 'custom';
                return {native: typeof window.electron, node: typeof window.require, customVisible: getComputedStyle(document.querySelector('.custom')).display !== 'none', choices: [...select.options].map(option => option.textContent)};
            })()`);
            assert.equal(receipt.chooser.native, 'undefined');
            assert.equal(receipt.chooser.node, 'undefined');
            assert.equal(receipt.chooser.customVisible, true);
            assert.deepEqual(receipt.chooser.choices, ['Prod','Staging','Fluxer','Custom']);
            const failedChoice = new Promise(resolve => chooser.webContents.once('did-finish-load', () => {
                const waitForError = async () => {
                    if (chooser.isDestroyed()) return;
                    const status = await chooser.webContents.executeJavaScript('document.querySelector(".status")?.textContent');
                    if (status) resolve(status); else setTimeout(waitForError, 100);
                }; void waitForError();
            }));
            await chooser.webContents.executeJavaScript(`document.querySelector('input').value='http://invalid.example';document.querySelector('form').requestSubmit();`);
            receipt.chooser.invalidChoice = await failedChoice;
            assert.match(receipt.chooser.invalidChoice, /Could not connect/);
            assert.equal(JSON.parse(fs.readFileSync(path.join(userData,'servers.json'),'utf8')).selectedOrigin, origin);
            fs.writeFileSync(path.join(output, 'chooser.png'), (await chooser.webContents.capturePage()).toPNG());
            chooser.destroy();
            receipt.offlineRecovery = offline;
            receipt.chooserPassed = true;
            if (!offline) {
                receipt.hostedCompatible = !receipt.page.selectorHidden && !receipt.page.bootstrapError;
                if (expectedError) {
                    assert.equal(receipt.page.bootstrapError, true);
                    assert.equal(receipt.page.startupError, expectedError);
                    assert.equal(receipt.page.startupDiagnostic, "Native voice engine bridge is not available in this desktop app build: missing-bridge-version");
                    assert.equal(receipt.page.selectorHidden, false);
                    assert.equal(receipt.page.retryPresent, true);
                    assert.equal(receipt.page.resetPresent, true);
                    receipt.expectedStartupErrorObserved = true;
                } else assert.equal(receipt.hostedCompatible, true, `Hosted frontend is incompatible: ${receipt.page.startupError || 'login unavailable'}`);
                window.setSize(800, 600);
                await window.webContents.executeJavaScript(`document.querySelector('tcn-server-selector').scrollIntoView({block:'end'})`);
                await new Promise(resolve => setTimeout(resolve, 500));
                receipt.smallWindow = await window.webContents.executeJavaScript(`(() => {const el=document.querySelector('tcn-server-selector'); const r=el.getBoundingClientRect();return {width:innerWidth,height:innerHeight,selectorWidth:r.width,selectorBottom:r.bottom,horizontalOverflow:document.documentElement.scrollWidth>innerWidth};})()`);
                assert.equal(receipt.smallWindow.horizontalOverflow, false);
                assert.ok(receipt.smallWindow.selectorBottom <= receipt.smallWindow.height + 1, 'Selector must be reachable by scrolling at minimum size.');
                fs.writeFileSync(path.join(output,'login-small.png'),(await window.webContents.capturePage()).toPNG());
            }
            if (expectedError) {
                // Exercise the actual compact control and main IPC without launching a visible child.
                window.webContents.debugger.attach('1.3');
                const {root: dom} = await window.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
                function find(node, predicate) { if(predicate(node)) return node; for(const child of [...(node.children||[]),...(node.shadowRoots||[])]) {const result=find(child,predicate); if(result)return result;} }
                const selector = find(dom,node=>node.nodeName==='TCN-SERVER-SELECTOR');
                const select = find(selector,node=>node.nodeName==='SELECT');
                assert.ok(select);
                const {object} = await window.webContents.debugger.sendCommand('DOM.resolveNode',{nodeId:select.nodeId});
                const state = await window.webContents.debugger.sendCommand('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){return {value:this.value,context:this.getRootNode().querySelector(".context").textContent}}',returnByValue:true});
                receipt.compactRecovery = state.result.value;
                assert.equal(receipt.compactRecovery.value,'tcn');
                assert.match(receipt.compactRecovery.context,/Selected server: Prod/);
                await window.webContents.debugger.sendCommand('DOM.focus',{nodeId:select.nodeId});
                const bounds = await window.webContents.debugger.sendCommand('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}',returnByValue:true});
                for (const type of ['mousePressed','mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...bounds.result.value,button:'left',clickCount:1});
                for (const key of [{key:'Home',code:'Home',windowsVirtualKeyCode:36},{key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40},{key:'Enter',code:'Enter',windowsVirtualKeyCode:13}]) {
                    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'rawKeyDown',...key});
                    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...key});
                }
                for(let attempt=0;attempt<100&&!receipt.quitRequested;attempt++) await new Promise(resolve=>setTimeout(resolve,100));
                const after = await window.webContents.debugger.sendCommand('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){return {value:this.value,status:this.getRootNode().querySelector("[role=status]").textContent}}',returnByValue:true});
                receipt.compactRecovery.after = after.result.value;
                assert.equal(receipt.relaunchRequested,true,'Choosing Staging must request a restart');
                assert.equal(receipt.quitRequested,true);
                receipt.compactRecovery.savedOrigin=JSON.parse(fs.readFileSync(path.join(userData,'servers.json'),'utf8')).selectedOrigin;
                assert.equal(receipt.compactRecovery.savedOrigin,'https://chat.server60.the-cantina.net');
                receipt.compactRecovery.activeOrigin=new URL(window.webContents.getURL()).origin;
                assert.equal(receipt.compactRecovery.activeOrigin,origin,'Current native session remains on its original server until restart');
                window.webContents.debugger.detach();
            }
            receipt.passed = true; save(); clearTimeout(timeout);
            console.log('Full native entry/preload smoke passed.');
            quit();
        } catch (error) {
            receipt.errors.push(error.stack); save(); clearTimeout(timeout); app.exit(1);
        }
    };
    if (offline) window.webContents.once('did-fail-load', () => void run());
    else window.webContents.on('did-finish-load', () => void run());
});
import(pathToFileURL(path.join(root, 'dist/main/index.js')).href).catch(error => {
    receipt.errors.push(error.stack); save(); clearTimeout(timeout); app.exit(1);
});
