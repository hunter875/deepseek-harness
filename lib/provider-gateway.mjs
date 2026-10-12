import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {requireGate,utc} from './common.mjs';

// A trusted transport boundary around the upstream engine, not a second agent loop.
// Reserve a conservative input bound and the full output allowance before each billable request.
export async function providerGateway({key,model,models=[model],endpoint='https://api.deepseek.com',budget,rates,enforceBudget=true,maxRequestBytes=enforceBudget?1048576:33554432,fetchImpl=fetch}) {
  requireGate(endpoint==='https://api.deepseek.com','POLICY_DENIED','Only the official DeepSeek endpoint is bound');
  requireGate(Array.isArray(models)&&models.length>0&&models.every(value=>typeof value==='string'&&value.length>0),'INVALID_ARGUMENT','At least one provider model is required');
  const allowedModels=new Set(models);
  requireGate(key&&Object.values(rates).every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0),'BLOCKED','Dated conservative input/output price ceilings are required');
  if(enforceBudget)requireGate(budget.maxTokens>0&&budget.maxCostUsd>0&&budget.maxCalls>0&&budget.maxSeconds>0,'INVALID_ARGUMENT','Provider budget must be positive');
  requireGate(Number.isSafeInteger(maxRequestBytes)&&maxRequestBytes>0,'INVALID_ARGUMENT','Request byte cap must be a positive integer');
  const token=randomBytes(32).toString('hex'),started=Date.now(),calls=[],active=new Set();let busy=false,reservedTokens=0,reservedCost=0,unknownUsage=false;
  const server=http.createServer(async(req,res)=> {
    const fail=(status,code,message)=>{if(!res.headersSent)res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'edumatch_gate',code,...message?{message}:{}}}));};
    if(req.method!=='POST'||!['/chat/completions','/v1/chat/completions'].includes(req.url)||req.headers.authorization!==`Bearer ${token}`||req.headers.origin)return fail(403,'POLICY_DENIED');
    if(busy)return fail(429,'SEQUENTIAL_ONLY');busy=true;let controller;
    try {
      if(enforceBudget)requireGate(!unknownUsage&&Date.now()-started<budget.maxSeconds*1000,'BUDGET_EXCEEDED','Provider usage unknown or deadline reached');
      let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;requireGate(bytes<=maxRequestBytes,'INVALID_ARGUMENT','Request byte cap');chunks.push(chunk);}
      const body=Buffer.concat(chunks),request=JSON.parse(body);
      requireGate(allowedModels.has(request.model),'INVALID_ARGUMENT','Gateway model is not allowed');
      requireGate(Array.isArray(request.messages),'INVALID_ARGUMENT','Gateway requires a messages array');
      requireGate(!request.n,'INVALID_ARGUMENT','Gateway only allows one completion');
      requireGate(typeof request.max_tokens==='number'&&Number.isInteger(request.max_tokens)&&request.max_tokens>0,'INVALID_ARGUMENT','Gateway requires a positive integer max_tokens');
      requireGate(request.max_tokens<=8192,'INVALID_ARGUMENT','Gateway max_tokens exceeds 8192');
      const inputBound=body.length+1024+request.messages.length*256,outputBound=request.max_tokens;
      const reserveTokens=inputBound+outputBound,reserveCost=(inputBound*rates.input+outputBound*rates.output)/1e6;
      if(enforceBudget)requireGate(calls.length<budget.maxCalls&&reservedTokens+reserveTokens<=budget.maxTokens&&reservedCost+reserveCost<=budget.maxCostUsd,'BUDGET_EXCEEDED','Request reservation exceeds frozen token/cost budget');
      reservedTokens+=reserveTokens;reservedCost+=reserveCost;
      const record={startedAt:utc(),inputBound,outputBound,reservedCost,usage:null,status:'pending'};calls.push(record);
      controller=new AbortController();active.add(controller);const remaining=budget.maxSeconds*1000-(Date.now()-started);const timer=enforceBudget?setTimeout(()=>controller.abort(),Math.max(1,remaining)):null;
      const cancelled=()=>{if(!res.writableFinished)controller.abort();};res.once('close',cancelled);
      try {
        if(request.stream)request.stream_options={include_usage:true};
        const response=await fetchImpl(`${endpoint}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(request),signal:controller.signal,redirect:'error'});
        requireGate(response.ok,'SOURCE_UNAVAILABLE',`DeepSeek upstream rejected request (HTTP ${response.status})`);
        res.writeHead(200,{'content-type':request.stream?'text/event-stream':'application/json','cache-control':'no-store'});
        let text='',received=0;for await(const chunk of response.body){received+=chunk.length;requireGate(received<=4194304,'SOURCE_UNAVAILABLE','Provider response cap');text+=Buffer.from(chunk).toString('utf8');res.write(chunk);}
        const objects=request.stream?text.split('\n').filter(l=>l.startsWith('data: ')&&!l.includes('[DONE]')).map(l=>{try{return JSON.parse(l.slice(6));}catch{return null;}}):[JSON.parse(text)];
        const usage=objects.findLast(o=>o?.usage)?.usage;
        requireGate(usage&&Number.isInteger(usage.prompt_tokens)&&usage.prompt_tokens>=0&&Number.isInteger(usage.completion_tokens)&&usage.completion_tokens>=0,'UNTRUSTED_USAGE','Provider did not attest usage');
        requireGate(usage.prompt_tokens<=inputBound&&usage.completion_tokens<=outputBound,'BUDGET_EXCEEDED','Provider usage exceeded reserved bound');
        record.usage={input:usage.prompt_tokens,output:usage.completion_tokens,costUpperUsd:(usage.prompt_tokens*rates.input+usage.completion_tokens*rates.output)/1e6,responseModel:objects.find(o=>o?.model)?.model??null};record.status='complete';
        // Keep full reservations rather than silently refunding uncertain billable retries.
        res.end();
      } finally {if(timer)clearTimeout(timer);res.removeListener('close',cancelled);}
    } catch(error) {
      if(controller){unknownUsage=true;controller.abort();if(calls.at(-1))calls.at(-1).status=error.code??'SOURCE_UNAVAILABLE';}
      fail(error.code==='BUDGET_EXCEEDED'?429:502,error.code??'SOURCE_UNAVAILABLE',error.message);
    } finally {if(controller)active.delete(controller);busy=false;}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,token,report:()=>({source:'trusted-provider-budget-gateway',model,models:[...allowedModels],calls,startedAt:new Date(started).toISOString(),reservedTokens,reservedCostUsd:reservedCost,usageComplete:!unknownUsage&&calls.length>0&&calls.every(c=>c.status==='complete'),budgetMode:enforceBudget?'bounded':'unlimited',requestByteCap:maxRequestBytes,budget:enforceBudget?budget:null}),close:async()=>{for(const c of active)c.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
