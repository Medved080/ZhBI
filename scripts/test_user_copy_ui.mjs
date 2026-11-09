// Browser checks against a disposable database, with real auth and V2 write gate.
// Run: node scripts/test_user_copy_ui.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const work = mkdtempSync(join(tmpdir(), 'zhbi-user-copy-ui-'));
const base = 'http://127.0.0.1:8161';
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
c.commit()
print(json.dumps({'source':source,'object':obj}))
c.close()
`, join(work, 'seed.db')], { encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
const fixture = JSON.parse(seed.stdout.trim().split('\n').at(-1));
const server = spawn('.venv312/bin/python', ['-W', 'ignore', 'scripts/real_auth_server.py', join(work, 'seed.db'), '8161', work], {
  env: { ...process.env, ZHBI_CALC_DIR: join(work, 'calc'), ZHBI_CALC_RECOVERY_WORKER: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '', browser, page;
server.stdout.on('data', b => { serverLog += b; });
server.stderr.on('data', b => { serverLog += b; });
const checks = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); };
const grantSet = data => data.grants.map(g => JSON.stringify([g.project_id, g.object_id, g.role])).sort();
const layoutAudit = readFileSync('scripts/ui_align_audit.js', 'utf8');
async function checkLayout(selector, name) {
  for (const [width, height] of [[2560, 1440], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    const audit = await page.evaluate(`(() => {${layoutAudit}\nconst root = document.querySelector(${JSON.stringify(selector)}); return {align: alignAudit(root), size: sizeAudit(root)};})()`);
    assert.deepEqual(audit, { align: [], size: [] }, `${name} ${width}×${height}`);
    await page.screenshot({ path: `output/validation/user-copy/${name}-${width}x${height}.png`, fullPage: true });
  }
  check(`${name}: alignment and field sizes at both viewport sizes`, true);
}
const read = async path => {
  const response = await page.request.get(base + path);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
};
async function findUser(login) { return (await read('/users')).find(u => u.domain_login === login); }
async function verifyCopy(login, expected) {
  const user = await findUser(login);
  assert.ok(user, login);
  assert.equal(user.role, 'view');
  assert.equal(user.has_password, false);
  assert.equal(user.must_change_password, true);
  assert.deepEqual(grantSet(await read(`/users/${user.id}/access`)), expected);
  return user;
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
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const login = await page.request.post(base + '/login', { data: { domain_login: 'admin', password: 'Test-Pass-1234!' } });
  assert.equal(login.status(), 200, await login.text());
  const original = await findUser('qa.copy.source');
  const expected = grantSet(await read(`/users/${fixture.source}/access`));
  assert.equal(expected.length, 4);
  await page.goto(base + '/v2#/users-access');
  await page.locator(`[data-copy-user="${fixture.source}"]`).waitFor();
  await page.locator('#ua-search').fill('qa.copy.source');
  await page.locator(`[data-copy-user="${fixture.source}"]`).click();
  await page.locator('#nu-last').waitFor();
  check('Copy button works after filtering the list', await page.locator('#nu-copy-from').inputValue() === String(fixture.source));
  check('New identity fields are empty', await page.locator('#nu-last').inputValue() === '' && await page.locator('#nu-first').inputValue() === '' && await page.locator('#nu-login').inputValue() === '');
  check('System role and organizational fields are filled from source', await page.locator('#nu-role').inputValue() === 'view' && await page.locator('#nu-role').isDisabled() && await page.locator('#nu-pos').inputValue() === 'Инженер' && await page.locator('#nu-dept').inputValue() === 'ПТО');
  await page.locator('#nu-last').fill('Новый');
  await page.locator('#nu-first').fill('Николай');
  await page.locator('#nu-patr').fill('Петрович');
  await page.locator('#nu-generate').uncheck();
  await page.locator('#nu-login').fill('QA.COPY.SOURCE');
  await page.locator('#nu-submit').click();
  await page.waitForFunction(() => document.querySelector('#nu-error')?.textContent.includes('занято'));
  check('Duplicate login preserves form and source selection', await page.locator('#nu-last').inputValue() === 'Новый' && await page.locator('#nu-copy-from').inputValue() === String(fixture.source));
  await page.locator('#nu-login').fill('qa.copy.v2');
  await page.locator('#nu-submit').click();
  await page.locator('[data-tab="security"][aria-pressed="true"]').waitFor();
  const copied = await verifyCopy('qa.copy.v2', expected);
  check('V2 copies every grant with real write gate and opens password setup', true);
  assert.equal(copied.patronymic, 'Петрович');
  await page.locator('[data-copy-current]').click();
  await page.locator('#nu-copy-from').waitFor();
  check('Copy is also available from the user card', await page.locator('#nu-copy-from').inputValue() === String(copied.id));
  await page.locator('#nu-cancel').click();
  await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
  await page.locator('#nu-copy-from').selectOption(String(fixture.source));
  check('Standard new-user form supports choosing a source', await page.locator('#nu-role').inputValue() === 'view');
  await page.locator('#nu-copy-from').selectOption('');
  check('Removing source restores ordinary creation defaults', await page.locator('#nu-role').inputValue() === 'user' && await page.locator('#nu-role').isEnabled());
  await page.locator('#nu-last').fill('Обычный');
  await page.locator('#nu-login').fill('qa.copy.ordinary');
  await page.locator('#nu-generate').uncheck();
  await page.locator('#nu-submit').click();
  await page.locator('[data-tab="profile"][aria-pressed="true"]').waitFor();
  const ordinary = await findUser('qa.copy.ordinary');
  check('Ordinary creation still works without copying or extra grants', ordinary.role === 'user' && grantSet(await read(`/users/${ordinary.id}/access`)).length === 0);
  await page.locator('[data-back]').click();
  mkdirSync('output/validation/user-copy', { recursive: true });
  await page.locator(`[data-copy-user="${fixture.source}"]`).click();
  await page.locator('#nu-last').waitFor();
  await page.screenshot({ path: 'output/validation/user-copy/v2.png', fullPage: true });
  await checkLayout('#ua-new-user', 'v2');
  await page.locator('#nu-cancel').click();

  await page.goto(base + '/?ui=v1');
  await page.locator('#changelog-backdrop.open').waitFor();
  await page.locator('#changelog-close').click();
  await page.locator('#btn-settings-menu').click();
  await page.locator('#actions-panel-body [data-menu-id="menu-users"]').click();
  await page.locator('#users-search').fill('qa.copy.source');
  await page.locator(`#users-table [data-copy-user="${fixture.source}"]`).click();
  await page.locator('#user-edit-backdrop.open').waitFor();
  check('V1 copy opens a new identity with copied system role', await page.locator('#ue-last-name').inputValue() === '' && await page.locator('#ue-domain-login').inputValue() === '' && await page.locator('#ue-role').inputValue() === 'view');
  check('V1 profile names the source and explains separate password setup', (await page.locator('#ue-copy-note').innerText()).includes('qa.copy.source'));
  await page.screenshot({ path: 'output/validation/user-copy/v1-profile.png', fullPage: true });
  await checkLayout('#user-edit-backdrop [data-ue-panel="profile"]', 'v1-profile');
  await page.locator('#ue-last-name').fill('Второй');
  await page.locator('#ue-first-name').fill('Виктор');
  await page.locator('#ue-generate').uncheck();
  await page.locator('#user-edit-backdrop [data-ue-tab="access"]').click();
  check('V1 shows copied access before creation', (await page.locator('#ue-access-summary').innerText()).includes('Команда'));
  await page.screenshot({ path: 'output/validation/user-copy/v1.png', fullPage: true });
  await page.locator('#user-edit-backdrop [data-ue-tab="security"]').click();
  await page.locator('#ue-domain-login').fill('qa.copy.v1');
  const response = page.waitForResponse(r => r.url() === base + '/users' && r.request().method() === 'POST');
  await page.locator('#user-edit-save').click();
  assert.equal((await response).status(), 200);
  await page.waitForFunction(() => document.querySelector('#ue-domain-login')?.value === 'qa.copy.v1' && !document.querySelector('#ue-password-btn')?.disabled);
  await verifyCopy('qa.copy.v1', expected);
  check('V1 copies all grants atomically and opens password setup', true);
  assert.deepEqual(await findUser('qa.copy.source'), original);
  assert.deepEqual(grantSet(await read(`/users/${fixture.source}/access`)), expected);
  check('Source user and permissions are unchanged', true);
  check('No browser script errors', errors.length === 0);

  const restricted = await browser.newContext();
  assert.equal((await restricted.request.post(base + '/login', { data: { domain_login: 'qa.copy.denied', password: 'Test-Pass-1234!' } })).status(), 200);
  const forbidden = await restricted.request.post(base + '/users', { data: { last_name: 'Запрещён', domain_login: 'qa.copy.forbidden', role: 'view', copy_from_user_id: fixture.source } });
  check('Copy endpoint rejects users without management permission', forbidden.status() === 403);
  await restricted.close();
  console.log(JSON.stringify({ checks, work }, null, 2));
} catch (error) {
  if (page) {
    console.error((await page.locator('body').innerText()).slice(0, 5000));
    mkdirSync('output/validation/user-copy', { recursive: true });
    await page.screenshot({ path: 'output/validation/user-copy/failure.png', fullPage: true });
  }
  console.error(serverLog);
  throw error;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
