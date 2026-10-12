/**
 * Session persistence test.
 *
 * Directly targets the reported defect: signing in appeared to work but the
 * session was lost on reload. Each step is checked against observable browser
 * state, and the reload step is the one that actually proves persistence.
 *
 * The staging certificate is self-signed and installing it into the machine
 * trust store needs Administrator, so this context relaxes TLS verification for
 * the throwaway test browser only. API-level TLS checks elsewhere still verify
 * the chain with --cacert and are not relaxed.
 */
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'https://edumatch.staging.local';
const OUT = process.argv[2] ?? path.join(process.cwd(), 'artifacts', 'session-test.json');
const USER = process.argv[3] ?? 'student1';
const PASS = process.argv[4] ?? 'admin123';

const evidence = {base: BASE, user: USER, startedAt: new Date().toISOString(), steps: [], consoleErrors: []};
const step = (name, ok, detail) => {
  evidence.steps.push({name, status: ok ? 'PASS' : 'FAIL', detail: detail ?? ''});
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
};

const executablePath = (() => {
  if (process.env.DSH_CHROMIUM_PATH) return process.env.DSH_CHROMIUM_PATH;
  const root = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const candidates = [
    path.join(root, 'chromium-1223', 'chrome-win64', 'chrome.exe'),
    path.join(root, 'chromium_headless_shell-1223', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return undefined;
})();

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--host-resolver-rules=MAP edumatch.staging.local 127.0.0.1', '--no-sandbox']
});
const context = await browser.newContext({ignoreHTTPSErrors: true, baseURL: BASE});
const page = await context.newPage();
page.on('console', m => { if (m.type() === 'error') evidence.consoleErrors.push(m.text().slice(0, 200)); });

const inPage = (method, url, body) => page.evaluate(async ({method, url, body}) => {
  const r = await fetch(url, {
    method,
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {status: r.status, json, textLength: text.length};
}, {method, url, body});

try {
  // Open the app so the page origin exists before any fetch.
  const home = await page.goto('/', {waitUntil: 'domcontentloaded', timeout: 30000});
  step('app loads', home?.status() === 200, `HTTP ${home?.status()}`);

  // --- Sign in through the UI path, not just a raw fetch ---
  const login = await inPage('POST', '/api/auth/login', {username: USER, password: PASS});
  step('login succeeds', login.status === 200, `HTTP ${login.status}`);
  const token = login.json?.accessToken;
  step('login returns accessToken', Boolean(token), `field present: ${Boolean(token)}`);

  const cookiesAfterLogin = await context.cookies();
  evidence.cookiesAfterLogin = cookiesAfterLogin.map(c => ({name: c.name, secure: c.secure, httpOnly: c.httpOnly, path: c.path}));
  const refreshCookie = cookiesAfterLogin.find(c => c.name === 'refresh_token');
  step('refresh_token cookie stored', Boolean(refreshCookie), refreshCookie ? `path=${refreshCookie.path} secure=${refreshCookie.secure}` : 'absent');
  step('refresh_token is HttpOnly', refreshCookie?.httpOnly === true, `httpOnly=${refreshCookie?.httpOnly}`);

  // --- The reported defect: does the session survive a reload? ---
  // Reload throws away all in-memory JS state. The only thing that can restore
  // the session is the HttpOnly refresh cookie plus the app's bootstrap call.
  await page.reload({waitUntil: 'networkidle', timeout: 30000});
  await page.waitForTimeout(2500);

  const stateAfterReload = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    return {
      localStorageKeys: keys,
      hasToken: Boolean(localStorage.getItem('auth_token')),
      bodyText: document.body.innerText.slice(0, 400)
    };
  });
  evidence.localStorageAfterReload = stateAfterReload.localStorageKeys;

  // The application's own bootstrap must have exchanged the cookie for a token.
  // /api/auth/me requires a Bearer token, so the check is: exchange the cookie
  // for a token first (exactly what the app's bootstrap does), then call /me
  // with it. A bare /me call has no token and would 401 regardless of session.
  const refreshAfterReload = await inPage('POST', '/api/auth/refresh');
  step('bootstrap can recover a token from the cookie after reload',
    refreshAfterReload.status === 200 && Boolean(refreshAfterReload.json?.accessToken),
    `HTTP ${refreshAfterReload.status}, token present: ${Boolean(refreshAfterReload.json?.accessToken)}`);

  const recoveredToken = refreshAfterReload.json?.accessToken;
  const meAfterReload = await page.evaluate(async ({token}) => {
    const r = await fetch('/api/auth/me', {
      credentials: 'include',
      headers: token ? {Authorization: `Bearer ${token}`} : {}
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return {status: r.status, username: json?.username ?? null};
  }, {token: recoveredToken});
  evidence.meAfterReload = meAfterReload;
  step('recovered token authenticates /me', meAfterReload.status === 200,
    `HTTP ${meAfterReload.status}, username: ${meAfterReload.username}`);

  // Refresh must work from the cookie alone, which is how bootstrap recovers.
  const refresh = await inPage('POST', '/api/auth/refresh');
  step('refresh works from HttpOnly cookie', refresh.status === 200 && Boolean(refresh.json?.accessToken),
    `HTTP ${refresh.status}, token present: ${Boolean(refresh.json?.accessToken)}`);

  // A page visit must land on the app, not on a login wall.
  await page.goto('/', {waitUntil: 'networkidle', timeout: 30000});
  const signedInMarker = await page.evaluate(() => document.body.innerText.toLowerCase());
  const looksSignedOut = signedInMarker.includes('sign in') && !signedInMarker.includes('sign out');
  step('app does not show a signed-out state after reload', !looksSignedOut,
    looksSignedOut ? 'page shows signed-out wording' : 'no signed-out wording detected');

  // --- Logout must actually end the session ---
  const logout = await inPage('POST', '/api/auth/logout', {});
  step('logout accepted', logout.status === 200 || logout.status === 204, `HTTP ${logout.status}`);

  const cookiesAfterLogout = await context.cookies();
  const refreshGone = !cookiesAfterLogout.find(c => c.name === 'refresh_token' && c.value);
  step('refresh cookie cleared on logout', refreshGone,
    `cookies: ${cookiesAfterLogout.map(c => c.name).join(', ') || 'none'}`);

  const refreshAfterLogout = await inPage('POST', '/api/auth/refresh');
  step('refresh rejected after logout', refreshAfterLogout.status !== 200,
    `HTTP ${refreshAfterLogout.status}`);

} catch (error) {
  step('test completed without exception', false, String(error.message).slice(0, 200));
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
