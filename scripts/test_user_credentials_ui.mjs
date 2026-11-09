// Browser checks against a disposable database, with real auth and V2 write gate.
// Run: node scripts/test_user_credentials_ui.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const work = mkdtempSync(join(tmpdir(), 'pm-features-ui-'));
const base = 'http://127.0.0.1:8162';
const seed = spawnSync('.venv312/bin/python', ['-W', 'ignore', '-c', `
import os,sys,json
os.environ['ZHBI_DB_PATH']=sys.argv[1]
from app import db,auth,team_access
db.init_db()
c=db.get_connection()
project=c.execute("INSERT INTO projects(name) VALUES('Проверка копирования')").lastrowid
obj=c.execute("INSERT INTO objects(name,project_id) VALUES('Корпус для копирования',?)",(project,)).lastrowid
for key,name in [('qa_copy_all','Общий доступ'),('qa_copy_project','Проект'),('qa_copy_object','Объект'),('qa_copy_team','Команда')]:
 c.execute('INSERT INTO object_roles(key,name,rank) VALUES(?,?,100)',(key,name))
h,s=auth.hash_password('Test-Pass-1234!')
source=c.execute("INSERT INTO users(last_name,first_name,patronymic,domain_login,role,position,department,password_hash,password_salt) VALUES('Образцов','Олег','Иванович','qa.copy.source','view','Инженер','ПТО',?,?)",(h,s)).lastrowid
for p,o,r in [(None,None,'qa_copy_all'),(project,None,'qa_copy_project'),(project,obj,'qa_copy_object')]:
 c.execute('INSERT INTO user_access(user_id,project_id,object_id,role) VALUES(?,?,?,?)',(source,p,o,r))
person=c.execute("INSERT INTO individuals(name) VALUES('Образцов О. И.')").lastrowid
c.execute('INSERT INTO individual_user_links VALUES(?,?)',(person,source))
c.execute("INSERT INTO team_role_access VALUES('gip','qa_copy_team')")
c.execute("INSERT INTO object_team_members(object_id,role_key,individual_id) VALUES(?,'gip',?)",(obj,person))
team_access.sync_all(c)
c.execute("INSERT INTO users(last_name,domain_login,role,password_hash,password_salt) VALUES('Наблюдатель','qa.copy.denied','view',?,?)",(h,s))

c.execute("INSERT INTO object_drawings(object_id,source_file,is_current) VALUES(?,'synthetic.dxf',1)",(obj,))
ids=[]
for i in range(4):
 x=i*1500
 outline=json.dumps([[x,0],[x+500,0],[x+500,500],[x,500]])
 ids.append(c.execute("INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark,mark_source,x,y,axis_status,object_id,element_uid,outline_json,planned_delivery_date) VALUES('synthetic.dxf',?,'TEST','Колонна',?,'manual',?,250,'none',?,?,?,?)",(f'E{i}','QA-1' if i<3 else 'QA-2',x+250,obj,f'synthetic-{i}',outline,None if i<3 else '2026-12-05')).lastrowid)
cp=c.execute("INSERT INTO counterparties(full_name,short_name,code) VALUES('Тестовый поставщик','Поставщик','ТП')").lastrowid
agreement=c.execute("INSERT INTO agreements(counterparty_id,number,object_id) VALUES(?,'Д-1',?)",(cp,obj)).lastrowid
spec=c.execute("INSERT INTO specifications(agreement_id,number) VALUES(?,'СП-1')",(agreement,)).lastrowid
contract=c.execute("INSERT INTO contracts(specification_id,theme) VALUES(?,'Контрольный контракт')",(spec,)).lastrowid
c.execute("INSERT INTO contract_lines(contract_id,element_type,mark,quantity) VALUES(?,'Колонна','QA-1',2)",(contract,))
c.commit()
print(json.dumps({'source':source,'object':obj,'ids':ids,'contract':contract}))
c.close()
`, join(work, 'seed.db')], { encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
const fixture = JSON.parse(seed.stdout.trim().split('\n').at(-1));
const server = spawn('.venv312/bin/python', ['-W', 'ignore', 'scripts/real_auth_server.py', join(work, 'seed.db'), '8162', work], {
  env: { ...process.env, ZHBI_CALC_DIR: join(work, 'calc'), ZHBI_CALC_RECOVERY_WORKER: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '', browser, page;
server.stdout.on('data', b => { serverLog += b; });
server.stderr.on('data', b => { serverLog += b; });
mkdirSync('output/validation/pm-features', { recursive: true });
const checks = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); };
const grantSet = data => data.grants.map(g => JSON.stringify([g.project_id, g.object_id, g.role])).sort();
const layoutAudit = readFileSync('scripts/ui_align_audit.js', 'utf8');
async function checkLayout(selector, name) {
  for (const [width, height] of [[2560, 1440], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    const audit = await page.evaluate(`(() => {${layoutAudit}\nconst root = document.querySelector(${JSON.stringify(selector)}); return {align: alignAudit(root), size: sizeAudit(root)};})()`);
    assert.deepEqual(audit, { align: [], size: [] }, `${name} ${width}×${height}`);
    await page.screenshot({ path: `output/validation/pm-features/${name}-${width}x${height}.png`, fullPage: true });
  }
  check(`${name}: alignment and field sizes at both viewport sizes`, true);
}
const read = async path => {
  const response = await page.request.get(base + path);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
};
async function findUser(login) { return (await read('/users')).find(u => u.domain_login === login); }

async function checkHandoff(login, expectedPassword, label) {
  const dialog = page.locator('dialog.pc-dialog[open]');
  await dialog.waitFor();
  check(`${label}: identity and generated password are displayed once`,
    (await dialog.innerText()).includes(login) && (await dialog.innerText()).includes(expectedPassword));
  await page.keyboard.press('Escape');
  check(`${label}: Escape keeps the one-time credentials visible`, await dialog.isVisible());
  await dialog.getByRole('button', { name: 'Скопировать для отправки', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.pc-status')?.textContent.includes('Скопированы'));
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check(`${label}: copied handoff contains PM, address, login, password and first-login instruction`,
    copied.startsWith('PM\n') && copied.includes(`Адрес: ${base}/`) && copied.includes(`Логин: ${login}`)
    && copied.includes(`Пароль: ${expectedPassword}`) && copied.includes('сменить пароль'));
  const users = await read('/users');
  check(`${label}: password is absent from user listings and browser storage`,
    !JSON.stringify(users).includes(expectedPassword) && await page.evaluate(password =>
      !JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(password), expectedPassword));
}

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { ready = (await fetch(base + '/health')).ok; } catch {}
    if (ready) break;
    if (server.exitCode != null) throw Error(serverLog);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, serverLog);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  assert.equal((await page.request.post(base + '/login', { data: { domain_login: 'admin', password: 'Test-Pass-1234!' } })).status(), 200);
  await page.goto(base + '/v2#/users-access');
  await page.locator(`[data-copy-user="${fixture.source}"]`).click();
  await page.locator('#nu-last').fill('Пароль');
  await page.locator('#nu-first').fill('Автоматический');
  await page.locator('#nu-login').fill('qa.credentials.v2');
  check('V2 new-user form enables automatic password generation by default', await page.locator('#nu-generate').isChecked());
  const creation = page.waitForResponse(r => r.url() === base + '/users' && r.request().method() === 'POST');
  await page.locator('#nu-submit').click();
  const created = await (await creation).json();
  assert.ok(created.generated_password);
  await checkHandoff('qa.credentials.v2', created.generated_password, 'V2 creation');
  await checkLayout('dialog.pc-dialog', 'v2-credentials');
  await page.locator('dialog.pc-dialog').getByRole('button', { name: 'Готово', exact: true }).click();
  await page.locator('#sec-generate').waitFor();
  check('V2 service header and browser title use PM', (await page.title()).endsWith('— PM') && (await page.locator('.v2-head-title strong').first().innerText()) === 'PM');
  const newcomer = await browser.newContext();
  const firstLogin = await newcomer.request.post(base + '/login', { data: { domain_login: 'qa.credentials.v2', password: created.generated_password } });
  assert.equal(firstLogin.status(), 200, await firstLogin.text());
  check('Generated password permits login and requires a personal password change', (await firstLogin.json()).must_change_password === true);
  const resetResponse = page.waitForResponse(r => r.url().endsWith('/generate-password') && r.request().method() === 'POST');
  await page.locator('#sec-generate').click();
  await page.getByRole('button', { name: 'Сгенерировать', exact: true }).click();
  const reset = await (await resetResponse).json();
  assert.notEqual(reset.generated_password, created.generated_password);
  await checkHandoff('qa.credentials.v2', reset.generated_password, 'V2 reset');
  check('The old user session is revoked after password generation', (await newcomer.request.get(base + '/me')).status() === 401);
  await newcomer.close();
  await page.locator('dialog.pc-dialog').getByRole('button', { name: 'Готово', exact: true }).click();

  await page.goto(base + '/?ui=v1');
  await page.locator('#changelog-backdrop.open').waitFor();
  await page.locator('#changelog-close').click();
  check('V1 service header and browser title use PM', await page.title() === 'PM' && await page.locator('#toolbar h1').innerText() === 'PM');
  await page.locator('#btn-settings-menu').click();
  await page.locator('#actions-panel-body [data-menu-id="menu-users"]').click();
  await page.locator(`#users-table [data-copy-user="${fixture.source}"]`).click();
  await page.locator('#ue-last-name').fill('Пароль');
  await page.locator('#ue-first-name').fill('Первый');
  check('V1 new-user form enables automatic password generation by default', await page.locator('#ue-generate').isChecked());
  await page.locator('#user-edit-backdrop [data-ue-tab="security"]').click();
  await page.locator('#ue-domain-login').fill('qa.credentials.v1');
  const v1Creation = page.waitForResponse(r => r.url() === base + '/users' && r.request().method() === 'POST');
  await page.locator('#user-edit-save').click();
  const v1 = await (await v1Creation).json();
  assert.ok(v1.generated_password);
  await checkHandoff('qa.credentials.v1', v1.generated_password, 'V1 creation');
  await checkLayout('dialog.pc-dialog', 'v1-credentials');
  // Exercise the corporate HTTP fallback while keeping clipboard reading available for verification.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { get: () => undefined, configurable: true }));
  await page.locator('dialog.pc-dialog').getByRole('button', { name: 'Только пароль', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.pc-status')?.textContent === 'Пароль скопирован');
  await page.evaluate(() => { delete navigator.clipboard; });
  check('Copying works without the modern Clipboard API', await page.evaluate(() => navigator.clipboard.readText()) === v1.generated_password);
  await page.locator('dialog.pc-dialog').getByRole('button', { name: 'Готово', exact: true }).click();
  await page.locator('#ue-password-btn').click();
  const v1ResetResponse = page.waitForResponse(r => r.url().endsWith('/generate-password') && r.request().method() === 'POST');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#user-password-generate').click();
  const v1Reset = await (await v1ResetResponse).json();
  await checkHandoff('qa.credentials.v1', v1Reset.generated_password, 'V1 reset');
  await page.locator('dialog.pc-dialog').getByRole('button', { name: 'Готово', exact: true }).click();

  await page.goto(`${base}/v2?object_id=${fixture.object}#/ws-model`);
  const scene = page.frameLocator('iframe.ws-frame');
  await scene.locator('.element-shape').first().waitFor({ timeout: 30000 });
  const selectGroup = async ids => {
    const boxes = await Promise.all(ids.map(id => scene.locator(`.element-shape[data-id="${id}"]`).boundingBox()));
    assert.ok(boxes.every(Boolean));
    const frame = await page.locator('iframe.ws-frame').boundingBox();
    const x = Math.max(frame.x + 5, Math.min(...boxes.map(b => b.x)) - 8);
    const y = Math.max(frame.y + 5, Math.min(...boxes.map(b => b.y)) - 8);
    const right = Math.min(frame.x + frame.width - 5, Math.max(...boxes.map(b => b.x + b.width)) + 8);
    const bottom = Math.min(frame.y + frame.height - 5, Math.max(...boxes.map(b => b.y + b.height)) + 8);
    await page.keyboard.down('Shift');
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 12 }); await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.locator('[data-eo-bar="status"]').waitFor();
  };
  await selectGroup(fixture.ids);
  await page.locator('[data-eo-bar="status"]').click();
  await page.locator('#eor-status').waitFor();
  check('V2 group toolbar opens the full per-element table directly', await page.locator('.eo-dialog [data-eor-id]').count() === 4);
  await page.locator(`[data-eor-remove="${fixture.ids[3]}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('.eo-dialog [data-eor-id]').length === 3);
  check('Excluding a row also removes its highlight from the actual scene', await scene.locator(`.element-shape.multi-selected[data-id="${fixture.ids[3]}"]`).count() === 0);
  await page.locator('#eor-status').selectOption('contracting');
  await page.locator('[data-eor-m]').first().click();
  await page.locator(`.eo-crow[data-c="${fixture.contract}"]`).click();
  await page.waitForFunction(() => document.querySelector('.eo-bymark')?.textContent.includes('Распределено 2 из 3'));
  check('Distribution respects the remaining contract quantity', await page.locator('[data-eor-c]').filter({ hasText: '— выбрать —' }).count() === 1);
  await page.locator('[data-eor-c]').filter({ hasText: '— выбрать —' }).click();
  check('Contract picker subtracts unsaved assignments from available quantity', await page.locator(`.eo-crow[data-c="${fixture.contract}"]`).isDisabled());
  await page.locator('.eo-crow[data-c="none"]').click();
  await page.locator('#eor-status').selectOption('in_production');
  await page.locator('#eor-status').selectOption('contracting');
  check('Changing the target status preserves assigned per-row contracts', await page.locator('[data-eor-c]').filter({ hasText: '— выбрать —' }).count() === 0);
  await checkLayout('.eo-dialog', 'v2-group-status');
  const stateBefore = await read(`/element-ops/state?ids=${fixture.ids.join(',')}`);
  await page.locator('[data-eor="preview"]').click();
  await page.locator('.eo-preview').waitFor();
  assert.deepEqual(await read(`/element-ops/state?ids=${fixture.ids.join(',')}`), stateBefore);
  check('Group preview performs no writes', true);
  await page.locator('[data-eor="apply"]').click();
  await page.locator('.v2-dialog[role="alertdialog"] [data-choice="confirm"]').click();
  await page.locator('.eo-dialog').waitFor({ state: 'detached' });
  const stateAfter = await read(`/element-ops/state?ids=${fixture.ids.join(',')}`);
  const applied = stateAfter.items || stateAfter.elements;
  check('Status and contract choices are applied, excluded element remains unchanged', applied.filter(e => e.current_status === 'contracting').length === 3
    && applied.filter(e => e.contract_id === fixture.contract).length === 2
    && applied.find(e => e.id === fixture.ids[3]).current_status === 'planned');
  // Applying the operation preserves selection; clear and select the same synthetic group again.
  const clear = page.locator('[data-eo-bar="clear"]');
  if (await clear.count()) await clear.click();
  await selectGroup(fixture.ids);
  await page.locator('[data-eo-bar="planned"]').click();
  await page.locator('.eor-date').first().waitFor();
  check('Group dates open the per-element date table directly', await page.locator('.eo-dialog [data-eor-id]').count() === 4);
  await page.locator('#eor-fill').fill('2026-12-10');
  await page.locator('[data-eor="fill"]').click();
  check('Fill empty dates preserves the existing row date', await page.locator(`.eor-date[data-id="${fixture.ids[3]}"]`).inputValue() === '2026-12-05');
  await page.locator(`[data-eor-remove="${fixture.ids[2]}"]`).click();
  await checkLayout('.eo-dialog', 'v2-group-dates');
  await page.locator('[data-eor="preview"]').click();
  await page.locator('.eo-preview').waitFor();
  await page.locator('[data-eor="apply"]').click();
  await page.locator('.v2-dialog[role="alertdialog"] [data-choice="confirm"]').click();
  await page.locator('.eo-dialog').waitFor({ state: 'detached' });
  const dates = await read(`/element-ops/state?ids=${fixture.ids.join(',')}`);
  const dated = dates.items || dates.elements;
  check('Group dates apply to included changed rows only', dated.find(e => e.id === fixture.ids[0]).planned_delivery_date === '2026-12-10'
    && dated.find(e => e.id === fixture.ids[1]).planned_delivery_date === '2026-12-10'
    && dated.find(e => e.id === fixture.ids[2]).planned_delivery_date == null
    && dated.find(e => e.id === fixture.ids[3]).planned_delivery_date === '2026-12-05');
  await page.goto(`${base}/v2?object_id=${fixture.object}#/ws-picker`);
  await scene.locator('.element-shape').first().waitFor({ timeout: 30000 });
  await selectGroup(fixture.ids);
  check('Picker workspace exposes both group actions after selection', await page.locator('[data-eo-bar="planned"]').isVisible());
  await page.locator('[data-eo-bar="status"]').click();
  await page.locator('#eor-status').waitFor();
  check('Picker workspace opens the same complete row editor', await page.locator('.eo-dialog [data-eor-id]').count() === 4);
  await page.locator('[data-eor-single]').click();
  await page.locator('#eo-gform').waitFor();
  check('Single-value mode retains status, timestamp and comment fields', await page.locator('#eo-gform [name="at"]').count() === 1 && await page.locator('#eo-gform [name="comment"]').count() === 1);
  const denied = await browser.newContext();
  assert.equal((await denied.request.post(base + '/login', { data: { domain_login: 'qa.copy.denied', password: 'Test-Pass-1234!' } })).status(), 200);
  for (const path of ['/element-ops/status-rows', '/element-ops/planned-date-rows']) {
    const item = path.endsWith('/status-rows')
      ? { element_id: fixture.ids[0], expected_status: 'contracting', expected_contract_id: fixture.contract, contract_id: null }
      : { element_id: fixture.ids[0], expected_planned_date: '2026-12-10', planned_date: '2026-12-11' };
    const response = await denied.request.post(base + path, { data: { mode: 'preview', object_id: fixture.object, status: 'planned', items: [item] } });
    assert.equal(response.status(), 403, await response.text());
    check(`Group endpoint ${path} rejects an account without access`, true);
  }
  await denied.close();
  check('No browser script errors', errors.length === 0);
  check('Generated passwords never appear in server logs', ![created, reset, v1, v1Reset].some(u => serverLog.includes(u.generated_password)));
  console.log(JSON.stringify({ checks, work }, null, 2));
} catch (error) {
  if (page) {
    console.error((await page.locator('body').innerText()).slice(0, 5000));
    await page.screenshot({ path: 'output/validation/pm-features/failure.png', fullPage: true });
  }
  console.error(serverLog);
  throw error;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
