// SPDX-License-Identifier: AGPL-3.0-or-later
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const {validateReceipt} = require('../../tcn/scripts/releases/lineage.mjs');
const builderRequire = createRequire(require.resolve('electron-builder'));
const asarRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = asarRequire('@electron/asar');
assert.ok(process.argv[2] && process.argv[3], 'Usage: node scripts/tcn-inspect-package.cjs PACKAGE_DIR RECEIPT.json');
const dir = path.resolve(process.argv[2]);
const archive = path.join(dir, 'resources/app.asar');
const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
const metadata = JSON.parse(asar.extractFile(archive, 'package.json'));
const expectedVersion = process.env.TCN_EXPECT_VERSION || JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version;
const expectedChannel = process.env.TCN_EXPECT_CHANNEL || 'stable';
assert.ok(['stable', 'canary'].includes(expectedChannel), 'Invalid expected channel');
assert.equal(metadata.version, expectedVersion);
assert.equal(metadata.main, 'dist/main/index.js');
assert.equal(metadata.name, expectedChannel === 'canary' ? 'tcn_chat_desktop_canary' : 'tcn_chat_desktop');
for (const name of ['dist/main/index.js', 'dist/main/MainApp.js', 'dist/preload/index.cjs', 'LICENSE', 'TCN-UPSTREAM.md']) {
    assert.ok(asar.statFile(archive, path.normalize(name)).size > 0, name);
}
const forbidden = entries.filter(name => /(^|[\\/])(\.git|\.env|target|tests?|scripts|tcn|backup|profiles?|fixtures|benches|settings\.json|servers\.json)([\\/]|$)/i.test(name));
assert.deepEqual(forbidden, []);
const files = [];
function walk(directory) {
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) walk(file);
        else files.push({path: path.relative(dir, file).split(path.sep).join('/'), size: fs.statSync(file).size,
            sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
    }
}
walk(dir);
const releaseConfig = entries.includes('/dist/release.json') ? JSON.parse(asar.extractFile(archive, 'dist/release.json')) : null;
if (releaseConfig) assert.equal(releaseConfig.channel, expectedChannel);
const sourceProvenance = entries.includes('/dist/source.json') ? JSON.parse(asar.extractFile(archive, 'dist/source.json')) : null;
if (sourceProvenance) validateReceipt(sourceProvenance, {version: expectedVersion, channel: expectedChannel});
if (process.env.TCN_SOURCE_RECEIPT_PATH) assert.deepEqual(sourceProvenance, JSON.parse(fs.readFileSync(process.env.TCN_SOURCE_RECEIPT_PATH, 'utf8')), 'Embedded provenance must match the build input');
const receipt = {releaseConfig, sourceProvenance, channel: expectedChannel, metadata: {name: metadata.name, version: metadata.version, main: metadata.main},
    archiveEntries: entries.length, forbiddenEntries: forbidden, nativePayload: files.filter(file => file.path.endsWith('.node')),
    files, totalBytes: files.reduce((sum, file) => sum + file.size, 0)};
assert.equal(receipt.nativePayload.filter(file => file.path.includes('/@fluxer/')).length, 9);
assert.equal(receipt.nativePayload.length, 10, 'Nine Fluxer modules plus the upstream Velopack runtime');
fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({entries: entries.length, files: files.length, totalBytes: receipt.totalBytes, nativeAddons: receipt.nativePayload.length, version: metadata.version}));
