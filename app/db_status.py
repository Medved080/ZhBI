"""Отчёт «Состояние БД» для администратора сервиса.

Что показывает: структуру базы (те же таблицы, поля и связи с их
назначением, что и схема `Docs/db-schema.drawio` — источник у них ОДИН,
`app/db_schema_doc.py`), сколько в каждой таблице записей, сколько она
занимает на диске, и содержимое любой таблицы построчно.

Зачем это внутри сервиса, а не «зайти по SSH и посмотреть sqlite3»: у
администратора сервиса нет ни репозитория, ни доступа к файлу базы (см. тот
же довод в `app/admin_guide.py`), а вопросы «что вообще хранится», «почему
база выросла до N ГБ» и «что реально записалось при импорте» возникают
именно у него и именно тогда, когда посмотреть больше нечем.

**Размер считает `dbstat`** — виртуальная таблица SQLite, отдающая реальное
число страниц каждого b-дерева, а не оценку по длине значений. Она есть не в
любой сборке (`SQLITE_ENABLE_DBSTAT_VTAB`), поэтому доступность проверяется
на месте: проверено, что она есть и в python3 на машине разработчика
(SQLite 3.51), и в образе `python:3.12-slim` (SQLite 3.46), на котором
собирается контейнер. Если сборка окажется без неё — размеры не показываются
вовсе и об этом пишется прямо. Оценка «по длине значений» сознательно НЕ
делается: она не учитывает ни индексы, ни служебные страницы, ни свободное
место, и разошлась бы с реальным файлом в разы — а отчёт про размер, в
котором размер неверный, хуже отчёта без размера. Индексы считаются
ОТДЕЛЬНОЙ величиной и приписываются своей таблице: на `elements` они дают
заметную долю, и «таблица занимает X» без них вводило бы в заблуждение.

**Просмотр содержимого — только чтение и только по белому списку.** Имя
таблицы подставляется в SQL (иначе выборку не построить: имя таблицы нельзя
передать параметром), поэтому оно берётся из `sqlite_master` и сверяется на
точное совпадение. Ни строка из запроса, ни имя из описания в SQL не
попадают. Значения секретных колонок (`app/db_schema_doc.SECRET_COLUMNS` —
хэш и соль пароля, токен сессии) заменяются точками: это не «личные
данные», а материал для входа под чужой учётной записью, и системному
администратору он тоже не нужен.

Доступ — системный админ (`require_system_admin`): отчёт показывает данные
всех объектов сразу, объектная роль тут не годится.
"""

import os
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

import app.activity as activity
import app.db as _db
import app.db_schema_doc as doc
from app.access import require_service_feature

router = APIRouter(tags=["db-status"])

# Потолок страницы просмотра. Тысяча строк по сорок колонок — это уже
# несколько мегабайт JSON, и браузеру их рисовать дольше, чем человеку
# читать; постранично тот же объём смотрится без единой задержки.
MAX_PAGE = 500
DEFAULT_PAGE = 50

# Длинные значения (контур элемента в `outline_json` — тысячи символов)
# обрезаются: в таблице их всё равно не прочесть, а страницу они раздувают
# на порядок. Полная длина показывается рядом, чтобы обрезка не выглядела
# как «в базе лежит вот столько».
MAX_VALUE_CHARS = 300

MASK = "••••••••"


def _dbstat_sizes(conn: sqlite3.Connection) -> Optional[dict]:
    """Байты по каждому b-дереву: {имя таблицы или индекса: размер}.

    None — сборка SQLite без dbstat (см. модульную строку документации).
    """
    try:
        rows = conn.execute("SELECT name, SUM(pgsize) AS b FROM dbstat GROUP BY name").fetchall()
    except sqlite3.OperationalError:
        return None
    return {r["name"]: int(r["b"] or 0) for r in rows}


def _index_owners(conn: sqlite3.Connection) -> dict:
    """Индекс -> таблица, которой он принадлежит.

    Нужен, чтобы приписать размер индекса его таблице: в dbstat индекс —
    самостоятельное b-дерево со своим именем.
    """
    return {r["name"]: r["tbl_name"] for r in conn.execute(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")}


def _db_tables(conn: sqlite3.Connection) -> list:
    return [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def _file_bytes() -> int:
    """Размер файла базы на диске — вместе со спутниками -wal/-journal.

    Сумма размеров таблиц с ним не сходится (свободные страницы, служебные
    заголовки), и это нормально; в отчёте обе величины показаны рядом
    именно поэтому.
    """
    total = 0
    for suffix in ("", "-wal", "-journal", "-shm"):
        try:
            total += os.path.getsize(str(_db.DB_PATH) + suffix)
        except OSError:
            pass
    return total


@router.get("/admin/db-status")
def db_status(admin: sqlite3.Row = Depends(require_service_feature("db_status", "read"))):
    conn = _db.get_connection()
    try:
        существующие = _db_tables(conn)
        sizes = _dbstat_sizes(conn)
        owners = _index_owners(conn)

        # Размер индексов приписывается их таблице отдельной величиной.
        index_bytes = {}
        if sizes:
            for имя, байт in sizes.items():
                владелец = owners.get(имя)
                if владелец:
                    index_bytes[владелец] = index_bytes.get(владелец, 0) + байт

        page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        page_count = conn.execute("PRAGMA page_count").fetchone()[0]
        freelist = conn.execute("PRAGMA freelist_count").fetchone()[0]

        таблицы = []
        for имя in существующие:
            описание = doc.BY_NAME.get(имя)
            колонки_бд = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % имя)]
            поля = []
            for fname, ftype, fkey, purpose in doc.fields_of(имя):
                поля.append({
                    "name": fname, "type": ftype, "key": fkey,
                    "purpose": purpose, "in_db": fname in колонки_бд,
                })
            # Колонка, которой нет в описании: показываем её отдельно и
            # честно — «есть в базе, назначение не описано», а не прячем.
            описанные = {f["name"] for f in поля}
            for c in колонки_бд:
                if c not in описанные:
                    поля.append({"name": c, "type": "", "key": "",
                                 "purpose": "", "in_db": True, "undocumented": True})
            таблицы.append({
                "name": имя,
                "caption": описание[1] if описание else имя,
                "fill": описание[2] if описание else doc.C_REF,
                "stroke": описание[3] if описание else doc.S_REF,
                "domain": doc.DOMAIN_BY_FILL.get(описание[2] if описание else doc.C_REF,
                                                 "Не описано"),
                "described": описание is not None,
                "rows": conn.execute("SELECT COUNT(*) FROM %s" % имя).fetchone()[0],
                "bytes": sizes.get(имя) if sizes else None,
                "index_bytes": index_bytes.get(имя, 0) if sizes else None,
                "fields": поля,
            })

        связи = [{"child": a, "child_field": b, "parent": c, "parent_field": d,
                  "note": note} for a, b, c, d, note in doc.FKS]
        мягкие = [{"child": a, "child_field": b, "parent": c, "parent_field": d,
                   "note": note} for a, b, c, d, note in doc.SOFT]

        activity.log("db_status_open", user=admin, entity_type="database")
        return {
            "database": {
                "path": str(_db.DB_PATH),
                "file_bytes": _file_bytes(),
                "page_size": page_size,
                "page_count": page_count,
                "free_bytes": freelist * page_size,
                "sqlite_version": sqlite3.sqlite_version,
                "sizes_available": sizes is not None,
            },
            # Порядок групп — как в легенде схемы (иерархия → пользователи →
            # элементы → зоны → контрактация → справочники), а не по алфавиту
            # имён таблиц: на экране должно быть то же деление, что в
            # Docs/db-schema.drawio, иначе два представления одной базы
            # выглядят по-разному без всякой причины.
            "domains": list(doc.DOMAIN_BY_FILL.values()),
            "tables": таблицы,
            "relations": связи,
            "soft_relations": мягкие,
            # Расхождения описания с реальной схемой — тем же кодом, что и у
            # генератора Docs/db-schema.drawio. Пустой список = сходится.
            "drift": doc.verify(conn),
        }
    finally:
        conn.close()


@router.get("/admin/db-status/tables/{table}")
def table_rows(
    table: str,
    limit: int = Query(DEFAULT_PAGE, ge=1, le=MAX_PAGE),
    offset: int = Query(0, ge=0),
    admin: sqlite3.Row = Depends(require_service_feature("db_status", "read")),
):
    conn = _db.get_connection()
    try:
        if table not in _db_tables(conn):
            raise HTTPException(status_code=404, detail="Таблицы нет в этой базе")

        колонки = [{"name": r[1], "type": r[2], "pk": bool(r[5]),
                    "purpose": doc.purpose_of(table, r[1]),
                    "masked": (table, r[1]) in doc.SECRET_COLUMNS}
                   for r in conn.execute("PRAGMA table_info(%s)" % table)]
        всего = conn.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]

        # rowid даёт устойчивый порядок «как лежит в базе». У таблиц
        # WITHOUT ROWID его нет — тогда порядок отдаём как есть, а не
        # выдумываем сортировку по первой колонке.
        try:
            строки = conn.execute(
                "SELECT * FROM %s ORDER BY rowid LIMIT ? OFFSET ?" % table,
                (limit, offset)).fetchall()
        except sqlite3.OperationalError:
            строки = conn.execute(
                "SELECT * FROM %s LIMIT ? OFFSET ?" % table,
                (limit, offset)).fetchall()

        секретные = {c["name"] for c in колонки if c["masked"]}
        данные = []
        for строка in строки:
            ячейки = []
            for колонка in колонки:
                значение = строка[колонка["name"]]
                if колонка["name"] in секретные:
                    ячейки.append({"v": MASK if значение is not None else None})
                elif значение is None:
                    ячейки.append({"v": None})
                elif isinstance(значение, bytes):
                    ячейки.append({"v": "<%d байт двоичных данных>" % len(значение)})
                else:
                    текст = str(значение)
                    if len(текст) > MAX_VALUE_CHARS:
                        ячейки.append({"v": текст[:MAX_VALUE_CHARS], "full_len": len(текст)})
                    else:
                        ячейки.append({"v": текст})
            данные.append(ячейки)

        activity.log("db_status_table_view", user=admin, entity_type="database",
                     new_value=table, details={"limit": limit, "offset": offset})
        return {"table": table, "columns": колонки, "rows": данные,
                "total": всего, "limit": limit, "offset": offset}
    finally:
        conn.close()
