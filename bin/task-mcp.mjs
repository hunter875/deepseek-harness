import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {ROOT,readJson,requireGate,authenticated,utc} from '../lib/common.mjs';
import {TaskRunner} from '../lib/runner.mjs';
import {Workspace} from '../lib/workspace.mjs';
import {nodeProbeExecutor} from '../lib/verifiers.mjs';
const taskId=process.env.EDUMATCH_TASK_ID;requireGate(/^task-[a-zA-Z0-9-]+$/.test(taskId??''),'POLICY_DENIED','Trusted task binding is required');
const stateDir=path.join(ROOT,'.state','tasks'),folder=path.join(stateDir,taskId),workspace=path.join(folder,'workspace');
const key=await fs.readFile(path.join(ROOT,'.state','authority.key')),saved=await readJson(path.join(folder,'contract.json'));
requireGate(authenticated(saved.frozen,saved.signature,key),'POLICY_DENIED','Frozen contract signature invalid');
const executor=nodeProbeExecutor({mode:'docker',image:process.env.EDUMATCH_SANDBOX_IMAGE});
const runner=new TaskRunner({stateDir,key,registry:saved.frozen.registry,executor});let session=await runner.resume(taskId,workspace);
const code=new Workspace(workspace,session.task);code.budget=session.budget;
const empty={type:'object',additionalProperties:false,properties:{}};
const schemas={task_contract:empty,read_code:{type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string',maxLength:200}}},edit_code:{type:'object',additionalProperties:false,required:['path','content','expectedHash'],properties:{path:{type:'string',maxLength:200},content:{type:'string',maxLength:102400},expectedHash:{type:'string',pattern:'^[a-f0-9]{64}$'}}},search_code:{type:'object',additionalProperties:false,required:['literal'],properties:{literal:{type:'string',minLength:1,maxLength:100}}},verify_candidate:empty};
const ajv=new Ajv();const validators=Object.fromEntries(Object.entries(schemas).map(([k,v])=>[k,ajv.compile(v)]));
const server=new Server({name:'edumatch-task',version:'0.1.0'},{capabilities:{tools:{}}});let busy=false;
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Object.entries(schemas).map(([name,inputSchema])=>({name,description:`Frozen task capability ${name}. No host shell, policy/oracle edit or cloud write. Final status comes from snapshot verifier.`,inputSchema}))}));
server.setRequestHandler(CallToolRequestSchema,async request=> {
  const name=request.params.name,args=request.params.arguments??{};
  requireGate(validators[name]?.(args),'INVALID_ARGUMENT','Task tool schema mismatch');requireGate(!busy,'RATE_LIMITED','Sequential task execution only');busy=true;
  try {
    let value;session.budget.use();
    if(name==='task_contract')value={task:session.task,state:session.state,context:await readJson(path.join(folder,'context.json')),workflow:await fs.readFile(path.join(ROOT,'workflows','code-change','SKILL.md'),'utf8'),source:'frozen-task-authority'};
    else if(name==='read_code')value=await code.read(args.path);
    else if(name==='search_code')value=await code.search(args.literal);
    else if(name==='edit_code') {
      if(session.state==='PLAN')runner.transition(session,'EDIT');
      else if(session.state==='VERIFY'){const old=await readJson(path.join(folder,'result.json'));requireGate(authenticated(old.result,old.signature,key),'UNTRUSTED_REPORT','Invalid repair evidence');runner.transition(session,'REPAIR',old.result.checks.map(c=>c.artifactSha256).join());runner.transition(session,'EDIT');}
      requireGate(session.state==='EDIT','INVALID_TRANSITION','Task is not editable in this state');value=await code.write(args.path,args.content,args.expectedHash);
    } else if(name==='verify_candidate') {
      if(session.state==='PLAN'||session.state==='EDIT')runner.transition(session,'VERIFY');
      const receipt=await runner.verify(session,workspace);value=receipt.result;
    }
    return {content:[{type:'text',text:JSON.stringify(value)}]};
  } catch(error){return {content:[{type:'text',text:JSON.stringify({status:'BLOCKED',code:error.code??'SOURCE_UNAVAILABLE'})}],isError:true};}
  finally{try{await runner.checkpoint(session,workspace);}finally{busy=false;}}
});
await server.connect(new StdioServerTransport());
