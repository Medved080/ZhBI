import * as THREE from 'three';

export function buildDrawing(data){
 const [lo,hi]=data.bounds,scale=8/(hi[0]-lo[0]),center=lo.map((v,i)=>(v+hi[i])/2);
 const point=p=>new THREE.Vector3(...p.map((v,i)=>(v-center[i])*scale));
 const transform=new THREE.Matrix4().set(scale,0,0,-center[0]*scale,0,scale,0,-center[1]*scale,0,0,scale,-center[2]*scale,0,0,0,1);
 const concrete=new THREE.Group(),edges=new THREE.Group(),steel=new THREE.Group(),layers=new Map();
 const concreteMaterial=new THREE.MeshStandardMaterial({color:0x95a6b7,roughness:.88,transparent:true,opacity:.3,depthWrite:false,side:THREE.DoubleSide});
 const edgeMaterial=new THREE.LineBasicMaterial({color:0x60738a,transparent:true,opacity:.7});
 function addConcrete(geometry){geometry.applyMatrix4(transform);const mesh=new THREE.Mesh(geometry,concreteMaterial);mesh.renderOrder=2;concrete.add(mesh);const edge=new THREE.LineSegments(new THREE.EdgesGeometry(geometry,25),edgeMaterial);edge.renderOrder=3;edges.add(edge);}
 const shape=new THREE.Shape();data.bodyPolygon.forEach(([x,y],i)=>i?shape.lineTo(x,y):shape.moveTo(x,y));shape.closePath();
 for(const hole of data.pipes){const circle=new THREE.Path();circle.absarc(hole.x,hole.y,hole.outer/2,0,Math.PI*2,true);shape.holes.push(circle);}
 addConcrete(new THREE.ExtrudeGeometry(shape,{depth:data.section[1],bevelEnabled:false,curveSegments:16}));
 const middle=new THREE.BoxGeometry(data.channelStart-data.upperStart,900,data.section[1]);middle.translate((data.upperStart+data.channelStart)/2,450,data.section[1]/2);addConcrete(middle);
 const top=new THREE.Shape();top.moveTo(0,0);top.lineTo(900,0);top.lineTo(900,data.section[1]);top.lineTo(0,data.section[1]);top.closePath();
 for(const hole of data.channels){const circle=new THREE.Path();circle.absarc(hole.y,hole.z,hole.diameter/2,0,Math.PI*2,true);top.holes.push(circle);}
 const upper=new THREE.ExtrudeGeometry(top,{depth:data.concreteLength-data.channelStart,bevelEnabled:false,curveSegments:12});
 upper.applyMatrix4(new THREE.Matrix4().set(0,0,1,data.channelStart,1,0,0,0,0,1,0,0,0,0,0,1));addConcrete(upper);
 const colors={longitudinal:0xa95e30,'bottom-mesh':0x248876,'top-mesh':0x248876,'cross-mesh':0x248876,console:0xb07925,spirals:0x5673b0,lifting:0x925f9e,pipes:0x667686};
 for(const record of data.groups){
  const layer=new THREE.Group();layer.userData.record=record;steel.add(layer);layers.set(record.id,layer);
  const material=new THREE.MeshStandardMaterial({color:colors[record.id],roughness:.55,metalness:.35});
  const byDiameter=new Map();
  for(const path of record.paths){const list=byDiameter.get(path.diameter)||[];for(let i=1;i<path.points.length;i++){
   const a=point(path.points[i-1]),b=point(path.points[i]);if(a.distanceTo(b)>1e-8)list.push({a,b,path});
  }byDiameter.set(path.diameter,list);}
  for(const [diameter,segments] of byDiameter){
   const mesh=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8),material,segments.length),dummy=new THREE.Object3D();
   mesh.userData.record=record;mesh.userData.segments=segments;mesh.userData.diameter=diameter;
   segments.forEach(({a,b},i)=>{const delta=b.clone().sub(a);dummy.position.copy(a).add(b).multiplyScalar(.5);dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.clone().normalize());dummy.scale.set(diameter/2*scale,delta.length(),diameter/2*scale);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);});
   mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();layer.add(mesh);
  }
 }
 for(const pipe of data.pipes){
  const section=new THREE.Shape();section.absarc(0,0,pipe.outer/2,0,Math.PI*2,false);const hole=new THREE.Path();hole.absarc(0,0,pipe.inner/2,0,Math.PI*2,true);section.holes.push(hole);
  const geometry=new THREE.ExtrudeGeometry(section,{depth:data.section[1],bevelEnabled:false,curveSegments:16});geometry.translate(pipe.x,pipe.y,0);geometry.applyMatrix4(transform);
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:colors.pipes,roughness:.5,metalness:.6}));mesh.userData.record=layers.get('pipes').userData.record;mesh.userData.diameter=pipe.outer;layers.get('pipes').add(mesh);
 }
 return {concrete,edges,steel,layers,scale,point,size:new THREE.Vector3(...hi.map((v,i)=>(v-lo[i])*scale))};
}
