import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,writeJson,sha256,utc,requireGate} from '../lib/common.mjs';
import {runProcess} from '../lib/process.mjs';
const testFiles=(await fs.readdir(path.join(ROOT,'tests'))).filter(f=>f.endsWith('.test.mjs')).sort();
const sources={};
for(const dir of ['lib','bin','schemas','tests'])for(const file of (await fs.readdir(path.join(ROOT,dir))).sort()) {
  const relative=`${dir}/${file}`;if((await fs.stat(path.join(ROOT,relative))).isFile())sources[relative]=sha256(await fs.readFile(path.join(ROOT,relative)));
}
const run=await runProcess(process.execPath,['--test','--test-reporter=tap',...testFiles.map(f=>`tests/${f}`)],{cwd:ROOT,timeoutMs:120000,maxBytes:102400});
const count=name=>Number(run.output.match(new RegExp(`^# ${name} (\\d+)$`,'m'))?.[1]??0);
const report={source:'local-controller-extension-tests',verifiedAt:utc(),sourceDigest:sha256(sources),sourceHashes:sources,counts:{tests:count('tests'),pass:count('pass'),fail:count('fail'),skip:count('skipped'),cancelled:count('cancelled')},passed:run.exitCode===0&&!run.timedOut&&!run.truncated&&count('tests')>0&&count('pass')===count('tests')&&count('skipped')===0,run};
await writeJson(path.join(ROOT,'artifacts/tests.json'),report);console.log(JSON.stringify({passed:report.passed,counts:report.counts},null,2));requireGate(report.passed,'TEST_FAILED','Controller checks failed; inspect artifacts/tests.json');
