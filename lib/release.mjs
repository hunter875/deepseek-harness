import {requireGate,sha256} from './common.mjs';
export const APP_SERVICES=['auth-service','scholarship-service','chat-service','matching-service','frontend','api-gateway'];
export const PLATFORM_SERVICES=['auth-db','scholarship-db','chat-db','matching-db','redis','rabbitmq'];
export function validateRelease(manifest,{accountId,region='ap-southeast-1',previous=null,operation='deploy'}={}) {
  requireGate(manifest.schemaVersion==='1.0'&&manifest.environment==='aws-staging'&&manifest.region===region&&manifest.accountId===accountId,'TARGET_MISMATCH','Release target mismatch');
  requireGate(/^[a-f0-9]{40}-[0-9]+$/.test(manifest.releaseId)&&/^[a-f0-9]{40}$/.test(manifest.sourceRevision)&&/^[a-f0-9]{64}$/.test(manifest.configVersion)&&/^[a-f0-9]{64}$/.test(manifest.migrationDigest),'INVALID_ARGUMENT','Invalid release identity');
  requireGate(Object.keys(manifest.images).sort().join()===[...APP_SERVICES,...PLATFORM_SERVICES].sort().join(),'INVALID_ARGUMENT','All application and platform images must be pinned');
  for(const [service,image]of Object.entries(manifest.images)) {
    requireGate(typeof image==='string'&&/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image),'INVALID_ARGUMENT',`Image digest missing: ${service}`);
    if(APP_SERVICES.includes(service))requireGate(image.startsWith(`${accountId}.dkr.ecr.${region}.amazonaws.com/edumatch-staging/${service}@`),'TARGET_MISMATCH','App image is outside the bound ECR repository');
  }
  if(previous) {
    requireGate(manifest.expectedPreviousRelease===previous.releaseId||operation==='rollback','STALE_RELEASE','Current release changed after preparation');
    if(operation==='rollback')requireGate(manifest.migrationDigest===previous.migrationDigest,'NEEDS_DECISION','Code rollback is incompatible with current migration set; data restore requires a separate approved plan');
  } else requireGate(!manifest.expectedPreviousRelease,'STALE_RELEASE','Expected previous release does not exist');
  return manifest;
}
export function reconcileRelease(manifest,observed,smoke) {
  const missing=APP_SERVICES.filter(service=>!observed[service]||observed[service].image!==manifest.images[service]||observed[service].sourceRevision!==manifest.sourceRevision||!observed[service].ready);
  requireGate(missing.length===0&&smoke.external===true&&smoke.passed===true&&smoke.releaseId===manifest.releaseId,'PARTIAL_ROLLOUT','Desired images, observed revision and external smoke must agree');
  return {releaseId:manifest.releaseId,status:'SUCCEEDED_STAGING',codeRollbackOnly:true};
}
