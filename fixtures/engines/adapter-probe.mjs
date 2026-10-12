import {liveAdapter} from '/tooling/lib/adapters.mjs';
import {Broker} from '/tooling/lib/broker.mjs';
import {readJson,sha256} from '/tooling/lib/common.mjs';
const policy=await readJson('/tooling/config/policy.json'),targets=await readJson('/tooling/config/targets.json'),queries=await readJson('/tooling/config/queries.json');
// Dependency loading from a Windows bind mount is setup, not observation time.
await Promise.all([import('redis'),import('pg'),import('mysql2/promise')]);
const config={MATCHING_OBSERVER_DATABASE_URL:'postgresql://observer:fake-pg-observer-canary@postgres:5432/fixture',SCHOLARSHIP_OBSERVER_HOST:'mysql',SCHOLARSHIP_OBSERVER_PORT:'3306',SCHOLARSHIP_OBSERVER_USERNAME:'observer',SCHOLARSHIP_OBSERVER_PASSWORD:'fake-mysql-observer-canary',SCHOLARSHIP_OBSERVER_DATABASE:'fixture',REDIS_OBSERVER_URL:'redis://observer:fake-redis-observer-canary@redis:6379',RABBITMQ_OBSERVER_BASE_URL:'http://rabbitmq:15672',RABBITMQ_OBSERVER_USERNAME:'observer',RABBITMQ_OBSERVER_PASSWORD:'fake-rabbit-observer-canary'};
targets.targets['local-fixture'].vhost='fixture';
const broker=new Broker({policy,targets,queries,targetRef:'local-fixture',environment:'fixture',adapter:liveAdapter(config),stateDir:'/tmp/evidence'});
const results=[];
for(const [tool,args]of [['db_read_query',{queryId:'processed-event-state',params:{eventId:'evt-fixture'}}],['db_read_query',{queryId:'outbox-progress',params:{status:'PUBLISHED'}}],['db_schema',{database:'matching'}],['db_schema',{database:'scholarship'}],['rabbitmq_status',{queue:'user_profile_updates'}],['redis_key_metadata',{domain:'scholarship-public-detail',entityId:'1'}]]) {
  const e=await broker.call(tool,args),artifact=await readJson(`/tmp/evidence/${e.evidenceId}.json`);
  results.push({tool,status:e.status,count:e.data.length,artifactHashMatches:sha256(artifact)===e.artifactSha256,errorCode:e.error?.code??null});
}
const passed=results.every(r=>r.status==='ok'&&r.count>0&&r.artifactHashMatches);console.log(JSON.stringify({passed,results,environment:'fixture',source:'actual-adapters-on-disposable-engines'}));process.exitCode=passed?0:1;
