import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,readJson,writeJson,sha256,id,utc,requireGate} from '../lib/common.mjs';
import {classify,metrics,assertTrajectory} from '../lib/claims.mjs';
const dataset=await readJson(path.join(ROOT,'fixtures/eval/cases.json'));
const oracle=await readJson(path.join(ROOT,'fixtures/oracles/eval.json'));
const casesHash=sha256(dataset),oracleHash=sha256(oracle),configurationHash=sha256(await fs.readFile(path.join(ROOT,'lib/claims.mjs')));
const live=process.argv.includes('--model');
if(live)throw new Error('Live model eval requires a prepared isolated task runner and DeepSeek credentials. Fixture eval cannot substitute for this gate. See eval-plan.json.');
const rows=[];
for(const split of ['development','holdout'])for(const task of dataset.cases.filter(c=>c.split===split))for(let repeat=0;repeat<3;repeat++) {
  const order=repeat%2?['candidate','baseline']:['baseline','candidate'];
  for(const configuration of order) {
    const startedAt=utc(),input={...dataset.defaults,...task.input};
    // Safe synthetic baseline intentionally illustrates missing publication gates, never runs unsafe live actions.
    const baseline=input.kind==='diagnostic'?'DIAGNOSED':input.kind==='review'?'REVIEWED':'SUCCEEDED_LOCAL';
    const agentStatus=configuration==='baseline'?baseline:classify(input);
    const trajectory={trajectoryId:id('trajectory'),taskId:task.id,split,group:task.group,repeat,configuration,source:'fixture-policy',model:null,snapshotDigest:casesHash,configHash:configurationHash,oracleHash,budget:{maxSeconds:1,maxCostUsd:0},startedAt,finishedAt:utc(),agentStatus,verifierStatus:oracle.expected[task.id],apiCostUsd:0,toolCostUsd:0,unsafeAttempts:input.unsafeAttempt?1:0,executedViolations:0,requiresUnknown:Boolean(input.blockingUnknown),infrastructureFailure:false};
    assertTrajectory(trajectory);rows.push(trajectory);
  }
}
requireGate(sha256(await readJson(path.join(ROOT,'fixtures/oracles/eval.json')))===oracleHash,'ORACLE_CHANGED','Eval oracle changed during run');
const summary=Object.fromEntries(['baseline','candidate'].map(config=>[config,{all:metrics(rows.filter(r=>r.configuration===config)),development:metrics(rows.filter(r=>r.configuration===config&&r.split==='development')),holdout:metrics(rows.filter(r=>r.configuration===config&&r.split==='holdout'))}]));
await writeJson(path.join(ROOT,'artifacts/eval-policy.json'),{schemaVersion:'1.0',measuredAt:utc(),source:'fixture-policy',taskCount:12,repetitionsPerTask:3,trajectoryCount:rows.length,casesHash,oracleHash,configurationHash,summary,rows,limitations:['Deterministic policy regression, not an agent/model accuracy benchmark','Synthetic frontend/event/auth states, not EduMatch integration results','Three repeats of deterministic checks do not estimate stochastic model reliability','No model selection or accuracy improvement claim is supported by this run']});
console.log(`Synthetic policy eval: ${rows.length} paired trajectories; candidate correct ${summary.candidate.all.correctOutcome}/${summary.candidate.all.denominator}; false completion ${summary.candidate.all.falseCompletion.numerator}`);
