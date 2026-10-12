/**
 * Sweep every user-facing page and every API route the app depends on.
 *
 * The goal is coverage, not confirmation: each page is loaded as a signed-in
 * user and every request the page makes is recorded with its status, so a
 * failing feature can be attributed to a specific call. Pages that redirect to
 * login, return 5xx, or call an endpoint that answers 404/500 are reported.
 */
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'https://edumatch.staging.local';
const OUT = process.argv[2] ?? path.join(process.cwd(), 'artifacts', 'sweep.json');

const PAGES = [
  '/', '/user/dashboard', '/user/profile', '/user/scholarships', '/user/applications',
  '/user/settings', '/messages', '/scholarships', '/about', '/contact',
  '/employer/dashboard', '/admin/dashboard'
];

const ACCOUNTS = {
  user: {username: 'student1', password: 'admin123'},
  employer: {username: 'mit_provider', password: 'admin123'},
  admin: {username: 'admin_test', password: 'admin123'}
};

const executablePath = (() => {
  if (process.env.DSH_CHROMIUM_PATH) return process.env.DSH_CHROMIUM_PATH;
  const root = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  for (const c of [
    path.join(root, 'chromium-1223', 'chrome-win64', 'chrome.exe'),
    path.join(root, 'chromium_headless_shell-1223', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
  ]) if (existsSync(c)) return c;
  return undefined;
})();

const browser = await chromium.launch({
  headless: true, executablePath,
  args: ['--host-resolver-rules=MAP edumatch.staging.local 127.0.0.1', '--no-sandbox']
});

const report = {base: BASE, startedAt: new Date().toISOString(), pages: [], api: [], findings: []};

async function session(role) {
  const context = await browser.newContext({ignoreHTTPSErrors: true, baseURL: BASE});
  const page = await context.newPage();
  const requests = [];
  page.on('response', r => {
    const u = r.url();
    if (u.includes('edumatch.staging.local') && u.includes('/api/')) {
      requests.push({method: r.request().method(), path: u.replace(BASE, ''), status: r.status()});
    }
  });
  await page.goto('/', {waitUntil: 'domcontentloaded', timeout: 30000});
  await page.evaluate(async ({u, p}) => {
    await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: u, password: p})
    });
  }, {u: ACCOUNTS[role].username, p: ACCOUNTS[role].password});
  await page.reload({waitUntil: 'domcontentloaded', timeout: 30000});
  await page.waitForTimeout(2500);
  return {context, page, requests};
}

try {
  for (const role of ['user', 'employer', 'admin']) {
    const {context, page, requests} = await session(role);
    for (const target of PAGES) {
      requests.length = 0;
      let status = null;
      try {
        const response = await page.goto(target, {waitUntil: 'domcontentloaded', timeout: 35000});
        status = response?.status() ?? null;
      } catch (error) {
        report.pages.push({role, target, status: 'ERROR', detail: String(error.message).slice(0, 120)});
        continue;
      }
      await page.waitForTimeout(2500);
      const finalPath = page.url().replace(BASE, '');
      const text = (await page.evaluate(() => document.body.innerText)).slice(0, 300);
      const apiCalls = requests.map(r => `${r.method} ${r.path} -> ${r.status}`);
      const bad = requests.filter(r => r.status >= 400);

      const entry = {
        role, target, status, finalPath,
        redirectedToLogin: finalPath.includes('/auth/login'),
        empty: text.trim().length < 40,
        textHead: text.replace(/\s+/g, ' ').slice(0, 120),
        apiCalls, badCalls: bad.map(r => `${r.method} ${r.path} -> ${r.status}`)
      };
      report.pages.push(entry);

      const flags = [];
      if (entry.redirectedToLogin && target !== '/') flags.push('REDIRECTED_TO_LOGIN');
      if (status !== null && status >= 500) flags.push(`HTTP_${status}`);
      if (entry.empty) flags.push('EMPTY_PAGE');
      for (const b of entry.badCalls) flags.push(b);
      if (flags.length) report.findings.push({role, target, flags});
    }
    await context.close();
  }
} catch (error) {
  report.fatal = String(error.message).slice(0, 200);
} finally {
  report.finishedAt = new Date().toISOString();
  await browser.close();
  await fs.mkdir(path.dirname(OUT), {recursive: true});
  await fs.writeFile(OUT, JSON.stringify(report, null, 2));

  console.log('=== PAGE SWEEP ===');
  for (const p of report.pages) {
    const mark = p.redirectedToLogin || (typeof p.status === 'number' && p.status >= 500) || p.empty ? 'FAIL' : 'ok  ';
    console.log(`${mark} ${p.role.padEnd(9)} ${String(p.status).padEnd(5)} ${p.target.padEnd(24)} -> ${p.finalPath}${p.empty ? ' [EMPTY]' : ''}`);
  }
  console.log('\n=== FAILING API CALLS ===');
  const bad = report.pages.flatMap(p => p.badCalls.map(c => `${p.role.padEnd(9)} ${p.target.padEnd(20)} ${c}`));
  const unique = [...new Set(bad.map(b => b.split(' ').slice(-3).join(' ')))];
  for (const u of unique) console.log(`  ${u}`);
  if (!unique.length) console.log('  (none)');
  console.log(`\nfindings: ${report.findings.length}`);
}
