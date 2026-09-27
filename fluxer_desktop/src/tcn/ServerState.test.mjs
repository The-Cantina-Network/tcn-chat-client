// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import * as servers from './Servers.mjs';
const require = createRequire(import.meta.url);
const {transformSync} = require('esbuild');
function load(file, mocks) {
    const module = {exports:{}};
    const code = transformSync(readFileSync(new URL(file,import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'node20'}).code;
    vm.runInNewContext(code,{module,exports:module.exports,require: id => mocks[id] ?? require(id)});
    return module.exports;
}
async function fixture(t, options = {}) {
    const directory = await mkdtemp(path.join(tmpdir(),'tcn-native-server-test-'));
    t.after(() => rm(directory,{recursive:true,force:true}));
    const handlers = new Map();
    const contents = {};
    const effects = [];
    let api;
    const window = {getMainWindow: () => ({webContents:contents}), isTrustedOrigin: url => new URL(url).origin === api.getSelectedServer().origin};
    const guard = load('../main/PrivilegedRendererDocuments.ts',{'@electron/main/Window':window});
    const mocks = {
        '@electron/common/DesktopConfig':{setRuntimeAppUrlOverride: url => effects.push(['url',url])},
        '@electron/main/PrivilegedRendererDocuments':guard,
        '@electron/main/Window':window,
        electron:{app:{relaunch: () => effects.push(['relaunch']),quit: () => effects.push(['quit'])},ipcMain:{handle: (name,handler) => handlers.set(name,handler)}},
        './Servers.mjs':{...servers,resolveServer:options.resolve ?? (async origin => servers.serverFromOrigin(origin)),...(options.save ? {saveServerPreferences:options.save}: {})},
    };
    api = load('./ServerState.ts',mocks);
    await api.initializeServerSelection(directory); api.registerServerSelection();
    const event = {sender:contents,senderFrame:{url:servers.PRESET_SERVERS[0].origin+'/login',parent:null,detached:false}};
    return {api,handlers,event,effects,directory};
}
test('startup retains production partition and changing server persists before restarting', async t => {
    const f = await fixture(t);
    assert.equal(f.api.getSelectedServer().partition,'persist:tcn-main');
    const result = await f.handlers.get('tcn-server-select')(f.event,servers.PRESET_SERVERS[1].origin);
    assert.equal(result.ok,true);
    assert.equal(JSON.parse(await readFile(path.join(f.directory,'servers.json'),'utf8')).selectedOrigin,servers.PRESET_SERVERS[1].origin);
    assert.deepEqual(f.effects.slice(-2),[['relaunch'],['quit']]);
    assert.equal(f.api.getSelectedServer().origin,servers.PRESET_SERVERS[0].origin,'running process trust never switches beneath native state');
    await f.api.initializeServerSelection(f.directory);
    assert.equal(f.api.getSelectedServer().partition,'persist:tcn-staging');
});
test('server IPC rejects foreign origins, child frames, detached frames and other windows', async t => {
    const f = await fixture(t);
    for (const event of [
        {...f.event,sender:{}},
        {...f.event,senderFrame:null},
        {...f.event,senderFrame:{...f.event.senderFrame,parent:{}}},
        {...f.event,senderFrame:{...f.event.senderFrame,detached:true}},
        {...f.event,senderFrame:{...f.event.senderFrame,url:servers.PRESET_SERVERS[2].origin}},
    ]) assert.throws(() => f.handlers.get('tcn-server-state')(event));
    assert.equal(f.handlers.get('tcn-server-state')(f.event).selected.partition,'persist:tcn-main');
    assert.equal(f.effects.length,1);
});
test('navigation during discovery and concurrent switches cannot persist or restart', async t => {
    let resolve;
    const f = await fixture(t,{resolve: () => new Promise(done => {resolve=done;})});
    const pending = f.handlers.get('tcn-server-select')(f.event,servers.PRESET_SERVERS[1].origin);
    assert.equal((await f.handlers.get('tcn-server-select')(f.event,servers.PRESET_SERVERS[2].origin)).ok,false);
    f.event.senderFrame.detached=true;
    resolve(servers.PRESET_SERVERS[1]);
    assert.equal((await pending).ok,false);
    assert.equal(f.effects.length,1);
    await assert.rejects(readFile(path.join(f.directory,'servers.json')),{code:'ENOENT'});
});
test('save failure and invalid custom addresses preserve the running session', async t => {
    const f = await fixture(t,{save:async () => {throw new Error('disk full');}});
    for (const origin of ['http://example.org','https://secret@example.org',servers.PRESET_SERVERS[1].origin]) {
        assert.equal((await f.handlers.get('tcn-server-select')(f.event,origin)).ok,false);
    }
    assert.equal(f.effects.length,1);
    assert.equal(f.api.getSelectedServer().partition,'persist:tcn-main');
});
