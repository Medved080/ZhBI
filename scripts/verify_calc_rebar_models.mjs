// Check steel upgrades on a disposable real_auth_server.py instance.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {launch} from './cdp.mjs';

const port=Number(process.argv[2]);
if(!port || [8000,8010,8020].includes(port))throw new Error('Use a disposable test server');
const reportPath=resolve(process.argv[3]||'tmp/rebar-models/import-result.json');
const imported=JSON.parse(readFileSync(reportPath,'utf8'));
const directory=resolve(process.argv[4]||'tmp/rebar-models/browser');mkdirSync(directory,{recursive:true});
const browser=await launch({width:1720,height:1080,
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
  await browser.goto(`http://127.0.0.1:${port}/`);
  const status=await browser.eval(`(async()=>{
    const response=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({domain_login:'admin',password:'Test-Pass-1234!'})});return response.status;
  })()`);
  if(status!==200)throw new Error('Test login failed: '+status);
  await browser.goto(`http://127.0.0.1:${port}/calc/`);
  await browser.waitFor("Boolean(window.CalcZhBIWorkspace && document.querySelector('#pc-product-count')?.textContent)",60000);
  await browser.eval(`(async()=>{
    window.__steelTestWorkspace=await window.CalcZhBIAPI.request('/calc/api/workspace?lite=1');
    window.__steelTestGeometry=await import('/calc/solid-geometry.js');
  })()`);
  const checked=[];
  for(const row of imported.models){
    const result=await browser.eval(`(async()=>{
      const row=${JSON.stringify(row)},api=window.CalcZhBIAPI;
      const entry=await api.request('/calc/api/document-models/'+row.id);
      const protocol=await api.request('/calc/api/document-models/'+row.id+'/qa');
      const product=window.__steelTestWorkspace.products.find(item=>item.product.documentModelId===row.id)?.product;
      if(!product || product.documentModel.modelReadiness.status!=='partial')throw new Error(row.alias+': missing/incorrect card');
      const solid=entry.solidModel;
      if(solid.supplyId!==row.supplyId || !solid.groups.length || protocol.qa.counts.failures)
        throw new Error(row.alias+': incorrect steel delivery');
      if(row.sourceId==='doc09' && /^1Р/.test(row.alias)){
        const wires=solid.groups.find(group=>group.id==='span-lower')?.paths.filter(path=>path.diameter===5);
        if(!wires?.length)throw new Error(row.alias+': missing lower mesh wires');
        const low=Math.min(...wires.map(path=>path.points[0][1]));
        const z=[...new Set(wires.filter(path=>Math.abs(path.points[0][1]-low)<.0001).map(path=>path.points[0][2]))].sort((a,b)=>a-b);
        if(z.length!==2 || Math.abs(z[1]-z[0]-175)>.0001)throw new Error(row.alias+': lower wire spacing regression');
      }
      const {solidPartGeometry,buildSolidModel}=window.__steelTestGeometry;
      let signedVolume=0;
      for(const part of solid.concreteParts){
        const geometry=solidPartGeometry(part),positions=geometry.getAttribute('position'),indices=geometry.getIndex();
        for(let i=0;i<(indices?.count||positions.count);i+=3){
          const [a,b,c]=[0,1,2].map(j=>{const n=indices?indices.getX(i+j):i+j;
            return [positions.getX(n),positions.getY(n),positions.getZ(n)];});
          signedVolume+=(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
        }geometry.dispose();
      }
      if(Math.abs(signedVolume/1e9-row.modelM3)>.000002)throw new Error(row.alias+': concrete changed');
      const built=buildSolidModel(solid),renderedGroups=new Set(),matrices=[];
      let barSegments=0,metalMeshes=0;
      built.steel.traverse(mesh=>{
        if(mesh.isInstancedMesh){
          renderedGroups.add(mesh.userData.record.id);barSegments+=mesh.count;
          const array=mesh.instanceMatrix.array;
          if(![...array].every(Number.isFinite))throw new Error(row.alias+': invalid bar placement');
          for(let i=0;i<mesh.count;i++)if(array[i*16+15]!==1)throw new Error(row.alias+': invalid instance transform');
        }else if(mesh.isMesh)metalMeshes++;
      });
      if(renderedGroups.size!==solid.groups.length || barSegments<row.segments || metalMeshes!==solid.metalParts.length)
        throw new Error(row.alias+': steel/metal omitted during rendering');
      for(const [id,layer] of built.layers)if(layer.userData.empty)throw new Error(row.alias+': empty layer '+id);
      for(const object of [built.concrete,built.edges,built.steel])object.traverse(child=>{
        child.geometry?.dispose();for(const material of Array.isArray(child.material)?child.material:[child.material])material?.dispose();
      });
      return {id:row.id,alias:row.alias,productId:product.id,sourceId:row.sourceId,
        layers:built.layers.size,barSegments,metalMeshes,groups:renderedGroups.size,concreteM3:signedVolume/1e9,
        paths:solid.groups.reduce((sum,group)=>sum+group.paths.length,0),qaWarnings:protocol.qa.counts.warnings};
    })()`);
    checked.push(result);console.log(`${result.alias}: ${result.groups} groups, ${result.paths} bars, ${result.metalMeshes} metal meshes`);
  }
  const representatives=[...new Set(checked.map(row=>row.sourceId))].map(source=>
    checked.filter(row=>row.sourceId===source).sort((a,b)=>b.metalMeshes-a.metalMeshes||b.paths-a.paths)[0]);
  const nextRigels=checked.filter(row=>/^Р(?:\d|к)/.test(row.alias));
  if(nextRigels.length>1){
    const shortest=[...nextRigels].sort((a,b)=>a.concreteM3-b.concreteM3)[0];
    const longest=[...nextRigels].sort((a,b)=>b.concreteM3-a.concreteM3)[0];
    for(const row of [shortest,longest])if(!representatives.some(item=>item.id===row.id))representatives.push(row);
  }
  const cards=[];
  for(const row of representatives){
    await browser.eval(`location.hash='product='+${JSON.stringify(row.productId)}`);
    await browser.waitFor(`document.querySelector('#pc-viewport')?.dataset.documentModel===${JSON.stringify(row.id)} && document.querySelector('#pc-viewport')?.dataset.modelReady==='true'`,30000);
    await browser.clickSel('#pc-tab-model');
    await browser.waitFor("document.querySelector('#pc-viewport canvas')?.getBoundingClientRect().height>300",15000);
    await browser.waitFor(`Number(document.querySelector('#pc-viewport')?.dataset.layerCount)>=${row.groups}`,15000);
    await browser.clickSel('#pc-steel');
    await browser.waitFor("document.querySelector('#pc-viewport').dataset.steel==='false'",5000);
    await browser.clickSel('#pc-steel');
    await browser.waitFor("document.querySelector('#pc-viewport').dataset.steel==='true'",5000);
    const layer=await browser.eval("document.querySelector('[data-layer]:not(:disabled)')?.dataset.layer");
    if(!layer)throw new Error(row.alias+': no steel layer controls');
    const selector=`[data-layer=${JSON.stringify(layer)}]`;
    await browser.clickSel(selector);
    if(await browser.eval(`document.querySelector(${JSON.stringify(selector)}).closest('label').dataset.visible`)!=='false')
      throw new Error(row.alias+': cannot hide steel layer');
    await browser.clickSel(selector);await browser.sleep(400);
    const file=resolve(directory,row.sourceId+'-'+row.id+'-steel.png');await browser.shot(file);
    cards.push({alias:row.alias,file,steelTogglePassed:true,layerTogglePassed:true});
  }
  const errors=browser.consoleLog.filter(item=>item.type==='error');
  if(browser.exceptions.length || errors.length)throw new Error('Browser errors: '+JSON.stringify({exceptions:browser.exceptions,errors}));
  const report={checkedAt:new Date().toISOString(),modelCount:checked.length,models:checked,cards,
    exceptions:browser.exceptions,consoleErrors:errors};
  writeFileSync(resolve(directory,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({modelCount:checked.length,cards:cards.map(row=>row.alias),errors:0}));
}finally{await browser.close();}
