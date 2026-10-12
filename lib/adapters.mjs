import fs from 'node:fs/promises';
import { requireGate, GateError, utc, readJson } from './common.mjs';
import { runProcess } from './process.mjs';
async function jsonFetch(url,{signal,headers={}}={}) {
  const result=await fetch(url,{signal,headers,redirect:'error'});
  if(!result.ok) throw new GateError(result.status===401||result.status===403?'PERMISSION_DENIED':'SOURCE_UNAVAILABLE','Source HTTP request failed');
  const length=Number(result.headers.get('content-length')??0);
  requireGate(length<=1048576,'SCHEMA_MISMATCH','Source response too large');
  const reader=result.body.getReader();let buffers=[],bytes=0;
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1048576){await reader.cancel();throw new GateError('SCHEMA_MISMATCH','Source byte cap');}buffers.push(Buffer.from(value));}
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}
export async function awsRead(config,service,operation,args=[],signal) {
  const allow={sts:['get-caller-identity'],ec2:['describe-instances','describe-instance-status','stop-instances'],logs:['filter-log-events'],ce:['get-cost-and-usage']};
  requireGate(allow[service]?.includes(operation),'POLICY_DENIED','AWS action is not approved');
  if(operation==='stop-instances')requireGate(args.includes('--dry-run'),'POLICY_DENIED','Stop probe must use DryRun');
  const env=Object.fromEntries(['AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE','USERPROFILE','HOME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const run=await runProcess('aws',[service,operation,...args,'--profile',config.AWS_PROFILE,'--region',config.EDUMATCH_REGION,'--output','json','--no-cli-pager','--no-paginate'],{timeoutMs:10000,maxBytes:1048576,signal,env,captureJson:true});
  if(run.timedOut)throw new GateError('TIMEOUT','AWS read timed out');
  if(run.exitCode!==0)throw new GateError(/UnauthorizedOperation|AccessDenied|not authorized/.test(run.output)?'PERMISSION_DENIED':/Throttl/.test(run.output)?'RATE_LIMITED':'SOURCE_UNAVAILABLE','AWS read failed');
  requireGate(!run.truncated&&run.parsedJson!==undefined,'SCHEMA_MISMATCH','AWS response exceeded source cap or invalid JSON');return run.parsedJson;
}
export async function bindAwsIdentity(config,target,signal) {
  requireGate(config.AWS_PROFILE && /^\d{12}$/.test(target.accountId??'') && target.roleArn && target.region===config.EDUMATCH_REGION,'TARGET_MISMATCH','AWS binding is incomplete');
  const identity=await awsRead(config,'sts','get-caller-identity',[],signal);
  const roleName=target.roleArn.split('/').at(-1);
  requireGate(identity.Account===target.accountId && identity.Arn.startsWith(`arn:aws:sts::${target.accountId}:assumed-role/${roleName}/`),'TARGET_MISMATCH','Actual AWS account/role mismatch');
  return identity;
}
export function liveAdapter(config,{isolationAttested=false}={}) {
  const adapter=async(tool,args,ctx)=>{
    const {target,queries,signal}=ctx;
    const meta={source:'live-'+tool,sourceObservedAt:utc(),revision:null,matchedTotal:null,scannedTotal:null};
    if(tool.startsWith('aws_'))await bindAwsIdentity(config,target,signal);
    if(tool==='search_logs') {
      const file=target.localLogFiles?.[args.service];requireGate(file,'POLICY_DENIED','No frozen local log file for service');
      const stat=await fs.lstat(file);requireGate(stat.isFile()&&!stat.isSymbolicLink(),'POLICY_DENIED','Log source must be a regular bound file');
      const handle=await fs.open(file,'r');let text;
      try {const bytes=Math.min(stat.size,1048576),buffer=Buffer.alloc(bytes);const read=await handle.read(buffer,0,bytes,Math.max(0,stat.size-bytes));text=buffer.subarray(0,read.bytesRead).toString('utf8');}finally{await handle.close();}
      let incomplete=stat.size>1048576,scanned=0;const rows=[],revisions=new Set();
      if(incomplete)text=text.slice(text.indexOf('\n')+1);
      for(const line of text.split('\n').filter(Boolean)) {
        if(signal.aborted)throw new GateError('TIMEOUT','Log read cancelled');scanned++;
        let row;try{row=JSON.parse(line);}catch{incomplete=true;continue;}
        const time=Date.parse(row.eventTime??row.timestamp);if(!Number.isFinite(time)){incomplete=true;continue;}
        if(time<Date.parse(args.window.from)||time>Date.parse(args.window.to)||row.service!==args.service)continue;
        if(args.correlationId&&![row.requestId,row.traceId,row.eventId].includes(args.correlationId))continue;
        rows.push({...row,eventTime:new Date(time).toISOString()});if(row.revision)revisions.add(row.revision);
      }
      const after=await fs.stat(file);incomplete||=stat.size!==after.size||stat.mtimeMs!==after.mtimeMs;
      return {...meta,source:'live-bound-jsonl-file',sourceObservedAt:stat.mtime.toISOString(),revision:revisions.size===1?[...revisions][0]:null,rows,scannedTotal:scanned,matchedTotal:incomplete?null:rows.length,incomplete};
    }
    if(tool==='service_health') {
      requireGate(target.healthUrls[args.service],'POLICY_DENIED','No audited health URL for service');
      const data=await jsonFetch(target.healthUrls[args.service],{signal});
      return {...meta,revision:data.gitCommit??data.commit??null,rows:[{service:args.service,ready:data.status==='UP'||data.status==='healthy',dependencyStatus:data.database??data.status,version:data.version,gitCommit:data.gitCommit??data.commit}]};
    }
    if(tool==='db_read_query'||tool==='db_schema') {
      const database=tool==='db_schema'?args.database:queries.queries[args.queryId].database;
      const tables=queries.schemaTables[database];let rows;
      if(database==='matching') {
        const {Client}=await import('pg');
        const client=new Client({connectionString:config.MATCHING_OBSERVER_DATABASE_URL,connectionTimeoutMillis:ctx.timeoutMs,statement_timeout:ctx.timeoutMs,query_timeout:ctx.timeoutMs,options:'-c default_transaction_read_only=on -c lock_timeout=1000'});
        const cancel=()=>client.end().catch(()=>{});signal.addEventListener('abort',cancel,{once:true});
        try {await client.connect();await client.query('BEGIN READ ONLY');
          if(tool==='db_schema')rows=(await client.query('SELECT table_name AS "table", column_name AS "column", data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2) ORDER BY table_name, ordinal_position',['public',tables])).rows;
          else {const q=queries.queries[args.queryId];rows=(await client.query(q.sql,q.args.map(k=>args.params[k]))).rows;}
          await client.query('ROLLBACK');
        } finally {signal.removeEventListener('abort',cancel);await client.end();}
      } else {
        const mysql=await import('mysql2/promise');
        const connection=await mysql.createConnection({host:config.SCHOLARSHIP_OBSERVER_HOST,port:Number(config.SCHOLARSHIP_OBSERVER_PORT),user:config.SCHOLARSHIP_OBSERVER_USERNAME,password:config.SCHOLARSHIP_OBSERVER_PASSWORD,database:config.SCHOLARSHIP_OBSERVER_DATABASE,connectTimeout:ctx.timeoutMs,multipleStatements:false,supportBigNumbers:true,bigNumberStrings:true});
        const cancel=()=>connection.destroy();signal.addEventListener('abort',cancel,{once:true});
        try {await connection.query(`SET SESSION MAX_EXECUTION_TIME=${ctx.timeoutMs}`);await connection.query('SET SESSION innodb_lock_wait_timeout=1');await connection.query('START TRANSACTION READ ONLY');
          if(tool==='db_schema') [rows]=await connection.execute(`SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`, DATA_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.columns WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${tables.map(()=>'?').join(',')}) ORDER BY TABLE_NAME, ORDINAL_POSITION`,[config.SCHOLARSHIP_OBSERVER_DATABASE,...tables]);
          else {const q=queries.queries[args.queryId];[rows]=await connection.execute(q.sql,q.args.map(k=>args.params[k]));}
          await connection.rollback();
        } finally {signal.removeEventListener('abort',cancel);await connection.end();}
      }
      return {...meta,rows,incomplete:rows.length>200};
    }
    if(tool==='rabbitmq_status') {
      const url=new URL(`/api/queues/${encodeURIComponent(target.vhost)}/${encodeURIComponent(args.queue)}`,config.RABBITMQ_OBSERVER_BASE_URL);
      const data=await jsonFetch(url,{signal,headers:{authorization:'Basic '+Buffer.from(`${config.RABBITMQ_OBSERVER_USERNAME}:${config.RABBITMQ_OBSERVER_PASSWORD}`).toString('base64')}});
      return {...meta,rows:[{name:data.name,messages_ready:data.messages_ready,messages_unacknowledged:data.messages_unacknowledged,consumers:data.consumers,publishRate:data.message_stats?.publish_details?.rate,deliverRate:data.message_stats?.deliver_get_details?.rate}]};
    }
    if(tool==='redis_key_metadata') {
      const encoder=queries.cacheEncoders[args.domain];requireGate(encoder&&new RegExp(encoder.entityPattern).test(args.entityId),'INVALID_ARGUMENT','Key encoder rejected entity');
      const {createClient}=await import('redis');const client=createClient({url:config.REDIS_OBSERVER_URL,disableClientInfo:true,socket:{connectTimeout:ctx.timeoutMs,reconnectStrategy:false}});client.on('error',()=>{});
      const cancel=()=>client.destroy();signal.addEventListener('abort',cancel,{once:true});
      try {await client.connect();const key=encoder.prefix+args.entityId;const type=await client.type(key),pttl=await client.pTTL(key);const size=type==='string'?await client.strLen(key):type==='hash'?await client.hLen(key):null;
        return {...meta,rows:[{domain:args.domain,entityId:args.entityId,type,pttl,size,ttlState:pttl===-2?'not-found':pttl===-1?'no-expiry':'expiring',version:null}]};
      } finally {signal.removeEventListener('abort',cancel);if(client.isOpen)await client.close();}
    }
    if(tool==='aws_instance_status') {
      requireGate(/^i-[a-f0-9]+$/.test(target.instanceId??''),'TARGET_MISMATCH','Instance ID is not bound');
      const data=await awsRead(config,'ec2','describe-instances',['--instance-ids',target.instanceId],signal);
      const instances=data.Reservations.flatMap(r=>r.Instances);requireGate(instances.length===1&&instances[0].InstanceId===target.instanceId,'TARGET_MISMATCH','Unexpected instance response');
      const state=await awsRead(config,'ec2','describe-instance-status',['--instance-ids',target.instanceId,'--include-all-instances'],signal);
      return {...meta,rows:[{instanceId:target.instanceId,state:instances[0].State.Name,accountId:target.accountId,region:target.region,systemStatus:state.InstanceStatuses[0]?.SystemStatus.Status??'unknown',instanceStatus:state.InstanceStatuses[0]?.InstanceStatus.Status??'unknown'}]};
    }
    if(tool==='aws_logs') {
      const parameters=['--log-group-name',target.logGroups[args.logAlias],'--start-time',String(Date.parse(args.window.from)),'--end-time',String(Date.parse(args.window.to)),'--limit',String(args.limit??200)];
      if(args.correlationId)parameters.push('--filter-pattern',`"${args.correlationId}"`);
      if(ctx.sourceCursor)parameters.push('--next-token',ctx.sourceCursor);
      const data=await awsRead(config,'logs','filter-log-events',parameters,signal);
      const rows=(data.events??[]).map(e=> {let parsed={};try{parsed=JSON.parse(e.message);}catch(error){/* Unstructured message omitted by field allowlist. */}return {...parsed,eventTime:new Date(e.timestamp).toISOString(),ingestionTime:new Date(e.ingestionTime).toISOString()};});
      return {...meta,sourceObservedAt:rows.at(-1)?.ingestionTime??null,rows,next:data.nextToken?1:null,sourceCursor:data.nextToken??null,incomplete:Boolean(data.nextToken)};
    }
    if(tool==='aws_deployment_status') {
      requireGate(target.deploymentStatusFile,'POLICY_DENIED','Trusted release status source not configured');
      const status=await readJson(target.deploymentStatusFile);
      requireGate(status.targetRef==='aws-staging'&&status.accountId===target.accountId&&status.region===target.region,'TARGET_MISMATCH','Release status target mismatch');
      const service=status.services[args.service];requireGate(service,'NOT_FOUND','Service not observed');
      return {...meta,sourceObservedAt:status.observedAt,revision:status.sourceRevision,rows:[{service:args.service,...service,sourceRevision:status.sourceRevision,releaseId:status.releaseId}]};
    }
    if(tool==='aws_cost_summary') {
      // Account-wide billing visibility is deliberately excluded from diagnostic observer.
      throw new GateError('POLICY_DENIED','Use separately authorized cost reader and billing timestamp source');
    }
    throw new GateError('POLICY_DENIED','No audited live source adapter for this tool');
  };
  adapter.isolationAttested=isolationAttested;return adapter;
}
