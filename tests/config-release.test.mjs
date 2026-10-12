import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {ROOT,loadConfig,readJson,writeJson,sha256} from '../lib/common.mjs';
import {APP_SERVICES,PLATFORM_SERVICES} from '../lib/release.mjs';
import {runProcess} from '../lib/process.mjs';
test('generated release binds external health to release, RSA and hidden data ports',async t=> {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'edumatch-config-'));t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
  const config=await loadConfig(),repo=path.resolve(ROOT,config.EDUMATCH_REPO),revision='a'.repeat(40),accountId='111111111111';
  const images=Object.fromEntries([...APP_SERVICES,...PLATFORM_SERVICES].map(s=>[s,(APP_SERVICES.includes(s)?`${accountId}.dkr.ecr.ap-southeast-1.amazonaws.com/edumatch-staging/${s}`:`fixture/${s}`)+'@sha256:'+'b'.repeat(64)]));
  const release={schemaVersion:'1.0',environment:'aws-staging',accountId,region:'ap-southeast-1',releaseId:revision+'-1',sourceRevision:revision,images,configVersion:null,migrationDigest:'c'.repeat(64),tlsDomain:'staging.example.invalid',expectedPreviousRelease:null};
  const input=path.join(temporary,'input.json'),output=path.join(temporary,release.releaseId);await writeJson(input,release);
  const run=await runProcess(process.execPath,[path.join(ROOT,'scripts/prepare-release.mjs'),repo,input,output],{timeoutMs:20000});assert.equal(run.exitCode,0,run.output);
  const manifest=await readJson(path.join(output,'manifest.json')),composeText=await fs.readFile(path.join(output,'compose.yml'),'utf8'),nginx=await fs.readFile(path.join(output,'nginx.conf'),'utf8'),compose=YAML.parse(composeText);
  assert.equal(manifest.configVersion,sha256({compose:composeText,nginx}));assert.ok(nginx.includes(`"releaseId":"${release.releaseId}"`));assert.ok(nginx.includes(`"sourceRevision":"${revision}"`));assert.ok(!nginx.includes('add_header Access-Control-Allow-Origin $http_origin'));
  for(const [name,service]of Object.entries(compose.services)){assert.ok(!service.build);assert.ok(!service.container_name);assert.deepEqual(service.ports??[],name==='api-gateway'?['443:443']:[]);}
  assert.equal(compose.services['matching-service'].environment.JWT_ALGORITHM,'RS256');assert.equal(compose.services['matching-service'].environment.JWT_REQUIRE_RSA,'true');
  // app.jwt.secret now defaults to empty in the audited properties and is only
  // read on the HS256 fallback path, which fails closed under require-rsa. No
  // shared secret may be injected, in any form.
  for(const name of ['auth-service','scholarship-service','chat-service','matching-service','matching-consumer']){
    const env=compose.services[name].environment;
    assert.ok(!('APP_JWT_SECRET' in env),`${name} must not carry a shared APP_JWT_SECRET`);
    assert.ok(!String(env.JWT_SECRET??'').includes('FALLBACK'),`${name} must not reference a fallback secret`);
  }
  assert.equal(compose.services['auth-service'].environment.APP_AUTH_COOKIE_SECURE,'true');assert.equal(nginx.includes('\r'),false);
  // An unmatched /api/ path must answer with the JSON envelope, not fall through
  // to the frontend's HTML error page. The catch-all has to stay ahead of
  // location / and behind the service prefixes.
  const apiCatchAll=nginx.indexOf('location /api/ {'),frontendCatchAll=nginx.indexOf('location / {');
  assert.ok(apiCatchAll>0,'release nginx must carry the /api/ catch-all');
  assert.ok(frontendCatchAll>apiCatchAll,'the /api/ catch-all must precede location /');
  assert.match(nginx.slice(apiCatchAll,frontendCatchAll),/return 404 '\{[^']*"code":"NOT_FOUND"/);
  for(const prefix of ['location /api/v1/chat {','location /api/scholarships {']){
    assert.ok(nginx.indexOf(prefix)<apiCatchAll,`${prefix} must stay ahead of the /api/ catch-all`);
  }
  // Service-to-service identity: both ends read the same runtime values.
  for(const name of ['auth-service','chat-service']){
    const env=compose.services[name].environment;
    assert.match(env.APP_SERVICE_AUTH_ENABLED,/^\$\{APP_SERVICE_AUTH_ENABLED:\?/);
    assert.match(env.APP_SERVICE_AUTH_CLIENT_ID,/^\$\{APP_SERVICE_AUTH_CLIENT_ID:\?/);
    assert.match(env.APP_SERVICE_AUTH_CLIENT_SECRET,/^\$\{APP_SERVICE_AUTH_CLIENT_SECRET:\?/);
  }
  // RSA material is mounted as files and the Java consumers need the file:
  // scheme, or Spring resolves the path as a classpath resource and fails.
  for(const name of ['auth-service','scholarship-service','chat-service','matching-service','matching-consumer']){
    const env=compose.services[name].environment,vols=compose.services[name].volumes??[];
    assert.ok(vols.includes('/opt/edumatch/secrets/jwt-public.pem:/run/secrets/jwt-public.pem:ro'),`${name} missing public key mount`);
    assert.ok(String(env.APP_JWT_RSA_PUBLIC_KEY_PATH??'').startsWith('file:'),`${name} public key path needs file: scheme`);
  }
  assert.ok(compose.services['auth-service'].volumes.includes('/opt/edumatch/secrets/jwt-private.pem:/run/secrets/jwt-private.pem:ro'));
  // The audited Compose is a local stack; no "-test" hostname may survive.
  for(const [name,service]of Object.entries(compose.services))for(const [key,value]of Object.entries(service.environment??{})){
    assert.ok(!String(value).includes('-test'),`${name}.${key} still references a local-only host`);
  }
});
