// Run only against the disposable real_auth_server.py instance, never production.
// Checks API/QA, the actual Three.js triangulation of every new part, and cards.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {launch} from './cdp.mjs';

const port = Number(process.argv[2]);
if (!port || [8000, 8010, 8020].includes(port)) throw new Error('Use a disposable test server port');
const reportPath = resolve(process.argv[3] || 'tmp/quick-models/import-result.json');
const directory = resolve('tmp/quick-models/browser');
mkdirSync(directory, {recursive: true});
const imported = JSON.parse(readFileSync(reportPath, 'utf8'));
const base = `http://127.0.0.1:${port}`;
const browser = await launch({width: 1720, height: 1080,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
try {
  await browser.goto(base + '/');
  const login = await browser.eval(`(async()=>{
    const response=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({domain_login:'admin',password:'Test-Pass-1234!'})});
    return {status:response.status};
  })()`);
  if (login.status !== 200) throw new Error('Test login failed: ' + login.status);
  await browser.goto(base + '/calc/');
  await browser.waitFor("Boolean(window.CalcZhBIWorkspace && document.querySelector('#pc-product-count')?.textContent)", 60000);
  const checked = await browser.eval(`(async()=>{
    const rows=${JSON.stringify(imported.models)};
    const {solidPartGeometry,buildSolidModel}=await import('/calc/solid-geometry.js');
    const workspace=await window.CalcZhBIAPI.request('/calc/api/workspace?lite=1');
    const results=[];
    for(const row of rows){
      const entry=await window.CalcZhBIAPI.request('/calc/api/document-models/'+row.id);
      const protocol=await window.CalcZhBIAPI.request('/calc/api/document-models/'+row.id+'/qa');
      const product=workspace.products.find(p=>p.product.documentModelId===row.id)?.product;
      if(!product)throw new Error(row.alias+': absent from calculator');
      if(product.documentModel.modelReadiness.status!=='partial')throw new Error(row.alias+': incorrect readiness');
      if(product.documentModel.preview3d)throw new Error(row.alias+': old envelope retained');
      if(protocol.qa.counts.failures || !protocol.pending.length)throw new Error(row.alias+': invalid QA/limits');
      let signedVolume=0,triangles=0;
      for(const part of entry.solidModel.concreteParts){
        const geometry=solidPartGeometry(part),positions=geometry.getAttribute('position'),indices=geometry.getIndex();
        const count=indices?.count||positions.count;
        for(let i=0;i<count;i+=3){
          const points=[0,1,2].map(j=>{const n=indices?indices.getX(i+j):i+j;
            return [positions.getX(n),positions.getY(n),positions.getZ(n)];});
          if(!points.flat().every(Number.isFinite))throw new Error(row.alias+': invalid rendered vertices');
          const [a,b,c]=points;
          signedVolume+=(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
          triangles++;
        }
        geometry.dispose();
      }
      const renderedM3=signedVolume/1e9;
      if(!(renderedM3>0) || Math.abs(renderedM3-row.modelM3)>0.000002)
        throw new Error(row.alias+': rendered volume differs: '+renderedM3+' / '+row.modelM3);
      const built=buildSolidModel(entry.solidModel);
      if(!built.concrete.children.length || !built.edgeRecords.length || !built.size.toArray().every(v=>v>0))
        throw new Error(row.alias+': empty rendered assembly');
      for(const object of [built.concrete,built.edges,built.steel])object.traverse(child=>{
        child.geometry?.dispose();
        for(const material of Array.isArray(child.material)?child.material:[child.material])material?.dispose();
      });
      results.push({alias:row.alias,id:row.id,productId:product.id,triangles,renderedM3,
        readiness:product.documentModel.modelReadiness.status,qaWarnings:protocol.qa.counts.warnings});
    }
    return results;
  })()`);
  const cards = [];
  for (const [alias, file] of [['1Р1','rigel'],['ПЦ-35','plinth-step'],['ПЦ-33-1','plinth-notch'],['ШЛ16.1','shaft']]) {
    const row = checked.find(item=>item.alias===alias);
    if (!row) throw new Error('Missing representative: '+alias);
    await browser.eval(`location.hash='product='+${JSON.stringify(row.productId)}`);
    await browser.waitFor(`document.querySelector('#pc-viewport')?.dataset.documentModel===${JSON.stringify(row.id)} && document.querySelector('#pc-viewport')?.dataset.modelReady==='true'`, 30000);
    await browser.clickSel('#pc-tab-model');
    await browser.waitFor("document.querySelector('#pc-viewport canvas')?.getBoundingClientRect().height>300", 15000);
    await browser.sleep(350);
    const card = await browser.eval(`(()=>{
      const host=document.querySelector('#pc-viewport');
      return {quality:host.dataset.modelQuality,extents:host.dataset.rulerExtents,
        edges:Number(host.dataset.edgeDimensions),canvasVisible:!host.querySelector('canvas')?.hidden && host.getBoundingClientRect().height>300,
        caption:document.querySelector('#pc-model-caption')?.textContent,
        info:document.querySelector('#pc-document-info')?.textContent};
    })()`);
    if(card.quality!=='source-partial' || !card.edges || !card.canvasVisible)
      throw new Error(alias+': rendered card not ready: '+JSON.stringify(card));
    await browser.shot(resolve(directory,file+'.png'));
    cards.push({alias,...card});
  }
  if(browser.exceptions.length)throw new Error('Browser exceptions: '+JSON.stringify(browser.exceptions));
  const result={checkedAt:new Date().toISOString(),modelCount:checked.length,models:checked,cards,
    exceptions:browser.exceptions,consoleErrors:browser.consoleLog.filter(line=>line.type==='error')};
  writeFileSync(resolve(directory,'verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({modelCount:checked.length,cards:cards.map(card=>card.alias),exceptions:0,
    consoleErrors:result.consoleErrors,report:resolve(directory,'verification.json')},null,2));
} finally {
  await browser.close();
}
