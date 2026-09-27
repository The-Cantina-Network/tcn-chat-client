// SPDX-License-Identifier: AGPL-3.0-or-later
// Run with ELECTRON_RUN_AS_NODE=1 using the candidate's Electron runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = path.resolve(process.env.TCN_SMOKE_PACKAGE || path.join(__dirname, '..'));
const runtimeRequire = createRequire(path.join(root, 'package.json'));
const names = ['webauthn', 'hardware-encoder', 'win-process-loopback', 'win-clipboard', 'win-shell', 'win-toast', 'windows-input-hook', 'win-game-capture', 'platform-info'];
const results = [];
for (const name of names) {
    const id = '@fluxer/' + name;
    const mod = runtimeRequire(id);
    assert.ok(!mod.loadError, `${id}: ${mod.loadError?.message}`);
    results.push({module: id, loaded: true, exports: Object.keys(mod)});
}
const receipt = {electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, nativeModules: results};
if (process.env.TCN_SMOKE_OUTPUT) {fs.mkdirSync(process.env.TCN_SMOKE_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.TCN_SMOKE_OUTPUT,'native-modules.json'),JSON.stringify(receipt,null,2));}
console.log(`Loaded all ${results.length} native modules in Electron ${process.versions.electron}.`);
