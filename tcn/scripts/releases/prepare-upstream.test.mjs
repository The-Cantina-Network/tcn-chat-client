// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareUpstream, freshOutput} from './prepare-upstream.mjs';
function fixture() {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tcn-prepare-test-')),repo=path.join(root,'source');
    fs.mkdirSync(repo);const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
    git('init','-q');git('config','core.autocrlf','false');fs.writeFileSync(path.join(repo,'base'),'base');git('add','.');
    git('-c','user.name=TCN test','-c','user.email=test@example.invalid','commit','-qm','base');
    const base=git('rev-parse','HEAD');fs.mkdirSync(path.join(repo,'tcn'));
    fs.writeFileSync(path.join(repo,'tcn/release-lineage.json'),JSON.stringify({schema:'tcn-desktop-lineage/v1',upstream:{repository:'fluxerapp/fluxer',commit:base,releaseTag:null},patchIds:['D01','D02','D03','D04','D05','D06']}));
    git('add','.');git('-c','user.name=TCN test','-c','user.email=test@example.invalid','commit','-qm','patch');
    return {root,repo,git,cleanup(){const actual=fs.realpathSync(root);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(actual).startsWith('tcn-prepare-test-'));fs.rmSync(actual,{recursive:true,force:true});}};
}
const tag='fluxer-desktop-stable@2026.925.203705',commit='a'.repeat(40);
const readGithub=async endpoint=>endpoint.includes('/releases/tags/')?{id:1,tag_name:tag,draft:false,prerelease:false,html_url:'https://github.com/fluxerapp/fluxer/releases/tag/'+tag}:{ref:'refs/tags/'+tag,object:{type:'commit',sha:commit}};
test('default preparation exports reviewed patch/report without changing source or Git refs',async()=>{
    const f=fixture();
    try{
        const before=f.git('show-ref'),head=f.git('rev-parse','HEAD');
        const output=path.join(f.root,'review');
        const report=await prepareUpstream({repository:f.repo,tag,commit,output,readGithub});
        assert.equal(report.applied,false);assert.equal(report.status,'review-required');
        assert.equal(f.git('show-ref'),before);assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('status','--porcelain'),'');
        assert.ok(fs.existsSync(path.join(output,'tcn.patch')));
        assert.ok(!fs.existsSync(path.join(output,'worktree')));
    }finally{f.cleanup();}
});
test('dirty source and mismatched official release are rejected before output creation',async()=>{
    const f=fixture();
    try{
        const output=path.join(f.root,'review');
        await assert.rejects(prepareUpstream({repository:f.repo,tag,commit,output,readGithub:async endpoint=>{const v=await readGithub(endpoint);return v.object?{...v,object:{type:'commit',sha:'b'.repeat(40)}}:v;}}),/tag moved/);
        assert.ok(!fs.existsSync(output));
        fs.writeFileSync(path.join(f.repo,'dirty'),'x');
        await assert.rejects(prepareUpstream({repository:f.repo,tag,commit,output,readGithub}),/Commit/);
        assert.ok(!fs.existsSync(output));
    }finally{f.cleanup();}
});
test('existing output and output inside the active source are rejected',()=>{
    const f=fixture();
    try{assert.throws(()=>freshOutput(f.repo,f.repo));assert.throws(()=>freshOutput(f.repo,path.join(f.repo,'inside')));assert.throws(()=>freshOutput(f.repo,f.root));}finally{f.cleanup();}
});

function releaseFor(revision) {
    return async endpoint => {
        const value = await readGithub(endpoint);
        return value.object ? {...value, object:{type:'commit',sha:revision}} : value;
    };
}
function localRelease(f, conflict = false) {
    if (conflict) {
        fs.writeFileSync(path.join(f.repo,'base'),'TCN edit\n');
        f.git('add','base');f.git('-c','user.name=TCN test','-c','user.email=test@example.invalid','commit','-qm','TCN change');
    }
    const active=f.git('rev-parse','HEAD');
    const base=JSON.parse(fs.readFileSync(path.join(f.repo,'tcn/release-lineage.json'))).upstream.commit;
    f.git('checkout','--detach',base);
    fs.writeFileSync(path.join(f.repo,conflict?'base':'new-upstream-file'),'new upstream\n');
    f.git('add','.');f.git('-c','user.name=TCN test','-c','user.email=test@example.invalid','commit','-qm','upstream release');
    const target=f.git('rev-parse','HEAD');f.git('tag',tag);f.git('checkout','--detach',active);
    // A fixture-local Git transport rewrite keeps the real apply path offline.
    const localUrl=new URL('file://' + (process.platform==='win32'?'/':'') + f.repo.replaceAll('\\','/') + '/').href;
    f.git('config','url.'+localUrl+'.insteadOf','https://github.com/fluxerapp/fluxer.git');
    return {active,target};
}
test('explicit apply prepares an isolated real Git worktree without advancing the active checkout',async()=>{
    const f=fixture();
    try {
        const {active,target}=localRelease(f);
        const output=path.join(f.root,'applied');
        const report=await prepareUpstream({repository:f.repo,tag,commit:target,output,apply:true,readGithub:releaseFor(target)});
        assert.equal(report.status,'prepared-unaccepted');assert.equal(report.applied,true);
        assert.equal(f.git('rev-parse','HEAD'),active);assert.equal(f.git('status','--porcelain'),'');
        const next=JSON.parse(fs.readFileSync(path.join(report.worktree,'tcn/release-lineage.json')));
        assert.equal(next.upstream.commit,target);assert.equal(next.upstream.releaseTag,tag);
        assert.equal(fs.readFileSync(path.join(report.worktree,'new-upstream-file'),'utf8'),'new upstream\n');
        assert.ok(fs.existsSync(path.join(output,'prepared.json')));
    } finally {f.cleanup();}
});
test('conflicting patch records an incomplete handoff and retains the isolated worktree',async()=>{
    const f=fixture();
    try {
        const {active,target}=localRelease(f,true);
        const output=path.join(f.root,'conflict');
        await assert.rejects(prepareUpstream({repository:f.repo,tag,commit:target,output,apply:true,readGithub:releaseFor(target)}));
        assert.equal(f.git('rev-parse','HEAD'),active);assert.equal(f.git('status','--porcelain'),'');
        const failure=JSON.parse(fs.readFileSync(path.join(output,'incomplete.json')));
        assert.equal(failure.phase,'reapply-maintained-patch');
        assert.ok(fs.existsSync(path.join(failure.worktree,'.git')));
        assert.ok(!fs.existsSync(path.join(output,'prepared.json')));
    } finally {f.cleanup();}
});
