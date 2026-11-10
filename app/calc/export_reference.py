"""All source columns from the supplied commercial workbook, read-only."""
import hashlib
import json
import re
from collections import defaultdict
from functools import lru_cache

from .document_models import ASSETS, catalog
from .marks import build_index, normalize


def title_marks(title):
    """Parse explicit marks, including a source row listing several plates."""
    result = []
    for part in (title or '').split('+'):
        head = re.split(r'\s*согласно\s*', part, maxsplit=1, flags=re.I)[0].strip()
        match = re.match(r'^(Колонна|Ригель|Плита(?:\s+перекрытия)?|Панель(?:\s+(?:цокольная|стеновая))?)\s*(.+)$', head, re.I)
        if not match:
            continue
        kind, tail = match.groups()
        mark = tail.strip() if tail.startswith('ПП ') else tail.split()[0]
        result.append(('Плита перекрытия' if kind.lower().startswith('плита') else kind.split()[0].capitalize(), mark))
    return result


def source_rows():
    meta_path = ASSETS / 'promka-commercial-references.json'
    audit_path = ASSETS / 'promka-commercial-reference-audit.json'
    meta = json.loads(meta_path.read_text())
    path = ASSETS / 'sources' / meta['storageName']
    signature = (path.stat().st_mtime_ns, path.stat().st_size, audit_path.stat().st_mtime_ns)
    return _source_rows(str(path), str(audit_path), meta['sha256'], meta['sheet'], signature)


@lru_cache(maxsize=1)
def _source_rows(path, audit_path, expected_sha, sheet_name, signature):
    from pathlib import Path
    from openpyxl import load_workbook
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != expected_sha:
        raise ValueError('Исходный файл КП изменился после сверки. Требуется повторная привязка строк.')
    audit = json.loads(Path(audit_path).read_text())
    if audit['sha256'] != expected_sha:
        raise ValueError('Реестр привязки строк относится к другой версии файла КП.')
    book = load_workbook(path, read_only=True, data_only=True)
    formulas = load_workbook(path, read_only=True, data_only=False)
    try:
        sheet = book[sheet_name]
        values = list(sheet.iter_rows(values_only=True))
        source_cells = dict(enumerate(formulas[sheet_name].iter_rows(min_row=7, max_col=16), start=7))
        return tuple({'row': item['row'], 'proposedName': values[item['row']-1][1],
                      'ttnName': values[item['row']-1][6], 'sourceQuantity': values[item['row']-1][7],
                      'sourceCells': [{'value': values[item['row']-1][i], 'numberFormat': cell.number_format,
                                       'formula': cell.value if cell.data_type == 'f' else None}
                                      for i, cell in enumerate(source_cells[item['row']])],
                      'modelIds': item.get('modelIds', [])}
                     for item in audit['rows'])
    finally:
        book.close()
        formulas.close()


def export_references(conn):
    products = list(conn.execute('SELECT id,name,document_model_id FROM products'))
    try:
        rows = source_rows()
    except (FileNotFoundError, ValueError, KeyError) as error:
        return {p['id']: {'referenceStatus': 'unavailable', 'referenceNote': str(error)} for p in products}
    models, index = catalog(), build_index(conn, True)
    by_model, candidates = defaultdict(set), defaultdict(list)
    for product in products:
        by_model[product['document_model_id']].add(product['id'])
    for row in rows:
        matched = set()
        for model_id in row['modelIds']:
            matched.update(by_model.get(model_id, ()))
            # The two original calculator columns replace registry aliases of the same drawings.
            model = models.get(model_id, {})
            alias = model.get('alias')
            if alias and not by_model.get(model_id):
                for product in products:
                    current = models.get(product['document_model_id'], {})
                    if (current.get('source', {}).get('sha256') == model.get('source', {}).get('sha256')
                            and normalize(re.sub(r'^Колонна\s+', '', product['name']), True) == normalize(alias, True)):
                        matched.add(product['id'])
        if not matched:
            for kind, mark in title_marks(row['ttnName']):
                found = list(index.get(normalize(mark, True), {}).values())
                found = [p for p in found if not p['kind'] or kind.casefold().startswith(p['kind'][:5]) or p['kind'].startswith(kind[:5].casefold())]
                if len(found) == 1:
                    matched.add(found[0]['id'])
        for product_id in matched:
            candidates[product_id].append({**row, 'grouped': len(matched)>1 or len(row['modelIds'])>1})
    result = {}
    for product in products:
        found = candidates[product['id']]
        names = {(r['proposedName'], r['ttnName']) for r in found}
        if len(names) == 1:
            proposed, ttn = next(iter(names))
            result[product['id']] = {'referenceStatus': 'found', 'proposedName': proposed, 'ttnName': ttn,
                                    'sourceRows': [r['row'] for r in found],
                                    'sourceCells': found[0].get('sourceCells', []) if len(found)==1 and not found[0]['grouped'] else [],
                                    'sourceQuantity': found[0]['sourceQuantity'] if len(found)==1 and not found[0]['grouped'] else None}
        else:
            result[product['id']] = {'referenceStatus': 'ambiguous' if found else 'not-found', 'sourceRows': [r['row'] for r in found]}
    return result
