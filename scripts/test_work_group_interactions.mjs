// Run with the disposable, anonymized fixture on port 8043.
import assert from 'node:assert/strict';
import { launch } from './cdp.mjs';

const base = process.env.WORK_GROUPS_BASE || 'http://127.0.0.1:8043';
assert.equal(new URL(base).port, '8043', 'Use the disposable fixture');
const browser = await launch({ width: 1440, height: 900 });
const selected = () => browser.eval("[...document.querySelectorAll('.wg-map [data-element][fill=\"#dc5d26\"]')].map(e=>Number(e.dataset.element)).sort((a,b)=>a-b)");
const frame = () => browser.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
const view = () => browser.eval("document.querySelector('.wg-map').getAttribute('viewBox')");
const target = () => browser.eval(`(()=>{
  const svg=document.querySelector('.wg-map'),sr=svg.getBoundingClientRect();
  for(const node of svg.querySelectorAll('[data-element]')) {
    const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    if(x>sr.x+40&&x<sr.right-120&&y>sr.y+40&&y<sr.bottom-80&&document.elementFromPoint(x,y)?.closest('[data-element]')===node)
      return {x,y,id:Number(node.dataset.element)};
  }
})()`);
const press = (x,y) => browser.send('Input.dispatchMouseEvent', {type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
const move = (x,y) => browser.send('Input.dispatchMouseEvent', {type:'mouseMoved',x,y,button:'left',buttons:1});
const release = (x,y) => browser.send('Input.dispatchMouseEvent', {type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
try {
  await browser.goto(`${base}/v2`);
  await browser.eval("location.hash='#/zones'");
  await browser.waitFor("document.querySelector('.wg-map [data-element]')", 20000);
  await browser.eval("document.querySelector('.wg-map').scrollIntoView({block:'center'})");
  const count = await browser.eval("document.querySelectorAll('.wg-map [data-element]').length");
  assert.ok(count > 9000, 'Test uses the complete model');
  // Zoom first: the former redraw changed the width of every outline after a click.
  const map = await browser.rect('.wg-map');
  for (let i=0;i<3;i++) await browser.wheel(map.cx,map.cy,-100);
  await frame();
  const item = await target();
  assert.ok(item, 'A visible product is available');
  await browser.eval(`window.originalMap=document.querySelector('.wg-map');
    window.originalItem=document.querySelector('[data-element="${item.id}"]');
    window.originalStroke=originalItem.parentElement.getAttribute('stroke-width');
    window.mapNodeMutations=0;
    new MutationObserver(list=>mapNodeMutations+=list.filter(e=>e.type==='childList').length).observe(originalMap,{subtree:true,childList:true});
    window.savedTarget=document.querySelector('#wg-target').options[1].value;
    document.querySelector('#wg-target').value=savedTarget;`);
  const requestCount = browser.requests.length;
  // A slower CPU makes rebuilding thousands of SVG nodes visible in this check.
  await browser.send('Emulation.setCPUThrottlingRate', {rate:4});
  const started = performance.now();
  await browser.click(item.x,item.y);
  await frame();
  const clickMs = Math.round(performance.now()-started);
  assert.deepEqual(await selected(), [item.id]);
  assert.ok(clickMs < 800, `Selection took ${clickMs} ms`);
  assert.ok(await browser.eval(`originalMap===document.querySelector('.wg-map') && originalItem===document.querySelector('[data-element="${item.id}"]') && originalStroke===originalItem.parentElement.getAttribute('stroke-width')`), 'Selection retains geometry and outline width');
  assert.equal(await browser.eval('mapNodeMutations'),0);
  assert.ok(await browser.eval("document.querySelector('#wg-target').value===savedTarget"), 'Selected capture is retained');

  const originalView = await view();
  const before = await browser.rect(`[data-element="${item.id}"]`);
  await browser.drag(item.x,item.y,item.x+60,item.y+25);
  await frame();
  const after = await browser.rect(`[data-element="${item.id}"]`);
  assert.notEqual(await view(),originalView,'Dragging from a product pans the plan');
  assert.ok(Math.abs(after.x-before.x-60)<1 && Math.abs(after.y-before.y-25)<1,'Plan follows the pointer in screen pixels');
  assert.deepEqual(await selected(),[item.id],'Pan does not change selection');

  // The map moves before the mouse is released, even after several consecutive drags.
  for(let i=0;i<3;i++) {
    const prior=await view(),x=map.x+25,y=map.y+25;
    await browser.move(x,y); await press(x,y); await move(x+45,y+18);
    await frame();
    assert.notEqual(await view(),prior,'Plan updates while dragging');
    await release(x+45,y+18);
  }
  assert.equal(await browser.eval('mapNodeMutations'),0,'Panning keeps model nodes');

  // Captured mouse movements outside the scheme must not leave a stuck gesture.
  await browser.drag(map.x+20,map.y+20,map.x-15,map.y-10);
  await browser.clickSel('[data-wg="fit"]');
  await frame();
  assert.equal(await browser.eval("document.querySelector('#wg-zoom').textContent"),'100%');
  const next=await target();
  const wasSelected=(await selected()).includes(next.id);
  await browser.drag(next.x,next.y,next.x+2,next.y+1,{steps:2});
  assert.equal((await selected()).includes(next.id),!wasSelected,'Small pointer jitter toggles selection as a click');

  await browser.move(map.x+20,map.y+20); await press(map.x+20,map.y+20);
  await browser.eval(`document.querySelector('.wg-map').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))`);
  await release(map.x+20,map.y+20);
  const zoomBefore=await view();
  await browser.wheel(map.cx,map.cy,100); await frame();
  assert.notEqual(await view(),zoomBefore,'Wheel works after pointer cancellation');
  await browser.clickSel('[data-wg="fit"]');
  await browser.clickSel('[data-wg="clear-selection"]');
  assert.deepEqual(await selected(),[]);

  // Shift-selection uses the visible rectangle and preserves the complete SVG.
  await browser.eval("document.querySelector('.wg-map').scrollIntoView({block:'center'})");
  const boxItem=await target();
  await browser.drag(boxItem.x-15,boxItem.y-15,boxItem.x+15,boxItem.y+15,{shift:true});
  assert.ok((await selected()).includes(boxItem.id),'Rectangle selects product centres');
  assert.equal(await browser.eval('mapNodeMutations'),0);
  assert.equal(browser.requests.length,requestCount,'Selection, pan, fit and clear do not fetch the model');
  await browser.eval("document.querySelector('[data-wg=\"new-zone\"]').click()");
  await browser.waitFor("document.querySelector('[data-wg=draw]') && !document.querySelector('[data-wg=draw]').disabled");
  await browser.eval("document.querySelector('[data-wg=draw]').click()");
  await browser.waitFor("document.querySelector('.wg-map.wg-drawing')");
  await browser.eval("document.querySelector('.wg-map').scrollIntoView({block:'center'}); window.drawingItem=document.querySelector('.wg-map [data-element]')");
  const drawingMap=await browser.rect('.wg-map');
  for(const [x,y] of [[25,25],[90,25],[90,70]]) await browser.click(drawingMap.x+x,drawingMap.y+y);
  assert.equal(await browser.eval("document.querySelector('[data-wg-draft] polyline').points.numberOfItems"),3);
  assert.ok(await browser.eval("drawingItem===document.querySelector('.wg-map [data-element]')"),'Adding contour vertices keeps model geometry');
  await browser.eval("document.querySelector('[data-wg=draw]').click()");
  await browser.waitFor("document.querySelector('[data-wg=\"preview-zone\"]') && !document.querySelector('[data-wg=\"preview-zone\"]').disabled");
  assert.deepEqual(browser.exceptions,[]);
  console.log(JSON.stringify({products:count,cpuSlowdown:4,clickToPaintMs:clickMs,geometryRecreated:false,panAndSelection:'passed'}));
} finally {
  await browser.close();
}
