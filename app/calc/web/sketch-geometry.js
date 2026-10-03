import * as THREE from 'three';
import {prismEdges} from './edge-dimensions.js';

function loftGeometry(sections){
 const vertices=[],count=sections[0].polygon.length;
 const p=(ring,index)=>{const s=sections[ring],[z,y]=s.polygon[index];return [s.x,y,z];};
 const triangle=(a,b,c)=>vertices.push(...a,...c,...b);
 for(let r=0;r<sections.length-1;r++)for(let i=0;i<count;i++){
  const j=(i+1)%count,a=p(r,i),b=p(r,j),c=p(r+1,j),d=p(r+1,i);triangle(a,b,c);triangle(a,c,d);
 }
 for(const r of [0,sections.length-1]){
  const poly=sections[r].polygon.map(([z,y])=>new THREE.Vector2(z,y));
  for(const [a,b,c] of THREE.ShapeUtils.triangulateShape(poly,[]))triangle(p(r,a),p(r,b),p(r,c));
 }
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.computeVertexNormals();return geometry;
}

function geometryEdges(geometry){
 const outline=new THREE.EdgesGeometry(geometry,25),positions=outline.getAttribute('position'),faces=geometry.getAttribute('position'),index=geometry.index,records=[];
 const v=i=>new THREE.Vector3().fromBufferAttribute(faces,index?index.getX(i):i),total=index?index.count:faces.count;
 for(let i=0;i<positions.count;i+=2){
  const a=new THREE.Vector3().fromBufferAttribute(positions,i),b=new THREE.Vector3().fromBufferAttribute(positions,i+1),mid=a.clone().add(b).multiplyScalar(.5),normals=[];
  for(let j=0;j<total;j+=3){
   const face=new THREE.Triangle(v(j),v(j+1),v(j+2)),normal=face.getNormal(new THREE.Vector3());
   if(normal.lengthSq()<.5||Math.abs(normal.dot(a.clone().sub(face.a)))>.1||Math.abs(normal.dot(b.clone().sub(face.a)))>.1)continue;
   if(!face.containsPoint(mid))continue;
   // Orient surface normals outwards, also for the end caps.
   if(Math.abs(normal.x)>.99)normal.set(a.x<1?-1:1,0,0);
   if(!normals.some(n=>Math.abs(n.dot(normal)-1)<.001))normals.push(normal);
  }
  records.push({a:a.toArray(),b:b.toArray(),length:a.distanceTo(b),normals:normals.map(n=>n.toArray())});
 }
 outline.dispose();
 // Remove collinear subdivisions caused by loft rings; a straight concrete rib
 // remains one dimension, e.g. 500 mm rather than 190 + 45 + 265.
 const close=(a,b)=>a.distanceTo(b)<.1;
 let changed=true;
 while(changed){changed=false;outer:for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
  const r=records[i],s=records[j],ra=new THREE.Vector3(...r.a),rb=new THREE.Vector3(...r.b),sa=new THREE.Vector3(...s.a),sb=new THREE.Vector3(...s.b);
  const shared=close(ra,sa)||close(ra,sb)?ra:close(rb,sa)||close(rb,sb)?rb:null;if(!shared)continue;
  const degree=records.filter(e=>close(new THREE.Vector3(...e.a),shared)||close(new THREE.Vector3(...e.b),shared)).length;if(degree!==2)continue;
  const a=close(ra,shared)?rb:ra,b=close(sa,shared)?sb:sa;
  if(a.clone().sub(shared).normalize().dot(b.clone().sub(shared).normalize())>-.99999)continue;
  records[i]={a:a.toArray(),b:b.toArray(),length:a.distanceTo(b),normals:[...r.normals,...s.normals]};records.splice(j,1);changed=true;break outer;
 }}
 return records;
}

function addReinforcement(records,steel,layers,point,scale){
 const colors={longitudinal:0xa95e30,'cross-mesh':0x248876,additional:0xb07925,'bent-full':0x687eae,'bent-ledge':0x8978b5,spacers:0x368b94,lifting:0x925f9e,embedded:0x697e89};
 for(const record of records){
  const layer=new THREE.Group();layer.userData.record=record;steel.add(layer);layers.set(record.id,layer);
  const material=new THREE.MeshStandardMaterial({color:record.partial?0xc28d32:(record.color??colors[record.id]??0x925f9e),roughness:.55,metalness:.35}),byDiameter=new Map();
  for(const path of record.paths){const list=byDiameter.get(path.diameter)||[];for(let i=1;i<path.points.length;i++){
   const a=point(path.points[i-1]),b=point(path.points[i]);if(a.distanceTo(b)>1e-8)list.push({a,b,path});
  }byDiameter.set(path.diameter,list);}
  for(const [diameter,segments] of byDiameter){
   const mesh=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8),material,segments.length),dummy=new THREE.Object3D();
   mesh.userData.record=record;mesh.userData.segments=segments;mesh.userData.diameter=diameter;
   segments.forEach(({a,b},i)=>{const delta=b.clone().sub(a);dummy.position.copy(a).add(b).multiplyScalar(.5);dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.clone().normalize());dummy.scale.set(diameter/2*scale,delta.length(),diameter/2*scale);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);});
   mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();layer.add(mesh);
  }
  for(const path of record.paths.filter(p=>p.openEnd||p.openStart)){
   for(const endpoint of [...(path.openStart?[path.points[0]]:[]),...(path.openEnd?[path.points.at(-1)]:[])]){
    const marker=new THREE.Mesh(new THREE.SphereGeometry(5*scale,8,6),new THREE.MeshBasicMaterial({color:0xe6a52a}));marker.position.copy(point(endpoint));marker.userData.record=record;marker.userData.note=path.note;marker.userData.position=path.position;layer.add(marker);
   }
  }
 }
}

function addMetalSolids(records,layers,transform){
 for(const record of records){
  const layer=layers.get(record.groupId);if(!layer)throw new Error('Не найдена группа закладной '+record.groupId);
  const shape=new THREE.Shape(record.profile.map(p=>new THREE.Vector2(...p)));
  const geometry=new THREE.ExtrudeGeometry(shape,{depth:record.length,bevelEnabled:false});
  geometry.applyMatrix4(new THREE.Matrix4().set(0,0,1,record.x,0,1,0,0,1,0,0,0,0,0,0,1));geometry.applyMatrix4(transform);
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0x697e89,roughness:.5,metalness:.6,side:THREE.DoubleSide}));
  mesh.userData.record=layer.userData.record;mesh.userData.position=record.position;mesh.userData.partName=record.name;layer.add(mesh);
 }
}

// Envelope dimensions from the source mark/specification. No invented bar paths.
export function buildProjectSketch(sketch){
 const [length,height,width]=sketch.dimensions,scale=8/Math.max(length,height,width),center=[length/2,height/2,width/2];
 const point=p=>new THREE.Vector3(...p.map((v,i)=>(v-center[i])*scale));
 const transform=new THREE.Matrix4().set(scale,0,0,-center[0]*scale,0,scale,0,-center[1]*scale,0,0,scale,-center[2]*scale,0,0,0,1);
 const concrete=new THREE.Group(),edges=new THREE.Group(),steel=new THREE.Group(),layers=new Map();
 const material=new THREE.MeshStandardMaterial({color:0x95a6b7,roughness:.88,transparent:true,opacity:.3,depthWrite:false,side:THREE.DoubleSide});
 let geometry,edgeRecords;
 if(sketch.shape==='hollow-slab'){
  const shape=new THREE.Shape();shape.moveTo(0,0);shape.lineTo(height,0);shape.lineTo(height,width);shape.lineTo(0,width);shape.closePath();
  const count=Math.max(1,Math.floor(width/140)),pitch=width/count;
  for(let i=0;i<count;i++){const hole=new THREE.Path();hole.absellipse(height/2,pitch*(i+.5),height*.31,Math.min(pitch*.34,65),0,Math.PI*2,true);shape.holes.push(hole);}
  geometry=new THREE.ExtrudeGeometry(shape,{depth:length,bevelEnabled:false,curveSegments:18});geometry.applyMatrix4(new THREE.Matrix4().set(0,0,1,0,1,0,0,0,0,1,0,0,0,0,0,1));
 }else if(sketch.shape==='outline-slab'){
  const shape=new THREE.Shape(sketch.planPolygon.map(p=>new THREE.Vector2(...p)));
  geometry=new THREE.ExtrudeGeometry(shape,{depth:height,bevelEnabled:false});geometry.applyMatrix4(new THREE.Matrix4().set(1,0,0,0,0,0,1,0,0,1,0,0,0,0,0,1));
  const swap=p=>[p[0],p[2],p[1]];
  edgeRecords=prismEdges(sketch.planPolygon,0,height).map(e=>({...e,a:swap(e.a),b:swap(e.b),normals:e.normals.map(swap)}));
 }else if(sketch.shape==='profile-prism'){
  const shape=new THREE.Shape(sketch.profile.map(p=>new THREE.Vector2(...p)));
  geometry=new THREE.ExtrudeGeometry(shape,{depth:length,bevelEnabled:false});
  geometry.applyMatrix4(new THREE.Matrix4().set(0,0,1,0,0,1,0,0,1,0,0,0,0,0,0,1));
  const swap=p=>[p[2],p[1],p[0]];
  edgeRecords=prismEdges(sketch.profile,0,length).map(e=>({...e,a:swap(e.a),b:swap(e.b),normals:e.normals.map(swap)}));
 }else if(sketch.shape==='stair-loft'){
  geometry=loftGeometry(sketch.sections);edgeRecords=geometryEdges(geometry);
 }else{geometry=new THREE.BoxGeometry(length,height,width);geometry.translate(length/2,height/2,width/2);}
 edgeRecords??=prismEdges([[0,0],[length,0],[length,height],[0,height]],0,width);
 geometry.applyMatrix4(transform);const mesh=new THREE.Mesh(geometry,material);mesh.renderOrder=2;concrete.add(mesh);
 const outline=new THREE.LineSegments(new THREE.EdgesGeometry(geometry,25),new THREE.LineBasicMaterial({color:0x60738a,transparent:true,opacity:.7}));outline.renderOrder=3;edges.add(outline);
 addReinforcement(sketch.reinforcementGroups||[],steel,layers,point,scale);
 addMetalSolids(sketch.metalSolids||[],layers,transform);
 steel.updateMatrixWorld(true);concrete.updateMatrixWorld(true);
 const viewBounds=new THREE.Box3().setFromObject(concrete).union(new THREE.Box3().setFromObject(steel)),viewSize=viewBounds.getSize(new THREE.Vector3());
 return {concrete,edges,steel,layers,scale,point,edgeRecords,viewSize,size:new THREE.Vector3(length*scale,height*scale,width*scale)};
}
