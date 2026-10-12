import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, requireGate, ROOT, id } from './common.mjs';
import { runProcess } from './process.mjs';
import { safePath } from './common.mjs';
export function nodeProbeExecutor({mode='fixture-process',image=null,canaries=[],isolationAttested=false}={}) {
  requireGate(mode==='fixture-process'||mode==='docker','POLICY_DENIED','Unknown execution mode');
  const executor=async(record,candidate,task)=> {
    requireGate(record.kind==='node-probe'&&Array.isArray(record.probes)&&record.probes.length>0,'INVALID_ARGUMENT','Frozen node probe required');
    requireGate(mode==='docker'||task.environment==='fixture','POLICY_DENIED','Host process mode is fixture-only');
    await safePath(candidate,record.module);
    const observations=[];let last;
    for(const probe of record.probes) {
      const bridge=path.join(ROOT,'sandbox','probe.mjs');
      if(mode==='docker') {
        requireGate(/@sha256:[a-f0-9]{64}$/.test(image??''),'POLICY_DENIED','Sandbox image must be digest-pinned');
        const container=id('verify');
        try {
          last=await runProcess('docker',['run','--name',container,'--rm','--pull','never','--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--cpus','2','--memory','2g','--tmpfs','/tmp:rw,nosuid,noexec,size=128m','--mount',`type=bind,source=${candidate},target=/candidate,readonly`,'--mount',`type=bind,source=${bridge},target=/runner/probe.mjs,readonly`,image,'node','/runner/probe.mjs',`/candidate/${record.module}`,record.export,canonical(probe.input)],{timeoutMs:record.timeoutMs,maxBytes:102400,canaries});
        } finally {await runProcess('docker',['rm','-f',container],{timeoutMs:10000,maxBytes:1024});}
      } else last=await runProcess(process.execPath,[bridge,path.join(candidate,record.module),record.export,canonical(probe.input)],{timeoutMs:record.timeoutMs,maxBytes:102400,canaries,env:{NODE_OPTIONS:'',NODE_PATH:''}});
      let value;try{value=JSON.parse(last.output);}catch(error){value={invalidOutput:true};}
      observations.push({input:probe.input,actual:value,passed:last.exitCode===0&&!last.timedOut&&!last.truncated&&canonical(value)===canonical(probe.expected)});
    }
    const pass=observations.filter(o=>o.passed).length;
    return {...last,discovered:record.probes.length,ran:observations.length,pass,fail:observations.length-pass,skip:0,observations,runtime:mode==='docker'?image:`node ${process.version} fixture-process`,output:last.output};
  };
  executor.isolationAttested=isolationAttested&&mode==='docker';
  executor.liveAttested=false;
  return executor;
}
