// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateLineage, verifyUpstreamRelease, inspectLineage, sourceState, validateReceipt, argumentsFor, validateSourceArchive, sha256} from './lineage.mjs';

const commit = 'a'.repeat(40), tag = 'fluxer-desktop-stable@2026.925.203705';
const upstream = {repository: 'fluxerapp/fluxer', commit, releaseTag: tag};
const manifest = {schema: 'tcn-desktop-lineage/v1', upstream, patchIds: ['D01','D02','D03','D04','D05','D06']};
function responses(pin = upstream, transform = x => x) {
    return async endpoint => {
        if (endpoint.includes('/releases/tags/')) return transform({id: 1, tag_name: pin.releaseTag, draft: false, prerelease: pin.releaseTag.includes('canary'), html_url: 'https://github.com/fluxerapp/fluxer/releases/tag/' + pin.releaseTag});
        return transform({ref: 'refs/tags/' + pin.releaseTag, object: {type: 'commit', sha: pin.commit}});
    };
}
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcn-lineage-test-'));
    const run = (...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
    run('init', '-q');fs.mkdirSync(path.join(root,'tcn'));
    fs.writeFileSync(path.join(root,'base.txt'),'base');
    run('add','base.txt');run('-c','user.name=TCN test','-c','user.email=test@example.invalid','commit','-qm','upstream');
    const base = run('rev-parse','HEAD');
    const pin = {...upstream,commit:base};
    fs.writeFileSync(path.join(root,'tcn/release-lineage.json'),JSON.stringify({...manifest,upstream:pin}));
    run('add','.');run('-c','user.name=TCN test','-c','user.email=test@example.invalid','commit','-qm','TCN patch');
    return {root,run,pin,cleanup() {
        const actual=fs.realpathSync(root),temp=fs.realpathSync(os.tmpdir());
        assert.equal(path.dirname(actual),temp);
        assert.ok(path.basename(actual).startsWith('tcn-lineage-test-'));
        fs.rmSync(actual,{recursive:true,force:true});
    }};
}
test('rejects unofficial source, API tag and missing patch coverage', () => {
    for (const bad of [{...manifest,upstream:{...upstream,repository:'other/repo'}},{...manifest,upstream:{...upstream,releaseTag:'fluxer-api@2026.925.203705'}},{...manifest,patchIds:['D06']}]) assert.throws(()=>validateLineage(bad));
});
test('null tag is valid evaluation metadata but cannot verify a release', async()=> {
    assert.doesNotThrow(()=>validateLineage({...manifest,upstream:{...upstream,releaseTag:null}}));
    await assert.rejects(verifyUpstreamRelease({...upstream,releaseTag:null},responses()),/no verified/);
});
test('verifies exact official release and tag commit', async()=> {
    assert.equal((await verifyUpstreamRelease(upstream,responses())).commit,commit);
});
test('rejects moved tag, draft, channel mismatch and foreign release URL', async()=>{
    for(const transform of [x=>x.object?{...x,object:{type:'commit',sha:'b'.repeat(40)}}:x,x=>x.object?x:{...x,draft:true},x=>x.object?x:{...x,prerelease:true},x=>x.object?x:{...x,html_url:'https://example.invalid/release'}]) await assert.rejects(verifyUpstreamRelease(upstream,responses(upstream,transform)));
});
test('resolves annotated tags and rejects cycles', async()=>{
    const tagSha='b'.repeat(40);
    const read=async endpoint => endpoint.includes('/git/tags/')?{sha:tagSha,object:{type:'commit',sha:commit}}:endpoint.includes('/git/ref/')?{ref:'refs/tags/'+tag,object:{type:'tag',sha:tagSha}}:responses()(endpoint);
    assert.equal((await verifyUpstreamRelease(upstream,read)).commit,commit);
    await assert.rejects(verifyUpstreamRelease(upstream,async endpoint => endpoint.includes('/git/tags/')?{sha:tagSha,object:{type:'tag',sha:tagSha}}:read(endpoint)),/tag chain/);
});
test('source receipt separates upstream, patched commit and evaluation readiness',async()=>{
    const f=fixture();
    try{
        const receipt=await inspectLineage({repository:f.root,version:'0.2.0',channel:'stable'});
        assert.equal(receipt.upstream.commit,f.pin.commit);assert.notEqual(receipt.sourceRevision,f.pin.commit);
        assert.equal(receipt.releaseReady,false);assert.equal(receipt.dirty,false);
        assert.throws(()=>validateReceipt(receipt,{requireRelease:true}),/accepted source/);
    }finally{f.cleanup();}
});
test('clean source can pass live-shaped release evidence; dirty source cannot',async()=>{
    const f=fixture();
    try{
        const args={repository:f.root,version:'0.2.0',channel:'stable',requireRelease:true,readGithub:responses(f.pin)};
        const receipt=await inspectLineage(args);assert.equal(receipt.releaseReady,true);
        assert.doesNotThrow(()=>validateReceipt(receipt,{version:'0.2.0',channel:'stable',sourceRevision:f.run('rev-parse','HEAD'),requireRelease:true}));
        fs.writeFileSync(path.join(f.root,'base.txt'),'changed');
        await assert.rejects(inspectLineage(args),/clean/);
    }finally{f.cleanup();}
});
test('working and untracked source changes alter fingerprints',()=>{
    const f=fixture();
    try{
        const initial=sourceState(f.root,f.pin.commit);
        fs.writeFileSync(path.join(f.root,'base.txt'),'changed');const tracked=sourceState(f.root,f.pin.commit);
        assert.notEqual(initial.sourceFingerprint,tracked.sourceFingerprint);
        fs.writeFileSync(path.join(f.root,'new.txt'),'new');const extra=sourceState(f.root,f.pin.commit);
        assert.notEqual(extra.sourceFingerprint,tracked.sourceFingerprint);assert.equal(extra.untracked[0].path,'new.txt');
    }finally{f.cleanup();}
});
test('cross-channel, mismatched source and prerelease Stable receipts fail',async()=>{
    const f=fixture();
    try{
        const receipt=await inspectLineage({repository:f.root,version:'0.2.0',channel:'stable'});
        assert.throws(()=>validateReceipt(receipt,{channel:'canary'}));
        assert.throws(()=>validateReceipt(receipt,{sourceRevision:commit}));
        await assert.rejects(inspectLineage({repository:f.root,version:'0.2.0-canary.1',channel:'stable',requireRelease:true}),/stable version/);
    }finally{f.cleanup();}
});
test('requires explicit arguments and rejects duplicate/unknown options',()=>{
    for(const args of [[],['--repository','x','--repository','y'],['--other','x']])assert.throws(()=>argumentsFor(args,['repository']));
    assert.deepEqual(argumentsFor(['--repository','x','--require-release'],['repository'],['require-release']),{repository:'x','require-release':true});
});

test('publication source archive is bound to the candidate and actual Git commit',async()=>{
    const f=fixture();
    try {
        const receipt=await inspectLineage({repository:f.root,version:'0.2.0',channel:'stable',requireRelease:true,readGithub:responses(f.pin)});
        const bytes=execFileSync('git',['-C',f.root,'archive','--format=zip','HEAD'],{windowsHide:true});
        receipt.sourceArchive={name:'tcn-chat-client-0.2.0-source.zip',size:bytes.length,sha256:sha256(bytes)};
        assert.doesNotThrow(()=>validateSourceArchive(receipt,bytes));
        const modified=Buffer.from(bytes);modified[0]^=1;
        assert.throws(()=>validateSourceArchive(receipt,modified),/digest/);
        const different=execFileSync('git',['-C',f.root,'archive','--format=zip',f.pin.commit],{windowsHide:true});
        const wrong={...receipt,sourceArchive:{...receipt.sourceArchive,size:different.length,sha256:sha256(different)}};
        assert.throws(()=>validateSourceArchive(wrong,different),/different commit/);
    } finally {f.cleanup();}
});

test('official GitHub percent-encoded desktop tag URLs resolve to the same identity',async()=>{
    const read=responses(upstream,x=>x.html_url?{...x,html_url:x.html_url.replace('@','%40')}:x);
    assert.equal((await verifyUpstreamRelease(upstream,read)).commit,commit);
});
