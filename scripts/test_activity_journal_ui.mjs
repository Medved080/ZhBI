// Browser regression on a temporary copy of the real database. No production writes.
// node scripts/test_activity_journal_ui.mjs
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const work = mkdtempSync(join(tmpdir(), 'zhbi-journal-ui-'));
const base = 'http://127.0.0.1:8159';
const server = spawn('.venv312/bin/python', ['scripts/real_auth_server.py', 'data/zhbi.anon.db', '8159', work], {
  env: {...process.env, ZHBI_CALC_DIR: join(work, 'calc'), ZHBI_CALC_RECOVERY_WORKER: '0'}, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', b => { serverLog += b; }); server.stderr.on('data', b => { serverLog += b; });
let browser, page;
const checks = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); };
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { ready = (await fetch(base + '/health')).ok; } catch {}
    if (ready) break;
    if (server.exitCode != null) throw Error(serverLog);
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ready, serverLog);
  const seed = spawnSync('.venv312/bin/python', ['-c', `import sqlite3,json,sys
from datetime import datetime,timedelta
c=sqlite3.connect(sys.argv[1])
c.execute("INSERT INTO users(last_name,first_name,domain_login,role,password_hash,password_salt) SELECT 'Проверка','Журнала','qa_journal_viewer','view',password_hash,password_salt FROM users WHERE domain_login='admin'")
for i in range(110):
 d={'путь':'/calc/api/products/qa','метод':'GET','код':500,'подсистема':'calc','уровень':'ERROR','сообщение':'Проверка журнала: отсутствует ставка бетона <script>bad()</script>','трассировка':'Traceback (most recent call last):\\n  File "calculation.py", line 42\\nValueError: отсутствует ставка бетона','тип ошибки':'ValueError'}
 c.execute('INSERT INTO activity_log(at,source,user_id,user_name,action,category,entity_type,duration_ms,request_id,details) VALUES(?,?,?,?,?,?,?,?,?,?)',((datetime.utcnow()-timedelta(seconds=i)).strftime('%Y-%m-%d %H:%M:%S.000'),'server',1,'Тестовый администратор','server_error','error','request',123.4,f'journal-qa-{i}',json.dumps(d,ensure_ascii=False)))
c.commit();c.close()`, join(work, 'work.db')], {encoding:'utf8'});
  assert.equal(seed.status, 0, seed.stderr);
  browser = await chromium.launch({headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  page = await browser.newPage({viewport: {width:1440, height:1000}});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const login = await page.request.post(base + '/login', {data:{domain_login:'admin', password:'Test-Pass-1234!'}});
  assert.equal(login.status(), 200);
  await page.goto(base + '/v2#/activity');
  await page.locator('#aj-results tbody tr').first().waitFor();
  check('Dedicated journal is mounted in real V2 shell', await page.locator('#aj-form').count() === 1);
  const calcCount = (await (await page.request.get(base + '/activity?subsystem=calc')).json()).total;
  await page.locator('[data-preset="calc"]').click();
  await page.waitForFunction(n => document.querySelector('#aj-status').textContent === 'Найдено событий: ' + n, String(calcCount));
  check('Calculator filter returns only calculator events', calcCount >= 110);
  await page.locator('input[name="text"]').fill('journal-qa-');
  await page.locator('#aj-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#aj-status').textContent === 'Найдено событий: 110');
  check('100 rows shown, next page available', await page.locator('#aj-results tbody tr').count() === 100 && await page.locator('#aj-next').isEnabled());
  await page.locator('#aj-next').click();
  await page.waitForFunction(() => document.querySelector('#aj-page').textContent.startsWith('101'));
  check('Pagination returns remaining 10 rows', await page.locator('#aj-results tbody tr').count() === 10);
  await page.locator('#aj-prev').click();
  await page.waitForFunction(() => document.querySelector('#aj-page').textContent.startsWith('1–'));
  await page.locator('#aj-results summary').first().click();
  check('Traceback is readable', (await page.locator('#aj-results pre').first().innerText()).includes('ValueError'));
  check('Event text is escaped', await page.locator('#aj-results script').count() === 0);
  await page.locator('[data-related]').first().click();
  await page.waitForFunction(() => document.querySelector('#aj-status').textContent === 'Найдено событий: 1');
  check('Related events are filtered by request ID', await page.locator('#aj-results tbody tr').count() === 1);
  await page.locator('#aj-reset').click();
  await page.waitForFunction(() => document.querySelector('#aj-results').getAttribute('aria-busy') === 'false');
  await page.locator('input[name="text"]').fill('journal-qa-');
  await page.locator('input[name="status"]').fill('500');
  await page.locator('input[name="path"]').fill('/calc/api/products/qa');
  await page.locator('#aj-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#aj-status').textContent === 'Найдено событий: 110');
  check('Combined field filters use server results', true);
  await page.locator('#aj-form > details > summary').click();
  await page.locator('input[name="detail_key"]').fill('сообщение');
  await page.locator('input[name="detail_value"]').fill('не существующий текст');
  await page.locator('#aj-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#aj-status').textContent === 'Найдено событий: 0');
  check('Arbitrary detail field filter gives empty results', (await page.locator('#aj-results').innerText()).includes('не найдено'));
  await page.locator('[data-preset="calc"]').click();
  await page.waitForFunction(n => document.querySelector('#aj-status').textContent === 'Найдено событий: ' + n, String(calcCount));
  if(await page.locator('#aj-form > details').getAttribute('open') !== null) await page.locator('#aj-form > details > summary').click();
  mkdirSync('output/validation/activity-journal', {recursive:true});
  await page.screenshot({path:'output/validation/activity-journal/desktop.png',fullPage:true});
  await page.setViewportSize({width: 1440, height:900});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({path:'output/validation/activity-journal/laptop.png'});
  for(const [width,height] of [[1440,900],[2560,1440]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(readFileSync('scripts/ui_align_audit.js','utf8'));
    const audits=await page.evaluate(()=>({align:alignAudit(document.querySelector('#aj-form')),size:sizeAudit(document.querySelector('#aj-form'))}));
    assert.deepEqual(audits,{align:[],size:[]});
    await page.screenshot({path:`output/validation/activity-journal/audit-${width}.png`});
  }
  check('No browser script errors', errors.length === 0);
  const user = await browser.newContext();
  assert.equal((await user.request.post(base + '/login', {data:{domain_login:'qa_journal_viewer', password:'Test-Pass-1234!'}})).status(), 200);
  check('Journal remains restricted by service permissions', (await user.request.get(base + '/activity')).status() === 403);
  console.log(JSON.stringify({checks, work}, null, 2));
} catch (error) {
  if(page) { console.error((await page.locator('body').innerText()).slice(0,5000)); mkdirSync('output/validation/activity-journal', {recursive:true}); await page.screenshot({path:'output/validation/activity-journal/failure.png',fullPage:true}); }
  console.error(serverLog); throw error;
} finally {
  if(browser) await browser.close();
  server.kill('SIGTERM');
}
