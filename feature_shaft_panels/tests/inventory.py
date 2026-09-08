"""AST-based map of Python integration points (does not import app)."""
import ast
import json
from pathlib import Path

root=Path(__file__).resolve().parents[2]
paths=['app/main.py','app/db.py','app/element_sync.py','app/dxf_import.py','app/input_import.py',
       'app/element_identity.py','app/models.py','app/zone_recalc.py','app/marks.py',
       'app/element_fields.py','scripts/import_elements.py','scripts/layer_naming.py']
result={}
for name in paths:
    tree=ast.parse((root/name).read_text())
    result[name]=[{'kind':type(n).__name__,'name':n.name,'line':n.lineno,
                   'signature':ast.unparse(n.args) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) else None}
                  for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef))]
out=root/'feature_shaft_panels/integration/architecture-map.json'
out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'{sum(map(len,result.values()))} definitions in {len(result)} files')
