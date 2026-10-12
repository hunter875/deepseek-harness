import {test} from 'node:test';
import assert from 'node:assert/strict';
import {providerGateway} from '../lib/provider-gateway.mjs';
const base={key:'fake-upstream-secret',model:'deepseek-flash',budget:{maxTokens:10000,maxCostUsd:1,maxCalls:1,maxSeconds:10},rates:{input:1,output:2}};
const body={model:'deepseek-flash',messages:[{role:'user',content:'fixture'}],max_tokens:10,stream:false};
const call=(g,b=body,token=g.token)=>fetch(`${g.url}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(b)});
test('provider holds real key, reserves cost and denies additional requests before billing',async t=> {
  let billed=0;
  const g=await providerGateway({...base,fetchImpl:async(url,options)=>{billed++;assert.equal(options.headers.authorization,'Bearer fake-upstream-secret');return new Response(JSON.stringify({model:'response-model',usage:{prompt_tokens:5,completion_tokens:2},choices:[]}));}});t.after(()=>g.close());
  assert.equal((await call(g,body,'invalid')).status,403);assert.equal(billed,0);
  assert.equal((await call(g)).status,200);assert.equal(g.report().usageComplete,true);assert.equal(g.report().calls[0].usage.input,5);
  assert.equal((await call(g)).status,429);assert.equal(billed,1);
});
test('unknown provider usage retains reservation and blocks further billable calls',async t=> {
  let billed=0;const g=await providerGateway({...base,budget:{...base.budget,maxCalls:3},fetchImpl:async()=>{billed++;return new Response(JSON.stringify({choices:[]}));}});t.after(()=>g.close());
  await (await call(g)).text();assert.equal(g.report().usageComplete,false);assert.ok(g.report().reservedCostUsd>0);
  assert.equal((await call(g)).status,429);assert.equal(billed,1);
});
test('unlimited mode does not freeze turns on totals or unknown usage',async t=> {
  let billed=0;const g=await providerGateway({...base,enforceBudget:false,budget:{maxTokens:1,maxCostUsd:0.000001,maxCalls:1,maxSeconds:0.001},fetchImpl:async()=>{billed++;return billed===1?new Response(JSON.stringify({choices:[]})):new Response(JSON.stringify({model:'response-model',usage:{prompt_tokens:5,completion_tokens:2},choices:[]}));}});t.after(()=>g.close());
  await (await call(g)).text();assert.equal(g.report().usageComplete,false);
  assert.equal((await call(g)).status,200);
  assert.equal(billed,2);assert.equal(g.report().budgetMode,'unlimited');assert.equal(g.report().budget,null);
});
test('unlimited mode accepts a request larger than one MiB under its expanded finite cap',async t=> {
  let billed=0;const largeBody={...body,messages:[{role:'user',content:'x'.repeat(1048576)}]};
  const g=await providerGateway({...base,enforceBudget:false,fetchImpl:async(url,options)=>{billed++;assert.ok(options.body.length>1048576);return new Response(JSON.stringify({model:'response-model',usage:{prompt_tokens:300000,completion_tokens:2},choices:[]}));}});t.after(()=>g.close());
  assert.equal((await call(g,largeBody)).status,200);assert.equal(billed,1);assert.equal(g.report().requestByteCap,33554432);
});
test('model mismatch and oversized token reservation cannot reach provider',async t=> {
  let billed=0;const g=await providerGateway({...base,budget:{...base.budget,maxTokens:10},fetchImpl:async()=>{billed++;throw Error('must not call');}});t.after(()=>g.close());
  assert.equal((await call(g,{...body,model:'other-model'})).status,502);
  assert.equal((await call(g)).status,429);assert.equal(billed,0);
});
