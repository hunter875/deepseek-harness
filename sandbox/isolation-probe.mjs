import fs from 'node:fs/promises';
import net from 'node:net';
const prohibited=['/broker/canary','/authority/oracle','/var/run/docker.sock','/mnt/c/Windows/System32/cmd.exe','/host-home-canary'];
const files=await Promise.all(prohibited.map(async file=>{try{await fs.readFile(file);return {file,denied:false};}catch(error){return {file,denied:['ENOENT','EACCES','ENOTDIR'].includes(error.code)};}}));
const canaryEnv=['DEEPSEEK_API_KEY','AWS_SECRET_ACCESS_KEY','BROKER_PRIVATE_KEY','VERIFIER_ORACLE'].filter(k=>process.env[k]);
const metadataDenied=await new Promise(resolve=>{const socket=net.connect({host:'169.254.169.254',port:80});const timer=setTimeout(()=>{socket.destroy();resolve(true);},1000);socket.on('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});socket.on('error',()=>{clearTimeout(timer);resolve(true);});});
const credentialStores=await Promise.all(['/root/.aws/credentials','/root/.ssh/id_rsa','/root/.docker/config.json'].map(async file=>{try{await fs.readFile(file);return false;}catch(error){return true;}}));
console.log(JSON.stringify({files,canaryEnv,metadataDenied,credentialStoresDenied:credentialStores.every(Boolean),uid:process.getuid(),dockerSocketPresent:await fs.stat('/var/run/docker.sock').then(()=>true).catch(()=>false)}));
