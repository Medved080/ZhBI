// Run against scripts/snz_test_server.py: a synthetic DB and loopback only.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8038';
const output=new URL('../outputs/snz-verification/',import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
const errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const click=action=>page.locator(`.snz-dialog [data-action="${action}"]`).click();
const tab=name=>page.locator(`.snz-dialog [data-tab="${name}"]`).click();
const settled=()=>page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy="true"]'));
try{
  await page.goto(base+'/v2?object_id=1#/ws-foreman');
  await page.locator('.ws-tabs [data-tab="snz"]').click();
  await page.locator('[data-snz-open]').click();await settled();
  check('Foreman workspace opens the real СНЗ planner',await page.locator('.snz-dialog').isVisible());
  if(process.argv.includes('--probe')){console.log((await page.locator('body').innerText()).slice(0,6000));await page.screenshot({path:new URL('initial.png',output).pathname});}
  else{
    await tab('cards');
    await page.locator('[data-path="cards.0.steps.2.minutes"]').fill('45');
    await page.locator('[data-path="cards.0.steps.2.minutes"]').press('Tab');
    check('Changing a norm enables Save',await page.locator('[data-action="save"]').isEnabled());
    await click('save');await settled();
    check('Norm changes persist through the real API',(await(await page.request.get(base+'/objects/1/snz/state')).json()).state.cards[0].steps[2].minutes===45);
    await tab('plan');await click('page-all');
    await tab('groups');await page.locator('[data-group-name]').fill('Крест 1');await click('add-group');
    await page.locator('[data-path="groups.0.card_id"]').selectOption('base');
    await click('save');await settled();
    check('Four selected beams become one manual group',(await(await page.request.get(base+'/objects/1/snz/state')).json()).state.groups[0].element_ids.length===4);
    await tab('plan');
    await page.locator('[data-filter="date"]').fill('2026-11-09');await page.locator('[data-filter="date"]').press('Tab');
    await page.locator('[data-filter="shift"]').selectOption('night');
    await page.locator('[data-filter="crew"]').selectOption('preparation');
    await click('preview');await settled();
    check('Preparation is scheduled the previous night',await page.locator('.snz-result tbody tr').count()===4);
    await click('issue');await settled();
    check('Preparation order is issued',/Выданный СНЗ/.test(await page.locator('.snz-result h3').innerText()));
    while(await page.locator('[data-action="complete"]').count()){await page.locator('[data-action="complete"]').first().click();await settled();}
    check('Binary completion is recorded',await page.locator('.snz-done').filter({hasText:'100 %'}).count()===4);
    await page.locator('[data-filter="date"]').fill('2026-11-10');await page.locator('[data-filter="date"]').press('Tab');
    await page.locator('[data-filter="shift"]').selectOption('day');await page.locator('[data-filter="crew"]').selectOption('install1');
    await click('preview');await settled();
    check('Group stages appear once and four installations remain',await page.locator('.snz-result tbody tr').count()===12);
    check('Gantt contains profession resource rows',await page.locator('.snz-track').count()===3);
    await click('issue');await settled();
    const orderState=await(await page.request.get(base+'/objects/1/snz/state')).json();
    check('One document per foreman and shift is persisted',orderState.orders.length===2);
    for(const kind of ['xlsx','pdf']){
      const pending=page.waitForEvent('download');await click(kind);const download=await pending;await download.saveAs(new URL(`browser-order.${kind}`,output).pathname);await settled();
      check('Browser downloads '+kind,!(await download.failure()));
    }
    // Visual QA, including the project's required alignment audit at both sizes.
    const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
    for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
      await page.setViewportSize(size);
      await page.evaluate(audit);
      const issues=await page.evaluate(()=>({alignment:alignAudit(document.querySelector('.snz-dialog')),sizes:sizeAudit(document.querySelector('.snz-dialog'))}));
      await writeFile(new URL(`audit-${size.width}.json`,output),JSON.stringify(issues,null,2));
      await page.locator('.snz-content').evaluate(e=>{const result=e.querySelector('.snz-result');e.scrollTop+=result.getBoundingClientRect().top-e.getBoundingClientRect().top;});
      await page.screenshot({path:new URL(`planner-${size.width}.png`,output).pathname});
      check(`Alignment at ${size.width}`,issues.alignment.length===0);
      check(`Field sizes at ${size.width}`,issues.sizes.length===0);
    }
    await page.setViewportSize({width:1440,height:900});
    await page.locator('.snz-content').evaluate(e=>e.scrollTo(0,0));
    await click('show-sequence');
    await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelectorAll('#snz-sequence-layer text').length===4);
    check('Mounting sequence is shown on the actual model',true);
    await page.locator('.ws-tabs [data-tab="props"]').click();
    await page.waitForFunction(()=>!document.querySelector('iframe')?.contentDocument?.querySelector('#snz-sequence-layer'));
    check('Sequence labels are scoped to the СНЗ tab',true);
    check('No browser runtime errors',errors.length===0);
    await writeFile(new URL('browser-checks.json',output),JSON.stringify({checks,errors},null,2));
  }
}catch(e){await page.screenshot({path:new URL('failure.png',output).pathname});console.log((await page.locator('body').innerText()).slice(-7000));console.log('Browser errors:',errors);throw e;}
finally{await browser.close();}
