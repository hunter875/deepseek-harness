import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { checkArguments } from './tools.mjs';
import { validate } from './schema.mjs';
import { requireGate, GateError, canonical, sha256, id, utc, redact, sign, authenticated, writeJson, Budget } from './common.mjs';
const FIELDS = {
  service_health:['service','ready','dependencyStatus','version','gitCommit'],
  search_logs:['eventTime','ingestionTime','requestId','traceId','eventId','revision','service','status','durationMs','errorCode'],
  aws_logs:['eventTime','ingestionTime','requestId','traceId','eventId','revision','service','status','durationMs','errorCode'],
  db_schema:['table','column','type','nullable'],db_read_query:null,
  rabbitmq_status:['name','messages_ready','messages_unacknowledged','consumers','publishRate','deliverRate'],
  redis_key_metadata:['domain','entityId','type','pttl','size','ttlState','version'],
  aws_instance_status:['instanceId','state','accountId','region','systemStatus','instanceStatus'],
  aws_deployment_status:['service','desiredDigest','observedDigest','sourceRevision','reconciled','releaseId'],
  aws_cost_summary:['amount','currency','billingObservedAt','estimated','excluded','source']
};
export class Broker {
  constructor({policy,targets,targetRef,environment,queries,adapter,stateDir,key=randomBytes(32),canaries=[],budget={maxSeconds:3600,maxToolCalls:1000,maxTokens:1e9,maxCostUsd:0}}) {
    this.policy=structuredClone(policy);this.queries=structuredClone(queries);this.target=structuredClone(targets.targets[targetRef]);
    requireGate(this.target?.environment===environment,'TARGET_MISMATCH','Invalid target binding');
    this.targetRef=targetRef;this.environment=environment;this.adapter=adapter;this.stateDir=stateDir;this.key=key;this.canaries=canaries;this.budget=new Budget(budget);this.cursors=new Map();
    if(environment!=='fixture') requireGate(policy.liveEnabled && adapter.isolationAttested===true,'POLICY_DENIED','Live observer requires a verified isolation boundary');
  }
  cursor(payload) { const body=Buffer.from(canonical(payload)).toString('base64url');return `${body}.${sign(payload,this.key)}`; }
  decodeCursor(text,queryHash) {
    try {
      const [body,signature,extra]=text.split('.');const payload=JSON.parse(Buffer.from(body,'base64url'));
      requireGate(!extra && authenticated(payload,signature,this.key) && payload.queryHash===queryHash && payload.targetRef===this.targetRef && payload.expires>Date.now(),'TARGET_MISMATCH','Cursor mismatch/expired');
      requireGate(this.cursors.has(payload.id),'TARGET_MISMATCH','Cursor not issued by this broker');return this.cursors.get(payload.id);
    } catch(error) { throw new GateError('TARGET_MISMATCH','Cursor is invalid or belongs to another query'); }
  }
  async call(tool,args) {
    this.budget.use(); const fetchedAt=utc();const toolCallId=id('call'),evidenceId=id('ev');
    const limits={maxRecords:Math.min(args?.limit??this.policy.maxRecords,this.policy.maxRecords),maxBytes:this.policy.maxBytes,timeoutMs:tool==='db_read_query'?this.policy.dbTimeoutMs:this.policy.timeoutMs};
    let source=null,error=null,rows=[],nextCursor=null,truncated=false,status='ok',cleanFields=[];
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),limits.timeoutMs);
    try {
      checkArguments(tool,args,this.target,this.policy,this.queries);
      const queryArgs={...args};delete queryArgs.cursor;
      const queryHash=sha256({tool,args:queryArgs,binding:this.targetRef});
      const page=args.cursor?this.decodeCursor(args.cursor,queryHash):{offset:0,sourceCursor:null};
      source=await Promise.race([
        this.adapter(tool,args,{signal:controller.signal,offset:page.offset,sourceCursor:page.sourceCursor,target:this.target,queries:this.queries,timeoutMs:limits.timeoutMs}),
        new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new GateError('TIMEOUT','Bounded source call timed out')),{once:true}))
      ]);
      const fields=tool==='db_read_query'?this.queries.queries[args.queryId].fields:FIELDS[tool];
      requireGate(Array.isArray(source.rows) && fields,'SCHEMA_MISMATCH','Invalid source response');
      let used=2;
      for(const row of source.rows) {
        const selected=Object.fromEntries(Object.entries(row).filter(([key])=>fields.includes(key)));
        const cleaned=redact(selected,this.canaries);cleanFields.push(...cleaned.redactedFields);
        const size=Buffer.byteLength(canonical(cleaned.value))+1;
        if(rows.length>=limits.maxRecords||used+size>limits.maxBytes) {truncated=true;break;}
        rows.push(cleaned.value);used+=size;
      }
      if(!truncated && source.next!==undefined && source.next!==null) {
        const cursorId=id('cursor');this.cursors.set(cursorId,{offset:source.next,sourceCursor:source.sourceCursor??null});
        nextCursor=this.cursor({id:cursorId,queryHash,targetRef:this.targetRef,expires:Date.now()+300000});
      }
      truncated ||= Boolean(nextCursor)||Boolean(source.incomplete);
      // Truncation within a page needs a resumable source offset; otherwise record incompleteness without inventing a cursor.
      if(truncated)status='partial';
    } catch(caught) {
      status='error';const code=['INVALID_ARGUMENT','PERMISSION_DENIED','TARGET_MISMATCH','NOT_FOUND','TIMEOUT','RATE_LIMITED','SOURCE_UNAVAILABLE','SCHEMA_MISMATCH','POLICY_DENIED'].includes(caught.code)?caught.code:'SOURCE_UNAVAILABLE';
      error={code,message:code==='SOURCE_UNAVAILABLE'?'Bound source is unavailable':redact(caught.message,this.canaries).value};
      rows=[];nextCursor=null;
    } finally {clearTimeout(timer);}
    const category=tool==='aws_cost_summary'?'cost':tool==='aws_deployment_status'?'deployment':'default';
    const observed=source?.sourceObservedAt??null;
    const age=observed?(Date.parse(fetchedAt)-Date.parse(observed))/1000:null;
    const freshness=age===null||!Number.isFinite(age)||age< -5?'unknown':args?.window?'historical':age<=this.policy.freshnessSeconds[category]?'within-policy':'stale';
    const clean=redact({data:rows,error},this.canaries);
    const artifact={tool,argumentsHash:sha256(args??{}),...clean.value};
    await writeJson(path.join(this.stateDir,`${evidenceId}.json`),artifact);
    const envelope={schemaVersion:'1.0',toolCallId,evidenceId,toolVersion:this.policy.toolVersion,argumentsHash:sha256(args??{}),status,error:clean.value.error,source:source?.source??(this.environment==='fixture'?'fixture-unavailable':'live-unavailable'),environment:this.environment,targetRef:this.targetRef,revision:source?.revision??null,revisionUnknownReason:source?.revision?null:'Source does not attest a release revision',fetchedAt,sourceObservedAt:observed,queryWindow:args?.window??null,freshness,complete:status==='ok',truncated,nextCursor,coverage:{returned:rows.length,matchedTotal:source?.matchedTotal??null,scannedTotal:source?.scannedTotal??null},limitsApplied:limits,data:rows,redactedFields:[...new Set([...cleanFields,...clean.redactedFields])],warnings:[...(status==='partial'?['Incomplete source coverage']:[]),...(freshness==='stale'?['Source observation is stale']:[]),...(this.environment==='fixture'?['Fixture evidence cannot satisfy a live gate']:[])],artifactRef:evidenceId,artifactSha256:sha256(artifact)};
    await validate('evidence',envelope);
    const receipt={envelope,signature:sign(envelope,this.key)};
    await writeJson(path.join(this.stateDir,`${evidenceId}.receipt.json`),receipt);
    return envelope;
  }
  assertEvidence(receipt,{revision,current=true,allowHistorical=false}={}) {
    requireGate(authenticated(receipt.envelope,receipt.signature,this.key),'UNTRUSTED_EVIDENCE','Broker signature invalid');
    const e=receipt.envelope;
    requireGate(e.status==='ok'&&e.complete&&!e.truncated&&e.targetRef===this.targetRef&&e.environment===this.environment,'INCOMPLETE_EVIDENCE','Evidence cannot support this conclusion');
    if(revision)requireGate(e.revision===revision,'REVISION_MISMATCH','Wrong observed release');
    if(current)requireGate(e.freshness==='within-policy'&&(Date.now()-Date.parse(e.sourceObservedAt))/1000<=this.policy.freshnessSeconds.default,'STALE_EVIDENCE','Evidence is stale or historical');
    if(!allowHistorical)requireGate(e.freshness!=='historical','STALE_EVIDENCE','Historical evidence requires a scoped historical assertion');
    return e;
  }
}
