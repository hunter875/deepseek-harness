import fs from 'node:fs/promises';
import path from 'node:path';
import { id, sha256, sign, authenticated, requireGate, writeJson, readJson, utc, Budget } from './common.mjs';
import { validate } from './schema.mjs';
import { capture, manifest, changedPaths, checkScope } from './snapshot.mjs';
const NEXT = { DISCOVER:['BASELINE','REPORT'], BASELINE:['PLAN','REPORT'], PLAN:['EDIT','VERIFY','REPORT'], EDIT:['VERIFY'], VERIFY:['REPAIR','REPORT'], REPAIR:['EDIT','REPORT'], REPORT:[] };
export class TaskRunner {
  constructor({ stateDir, key, registry, executor }) {
    this.stateDir = stateDir; this.key = key;
    this.registry = structuredClone(registry); this.registryHash = sha256(this.registry); this.executor = executor;
  }
  async freeze(task, workspace) {
    await validate('task', task);
    requireGate(task.state === 'FROZEN', 'NEEDS_DECISION', 'Contract remains DRAFT');
    requireGate(!task.unknowns.some(u => u.blocking), 'NEEDS_DECISION', 'Blocking business unknown');
    requireGate(new Set(task.acceptance.map(a => a.id)).size === task.acceptance.length, 'INVALID_ARGUMENT', 'Duplicate acceptance IDs');
    requireGate(!task.scope.allowedPaths.some(p => /[*?]|^\.?\/?$|\.\.|\\/.test(p)), 'POLICY_DENIED', 'Scope must use explicit files/directories');
    for (const a of task.acceptance) {
      requireGate(task.verifierIds.includes(a.verifierId) && this.registry.verifiers[a.verifierId], 'INVALID_ARGUMENT', 'Unknown verifier');
      requireGate(a.requirement !== 'not-applicable' || a.notApplicableReason?.length > 0, 'INVALID_ARGUMENT', 'N/A requires a frozen reason');
    }
    const initial = await manifest(workspace);
    requireGate(initial.digest === task.initialSnapshotDigest, 'SNAPSHOT_CHANGED', 'Initial snapshot mismatch');
    const folder = path.join(this.stateDir, task.taskId);
    await fs.mkdir(folder, { recursive: false });
    const frozen = { task: structuredClone(task), initial, registry: this.registry, registryHash: this.registryHash };
    await writeJson(path.join(folder, 'contract.json'), { frozen, signature: sign(frozen, this.key) });
    return { task: structuredClone(task), folder, initial, state:'DISCOVER', repairs:0, previousFailure:null, budget:new Budget(task.budget) };
  }
  transition(session, state, failureEvidence = null) {
    session.budget.use({calls:0});
    requireGate(NEXT[session.state].includes(state), 'INVALID_TRANSITION', `${session.state} -> ${state}`);
    if (state === 'REPAIR') {
      session.repairs++;
      requireGate(session.repairs <= session.task.budget.maxRepairs, 'BUDGET_EXCEEDED', 'Repair limit');
      requireGate(failureEvidence && failureEvidence !== session.previousFailure, 'NO_NEW_EVIDENCE', 'Repeated failure without new evidence');
      session.previousFailure = failureEvidence;
    }
    session.state = state;
  }
  async verify(session, workspace) {
    session.budget.use();
    requireGate(session.state === 'VERIFY', 'INVALID_TRANSITION', 'Runner is not in VERIFY');
    const saved = await readJson(path.join(session.folder, 'contract.json'));
    requireGate(authenticated(saved.frozen, saved.signature, this.key), 'ORACLE_CHANGED', 'Frozen authority failed authentication');
    requireGate(sha256(session.task) === sha256(saved.frozen.task) && sha256(this.registry) === saved.frozen.registryHash, 'ORACLE_CHANGED', 'Task/registry changed after freeze');
    const candidateDir = path.join(session.folder, id('snapshot'));
    const candidate = await capture(workspace, candidateDir);
    const changes = changedPaths(saved.frozen.initial, candidate);
    checkScope(changes, session.task.scope);
    const startedAt = utc(); const checks = [];
    for (const verifierId of session.task.verifierIds) {
      session.budget.use();
      const record = saved.frozen.registry.verifiers[verifierId];
      const execution = await this.executor(record, candidateDir, session.task);
      const artifactRef = id('check');
      await writeJson(path.join(session.folder, `${artifactRef}.json`), execution);
      checks.push({ verifierId, passed:execution.exitCode === 0 && !execution.timedOut && !execution.truncated && execution.ran > 0 && execution.fail === 0 && execution.skip === 0 && execution.pass === execution.ran && execution.ran === execution.discovered,
        discovered:execution.discovered,ran:execution.ran,pass:execution.pass,fail:execution.fail,skip:execution.skip,exitCode:execution.exitCode,signal:execution.signal,timedOut:execution.timedOut,artifactRef,artifactSha256:sha256(execution),runtime:execution.runtime,startedAt:execution.startedAt,finishedAt:execution.finishedAt });
    }
    requireGate((await manifest(candidateDir)).digest === candidate.digest, 'SNAPSHOT_CHANGED', 'Verifier mutated source inputs');
    const acceptance = session.task.acceptance.map(a => {
      const check = checks.find(c => c.verifierId === a.verifierId);
      return { id:a.id,status:a.requirement === 'not-applicable' ? 'not-applicable' : !check ? 'not-run' : check.passed ? 'passed' : 'failed',evidenceRef:check?.artifactRef ?? null,reason:a.notApplicableReason };
    });
    const required = session.task.acceptance.filter(a => a.requirement === 'required');
    const passed = required.length > 0 && required.every(a => acceptance.find(v => v.id === a.id).status === 'passed');
    requireGate(session.task.environment === 'fixture' || !passed || this.executor.liveAttested === true, 'POLICY_DENIED', 'A fixture executor cannot satisfy a live gate');
    const status = !passed ? 'FAILED' : session.task.kind === 'diagnostic' ? 'DIAGNOSED' : session.task.kind === 'review' ? 'REVIEWED' : session.task.environment === 'aws-staging' ? 'SUCCEEDED_STAGING' : 'SUCCEEDED_LOCAL';
    const result = {schemaVersion:'1.0',taskId:session.task.taskId,status,candidateSnapshotDigest:candidate.digest,baseRevision:session.task.baseRevision,patchHash:sha256(changes.map(p => ({path:p,hash:candidate.files.find(f=>f.path===p)?.sha256 ?? null}))),verifierManifestHash:saved.frozen.registryHash,startedAt,finishedAt:utc(),checks,acceptance,limitations:this.executor.isolationAttested ? [] : ['Fixture child process only; OS isolation and production profile gates have not passed.']};
    await validate('result', result);
    const receipt = { result, signature:sign(result,this.key) };
    await writeJson(path.join(session.folder, 'result.json'), receipt);
    return receipt;
  }
  async report(session, workspace) {
    const { result, signature } = await readJson(path.join(session.folder, 'result.json'));
    requireGate(authenticated(result, signature, this.key), 'UNTRUSTED_REPORT', 'Verdict signature invalid');
    requireGate((await manifest(workspace)).digest === result.candidateSnapshotDigest, 'STALE_VERDICT', 'Candidate changed after verification');
    return result;
  }
  async checkpoint(session, workspace) {
    const record={taskId:session.task.taskId,state:session.state,repairs:session.repairs,previousFailure:session.previousFailure,workspaceDigest:(await manifest(workspace)).digest,budget:{started:session.budget.started,calls:session.budget.calls,tokens:session.budget.tokens,cost:session.budget.cost},savedAt:utc()};
    await writeJson(path.join(session.folder,'checkpoint.json'),{record,signature:sign(record,this.key)});
    return record;
  }
  async resume(taskId,workspace) {
    requireGate(/^task-[a-zA-Z0-9-]+$/.test(taskId),'INVALID_ARGUMENT','Invalid task ID');
    const folder=path.join(this.stateDir,taskId),saved=await readJson(path.join(folder,'contract.json')),checkpoint=await readJson(path.join(folder,'checkpoint.json'));
    requireGate(authenticated(saved.frozen,saved.signature,this.key)&&authenticated(checkpoint.record,checkpoint.signature,this.key),'UNTRUSTED_REPORT','Checkpoint/contract authentication failed');
    requireGate(saved.frozen.task.taskId===taskId&&checkpoint.record.taskId===taskId,'TARGET_MISMATCH','Checkpoint task binding mismatch');
    requireGate(checkpoint.record.workspaceDigest===(await manifest(workspace)).digest&&saved.frozen.registryHash===sha256(this.registry),'SNAPSHOT_CHANGED','Resume context/authority mismatch');
    const budget=new Budget(saved.frozen.task.budget);Object.assign(budget,checkpoint.record.budget);budget.use({calls:0});
    return {task:saved.frozen.task,folder,initial:saved.frozen.initial,state:checkpoint.record.state,repairs:checkpoint.record.repairs,previousFailure:checkpoint.record.previousFailure,budget};
  }
}
