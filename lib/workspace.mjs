import fs from 'node:fs/promises';
import { safePath, inside, requireGate, sha256, Budget } from './common.mjs';
import { checkScope, manifest } from './snapshot.mjs';
export class Workspace {
  constructor(root,task) {this.root=root;this.task=structuredClone(task);this.budget=new Budget(task.budget);}
  async read(relative) {
    this.budget.use();checkScope([relative],this.task.scope);
    const file=await safePath(this.root,relative);const bytes=await fs.readFile(file);
    requireGate(bytes.length<=102400,'POLICY_DENIED','Read byte cap exceeded');
    return {path:relative,content:bytes.toString('utf8'),sha256:sha256(bytes)};
  }
  async write(relative,content,expectedHash) {
    this.budget.use();requireGate(this.task.allowedCapabilities.includes('edit-code'),'POLICY_DENIED','No edit capability');checkScope([relative],this.task.scope);
    requireGate(Buffer.byteLength(content)<=102400,'POLICY_DENIED','Write byte cap exceeded');
    const file=await safePath(this.root,relative);const before=await fs.readFile(file);
    requireGate(sha256(before)===expectedHash,'SNAPSHOT_CHANGED','Concurrent edit detected');
    await fs.writeFile(file,content);return {path:relative,sha256:sha256(content)};
  }
  async search(needle) {
    this.budget.use();requireGate(typeof needle==='string'&&needle.length>0&&needle.length<=100,'INVALID_ARGUMENT','Bounded literal search only');
    const found=[];let scannedBytes=0,truncated=false;
    for(const file of (await manifest(this.root)).files) {
      try {checkScope([file.path],this.task.scope);}catch(error){continue;}
      if(scannedBytes+file.bytes>10485760){truncated=true;break;}scannedBytes+=file.bytes;
      const lines=(await fs.readFile(await safePath(this.root,file.path),'utf8')).split('\n');
      for(let i=0;i<lines.length;i++)if(lines[i].includes(needle)){if(found.length>=100){truncated=true;break;}found.push({path:file.path,line:i+1,text:lines[i].slice(0,500)});}
      if(truncated)break;
    }
    return {matches:found,truncated,scannedBytes};
  }
}
