"""Add reviewed source products and create calculations without replacing existing work.

The customer package stays outside Git. It contains registry, readings and optional
reviewedReadings/discrepancies mappings. Preview imports into a disposable DB copy;
--apply backs up the live DB/assets, then imports through the normal repository.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.calc import document_models as dm
from app.calc.config import Settings
from app.calc.import_register import import_register
from app.calc.readings import reviewed_page_matches

FILES = {'registry': 'promka-register.json', 'readings': 'promka-readings.json',
         'reviewedReadings': 'promka-reviewed-readings.json', 'sources': 'promka-sources.json'}


def merge(assets, package):
    result = {}
    for section, name in FILES.items():
        path = assets / name
        before = json.loads(path.read_text()) if path.exists() else {}
        additions = package.get(section) or {}
        conflicts = [k for k, v in additions.items() if k in before and v != before[k]]
        if conflicts:
            raise ValueError(f'{section}: existing entries differ: {conflicts}')
        result[name] = {**before, **additions}
    checked_sources = set()
    for key, model in (package.get('registry') or {}).items():
        if model.get('id') != key or model.get('kind') != 'registry':
            raise ValueError('Expected a source registry entry: ' + key)
        if not model.get('alias') or not model.get('source', {}).get('pageVerified'):
            raise ValueError('Expected a verified source page: ' + key)
        source = model['source']; meta = result['promka-sources.json'].get(source['id'])
        if not meta or source.get('sha256') != meta['sha256'] or not 1 <= source['productPage'] <= meta['pages']:
            raise ValueError('Source identity or page differs: ' + key)
        if source['id'] not in checked_sources:
            filename = meta['storageName']
            if Path(filename).name != filename:
                raise ValueError('Source filename must be a basename')
            with (assets / 'sources' / filename).open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != meta['sha256']:
                raise ValueError('Source PDF differs: ' + source['id'])
            checked_sources.add(source['id'])
        if model.get('readingMode') == 'reviewed':
            reading = result['promka-reviewed-readings.json'].get(key)
            if not reading or reading != result['promka-readings.json'].get(key):
                raise ValueError('Reviewed reading is missing or differs: ' + key)
            if not reviewed_page_matches(reading, source):
                raise ValueError('Reading belongs to another product page: ' + key)
    name = 'promka-discrepancies.json'; path = assets / name
    before = json.loads(path.read_text()) if path.exists() else []
    by_id = {v['id']: v for v in before}
    for item in package.get('discrepancies') or []:
        if item['id'] in by_id and item != by_id[item['id']]:
            raise ValueError('Existing discrepancy differs: ' + item['id'])
        by_id[item['id']] = item
    result[name] = list(by_id.values())
    return result


def publish(assets, documents):
    for name, value in documents.items():
        path = assets / name; temp = path.with_suffix('.json.importing')
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + '\n')
        os.replace(temp, path)


def snapshot_connection(conn):
    return {table: [tuple(row) for row in conn.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
            for table in ('products', 'calculation_versions', 'product_resource_baselines', 'extra_lines',
                          'line_overrides', 'product_verifications', 'production_norms', 'price_list', 'calculation_profiles')}


def db_snapshot(path):
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as conn:
        return snapshot_connection(conn)


def check_preserved(before, after):
    for table, rows in before.items():
        present = set(after[table])
        if any(row not in present for row in rows):
            raise ValueError('Existing records changed: ' + table)
        if table in ('production_norms', 'price_list', 'calculation_profiles') and rows != after[table]:
            raise ValueError('Rates or norms changed: ' + table)


def import_into(database, assets, before, required):
    from app.calc.database import transaction
    from app.calc.discrepancies import sync_catalog_issues
    dm.ASSETS = assets; dm.catalog.cache_clear()
    settings = Settings(data_dir=database.parent)
    if settings.database_path != database:
        raise ValueError('Database must be named calczhbi.sqlite3')
    with transaction(database) as conn:
        imported = import_register(settings, connection=conn)
        sync_catalog_issues(conn, assets / 'promka-discrepancies.json')
        for key in required:
            if not conn.execute('SELECT 1 FROM products WHERE document_model_id=?', (key,)).fetchone():
                raise ValueError('Product was not imported: ' + key)
        check_preserved(before, snapshot_connection(conn))
    return imported


def run(args):
    package = json.loads(args.package.read_text())
    documents = merge(args.assets, package)
    required = set(package.get('registry') or {})
    before = db_snapshot(args.database)
    dm.ASSETS = args.assets; dm.catalog.cache_clear()
    original_models = json.loads(json.dumps(dm.catalog()))
    with tempfile.TemporaryDirectory(prefix='calc-additions-') as folder:
        stage = Path(folder); staged_assets = stage / 'assets'; staged_assets.mkdir()
        for path in args.assets.iterdir():
            if path.name not in documents:
                (staged_assets / path.name).symlink_to(path.resolve())
        publish(staged_assets, documents)
        staged_db = stage / 'calczhbi.sqlite3'
        with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as src, sqlite3.connect(staged_db) as dst:
            src.backup(dst)
        imported = import_into(staged_db, staged_assets, before, required)
        check_preserved(before, db_snapshot(staged_db))
        staged_models = dm.catalog()
        if any(staged_models.get(k) != v for k, v in original_models.items()):
            raise ValueError('Existing source calculation inputs changed')
        if not args.apply:
            print(json.dumps({'preview': True, 'imported': imported, 'preservedProducts': len(before['products'])}, ensure_ascii=False, indent=2))
            return
    # Recheck immediately before publishing, to avoid overwriting a concurrent edit.
    if merge(args.assets, package) != documents or db_snapshot(args.database) != before:
        raise ValueError('Data changed during preview; run again')
    backup = args.database.parent / 'backups' / ('catalog-additions-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True)
    with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as src, sqlite3.connect(backup / args.database.name) as dst:
        src.backup(dst)
    absent = []
    for name in documents:
        path = args.assets / name
        if path.exists(): shutil.copy2(path, backup / name)
        else: absent.append(name)
    try:
        publish(args.assets, documents)
        imported = import_into(args.database, args.assets, before, required)
    except Exception:
        # Repository transaction rolls back a failed import. Restore source inputs.
        for name in documents:
            path = args.assets / name
            if name in absent: path.unlink(missing_ok=True)
            else: shutil.copy2(backup / name, path)
        dm.catalog.cache_clear()
        raise
    print(json.dumps({'imported': imported, 'preservedProducts': len(before['products']), 'backup': str(backup)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--assets', type=Path, default=ROOT / 'data/calc/assets')
    parser.add_argument('--database', type=Path, default=ROOT / 'data/calc/calczhbi.sqlite3')
    parser.add_argument('--apply', action='store_true')
    run(parser.parse_args())
