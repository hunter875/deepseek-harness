import { spawn } from 'node:child_process';
import { requireGate, utc, redact } from './common.mjs';
const ENV_KEYS = ['SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT'];
export function cleanEnv(extra = {}) {
  return { ...Object.fromEntries(ENV_KEYS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])), ...extra };
}
export async function runProcess(executable, argv, { cwd, timeoutMs = 10000, maxBytes = 102400, env = {}, signal, canaries = [], captureJson = false } = {}) {
  requireGate(Array.isArray(argv) && argv.every(a => typeof a === 'string'), 'INVALID_ARGUMENT', 'argv must be strings');
  const startedAt = utc();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env: cleanEnv(env), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
    let chunks = [], bytes = 0, truncated = false, timedOut = false;
    const kill = () => {
      if (process.platform === 'win32') { child.kill('SIGKILL'); spawn('taskkill.exe', ['/PID',String(child.pid),'/T','/F'], { windowsHide: true, stdio: 'ignore' }); }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const cancel = () => kill();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) kill();
    function collect(data) {
      const remain = maxBytes - bytes;
      if (remain > 0) { chunks.push(data.subarray(0, remain)); bytes += Math.min(data.length, remain); }
      if (data.length > remain) { truncated = true; kill(); }
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(error); });
    child.once('close', (exitCode, childSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      // Redact after reassembling byte chunks, before truncating any published text.
      let raw=Buffer.concat(chunks).toString('utf8'),parsedJson;
      // Only trusted source adapters request structured capture. They keep it private,
      // select fields and redact through the broker before publishing any evidence.
      if(captureJson&&!truncated){try{parsedJson=JSON.parse(raw);}catch{}}
      if(truncated)for(const canary of canaries.filter(Boolean))for(let n=Math.min(canary.length-1,raw.length);n>0;n--)if(raw.endsWith(canary.slice(0,n))){raw=raw.slice(0,-n)+'[REDACTED]';break;}
      const output = redact(raw, canaries).value;
      resolve({ exitCode, signal: childSignal, timedOut, truncated, cancelled: Boolean(signal?.aborted), output, startedAt, finishedAt: utc(),...(captureJson?{parsedJson}: {}) });
    });
  });
}
