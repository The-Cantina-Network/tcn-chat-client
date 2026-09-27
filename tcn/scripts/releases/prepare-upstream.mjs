// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {UPSTREAM, UPSTREAM_URL, argumentsFor, git, sha256, sourceState, validateLineage, verifyUpstreamRelease, writeFresh} from './lineage.mjs';

export function freshOutput(repository, output) {
    const root = fs.realpathSync(repository), destination = path.resolve(output);
    const relative = path.relative(root, destination);
    assert.ok(relative && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)), 'Preparation output must be outside the source checkout');
    assert.ok(!fs.existsSync(destination), 'Preparation output already exists');
    let parent = path.dirname(destination);
    while (!fs.existsSync(parent)) {
        const next = path.dirname(parent);
        assert.notEqual(next, parent, 'No existing output parent');
        parent = next;
    }
    assert.equal(fs.realpathSync(parent).toLowerCase(), parent.toLowerCase(), 'Output parent must not traverse a link');
    return destination;
}
export async function prepareUpstream({repository, tag, commit, output, apply = false, readGithub}) {
    const target = {repository: UPSTREAM, releaseTag: tag, commit};
    const current = validateLineage(JSON.parse(fs.readFileSync(path.join(repository, 'tcn/release-lineage.json'))));
    const state = sourceState(repository, current.upstream.commit);
    assert.equal(state.dirty, false, 'Commit/review the current patch set before preparing an upgrade');
    assert.notEqual(commit, current.upstream.commit, 'Select a different explicitly reviewed upstream release');
    const destination = freshOutput(repository, output);
    const release = await verifyUpstreamRelease(target, readGithub);
    const patch = git(repository, 'diff', '--binary', current.upstream.commit, state.sourceRevision, '--') + '\n';
    assert.ok(patch.trim(), 'No committed TCN patch set to reapply');
    // Only public source metadata and the reviewed committed diff are emitted.
    fs.mkdirSync(destination, {recursive: true});
    const patchPath = path.join(destination, 'tcn.patch');
    fs.writeFileSync(patchPath, patch, {flag: 'wx'});
    const report = {schema:'tcn-desktop-upgrade-plan/v1', status:'review-required', sourceRevision:state.sourceRevision,
        sourceFingerprint:state.sourceFingerprint, from:current.upstream, target, release,
        patchSha256:sha256(patch), applied:false,
        review:['Review upstream changes affecting D01–D06, native bridge and release tooling.',
            'Resolve every conflict and update human-readable upstream/patch memory.',
            'Run clean source, native build and exact staging/installed acceptance before release.']};
    writeFresh(path.join(destination, 'plan.json'), report);
    if (!apply) return report;
    const worktree = path.join(destination, 'worktree');
    const ref = 'refs/tcn/upstream/' + commit;
    let phase = 'fetch-verified-release';
    try {
        // Fixed official remote and explicit ref; never fetch a guessed/latest branch.
        git(repository, 'fetch', '--no-tags', '--no-write-fetch-head', UPSTREAM_URL, 'refs/tags/' + tag + ':' + ref);
        assert.equal(git(repository, 'rev-parse', ref + '^{commit}'), commit, 'Fetched upstream ref changed');
        assert.equal(sourceState(repository, current.upstream.commit).sourceFingerprint, state.sourceFingerprint, 'Active source changed during preparation');
        phase = 'create-isolated-worktree';
        git(repository, 'worktree', 'add', '--detach', worktree, commit);
        // A sparse checkout must include TCN files and the inherited workflow controls.
        if (fs.existsSync(path.join(worktree, '.git'))) {
            const sparse = git(worktree, 'config', '--get', '--default', 'false', 'core.sparseCheckout');
            if (sparse === 'true') git(worktree, 'sparse-checkout', 'add', 'tcn', '.github');
        }
        phase = 'reapply-maintained-patch';
        git(worktree, 'apply', '--3way', '--index', patchPath);
        phase = 'record-new-upstream-pin';
        const next = {...current, upstream:target, status:'prepared-unaccepted'};
        delete next.note;
        fs.writeFileSync(path.join(worktree, 'tcn/release-lineage.json'), JSON.stringify(next,null,2) + '\n');
        report.status = 'prepared-unaccepted'; report.applied = true; report.worktree = worktree;
        report.note = 'Detached isolated worktree; inspect, test and commit only after review. No branch or feed was advanced.';
        writeFresh(path.join(destination, 'prepared.json'), report);
        return report;
    } catch (error) {
        writeFresh(path.join(destination, 'incomplete.json'), {status:'incomplete', phase, worktree,
            sourceRevision:state.sourceRevision, target, message:'Preparation failed. Preserve the worktree and inspect Git status/conflicts; no automatic cleanup or publication.'});
        throw error;
    }
}
async function cli() {
    const a = argumentsFor(process.argv.slice(2), ['repository','tag','commit','output'], ['apply']);
    const report = await prepareUpstream(a);
    console.log(JSON.stringify({status:report.status, sourceRevision:report.sourceRevision,target:report.target,applied:report.applied}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli().catch(error=>{console.error(error.message);process.exitCode=1;});
