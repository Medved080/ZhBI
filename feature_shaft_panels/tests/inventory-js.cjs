// Uses Node's bundled AST parser; no package install or vendored code.
// Run with node --expose-internals feature_shaft_panels/tests/inventory-js.cjs
const fs=require('node:fs');
const acorn=require('internal/deps/acorn/acorn/dist/acorn');
const result=[];
const file='app/static/app.js';
const ast=acorn.parse(fs.readFileSync(file,'utf8'),{ecmaVersion:'latest',sourceType:'script',locations:true});
function visit(node,fn=null) {
 if (!node||typeof node!=='object') return;
 if (node.type==='FunctionDeclaration') fn=node.id?.name||fn;
 if (node.type==='Literal'&&['Колонна','Ригель','Плита перекрытия','Панель'].includes(node.value)) result.push({file,line:node.loc.start.line,function:fn,value:node.value});
 for(const [key,value] of Object.entries(node)) if(key!=='loc') {
  if(Array.isArray(value))value.forEach(n=>visit(n,fn));
  else if(value&&typeof value==='object')visit(value,fn);
 }
}
visit(ast);
fs.writeFileSync('feature_shaft_panels/integration/type-usage.json',JSON.stringify(result,null,2));
console.log(`${result.length} type-literal usages found by AST`);
