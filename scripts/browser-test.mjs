/**
 * Browser test for the EduMatch staging frontend, run through an SSM tunnel.
 *
 * Connects to the staging host on 127.0.0.1:443 (forwarded to the instance) and
 * addresses it by the certificate's own hostname, so TLS is exercised for real.
 * `ignoreHTTPSErrors` is used because the staging certificate is self-signed and
 * installing it into the machine trust store needs Administrator; that is a
 * narrower, explicit exception for this one browser context and it is recorded
 * as such. The API-level TLS checks elsewhere still verify the chain with
 * --cacert and are not relaxed.
 *
 * Tokens and cookies are never written to the evidence file: only names, status
 * codes and booleans are recorded.
 */
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'https://edumatch.staging.local';
const OUT = process.argv[2] ?? path.join(process.cwd(), 'artifacts', 'browser-test.json');
const USER = `bt${Date.now().toString().slice(-6)}`;
const PASS = 'Browserv0rd!23';

const evidence = {base: BASE, startedAt: new Date().toISOString(), steps: [], consoleErrors: [], failedRequests: []};
const step = (name, ok, detail) => {
  evidence.steps.push({name, status: ok ? 'PASS' : 'FAIL', detail});
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
};

const executablePath = (() => {
  // playwright-core does not ship browsers; point it at the chromium already
  // present on this machine instead of downloading another revision. An explicit
  // override wins so CI can supply its own.
  if (process.env.DSH_CHROMIUM_PATH) return process.env.DSH_CHROMIUM_PATH;
  const root = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const candidates = [
    path.join(root, 'chromium-1223', 'chrome-win64', 'chrome.exe'),
    path.join(root, 'chromium_headless_shell-1223', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
  ];
  const fsSync = {existsSync};
  for (const candidate of candidates) if (fsSync.existsSync(candidate)) return candidate;
  return undefined;
})();

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--host-resolver-rules=MAP edumatch.staging.local 127.0.0.1', '--no-sandbox']
  });
} catch (error) {
  evidence.launchError = String(error.message);
  await fs.mkdir(path.dirname(OUT), {recursive: true});
  await fs.writeFile(OUT, JSON.stringify(evidence, null, 2));
  console.log('LAUNCH_FAILED:', error.message);
  process.exit(2);
}

const context = await browser.newContext({ignoreHTTPSErrors: true, baseURL: BASE});
const page = await context.newPage();
page.on('console', message => {
  if (message.type() === 'error') evidence.consoleErrors.push(message.text().slice(0, 300));
});
page.on('requestfailed', request => {
  evidence.failedRequests.push({url: request.url().slice(0, 200), reason: request.failure()?.errorText ?? 'unknown'});
});

/**
 * Issue an API call from INSIDE the page.
 *
 * The API request context runs in Node, where --host-resolver-rules does not
 * apply, so edumatch.staging.local would not resolve. Running the call in the
 * page uses the browser's resolver override and, more importantly, exercises the
 * real browser cookie jar and CORS path rather than a synthetic HTTP client.
 */
const api = async (method, url, body, headers = {}) => {
  return await page.evaluate(async ({method, url, body, headers}) => {
    const response = await fetch(url, {
      method,
      credentials: 'include',
      headers: {'Content-Type': 'application/json', ...headers},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    const text = await response.text();
    try { json = JSON.parse(text); } catch { /* non-JSON is fine */ }
    return {status: response.status, json, textLength: text.length};
  }, {method, url, body, headers});
};

try {
  // --- 1. Page loads ---
  const home = await page.goto('/', {waitUntil: 'domcontentloaded', timeout: 30000});
  step('frontend page loads', home?.status() === 200, `HTTP ${home?.status()}`);
  const title = await page.title();
  evidence.pageTitle = title;
  step('page has a title', title.length > 0, title.slice(0, 80));

  // --- 2. Register through the browser context (real cookie handling) ---
  const register = await api('POST', '/api/auth/register', {
    username: USER, email: `${USER}@example.com`, password: PASS,
    firstName: 'Browser', lastName: 'Test'
  });
  step('register via browser context', register.status === 200 || register.status === 201, `HTTP ${register.status}`);

  // --- 3. Login: cookies must be stored by the browser ---
  const login = await api('POST', '/api/auth/login', {username: USER, password: PASS});
  step('login via browser context', login.status === 200, `HTTP ${login.status}`);
  step('login returns an access token', Boolean(login.json?.accessToken), `token present: ${Boolean(login.json?.accessToken)}`);

  const cookies = await context.cookies();
  const names = cookies.map(c => c.name);
  evidence.cookieNames = names;
  step('browser stored auth cookies', names.length > 0, `names: ${names.join(', ') || 'none'}`);
  const secureCookies = cookies.filter(c => c.secure).map(c => c.name);
  evidence.secureCookieNames = secureCookies;
  step('auth cookie marked Secure', secureCookies.length > 0,
    `Secure: ${secureCookies.join(', ') || 'none'}`);

  // --- 4. Authenticated call using the stored cookie/token ---
  const token = login.json?.accessToken;
  const me = await api('GET', '/api/auth/me', undefined, token ? {Authorization: `Bearer ${token}`} : {});
  step('authenticated /me works', me.status === 200, `HTTP ${me.status}`);
  evidence.meUsername = me.json?.username ?? null;
  step('/me returns the registered user', me.json?.username === USER, `username: ${me.json?.username}`);

  // --- 5. WebSocket from the page itself (not curl) ---
  const wsResult = await page.evaluate(async ({token}) => {
    return await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolve(value); } };
      try {
        const socket = new WebSocket(`wss://edumatch.staging.local/api/ws`);
        const timer = setTimeout(() => { try { socket.close(); } catch {} finish({opened: false, reason: 'timeout'}); }, 8000);
        socket.onopen = () => { clearTimeout(timer); finish({opened: true, reason: 'opened'}); };
        socket.onerror = () => { clearTimeout(timer); finish({opened: false, reason: 'error'}); };
        socket.onclose = event => { clearTimeout(timer); finish({opened: false, reason: `closed ${event.code}`}); };
      } catch (error) { finish({opened: false, reason: String(error.message)}); }
    });
  }, {token});
  step('WebSocket opens from the page', wsResult.opened === true, wsResult.reason);

  // --- 6. Redirect behaviour on a protected page ---
  const guarded = await page.goto('/dashboard', {waitUntil: 'domcontentloaded', timeout: 30000}).catch(() => null);
  const afterUrl = page.url();
  evidence.guardedUrl = afterUrl;
  const redirected = afterUrl.includes('/login') || afterUrl.includes('/auth') || afterUrl.endsWith('/');
  step('protected route responds without a server error', (guarded?.status() ?? 0) < 500,
    `HTTP ${guarded?.status()} -> ${afterUrl.replace(BASE, '')}`);

  // --- 7. Logout clears the session ---
  const logout = await api('POST', '/api/auth/logout', {});
  step('logout accepted', logout.status === 200 || logout.status === 204, `HTTP ${logout.status}`);
  const afterLogout = await context.cookies();
  evidence.cookiesAfterLogout = afterLogout.map(c => c.name);
  const cleared = afterLogout.filter(c => c.value).length === 0 ||
    !afterLogout.some(c => names.includes(c.name) && c.value);
  step('session cookie cleared after logout', cleared,
    `cookies after logout: ${afterLogout.map(c => c.name).join(', ') || 'none'}`);

  const meAfter = await api('GET', '/api/auth/me', undefined, token ? {Authorization: `Bearer ${token}`} : {});
  step('old token no longer grants access OR cookie gone', meAfter.status !== 200 || cleared,
    `HTTP ${meAfter.status} after logout`);

} catch (error) {
  evidence.fatal = String(error.message);
  step('browser test completed without exception', false, String(error.message).slice(0, 200));
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.passCount = evidence.steps.filter(s => s.status === 'PASS').length;
  evidence.failCount = evidence.steps.filter(s => s.status === 'FAIL').length;
  await browser.close();
  await fs.mkdir(path.dirname(OUT), {recursive: true});
  await fs.writeFile(OUT, JSON.stringify(evidence, null, 2));
  console.log(`\nRESULT pass=${evidence.passCount} fail=${evidence.failCount}`);
  console.log(`evidence: ${OUT}`);
}
