import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateRelease,reconcileRelease,APP_SERVICES,PLATFORM_SERVICES} from '../lib/release.mjs';
const accountId='123456789012';
const release=()=>({schemaVersion:'1.0',environment:'aws-staging',accountId,region:'ap-southeast-1',releaseId:'a'.repeat(40)+'-1',sourceRevision:'a'.repeat(40),configVersion:'b'.repeat(64),migrationDigest:'c'.repeat(64),expectedPreviousRelease:null,images:Object.fromEntries([...APP_SERVICES,...PLATFORM_SERVICES].map(s=>[s,`${APP_SERVICES.includes(s)?`${accountId}.dkr.ecr.ap-southeast-1.amazonaws.com/edumatch-staging/${s}`:s}@sha256:${'d'.repeat(64)}`]))});
test('release binding rejects mutable tag, wrong account and missing service',()=>{
  const m=release();assert.equal(validateRelease(m,{accountId}).releaseId,m.releaseId);m.images.frontend='frontend:latest';assert.throws(()=>validateRelease(m,{accountId}));
  assert.throws(()=>validateRelease(release(),{accountId:'999999999999'}));const missing=release();delete missing.images.redis;assert.throws(()=>validateRelease(missing,{accountId}));
});
test('rollback blocks changed migration and deploy checks previous release',()=>{
  const m=release(),old=release();old.releaseId='e'.repeat(40)+'-1';assert.throws(()=>validateRelease(m,{accountId,previous:old}));old.migrationDigest='f'.repeat(64);assert.throws(()=>validateRelease(m,{accountId,previous:old,operation:'rollback'}),e=>e.code==='NEEDS_DECISION');
});
test('ECR presence, partial rollout and internal smoke cannot claim staging success',()=>{
  const m=release();const observed=Object.fromEntries(APP_SERVICES.map(s=>[s,{image:m.images[s],sourceRevision:m.sourceRevision,ready:true}]));
  assert.throws(()=>reconcileRelease(m,observed,{external:false,passed:true,releaseId:m.releaseId}));observed.frontend.sourceRevision='wrong';assert.throws(()=>reconcileRelease(m,observed,{external:true,passed:true,releaseId:m.releaseId}));observed.frontend.sourceRevision=m.sourceRevision;assert.equal(reconcileRelease(m,observed,{external:true,passed:true,releaseId:m.releaseId}).status,'SUCCEEDED_STAGING');
});
