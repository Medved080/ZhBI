"""
Оркестрирует полный цикл обработки DXF-файла, загруженного через веб-UI:
сохранить на диск -> распарсить марки -> посчитать адресацию по осям ->
записать в БД. Использует ровно те же функции, что и CLI-скрипты
(scripts/parse_zhbi.py, scripts/assign_axes.py, scripts/import_elements.py) —
никакой отдельной копии логики парсинга/адресации здесь нет.

DXF читается один раз (а не трижды, как при последовательном запуске трёх
CLI-скриптов) — открытый ezdxf-документ переиспользуется и для марок, и для
сетки осей.
"""

import logging
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import ezdxf

import assign_axes
import import_elements
import new_standard_pipeline
import parse_zhbi
from layer_naming import LayerNameError

from app.db import get_connection, init_db
from app.models import DxfImportResult, ZoneImportSummary

logging.getLogger("ezdxf").setLevel(logging.ERROR)

UPLOADS_DIR = Path(__file__).resolve().parent.parent / "uploads"

# Слои, уже распознаваемые СТАРЫМ конвейером (LAYER_CONFIG/ANNOTATION_LAYERS/
# сетка осей) — исключаются из строгой валидации НОВОГО стандарта имён
# слоёв (scripts/layer_naming.py), иначе старые файлы сломались бы на
# "WEB_Оси" и подобных, которые не подходят под новую грамматику.
_KNOWN_OLD_LAYERS = (
    set(parse_zhbi.LAYER_CONFIG) | parse_zhbi.ANNOTATION_LAYERS | set(assign_axes.AXIS_LAYER_CANDIDATES)
)


def _load_allowed_subtypes(conn) -> dict:
    result = {}
    for row in conn.execute("SELECT element_type, subtype FROM allowed_subtypes"):
        result.setdefault(row["element_type"], set()).add(row["subtype"])
    return result


class DxfProcessingError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def save_uploaded_file(upload_file, uploads_dir: Path = UPLOADS_DIR) -> Path:
    filename = Path(upload_file.filename or "").name  # режет путь-траверсал (../..)
    if not filename.lower().endswith(".dxf"):
        raise DxfProcessingError(400, "Ожидается файл .dxf")

    uploads_dir.mkdir(parents=True, exist_ok=True)
    dest = uploads_dir / filename
    with open(dest, "wb") as f:
        shutil.copyfileobj(upload_file.file, f)
    return dest


def process_upload(dxf_path: Path, source_file: str) -> DxfImportResult:
    try:
        doc = ezdxf.readfile(str(dxf_path))
    except Exception:
        # ezdxf на повреждённых/обрезанных файлах кидает разные типы исключений
        # в зависимости от того, где именно парсер споткнулся (DXFStructureError,
        # UnicodeDecodeError, а на файле, обрезанном посреди секции, даже сырой
        # StopIteration из внутреннего итератора) — ловим широко, любая ошибка
        # чтения здесь означает одно и то же для пользователя: файл не подошёл.
        raise DxfProcessingError(422, "Файл повреждён или не является корректным DXF")

    msp = doc.modelspace()

    init_db()
    conn = get_connection()
    try:
        allowed_subtypes = _load_allowed_subtypes(conn)

        # Старый конвейер (LAYER_CONFIG) — без изменений.
        old_records = parse_zhbi.parse_dxf_from_doc(doc)

        # Сетка осей нужна РАНЬШЕ бинда элементов к зонам нового стандарта
        # (см. new_standard_pipeline.process — "лесенка" сужения зоны
        # стоянки крана с высотой опирается на реальные оси сетки), поэтому
        # строится до, а не после, как раньше.
        grid = assign_axes.build_axis_grid_auto(doc)

        # Новый стандарт имён слоёв (см. Docs/backlog.md) — работает
        # параллельно, не заменяет старый. Строгая валидация: любой
        # WEB_-слой, не распознанный старым конвейером и не подходящий под
        # новую грамматику, — явная ошибка с именем слоя, не молчаливый
        # пропуск (см. scripts/layer_naming.LayerNameError).
        try:
            new_records, zones, zone_review = new_standard_pipeline.process(
                msp, _KNOWN_OLD_LAYERS, allowed_subtypes, axis_grid=grid
            )
        except LayerNameError as e:
            raise DxfProcessingError(422, str(e))

        if not old_records and not new_records:
            layers = ", ".join(parse_zhbi.LAYER_CONFIG)
            raise DxfProcessingError(
                422,
                f"Не найдено элементов ни на слоях старого стандарта ({layers}), "
                f"ни на слоях нового стандарта имён (WEB_<Тип>..._Элемент)",
            )

        rows = []
        by_mark_source = {}
        by_axis_status = {}
        for record in old_records + new_records:
            address = assign_axes.assign_address(record, grid)
            rows.append(import_elements.build_row(record, address))
            by_mark_source[record.source] = by_mark_source.get(record.source, 0) + 1
            by_axis_status[address["status"]] = by_axis_status.get(address["status"], 0) + 1

        inserted, updated = import_elements.upsert_elements(conn, rows, source_file)
        n_numeric, n_letter = import_elements.save_axis_grid(conn, grid, source_file)

        zones_summary = None
        if zones or new_records:
            zone_handle_to_id = import_elements.upsert_zones(conn, zones, source_file)
            import_elements.apply_zone_bindings(conn, source_file, new_records, zone_handle_to_id)

            by_category = {}
            for z in zones:
                by_category[z.category] = by_category.get(z.category, 0) + 1
            needs_review = sum(1 for z in zones if z.match_status != "matched")
            bindings_needs_review = {"Захватка": 0, "Кран": 0, "Стоянка": 0}
            for record in new_records:
                for category, result in (record.zone_bindings or {}).items():
                    if result.status == "needs_review":
                        bindings_needs_review[category] += 1
            zones_summary = ZoneImportSummary(
                total=len(zones),
                by_category=by_category,
                needs_review=needs_review,
                element_bindings_needs_review=bindings_needs_review,
            )
    finally:
        conn.close()

    return DxfImportResult(
        source_file=source_file,
        inserted=inserted,
        updated=updated,
        total=inserted + updated,
        by_mark_source=by_mark_source,
        by_axis_status=by_axis_status,
        axis_grid={"numeric": n_numeric, "letter": n_letter},
        zones=zones_summary,
    )


def import_dxf_file(upload_file, source_file_override, uploads_dir: Path = UPLOADS_DIR) -> DxfImportResult:
    saved_path = save_uploaded_file(upload_file, uploads_dir)
    source_file = source_file_override or saved_path.name
    return process_upload(saved_path, source_file)
