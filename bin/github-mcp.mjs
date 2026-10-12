import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {ROOT,loadConfig,requireGate,redact,sha256,sign,id,utc,writeJson,Budget} from '../lib/common.mjs';
import {cleanEnv,runProcess} from '../lib/process.mjs';
const cfg=await loadConfig();
requireGate(cfg.GITHUB_OBSERVER_ENABLED==='true'&&cfg.GITHUB_TOKEN_SCOPE_VERIFIED==='true'&&cfg.GITHUB_READ_TOKEN,'BLOCKED','GitHub requires an enabled, audited fine-grained read token restricted to hunter875/edumatch-production');
requireGate(/^ghcr\.io\/github\/github-mcp-server@sha256:[a-f0-9]{64}$/.test(cfg.GITHUB_MCP_IMAGE),'BLOCKED','Pin the official GitHub MCP image before connecting');
const authority=await fs.readFile(path.join(ROOT,'.state/authority.key')),container=id('edumatch-github');
// Credential resides only in the trusted server container. No host mounts/socket/home.
const transport=new StdioClientTransport({command:'docker',args:['run','--rm','-i','--pull','never','--name',container,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001','--memory','256m','--cpus','1','--pids-limit','64','--tmpfs','/tmp:rw,nosuid,noexec,size=16m','-e','GITHUB_PERSONAL_ACCESS_TOKEN','-e','GITHUB_READ_ONLY=1','-e','GITHUB_TOOLSETS=repos,issues,pull_requests,actions',cfg.GITHUB_MCP_IMAGE],env:cleanEnv({GITHUB_PERSONAL_ACCESS_TOKEN:cfg.GITHUB_READ_TOKEN}),stderr:'pipe'});
const upstream=new Client({name:'edumatch-trusted-github-proxy',version:'0.1.0'});
const known=new Set(['get_file_contents','get_commit','list_commits','list_branches','issue_read','list_issues','pull_request_read','list_pull_requests','actions_get','actions_list','get_job_logs']);
let catalog;
try {
  transport.stderr?.on('data',()=>{});await upstream.connect(transport);
  catalog=(await upstream.listTools()).tools.filter(tool=>known.has(tool.name)&&tool.annotations?.readOnlyHint===true&&tool.inputSchema.properties?.owner&&tool.inputSchema.properties?.repo);
  requireGate(catalog.length>0,'BLOCKED','Pinned GitHub server did not advertise audited repository-bound read tools');
}catch(error){await upstream.close().catch(()=>{});await runProcess('docker',['rm','-f',container],{timeoutMs:10000,maxBytes:1024}).catch(()=>{});throw error;}
const ajv=new Ajv({strict:false,validateFormats:false}),validators=Object.fromEntries(catalog.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
const budget=new Budget({maxSeconds:3600,maxToolCalls:100,maxTokens:1e9,maxCostUsd:0});let busy=false;
const server=new Server({name:'edumatch-github-read-proxy',version:'0.1.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:catalog}));
server.setRequestHandler(CallToolRequestSchema,async request=> {
  const name=request.params.name,args=request.params.arguments??{};requireGate(!busy,'RATE_LIMITED','Sequential GitHub reads only');busy=true;
  try {
    budget.use();requireGate(validators[name]?.(args)&&args.owner==='hunter875'&&args.repo==='edumatch-production','POLICY_DENIED','Tool/repository argument is outside the bound target');
    requireGate(!Object.keys(args).some(k=>/^(url|headers|token|credentials|command|body)$/i.test(k)),'POLICY_DENIED','Raw capabilities are not accepted');
    const response=await upstream.callTool({name,arguments:args},undefined,{timeout:10000}),clean=redact(response,[cfg.GITHUB_READ_TOKEN]);
    let text=JSON.stringify(clean.value),truncated=Buffer.byteLength(text)>102400;if(truncated)text=Buffer.from(text).subarray(0,102400).toString('utf8');
    const evidence={schemaVersion:'1.0',evidenceId:id('github-ev'),source:'live-official-github-mcp',targetRef:'hunter875/edumatch-production',tool:name,argumentsHash:sha256(args),fetchedAt:utc(),sourceObservedAt:null,revision:null,revisionUnknownReason:'Select commit/ref from returned GitHub metadata; retrieval time does not attest repository revision',status:response.isError?'error':truncated?'partial':'ok',complete:!response.isError&&!truncated,truncated,redactedFields:clean.redactedFields,data:text};
    await writeJson(path.join(ROOT,'.state/github-evidence',`${evidence.evidenceId}.json`),{evidence,signature:sign(evidence,authority)});
    return {content:[{type:'text',text:JSON.stringify(evidence)}],isError:Boolean(response.isError)};
  }catch(error){return {content:[{type:'text',text:JSON.stringify({status:'BLOCKED',code:error.code??'SOURCE_UNAVAILABLE'})}],isError:true};}
  finally{busy=false;}
});
const close=async()=>{await upstream.close().catch(()=>{});await runProcess('docker',['rm','-f',container],{timeoutMs:10000,maxBytes:1024}).catch(()=>{});process.exit();};
process.once('SIGINT',close);process.once('SIGTERM',close);process.stdin.once('end',close);
await server.connect(new StdioServerTransport());
