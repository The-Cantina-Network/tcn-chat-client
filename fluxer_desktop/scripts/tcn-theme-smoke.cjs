// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline hidden Chromium regression: pinned upstream CSS + real theme import/IndexedDB domain.
// Run with pinned Electron; set TCN_THEME_SMOKE_OUTPUT to a fresh output directory.
const {app, BrowserWindow, protocol, session} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const repo = path.resolve(__dirname, '../..');
const upstream = 'c9754ac11a75295c367c100a1a3f3787b723d809';
const output = path.resolve(process.env.TCN_THEME_SMOKE_OUTPUT || '');
assert.ok(process.env.TCN_THEME_SMOKE_OUTPUT, 'An explicit fresh output directory is required.');
assert.ok(!fs.existsSync(output), 'Refusing to overwrite existing regression output.');
fs.mkdirSync(output, {recursive: true});
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tcn-theme-regression-'));
app.setPath('appData', temporaryRoot);
app.setPath('userData', path.join(temporaryRoot, 'user-data'));
app.on('window-all-closed', () => {}); // Save final evidence after hidden-window teardown.
protocol.registerSchemesAsPrivileged([{scheme: 'tcn-theme-test', privileges: {standard: true, secure: true, supportFetchAPI: true}}]);
const sourceHashes = {};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function readGit(file) {
    const source = execFileSync('git', ['show', upstream + ':' + file], {cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true});
    sourceHashes[file] = sha256(source);
    return source;
}
const brandingPath = 'fluxer_desktop/src/tcn/branding.css';
const themePath = 'tcn/themes/TCN.theme.css';
const brandingCss = fs.readFileSync(path.join(repo, brandingPath), 'utf8');
const customCss = fs.readFileSync(path.join(repo, themePath), 'utf8');
sourceHashes[brandingPath] = sha256(brandingCss);
sourceHashes[themePath] = sha256(customCss);
const globalsCss = readGit('fluxer_app/src/app/globals.css');
const generator = readGit('fluxer_app/scripts/GenerateColorSystem.ts');
let colourCss;
const generatorScript = esbuild.transformSync(generator.replaceAll('import.meta.dirname', JSON.stringify(path.join(repo, 'fluxer_app/scripts'))), {loader: 'ts', format: 'cjs'}).code;
vm.runInNewContext(generatorScript, {
    require: name => {
        if (name === 'node:path') return path;
        if (name === 'node:fs') return {mkdirSync() {}, writeFileSync(file, value) {
            assert.ok(file.endsWith('color-system.css'));
            colourCss = value;
        }};
        throw new Error('Unexpected generator import: ' + name);
    },
    console: {log() {}, warn(message) {throw new Error(message);}},
});
assert.ok(colourCss && colourCss.includes('.theme-dark_legacy') && colourCss.includes('.theme-coal'));
const neutralTokens = [
    '--background-primary', '--background-secondary', '--background-secondary-alt', '--background-secondary-lighter',
    '--background-tertiary', '--background-header-primary', '--background-header-primary-hover',
    '--background-header-secondary', '--background-channel-header', '--background-textarea', '--form-surface-background',
    '--text-primary', '--text-chat', '--text-secondary', '--text-primary-muted', '--text-chat-muted',
    '--text-tertiary', '--text-tertiary-muted', '--text-tertiary-secondary', '--border-color', '--border-color-hover',
    '--background-modifier-hover', '--background-modifier-accent', '--surface-interactive-hover-bg',
    '--control-button-normal-text', '--control-button-hover-bg', '--control-button-hover-text',
];
const highlights = {
    '--brand-primary': '#175251', '--brand-secondary': '#1c6563', '--brand-primary-light': '#59c8c4',
    '--brand-primary-fill': '#d9fffc', '--text-on-brand-primary': '#d9fffc', '--text-link': '#59c8c4',
    '--focus-primary': '#59c8c4', '--border-color-focus': '#59c8c4', '--background-modifier-selected': '#2a2316',
    '--background-modifier-accent-focus': '#59c8c4', '--surface-interactive-selected-bg': '#2a2316',
    '--surface-interactive-selected-color': '#d5aa58', '--control-button-active-bg': '#2a2316',
    '--control-button-active-text': '#d5aa58', '--text-selection': 'rgb(89 200 196 / 30%)',
};
const allTokens = [...neutralTokens, ...Object.keys(highlights)];
const receipt = {
    schema: 'tcn-theme-regression/v1', upstreamRevision: upstream, electron: process.versions.electron,
    chromium: process.versions.chrome, sourceHashes, generatedColourCssSha256: sha256(colourCss),
    profileIsTemporary: true, hidden: true, networkRequests: [], checks: [], samples: {},
    limitations: [
        'Offline Chromium fixture, not an authenticated hosted application or packaged main/preload acceptance.',
        'Real upstream CSS generator, ThemeLibrary, ThemeLibraryDb, ProtectedWebStorage and ThemeCssUtils are used.',
        'MobX observability, logger, translation and native UI access are inert test shims; React import UI is not exercised.',
        'Custom CSS application is explicit in the fixture; this does not test the React useCustomThemeStyle hook.',
    ],
};
let window;
let testSession;
let failure;
const timeout = setTimeout(() => {receipt.error = 'Timed out'; save(); app.exit(1);}, 60000);
function save() {fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));}
function check(name, operation) {operation(); receipt.checks.push(name);}
async function buildLibraryBundle() {
    const shims = {
        'mobx': 'export const makeAutoObservable = value => value; export const runInAction = operation => operation();',
        '@lingui/core': 'export const i18n = {_:(value)=>typeof value==="string"?value:value.message};',
        '@lingui/core/macro': 'export const msg = value => value;',
        '@app/features/platform/utils/AppLogger': 'export class Logger {debug(){} warn(){} error(){}}',
        '@app/features/ui/utils/NativeUtils': 'export const getElectronAPI = () => undefined;',
    };
    const result = await esbuild.build({
        stdin: {contents: 'import library from "@app/features/theme/state/ThemeLibrary"; window.themeLibraryFixture = library;', resolveDir: repo, loader: 'ts'},
        bundle: true, write: false, platform: 'browser', format: 'iife', define: {'import.meta.env.PROD': 'false'},
        plugins: [{
            name: 'pinned-upstream-theme-domain',
            setup(build) {
                build.onResolve({filter: /.*/}, args => {
                    if (shims[args.path]) return {path: args.path, namespace: 'shim'};
                    if (args.path.startsWith('@app/')) return {path: 'fluxer_app/src/' + args.path.slice(5) + '.ts', namespace: 'git'};
                    throw new Error('Unexpected theme-domain dependency: ' + args.path);
                });
                build.onLoad({filter: /.*/, namespace: 'shim'}, args => ({contents: shims[args.path], loader: 'js'}));
                build.onLoad({filter: /.*/, namespace: 'git'}, args => ({contents: readGit(args.path), loader: 'ts'}));
            },
        }],
    });
    return result.outputFiles[0].text;
}
const fixtureMarkup = '<!doctype html><html><head><meta charset="utf-8"><title>TCN theme regression</title></head><body>' +
    '<main><p class="eyebrow">OFFLINE THEME REGRESSION · NO ACCOUNT</p><h1 id="phase"></h1><div class="layout">' +
    '<nav><h2>The Cantina Network</h2><p class="item">General</p><p class="item selected">Selected channel</p><p class="item hovered">Hovered channel</p><a href="#fixture">Example link</a></nav>' +
    '<article><h2>Standard surfaces and text</h2><p>Body text keeps the selected upstream theme. Branded highlights remain teal and gold.</p><p class="muted">Secondary text and borders retain their normal contrast.</p><div class="message">This card uses the secondary background.</div><button>Branded button</button><button class="focus">Focus highlight</button><textarea aria-label="Message" placeholder="Message field"></textarea></article></div></main></body></html>';
const layoutCss = ':root{--font-sans:Arial,sans-serif;--font-mono:monospace}body{margin:0;padding:32px;font:16px/1.5 Arial,sans-serif;background:var(--background-primary);color:var(--text-primary)}main{max-width:940px;margin:auto}.eyebrow{font-size:11px;letter-spacing:2px;color:var(--text-secondary)}h1{font-size:26px;margin:8px 0 24px}h2{font-size:17px;margin:0 0 16px}.layout{display:grid;grid-template-columns:260px 1fr;gap:20px}nav,article{padding:22px;border:1px solid var(--border-color);border-radius:12px}nav{background:var(--background-secondary)}article{background:var(--background-primary)}p{margin:10px 0}.item{padding:10px;border-radius:6px}.selected{background:var(--surface-interactive-selected-bg);color:var(--surface-interactive-selected-color)}.hovered{background:var(--surface-interactive-hover-bg)}a{color:var(--text-link)}.muted{color:var(--text-secondary)}.message{padding:16px;margin:20px 0;background:var(--background-secondary);border:1px solid var(--border-color);border-radius:8px}button{margin:0 12px 20px 0;padding:10px 14px;border:0;border-radius:6px;background:var(--brand-primary);color:var(--text-on-brand-primary)}button.focus{outline:2px solid var(--focus-primary);outline-offset:3px}textarea{width:100%;height:64px;box-sizing:border-box;padding:12px;background:var(--background-textarea);color:var(--text-primary);border:1px solid var(--border-color);border-radius:6px}';
async function evaluate(fn, argument) {
    return window.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(argument) + ')');
}
async function sample(theme, branded, custom, label) {
    return evaluate(({theme, branded, custom, label, tokens}) => {
        document.documentElement.className = 'theme-' + theme;
        document.getElementById('branding').textContent = branded;
        document.getElementById('custom').textContent = custom;
        document.getElementById('phase').textContent = label;
        const probe = document.createElement('span');
        document.body.append(probe);
        const properties = {};
        for (const token of tokens) {
            probe.style.color = 'var(' + token + ')';
            properties[token] = {raw: getComputedStyle(document.documentElement).getPropertyValue(token).trim(), resolved: getComputedStyle(probe).color};
        }
        probe.remove();
        return properties;
    }, {theme, branded, custom, label, tokens: allTokens});
}
async function capture(name) {
    await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const filename = name + '.png';
    fs.writeFileSync(path.join(output, filename), (await window.webContents.capturePage()).toPNG());
}
app.whenReady().then(async () => {
    assert.equal(process.versions.electron, JSON.parse(fs.readFileSync(path.join(repo, 'fluxer_desktop/package.json'), 'utf8')).devDependencies.electron);
    const bundle = await buildLibraryBundle();
    testSession = session.fromPartition('tcn-theme-regression-' + crypto.randomUUID(), {cache: false});
    testSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    testSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (details, callback) => {
        receipt.networkRequests.push(details.url); callback({cancel: true});
    });
    testSession.protocol.handle('tcn-theme-test', () => new Response(fixtureMarkup, {headers: {'content-type': 'text/html; charset=utf-8'}}));
    window = new BrowserWindow({show: false, width: 1080, height: 780, autoHideMenuBar: true,
        webPreferences: {session: testSession, sandbox: true, contextIsolation: true, nodeIntegration: false}});
    window.on('show', () => {throw new Error('Test window must remain hidden');});
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.webContents.on('will-download', event => event.preventDefault());
    window.webContents.on('will-navigate', (event, url) => {if (!url.startsWith('tcn-theme-test://fixture/')) event.preventDefault();});
    await window.loadURL('tcn-theme-test://fixture/');
    await evaluate(({globals, colours, layout}) => {
        for (const [id, text] of [['globals',globals],['colours',colours],['layout',layout],['branding',''],['custom','']]) {
            const style = document.createElement('style'); style.id = id; style.textContent = text; document.head.append(style);
        }
    }, {globals: globalsCss, colours: colourCss, layout: layoutCss});
    const expectedHighlights = await evaluate(values => {
        const probe = document.createElement('span'); document.body.append(probe);
        const result = {};
        for (const [token, value] of Object.entries(values)) {probe.style.color = value; result[token] = getComputedStyle(probe).color;}
        probe.remove(); return result;
    }, highlights);
    for (const theme of ['dark', 'dark_legacy', 'coal', 'light']) {
        const baseline = await sample(theme, '', '', theme + ' · upstream baseline');
        const branded = await sample(theme, brandingCss, '', theme + ' · standard theme + TCN highlights');
        check(theme + ': neutral surfaces/text/borders/hover equal upstream', () => {
            for (const token of neutralTokens) {
                assert.ok(baseline[token].raw, 'Missing upstream token ' + token);
                assert.deepEqual(branded[token], baseline[token], theme + ' changed ' + token);
            }
        });
        check(theme + ': highlights or complete light preservation', () => {
            for (const token of Object.keys(highlights)) {
                if (theme === 'light') assert.deepEqual(branded[token], baseline[token], 'Light changed ' + token);
                else assert.equal(branded[token].resolved, expectedHighlights[token], theme + ' highlight mismatch ' + token);
            }
        });
        receipt.samples[theme] = {baseline, branded};
        await capture(theme + '-standard');
        const enabled = await sample(theme, brandingCss, customCss, theme + ' · optional TCN theme enabled');
        if (theme === 'dark') {
            check('dark: optional full TCN palette changes expected surface/text', () => {
                assert.equal(enabled['--background-primary'].resolved, 'rgb(11, 21, 28)');
                assert.equal(enabled['--text-primary'].resolved, 'rgb(237, 243, 244)');
                assert.notDeepEqual(enabled['--background-primary'], branded['--background-primary']);
            });
            await capture('dark-tcn-enabled');
        } else {
            check(theme + ': optional TCN CSS has no effect', () => assert.deepEqual(enabled, branded));
        }
        const disabled = await sample(theme, brandingCss, '', theme + ' · optional theme disabled');
        check(theme + ': disabling returns exactly to standard branded theme', () => assert.deepEqual(disabled, branded));
        receipt.samples[theme].enabled = enabled;
    }
    await window.webContents.executeJavaScript(bundle);
    receipt.library = await evaluate(async css => {
        const library = window.themeLibraryFixture;
        await library.init();
        const before = {count: library.themes.length, enabled: [...library.enabledThemeIds]};
        const imported = await library.importCssFiles([new File([css], 'TCN.theme.css', {type: 'text/css'})]);
        const item = imported[0];
        const afterImport = {count: imported.length, name: item.name, source: item.source, css: item.css === css,
            enabled: library.enabledThemeIds.includes(item.id), activeCss: library.activeThemeCss};
        await library.setThemeEnabled(item.id, true);
        await library.reload();
        const afterEnableReload = {enabled: library.enabledThemeIds.includes(item.id), activeCssMatches: library.activeThemeCss === css.trim()};
        await library.setThemeEnabled(item.id, false);
        await library.reload();
        const afterDisableReload = {enabled: library.enabledThemeIds.includes(item.id), activeCss: library.activeThemeCss, retained: library.themes.some(theme => theme.id === item.id)};
        return {before, afterImport, afterEnableReload, afterDisableReload};
    }, customCss);
    check('upstream import uses native FileReader + IndexedDB and remains disabled', () => {
        assert.equal(receipt.library.before.count, 0);
        assert.equal(receipt.library.afterImport.count, 1);
        assert.equal(receipt.library.afterImport.name, 'TCN');
        assert.equal(receipt.library.afterImport.source, 'css_file');
        assert.equal(receipt.library.afterImport.css, true);
        assert.equal(receipt.library.afterImport.enabled, false);
        assert.equal(receipt.library.afterImport.activeCss, '');
    });
    check('upstream library enable/disable survives IndexedDB reload', () => {
        assert.deepEqual(receipt.library.afterEnableReload, {enabled: true, activeCssMatches: true});
        assert.deepEqual(receipt.library.afterDisableReload, {enabled: false, activeCss: '', retained: true});
    });

    const registrationBundle = await esbuild.build({
        stdin: {contents: 'import * as bundled from "./src/tcn/BundledTheme"; window.bundledThemeFixture = bundled;', resolveDir: path.join(repo, 'fluxer_desktop'), loader: 'ts'},
        bundle: true, write: false, platform: 'browser', format: 'iife', loader: {'.css':'text'},
    });
    sourceHashes['fluxer_desktop/src/tcn/BundledTheme.ts'] = sha256(fs.readFileSync(path.join(repo, 'fluxer_desktop/src/tcn/BundledTheme.ts')));
    await window.webContents.executeJavaScript(registrationBundle.outputFiles[0].text);
    receipt.bundled = await evaluate(async css => {
        const lib = window.themeLibraryFixture;
        const bundled = window.bundledThemeFixture;
        const id = bundled.TCN_THEME_ID;
        const summary = () => ({count: lib.themes.length, enabled: [...lib.enabledThemeIds], css: lib.themes.find(t => t.id === id)?.css});
        await lib.resetLibrary();
        const added = await bundled.registerTcnTheme(indexedDB);
        await lib.reload();
        const fresh = summary();
        await lib.setThemeEnabled(id, true);
        const repeat = await bundled.registerTcnTheme(indexedDB);
        await lib.reload();
        const repeated = summary();
        await lib.updateThemeDetails(id, {css: ':root {--test-edit: 1}', name: 'My TCN'});
        await bundled.registerTcnTheme(indexedDB);
        await lib.reload();
        const edited = {name: lib.themes[0].name, ...summary()};
        await lib.deleteTheme(id);
        await bundled.registerTcnTheme(indexedDB);
        await lib.reload();
        const deleted = summary();
        await lib.resetLibrary();
        const legacy = (await lib.importCssFiles([new File([css], 'TCN.theme.css')]))[0];
        await lib.setThemeEnabled(legacy.id, true);
        const adopted = await bundled.registerTcnTheme(indexedDB);
        await lib.reload();
        const adoption = {count: lib.themes.length, sameId: lib.themes[0].id === legacy.id, enabled: lib.enabledThemeIds.includes(legacy.id)};
        await lib.resetLibrary();
        const other = await lib.saveCssAsTheme(':root {--other-user-theme: 1}', 'Other theme');
        await lib.setThemeEnabled(other.id, true);
        const concurrent = await Promise.all([bundled.registerTcnTheme(indexedDB), bundled.registerTcnTheme(indexedDB)]);
        await lib.reload();
        const preservation = {count: lib.themes.length, enabled: [...lib.enabledThemeIds], otherId: other.id,
            otherCss: lib.themes.find(t => t.id === other.id)?.css};
        await lib.resetLibrary();
        const denied = [];
        for (const [selected, mainFrame] of [
            [{origin:location.origin, branding:false},true],
            [{origin:'https://unrelated.example',branding:true},true],
            [{origin:location.origin,branding:true},false],
        ]) denied.push(await bundled.installBundledTcnTheme(selected, mainFrame));
        await lib.reload();
        const deniedCount = lib.themes.length;
        const receiver = new BroadcastChannel('fluxer-theme-studio');
        const message = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('No theme refresh broadcast')), 3000);
            receiver.onmessage = async event => {
                clearTimeout(timeout);
                await lib.reload();
                resolve({type:event.data.type, count:lib.themes.length, enabled: [...lib.enabledThemeIds]});
            };
        });
        await bundled.installBundledTcnTheme({origin:location.origin,branding:true}, true);
        const refreshed = await message;
        receiver.close();
        return {id, added, fresh, repeat, repeated, edited, deleted, adopted, adoption, concurrent, preservation, denied, deniedCount, refreshed};
    }, customCss);
    check('bundled theme appears without import and starts disabled', () => {
        assert.equal(receipt.bundled.added, 'added');
        assert.deepEqual(receipt.bundled.fresh, {count:1, enabled:[], css:customCss});
    });
    check('repeat registration preserves enabled choice without duplication', () => {
        assert.equal(receipt.bundled.repeat, 'remembered');
        assert.deepEqual(receipt.bundled.repeated, {count:1, enabled:[receipt.bundled.id], css:customCss});
    });
    check('user edits and deletion survive repeat registration', () => {
        assert.equal(receipt.bundled.edited.name, 'My TCN');
        assert.equal(receipt.bundled.edited.css, ':root {--test-edit: 1}');
        assert.deepEqual(receipt.bundled.deleted, {count:0, enabled:[], css:undefined});
    });
    check('dev14 manual imports are adopted without duplicate or preference change', () => {
        assert.equal(receipt.bundled.adopted, 'existing');
        assert.deepEqual(receipt.bundled.adoption, {count:1, sameId:true, enabled:true});
    });
    check('concurrent registration adds exactly once and preserves unrelated enabled themes', () => {
        assert.deepEqual(receipt.bundled.concurrent.sort(), ['added','remembered']);
        assert.deepEqual(receipt.bundled.preservation, {count:2, enabled:[receipt.bundled.preservation.otherId],
            otherId:receipt.bundled.preservation.otherId, otherCss:':root {--other-user-theme: 1}'});
    });
    check('nonbranded servers, unrelated origins and subframes do not register a theme', () => {
        assert.deepEqual(receipt.bundled.denied, ['skipped','skipped','skipped']);
        assert.equal(receipt.bundled.deniedCount, 0);
    });
    check('existing theme broadcast refreshes an already-hydrated library', () => {
        assert.deepEqual(receipt.bundled.refreshed, {type:'themeLibrary',count:1,enabled:[]});
    });
    for (const schema of ['future','incompatible']) {
        const prior = window;
        window = new BrowserWindow({show:false, webPreferences:{session:testSession,sandbox:true,contextIsolation:true,nodeIntegration:false}});
        await window.loadURL('tcn-theme-test://' + schema + '/');
        await window.webContents.executeJavaScript(registrationBundle.outputFiles[0].text);
        const result = await evaluate(async schema => {
            const db = await new Promise((resolve,reject) => {
                const request = indexedDB.open('fluxer-theme-library', schema === 'future' ? 2 : 1);
                request.onupgradeneeded = () => request.result.createObjectStore('unrelated');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            db.close();
            const result = await window.bundledThemeFixture.registerTcnTheme(indexedDB);
            const readback = await new Promise(resolve => {const r=indexedDB.open('fluxer-theme-library');r.onsuccess=()=>resolve(r.result);});
            const state = {result,version:readback.version,stores:[...readback.objectStoreNames]};
            readback.close(); return state;
        }, schema);
        check(schema + ' library schema remains untouched', () => {
            assert.deepEqual(result, {result:'unsupported',version:schema === 'future' ? 2 : 1,stores:['unrelated']});
        });
        window.destroy(); window = prior;
    }

    check('no network requests or visible window', () => {
        assert.deepEqual(receipt.networkRequests, []);
        assert.equal(window.isVisible(), false);
    });
    receipt.passed = true;
}).catch(error => {failure = error; receipt.passed = false; receipt.error = error.stack || String(error);}).finally(async () => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    if (testSession) await testSession.clearStorageData().catch(() => {});
    receipt.completedUtc = new Date().toISOString();
    save();
    console.log(JSON.stringify({passed: receipt.passed, checks: receipt.checks.length, output, error: failure?.message}));
    app.exit(failure ? 1 : 0);
});
