import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {ROOT,loadConfig,readJson,writeJson,requireGate,id} from '../lib/common.mjs';
import {manifest,capture} from '../lib/snapshot.mjs';
import {TaskRunner} from '../lib/runner.mjs';
import {nodeProbeExecutor} from '../lib/verifiers.mjs';
import {runProcess} from '../lib/process.mjs';
import {providerGateway} from '../lib/provider-gateway.mjs';
import {requireIsolation} from '../lib/isolation-proof.mjs';
import {taskContext} from './context.mjs';
const [taskFile,registryFile,sourceArg]=process.argv.slice(2);requireGate(taskFile&&registryFile&&sourceArg,'INVALID_ARGUMENT','Usage: run-task <task.json> <frozen-verifiers.json> <source-workspace>');
const cfg=await loadConfig();requireGate(cfg.DEEPSEEK_API_KEY,'BLOCKED','Populate DeepSeek API key in .env');
requireGate(/@sha256:[a-f0-9]{64}$/.test(cfg.SANDBOX_IMAGE),'BLOCKED','Prepare and pin sandbox image');
await requireIsolation(cfg.SANDBOX_IMAGE);
const priceDate=Date.parse(cfg.DEEPSEEK_PRICE_VERIFIED_AT);
requireGate(Number.isFinite(priceDate)&&priceDate<=Date.now()&&Date.now()-priceDate<7*86400000,'BLOCKED','Verify conservative DeepSeek price ceilings and date in .env');
const task=await readJson(taskFile),registry=await readJson(registryFile);requireGate(task.kind==='code'&&task.environment==='fixture','POLICY_DENIED','This driver supports isolated fixture coding only; live diagnostic uses bound broker and independent evidence acceptance');
const stateDir=path.join(ROOT,'.state','tasks');await fs.mkdir(stateDir,{recursive:true});
const key=await fs.readFile(path.join(ROOT,'.state','authority.key'));
const runner=new TaskRunner({stateDir,key,registry,executor:nodeProbeExecutor({mode:'docker',image:cfg.SANDBOX_IMAGE,isolationAttested:true})});
const source=path.resolve(sourceArg),session=await runner.freeze(task,source);const workspace=path.join(session.folder,'workspace');await capture(source,workspace);
await taskContext(task,path.join(session.folder,'context.json'));
runner.transition(session,'BASELINE');runner.transition(session,'PLAN');runner.transition(session,'VERIFY');const baseline=(await runner.verify(session,workspace)).result;
// Preserve baseline failure classification; a setup failure is never treated as a reproducer.
requireGate(baseline.checks.every(c=>c.ran>0&&!c.timedOut),'BLOCKED','Baseline setup failed');
session.state='PLAN';await runner.checkpoint(session,workspace);
const overlay=path.join(session.folder,'task.patch.yml');await fs.writeFile(overlay,YAML.stringify([{id:'edumatch-ops',disabled:true},{insert:[{id:'edumatch-task',name:'@deepseek-ai/dsh-mcp-client',config:{transport:'stdio',serverName:'task',command:process.execPath,args:[path.join(ROOT,'bin/task-mcp.mjs')],env:{EDUMATCH_TASK_ID:task.taskId,EDUMATCH_SANDBOX_IMAGE:cfg.SANDBOX_IMAGE},cwd:ROOT,toolCallTimeoutMs:30000,failOnStartupError:true}}]}]));
const remainingSeconds=Math.floor(task.budget.maxSeconds-(Date.now()-session.budget.started)/1000);
const gateway=await providerGateway({key:cfg.DEEPSEEK_API_KEY,model:cfg.DEEPSEEK_MODEL,endpoint:cfg.EDUMATCH_DEEPSEEK_BASE_URL,budget:{maxSeconds:remainingSeconds,maxTokens:task.budget.maxTokens,maxCostUsd:Math.min(task.budget.maxCostUsd,Number(cfg.DEEPSEEK_API_BUDGET_USD)),maxCalls:Number(cfg.DEEPSEEK_MAX_API_CALLS)},rates:{input:Number(cfg.DEEPSEEK_INPUT_PRICE_CEILING_PER_M),output:Number(cfg.DEEPSEEK_OUTPUT_PRICE_CEILING_PER_M)}});
const providerPatch={id:'llm-deepseek',config:{baseURL:gateway.url,apiKeyEnv:'DEEPSEEK_API_KEY'}};
// One final overlay guarantees ordering on the pinned CLI without assuming repeated --patch semantics.
const taskPatches=YAML.parse(await fs.readFile(overlay,'utf8'));taskPatches.push(providerPatch);await fs.writeFile(overlay,YAML.stringify(taskPatches));
let output,usage;
try {output=await runProcess(process.execPath,[path.join(ROOT,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','edumatch','--patch',overlay,'Read task_contract, inspect relevant code, implement the frozen acceptance, then verify_candidate. Do not claim a status beyond the trusted verifier.'],{cwd:ROOT,timeoutMs:remainingSeconds*1000,maxBytes:102400,canaries:[cfg.DEEPSEEK_API_KEY,gateway.token],env:{DSH_HOME:path.join(ROOT,'.dsh-home'),DSH_TELEMETRY_DISABLED:'1',DEEPSEEK_API_KEY:gateway.token}});usage=gateway.report();await writeJson(path.join(session.folder,'provider-usage.json'),usage);}
finally {await gateway.close();}
const resumed=await runner.resume(task.taskId,workspace);
if(output.timedOut||output.exitCode!==0||!usage.usageComplete){console.log(JSON.stringify({taskId:task.taskId,status:'BLOCKED',reason:'Upstream run failed, usage is unknown or budget was exceeded'}));process.exitCode=1;}
else {
  // Always verify once outside the model's turn. A model-produced report never writes the verdict.
  if(resumed.state==='PLAN'||resumed.state==='EDIT')runner.transition(resumed,'VERIFY');
  await runner.verify(resumed,workspace);const verdict=await runner.report(resumed,workspace);await writeJson(path.join(ROOT,'artifacts',`${task.taskId}.json`),verdict);
  console.log(JSON.stringify({verdict,workspace,sourceUnmodified:true},null,2));process.exitCode=verdict.status==='SUCCEEDED_LOCAL'?0:1;
}
