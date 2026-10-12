import fs from 'node:fs/promises';
import path from 'node:path';
import { requireGate, sha256, safePath, writeJson } from './common.mjs';
// Frozen by the controller, not derived from candidate .gitignore.
export const EXCLUDED = ['.git','node_modules','.next','target','__pycache__','.pytest_cache','.venv','.state'];
export async function manifest(root) {
  const files = [];
  async function walk(relative = '') {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (EXCLUDED.includes(entry.name)) continue;
      requireGate(!entry.isSymbolicLink(), 'POLICY_DENIED', 'Snapshot rejects symlinks');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      requireGate(!/^\.env($|\.)/.test(entry.name) || entry.name === '.env.example', 'POLICY_DENIED', 'Secret env file is not a source input');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const content = await fs.readFile(await safePath(root, name));
        files.push({ path: name, sha256: sha256(content), bytes: content.length });
      } else throw new Error('Unsupported filesystem object');
    }
  }
  await walk();
  return { digest: sha256(files), files };
}
export async function capture(root, destination) {
  requireGate(!path.resolve(destination).startsWith(`${path.resolve(root)}${path.sep}`), 'POLICY_DENIED', 'Snapshot destination must be outside workspace');
  const before = await manifest(root);
  await fs.mkdir(destination, { recursive: false });
  for (const file of before.files) {
    const target = path.join(destination, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(await safePath(root, file.path), target);
  }
  const after = await manifest(destination);
  requireGate(before.digest === after.digest && (await manifest(root)).digest === before.digest, 'SNAPSHOT_CHANGED', 'Source changed during snapshot');
  return after;
}
export function changedPaths(initial, candidate) {
  const before = new Map(initial.files.map(f => [f.path, f.sha256]));
  const after = new Map(candidate.files.map(f => [f.path, f.sha256]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort();
}
export function checkScope(paths, scope) {
  for (const p of paths) {
    requireGate(scope.allowedPaths.some(allowed => p === allowed || (allowed.endsWith('/') && p.startsWith(allowed))), 'SCOPE_VIOLATION', `Out of scope: ${p}`);
    requireGate(!scope.forbiddenChanges.some(f => p === f || p.startsWith(`${f}/`)), 'SCOPE_VIOLATION', `Frozen path changed: ${p}`);
  }
}
