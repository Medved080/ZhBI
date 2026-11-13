// Run against a disposable real_auth_server.py fixture on port 8377.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.PANEL_LABELS_BASE || 'http://127.0.0.1:8377';
assert.equal(new URL(base).port, '8377', 'Use the disposable fixture');
const output = new URL('../outputs/panel-labels/', import.meta.url);
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({channel:'chrome',headless:true,args:[
  '--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader',
]});
try {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base+'/v2');
  await page.locator('#v2-login-user').fill('admin');
  await page.locator('#v2-login-pass').fill('Test-Pass-1234!');
  await page.locator('#v2-login-pass').press('Enter');
  await page.locator('#v2-object').waitFor({state:'attached'});
  await page.goto(base+'/?ui=v1&object_id=1');
  await page.waitForFunction(()=>typeof state!=='undefined' && state.elements?.some(e=>e.subtype==='фасадная'));
  await page.locator('#btn-view-3d').click();
  await page.waitForFunction(()=>state.view3d.active && !!state.view3d.merged);
  const checked = await page.evaluate(()=>{
    const levels=computeColumnLevels(), tops=computeColumnTops(levels);
    const panels=state.elements.filter(e=>e.element_type==='Панель' || e.element_type==='Панель облицовки шахты');
    const failures=[];
    for(const panel of panels){
      const quads=collectMarkDecalQuads(panel,{subText:''},5,levels,tops);
      if(quads?.length!==2){failures.push([panel.id,'face count']);continue;}
      if(!state.view3d.decalElementIds.has(panel.id) || state.view3d.labelSpriteById.has(panel.id)) failures.push([panel.id,'sprite fallback']);
      if(quads[0].normal.dot(quads[1].normal)>-0.99999) failures.push([panel.id,'opposite normals']);
      for(const quad of quads){
        const up=new THREE.Vector3().crossVectors(quad.normal,quad.right);
        if(Math.abs(up.y-1)>1e-6) failures.push([panel.id,'upright orientation']);
        if(Math.abs(quad.center.y-(panel.elevation_mm+panel.height_mm/2))>1e-6) failures.push([panel.id,'vertical center']);
        const surface=quad.center.clone().addScaledVector(quad.normal,-DECAL_SURFACE_OFFSET_MM);
        const point=[surface.x,-surface.z];
        const matching=polygonSides(panel.outline).filter(side=>{
          const dx=side.b[0]-side.a[0],dy=side.b[1]-side.a[1];
          const length=Math.hypot(dx,dy);
          return Math.abs((point[0]-side.a[0])*dy-(point[1]-side.a[1])*dx)/length<.001;
        });
        if(!matching.some(side=>quad.width<=Math.hypot(side.b[0]-side.a[0],side.b[1]-side.a[1])+.001)) failures.push([panel.id,'surface fit']);
        if(quad.height>panel.height_mm) failures.push([panel.id,'height fit']);
      }
    }
    const meshes=state.view3d.decalMeshes.filter(m=>m.userData.elementType==='Панель');
    for(const mesh of meshes){
      if(mesh.material.side!==THREE.FrontSide) failures.push(['mesh','backface culling']);
      if(Array.from(mesh.geometry.getAttribute('aFlippable').array).some(x=>x!==0)) failures.push(['mesh','camera flip']);
    }
    return {count:panels.length,facades:panels.filter(e=>e.subtype==='фасадная').length,failures};
  });
  assert.ok(checked.facades===1457,JSON.stringify(checked));
  assert.deepEqual(checked.failures,[]);
  console.log('PASS',JSON.stringify(checked));
  await page.locator('.tab-btn[data-tab="view"]').click();
  await page.locator('input[data-type="Панель"]').check({force:true});
  assert.equal(await page.evaluate(()=>state.view3d.labelGroupByType.get('Панель').visible),true);
  await page.locator('input[data-type="Панель"]').uncheck({force:true});
  assert.equal(await page.evaluate(()=>state.view3d.labelGroupByType.get('Панель').visible),false);
  await page.locator('input[data-type="Панель"]').check({force:true});
  // Isolate a panel for screenshots so the frame does not occlude its inside label.
  await page.evaluate(()=>{
    for(const id of ['zhbi-show-external-models','zhbi-show-external-facades']){
      const cb=document.getElementById(id);cb.checked=false;cb.dispatchEvent(new Event('change'));
    }
    const panel=state.elements.find(e=>e.element_uid==='0922f85c32ec4bb190c79255b7006720');
    state.elements=[panel];build3DScene();
    for(const mesh of state.view3d.zoneMeshByLevel.values())mesh.visible=false;
  });
  for(const mode of ['normal','light']){
    if(mode==='light') await page.locator('#btn-view-3d-light').click();
    for(const side of [0,1]){
      await page.evaluate(side=>{
        const v=state.view3d,p=state.elements[0];
        const q=collectMarkDecalQuads(p,{subText:''},5,[],new Map())[side];
        v.camera.up.set(0,1,0);v.controls.target.copy(q.center);
        v.camera.position.copy(q.center).addScaledVector(q.normal,4500);
        v.controls.update();requestRender3D();
      },side);
      await page.waitForTimeout(300);
      await page.locator('#stage-3d canvas').screenshot({path:new URL(`${mode}-side-${side}.png`,output).pathname});
    }
  }
  assert.deepEqual(errors,[]);
  console.log('PASS type visibility toggle, both faces in normal and light 3D');
} finally {
  await browser.close();
}
