import * as THREE from 'three';
import {prismEdges} from './edge-dimensions.js';

// Supplied coordinates and placements are immutable millimetres. This adapter
// triangulates volumes and scales the scene; it never resolves source conflicts.
export function solidPartGeometry(part){
 let geometry;
 if(part.type==='extrusion'){
  const shape=new THREE.Shape();
  part.profile.forEach(([x,y],i)=>i?shape.lineTo(x,y):shape.moveTo(x,y));shape.closePath();
  for(const hole of part.holes||[]){
   const path=new THREE.Path();
   if(hole.type==='circle')path.absarc(...hole.center,hole.radius,0,Math.PI*2,true);
   else if(hole.type==='polygon'){hole.points.forEach(([x,y],i)=>i?path.lineTo(x,y):path.moveTo(x,y));path.closePath();}
   else throw new Error('Неизвестный тип отверстия: '+hole.type);
   shape.holes.push(path);
  }
  geometry=new THREE.ExtrudeGeometry(shape,{depth:part.depth,bevelEnabled:false,curveSegments:24});
  const [u,v,d,o]=[part.u,part.v,part.direction,part.origin];
  const basis=new THREE.Matrix4().set(u[0],v[0],d[0],o[0],u[1],v[1],d[1],o[1],u[2],v[2],d[2],o[2],0,0,0,1);
  geometry.applyMatrix4(basis);
  // A reflected basis reverses winding; preserve outward normals and positive volume.
  if(basis.determinant()<0){const positions=geometry.getAttribute('position');for(let i=0;i<positions.count;i+=3){const b=new THREE.Vector3().fromBufferAttribute(positions,i+1),c=new THREE.Vector3().fromBufferAttribute(positions,i+2);positions.setXYZ(i+1,c.x,c.y,c.z);positions.setXYZ(i+2,b.x,b.y,b.z);}geometry.computeVertexNormals();}
 }else if(part.type==='mesh'){
  geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(part.vertices.flat(),3));geometry.setIndex(part.indices.flat());geometry.computeVertexNormals();
 }else throw new Error('Неизвестный объём: '+part.type);
 geometry.computeBoundingBox();return geometry;
}

function partEdges(part,geometry){
 if(part.type==='extrusion'){
  const basis=p=>p.map((_,i)=>part.u[i]*p[0]+part.v[i]*p[1]+part.direction[i]*p[2]);
  const world=p=>basis(p).map((v,i)=>v+part.origin[i]);
  return prismEdges(part.profile,0,part.depth).map(e=>({...e,a:world(e.a),b:world(e.b),normals:e.normals.map(basis)}));
 }
 // Shared edge normals for closed indexed meshes; omit coplanar triangulation diagonals.
 const positions=geometry.getAttribute('position'),indices=geometry.getIndex(),segments=new Map();
 const vertex=i=>new THREE.Vector3().fromBufferAttribute(positions,i),key=p=>p.toArray().map(v=>v.toFixed(4)).join(',');
 for(let i=0;i<(indices?.count||positions.count);i+=3){
  const points=[0,1,2].map(j=>vertex(indices?indices.getX(i+j):i+j));
  const n=points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize();
  for(let j=0;j<3;j++){const a=points[j],b=points[(j+1)%3],k=[key(a),key(b)].sort().join('|');if(!segments.has(k))segments.set(k,{a:a.toArray(),b:b.toArray(),normals:[]});segments.get(k).normals.push(n.toArray());}
 }
 return [...segments.values()].filter(e=>e.normals.length<2||new THREE.Vector3(...e.normals[0]).dot(new THREE.Vector3(...e.normals[1]))<Math.cos(25*Math.PI/180)).map(e=>({...e,length:new THREE.Vector3(...e.a).distanceTo(new THREE.Vector3(...e.b))}));
}

// K7 display: one axial wire and six helically wound wires. The pitch is
// illustrative (12 nominal diameters) unless supplied explicitly; it is never
// a fabrication dimension or an input to length, mass or collision calculations.
export function sevenWireSegments(path, point=p=>new THREE.Vector3(...p)){
 const diameter=path.diameter,pitch=path.visualLayPitchMm>0?path.visualLayPitchMm:12*diameter;
 const wireDiameter=diameter/3,orbit=diameter/3,segments=[];
 let travelled=0,normal=null,previousTangent=null,previousOuter=null;
 const append=(a,b,wireIndex)=>{if(a.distanceToSquared(b)>1e-16)segments.push({a:point(a.toArray()),b:point(b.toArray()),path,wireIndex});};
 for(let k=1;k<path.points.length;k++){
  const a=new THREE.Vector3(...path.points[k-1]),b=new THREE.Vector3(...path.points[k]),delta=b.clone().sub(a),length=delta.length();
  if(length<1e-8)continue;
  const tangent=delta.divideScalar(length);
  if(normal){normal.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(previousTangent,tangent));normal.addScaledVector(tangent,-normal.dot(tangent)).normalize();}
  else{const reference=Math.abs(tangent.y)<.9?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);normal=reference.addScaledVector(tangent,-reference.dot(tangent)).normalize();}
  const binormal=new THREE.Vector3().crossVectors(tangent,normal).normalize(),steps=Math.max(1,Math.ceil(length/pitch*16));
  const outerAt=(distance,wire)=>{
   const angle=2*Math.PI*(travelled+distance)/pitch+wire*Math.PI/3;
   return a.clone().addScaledVector(tangent,distance).addScaledVector(normal,orbit*Math.cos(angle)).addScaledVector(binormal,orbit*Math.sin(angle));
  };
  // Retain the shared endpoint at polyline bends, avoiding detached wire ends.
  let previous=previousOuter||Array.from({length:6},(_,wire)=>outerAt(0,wire));
  append(a,b,0);
  for(let j=1;j<=steps;j++){
   const next=Array.from({length:6},(_,wire)=>outerAt(length*j/steps,wire));
   next.forEach((end,wire)=>append(previous[wire],end,wire+1));previous=next;
  }
  previousOuter=previous;previousTangent=tangent;travelled+=length;
 }
 return {segments,wireDiameter,pitch};
}
function isSevenWire(record,path){
 const count=path.wireCountPerStrand??record.wireCountPerStrand;
 return count===7 || (count==null && /(?:К|K)7(?:\b|[-\s,])/i.test([path.material,record.material,record.name].filter(Boolean).join(' ')));
}

export function buildSolidModel(data){
 if(!['column-solids-mm-v1','project-solids-mm-v1'].includes(data.format))throw new Error('Неизвестный формат модели');
 const concreteParts=data.concreteParts.map(part=>({part,geometry:solidPartGeometry(part)}));
 const metalParts=(data.metalParts||[]).map(part=>({part,geometry:solidPartGeometry(part)}));
 const sourceBounds=new THREE.Box3(new THREE.Vector3(...data.bounds[0]),new THREE.Vector3(...data.bounds[1]));
 for(const {geometry} of [...concreteParts,...metalParts])sourceBounds.union(geometry.boundingBox);
 for(const record of data.groups)for(const path of record.paths||[])for(const p of path.points){const radius=path.diameter/2;sourceBounds.expandByPoint(new THREE.Vector3(...p).addScalar(radius));sourceBounds.expandByPoint(new THREE.Vector3(...p).addScalar(-radius));}
 const center=sourceBounds.getCenter(new THREE.Vector3()),scale=8/Math.max(...sourceBounds.getSize(new THREE.Vector3()).toArray());
 const point=p=>new THREE.Vector3(...p).sub(center).multiplyScalar(scale);
 const transform=new THREE.Matrix4().makeTranslation(-center.x*scale,-center.y*scale,-center.z*scale).scale(new THREE.Vector3(scale,scale,scale));
 const concrete=new THREE.Group(),edges=new THREE.Group(),steel=new THREE.Group(),layers=new Map(),edgeRecords=[],dedup=new Set();
 const material=new THREE.MeshStandardMaterial({color:0x95a6b7,roughness:.88,transparent:true,opacity:.3,depthWrite:false,side:THREE.DoubleSide});
 const edgeMaterial=new THREE.LineBasicMaterial({color:0x60738a,transparent:true,opacity:.7});
 for(const {part,geometry} of concreteParts){
  for(const edge of partEdges(part,geometry)){const k=[edge.a,edge.b].map(p=>p.map(v=>v.toFixed(3)).join(',')).sort().join('|');if(!dedup.has(k)){edgeRecords.push(edge);dedup.add(k);}}
  geometry.applyMatrix4(transform);const mesh=new THREE.Mesh(geometry,material);mesh.renderOrder=2;concrete.add(mesh);
  const lines=new THREE.LineSegments(new THREE.EdgesGeometry(geometry,25),edgeMaterial);lines.renderOrder=3;edges.add(lines);
 }
 const palette=[0xa95e30,0x248876,0x447d91,0xb07925,0x5673b0,0x925f9e];
 const shortLabels={'main-bars':'Рабочие','main-1':'Рабочие',main:'Рабочие','nets-sv':'Сетки СВ','nets-sn':'Сетки СН','frames-kk':'Каркасы КК',SN:'Сетки СН',SV:'Сетки СВ',KK:'Каркасы КК',P1:'Петли П1',loops:'Петли',spirals:'Спирали',spiral:'Спирали',oc1:'Ос1',short:'Короткие',supplement:'Дополнительные','console-main':'Консоль · основные','console-edge':'Консоль · края','console-stirrups':'Консоль · хомуты',tube68:'Трубы Ø68',tube50:'Трубы Ø50',pipe:'Труба'};
 function layerFor(id,record){
  if(layers.has(id))return layers.get(id);
  const layer=new THREE.Group();layer.userData.record={...record,shortLabel:record.shortLabel||shortLabels[id]||record.name};
  layer.userData.material=new THREE.MeshStandardMaterial({color:/tube|pipe/.test(id)?0x667686:palette[layers.size%palette.length],roughness:.55,metalness:.35});steel.add(layer);layers.set(id,layer);return layer;
 }
 for(const record of data.groups){
  const layer=layerFor(record.id,record),byDiameter=new Map();
  for(const path of record.paths||[]){
   const stranded=isSevenWire(record,path),key=path.diameter+':'+stranded;
   if(!byDiameter.has(key))byDiameter.set(key,{diameter:path.diameter,stranded,segments:[]});
   const list=byDiameter.get(key).segments;
   if(stranded)list.push(...sevenWireSegments(path,point).segments);
   else for(let i=1;i<path.points.length;i++){const a=point(path.points[i-1]),b=point(path.points[i]);if(a.distanceTo(b)>1e-8)list.push({a,b,path});}
  }
  for(const {diameter,stranded,segments} of byDiameter.values()){
   if(!segments.length)continue;
   const mesh=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8),layer.userData.material,segments.length),dummy=new THREE.Object3D();
   mesh.userData={record:layer.userData.record,segments,diameter,construction:stranded?'seven-wire-strand':'solid-bar',visualLayPitchMm:stranded?12*diameter:null,note:stranded?'К7: 1 центральная + 6 наружных проволок; шаг свивки условный, только для отображения':''};
   segments.forEach(({a,b},i)=>{const delta=b.clone().sub(a);dummy.position.copy(a).add(b).multiplyScalar(.5);dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.clone().normalize());const radius=diameter/(stranded?6:2)*scale;dummy.scale.set(radius,delta.length(),radius);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);});
   mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingBox();mesh.computeBoundingSphere();layer.add(mesh);
  }
 }
 for(const {part,geometry} of metalParts){
  const id=part.groupId||part.group||'metal',layer=layerFor(id,{id,name:part.name||'Металлические детали',quantity:1,unit:'шт',sheet:part.sheet||'см. исходные листы'});
  geometry.applyMatrix4(transform);const mesh=new THREE.Mesh(geometry,layer.userData.material);
  mesh.userData={record:layer.userData.record,partName:part.name,position:part.position,diameter:part.outerDiameter};layer.add(mesh);
 }
 for(const layer of layers.values())layer.userData.empty=!layer.children.length;
 return {concrete,edges,steel,layers,scale,point,edgeRecords,sourceBounds,size:sourceBounds.getSize(new THREE.Vector3()).multiplyScalar(scale)};
}
