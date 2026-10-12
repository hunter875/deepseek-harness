import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {ROOT,readJson,writeJson,requireGate,sign,sha256,id,utc} from '../lib/common.mjs';
import {runProcess} from '../lib/process.mjs';
const lock=await readJson(path.join(ROOT,'config/fixture-images.lock.json'));const image=lock.images.node.image;
const authority=path.join(ROOT,'.state','authority.key');await fs.mkdir(path.dirname(authority),{recursive:true});
let key;try{key=await fs.readFile(authority);}catch(error){requireGate(error.code==='ENOENT','BLOCKED','Authority unavailable');key=randomBytes(32);await fs.writeFile(authority,key,{mode:0o600,flag:'wx'});}
const canary=path.join(ROOT,'.state','isolation-canary');await fs.writeFile(canary,'fake-host-canary-for-boundary-probes');
const container=id('isolation'),probe=path.join(ROOT,'sandbox','isolation-probe.mjs');
const policyArgs=['--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--cpus','2','--memory','256m','--tmpfs','/tmp:rw,nosuid,noexec,size=16m'];
let workload,inspection;
try {
  const create=await runProcess('docker',['create','--name',container,...policyArgs,'--mount',`type=bind,source=${probe},target=/probe.mjs,readonly`,image,'node','/probe.mjs'],{timeoutMs:10000,maxBytes:10240});requireGate(create.exitCode===0,'BLOCKED','Container creation failed');
  const inspect=await runProcess('docker',['inspect',container],{timeoutMs:10000,maxBytes:102400});requireGate(inspect.exitCode===0,'BLOCKED','Container inspection failed');inspection=JSON.parse(inspect.output)[0];
  workload=await runProcess('docker',['start','--attach',container],{timeoutMs:10000,maxBytes:102400,env:{DEEPSEEK_API_KEY:'fake-env-canary',AWS_SECRET_ACCESS_KEY:'fake-aws-canary'}});
  requireGate(workload.exitCode===0&&!workload.truncated&&!workload.timedOut,'BLOCKED','Probe workload failed');
} finally {await runProcess('docker',['rm','-f',container],{timeoutMs:10000,maxBytes:1024});}
const observation=JSON.parse(workload.output),config=inspection.HostConfig;
requireGate(config.NetworkMode==='none'&&config.ReadonlyRootfs&&config.Privileged===false&&inspection.Config.User==='10001:10001'&&config.CapDrop.includes('ALL')&&config.SecurityOpt.includes('no-new-privileges'),'POLICY_DENIED','Observed container policy mismatch');
requireGate(inspection.Mounts.length===1&&inspection.Mounts[0].Destination==='/probe.mjs'&&inspection.Mounts[0].RW===false,'POLICY_DENIED','Unexpected mount');
const probes=[['host-home-denied',observation.files.find(f=>f.file==='/host-home-canary').denied&&observation.credentialStoresDenied],['broker-canary-denied',observation.files.find(f=>f.file==='/broker/canary').denied],['oracle-denied',observation.files.find(f=>f.file==='/authority/oracle').denied],['docker-socket-denied',!observation.dockerSocketPresent],['metadata-denied',observation.metadataDenied],['windows-interop-denied',observation.files.find(f=>f.file.includes('/mnt/c/')).denied],['child-env-clean',observation.canaryEnv.length===0]] .map(([id,passed])=>({id,passed}));
const result={schemaVersion:'1.0',hostPlatform:process.platform,verifiedAt:utc(),expiresAt:Date.now()+86400000,image,policyArgsHash:sha256(policyArgs),probes,observation,limitations:['Canary/container mount probes cover this configured execution path only','Same-host arbitrary shell is not attested; profile must expose only bound MCP tools','Docker admin remains a trusted operator, never a workload capability']};
await writeJson(path.join(ROOT,'artifacts/isolation.json'),{result,signature:sign(result,key)});
requireGate(probes.every(p=>p.passed),'POLICY_DENIED','Isolation probe failed');console.log(`Observed container isolation probes: ${probes.length}/${probes.length} PASS`);
