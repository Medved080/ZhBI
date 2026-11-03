"""Narrow, idempotent correction of three verified source links (no numeric edits)."""
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

MODEL_IDS = {'reg-doc05-3491d83a2241', 'reg-doc05-d7e043581ed1', 'reg-doc05-d065813d8162'}
SOURCE_SHA = 'c002cbcc27c61e5c4054c75e9524ff57c3fc0785cbb0331614a43a5283036c80'


def repair_links(models):
    changed = 0
    for key in MODEL_IDS:
        entry = models.get(key)
        if not entry: continue
        source = entry.get('source') or {}
        if source.get('id') != 'doc05' or source.get('sha256') != SOURCE_SHA: continue
        for part in entry.get('components', []):
            if (part.get('name') == 'Каркас пространственный КПВ10'
                    and part.get('pdfPage') == 110 and part.get('sheet') == 97):
                part.update(pdfPage=111, sheet=98)
                changed += 1
    return changed


def repair_assets(assets):
    """Preserve exact old bytes before the atomic replacement; do not rewrite on retry."""
    from .source_policy import SourcePolicy
    path = Path(assets) / 'promka-register.json'
    if not path.exists(): return 0
    original = path.read_bytes()
    data = json.loads(original)
    changed = repair_links(data)
    if not changed: return 0
    SourcePolicy(assets).page('doc05', 111)
    folder = path.parent / '.source-link-backups'
    folder.mkdir(exist_ok=True)
    backup = folder / (hashlib.sha256(original).hexdigest() + '.json')
    if not backup.exists():
        with backup.open('xb') as stream: stream.write(original)
    temporary = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n')
        os.chmod(temporary, path.stat().st_mode & 0o777)
        # Refuse to overwrite an edit made during this repair.
        if path.read_bytes() != original: raise RuntimeError('Каталог изменён другим процессом; повторите исправление ссылок')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return changed


def validate_assets(assets, resolve=None):
    """Check incoming catalog/readings before writing DB rows or installing assets."""
    from .source_policy import SourcePolicy
    policy = SourcePolicy(assets, resolve)
    models = {}
    for name in ('promka-models.json', 'promka-register.json'):
        path = Path(policy.resolve(name))
        if path.is_file(): models.update(json.loads(path.read_text()))
    repair_links(models)  # Accept the known old package only with the verified correction.
    readings_path = Path(policy.resolve('promka-readings.json'))
    readings = json.loads(readings_path.read_text()) if readings_path.is_file() else {}
    for key, entry in models.items():
        policy.model(entry)
        if key in readings: policy.reading(readings[key], entry.get('source', {}).get('id', 'doc02'))
    for filename in ('promka-solid-models.json', 'promka-sketches.json'):
        path = Path(policy.resolve(filename))
        if path.is_file():
            for key, entry in json.loads(path.read_text()).items():
                if key in models:
                    policy.reading(entry, models[key].get('source', {}).get('id', 'doc02'))
    return models, policy
