import path from 'node:path';
import {ROOT,writeJson,requireGate,utc} from '../lib/common.mjs';
import {runProcess} from '../lib/process.mjs';
const tags={node:'node:22.20.0-alpine',postgres:'postgres:14-alpine',mysql:'mysql:8.0',redis:'redis:7-alpine',rabbitmq:'rabbitmq:3.13-management-alpine'};
const images={};
for(const [name,tag]of Object.entries(tags)) {
  console.log(`Preparing ${tag} (builder-only tag resolution)`);
  const pull=await runProcess('docker',['pull',tag],{timeoutMs:300000,maxBytes:102400});requireGate(pull.exitCode===0,'BLOCKED',`Image preparation failed: ${tag}: ${pull.output.slice(-1000)}`);
  const inspect=await runProcess('docker',['image','inspect',tag,'--format','{{json .RepoDigests}}'],{timeoutMs:10000,maxBytes:10000});requireGate(inspect.exitCode===0,'BLOCKED','Image inspection failed');
  const digest=JSON.parse(inspect.output)[0];requireGate(/@sha256:[a-f0-9]{64}$/.test(digest),'SCHEMA_MISMATCH','No immutable image digest');images[name]={image:digest,sourceTag:tag};
  console.log(`Pinned ${name}: ${digest}`);
}
await writeJson(path.join(ROOT,'config','fixture-images.lock.json'),{schemaVersion:'1.0',preparedAt:utc(),architecture:'linux/amd64',images});
