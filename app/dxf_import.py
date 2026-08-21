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
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import ezdxf

import assign_axes
import import_elements
import new_standard_pipeline
import parse_zhbi
from layer_naming import LayerNameError
from zone_parser import classify_layers

from app import activity, element_sync, zone_sync
from app.db import get_connection, init_db
from app.models import DxfImportResult, ZoneImportSummary
from app.upload_limits import copy_upload_limited

logging.getLogger("ezdxf").setLevel(logging.ERROR)

UPLOADS_DIR = Path(__file__).resolve().parent.parent / "uploads"

# Слои, уже распознаваемые СТАРЫМ конвейером (LAYER_CONFIG/ANNOTATION_LAYERS/
# сетка осей) — исключаются из строгой валидации НОВОГО стандарта имён
# слоёв (scripts/layer_naming.py), иначе старые файлы сломались бы на
# "WEB_Оси" и подобных, которые не подходят под новую грамматику.
_KNOWN_OLD_LAYERS = (
    set(parse_zhbi.LAYER_CONFIG) | parse_zhbi.ANNOTATION_LAYERS | set(assign_axes.AXIS_LAYER_CANDIDATES)
)


def _load_allowed_subtypes(conn, object_id: Optional[int]) -> dict:
    """Справочник подтипов ОДНОГО объекта (2026-08-21): у соседнего здания
    свой набор отметок, и подставлять его в разбор этого чертежа незачем.

    object_id = None — объекта ещё нет (первая в жизни установка, объект
    заведёт сам импорт). Справочник тогда пуст, и КАЖДЫЙ подтип файла
    окажется новым: ровно то, что нужно, — объект наполнится с нуля.
    """
    result = {}
    if object_id is None:
        return result
    for row in conn.execute(
        "SELECT element_type, subtype FROM allowed_subtypes WHERE object_id = ?", (object_id,)
    ):
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
    copy_upload_limited(upload_file.file, dest)
    return dest


@dataclass
class ParsedDrawing:
    """Результат РАЗБОРА чертежа, ещё ничего не записано в БД. Отдельная
    структура нужна двухфазному импорту (решение И3): первая фаза считает
    сверку и отдаёт сводку, вторая — применяет; между ними разбор не
    повторяется (на реальном файле это 9422 элемента и заметное время)."""
    source_file: str
    rows: list
    new_records: list
    zones: list
    grid: object
    by_mark_source: dict
    by_axis_status: dict
    # Подтипы, которых в справочнике ОБЪЕКТА ещё не было: [(тип, подтип), ...]
    # в порядке появления (2026-08-21). Записываются в справочник на фазе
    # ПРИМЕНЕНИЯ, не разбора: фаза анализа не пишет в базу ничего (решение И3),
    # и «загрузку отменили, а подтипы остались» было бы ровно таким письмом.
    new_subtypes: list = field(default_factory=list)


def _collect_new_subtypes(msp, allowed_subtypes: dict) -> list:
    """Какие подтипы файла отсутствуют в справочнике объекта.

    Считается ОТДЕЛЬНЫМ проходом по именам слоёв, а не внутри
    new_standard_pipeline.process: тот возвращает записи изделий, и подтип,
    попавший только на слой «Марка» без парного слоя «Элемент», в них не
    виден вовсе — а в справочник он нужен, иначе следующая загрузка снова
    сочтёт его новым. Проход дешёвый: это разбор нескольких десятков строк
    с именами слоёв, а не обход геометрии.
    """
    unclaimed = new_standard_pipeline.discover_unclaimed_web_layers(msp, _KNOWN_OLD_LAYERS)
    итог = []
    for parsed in classify_layers(unclaimed, allowed_subtypes).values():
        if parsed.subtype_is_new and (parsed.type_or_category, parsed.subtype) not in итог:
            итог.append((parsed.type_or_category, parsed.subtype))
    return итог


def parse_drawing(dxf_path: Path, source_file: str, object_id: Optional[int] = None) -> ParsedDrawing:
    """object_id — объект, в чей справочник подтипов смотрит разбор
    (2026-08-21). Он известен ДО разбора: форма загрузки спрашивает объект
    первым шагом, а неинтерактивные пути разрешают его сами (см.
    element_sync.resolve_import_object). Пусто — только первая в жизни
    установка, где объекта ещё нет."""
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
        allowed_subtypes = _load_allowed_subtypes(conn, object_id)
        # Считается ДО process(): тот получает справочник и пополняет
        # разобранные записи, а нам нужен состав ИМЕННО нового — то есть
        # разница со справочником в его исходном виде.
        #
        # LayerNameError ловится ЗДЕСЬ ЖЕ, а не только вокруг process():
        # проход по именам слоёв тот же самый, и первым до непроходного слоя
        # доходит он. Без этого отказ по имени слоя уходил бы наружу сырым
        # исключением — то есть 500 вместо понятного 422 (поймано прогоном
        # на реальном файле с опечаткой в отметке).
        try:
            new_subtypes = _collect_new_subtypes(msp, allowed_subtypes)
        except LayerNameError as e:
            raise DxfProcessingError(422, str(e))

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
    finally:
        conn.close()

    return ParsedDrawing(
        source_file=source_file,
        rows=rows,
        new_records=new_records,
        zones=zones,
        grid=grid,
        by_mark_source=by_mark_source,
        by_axis_status=by_axis_status,
        new_subtypes=new_subtypes,
    )


def _zones_summary(parsed: ParsedDrawing) -> Optional[ZoneImportSummary]:
    if not parsed.zones and not parsed.new_records:
        return None
    by_category = {}
    for zone in parsed.zones:
        by_category[zone.category] = by_category.get(zone.category, 0) + 1
    bindings_needs_review = {"Захватка": 0, "Кран": 0, "Стоянка": 0}
    for record in parsed.new_records:
        for category, result in (record.zone_bindings or {}).items():
            if result.status == "needs_review":
                bindings_needs_review[category] += 1
    return ZoneImportSummary(
        total=len(parsed.zones),
        by_category=by_category,
        needs_review=sum(1 for z in parsed.zones if z.match_status != "matched"),
        element_bindings_needs_review=bindings_needs_review,
    )


_ZONE_FIELDS = {
    "Захватка": ("zone_zakhvatka_id", "Захватка"),
    "Кран": ("zone_crane_id", "Кран"),
    "Стоянка": ("zone_stance_id", "Стоянка"),
}


def _zone_change_review(conn, object_id: int, parsed: ParsedDrawing, match) -> list:
    """У каких изделий сменится привязка к зоне, если применить чертёж
    (2026-08-05, запрос пользователя).

    Зачем. Зоны считаются ГЕОМЕТРИЧЕСКИ: изделие относится к той захватке,
    крану и стоянке, в чей полигон оно попало. Заказчик перерисовал границу
    захватки на пару метров — и десятки изделий молча переехали в соседнюю,
    а вместе с ними переехали отчёты по захваткам и планы работ. До этой
    сводки такое было видно только постфактум и только если приглядеться.

    Как считается. Привязка НОВОГО чертежа уже посчитана разбором
    (`record.zone_bindings`, см. scripts/zone_binding) — но не в виде id
    записей справочника: их ещё нет, зоны синхронизируются на фазе
    применения. Поэтому сравниваем по ИМЕНИ зоны: у входящей — имя полигона
    из чертежа, у текущей — имя записи справочника. Это же и правильный
    ключ по смыслу: «Захватка 3» остаётся третьей захваткой, даже если
    запись справочника пересоздали.

    Сопоставление изделий берётся готовым из `match` — второй раз считать
    его нельзя, оно дорогое и должно совпасть с тем, что применится.
    """
    имя_по_handle = {z.handle: (z.category, z.name) for z in parsed.zones}
    привязки_по_handle = {
        r.id: r.zone_bindings for r in parsed.new_records if r.zone_bindings
    }
    if not привязки_по_handle:
        return []

    текущие = {
        r["id"]: r for r in conn.execute(
            """
            SELECT e.id, e.dxf_handle, e.element_type, e.mark, e.current_status,
                   zz.name AS Захватка, zc.name AS Кран, zs.name AS Стоянка
            FROM elements e
            LEFT JOIN zones zz ON zz.id = e.zone_zakhvatka_id
            LEFT JOIN zones zc ON zc.id = e.zone_crane_id
            LEFT JOIN zones zs ON zs.id = e.zone_stance_id
            WHERE e.object_id = ? AND e.is_current = 1
            """,
            (object_id,),
        )
    }

    изменения = []
    for item in match.matched:
        было = текущие.get(item.element_id)
        if было is None:
            continue
        входящая = parsed.rows[item.incoming_index]
        привязки = привязки_по_handle.get(входящая["dxf_handle"])
        if not привязки:
            continue
        расхождения = {}
        for категория, результат in привязки.items():
            стало = None
            if результат.zone_handle:
                пара = имя_по_handle.get(результат.zone_handle)
                стало = пара[1] if пара else None
            if (было[категория] or None) != (стало or None):
                расхождения[категория] = [было[категория], стало]
        if расхождения:
            изменения.append({
                "element_id": item.element_id,
                "dxf_handle": было["dxf_handle"],
                "element_type": было["element_type"],
                "mark": было["mark"],
                "current_status": было["current_status"],
                "changes": расхождения,
            })
    return изменения


def analyze_drawing(parsed: ParsedDrawing, object_id: Optional[int] = None) -> dict:
    """Фаза 1: что изменится, если применить чертёж. Ничего не пишет.
    Возвращает словарь для DxfAnalyzeResult + сам MatchResult (ключ
    "match"), который фаза 2 берёт как есть."""
    init_db()
    conn = get_connection()
    try:
        resolved_object_id = element_sync.resolve_import_object(conn, object_id, parsed.source_file)
        # resolve_import_object может СОЗДАТЬ объект на первой в жизни
        # установке — это единственная запись фазы анализа, и без неё
        # сверять было бы не с чем.
        conn.commit()
        analysis = element_sync.analyze_import(conn, resolved_object_id, parsed.rows)
        # Расхождения по ЗОНАМ (решение З1): зона опознаётся по номеру, но её
        # геометрия могла измениться — пользователь решает, правка это или уже
        # другая зона.
        zones_review = zone_sync.analyze_zones(conn, resolved_object_id, parsed.zones)
        analysis["counts"]["zone_conflicts"] = len(zones_review["zone_conflicts"])
        analysis["counts"]["zones_new"] = len(zones_review["new_zones"])
        analysis["details"]["zone_conflicts"] = zones_review["zone_conflicts"][:element_sync.DETAIL_LIMIT]
        analysis["details"]["zones_new"] = zones_review["new_zones"][:element_sync.DETAIL_LIMIT]
        # Смена привязки изделий к зонам — см. _zone_change_review выше.
        # Считается ПОСЛЕ analyze_import: сопоставление изделий берётся
        # оттуда готовым, второй раз оно не считается.
        смена_зон = _zone_change_review(conn, resolved_object_id, parsed, analysis["match"])
        analysis["counts"]["zone_binding_changes"] = len(смена_зон)
        analysis["counts"]["zone_binding_changes_with_progress"] = sum(
            1 for e in смена_зон if e["current_status"] != "planned")
        analysis["details"]["zone_binding_changes"] = смена_зон[:element_sync.DETAIL_LIMIT]
        # Новые подтипы — в сводку наравне с прочими расхождениями
        # (2026-08-21): загрузка пополняет справочник объекта сама, и
        # пользователь обязан увидеть заранее, ЧТО именно там появится.
        # Опечатка в имени слоя иначе тихо превратилась бы в подтип.
        analysis["counts"]["subtypes_new"] = len(parsed.new_subtypes)
        analysis["details"]["subtypes_new"] = [
            {"element_type": тип, "subtype": подтип} for тип, подтип in parsed.new_subtypes
        ][:element_sync.DETAIL_LIMIT]
        object_row = conn.execute(
            "SELECT name FROM objects WHERE id = ?", (resolved_object_id,)
        ).fetchone()
        previous = conn.execute(
            "SELECT source_file FROM object_drawings WHERE object_id = ? AND is_current = 1",
            (resolved_object_id,),
        ).fetchone()
    finally:
        conn.close()

    analysis["object_name"] = object_row["name"] if object_row else ""
    analysis["previous_source_file"] = previous["source_file"] if previous else None
    analysis["zones"] = _zones_summary(parsed)
    analysis["axis_grid"] = {
        "numeric": len(parsed.grid.numeric_axes), "letter": len(parsed.grid.letter_axes)
    }
    analysis["by_mark_source"] = parsed.by_mark_source
    analysis["by_axis_status"] = parsed.by_axis_status
    return analysis


def apply_drawing(
    parsed: ParsedDrawing,
    analysis: dict,
    accept_mark_changes: bool = True,
    keep_mark_element_ids=None,
    refill_manual_fields=None,
    create_new_zone_ids=None,
    user=None,
    request_id=None,
) -> DxfImportResult:
    """Фаза 2: применяет уже посчитанную сверку. Порядок операций тот же,
    что был у одношагового импорта: элементы -> сетка осей -> зоны и
    привязки (привязка опирается на только что записанные зоны)."""
    object_id = analysis["object_id"]
    init_db()
    conn = get_connection()
    try:
        # Подтипы — ПЕРВЫМИ, до записи изделий: изделие ссылается на подтип
        # своим полем, и проверка реквизитов (app/element_fields) сверяет
        # его со справочником ОБЪЕКТА. В обратном порядке только что
        # загруженное изделие на мгновение оказывалось бы с подтипом,
        # которого в справочнике ещё нет.
        for тип, подтип in parsed.new_subtypes:
            conn.execute(
                "INSERT OR IGNORE INTO allowed_subtypes (object_id, element_type, subtype) "
                "VALUES (?, ?, ?)",
                (object_id, тип, подтип),
            )
        if parsed.new_subtypes:
            conn.commit()
            activity.log(
                "subtype_add_import", user=user, request_id=request_id,
                entity_type="object", entity_id=object_id,
                new_value=", ".join(f"{тип} · {подтип}" for тип, подтип in parsed.new_subtypes)[:400],
                details={"чертёж": parsed.source_file,
                         "подтипы": [list(p) for p in parsed.new_subtypes]},
            )
        applied = element_sync.apply_import(
            conn, object_id, parsed.source_file, parsed.rows, analysis["match"],
            accept_mark_changes=accept_mark_changes,
            keep_mark_element_ids=set(keep_mark_element_ids or ()),
            refill_manual_fields={
                int(element_id): set(fields)
                for element_id, fields in (refill_manual_fields or {}).items()
            },
            user=user, request_id=request_id,
        )
        n_numeric, n_letter = import_elements.save_axis_grid(conn, parsed.grid, parsed.source_file)

        if parsed.zones or parsed.new_records:
            # Зоны — в справочник (app/zone_sync), а не полным DELETE+INSERT,
            # как раньше: на записи справочника ссылаются элементы, снести и
            # создать заново означало бы потерять эти ссылки (этап 2).
            zone_handle_to_id = zone_sync.sync_zones(
                conn, object_id, parsed.source_file, parsed.zones,
                create_new_zone_ids=set(create_new_zone_ids or ()),
            )
            # Цвета кранов раньше назначались внутри upsert_zones — вызываем
            # ту же функцию явно, чтобы новая цветовая схема не пропала вместе
            # с заменой записи зон (ключ у цветов свой: объект + имя крана,
            # с этапа D — раньше был файл, и настроенный цвет терялся на
            # каждой новой версии чертежа).
            import_elements._ensure_zone_colors(conn, parsed.zones, object_id)
            import_elements.apply_zone_bindings(
                conn, parsed.source_file, parsed.new_records, zone_handle_to_id
            )
    finally:
        conn.close()

    counts = analysis["counts"]
    return DxfImportResult(
        source_file=parsed.source_file,
        inserted=applied["inserted"],
        updated=applied["updated"],
        total=applied["total_current"],
        by_mark_source=parsed.by_mark_source,
        by_axis_status=parsed.by_axis_status,
        axis_grid={"numeric": n_numeric, "letter": n_letter},
        zones=_zones_summary(parsed),
        object_id=object_id,
        retired=applied["retired"],
        matched_by_handle=counts.get("matched_by_handle", 0),
        matched_by_geometry=counts.get("matched_by_geometry", 0),
        marks_kept=applied["marks_kept"],
        manual_kept=applied["manual_kept"],
    )


# Разобранные, но ещё не применённые чертежи — между фазами анализа и
# применения (решение И3). Держим в памяти процесса, а не в БД: это
# промежуточное состояние одного пользователя, живущее минуты, и записывать
# его в боевую базу ради этого незачем. Повторный разбор на фазе применения
# был бы честнее по отношению к перезапуску сервера, но стоит целого
# прохода по файлу на 9422 элемента.
#
# Ограничение по числу записей, а не по времени: пользователь либо применяет
# сводку сразу, либо уходит — таймер сложнее и ничего не добавляет. Если
# сервер перезапустится между фазами, токен пропадёт и фаза применения
# вернёт понятную ошибку (см. get_pending) вместо тихого сбоя.
_PENDING_IMPORTS = {}
_PENDING_LIMIT = 3


def remember_pending(parsed: ParsedDrawing, analysis: dict) -> str:
    import uuid

    token = uuid.uuid4().hex
    _PENDING_IMPORTS[token] = (parsed, analysis)
    while len(_PENDING_IMPORTS) > _PENDING_LIMIT:
        _PENDING_IMPORTS.pop(next(iter(_PENDING_IMPORTS)))
    return token


def get_pending(token: str):
    pending = _PENDING_IMPORTS.get(token)
    if pending is None:
        raise DxfProcessingError(
            410,
            "Результат разбора чертежа уже недоступен (сервер перезапускался "
            "или разбор устарел). Загрузите файл заново.",
        )
    return pending


def forget_pending(token: str) -> None:
    _PENDING_IMPORTS.pop(token, None)


def process_upload(dxf_path: Path, source_file: str, object_id: Optional[int] = None,
                   backup_comment: Optional[str] = None) -> DxfImportResult:
    """Одношаговый импорт с решениями по умолчанию — путь для НЕинтерактивных
    вызовов (scripts/rebuild_db.py, загрузка из Input/, решение З3: смены
    марок принимаются, но сводка печатается, а не проглатывается молча).

    backup_comment — снять копию базы перед записью и подписать её так.
    Пусто — НЕ снимать: копию уже взял вызывающий. Так у загрузки из папки
    Input одна копия на весь пакет (а не по одной на каждый чертёж), а у
    полной пересборки — своя, `auto_before_rebuild`.
    """
    # Объект разрешается ДО разбора (2026-08-21): разбору нужен справочник
    # подтипов ИМЕННО этого объекта. Раньше здесь передавалось None, и
    # разбор шёл по пустому справочнику — повторная загрузка на базе с
    # одним объектом докладывала бы, что все до единого подтипа новые.
    # Заодно отказ «в базе несколько объектов» приходит сразу, а не после
    # разбора девяти тысяч изделий.
    init_db()
    conn = get_connection()
    try:
        object_id = element_sync.resolve_import_object(conn, object_id, source_file)
        conn.commit()
    finally:
        conn.close()

    parsed = parse_drawing(dxf_path, source_file, object_id)
    analysis = analyze_drawing(parsed, object_id)
    # Копия — ПОСЛЕ разбора и сверки, но ДО первой записи: разбор ничего не
    # пишет, и снимать копию под файл, который сейчас окажется битым или
    # не тем, незачем.
    if backup_comment:
        from app import backups
        backups.backup_before_import(backup_comment)
    print(f"[import] {source_file}: {element_sync.summary_for_log(analysis['counts'])}")
    return apply_drawing(parsed, analysis)


def import_dxf_file(upload_file, source_file_override, uploads_dir: Path = UPLOADS_DIR) -> DxfImportResult:
    saved_path = save_uploaded_file(upload_file, uploads_dir)
    source_file = source_file_override or saved_path.name
    return process_upload(saved_path, source_file,
                          backup_comment=f"чертёж {source_file} (одношаговая загрузка)")
