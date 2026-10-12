import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,loadConfig,requireGate,writeJson,sha256,utc} from '../lib/common.mjs';
const cfg=await loadConfig(),repo=path.resolve(ROOT,cfg.EDUMATCH_REPO),output=path.join(repo,'ops/dsh');
requireGate(repo.startsWith(ROOT+path.sep),'POLICY_DENIED','Integration must stay inside this workspace');
const directories=['lib','bin','scripts','config','schemas','workflows','fixtures','sandbox','cloud','infra','tests'];
const excluded=new Set(['.terraform','__pycache__']);
await fs.mkdir(output,{recursive:true});const files=[];
async function copy(relative) {
  const source=path.join(ROOT,relative),stat=await fs.lstat(source);requireGate(!stat.isSymbolicLink(),'POLICY_DENIED','Integration source must not be a link');
  if(stat.isDirectory()){for(const item of await fs.readdir(source))if(!excluded.has(item))await copy(path.join(relative,item));return;}
  if(/\.tfstate|\.tfplan|terraform\.tfvars\.json$|\.pyc$/.test(relative))return;
  const dest=path.join(output,relative);await fs.mkdir(path.dirname(dest),{recursive:true});const data=await fs.readFile(source);await fs.writeFile(dest,data);files.push({path:relative.replaceAll('\\','/'),sha256:sha256(data)});
}
for(const dir of directories)await copy(dir);
for(const file of ['package.json','package-lock.json','.gitignore','.env.example','README.md','compatibility.lock.json','project-map.json','eval-plan.json'])await copy(file);
const template=path.join(output,'.env.example');let content=await fs.readFile(template,'utf8');content=content.replace(/^EDUMATCH_REPO=.*$/m,'EDUMATCH_REPO=../..');await fs.writeFile(template,content);
const workflow=path.join(repo,'.github/workflows/aws-staging.yml');await fs.mkdir(path.dirname(workflow),{recursive:true});await fs.copyFile(path.join(ROOT,'cloud/aws-staging.yml'),workflow);
await writeJson(path.join(ROOT,'artifacts/integration.json'),{integratedAt:utc(),repository:repo,destination:output,files,workflow:'.github/workflows/aws-staging.yml',cloudTriggered:false,credentialsCopied:false});
console.log('Integrated ops/dsh and AWS workflow into EduMatch; no remote push or workflow run.');
