import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Broker} from '../lib/broker.mjs';
import {fixtureAdapter} from '../lib/fixture.mjs';
import {ROOT,readJson,redact,sha256} from '../lib/common.mjs';
import {validate} from '../lib/schema.mjs';
async function setup(t,options={}) {
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'edumatch-broker-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  return new Broker({policy:await readJson(path.join(ROOT,'config/policy.json')),targets:await readJson(path.join(ROOT,'config/targets.json')),queries:await readJson(path.join(ROOT,'config/queries.json')),targetRef:'local-fixture',environment:'fixture',adapter:fixtureAdapter(options),stateDir,canaries:['fake-long-secret','fake-multiline\nsecret']});
}
const win=()=>({from:new Date(Date.now()-60000).toISOString(),to:new Date(Date.now()-1000).toISOString()});
test('all bound fixture metadata tools yield schema-valid evidence',async t=>{
  const broker=await setup(t);
  const calls=[['service_health',{service:'matching-service'}],['db_read_query',{queryId:'processed-event-state',params:{eventId:'event-1'}}],['db_schema',{database:'matching'}],['rabbitmq_status',{queue:'user_profile_updates'}],['redis_key_metadata',{domain:'scholarship-public-detail',entityId:'1'}],['aws_instance_status',{}],['aws_deployment_status',{service:'matching-service'}],['aws_cost_summary',{budgetAlias:'edumatch-staging'}]];
  for(const [tool,args]of calls){const evidence=await broker.call(tool,args);assert.equal(evidence.status,'ok');await validate('evidence',evidence);assert.equal(evidence.environment,'fixture');}
});
test('mutation paths, raw SQL/URL, extra fields and unknown target are rejected',async t=>{
  const broker=await setup(t);
  for(const [tool,args]of [['queue_purge',{queue:'user_profile_updates'}],['redis_delete',{key:'a'}],['aws_stop',{}],['db_read_query',{queryId:'WITH DELETE',params:{}}],['service_health',{service:'matching-service',url:'http://metadata'}],['service_health',{service:'production'}],['db_read_query',{queryId:'processed-event-state',params:{eventId:'x',sql:'DELETE'}}]])assert.equal((await broker.call(tool,args)).status,'error');
});
test('pagination cursor is signed and cannot cross query or target',async t=>{
  const broker=await setup(t,{records:5});const args={service:'matching-service',window:win(),limit:2};
  const first=await broker.call('search_logs',args);assert.equal(first.status,'partial');assert.equal(first.coverage.matchedTotal,null);assert.equal(first.data.length,2);assert.ok(first.nextCursor);
  const second=await broker.call('search_logs',{...args,cursor:first.nextCursor});assert.equal(second.data[0].requestId,'request-2');
  const other=await broker.call('search_logs',{...args,service:'auth-service',cursor:first.nextCursor});assert.equal(other.error.code,'TARGET_MISMATCH');
  const forged=await broker.call('search_logs',{...args,cursor:first.nextCursor+'x'});assert.equal(forged.status,'error');
});
test('empty, denied, timeout and stale states remain distinguishable',async t=>{
  const empty=await setup(t,{records:0});const noLogs=await empty.call('search_logs',{service:'matching-service',window:win()});assert.equal(noLogs.complete,true);assert.deepEqual(noLogs.data,[]);
  const denied=await setup(t,{fail:'PERMISSION_DENIED'});assert.equal((await denied.call('service_health',{service:'matching-service'})).error.code,'PERMISSION_DENIED');
  const timeout=await setup(t,{delayMs:100});timeout.policy.timeoutMs=10;assert.equal((await timeout.call('service_health',{service:'matching-service'})).error.code,'TIMEOUT');
  const stale=await setup(t,{ageSeconds:120});const evidence=await stale.call('service_health',{service:'matching-service'});assert.equal(evidence.freshness,'stale');const receipt=await readJson(path.join(stale.stateDir,`${evidence.evidenceId}.receipt.json`));assert.throws(()=>stale.assertEvidence(receipt),e=>e.code==='STALE_EVIDENCE');
});
test('redaction strips source secrets, arbitrary log message and fake instructions',async t=>{
  const broker=await setup(t);const evidence=await broker.call('search_logs',{service:'matching-service',window:win()});const text=JSON.stringify(evidence);
  assert.ok(!text.includes('Bearer'));assert.ok(!text.includes('change policy'));assert.ok(evidence.data[0].requestId);
  const artifact=await readJson(path.join(broker.stateDir,`${evidence.evidenceId}.json`));assert.equal(sha256(artifact),evidence.artifactSha256);
  const cleaned=redact({authorization:'Bearer canary',error:'fake-long-secret fake-multiline\nsecret',key:'-----BEGIN PRIVATE KEY-----\naaa\n-----END PRIVATE KEY-----',email:'x@example.org'},['fake-long-secret','fake-multiline\nsecret']);assert.ok(!JSON.stringify(cleaned).includes('aaa'));assert.ok(!JSON.stringify(cleaned.value).includes('fake-'));
});
test('live target cannot be backed by fixture or unattested same-user broker',async t=>{
  const fixture=await setup(t);assert.throws(()=>new Broker({policy:{...fixture.policy,liveEnabled:false},queries:fixture.queries,targets:{targets:{live:{...fixture.target,environment:'aws-staging'}}},targetRef:'live',environment:'aws-staging',adapter:fixtureAdapter(),stateDir:fixture.stateDir}),e=>e.code==='POLICY_DENIED');
});
test('evidence forgery, revision mismatch and incomplete result cannot support conclusion',async t=>{
  const broker=await setup(t);const e=await broker.call('service_health',{service:'matching-service'});const receipt=await readJson(path.join(broker.stateDir,`${e.evidenceId}.receipt.json`));
  assert.throws(()=>broker.assertEvidence(receipt,{revision:'different'}),x=>x.code==='REVISION_MISMATCH');receipt.envelope.revision='forged';assert.throws(()=>broker.assertEvidence(receipt),x=>x.code==='UNTRUSTED_EVIDENCE');
});
