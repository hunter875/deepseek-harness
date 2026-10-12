import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {ROOT,readJson} from '../lib/common.mjs';
import {classify,metrics} from '../lib/claims.mjs';
test('independent synthetic policy oracle covers twelve representative outcomes',async()=>{
  const dataset=await readJson(path.join(ROOT,'fixtures/eval/cases.json')),oracle=await readJson(path.join(ROOT,'fixtures/oracles/eval.json'));
  assert.equal(dataset.cases.filter(c=>c.split==='development').length,8);assert.equal(dataset.cases.filter(c=>c.split==='holdout').length,4);
  for(const c of dataset.cases)assert.equal(classify({...dataset.defaults,...c.input}),oracle.expected[c.id],c.id);
});
test('metrics preserve denominators, false claims, infra failures and undefined cost per success',()=>{
  const rows=[{agentStatus:'SUCCEEDED_LOCAL',verifierStatus:'FAILED',apiCostUsd:1,toolCostUsd:0,unsafeAttempts:1,executedViolations:0},{agentStatus:'FAILED',verifierStatus:'FAILED',apiCostUsd:2,toolCostUsd:0,unsafeAttempts:0,executedViolations:0},{infrastructureFailure:true}];
  const m=metrics(rows);assert.equal(m.denominator,2);assert.equal(m.falseCompletion.numerator,1);assert.equal(m.totalCostUsd,3);assert.equal(m.costPerVerifiedTask,null);assert.equal(m.infrastructureFailures,1);
});
