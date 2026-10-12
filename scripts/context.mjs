import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,readJson,writeJson,requireGate,sha256,utc} from '../lib/common.mjs';
export async function taskContext(task,output) {
  const map=await readJson(path.join(ROOT,'project-map.json')),registry=await readJson(path.join(ROOT,'config/commands.json'));
  if(task.baseRevision)requireGate(task.baseRevision===map.revision&&task.baseRevision===registry.revision,'REVISION_MISMATCH','Project context does not match frozen source revision');
  const services=map.services.filter(s=>task.scope.services.includes(s.id));
  const context={schemaVersion:'1.0',taskId:task.taskId,baseRevision:task.baseRevision,initialSnapshotDigest:task.initialSnapshotDigest,createdAt:utc(),goal:task.goal,acceptance:task.acceptance,scope:task.scope,contracts:task.contracts,unknowns:task.unknowns,assumptions:task.assumptions,services:services.map(s=>({id:s.id,path:s.path,entrypoints:s.entrypoints,contracts:s.contracts,tests:s.tests,commandIds:s.commandIds})),commands:task.commandIds.map(id=>{requireGate(registry.commands[id],'INVALID_ARGUMENT','Unknown context command');return registry.commands[id];}),authority:'Frozen task defines intent; implementation map does not invent expected behavior',references:task.kind==='code'?['workflows/code-change/SKILL.md']:task.kind==='diagnostic'?['workflows/diagnose/SKILL.md','workflows/references/events-cache.md']:['workflows/review/SKILL.md']};
  context.sourceHashes={projectMap:sha256(map),commandRegistry:sha256(registry),task:sha256(task)};await writeJson(output,context);return context;
}
if(process.argv[1]===path.join(ROOT,'scripts/context.mjs')) {const [taskFile,output]=process.argv.slice(2);requireGate(taskFile&&output,'INVALID_ARGUMENT','Usage: context <task.json> <output.json>');await taskContext(await readJson(taskFile),output);}
