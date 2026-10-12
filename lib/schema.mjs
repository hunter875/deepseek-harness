import Ajv from 'ajv';
import formats from 'ajv-formats';
import { readJson, ROOT, requireGate } from './common.mjs';
import path from 'node:path';
const ajv = new Ajv({ allErrors: true, strict: true });
formats(ajv);
const validators = new Map();
export async function validate(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile(await readJson(path.join(ROOT, 'schemas', `${name}.json`))));
  const fn = validators.get(name);
  requireGate(fn(value), 'SCHEMA_MISMATCH', ajv.errorsText(fn.errors));
  return value;
}
