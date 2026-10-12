import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {ROOT,id,readJson,writeJson,sha256,Budget,utc,redact} from '../lib/common.mjs';
import {manifest,capture,checkScope} from '../lib/snapshot.mjs';
import {TaskRunner} from '../lib/runner.mjs';
import {nodeProbeExecutor} from '../lib/verifiers.mjs';
import {runProcess,cleanEnv} from '../lib/process.mjs';
import {Workspace} from '../lib/workspace.mjs';
async function setup(t,{executor=nodeProbeExecutor(),code='export function boundedScore(v){return Math.max(0,Math.min(100,Number(v)))}'}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'edumatch-runner-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const workspace=path.join(dir,'workspace');await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'score.mjs'),code);
  const registry=await readJson(path.join(ROOT,'fixtures/oracles/demo.json'));
  const task={schemaVersion:'1.0',taskId:id('task'),state:'FROZEN',kind:'code',goal:'fixture clamp',acceptance:[{id:'clamp',behavior:'clamp to [0,100]',source:'frozen synthetic oracle',verifierId:'clamp-boundary',requirement:'required',notApplicableReason:null}],repo:'fixture',baseRevision:null,initialSnapshotDigest:(await manifest(workspace)).digest,environment:'fixture',targetRef:'local-fixture',scope:{allowedPaths:['score.mjs'],services:['fixture'],forbiddenChanges:['oracle']},contracts:[],commandIds:[],verifierIds:['clamp-boundary'],authorizationRef:'test-fixture',allowedCapabilities:['read-code','edit-code','fixture-test'],unknowns:[],assumptions:[],budget:{maxSeconds:120,maxToolCalls:50,maxTokens:1000,maxCostUsd:0,maxRepairs:3}};
  const runner=new TaskRunner({stateDir:dir,key:randomBytes(32),registry,executor});const session=await runner.freeze(task,workspace);
  runner.transition(session,'BASELINE');runner.transition(session,'PLAN');runner.transition(session,'VERIFY');
  return {runner,session,workspace,task};
}
test('boundary oracle fails broken baseline and passes corrected candidate',async t=>{
  const s=await setup(t,{code:'export function boundedScore(v){return Math.min(100,Number(v))}'});
  const baseline=(await s.runner.verify(s.session,s.workspace)).result;assert.equal(baseline.status,'FAILED');assert.equal(baseline.checks[0].fail,1);
  s.runner.transition(s.session,'REPAIR',baseline.checks[0].artifactSha256);s.runner.transition(s.session,'EDIT');await fs.writeFile(path.join(s.workspace,'score.mjs'),'export function boundedScore(v){return Math.max(0,Math.min(100,Number(v)))}');s.runner.transition(s.session,'VERIFY');
  const candidate=(await s.runner.verify(s.session,s.workspace)).result;assert.equal(candidate.status,'SUCCEEDED_LOCAL');assert.equal(candidate.checks[0].ran,3);
});
test('candidate changes invalidate authoritative verdict',async t=>{
  const s=await setup(t);await s.runner.verify(s.session,s.workspace);await fs.appendFile(path.join(s.workspace,'score.mjs'),'\n// new input');
  await assert.rejects(s.runner.report(s.session,s.workspace),e=>e.code==='STALE_VERDICT');
});
test('forged success and changed frozen oracle are rejected',async t=>{
  const s=await setup(t);await s.runner.verify(s.session,s.workspace);
  const file=path.join(s.session.folder,'result.json');const receipt=await readJson(file);receipt.result.status='SUCCEEDED_STAGING';await writeJson(file,receipt);
  await assert.rejects(s.runner.report(s.session,s.workspace),e=>e.code==='UNTRUSTED_REPORT');
  const contract=path.join(s.session.folder,'contract.json');const saved=await readJson(contract);saved.frozen.registry.verifiers['clamp-boundary'].probes[0].expected=-5;await writeJson(contract,saved);
  await assert.rejects(s.runner.verify(s.session,s.workspace),e=>e.code==='ORACLE_CHANGED');
});
test('zero tests, skips, timeout and missing counts cannot satisfy acceptance',async t=>{
  for(const invalid of [{discovered:0,ran:0,pass:0,fail:0,skip:0},{discovered:1,ran:1,pass:1,fail:0,skip:1},{discovered:2,ran:1,pass:1,fail:0,skip:0}]) {
    const s=await setup(t,{executor:async()=>({...invalid,exitCode:0,signal:null,timedOut:false,truncated:false,runtime:'fixture',startedAt:utc(),finishedAt:utc()})});assert.equal((await s.runner.verify(s.session,s.workspace)).result.status,'FAILED');
  }
});
test('scope excludes unrelated source and workload cannot mutate candidate snapshot',async t=>{
  const s=await setup(t);await fs.writeFile(path.join(s.workspace,'outside.txt'),'unexpected');await assert.rejects(s.runner.verify(s.session,s.workspace),e=>e.code==='SCOPE_VIOLATION');
  assert.throws(()=>checkScope(['../policy'],s.task.scope));
});
test('draft and blocking business unknown reject freeze',async t=>{
  const s=await setup(t);const draft={...s.task,taskId:id('task'),state:'DRAFT'};await assert.rejects(s.runner.freeze(draft,s.workspace),e=>e.code==='NEEDS_DECISION');
  const unknown={...s.task,taskId:id('task'),unknowns:[{description:'missing rule',impact:'business behavior',verification:'user decision',blocking:true}]};await assert.rejects(s.runner.freeze(unknown,s.workspace),e=>e.code==='NEEDS_DECISION');
});
test('workspace path traversal, stale edit and forbidden policy are denied',async t=>{
  const s=await setup(t);const w=new Workspace(s.workspace,s.task);await assert.rejects(w.read('../policy'));
  const read=await w.read('score.mjs');await assert.rejects(w.write('score.mjs','changed','0'.repeat(64)),e=>e.code==='SNAPSHOT_CHANGED');
  await w.write('score.mjs',read.content+'\n',read.sha256);await assert.rejects(w.read('oracle'));assert.throws(()=>checkScope(['score.mjs'],{allowedPaths:['score.mjs'],forbiddenChanges:['score.mjs']}));
});
test('snapshot includes untracked source and rejects links escaping workspace',async t=>{
  const s=await setup(t);const initial=await manifest(s.workspace);await fs.writeFile(path.join(s.workspace,'new.mjs'),'untracked');assert.notEqual(initial.digest,(await manifest(s.workspace)).digest);
  if(process.platform!=='win32'){await fs.symlink(os.tmpdir(),path.join(s.workspace,'escape'));await assert.rejects(manifest(s.workspace),e=>e.code==='POLICY_DENIED');}
});
test('process times out, output cap is bounded and inherited API key is absent',async()=>{
  const timeout=await runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100});assert.equal(timeout.timedOut,true);
  const cap=await runProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(100000))"],{maxBytes:100});assert.equal(cap.truncated,true);assert.equal(cap.output.length,100);
  process.env.DEEPSEEK_API_KEY='fake-canary';const env=await runProcess(process.execPath,['-e',"process.stdout.write(String(process.env.DEEPSEEK_API_KEY))"]);delete process.env.DEEPSEEK_API_KEY;assert.equal(env.output,'undefined');
});
test('budget and repeated repairs are runtime gates',async t=>{
  const b=new Budget({maxSeconds:10,maxToolCalls:1,maxTokens:1,maxCostUsd:0});b.use();assert.throws(()=>b.use(),e=>e.code==='BUDGET_EXCEEDED');
  const s=await setup(t);s.runner.transition(s.session,'REPAIR','same');s.runner.transition(s.session,'EDIT');s.runner.transition(s.session,'VERIFY');assert.throws(()=>s.runner.transition(s.session,'REPAIR','same'),e=>e.code==='NO_NEW_EVIDENCE');
});

test('checkpoint resume rejects changed workspace, registry and forged checkpoint',async t=> {
  const s=await setup(t);await s.runner.checkpoint(s.session,s.workspace);
  assert.equal((await s.runner.resume(s.task.taskId,s.workspace)).state,'VERIFY');
  const original=await fs.readFile(path.join(s.workspace,'score.mjs'));
  await fs.appendFile(path.join(s.workspace,'score.mjs'),'// drift');await assert.rejects(s.runner.resume(s.task.taskId,s.workspace),e=>e.code==='SNAPSHOT_CHANGED');await fs.writeFile(path.join(s.workspace,'score.mjs'),original);
  const file=path.join(s.session.folder,'checkpoint.json'),checkpoint=await readJson(file);checkpoint.record.budget.calls=0;checkpoint.record.state='EDIT';await writeJson(file,checkpoint);await assert.rejects(s.runner.resume(s.task.taskId,s.workspace),e=>e.code==='UNTRUSTED_REPORT');
});

test('canonical hashes retain real database timestamp values across artifact round trip',async()=> {
  const value={created_at:new Date('2026-09-16T00:00:00Z')};assert.equal(sha256(value),sha256(JSON.parse(JSON.stringify(value))));assert.notEqual(sha256(value),sha256({created_at:{}}));
  assert.equal(redact(value).value.created_at,'2026-09-16T00:00:00.000Z');
});

test('process redaction covers truncated canaries and keeps source pagination JSON private',async()=> {
  const secret='fake-high-entropy-secret-zz';
  const clipped=await runProcess(process.execPath,['-e',`process.stdout.write('prefix-'+${JSON.stringify(secret)})`],{maxBytes:14,canaries:[secret]});assert.equal(clipped.truncated,true);assert.ok(!clipped.output.includes('fake-'));assert.ok(clipped.output.includes('[REDACTED]'));
  assert.equal(redact('-----BEGIN PRIVATE KEY-----\ntruncated-private-material').value,'[REDACTED]');
  const source={nextToken:'opaque-source-pagination',events:[{message:JSON.stringify({value:'Bearer fake-key'})}]};
  const captured=await runProcess(process.execPath,['-e',`process.stdout.write(${JSON.stringify(JSON.stringify(source))})`],{captureJson:true});assert.deepEqual(captured.parsedJson,source);assert.ok(!captured.output.includes('fake-key'));
});
