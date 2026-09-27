// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const sourcePath = fileURLToPath(new URL('./Bootstrap.ts', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');
const mainImport = "await import(new URL('./MainApp.js', import.meta.url).href);";
assert.equal(source.split(mainImport).length, 2, 'Only the final main-app import is intercepted');
const compiled = esbuild.transformSync(source.replace(mainImport, ''), {
    loader: 'ts', format: 'cjs', target: 'node20', platform: 'node',
    define: {'import.meta.url': JSON.stringify(new URL('./Bootstrap.ts', import.meta.url).href)},
}).code;
const PACKAGE_ID = 'tcn_chat_desktop';
const CONFIG = {feedUrl: 'https://downloads.example.org/stable'};
const PENDING = {PackageId: PACKAGE_ID, Type: 'Full', Version: '1.0.1',
    FileName: 'tcn-1.0.1-full.nupkg', Size: 20, SHA256: '', SHA1: ''};
const EXPECTED_ROOT = 'C:\\TCN-tests\\packages';
const HOOKS = ['onAfterInstallFastCallback', 'onAfterUpdateFastCallback', 'onFirstRun', 'onRestarted'];

function bootstrap(options = {}) {
    const events = [], hooks = new Map(), sources = [], checks = [], quarantines = [], warnings = [];
    let repairs = 0, runCount = 0, autoApply;
    const lifecycle = {
        setAutoApplyOnStartup(value) { autoApply = value; events.push('auto:' + value); return this; },
        run() { runCount++; events.push('run'); },
    };
    for (const hook of HOOKS) lifecycle[hook] = callback => { hooks.set(hook, callback); return lifecycle; };
    class UpdateManager {
        constructor(url, policy) {
            events.push('manager');
            if (options.managerError) throw new Error('Missing or unreadable installation');
            sources.push({url, policy});
        }
        getAppId() { return options.packageId ?? PACKAGE_ID; }
        isPortable() { return options.portable ?? false; }
        getCurrentVersion() { return '1.0.0'; }
        getUpdatePendingRestart() { return Object.hasOwn(options, 'pending') ? options.pending : PENDING; }
    }
    const modules = {
        '@electron/tcn/Build': {TCN_COMMUNITY_BUILD: options.tcnBuild ?? true},
        '@electron/tcn/Release': {TCN_RELEASE_CONFIG: Object.hasOwn(options, 'config') ? options.config : CONFIG},
        '@electron/common/BuildChannel': {BUILD_CHANNEL: 'stable'},
        '@electron/common/DesktopIdentity': {WINDOWS_VELOPACK_ID: PACKAGE_ID},
        '@electron/main/WindowsShortcuts': {repairWindowsShortcuts() { repairs++; }},
        '@electron/tcn/UpdateCache': {
            validatePendingUpdate(root, asset, policy) {
                events.push('verify'); checks.push({root, asset, policy});
                if (options.invalidCache) throw new Error('Pending cache does not match its receipt');
            },
            quarantinePendingUpdate(root, asset, packageId) {
                events.push('quarantine'); quarantines.push({root, asset, packageId});
                if (options.quarantineError) throw new Error('Quarantine unavailable');
                return root + '\\retained.invalid';
            },
        },
        'node:path': path.win32,
        velopack: {UpdateManager, VelopackApp: {build() { events.push('build'); return lifecycle; }}},
    };
    function mockedRequire(name) {
        if (name === 'node:module') return {createRequire: () => mockedRequire};
        if (Object.hasOwn(modules, name)) return modules[name];
        throw new Error('Unexpected Bootstrap dependency: ' + name);
    }
    const module = {exports: {}};
    vm.runInNewContext(compiled, {
        module, exports: module.exports, require: mockedRequire,
        process: {platform: options.platform ?? 'win32', execPath: options.execPath ?? 'C:\\TCN-tests\\current\\TCN Chat.exe'},
        console: {warn: (...args) => warnings.push(args)},
    }, {filename: sourcePath});
    return {events, hooks, sources, checks, quarantines, warnings, autoApply, runCount,
        get repairs() { return repairs; }};
}

function assertLifecycle(result, enabled) {
    assert.equal(result.autoApply, enabled);
    assert.equal(result.runCount, 1);
    assert.deepEqual([...result.hooks.keys()], HOOKS);
    assert.equal(result.repairs, 1);
    for (const callback of result.hooks.values()) callback();
    assert.equal(result.repairs, 5, 'Install/update/restart hooks still perform their shortcut repair');
}

test('unconfigured evaluation registers installation hooks but never probes or auto-applies updates', () => {
    const result = bootstrap({config: null});
    assertLifecycle(result, false);
    assert.equal(result.sources.length, 0);
    assert.equal(result.checks.length, 0);
    assert.equal(result.quarantines.length, 0);
});

test('unpacked executable cannot enable startup updates even with a compiled feed', () => {
    const result = bootstrap({execPath: 'C:\\TCN-tests\\win-unpacked\\TCN Chat.exe'});
    assertLifecycle(result, false);
    assert.equal(result.sources.length, 0);
});

for (const [description, options] of [
    ['foreign application ID', {packageId: 'fluxer_desktop'}],
    ['portable installation', {portable: true}],
    ['no pending package', {pending: null}],
]) {
    test('defers startup updates for ' + description, () => {
        const result = bootstrap(options);
        assertLifecycle(result, false);
        assert.equal(result.checks.length, 0);
        assert.equal(result.quarantines.length, 0);
    });
}

test('verifies pending cache before enabling SDK startup application with exact installation policy', () => {
    const result = bootstrap();
    assertLifecycle(result, true);
    assert.equal(result.sources[0].url, CONFIG.feedUrl);
    assert.equal(result.sources[0].policy.AllowVersionDowngrade, false);
    assert.equal(result.sources[0].policy.ExplicitChannel, 'win');
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].root, EXPECTED_ROOT);
    assert.equal(result.checks[0].asset, PENDING);
    assert.equal(result.checks[0].policy.packageId, PACKAGE_ID);
    assert.equal(result.checks[0].policy.currentVersion, '1.0.0');
    assert.equal(result.checks[0].policy.channel, 'stable');
    assert.ok(result.events.indexOf('verify') < result.events.indexOf('auto:true'));
    assert.ok(result.events.indexOf('auto:true') < result.events.indexOf('run'));
    assert.equal(result.quarantines.length, 0);
});

test('unverified or corrupted cache is quarantined and startup auto-apply stays disabled', () => {
    const result = bootstrap({invalidCache: true});
    assertLifecycle(result, false);
    assert.equal(result.quarantines.length, 1);
    assert.equal(result.quarantines[0].root, EXPECTED_ROOT);
    assert.equal(result.quarantines[0].asset, PENDING);
    assert.equal(result.quarantines[0].packageId, PACKAGE_ID);
    assert.ok(result.events.indexOf('quarantine') < result.events.indexOf('run'));
});

test('quarantine or installation detection failure defers updates without preventing normal startup lifecycle', () => {
    for (const options of [{invalidCache: true, quarantineError: true}, {managerError: true}]) {
        const result = bootstrap(options);
        assertLifecycle(result, false);
        assert.equal(result.warnings.length, 1);
    }
});

test('non-Windows startup does not load or invoke Windows lifecycle', () => {
    const result = bootstrap({platform: 'linux'});
    assert.equal(result.runCount, 0);
    assert.equal(result.repairs, 0);
    assert.equal(result.sources.length, 0);
});

test('non-TCN build preserves upstream auto-apply without invoking TCN cache policy', () => {
    const result = bootstrap({tcnBuild: false});
    assertLifecycle(result, true);
    assert.equal(result.sources.length, 0);
    assert.equal(result.checks.length, 0);
});
