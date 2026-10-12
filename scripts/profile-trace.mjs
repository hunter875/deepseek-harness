/**
 * Trace the user profile page as a browser sees it.
 *
 * Records every request the page makes with its status, plus console output, so
 * a failing feature can be attributed to a specific call rather than guessed at.
 */
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'https://edumatch.staging.local';
const OUT = process.argv[2] ?? path.join(process.cwd(), 'artifacts', 'profile-trace.json');
const TARGET = process.argv[3] ?? '/user/profile';
const USER = 'student1';
const PASS = 'admin123';

const executablePath = (() => {
  if (process.env.DSH_CHROMIUM_PATH) return process.env.DSH_CHROMIUM_PATH;
  const root = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  for (const c of [
    path.join(root, 'chromium-1223', 'chrome-win64', 'chrome.exe'),
    path.join(root, 'chromium_headless_shell-1223', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
  ]) if (existsSync(c)) return c;
  return undefined;
})();

const evidence = {target: TARGET, requests: [], consoleErrors: [], consoleAll: [], pageErrors: []};
const browser = await chromium.launch({
  headless: true, executablePath,
  args: ['--host-resolver-rules=MAP edumatch.staging.local 127.0.0.1', '--no-sandbox']
});
const context = await browser.newContext({ignoreHTTPSErrors: true, baseURL: BASE});
const page = await context.newPage();

page.on('response', r => {
  const u = r.url();
  if (u.includes('edumatch.staging.local')) {
    evidence.requests.push({method: r.request().method(), path: u.replace(BASE, ''), status: r.status()});
  }
});
page.on('console', m => {
  const entry = `${m.type()}: ${m.text().slice(0, 300)}`;
  if (m.type() === 'error') evidence.consoleErrors.push(entry);
  evidence.consoleAll.push(entry);
});
page.on('pageerror', e => evidence.pageErrors.push(String(e.message).slice(0, 300)));

try {
  // Sign in first so the pages render as an authenticated user.
  await page.goto('/', {waitUntil: 'domcontentloaded', timeout: 30000});
  await page.evaluate(async ({USER, PASS}) => {
    await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: USER, password: PASS})
    });
  }, {USER, PASS});

  // Establish the in-memory token the app's own bootstrap would set, then load
  // the target page the same way a user click would.
  await page.reload({waitUntil: 'networkidle', timeout: 30000});
  await page.waitForTimeout(1500);

  evidence.requests.length = 0;
  const response = await page.goto(TARGET, {waitUntil: 'networkidle', timeout: 40000});
  await page.waitForTimeout(2500);

  evidence.pageStatus = response?.status();
  evidence.finalUrl = page.url();
  evidence.bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 1200);
  evidence.hasErrorBoundary = await page.evaluate(() =>
    /something went wrong|application error|unhandled|failed to load/i.test(document.body.innerText));

} catch (error) {
  evidence.fatal = String(error.message).slice(0, 300);
} finally {
  await browser.close();
  await fs.mkdir(path.dirname(OUT), {recursive: true});
  await fs.writeFile(OUT, JSON.stringify(evidence, null, 2));

  console.log(`TARGET ${TARGET} -> HTTP ${evidence.pageStatus ?? 'n/a'}`);
  console.log(`final url: ${evidence.finalUrl ?? 'n/a'}`);
  console.log('\n--- requests ---');
  for (const r of evidence.requests) console.log(`${r.status}  ${r.method} ${r.path}`);
  console.log('\n--- console errors ---');
  for (const c of evidence.consoleErrors.slice(0, 15)) console.log(c);
  console.log('\n--- page errors ---');
  for (const e of evidence.pageErrors.slice(0, 10)) console.log(e);
  console.log('\n--- visible text (first 600) ---');
  console.log((evidence.bodyText ?? '').slice(0, 600));
}
