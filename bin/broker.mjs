import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Broker } from '../lib/broker.mjs';
import { fixtureAdapter } from '../lib/fixture.mjs';
import { liveAdapter } from '../lib/adapters.mjs';
import { loadConfig, ROOT, readJson, requireGate, authenticated, writeJson } from '../lib/common.mjs';
const config=await loadConfig();const policy=await readJson(path.resolve(ROOT,config.EDUMATCH_POLICY_FILE));
const targets=await readJson(path.resolve(ROOT,config.EDUMATCH_TARGETS_FILE));const queries=await readJson(path.join(ROOT,'config','queries.json'));
const stateDir=path.resolve(ROOT,config.EDUMATCH_STATE_DIR,'broker');const fixture=config.EDUMATCH_ENVIRONMENT==='fixture';
let attested=false;
if(!fixture) {
  requireGate(config.OBSERVERS_LIVE_ENABLED==='true'&&config.EDUMATCH_ISOLATION_ATTESTATION,'POLICY_DENIED','Live observer disabled or no attestation');
  const proof=await readJson(config.EDUMATCH_ISOLATION_ATTESTATION);
  const key=await fs.readFile(path.join(ROOT,'.state','authority.key'));
  requireGate(authenticated(proof.result,proof.signature,key)&&proof.result.hostPlatform===process.platform&&proof.result.expiresAt>Date.now()&&policy.requiredIsolationProbes.every(id=>proof.result.probes.some(p=>p.id===id&&p.passed)),'POLICY_DENIED','Isolation attestation is invalid');
  attested=true;
}
const broker=new Broker({policy,targets,queries,targetRef:config.EDUMATCH_TARGET,environment:config.EDUMATCH_ENVIRONMENT,adapter:fixture?fixtureAdapter():liveAdapter(config,{isolationAttested:attested}),stateDir});
const token=config.EDUMATCH_BROKER_TOKEN|| (fixture?randomBytes(32).toString('hex'):null);
requireGate(token&&token.length>=32,'POLICY_DENIED','Set a broker token with at least 32 characters');
if(fixture)await writeJson(path.join(ROOT,'.state','broker-client.json'),{token,port:Number(config.EDUMATCH_BROKER_PORT),environment:'fixture'});
const equal=(a,b)=>{const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);};
let active=false;
const server=http.createServer(async(req,res)=> {
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  if(req.method!=='POST'||req.url!=='/call'||!equal(req.headers.authorization??'',`Bearer ${token}`)||req.headers.origin) {res.writeHead(403);res.end('{"error":"POLICY_DENIED"}');return;}
  if(active){res.writeHead(429);res.end('{"error":"RATE_LIMITED"}');return;}
  active=true;
  try {let body='',bytes=0;for await(const chunk of req){bytes+=chunk.length;requireGate(bytes<=16384,'INVALID_ARGUMENT','Request cap');body+=chunk.toString('utf8');}
    const request=JSON.parse(body);requireGate(Object.keys(request).sort().join()==='args,tool','INVALID_ARGUMENT','Request schema');
    const result=await broker.call(request.tool,request.args);res.end(JSON.stringify(result));
  } catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.code??'INVALID_ARGUMENT'}));}
  finally{active=false;}
});
server.requestTimeout=10000;server.headersTimeout=10000;
server.listen(Number(config.EDUMATCH_BROKER_PORT),'127.0.0.1',()=>console.log(`Broker ${config.EDUMATCH_ENVIRONMENT} bound to 127.0.0.1:${config.EDUMATCH_BROKER_PORT}`));
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close(()=>process.exit(0)));
