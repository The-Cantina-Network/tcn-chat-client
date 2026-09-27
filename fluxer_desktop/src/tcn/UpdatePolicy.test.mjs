// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compareReleaseVersions, parseVersion, validateReleaseConfig, validateReleaseAsset} from './UpdatePolicy.mjs';
test('SemVer compares numeric prereleases, stable releases and metadata correctly', () => {
    const sorted = ['0.1.0-dev.9','0.1.0-dev.12','0.1.0-rc.1','0.1.0','0.2.0','1.0.0'];
    for (let i=1;i<sorted.length;i++) assert.equal(compareReleaseVersions(sorted[i-1], sorted[i]), -1);
    assert.equal(compareReleaseVersions('1.0.0+abc','1.0.0+def'),0);
    for (const version of ['1','1.0.0-dev.01','01.0.0','1.0.0/evil']) assert.throws(() => parseVersion(version));
});
test('release configuration requires matching channel and dedicated HTTPS URLs', () => {
    const config = {schema:'tcn-desktop-release/v1',channel:'canary',feedUrl:'https://downloads.example.org/canary',downloadPageUrl:'https://downloads.example.org'};
    assert.equal(validateReleaseConfig(config,'canary').feedUrl, config.feedUrl);
    assert.throws(() => validateReleaseConfig(config,'stable'));
    for (const feedUrl of ['http://example.org','https://user:pass@example.org','https://pkgs.fluxer.com','https://fluxer.app','https://localhost','https://127.0.0.1','https://example.org/?token=x']) {
        assert.throws(() => validateReleaseConfig({...config,feedUrl},'canary'));
    }
});
test('release assets enforce identity, monotonic version, checksum and stable channel', () => {
    const asset = {PackageId:'tcn_chat_desktop',Version:'1.0.1',Type:'Full',FileName:'tcn-1.0.1-full.nupkg',SHA256:'a'.repeat(64),Size:123};
    assert.equal(validateReleaseAsset(asset,'tcn_chat_desktop','1.0.0','stable'),asset);
    for (const patch of [{PackageId:'fluxer'},{Version:'1.0.0'},{Version:'0.9.9'},{Version:'1.0.1-dev.1'},{Size:0},{Type:'Delta'},{SHA256:''},{FileName:'https://evil.example/evil.nupkg'}]) {
        assert.throws(() => validateReleaseAsset({...asset,...patch},'tcn_chat_desktop','1.0.0','stable'));
    }
});
