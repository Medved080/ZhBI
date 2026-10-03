// Real outer concrete edges in source millimetres. Shared vertices are kept together.
export function prismEdges(polygon,z0,z1){
 const area=polygon.reduce((s,a,i)=>{const b=polygon[(i+1)%polygon.length];return s+a[0]*b[1]-b[0]*a[1];},0),sign=area>0?1:-1;
 const normal=(a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],n=Math.hypot(dx,dy);return [sign*dy/n,-sign*dx/n,0];};
 const edges=[];
 polygon.forEach((a,i)=>{const b=polygon[(i+1)%polygon.length],previous=polygon[(i+polygon.length-1)%polygon.length],side=normal(a,b);
  for(const [z,face] of [[z0,[0,0,-1]],[z1,[0,0,1]]])edges.push({a:[...a,z],b:[...b,z],normals:[side,face]});
  edges.push({a:[...a,z0],b:[...a,z1],normals:[normal(previous,a),side]});
 });
 return edges.map(e=>({...e,length:Math.hypot(...e.a.map((v,i)=>e.b[i]-v))}));
}
export function drawingEdges(drawing){
 return [...prismEdges(drawing.bodyPolygon,0,drawing.section[1]),...prismEdges([[drawing.upperStart,0],[drawing.concreteLength,0],[drawing.concreteLength,900],[drawing.upperStart,900]],0,drawing.section[1])];
}
