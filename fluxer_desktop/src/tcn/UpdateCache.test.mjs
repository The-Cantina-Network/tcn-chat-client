// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const source = esbuild.buildSync({
    entryPoints: [fileURLToPath(new URL('./UpdateCache.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20',
}).outputFiles[0].text;
const module = {exports: {}};
vm.runInNewContext(source, {require, module, exports: module.exports, Buffer, console}, {filename: 'UpdateCache.ts'});
const {writeVerifiedUpdate, validatePendingUpdate, quarantinePendingUpdate, VERIFIED_UPDATE_RECEIPT} = module.exports;
const policy = {packageId: 'tcn_chat_desktop_canary', channel: 'canary', currentVersion: '0.1.0-dev.9'};

function fixture(t) {
    const base = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(base, 'tcn-update-cache-'));
    t.after(() => {
        const resolved = fs.realpathSync(root);
        assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
        assert.match(path.basename(resolved), /^tcn-update-cache-/);
        fs.rmSync(resolved, {recursive: true});
    });
    function packageFile(version = '0.1.0-dev.12', bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 19)) {
        const asset = {PackageId: policy.packageId, Version: version, Type: 'Full',
            FileName: `tcn-${version}-full.nupkg`, SHA256: createHash('sha256').update(bytes).digest('hex'),
            SHA1: '', Size: bytes.length, NotesMarkdown: 'not part of the receipt'};
        fs.writeFileSync(path.join(root, asset.FileName), bytes);
        return asset;
    }
    return {root, packageFile, receipt: path.join(root, VERIFIED_UPDATE_RECEIPT)};
}
function localPending(asset) { return {...asset, SHA1: '', SHA256: ''}; }

test('hashes cache bytes, atomically persists minimal receipt and accepts SDK pending metadata without digests', t => {
    const f = fixture(t), asset = f.packageFile();
    const receipt = writeVerifiedUpdate(f.root, {TargetFullRelease: asset, IsDowngrade: false}, policy);
    assert.equal(receipt.asset.SHA256, asset.SHA256);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f.receipt)).asset).sort(),
        ['FileName', 'PackageId', 'SHA256', 'Size', 'Type', 'Version']);
    assert.equal(validatePendingUpdate(f.root, localPending(asset), policy).asset.Version, asset.Version);
    assert.equal(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp')).length, 0);
});

test('detects same-size tampering after download and never advances receipt for invalid replacement', t => {
    const f = fixture(t), original = f.packageFile();
    writeVerifiedUpdate(f.root, original, policy);
    const receiptBefore = fs.readFileSync(f.receipt, 'utf8');
    fs.writeFileSync(path.join(f.root, original.FileName), Buffer.alloc(original.Size, 20));
    assert.throws(() => validatePendingUpdate(f.root, localPending(original), policy), /checksum/);
    const next = f.packageFile('0.1.0-dev.13', Buffer.from('valid'));
    fs.writeFileSync(path.join(f.root, next.FileName), 'wrong');
    assert.throws(() => writeVerifiedUpdate(f.root, next, policy), /checksum/);
    assert.equal(fs.readFileSync(f.receipt, 'utf8'), receiptBefore);
});

test('rejects truncated cache bytes before writing a receipt', t => {
    const f = fixture(t), asset = f.packageFile();
    fs.truncateSync(path.join(f.root, asset.FileName), asset.Size - 1);
    assert.throws(() => writeVerifiedUpdate(f.root, asset, policy), /size/);
    assert.equal(fs.existsSync(f.receipt), false);
});

test('requires receipt and quarantines only the exact unverified package without deleting other files', t => {
    const f = fixture(t), asset = f.packageFile();
    const older = f.packageFile('0.1.0-dev.8', Buffer.from('retained older package'));
    const before = fs.readFileSync(path.join(f.root, asset.FileName));
    assert.throws(() => validatePendingUpdate(f.root, localPending(asset), policy));
    const moved = quarantinePendingUpdate(f.root, localPending(asset), policy.packageId);
    assert.equal(path.dirname(moved), f.root);
    assert.match(path.basename(moved), /\.invalid$/);
    assert.equal(fs.existsSync(path.join(f.root, asset.FileName)), false);
    assert.deepEqual(fs.readFileSync(moved), before);
    assert.equal(fs.existsSync(path.join(f.root, older.FileName)), true);
    assert.equal(quarantinePendingUpdate(f.root, localPending(asset), policy.packageId), null);
});

test('rejects traversal, foreign package identity and non-package filenames without moving bytes', t => {
    const f = fixture(t), asset = f.packageFile();
    for (const patch of [{PackageId: 'fluxer_desktop'}, {Type: 'Delta'},
        {FileName: '../outside.nupkg'}, {FileName: '..\\outside.nupkg'},
        {FileName: 'C:\\outside.nupkg'}, {FileName: '/outside.nupkg'},
        {FileName: 'payload.nupkg:alternate'}, {FileName: '.nupkg'}]) {
        assert.throws(() => quarantinePendingUpdate(f.root, {...asset, ...patch}, policy.packageId));
    }
    assert.deepEqual(fs.readdirSync(f.root), [asset.FileName]);
    assert.throws(() => writeVerifiedUpdate(f.root, {...asset, PackageId: 'fluxer_desktop'}, policy));
    assert.equal(fs.existsSync(f.receipt), false);
});

test('requires exact receipt identity, version, filename, size and channel', t => {
    const f = fixture(t), asset = f.packageFile();
    const receipt = writeVerifiedUpdate(f.root, asset, policy);
    for (const patch of [{PackageId: 'fluxer_desktop'}, {Version: '0.1.0-dev.13'},
        {FileName: 'other-full.nupkg'}, {Size: asset.Size + 1}, {SHA256: ''}]) {
        fs.writeFileSync(f.receipt, JSON.stringify({...receipt, asset: {...receipt.asset, ...patch}}));
        assert.throws(() => validatePendingUpdate(f.root, localPending(asset), policy));
    }
    fs.writeFileSync(f.receipt, JSON.stringify({...receipt, channel: 'stable'}));
    assert.throws(() => validatePendingUpdate(f.root, localPending(asset), policy), /channel/);
});

test('rejects malformed or oversized receipts and versions that are no longer newer', t => {
    const f = fixture(t), asset = f.packageFile();
    writeVerifiedUpdate(f.root, asset, policy);
    assert.throws(() => validatePendingUpdate(f.root, localPending(asset), {...policy, currentVersion: asset.Version}));
    fs.writeFileSync(f.receipt, '{invalid');
    assert.throws(() => validatePendingUpdate(f.root, localPending(asset), policy));
    fs.writeFileSync(f.receipt, ' '.repeat(16385));
    assert.throws(() => validatePendingUpdate(f.root, localPending(asset), policy), /too large/);
});

test('atomic receipt failure removes its own temporary file and preserves package bytes', t => {
    const f = fixture(t), asset = f.packageFile();
    fs.mkdirSync(f.receipt);
    assert.throws(() => writeVerifiedUpdate(f.root, asset, policy));
    assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false);
    assert.equal(fs.statSync(path.join(f.root, asset.FileName)).size, asset.Size);
});

test('rejects redirected package directories', t => {
    const f = fixture(t);
    const actual = path.join(f.root, 'actual'), redirected = path.join(f.root, 'redirected');
    fs.mkdirSync(actual);
    try { fs.symlinkSync(actual, redirected, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('OS does not permit test links'); return; }
        throw error;
    }
    assert.throws(() => quarantinePendingUpdate(redirected,
        {PackageId: policy.packageId, Type: 'Full', FileName: 'safe.nupkg'}, policy.packageId), /real directory/);
});
