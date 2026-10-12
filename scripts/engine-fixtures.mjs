import path from 'node:path';
import fs from 'node:fs/promises';
import {ROOT,readJson,writeJson,requireGate,id,utc} from '../lib/common.mjs';
import {runProcess} from '../lib/process.mjs';
const lock=await readJson(path.join(ROOT,'config/fixture-images.lock.json'));const prefix=id('edumatch-fixture');const network=prefix;const names={};const results=[];
const docker=async(args,timeoutMs=20000)=>runProcess('docker',args,{timeoutMs,maxBytes:102400});
const checked=async(args,timeoutMs)=>{const result=await docker(args,timeoutMs);requireGate(result.exitCode===0&&!result.timedOut&&!result.truncated,'FIXTURE_FAILED',result.output.slice(-4000)||`Container command failed: exit=${result.exitCode}, timeout=${result.timedOut}, truncated=${result.truncated}`);return result.output.trim();};
async function untilReady(args,seconds=90) {
  const deadline=Date.now()+seconds*1000;while(Date.now()<deadline){const result=await docker(args,5000);if(result.exitCode===0)return;await new Promise(resolve=>setTimeout(resolve,1000));}
  throw new Error('Disposable fixture readiness timeout');
}
try {
  await checked(['network','create','--internal',network]);
  for(const name of ['postgres','mysql','redis','rabbitmq']) {
    names[name]=`${prefix}-${name}`;
    const options=['run','-d','--pull','never','--name',names[name],'--network',network,'--network-alias',name,'--cpus','2','--memory',name==='rabbitmq'?'1g':name==='mysql'?'768m':'512m','--pids-limit','256'];
    if(name==='postgres')options.push('--tmpfs','/var/lib/postgresql/data:rw,size=256m','-e','POSTGRES_DB=fixture','-e','POSTGRES_PASSWORD=fake-pg-admin-canary','--mount',`type=bind,source=${path.join(ROOT,'fixtures/engines/postgres.sql')},target=/docker-entrypoint-initdb.d/fixture.sql,readonly`);
    if(name==='mysql')options.push('--tmpfs','/var/lib/mysql:rw,size=512m','-e','MYSQL_DATABASE=fixture','-e','MYSQL_ROOT_PASSWORD=fake-mysql-admin-canary','--mount',`type=bind,source=${path.join(ROOT,'fixtures/engines/mysql.sql')},target=/docker-entrypoint-initdb.d/fixture.sql,readonly`);
    if(name==='rabbitmq')options.push('-e','RABBITMQ_DEFAULT_USER=fixture_admin','-e','RABBITMQ_DEFAULT_PASS=fake-rabbit-admin-canary');
    options.push(lock.images[name].image);await checked(options);
  }
  await untilReady(['exec',names.postgres,'pg_isready','-U','postgres','-d','fixture']);
  // Wait for initialization scripts to have committed the observer role.
  await untilReady(['exec','-e','PGPASSWORD=fake-pg-observer-canary',names.postgres,'psql','-h','127.0.0.1','-U','observer','-d','fixture','-c','SELECT event_id FROM processed_events']);
  const pgBefore=await checked(['exec',names.postgres,'psql','-U','postgres','-d','fixture','-Atc','SELECT count(*) FROM processed_events']);
  const pgRead=await checked(['exec','-e','PGPASSWORD=fake-pg-observer-canary',names.postgres,'psql','-h','127.0.0.1','-U','observer','-d','fixture','-Atc',"SELECT event_id,status FROM processed_events WHERE event_id='evt-fixture'"]);
  const pgMutations=[];
  for(const sql of ["DELETE FROM processed_events","WITH gone AS (DELETE FROM processed_events RETURNING *) SELECT count(*) FROM gone","EXPLAIN ANALYZE DELETE FROM processed_events","COPY processed_events TO '/tmp/escape'","CREATE FUNCTION dangerous() RETURNS integer LANGUAGE sql AS 'SELECT 1'"]) {
    const result=await docker(['exec','-e','PGPASSWORD=fake-pg-observer-canary',names.postgres,'psql','-h','127.0.0.1','-U','observer','-d','fixture','-v','ON_ERROR_STOP=1','-c',sql]);pgMutations.push({sqlCategory:sql.split(' ')[0],denied:result.exitCode!==0});
  }
  const pgAfter=await checked(['exec',names.postgres,'psql','-U','postgres','-d','fixture','-Atc','SELECT count(*) FROM processed_events']);
  results.push({engine:'postgres',version:await checked(['exec',names.postgres,'postgres','--version']),positiveRead:pgRead==='evt-fixture|PROCESSED',mutations:pgMutations,before:pgBefore,after:pgAfter,passed:pgRead==='evt-fixture|PROCESSED'&&pgMutations.every(m=>m.denied)&&pgBefore===pgAfter});
  await untilReady(['exec','-e','MYSQL_PWD=fake-mysql-observer-canary',names.mysql,'mysql','-h','127.0.0.1','-u','observer','-D','fixture','-e','SELECT id FROM outbox_events'],120);
  const mysqlRead=await checked(['exec','-e','MYSQL_PWD=fake-mysql-observer-canary',names.mysql,'mysql','-h','127.0.0.1','-u','observer','-D','fixture','-NBe',"SELECT id,status FROM outbox_events WHERE status='PUBLISHED' ORDER BY id"]);
  const mysqlMutations=[];
  for(const sql of ['DELETE FROM outbox_events',"SELECT id INTO OUTFILE '/tmp/escape' FROM outbox_events",'DROP TABLE outbox_events']) {const run=await docker(['exec','-e','MYSQL_PWD=fake-mysql-observer-canary',names.mysql,'mysql','-h','127.0.0.1','-u','observer','-D','fixture','-e',sql]);mysqlMutations.push({category:sql.split(' ')[0],denied:run.exitCode!==0});}
  const mysqlAfter=await checked(['exec','-e','MYSQL_PWD=fake-mysql-admin-canary',names.mysql,'mysql','-u','root','-D','fixture','-NBe','SELECT count(*) FROM outbox_events']);
  results.push({engine:'mysql',version:await checked(['exec',names.mysql,'mysql','--version']),positiveRead:mysqlRead==='1\tPUBLISHED',mutations:mysqlMutations,after:mysqlAfter,passed:mysqlRead==='1\tPUBLISHED'&&mysqlMutations.every(m=>m.denied)&&mysqlAfter==='1'});
  await untilReady(['exec',names.redis,'redis-cli','ping']);
  await checked(['exec',names.redis,'redis-cli','SET','scholarship:scholarshipPublicDetail::1','fake-cache-canary','PX','60000']);
  await checked(['exec',names.redis,'redis-cli','ACL','SETUSER','observer','on','>fake-redis-observer-canary','~scholarship:scholarshipPublicDetail::*','-@all','+type','+pttl','+strlen','+hlen']);
  const redisRead=await checked(['exec',names.redis,'redis-cli','--user','observer','-a','fake-redis-observer-canary','--no-auth-warning','TYPE','scholarship:scholarshipPublicDetail::1']);
  const redisMutations=[];
  for(const argv of [['SET','scholarship:scholarshipPublicDetail::1','changed'],['DEL','scholarship:scholarshipPublicDetail::1'],['KEYS','*'],['SCAN','0'],['FLUSHDB'],['CONFIG','GET','*'],['EVAL','return 1','0'],['TYPE','other:secret']]) {
    const run=await docker(['exec',names.redis,'redis-cli','--user','observer','-a','fake-redis-observer-canary','--no-auth-warning',...argv]);redisMutations.push({command:argv[0],denied:run.output.includes('NOPERM')});
  }
  const redisAfter=await checked(['exec',names.redis,'redis-cli','GET','scholarship:scholarshipPublicDetail::1']);
  results.push({engine:'redis',version:await checked(['exec',names.redis,'redis-server','--version']),positiveRead:redisRead==='string',mutations:redisMutations,passed:redisRead==='string'&&redisMutations.every(m=>m.denied)&&redisAfter==='fake-cache-canary'});
  await untilReady(['exec',names.rabbitmq,'rabbitmq-diagnostics','-q','check_running'],120);
  await checked(['exec',names.rabbitmq,'rabbitmqctl','add_vhost','fixture']);await checked(['exec',names.rabbitmq,'rabbitmqctl','set_permissions','-p','fixture','fixture_admin','.*','.*','.*']);
  await checked(['exec',names.rabbitmq,'rabbitmqctl','add_user','observer','fake-rabbit-observer-canary']);await checked(['exec',names.rabbitmq,'rabbitmqctl','set_user_tags','observer','monitoring']);await checked(['exec',names.rabbitmq,'rabbitmqctl','set_permissions','-p','fixture','observer','^$','^$','^$']);
  const mqProbe=['run','--rm','--pull','never','--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001','-e','FIXTURE_MQ_URL=http://rabbitmq:15672','--mount',`type=bind,source=${path.join(ROOT,'fixtures/engines/rabbit-probe.mjs')},target=/probe.mjs,readonly`,lock.images.node.image,'node','/probe.mjs'];
  await checked([...mqProbe,'setup']);await new Promise(resolve=>setTimeout(resolve,6000));
  const rabbit=JSON.parse(await checked([...mqProbe,'test']));
  const amqpProbe=['run','--rm','--pull','never','--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001','--mount',`type=bind,source=${path.join(ROOT,'fixtures/engines/amqp-probe.mjs')},target=/tooling/probe.mjs,readonly`,'--mount',`type=bind,source=${path.join(ROOT,'node_modules')},target=/tooling/node_modules,readonly`,lock.images.node.image,'node','/tooling/probe.mjs'];
  const amqp=JSON.parse(await checked(amqpProbe));
  results.push({engine:'rabbitmq',version:await checked(['exec',names.rabbitmq,'rabbitmq-diagnostics','-q','server_version']),...rabbit,amqp,passed:rabbit.passed&&amqp.passed});
  // Refresh TTL immediately before the actual adapter smoke.
  await checked(['exec',names.redis,'redis-cli','PEXPIRE','scholarship:scholarshipPublicDetail::1','60000']);
  const adapterProbe=['run','--rm','--pull','never','--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001','--tmpfs','/tmp:rw,nosuid,size=32m',...['lib','config','schemas','node_modules'].flatMap(folder=>['--mount',`type=bind,source=${path.join(ROOT,folder)},target=/tooling/${folder},readonly`]),'--mount',`type=bind,source=${path.join(ROOT,'fixtures/engines/adapter-probe.mjs')},target=/tooling/probe.mjs,readonly`,lock.images.node.image,'node','/tooling/probe.mjs'];
  const adapter=JSON.parse(await checked(adapterProbe,90000));results.push({engine:'broker-adapters',...adapter});
  await writeJson(path.join(ROOT,'artifacts/engine-fixtures.json'),{schemaVersion:'1.0',source:'disposable-engine-fixtures',imageLock:lock,verifiedAt:utc(),results,passed:results.every(r=>r.passed),limitations:['Fixture accounts/permissions only; live accounts must be provisioned and independently smoke-tested','No host secrets or shared data were supplied to engine fixtures']});
  requireGate(results.every(r=>r.passed),'FIXTURE_FAILED','Engine permission fixture failed');console.log(`Engine positive/negative fixture tests: ${results.length}/${results.length} PASS`);
} catch(error) {
  await writeJson(path.join(ROOT,'artifacts/engine-fixtures.json'),{schemaVersion:'1.0',source:'disposable-engine-fixtures',verifiedAt:utc(),results,passed:false,failure:{code:error.code??'FIXTURE_FAILED',message:error.message},imageLock:lock});
  throw error;
} finally {
  for(const name of Object.values(names)){requireGate(name.startsWith('edumatch-fixture-'),'POLICY_DENIED','Unsafe cleanup target');await docker(['rm','-f','-v',name]);}
  await docker(['network','rm',network]);
}
