import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const id = prefix => `${prefix}-${randomUUID()}`;
export const utc = () => new Date().toISOString();
export class GateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requireGate(condition, code, message) { if (!condition) throw new GateError(code, message); }
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function loadConfig(file = path.join(ROOT, '.env')) {
  const parsed = dotenv.parse(await fs.readFile(file));
  // File is explicit and centralized; only relevant environment names override it.
  for (const key of Object.keys(parsed)) if (process.env[key] !== undefined) parsed[key] = process.env[key];
  return parsed;
}
export function inside(root, relative) {
  requireGate(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !path.isAbsolute(relative), 'POLICY_DENIED', 'Expected a relative POSIX path');
  const resolved = path.resolve(root, relative);
  requireGate(resolved.startsWith(`${path.resolve(root)}${path.sep}`), 'POLICY_DENIED', 'Path escapes workspace');
  return resolved;
}
export async function safePath(root, relative) {
  const resolved = inside(root, relative);
  const parts = path.relative(root, resolved).split(path.sep);
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    requireGate(!stat.isSymbolicLink(), 'POLICY_DENIED', 'Symlink/reparse traversal is not allowed');
  }
  const real = await fs.realpath(resolved);
  requireGate(real.startsWith(`${await fs.realpath(root)}${path.sep}`), 'POLICY_DENIED', 'Resolved path escapes workspace');
  return resolved;
}
export function sign(value, key) { return createHmac('sha256', key).update(canonical(value)).digest('hex'); }
export function authenticated(value, signature, key) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(sign(value, key), 'hex');
  const actual = Buffer.from(signature ?? '', 'hex');
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}
const sensitiveKeys = /password|secret|token|cookie|authorization|private.?key|connection.?string|email|phone|payload|last_error/i;
export function redact(value, canaries = []) {
  const fields = [];
  function clean(v, p) {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((item, n) => clean(item, `${p}[${n}]`));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => {
      if (sensitiveKeys.test(k)) { fields.push(`${p}.${k}`); return [k, '[REDACTED]']; }
      return [k, clean(item, `${p}.${k}`)];
    }));
    if (typeof v === 'string') {
      let text = v.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
        .replace(/((?:password|secret|token|api[_ -]?key)\s*[:=]\s*)[^\s"',]+/gi, '$1[REDACTED]')
        .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]');
      for (const canary of canaries.filter(Boolean)) text = text.split(canary).join('[REDACTED]');
      if (text !== v) fields.push(p);
      return text;
    }
    return v;
  }
  return { value: clean(value, '$'), redactedFields: [...new Set(fields)] };
}
export class Budget {
  constructor(limits) { this.limits = limits; this.started = Date.now(); this.calls = 0; this.tokens = 0; this.cost = 0; }
  use({ calls = 1, tokens = 0, cost = 0 } = {}) {
    this.calls += calls; this.tokens += tokens; this.cost += cost;
    requireGate(Date.now() - this.started <= this.limits.maxSeconds * 1000 && this.calls <= this.limits.maxToolCalls && this.tokens <= this.limits.maxTokens && this.cost <= this.limits.maxCostUsd, 'BUDGET_EXCEEDED', 'Task budget exhausted');
  }
}
