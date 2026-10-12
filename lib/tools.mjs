import Ajv from 'ajv';
import formats from 'ajv-formats';
import { requireGate } from './common.mjs';
const text = {type:'string',minLength:1,maxLength:200};
const timestamp = {type:'string',format:'date-time',pattern:'Z$'};
const window = {type:'object',additionalProperties:false,required:['from','to'],properties:{from:timestamp,to:timestamp}};
const bounded = {limit:{type:'integer',minimum:1,maximum:200},cursor:{type:'string',maxLength:4096}};
const record = (required, properties) => ({type:'object',additionalProperties:false,required,properties});
const services=['auth-service','scholarship-service','matching-service','matching-consumer','chat-service','api-gateway'];
const databases=['matching','scholarship'];
const queues=['user_profile_updates','scholarship_updates'];
const cacheDomains=['scholarship-public-detail'];
const queryIds=['processed-event-state','outbox-progress'];
export const TOOL_SCHEMAS = {
  service_health:record(['service'],{service:{enum:services}}),
  search_logs:record(['service','window'],{service:{enum:services},window,correlationId:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,100}$'},...bounded}),
  db_schema:record(['database'],{database:{enum:databases}}),
  db_read_query:record(['queryId','params'],{queryId:{enum:queryIds},params:{type:'object',maxProperties:4,additionalProperties:{type:'string',minLength:1,maxLength:100}},...bounded}),
  rabbitmq_status:record(['queue'],{queue:{enum:queues}}),
  redis_key_metadata:record(['domain','entityId'],{domain:{enum:cacheDomains},entityId:{type:'string',pattern:'^[1-9][0-9]{0,18}$'}}),
  aws_instance_status:record([],{ }),
  aws_logs:record(['logAlias','window'],{logAlias:text,window,correlationId:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,100}$'},...bounded}),
  aws_deployment_status:record(['service'],{service:text}),
  aws_cost_summary:record(['budgetAlias'],{budgetAlias:text})
};
export const TOOL_DESCRIPTIONS = {
  service_health:`Read service readiness. service must be one of: ${services.join(', ')}.`,
  search_logs:`Search logs for an allowed service. window.from/to must be RFC3339 UTC ending in Z, span at most 60 minutes, and to must not be in the future. Allowed services: ${services.join(', ')}.`,
  db_schema:`Read the allowlisted schema projection. database must be one of: ${databases.join(', ')}.`,
  db_read_query:'Run one named read-only query. processed-event-state requires params {eventId}; outbox-progress requires params {status}. Never invent query IDs.',
  rabbitmq_status:`Read queue counters. queue must be one of: ${queues.join(', ')}.`,
  redis_key_metadata:`Read metadata for one numeric entity ID. domain must be: ${cacheDomains.join(', ')}. Keys cannot be enumerated.`,
  aws_instance_status:'Read the single bound staging instance status.',
  aws_logs:'Search the bound AWS log alias. Use logAlias staging and an RFC3339 UTC window of at most 60 minutes ending no later than now.',
  aws_deployment_status:`Compare desired and observed release identity for one service: ${services.join(', ')}.`,
  aws_cost_summary:'Read the bound AWS budget summary using budgetAlias edumatch-staging.'
};
const ajv = new Ajv({strict:true,allErrors:true}); formats(ajv);
const compiled = Object.fromEntries(Object.entries(TOOL_SCHEMAS).map(([k,s])=>[k,ajv.compile(s)]));
export function checkArguments(tool,args,target,policy,queries) {
  requireGate(policy.allowedTools.includes(tool) && compiled[tool], 'POLICY_DENIED', 'Tool not allowlisted');
  requireGate(compiled[tool](args), 'INVALID_ARGUMENT', ajv.errorsText(compiled[tool].errors));
  for(const [key,field] of [['service','services'],['queue','queues'],['database','databases'],['domain','cacheDomains'],['logAlias','logAliases'],['budgetAlias','budgetAliases']]) {
    if(args[key]) requireGate(target[field]?.includes(args[key]), 'TARGET_MISMATCH', `${key} is outside bound target`);
  }
  if(args.window) {
    const from=Date.parse(args.window.from),to=Date.parse(args.window.to);
    requireGate(to>from && to-from<=policy.maxWindowSeconds*1000 && to<=Date.now()+5000,'INVALID_ARGUMENT','Invalid UTC window');
  }
  if(args.queryId) {
    const query=queries.queries[args.queryId];
    requireGate(query && target.databases.includes(query.database),'POLICY_DENIED','Unknown query ID');
    requireGate(Object.keys(args.params).sort().join()===Object.keys(query.params).sort().join() && Object.entries(query.params).every(([k,t])=>typeof args.params[k]===t),'INVALID_ARGUMENT','Named query parameters mismatch');
  }
}
