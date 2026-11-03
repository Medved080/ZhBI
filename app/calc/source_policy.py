"""Eligibility of drawing pages, tied to reviewed PDF bytes rather than filenames.

Unknown/missing/changed PDFs fail closed. Original albums (including their cancelled
pages) remain intact for document history; only their use as calculation input is
forbidden. Review data is shipped with code and cannot be changed by a sync package.
"""
import hashlib
import json
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException

REVIEW_FILE = Path(__file__).with_name('reviewed-source-sheets.json')
PAGE_KEYS = {'productPage', 'cagePage', 'registerPage', 'pdfPage', 'sourcePage', 'drawingPage'}
SKIP_KEYS = {'paths', 'vertices', 'bodyPolygon', 'profile', 'points', 'sourceCorrections'}


class SourceSheetBlocked(HTTPException):
    def __init__(self, source_id, page, reason, code='source_sheet_not_reviewed'):
        self.source_id, self.page, self.reason = source_id, page, reason
        super().__init__(409, {'code': code, 'message':
            f'Импорт и расчёт запрещены: {source_id}, PDF-стр. {page}: {reason}',
            'sourceId': source_id, 'pdfPage': page})


def _stamp(path):
    try:
        s = Path(path).stat()
        return s.st_size, s.st_mtime_ns, s.st_ctime_ns
    except FileNotFoundError:
        return None


@lru_cache(maxsize=256)
def _json(path, stamp):
    return json.loads(Path(path).read_text())


@lru_cache(maxsize=256)
def _sha(path, stamp):
    with Path(path).open('rb') as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def references(value, source_id=None):
    """Explicit PDF provenance, including recursive assembly dependencies.

    Drawing sheet numbers are not PDF pages. Numeric geometry arrays are skipped.
    """
    if isinstance(value, dict):
        source = value.get('source')
        if isinstance(source, dict): source_id = source.get('id', source_id)
        elif isinstance(source, str) and source.startswith('doc'): source_id = source
        source_id = value.get('sourceId', source_id)
        if isinstance(value.get('id'), str) and value['id'].startswith('doc'):
            source_id = value['id']
        if isinstance(value.get('doc'), int): source_id = 'doc%02d' % value['doc']
        for key, child in value.items():
            if key in PAGE_KEYS or (key == 'page' and 'doc' in value):
                if child is not None: yield source_id or 'doc02', child
            elif key == 'sourcePages' and isinstance(child, list):
                for page in child:
                    if isinstance(page, int): yield source_id or 'doc02', page
            if key not in SKIP_KEYS and isinstance(child, (dict, list)):
                yield from references(child, source_id)
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)): yield from references(child, source_id)


class SourcePolicy:
    def __init__(self, assets, resolve=None):
        self.assets = Path(assets)
        self.resolve = resolve or (lambda relative: self.assets / relative)
        path = Path(self.resolve('promka-sources.json'))
        self.sources = _json(str(path), _stamp(path)) if path.is_file() else {}
        self.review = _json(str(REVIEW_FILE), _stamp(REVIEW_FILE))['albums']

    def page(self, source_id, page):
        sid = 'doc02' if source_id == 'promka-columns' else source_id
        meta = self.sources.get(sid)
        if not meta:
            raise SourceSheetBlocked(source_id, page, 'исходный альбом не установлен')
        if type(page) is not int or not 1 <= page <= meta.get('pages', 0):
            raise SourceSheetBlocked(source_id, page, 'номер страницы вне альбома')
        review = self.review.get(meta.get('sha256'))
        if not review or review['pages'] != meta['pages']:
            raise SourceSheetBlocked(source_id, page, 'эта редакция PDF не прошла проверку листов')
        # Never let a false metadata SHA or an unchanged preview cache admit new PDF bytes.
        name = meta.get('storageName', '')
        if Path(name).name != name or not name:
            raise SourceSheetBlocked(source_id, page, 'недопустимый путь исходного PDF')
        path = Path(self.resolve('sources/' + name))
        if not path.is_file() and sid == 'doc02': path = Path(self.resolve('promka-source.pdf'))
        stamp = _stamp(path)
        if stamp is None or _sha(str(path), stamp) != meta['sha256']:
            raise SourceSheetBlocked(source_id, page, 'исходный PDF отсутствует или изменён после проверки')
        if page in review['annulledPages']:
            raise SourceSheetBlocked(source_id, page, 'лист АННУЛИРОВАН', 'annulled_source_sheet')

    def allowed(self, source_id, page):
        try:
            self.page(source_id, page)
            return True
        except SourceSheetBlocked:
            return False

    def reading(self, reading, source_id=None):
        for sid, page in references(reading, source_id):
            self.page(sid, page)

    def model(self, entry):
        source = entry.get("source")
        if entry.get("id") or entry.get("kind") == "registry":
            if not isinstance(source, dict) or source.get("productPage") is None:
                raise SourceSheetBlocked(entry.get("id", "?"), "?", "у модели не указан исходный лист")
        if isinstance(source, dict) and source.get("sha256"):
            sid = source.get("id", "doc02")
            meta = self.sources.get("doc02" if sid == "promka-columns" else sid, {})
            if source["sha256"] != meta.get("sha256"):
                raise SourceSheetBlocked(sid, source.get("productPage", "?"), "модель относится к другой редакции PDF")
        for sid, page in references(entry, (source or {}).get("id", "doc02")):
            self.page(sid, page)
        # Original two source models encode component PDF pages as drawing-sheet + 15.
        if entry.get('kind') != 'registry' and entry.get('source'):
            sid = entry['source'].get('id', 'doc02')
            for group in entry.get('groups', []):
                if type(group.get('sheet')) is int: self.page(sid, group['sheet'] + 15)


def ensure_model(entry, assets=None, policy=None):
    if assets is None:
        from .document_models import ASSETS
        assets = ASSETS
    (policy or SourcePolicy(assets)).model(entry)


def signature(assets):
    """Invalidate workspace responses when PDF bytes/metadata/review data change."""
    policy = SourcePolicy(assets)
    return (_stamp(REVIEW_FILE), _stamp(policy.resolve('promka-sources.json')),
            tuple((sid, _stamp(policy.resolve('sources/' + meta['storageName'])))
                  for sid, meta in sorted(policy.sources.items())),
            _stamp(policy.resolve('promka-source.pdf')))
