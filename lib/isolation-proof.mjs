import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,readJson,requireGate,authenticated} from './common.mjs';
export async function requireIsolation(image,file=path.join(ROOT,'artifacts/isolation.json')) {
  const proof=await readJson(file),policy=await readJson(path.join(ROOT,'config/policy.json')),key=await fs.readFile(path.join(ROOT,'.state/authority.key'));
  requireGate(authenticated(proof.result,proof.signature,key)&&proof.result.image===image&&proof.result.hostPlatform===process.platform&&proof.result.expiresAt>Date.now(),'POLICY_DENIED','Isolation attestation missing, expired or mismatched');
  requireGate(policy.requiredIsolationProbes.every(id=>proof.result.probes.some(p=>p.id===id&&p.passed)),'POLICY_DENIED','Required isolation probes have not passed');
  return proof.result;
}
