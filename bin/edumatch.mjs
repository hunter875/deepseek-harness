import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,loadConfig,readJson,requireGate} from '../lib/common.mjs';
import {runProcess} from '../lib/process.mjs';
const config=await loadConfig();const command=process.argv[2]??'doctor';
if(command==='doctor') {
  const docker=await runProcess('docker',['version','--format','{{json .Server}}'],{timeoutMs:10000});
  console.log(JSON.stringify({node:process.version,repo:path.resolve(ROOT,config.EDUMATCH_REPO),fixtureMode:config.EDUMATCH_ENVIRONMENT==='fixture',deepseekKeyConfigured:Boolean(config.DEEPSEEK_API_KEY),awsProfileConfigured:Boolean(config.AWS_PROFILE),awsMonthlyBudgetUsd:Number(config.AWS_MONTHLY_BUDGET_USD),dockerReady:docker.exitCode===0,sandboxImagePinned:/@sha256:[a-f0-9]{64}$/.test(config.SANDBOX_IMAGE),liveObserversEnabled:config.OBSERVERS_LIVE_ENABLED==='true'},null,2));
} else if(command==='launch') {
  throw new Error('Use scripts/run-task.mjs with a frozen task contract. It enforces isolation and provider budgets before launching the upstream engine.');
  requireGate(config.DEEPSEEK_API_KEY,'BLOCKED','Fill DEEPSEEK_API_KEY in .env');
  const prompt=process.argv.slice(3).join(' ');requireGate(prompt.length>0,'INVALID_ARGUMENT','Task prompt required');
  const result=await runProcess(process.execPath,[path.join(ROOT,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','edumatch',prompt],{cwd:ROOT,timeoutMs:300000,maxBytes:102400,env:{DSH_HOME:path.join(ROOT,'.dsh-home'),DSH_TELEMETRY_DISABLED:'1',DEEPSEEK_API_KEY:config.DEEPSEEK_API_KEY,DEEPSEEK_BASE_URL:config.EDUMATCH_DEEPSEEK_BASE_URL}});
  console.log(JSON.stringify({status:'BLOCKED',unverifiedModelDraft:result.output,reason:'Discovery draft only. Use scripts/run-task.mjs with a frozen contract and independent verifier to obtain an authoritative result.'},null,2));process.exitCode=result.exitCode??1;
} else throw new Error('Usage: node bin/edumatch.mjs doctor | launch <prompt>');
