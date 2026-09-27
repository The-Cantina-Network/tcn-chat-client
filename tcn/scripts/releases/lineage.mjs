// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseVersion} from '../../../fluxer_desktop/src/tcn/UpdatePolicy.mjs';

export const UPSTREAM = 'fluxerapp/fluxer';
export const UPSTREAM_URL = 'https://github.com/fluxerapp/fluxer.git';
const REVISION = /^[a-f0-9]{40}$/;
const RELEASE_TAG = /^fluxer-desktop-(stable|canary)@[0-9]+(?:\.[0-9]+){2}$/;
const PATCH_IDS = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06'];
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export function git(repository, ...args) {
    return execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
}
export function validateLineage(value) {
    assert.equal(value?.schema, 'tcn-desktop-lineage/v1', 'Unsupported lineage schema');
    assert.equal(value.upstream?.repository, UPSTREAM, 'Unexpected upstream repository');
    assert.match(value.upstream.commit, REVISION, 'An exact upstream commit is required');
    if (value.upstream.releaseTag !== null) assert.match(value.upstream.releaseTag, RELEASE_TAG, 'A desktop release tag is required');
    assert.deepEqual(value.patchIds, PATCH_IDS, 'Every maintained patch must be reviewed');
    return value;
}
export async function githubJson(endpoint) {
    assert.match(endpoint, /^\/repos\/fluxerapp\/fluxer\/(?:releases\/tags\/|git\/ref\/tags\/|git\/tags\/)/);
    const response = await fetch('https://api.github.com' + endpoint, {
        headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
        redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200, 'Upstream verification failed: HTTP ' + response.status);
    const text = await response.text();
    assert.ok(text.length < 1024 * 1024, 'Unexpected upstream response size');
    return JSON.parse(text);
}
export async function verifyUpstreamRelease(upstream, read = githubJson) {
    validateLineage({schema: 'tcn-desktop-lineage/v1', upstream, patchIds: PATCH_IDS});
    assert.ok(upstream.releaseTag, 'The source pin has no verified desktop release tag');
    const encoded = encodeURIComponent(upstream.releaseTag);
    const release = await read('/repos/' + UPSTREAM + '/releases/tags/' + encoded);
    assert.equal(release.tag_name, upstream.releaseTag, 'Release tag mismatch');
    assert.equal(release.draft, false, 'Draft upstream releases cannot be adopted');
    assert.equal(release.prerelease, upstream.releaseTag.startsWith('fluxer-desktop-canary@'), 'Upstream release channel mismatch');
    assert.equal(decodeURIComponent(release.html_url), 'https://github.com/' + UPSTREAM + '/releases/tag/' + upstream.releaseTag, 'Unexpected upstream release URL');
    const ref = await read('/repos/' + UPSTREAM + '/git/ref/tags/' + encoded);
    assert.equal(ref.ref, 'refs/tags/' + upstream.releaseTag, 'Upstream ref mismatch');
    let object = ref.object;
    const seen = new Set();
    for (let depth = 0; object?.type === 'tag'; depth++) {
        assert.ok(depth < 5 && REVISION.test(object.sha) && !seen.has(object.sha), 'Invalid annotated tag chain');
        seen.add(object.sha);
        const tag = await read('/repos/' + UPSTREAM + '/git/tags/' + object.sha);
        assert.equal(tag.sha, object.sha, 'Annotated tag identity mismatch');
        object = tag.object;
    }
    assert.equal(object?.type, 'commit', 'Tag does not resolve to a commit');
    assert.equal(object.sha, upstream.commit, 'Upstream tag moved or commit is incorrect');
    return {repository: UPSTREAM, tag: upstream.releaseTag, commit: object.sha, releaseId: release.id, url: release.html_url};
}
export function sourceState(repository, upstreamCommit) {
    assert.match(upstreamCommit, REVISION);
    const sourceRevision = git(repository, 'rev-parse', 'HEAD');
    assert.match(sourceRevision, REVISION);
    assert.equal(git(repository, 'rev-parse', upstreamCommit + '^{commit}'), upstreamCommit);
    git(repository, 'merge-base', '--is-ancestor', upstreamCommit, sourceRevision);
    const status = git(repository, 'status', '--porcelain=v1', '-uall');
    const untracked = git(repository, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort();
    const files = untracked.map(name => {
        const file = path.resolve(repository, name);
        assert.ok(file.startsWith(path.resolve(repository) + path.sep), 'Untracked path escapes repository');
        assert.ok(!fs.lstatSync(file).isSymbolicLink(), 'Untracked symlinks require review');
        const data = fs.readFileSync(file);
        return {path: name, size: data.length, sha256: sha256(data)};
    });
    const workingPatch = git(repository, 'diff', '--binary', 'HEAD', '--');
    const committedPatch = git(repository, 'diff', '--binary', upstreamCommit, 'HEAD', '--');
    const state = {
        sourceRevision, sourceTree: git(repository, 'rev-parse', 'HEAD^{tree}'),
        dirty: status.length > 0, workingPatchSha256: sha256(workingPatch),
        untracked: files,
    };
    return {...state, sourceFingerprint: sha256(JSON.stringify(state)),
        patchSetSha256: sha256(JSON.stringify({committed: sha256(committedPatch), working: state.workingPatchSha256, untracked: files}))};
}
export async function inspectLineage({repository, version, channel, requireRelease = false, readGithub}) {
    parseVersion(version);
    assert.ok(['stable', 'canary'].includes(channel), 'Unknown TCN channel');
    if (requireRelease && channel === 'stable') assert.equal(parseVersion(version).pre.length, 0, 'Stable publication requires a stable version');
    const manifestFile = path.join(repository, 'tcn/release-lineage.json');
    const bytes = fs.readFileSync(manifestFile);
    const lineage = validateLineage(JSON.parse(bytes));
    const state = sourceState(repository, lineage.upstream.commit);
    let verified = null;
    if (requireRelease) {
        assert.equal(state.dirty, false, 'Release source must be clean and completely committed');
        verified = await verifyUpstreamRelease(lineage.upstream, readGithub);
        if (channel === 'stable') assert.ok(lineage.upstream.releaseTag.startsWith('fluxer-desktop-stable@'), 'Stable TCN requires a reviewed stable Fluxer release');
    }
    return {
        schema: 'tcn-desktop-source/v1', version, channel, ...state,
        upstream: lineage.upstream, upstreamVerification: verified,
        lineageManifestSha256: sha256(bytes), patchIds: lineage.patchIds,
        releaseReady: requireRelease && !state.dirty && verified !== null,
        recordedAt: new Date().toISOString(),
    };
}
export function validateReceipt(receipt, {version, channel, sourceRevision, requireRelease = false} = {}) {
    assert.equal(receipt?.schema, 'tcn-desktop-source/v1', 'Missing source provenance');
    const parsedVersion = parseVersion(receipt.version);
    assert.ok(['stable', 'canary'].includes(receipt.channel), 'Unknown provenance channel');
    assert.match(receipt.sourceRevision, REVISION);
    for (const name of ['sourceFingerprint', 'patchSetSha256', 'lineageManifestSha256']) assert.match(receipt[name], /^[a-f0-9]{64}$/);
    validateLineage({schema: 'tcn-desktop-lineage/v1', upstream: receipt.upstream, patchIds: receipt.patchIds});
    if (version !== undefined) assert.equal(receipt.version, version, 'Provenance version mismatch');
    if (channel !== undefined) assert.equal(receipt.channel, channel, 'Provenance channel mismatch');
    if (sourceRevision !== undefined) assert.equal(receipt.sourceRevision, sourceRevision, 'Provenance source revision mismatch');
    if (requireRelease) {
        assert.equal(receipt.releaseReady, true, 'Public releases require accepted source provenance');
        if (receipt.channel === 'stable') assert.equal(parsedVersion.pre.length, 0, 'Stable publication requires a stable version');
        assert.equal(receipt.dirty, false, 'Dirty evaluation source cannot publish');
        assert.equal(receipt.upstreamVerification?.commit, receipt.upstream.commit);
        assert.equal(receipt.upstreamVerification?.tag, receipt.upstream.releaseTag);
        assert.equal(receipt.upstreamVerification?.repository, UPSTREAM);
        assert.match(receipt.upstream.releaseTag, RELEASE_TAG);
        if (receipt.channel === 'stable') assert.ok(receipt.upstream.releaseTag.startsWith('fluxer-desktop-stable@'));
    }
    return receipt;
}
export function validateSourceArchive(receipt, bytes) {
    validateReceipt(receipt, {requireRelease: true});
    assert.equal(receipt.sourceArchive?.name, 'tcn-chat-client-' + receipt.version + '-source.zip', 'Source archive name mismatch');
    assert.equal(receipt.sourceArchive.size, bytes.length, 'Source archive size mismatch');
    assert.equal(receipt.sourceArchive.sha256, sha256(bytes), 'Source archive digest mismatch');
    // Git ZIP archives carry the immutable source commit in their EOCD comment.
    const end = bytes.length - 62;
    assert.ok(end >= 0 && bytes.readUInt32LE(end) === 0x06054b50, 'Missing Git source archive identity');
    assert.equal(bytes.readUInt16LE(end + 20), 40, 'Missing source commit comment');
    assert.equal(bytes.subarray(end + 22).toString('ascii'), receipt.sourceRevision, 'Source archive belongs to a different commit');
}
export function writeFresh(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
}
export function argumentsFor(argv, required, switches = []) {
    const result = {};
    for (let index = 0; index < argv.length; index++) {
        const name = argv[index];
        assert.ok(name.startsWith('--') && !Object.hasOwn(result, name.slice(2)), 'Unknown or repeated argument');
        const key = name.slice(2);
        if (switches.includes(key)) result[key] = true;
        else {
            assert.ok(required.includes(key) && argv[index + 1] && !argv[index + 1].startsWith('--'), 'Unknown argument or missing value: ' + name);
            result[key] = argv[++index];
        }
    }
    for (const name of required) assert.ok(result[name], 'Missing --' + name);
    return result;
}
async function cli() {
    const [command, ...argv] = process.argv.slice(2);
    if (command === 'inspect') {
        const a = argumentsFor(argv, ['repository', 'version', 'channel', 'output'], ['require-release']);
        assert.ok(!fs.existsSync(a.output), 'Output already exists');
        const receipt = await inspectLineage({...a, requireRelease: !!a['require-release']});
        writeFresh(a.output, receipt);
        console.log(JSON.stringify({sourceRevision: receipt.sourceRevision, upstreamCommit: receipt.upstream.commit, dirty: receipt.dirty, releaseReady: receipt.releaseReady}));
    } else if (command === 'check-receipt') {
        const a = argumentsFor(argv, ['receipt', 'version', 'channel', 'source-revision'], ['require-release', 'verify-upstream']);
        const receipt = validateReceipt(JSON.parse(fs.readFileSync(a.receipt)), {...a, sourceRevision: a['source-revision'], requireRelease: !!a['require-release']});
        if (a['verify-upstream']) await verifyUpstreamRelease(receipt.upstream);
        console.log('Source provenance verified');
    } else if (command === 'check-publication') {
        const a = argumentsFor(argv, ['candidate', 'source-revision', 'source-archive']);
        const candidate = JSON.parse(fs.readFileSync(a.candidate));
        const receipt = validateReceipt(candidate.sourceProvenance, {
            version: candidate.version, channel: candidate.channel,
            sourceRevision: a['source-revision'], requireRelease: true,
        });
        validateSourceArchive(receipt, fs.readFileSync(a['source-archive']));
        await verifyUpstreamRelease(receipt.upstream);
        console.log('Candidate and corresponding source verified');
    } else if (command === 'check-unchanged') {
        const a = argumentsFor(argv, ['repository', 'receipt']);
        const before = JSON.parse(fs.readFileSync(a.receipt));
        validateReceipt(before);
        const current = sourceState(a.repository, before.upstream.commit);
        assert.equal(current.sourceFingerprint, before.sourceFingerprint, 'Source changed during the build');
        assert.equal(sha256(fs.readFileSync(path.join(a.repository, 'tcn/release-lineage.json'))), before.lineageManifestSha256);
        console.log('Build source unchanged');
    } else throw Error('Expected inspect, check-receipt, check-publication or check-unchanged');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli().catch(error => {console.error(error.message); process.exitCode = 1;});
