import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {buildDrawing} from './drawing-geometry.js';
import {buildSolidModel} from './solid-geometry.js?v=20261003-seven-wire-2';
import {buildProjectSketch} from './sketch-geometry.js?v=20261002-short-rigels-3';
import {prismEdges,drawingEdges} from './edge-dimensions.js';

const host=document.getElementById('pc-viewport');
const viewer=document.querySelector('.pc-viewer');
try {
 const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
 renderer.setPixelRatio(Math.min(devicePixelRatio,2));
 renderer.outputColorSpace=THREE.SRGBColorSpace;
 renderer.domElement.setAttribute('aria-hidden','true');
 host.querySelector('.pc-view-loading')?.remove();host.prepend(renderer.domElement);
 const scene=new THREE.Scene();
 const camera=new THREE.PerspectiveCamera(35,1,.01,200);
 const controls=new OrbitControls(camera,renderer.domElement);
 controls.enableDamping=true;controls.dampingFactor=.12;controls.minDistance=.4;controls.maxDistance=100;controls.rotateSpeed=.7;
 controls.target.set(0,0,0);
 scene.add(new THREE.HemisphereLight(0xffffff,0x788899,2.1));
 const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(3,8,4);scene.add(sun);
 const grid=new THREE.GridHelper(14,28,0xa6b7c9,0xcbd5df);grid.material.transparent=true;grid.material.opacity=.33;scene.add(grid);
 const dimensionsControl=document.getElementById('pc-dimensions'),rulersControl=document.getElementById('pc-rulers');
 try{const saved=localStorage.getItem('calczhbi.dimensionMode');if(['none','outer','detail'].includes(saved))dimensionsControl.value=saved;rulersControl.checked=localStorage.getItem('calczhbi.rulers')!=='false';}catch{}
 const dimensionSummary=document.createElement('span');dimensionSummary.className='pc-dimension-summary';host.append(dimensionSummary);
 const svgNS='http://www.w3.org/2000/svg',annotations=document.createElementNS(svgNS,'svg');
 annotations.classList.add('pc-model-annotations');annotations.setAttribute('aria-hidden','true');host.append(annotations);
 let group=new THREE.Group(),concrete,edges,steel,edgeLabels=[],overallLabels=[],rulerBounds=null,key='',modelSize=new THREE.Vector3(8,1,1),layers=new Map(),modelRequest=0,annotationKey='';
 const modelCache=new Map(),layerControls=document.getElementById('pc-model-layers'),pickInfo=document.getElementById('pc-model-pick');
 const numberFormat=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}),formatMM=value=>numberFormat.format(Math.abs(value)<.05?0:value);
 const textMeasure=document.createElement('canvas').getContext('2d');
 scene.add(group);
 // Stable semantic types: independent of model, group order, diameter and source colour.
 const colorTypes={
  concrete:['Бетон','#95a6b7'],longitudinal:['Продольная / рабочая арматура','#c43b28'],secondary:['Вторая группа рабочих стержней','#ffc233'],
  'nets-sn':['Сетки СН / нижние','#148d2c'],'nets-sv':['Сетки СВ / верхние','#1d5fd1'],frames:['Поперечные каркасы КК / КР','#a120d3'],
  spirals:['Спирали','#00a6a6'],lifting:['Монтажные петли','#db3b95'],console:['Основная арматура консоли','#5b6218'],
  pipes:['Трубы (общая группа)','#424242'],tube68:['Трубы Ø68','#99ff33'],tube50:['Трубы Ø50','#271862'],oc1:['Стержни Ос1','#5b6218'],
  short:['Короткие стержни','#33ffff'],additional:['Дополнительные стержни','#5b6218'],'console-edge':['Краевые стержни консоли','#4778eb'],
  'console-horizontal':['Горизонтальные стержни консоли','#184c62'],'console-inclined':['Наклонные стержни консоли','#18624c'],
  'bent-full':['Отгибы основного участка','#3385ff'],'bent-ledge':['Отгибы уступа','#201862'],spacers:['Распорки','#00f562'],
  ties:['Стержни Ш1','#00f562'],'mesh-main':['Рабочие стержни сеток','#0c2a6e'],'mesh-cross':['Поперечные стержни сеток','#3b9325'],embedded:['Закладные детали','#303030'],anchors:['Анкеры закладных','#33ffad'],markers:['Неподтверждённые окончания','#e6a52a']
 };
 const typeAliases={longitudinal:'longitudinal','main-bars':'longitudinal',main:'longitudinal','main-1':'longitudinal','main-2':'secondary','bars-pos2':'secondary',
  'bottom-mesh':'nets-sn',SN:'nets-sn','nets-sn':'nets-sn','top-mesh':'nets-sv',SV:'nets-sv','nets-sv':'nets-sv',
  'cross-mesh':'frames',KK:'frames','frames-kk':'frames',spiral:'spirals',spirals:'spirals',P1:'lifting',loops:'lifting',lifting:'lifting',
  console:'console','console-main':'console','console-stirrups':'frames',pipes:'pipes',pipe:'pipes',supplement:'additional','anchors-zd':'anchors',plate:'embedded',metal:'embedded','rigel-cage-main':'longitudinal','rigel-cage-cross':'frames','rigel-mesh-main':'mesh-main','rigel-mesh-cross':'mesh-cross','rigel-bottom':'additional','rigel-lifting':'lifting','rigel-ties':'ties'};
 // Co-occurrence sets from the 58 current reinforced models, plus the manual preview.
 // Types that never occur together can reuse a colour; their assignment stays fixed.
 const colorCombinations=[["additional","bent-full","bent-ledge","concrete","embedded","frames","lifting","longitudinal","markers","spacers"],["additional","concrete","frames","lifting","longitudinal","markers","mesh-cross","mesh-main","ties"],["additional","concrete","frames","lifting","longitudinal","nets-sn","nets-sv","secondary","spirals","tube50","tube68"],["additional","concrete","frames","lifting","longitudinal","nets-sn","nets-sv","spirals","tube50","tube68"],["anchors","concrete","embedded","frames","lifting","longitudinal","nets-sn","nets-sv","oc1","secondary","spirals","tube68"],["anchors","concrete","embedded","frames","lifting","longitudinal","nets-sn","nets-sv","oc1","spirals","tube50","tube68"],["anchors","concrete","embedded","frames","lifting","longitudinal","nets-sn","nets-sv","oc1","spirals","tube68"],["concrete","console","console-edge","console-horizontal","console-inclined","frames","lifting","longitudinal","markers","nets-sn","short","tube50","tube68"],["concrete","console","frames","lifting","longitudinal","nets-sn","nets-sv","pipes","spirals"],["concrete","frames","lifting","longitudinal","nets-sn","nets-sv","oc1","secondary","spirals","tube68"],["concrete","frames","lifting","longitudinal","nets-sn","nets-sv","oc1","spirals","tube50","tube68"],["concrete","frames","lifting","longitudinal","nets-sn","nets-sv","oc1","spirals","tube68"],["concrete","longitudinal","frames"]];
 const paletteStorage='calczhbi.elementColors.v1',palette={},hexColor=/^#[0-9a-f]{6}$/i;
 // CIELAB distance is computed from sRGB, rather than comparing hex numbers or hue alone.
 function colorLab(hex){
  const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4),[r,g,b]=rgb;
  const [x,y,z]=[(.4124564*r+.3575761*g+.1804375*b)/.95047,.2126729*r+.7151522*g+.072175*b,(.0193339*r+.119192*g+.9503041*b)/1.08883].map(v=>v>.008856?v**(1/3):7.787*v+16/116);
  return [116*y-16,500*(x-y),200*(y-z)];
 }
 const colorDistance=(a,b)=>Math.hypot(...colorLab(a).map((v,i)=>v-colorLab(b)[i]));
 function paletteConflict(candidate){
  const entries=Object.entries(candidate);
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++)if(colorCombinations.some(types=>types.includes(entries[i][0])&&types.includes(entries[j][0]))&&colorDistance(entries[i][1],entries[j][1])<25)return [entries[i][0],entries[j][0]];
  return null;
 }
 for(const [type,[,color]] of Object.entries(colorTypes))palette[type]=color;
 try{
  const saved=JSON.parse(localStorage.getItem(paletteStorage)||'{}'),candidate={...palette};
  for(const type of Object.keys(palette))if(hexColor.test(saved?.[type]||''))candidate[type]=saved[type].toLowerCase();
  if(!paletteConflict(candidate))Object.assign(palette,candidate);
 }catch{}
 function layerColorType(id,layer){
  const tubeDiameter=/Труб[аы]\s+(68|50)(?:[×xх]|\b)/i.exec(layer.userData.record?.name||'');
  const type=['pipe','tube'].includes(id)&&tubeDiameter?'tube'+tubeDiameter[1]:(typeAliases[id]||id);
  if(!colorTypes[type]){
   // New source groups get a separate persistent type, never an order-based recycled colour.
   let best='#000000',distance=-1;
   for(let r=16;r<256;r+=32)for(let g=16;g<256;g+=32)for(let b=16;b<256;b+=32){
    const color='#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join(''),d=Math.min(...Object.values(palette).map(c=>colorDistance(color,c)));
    if(d>distance){best=color;distance=d;}
   }
   colorTypes[type]=[layer.userData.record?.shortLabel||layer.userData.record?.name||id,best];palette[type]=best;
   try{const saved=JSON.parse(localStorage.getItem(paletteStorage)||'{}');if(hexColor.test(saved?.[type]||'')){const candidate={...palette,[type]:saved[type]};if(!paletteConflict(candidate))palette[type]=saved[type];}}catch{}
  }
  return type;
 }
 function applyPalette(){
  const paint=(object,color,markers=false)=>object?.traverse(mesh=>{
   if(!mesh.isMesh)return;
   const isMarker=mesh.geometry?.type==='SphereGeometry'&&!!mesh.userData.record;if(isMarker!==markers)return;
   for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])material?.color?.set(color);
  });
  paint(concrete,palette.concrete);
  const activeTypes=['concrete',...(modelColors(steel,true).length?['markers']:[]),...[...layers].map(([id,layer])=>layerColorType(id,layer))];
  if(!colorCombinations.some(types=>activeTypes.every(type=>types.includes(type))))colorCombinations.push(activeTypes);
  for(const [id,layer] of layers){const type=layerColorType(id,layer);layer.userData.colorType=type;paint(layer,palette[type]);paint(layer,palette.markers,true);}
  if(!layers.size)steel?.traverse(mesh=>{if(mesh.isMesh)for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])material?.color?.set(palette[mesh.userData.colorType||'longitudinal']);});
 }
 const paletteDialog=document.createElement('dialog');paletteDialog.id='pc-palette-dialog';paletteDialog.setAttribute('aria-labelledby','pc-palette-title');
 paletteDialog.innerHTML='<div class="pc-palette-heading"><h2 id="pc-palette-title">Цвета элементов 3D</h2><button type="button" id="pc-palette-close" aria-label="Закрыть настройки цветов">×</button></div><p>Один цвет для каждого типа на всех изделиях. Настройки сохраняются в этом браузере. Цвета типов, встречающихся на одной схеме, должны заметно отличаться.</p><div class="pc-palette-grid"></div><p id="pc-palette-status" role="status" aria-live="polite"></p><button type="button" id="pc-palette-reset">Вернуть стандартные цвета</button>';
 viewer.append(paletteDialog);
 const paletteGrid=paletteDialog.querySelector('.pc-palette-grid'),paletteStatus=paletteDialog.querySelector('#pc-palette-status');
 function savePalette(){try{localStorage.setItem(paletteStorage,JSON.stringify(palette));paletteStatus.textContent='Цвета сохранены для всех изделий.';}catch{paletteStatus.textContent='Цвета применены. Браузер не разрешил сохранить их после перезагрузки.';}}
 function refreshPalette(){
  applyPalette();
  for(const [id,layer] of layers){
   const label=[...layerControls.querySelectorAll('label')].find(l=>l.dataset.layerId===id);if(!label)continue;
   const colors=modelColors(layer),input=label.querySelector('input');label.querySelector('.pc-layer-swatch')?.replaceWith(colorSwatch(colors));
   if(colors.length)input.style.accentColor=colors[0];
  }
  updateColorLegend();
 }
 function renderPaletteSettings(){
  paletteGrid.replaceChildren();
  for(const [type,[name]] of Object.entries(colorTypes)){
   const label=document.createElement('label'),input=document.createElement('input');input.type='color';input.value=palette[type];input.dataset.colorType=type;input.setAttribute('aria-label','Цвет: '+name);
   label.append(input,document.createTextNode(name));paletteGrid.append(label);
   input.addEventListener('change',()=>{
    const candidate={...palette,[type]:input.value.toLowerCase()},conflict=paletteConflict(candidate);
    if(conflict){paletteStatus.textContent='Цвета «'+colorTypes[conflict[0]][0]+'» и «'+colorTypes[conflict[1]][0]+'» слишком близки. Выберите другой цвет.';input.value=palette[type];return;}
    Object.assign(palette,candidate);refreshPalette();savePalette();
   });
  }
 }
 document.getElementById('pc-palette-open').addEventListener('click',()=>{renderPaletteSettings();paletteStatus.textContent='';paletteDialog.showModal();});
 paletteDialog.querySelector('#pc-palette-close').addEventListener('click',()=>paletteDialog.close());
 paletteDialog.querySelector('#pc-palette-reset').addEventListener('click',()=>{for(const [type,[,color]] of Object.entries(colorTypes))palette[type]=color;refreshPalette();savePalette();renderPaletteSettings();});
 function modelColors(object,markers=false){
  const colors=new Set();
  object?.traverse(mesh=>{
   if(!mesh.isMesh||mesh.count===0)return;
   const isMarker=mesh.geometry?.type==='SphereGeometry'&&!!mesh.userData.record;
   if(isMarker!==markers)return;
   for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])if(material?.color)colors.add('#'+material.color.getHexString(THREE.SRGBColorSpace));
  });
  return [...colors];
 }
 function colorSwatch(colors){
  const swatch=document.createElement('span');swatch.className='pc-layer-swatch';swatch.setAttribute('aria-hidden','true');swatch.dataset.colors=colors.join(',');
  for(const color of colors){const part=document.createElement('span');part.style.backgroundColor=color;swatch.append(part);}
  if(!colors.length)swatch.classList.add('pc-layer-swatch-empty');
  return swatch;
 }
 function addLayerControl(id,layer,title){
  const label=document.createElement('label'),input=document.createElement('input'),record=layer.userData.record,colors=modelColors(layer),empty=!!layer.userData.empty;
  input.type='checkbox';input.checked=!empty;input.disabled=empty;input.dataset.layer=id;input.setAttribute('aria-label',record.name);
  if(colors.length)input.style.accentColor=colors[0];
  label.title=record.name;label.dataset.layerId=id;label.dataset.visible=String(input.checked);label.dataset.empty=String(empty);
  label.append(input,colorSwatch(colors),document.createTextNode(title+(empty?' · не размещено':'')));
  input.addEventListener('change',()=>{layer.visible=input.checked;label.dataset.visible=String(input.checked);});layerControls.append(label);
 }
 function updateColorLegend(){
  for(const [id,object] of [['pc-concrete',concrete],['pc-steel',steel]]){
   const input=document.getElementById(id),label=input.closest('label'),colors=modelColors(object);label.querySelector('.pc-layer-swatch')?.remove();
   if(colors.length){input.style.accentColor=colors[0];input.after(colorSwatch(colors));}else input.style.removeProperty('accent-color');
  }
  layerControls.querySelector('.pc-marker-legend')?.remove();
  const colors=modelColors(steel,true);
  if(colors.length){
   const item=document.createElement('span');item.className='pc-marker-legend';item.title='Цветные точки обозначают неподтверждённые окончания, а не места отрезки.';
   const swatch=colorSwatch(colors);swatch.classList.add('pc-marker-swatch');item.append(swatch,document.createTextNode('Окончания · требуют уточнения'));layerControls.append(item);
  }
 }
 function disposeModel(){
  group.traverse(object=>{object.geometry?.dispose();if(object.material){for(const material of Array.isArray(object.material)?object.material:[object.material]){material.map?.dispose();material.dispose();}}});
  group.clear();edgeLabels=[];overallLabels=[];rulerBounds=null;annotations.replaceChildren();annotationKey='';
 }
 function rod(start,end,radius,material){
  const delta=new THREE.Vector3().subVectors(end,start);
  const mesh=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,delta.length(),8),material);
  mesh.position.copy(start).add(end).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return mesh;
 }
 function addEdgeDimensions(records,transform,known=true){
  edgeLabels=records.map(record=>{
   const a=transform(record.a),b=transform(record.b);
   return {a,b,midpoint:a.clone().add(b).multiplyScalar(.5),normals:record.normals.map(n=>new THREE.Vector3(...n)),length:record.length};
  });
  const vertices=records.flatMap(e=>[e.a,e.b]),lo=[0,1,2].map(i=>Math.min(...vertices.map(p=>p[i]))),hi=[0,1,2].map(i=>Math.max(...vertices.map(p=>p[i])));
  const box=new THREE.Box3().setFromPoints(vertices.map(transform));
  rulerBounds=known?{lo,hi,box}:null;
  // Overall spans use concrete extrema, never reinforcement/release bounds.
  overallLabels=[0,1,2].map(axis=>{
   const starts=vertices.filter(p=>Math.abs(p[axis]-lo[axis])<.01),ends=vertices.filter(p=>Math.abs(p[axis]-hi[axis])<.01),pairs=[];
   for(const a of starts)for(const b of ends){
    const score=a.reduce((s,v,i)=>s+(i===axis?0:(v-b[i])**2),0),virtual=b.map((v,i)=>i===axis?v:a[i]);
    if(pairs.some(p=>p.anchorA.distanceToSquared(transform(a))<1e-8&&p.anchorB.distanceToSquared(transform(b))<1e-8))continue;
    pairs.push({score,a:transform(a),b:transform(virtual),anchorA:transform(a),anchorB:transform(b)});
   }
   pairs.sort((a,b)=>a.score-b.score);
   const best=pairs[0].score;
   return {axis,text:['Д','В','Ш'][axis]+' · '+(known?formatMM(hi[axis]-lo[axis])+' мм':'не задана'),candidates:pairs.filter(p=>p.score<=best+.01)};
  });
  host.dataset.edgeDimensions=String(records.length);host.dataset.rulerExtents=known?hi.map((v,i)=>v-lo[i]).join(','):'';
  dimensionSummary.textContent=known?'Внешние размеры бетонного контура; подробные размеры рёбер со стрелками. Все значения в миллиметрах.':'Габариты не заданы; размерные выноски относятся к условной схеме. Шкала в миллиметрах недоступна.';
  annotationKey='';
 }
 function positionAnnotations(){
  const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;
  camera.updateMatrixWorld();
  const signature=[w,h,dimensionsControl.value,rulersControl.checked,...camera.matrixWorld.elements,...camera.projectionMatrix.elements].join(',');
  if(signature===annotationKey)return;annotationKey=signature;annotations.replaceChildren();annotations.setAttribute('viewBox',`0 0 ${w} ${h}`);
  if(!edgeLabels.length){dimensionSummary.hidden=true;host.dataset.visibleEdgeDimensions='0';host.dataset.rulers='false';return;}
  host.dataset.dimensionMode=dimensionsControl.value;host.dataset.rulers=String(rulersControl.checked&&!!rulerBounds);
  dimensionSummary.hidden=dimensionsControl.value==='none';
  const occupied=[],leaderSegments=[],shown=[],rulerSteps=[];
  const screen=p=>{const n=p.clone().project(camera);return {x:(n.x+1)*w/2,y:(1-n.y)*h/2,z:n.z};};
  const valid=p=>p.z>=-1&&p.z<=1&&Number.isFinite(p.x)&&Number.isFinite(p.y);
  const node=(tag,attrs={},text)=>{const n=document.createElementNS(svgNS,tag);for(const [key,value] of Object.entries(attrs))n.setAttribute(key,value);if(text!==undefined)n.textContent=text;annotations.append(n);return n;};
  const segment=(a,b,attrs={})=>node('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,...attrs});
  const collides=rect=>rect.left<5||rect.right>w-5||rect.top<5||rect.bottom>h-5||occupied.some(r=>rect.left<r.right+4&&rect.right>r.left-4&&rect.top<r.bottom+3&&rect.bottom>r.top-3);
  const labelRect=(text,x,y,small=false)=>{textMeasure.font=`600 ${small?10:11}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;const width=Math.ceil(textMeasure.measureText(text).width)+(small?8:14),height=small?16:22;return {left:x-width/2,right:x+width/2,top:y-height/2,bottom:y+height/2};};
  const dimensionText=(text,x,y,rect)=>{
   node('rect',{x:rect.left,y:rect.top,width:rect.right-rect.left,height:rect.bottom-rect.top,rx:3,class:'pc-dimension-box'});
   node('text',{x,y,'text-anchor':'middle','dominant-baseline':'central',class:'pc-dimension-text'},text);occupied.push(rect);
  };
  const arrow=(tip,towards)=>{const dx=towards.x-tip.x,dy=towards.y-tip.y,n=Math.hypot(dx,dy);if(n<1)return;const ux=dx/n,uy=dy/n;node('path',{d:`M${tip.x+ux*6-uy*2.5},${tip.y+uy*6+ux*2.5} L${tip.x},${tip.y} L${tip.x+ux*6+uy*2.5},${tip.y+uy*6-ux*2.5}`,class:'pc-dimension-line'});};
  const center=screen(new THREE.Vector3());
  const outward=(a,b,p)=>{const dx=b.x-a.x,dy=b.y-a.y,n=Math.hypot(dx,dy);let x=-dy/n,y=dx/n;if(x*(p.x-center.x)+y*(p.y-center.y)<0){x=-x;y=-y;}return {x,y,n};};
  if(rulersControl.checked&&rulerBounds){
   const {lo,hi,box}=rulerBounds,offset=.36;
   for(const axis of [0,1,2]){
    const a=box.min.clone(),b=box.min.clone();
    if(axis===0){a.y-=offset;a.z=box.max.z+offset;}if(axis===1){a.x-=offset;a.z=box.max.z+offset;}if(axis===2){a.x=box.max.x+offset;a.y-=offset;}
    b.copy(a).setComponent(axis,box.max.getComponent(axis));
    const sa=screen(a),sb=screen(b);if(!valid(sa)||!valid(sb))continue;
    const mid={x:(sa.x+sb.x)/2,y:(sa.y+sb.y)/2},normal=outward(sa,sb,mid),color=['#a34545','#367253','#486db2'][axis];if(normal.n<.5)continue;
    segment(sa,sb,{stroke:color,'stroke-width':1.5});
    const span=hi[axis]-lo[axis],desired=span/Math.max(1,Math.min(80,normal.n/75)),power=10**Math.floor(Math.log10(desired)),step=[1,2,5,10].map(v=>v*power).find(v=>v>=desired*.8);
    rulerSteps.push(step);
    const rulerPoint=value=>a.clone().setComponent(axis,box.min.getComponent(axis)+(value-lo[axis])/span*(box.max.getComponent(axis)-box.min.getComponent(axis)));
    if(normal.n*step/span>30){
     const minor=step/5;
     for(let value=Math.ceil(lo[axis]/minor)*minor;value<hi[axis];value+=minor){
      if(Math.abs(value/step-Math.round(value/step))<.001)continue;
      const p=screen(rulerPoint(value));if(!valid(p)||p.x<0||p.x>w||p.y<0||p.y>h)continue;
      segment(p,{x:p.x+normal.x*2.5,y:p.y+normal.y*2.5},{stroke:color,'stroke-width':.8});
     }
    }
    const ticks=[lo[axis]];for(let value=Math.ceil((lo[axis]+step*.001)/step)*step;value<hi[axis]-step*.001;value+=step)ticks.push(value);ticks.push(hi[axis]);
    // Ends get priority; interior labels yield when projection becomes too tight.
    for(const value of [ticks[0],ticks.at(-1),...ticks.slice(1,-1)]){
     const p=screen(rulerPoint(value));if(!valid(p))continue;
     segment({x:p.x-normal.x*3,y:p.y-normal.y*3},{x:p.x+normal.x*4,y:p.y+normal.y*4},{stroke:color,'stroke-width':1});
     const text=formatMM(value);
     for(const distance of [15,31,47]){
      const x=p.x+normal.x*distance,y=p.y+normal.y*distance,rect=labelRect(text,x,y,true);
      if(collides(rect))continue;
      if(distance>15)segment({x:p.x+normal.x*4,y:p.y+normal.y*4},{x:x-normal.x*8,y:y-normal.y*8},{stroke:color,'stroke-width':.7,opacity:.65});
      node('text',{x,y,fill:color,'text-anchor':'middle','dominant-baseline':'central',class:'pc-ruler-text'},text);occupied.push(rect);break;
     }
    }
    const text=['X · мм','Y · мм','Z · мм'][axis];
    for(const distance of [34,54,-20,74,-40]){
     const x=mid.x+normal.x*distance,y=mid.y+normal.y*distance,rect=labelRect(text,x,y,true);
     if(collides(rect))continue;node('text',{x,y,fill:color,'text-anchor':'middle','dominant-baseline':'central',class:'pc-ruler-text'},text);occupied.push(rect);break;
    }
   }
  }
  if(dimensionsControl.value!=='none'){
   for(const entry of overallLabels){
    const candidates=entry.candidates.map(pair=>({...pair,mid:pair.a.clone().add(pair.b).multiplyScalar(.5)})).sort((a,b)=>a.mid.distanceToSquared(camera.position)-b.mid.distanceToSquared(camera.position));
    let placed=false;
    for(const pair of candidates){
     const sa=screen(pair.a),sb=screen(pair.b),aa=screen(pair.anchorA),ab=screen(pair.anchorB);if(![sa,sb,aa,ab].every(valid))continue;
     const mid={x:(sa.x+sb.x)/2,y:(sa.y+sb.y)/2},normal=outward(sa,sb,mid);
     if(normal.n<.5)continue;
     for(const offset of [38,60,82,-38,-60,-82,104]){
      const start={x:sa.x+normal.x*offset,y:sa.y+normal.y*offset},end={x:sb.x+normal.x*offset,y:sb.y+normal.y*offset},x=(start.x+end.x)/2,y=(start.y+end.y)/2,rect=labelRect(entry.text,x,y);
      if(collides(rect)||[start,end].some(p=>p.x<3||p.x>w-3||p.y<3||p.y>h-3))continue;
      segment(aa,start,{class:'pc-dimension-line',opacity:.65});segment(ab,end,{class:'pc-dimension-line',opacity:.65});segment(start,end,{class:'pc-dimension-line'});arrow(start,end);arrow(end,start);
      dimensionText(entry.text,x,y,rect);placed=true;break;
     }
     if(placed)break;
    }
   }
  }
  if(dimensionsControl.value==='detail'&&rulerBounds){
   // Reject leaders through existing labels and crossing other leaders.
   const crosses=(a,b,c,d)=>{const cross=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);return cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0;};
   const cutsLabel=(a,b)=>occupied.some(r=>{
    const corners=[{x:r.left-2,y:r.top-2},{x:r.right+2,y:r.top-2},{x:r.right+2,y:r.bottom+2},{x:r.left-2,y:r.bottom+2}];
    return corners.some((p,i)=>crosses(a,b,p,corners[(i+1)%4]));
   });
   for(const entry of [...edgeLabels].sort((a,b)=>a.midpoint.distanceToSquared(camera.position)-b.midpoint.distanceToSquared(camera.position))){
    const {a,b,midpoint,normals}=entry,direction=camera.position.clone().sub(midpoint).normalize();if(!normals.some(n=>n.dot(direction)>.035))continue;
    const p=screen(midpoint),sa=screen(a),sb=screen(b);if(!valid(p)||p.x<4||p.x>w-4||p.y<4||p.y>h-4)continue;
    const normal=outward(sa,sb,p);if(normal.n<14)continue;
    const text=formatMM(entry.length)+' мм';
    for(const offset of [24,42,62,-24,-42,-62,84,-84]){
     const x=p.x+normal.x*offset,y=p.y+normal.y*offset,rect=labelRect(text,x,y);if(collides(rect))continue;
     const factor=Math.min((rect.right-rect.left)/2/Math.max(.001,Math.abs(x-p.x)),(rect.bottom-rect.top)/2/Math.max(.001,Math.abs(y-p.y)));
     const end={x:x+(p.x-x)*factor,y:y+(p.y-y)*factor};
     if(cutsLabel(p,end)||leaderSegments.some(([c,d])=>crosses(p,end,c,d)))continue;
     segment(p,end,{class:'pc-dimension-line'});arrow(p,end);dimensionText(text,x,y,rect);
     leaderSegments.push([p,end]);shown.push(entry.length);break;
    }
   }
  }
  host.dataset.visibleEdgeDimensions=String(shown.length);host.dataset.visibleEdgeLengths=shown.join(',');host.dataset.rulerSteps=rulerSteps.join(',');
 }
 let preferredDirection=new THREE.Vector3(.15,.22,.96).normalize();
 function home(direction=preferredDirection){
  const damping=controls.enableDamping;controls.enableDamping=false;controls.update();controls.target.set(0,0,0);
  const right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),direction).normalize(),up=new THREE.Vector3().crossVectors(direction,right).normalize();
  const size=modelSize.clone();if(rulersControl.checked&&rulerBounds)size.addScalar(.45);
  const projected=axis=>Math.abs(axis.x)*size.x+Math.abs(axis.y)*size.y+Math.abs(axis.z)*size.z;
  const tangent=Math.tan(THREE.MathUtils.degToRad(camera.fov/2)),hasAnnotations=dimensionsControl.value!=='none'||rulersControl.checked;
  const paddingX=hasAnnotations?Math.min(.4,100/Math.max(1,host.clientWidth)):0,paddingY=hasAnnotations?Math.min(.4,40/Math.max(1,host.clientHeight)):0;
  const distance=(Math.max(projected(up)/(2*tangent*(1-paddingY)),projected(right)/(2*tangent*camera.aspect*(1-paddingX)))+projected(direction)/2)*1.08;
  camera.position.copy(controls.target).addScaledVector(direction,distance);controls.update();controls.enableDamping=damping;annotationKey='';
 }
 async function setProduct(spec){
  const request=++modelRequest;let drawing=null;
  if(spec.registry&&!spec.preview3d&&!spec.solidModel){
   key='';disposeModel();layers=new Map();layerControls.replaceChildren();pickInfo.textContent='';
   concrete=null;steel=null;edges=null;dimensionSummary.hidden=true;updateColorLegend();
   renderer.domElement.hidden=true;viewer.querySelector('.pc-viewport-help').hidden=true;host.dataset.edgeDimensions='0';host.dataset.visibleEdgeDimensions='0';
   let preview=host.querySelector('.pc-registry-preview');if(!preview){preview=document.createElement('div');preview.className='pc-registry-preview';host.append(preview);}
   const message=document.createElement('span');message.textContent='3D-модель и расположение арматуры ещё не восстановлены.';
   const link=document.createElement('a');link.textContent='Открыть конструктив изделия в КЖИ';link.href=spec.sourceUrl;link.target='_blank';link.rel='noopener';preview.replaceChildren(message,link);
   host.dataset.modelReady='false';host.dataset.documentModel=spec.documentModelId;host.dataset.layerCount='0';
   document.getElementById('pc-camera-reset').disabled=document.getElementById('pc-camera-expand').disabled=true;
   return;
  }
  renderer.domElement.hidden=false;viewer.querySelector('.pc-viewport-help').hidden=false;host.querySelector('.pc-registry-preview')?.remove();
  document.getElementById('pc-camera-reset').disabled=document.getElementById('pc-camera-expand').disabled=false;
  if(spec.drawingOverride){drawing=spec.drawingOverride;}
  else if(spec.documentModelId){
   if(!modelCache.has(spec.documentModelId))modelCache.set(spec.documentModelId,window.CalcZhBIAPI.request('/calc/api/document-models/'+encodeURIComponent(spec.documentModelId)).catch(error=>{modelCache.delete(spec.documentModelId);throw error;}));
   try{drawing=await modelCache.get(spec.documentModelId);}catch(error){if(request===modelRequest){host.dataset.modelReady='false';pickInfo.textContent='Не удалось загрузить модель: '+error.message;}return;}
  }
  if(request!==modelRequest)return;
  const nextKey=JSON.stringify([spec.productKey,spec.geometry,spec.documentModelId,spec.modelKey]);
  const modelChanged=nextKey!==key;
  if(modelChanged){
   key=nextKey;disposeModel();layers=new Map();layerControls.replaceChildren();pickInfo.textContent='';
   preferredDirection=drawing?.preview3d?.shape==='profile-prism'?new THREE.Vector3(.82,.35,.65).normalize():new THREE.Vector3(.15,.22,.96).normalize();
   if(drawing?.solidModel){
    const built=buildSolidModel(drawing.solidModel);({concrete,edges,steel,layers}=built);group.add(concrete,edges,steel);modelSize.copy(built.size);
    addEdgeDimensions(built.edgeRecords,built.point);dimensionSummary.textContent+=' Размеры бетона по поставленным частям; вопросы сборки сохранены в описании.';
    for(const [id,layer] of layers)addLayerControl(id,layer,layer.userData.record.shortLabel);
    grid.position.y=-modelSize.y/2-.2;home();
   }else if(drawing?.preview3d){
    const built=buildProjectSketch(drawing.preview3d);({concrete,edges,steel,layers}=built);group.add(concrete,edges,steel);modelSize.copy(built.viewSize||built.size);
    addEdgeDimensions(built.edgeRecords,built.point);dimensionSummary.textContent+=' '+(drawing.preview3d.notes[0]||'');
    const titles={longitudinal:'Продольные КР','cross-mesh':'Поперечные КР',additional:'Стержень Ø20',spacers:'Распорки Ø8',lifting:'Петли СП1',embedded:'Закладные ЗД1'};
    for(const [id,layer] of layers){const record=layer.userData.record;addLayerControl(id,layer,record.shortLabel||titles[id]||(record.name.split(' · ')[0]+(record.partial?' · окончания ?':'')));}
    grid.position.y=-modelSize.y/2-.2;home();
   }else if(drawing){
    const built=buildDrawing(drawing);({concrete,edges,steel,layers}=built);group.add(concrete,edges,steel);modelSize.copy(built.size);
    addEdgeDimensions(drawingEdges(drawing),built.point);
    dimensionSummary.textContent+=' Подписи дальних и перекрывающихся рёбер появляются при вращении и увеличении модели.';
    const titles={longitudinal:'Продольная','bottom-mesh':'Нижние сетки','top-mesh':'Верхние сетки','cross-mesh':'Поперечные',console:'Консоль',spirals:'Спирали',lifting:'Петли',pipes:'Трубы'};
    for(const [id,layer] of layers)addLayerControl(id,layer,titles[id]||layer.userData.record.name);
    grid.position.y=-modelSize.y/2-.2;home();
   }else{
   const dimensions=spec.geometry||{length:6,width:.65,height:.65};
   const scale=8/Math.max(dimensions.length,dimensions.width,dimensions.height);
   const length=dimensions.length*scale,width=dimensions.width*scale,height=dimensions.height*scale;
   modelSize.set(length,height,width);
   const geometry=new THREE.BoxGeometry(length,height,width);
   concrete=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0x8e9dac,roughness:.88,transparent:true,opacity:.3,depthWrite:false}));
   concrete.renderOrder=2;group.add(concrete);
   edges=new THREE.LineSegments(new THREE.EdgesGeometry(geometry),new THREE.LineBasicMaterial({color:0x61748a,transparent:true,opacity:.65}));edges.renderOrder=3;group.add(edges);
   steel=new THREE.Group();group.add(steel);
   const metal=new THREE.MeshStandardMaterial({color:palette.longitudinal,roughness:.52,metalness:.45}),ties=new THREE.MeshStandardMaterial({color:palette.frames,roughness:.52,metalness:.45});
   const halfY=height*.36,halfZ=width*.36,rodRadius=Math.min(width,height)*.025;
   const point=(x,y,z)=>new THREE.Vector3(x,y,z);
   for(const y of [-halfY,halfY])for(const z of [-halfZ,halfZ])steel.add(rod(point(-length*.47,y,z),point(length*.47,y,z),rodRadius,metal));
   const tieCount=Math.max(3,Math.min(25,Math.ceil(length/Math.min(width,height)*1.5)));
   for(let i=0;i<tieCount;i++){
    const x=-length*.45+i/(tieCount-1)*length*.9;
    const corners=[point(x,-halfY,-halfZ),point(x,halfY,-halfZ),point(x,halfY,halfZ),point(x,-halfY,halfZ)];
    for(let j=0;j<4;j++){const mesh=rod(corners[j],corners[(j+1)%4],rodRadius*.65,ties);mesh.userData.colorType='frames';steel.add(mesh);}
   }
   if(spec.geometry){
    const d=spec.geometry;
    const records=prismEdges([[-d.length*500,-d.height*500],[d.length*500,-d.height*500],[d.length*500,d.height*500],[-d.length*500,d.height*500]],-d.width*500,d.width*500);
    addEdgeDimensions(records,p=>new THREE.Vector3(...p.map(v=>v*scale/1000)));
   }else{
    const records=prismEdges([[-length/2,-height/2],[length/2,-height/2],[length/2,height/2],[-length/2,height/2]],-width/2,width/2);
    addEdgeDimensions(records,p=>new THREE.Vector3(...p),false);
   }
   grid.position.y=-height/2-.12;home();
   }
  }
  if(modelChanged)refreshPalette();
  concrete.visible=edges.visible=spec.showConcrete;
  steel.visible=spec.showSteel;
  const applyOpacity=object=>{if(!object.material)return;object.material.opacity=spec.opacity/100;object.material.transparent=spec.opacity<100;object.material.depthWrite=spec.opacity>=100;};
  concrete.traverse(applyOpacity);edges.traverse(object=>{if(object.material)object.material.opacity=spec.opacity===0?0:.65;});
  host.dataset.modelReady='true';host.dataset.concrete=String(spec.showConcrete);host.dataset.steel=String(spec.showSteel);host.dataset.opacity=String(spec.opacity);
  host.dataset.documentModel=spec.documentModelId||'';host.dataset.layerCount=String(layers.size);host.dataset.modelQuality=drawing?.solidModel?'source-partial':drawing?.preview3d?(drawing.preview3d.quality||'envelope'):drawing?'drawing':'manual';
 }
 const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();let pointerStart=null;
 renderer.domElement.addEventListener('pointerdown',event=>{pointerStart=[event.clientX,event.clientY];});
 renderer.domElement.addEventListener('pointerup',event=>{if(!pointerStart||Math.hypot(event.clientX-pointerStart[0],event.clientY-pointerStart[1])>5||!steel?.visible)return;const rect=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);const hit=raycaster.intersectObjects([...layers.values()].filter(layer=>layer.visible),true)[0];if(!hit)return;const data=hit.object.userData,record=data.record,segment=data.segments?.[hit.instanceId],position=segment?.path.position||data.position,note=segment?.path.note||data.note;pickInfo.textContent=record.name+' · '+record.quantity+' '+record.unit+' · лист '+record.sheet+(data.partName?' · '+data.partName:'')+(position?' · поз. '+position:'')+(data.diameter?' · Ø'+data.diameter+' мм':'')+(note?' · '+note:'');});
 function resize(){const {width,height}=host.getBoundingClientRect();if(width<1||height<1)return;const changed=Math.abs(camera.aspect-width/height)>.001;camera.aspect=width/height;camera.updateProjectionMatrix();renderer.setSize(width,height,false);if(changed&&concrete)home(camera.position.clone().sub(controls.target).normalize());}
 const observer=new ResizeObserver(resize);observer.observe(host);resize();
 window.addEventListener('calczhbi:model',event=>setProduct(event.detail));
 if(window.CalcZhBIModelSpec)setProduct(window.CalcZhBIModelSpec);
 controls.addEventListener('change',()=>{host.dataset.camera=camera.position.toArray().map(v=>v.toFixed(4)).join(',');});
 host.dataset.camera=camera.position.toArray().map(v=>v.toFixed(4)).join(',');
 document.getElementById('pc-camera-reset').addEventListener('click',()=>{if(concrete)home();});
 dimensionsControl.addEventListener('change',()=>{try{localStorage.setItem('calczhbi.dimensionMode',dimensionsControl.value);}catch{}annotationKey='';});
 rulersControl.addEventListener('change',()=>{try{localStorage.setItem('calczhbi.rulers',String(rulersControl.checked));}catch{}annotationKey='';});
 document.getElementById('pc-camera-expand').addEventListener('click',async()=>{
  try{if(document.fullscreenElement)await document.exitFullscreen();else await viewer.requestFullscreen();}
  catch{viewer.querySelector('.pc-viewport-help').textContent='Полноэкранный режим недоступен в этом браузере.';}
 });
 document.addEventListener('fullscreenchange',()=>{document.getElementById('pc-camera-expand').textContent=document.fullscreenElement===viewer?'Свернуть':'Развернуть';const direction=camera.position.clone().sub(controls.target).normalize();resize();home(direction);});
 host.addEventListener('keydown',event=>{
  if(!concrete)return;
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(event.key))return;
  event.preventDefault();
  if(event.key==='0'){home();return;}
  const offset=camera.position.clone().sub(controls.target),spherical=new THREE.Spherical().setFromVector3(offset);
  if(event.key==='ArrowLeft')spherical.theta+=.12;if(event.key==='ArrowRight')spherical.theta-=.12;
  if(event.key==='ArrowUp')spherical.phi-=.12;if(event.key==='ArrowDown')spherical.phi+=.12;
  if(['+','='].includes(event.key))spherical.radius*=.9;if(event.key==='-')spherical.radius*=1.1;
  spherical.makeSafe();spherical.radius=THREE.MathUtils.clamp(spherical.radius,controls.minDistance,controls.maxDistance);
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));controls.update();
 });
 renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();host.dataset.modelReady='false';viewer.querySelector('.pc-viewport-help').textContent='3D-контекст потерян. Обновите страницу.';});
 function frame(){requestAnimationFrame(frame);if(host.clientHeight>0&&document.visibilityState==='visible'){
  controls.update();
  positionAnnotations();renderer.render(scene,camera);
 }}frame();
}catch(error){
 const message=host.querySelector('.pc-view-loading')||document.createElement('span');message.className='pc-view-loading';message.textContent='3D недоступно: включите аппаратное ускорение браузера.';host.append(message);host.dataset.modelReady='false';
 document.getElementById('pc-camera-reset').disabled=document.getElementById('pc-camera-expand').disabled=true;
}
