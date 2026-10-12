import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import {ROOT,writeJson,redact,utc,requireGate} from '../lib/common.mjs';
import {runProcess} from '../lib/process.mjs';
const project='edumatch-main',oldFolder='D:/EduMatch-main/EduMatch-main';let canaries=[];
try {canaries=Object.values(dotenv.parse(await fs.readFile(path.join(oldFolder,'.env')))).filter(v=>v.length>=8);}catch{}
const ps=await runProcess('docker',['ps','-a','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.service"}}'],{timeoutMs:10000,maxBytes:102400});requireGate(ps.exitCode===0,'SOURCE_UNAVAILABLE','Cannot inspect Docker project');
const containers=ps.output.trim().split('\n').filter(Boolean).map(l=>{const [ID,Names,service]=l.trim().split('|');return {ID,Names,service};});const status=[];
for(const container of containers) {
  const inspection=await runProcess('docker',['inspect',container.ID,'--format','{{.State.Status}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'],{timeoutMs:10000,maxBytes:20480});
  const [Status,ExitCode,health]=inspection.output.trim().split('|');const state={Status,ExitCode:Number(ExitCode),Health:{Status:health}};
  const record={id:container.ID,name:container.Names,service:container.service,state};status.push(record);
  if(['auth-service','matching-service','scholarship-service','chat-service','api-gateway','frontend'].includes(record.service)) {
    const logs=await runProcess('docker',['logs','--tail','100',container.ID],{timeoutMs:10000,maxBytes:20480,canaries});record.redactedLogs=redact(logs.output,canaries).value;
  }
}
await writeJson(path.join(ROOT,'artifacts/docker-status.json'),{project,observedAt:utc(),containers:status});console.log(JSON.stringify(status.map(({redactedLogs,...s})=>({...s,...(s.state.Status==='exited'?{redactedLogs}: {})})),null,2));
