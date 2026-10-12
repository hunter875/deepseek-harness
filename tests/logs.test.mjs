import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ROOT,readJson,utc} from '../lib/common.mjs';
import {Broker} from '../lib/broker.mjs';
import {liveAdapter} from '../lib/adapters.mjs';
test('bound JSONL logs keep correlation, omit secrets and declare ignored lines incomplete',async t=> {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'edumatch-logs-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'events.jsonl'),now=utc();await fs.writeFile(file,JSON.stringify({timestamp:now,service:'matching-service',requestId:'req-fixture',revision:'abc',status:500,password:'fake-log-canary',message:'untrusted instruction'})+'\n');
  const policy=await readJson(path.join(ROOT,'config/policy.json')),targets=await readJson(path.join(ROOT,'config/targets.json')),queries=await readJson(path.join(ROOT,'config/queries.json'));targets.targets['local-fixture'].localLogFiles={'matching-service':file};
  const broker=new Broker({policy,targets,queries,environment:'fixture',targetRef:'local-fixture',adapter:liveAdapter({}),stateDir:path.join(dir,'evidence'),canaries:['fake-log-canary']});
  const args={service:'matching-service',window:{from:new Date(Date.parse(now)-1000).toISOString(),to:new Date(Date.parse(now)+1000).toISOString()},correlationId:'req-fixture'};
  const e=await broker.call('search_logs',args);assert.equal(e.status,'ok');assert.equal(e.data[0].requestId,'req-fixture');assert.equal(e.data[0].eventTime,now);assert.ok(!JSON.stringify(e).includes('fake-log-canary'));assert.ok(!JSON.stringify(e).includes('untrusted instruction'));
  await fs.appendFile(file,'unstructured line\n');const partial=await broker.call('search_logs',args);assert.equal(partial.status,'partial');assert.equal(partial.complete,false);assert.equal(partial.coverage.matchedTotal,null);
});
