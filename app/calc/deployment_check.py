"""Read-only source eligibility gate for a copy of the target server's calculator."""
from contextlib import closing
from pathlib import Path
import sqlite3

from .database import SCHEMA_VERSION
from .source_link_repairs import validate_assets
from .source_policy import SourceSheetBlocked


def check_sources(assets, database):
    """Never initialize/migrate the database or persist the in-memory link repairs."""
    result = {'ready': False, 'database': str(Path(database).resolve()),
              'assets': str(Path(assets).resolve()), 'errors': []}
    try:
        # mode=ro also refuses to create a database when the path is wrong.
        with closing(sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True)) as conn:
            conn.execute('BEGIN')
            schema = conn.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0]
            result['schemaVersion'] = schema
            if schema != SCHEMA_VERSION:
                raise ValueError(f'Схема калькулятора {schema}, ожидается {SCHEMA_VERSION}; сначала отрепетируйте миграцию на копии')
            if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('Копия базы не прошла quick_check')
            if conn.execute('PRAGMA foreign_key_check').fetchone():
                raise ValueError('В копии базы нарушены внешние ключи')
            rows = conn.execute('SELECT document_model_id,manual_fields FROM products').fetchall()
            result['products'] = len(rows)
            result['linkedProducts'] = sum(bool(row[0]) for row in rows)
            result['productsWithManualFields'] = sum(row[1] not in (None, '', '[]') for row in rows)
            models, policy = validate_assets(assets)
            result['catalogModels'] = len(models)
            missing = sorted({row[0] for row in rows if row[0] and row[0] not in models})
            if missing:
                result['errors'].append({'code': 'missing_models', 'modelIds': missing,
                                         'message': 'У сохранённых изделий отсутствуют модели и источники'})
            # validate_assets checks every catalog entry and its reading/model provenance,
            # including the known correction in memory, without rewriting the target files.
            result['reviewedAlbums'] = sum(meta.get('sha256') in policy.review for meta in policy.sources.values())
            result['ready'] = not result['errors']
    except SourceSheetBlocked as error:
        result['errors'].append(error.detail)
    except (OSError, ValueError, sqlite3.Error) as error:
        result['errors'].append({'code': 'preflight_failed', 'message': str(error)})
    return result
