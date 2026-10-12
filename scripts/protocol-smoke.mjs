import http from 'node:http';
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import {ROOT,writeJson,readJson,utc,requireGate} from '../lib/common.mjs';
import {runProcess,cleanEnv} from '../lib/process.mjs';
const requests=[];const toolId='fixture-call-01';let activeChildren=[];let agentCalls=0;
const fixture=http.createServer(async(req,res)=> {
  if(!req.url.endsWith('/chat/completions')){res.writeHead(404);res.end('{}');return;}
  let body='';for await(const chunk of req)body+=chunk.toString();const request=JSON.parse(body);requests.push(request);
  const call=requests.length;
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const emit=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:`fixture-response-${call}`,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'deepseek-flash',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
  if(request.tools?.length && ++agentCalls===1){emit({role:'assistant'});emit({tool_calls:[{index:0,id:toolId,type:'function',function:{name:'mcp__edumatch__service_health',arguments:'{"service":"matching-service"}'}}]});emit({},'tool_calls');}
  else {emit({role:'assistant',content:'FIXTURE_PROTOCOL_OK. Fixture evidence only; no live system verified.'});emit({},'stop');}
  res.write('data: [DONE]\n\n');res.end();
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const port=fixture.address().port;
const broker=spawn(process.execPath,[path.join(ROOT,'bin/broker.mjs')],{cwd:ROOT,env:cleanEnv({EDUMATCH_ENVIRONMENT:'fixture',EDUMATCH_TARGET:'local-fixture'}),windowsHide:true,stdio:['ignore','pipe','pipe']});activeChildren.push(broker);
const ready=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),10000);broker.stdout.once('data',()=>{clearTimeout(timer);resolve(true);});broker.once('exit',()=>{clearTimeout(timer);resolve(false);});});
let result;
try {
  requireGate(ready,'BLOCKED','Fixture broker failed to start');
  // Override only model endpoint in a final overlay; no real provider request.
  const overlay=path.join(ROOT,'.state','protocol.patch.yml');await fs.mkdir(path.dirname(overlay),{recursive:true});
  await fs.writeFile(overlay,`- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n    baseURL: http://127.0.0.1:${port}\n    thinking: disabled\n    maxTokens: 512\n    streamIdleTimeoutMs: 10000\n`);
  result=await runProcess(process.execPath,[path.join(ROOT,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','edumatch','--patch',overlay,'Use service_health for matching-service once, then report the fixture evidence.'],{cwd:ROOT,timeoutMs:60000,maxBytes:102400,env:{DSH_HOME:path.join(ROOT,'.dsh-home'),DSH_TELEMETRY_DISABLED:'1',DEEPSEEK_API_KEY:'fixture-key-never-real'}});
  const toolResult=requests.flatMap(r=>r.messages??[]).find(m=>m.role==='tool'&&m.tool_call_id===toolId);
  const advertised=(requests.find(r=>r.tools?.length)?.tools??[]).map(t=>t.function.name);
  const passed=result.exitCode===0&&requests.length>=2&&Boolean(toolResult)&&advertised.length>0&&advertised.every(t=>t.startsWith('mcp__edumatch__'))&&result.output.includes('FIXTURE_PROTOCOL_OK');
  await writeJson(path.join(ROOT,'artifacts','protocol-smoke.json'),{source:'fixture-model-through-pinned-upstream',passed,requestedModel:requests[0]?.model??null,responseModel:'deepseek-flash',requestCount:requests.length,toolId,toolResultMatched:Boolean(toolResult),advertisedTools:advertised,streaming:true,result,verifiedAt:utc(),limitations:['Keyless fixture provider smoke; real DeepSeek API and checkpoint resume remain separate live gates.']});
  const lock=await readJson(path.join(ROOT,'compatibility.lock.json'));lock.capabilities.boot=passed?'fixture-pass':'fixture-fail';lock.capabilities.multiTurnFixtureSmoke=passed;lock.loadedTools=advertised;lock.discoveredSkills=['code-change','diagnose','review'];lock.loadedSkills=[];await writeJson(path.join(ROOT,'compatibility.lock.json'),lock);
  console.log(`Upstream fixture tool -> result -> next turn: ${passed?'PASS':'FAIL'}`);process.exitCode=passed?0:1;
}finally {broker.kill();fixture.close();}
