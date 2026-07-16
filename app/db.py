import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "zhbi.db"
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Колонки, добавленные в существующие таблицы уже после первого релиза схемы.
# CREATE TABLE IF NOT EXISTS в schema.sql не трогает таблицы, которые уже
# существуют на диске — без этого пользователи с накопленной БД теряли бы
# доступ к новым полям (или падали бы на INSERT/SELECT) после обновления,
# пока не удалят data/zhbi.db вручную.
_COLUMN_MIGRATIONS = [
    ("status_history", "changed_by_user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"),
    ("elements", "contract_id", "INTEGER REFERENCES contracts(id) ON DELETE SET NULL"),
    ("status_history", "contract_id", "INTEGER REFERENCES contracts(id) ON DELETE SET NULL"),
    # JSON-список вершин контура в мировых координатах (см. scripts/parse_zhbi.py
    # ElementRecord.outline) — есть только у элементов, извлечённых из
    # LWPOLYLINE, NULL у элементов из INSERT-блоков. Нужен для отображения
    # вытянутых элементов (ригелей) на схеме их настоящей формой.
    ("elements", "outline_json", "TEXT"),
    # Поля нового стандарта имён слоёв (см. scripts/layer_naming.py) —
    # заполняются только для элементов, чей слой распознан этим стандартом;
    # для старых файлов (LAYER_CONFIG) остаются NULL.
    ("elements", "subtype", "TEXT"),
    ("elements", "elevation_mm", "INTEGER"),
    ("elements", "zone_zakhvatka_id", "INTEGER REFERENCES zones(id) ON DELETE SET NULL"),
    ("elements", "zone_zakhvatka_status", "TEXT"),
    ("elements", "zone_crane_id", "INTEGER REFERENCES zones(id) ON DELETE SET NULL"),
    ("elements", "zone_crane_status", "TEXT"),
    ("elements", "zone_stance_id", "INTEGER REFERENCES zones(id) ON DELETE SET NULL"),
    ("elements", "zone_stance_status", "TEXT"),
    # Только у зон category='Стоянка' — зона категории 'Кран', в чьей
    # рабочей зоне физически находится эта стоянка (см.
    # scripts/zone_parser._link_stances_to_cranes, Docs/backlog.md).
    ("zones", "parent_zone_id", "INTEGER REFERENCES zones(id) ON DELETE SET NULL"),
    ("zones", "parent_match_status", "TEXT"),
]


def _apply_migrations(conn: sqlite3.Connection) -> None:
    for table, column, coltype in _COLUMN_MIGRATIONS:
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")


def _migrate_contracts_structure(conn: sqlite3.Connection) -> None:
    """
    Раунд 2 хранил контракт как одну строку (название+поставщик+тип+кол-во).
    Раунд 3 (Docs/backlog.md, п.8) вводит нормальную структуру: контракт
    (название, поставщик) + строки contract_lines (тип, количество) внутри
    него. На новой БД CREATE TABLE IF NOT EXISTS в schema.sql уже создаёт
    новую форму сразу — эта функция нужна только для БД, накопленных со
    старой формой (наличие столбца element_type в contracts — маркер).
    Группировка старых строк в контракты — по (name, supplier).
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(contracts)")}
    if "element_type" not in cols:
        return

    # ВАЖНО: ALTER TABLE ... RENAME TO молча переписывает FK-констрейнты в ДРУГИХ
    # таблицах (elements.contract_id, default_contracts.contract_id), которые
    # ссылались на "contracts", так что они начинают ссылаться на "contracts_old".
    # Без отключения foreign_keys последующий DROP TABLE contracts_old запускает
    # ON DELETE SET NULL по этим констрейнтам и обнуляет то, что мы только что
    # аккуратно перенесли на новые id (найдено и проверено эмпирически). Не
    # включаем PRAGMA обратно явно — это соединение короткоживущее (закрывается
    # в конце init_db()), а любое новое соединение уже получает foreign_keys=ON
    # по умолчанию через get_connection().
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("ALTER TABLE contracts RENAME TO contracts_old")
    conn.execute(
        """
        CREATE TABLE contracts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            supplier TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS contract_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_id INTEGER NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
            element_type TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            UNIQUE (contract_id, element_type)
        )
        """
    )

    old_rows = conn.execute("SELECT * FROM contracts_old ORDER BY id").fetchall()
    group_to_new_id = {}
    id_map = {}
    for row in old_rows:
        key = (row["name"], row["supplier"])
        if key not in group_to_new_id:
            conn.execute(
                "INSERT INTO contracts (name, supplier, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (row["name"], row["supplier"], row["created_at"], row["updated_at"]),
            )
            group_to_new_id[key] = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        new_id = group_to_new_id[key]
        id_map[row["id"]] = new_id
        conn.execute(
            "INSERT INTO contract_lines (contract_id, element_type, quantity) VALUES (?, ?, ?) "
            "ON CONFLICT(contract_id, element_type) DO UPDATE SET quantity = excluded.quantity",
            (new_id, row["element_type"], row["quantity"]),
        )

    for old_id, new_id in id_map.items():
        conn.execute("UPDATE elements SET contract_id = ? WHERE contract_id = ?", (new_id, old_id))
        conn.execute("UPDATE default_contracts SET contract_id = ? WHERE contract_id = ?", (new_id, old_id))

    conn.execute("DROP TABLE contracts_old")


# Старый конвейер (LAYER_CONFIG в scripts/parse_zhbi.py) когда-то отдавал
# английские element_type ("column"/"beam"), новый стандарт имён слоёв —
# русские ("Колонна"/"Ригель"/...) — парсер уже приведён к единому русскому
# словарю (см. Docs/backlog.md), но данные, загруженные ДО этого
# исправления, всё ещё хранят старые значения (а Input/ переобрабатывает
# на каждом старте только файлы, которые сейчас лежат в этой папке — для
# остальных источников самоисправление не сработает).
_ELEMENT_TYPE_RENAMES = {"column": "Колонна", "beam": "Ригель"}


def _normalize_element_type_vocabulary(conn: sqlite3.Connection) -> None:
    """Идемпотентно — можно спокойно гонять на каждом старте (после первого
    успешного прогона английских значений нигде не остаётся, дальше это
    просто холостой обход пустых выборок).

    elements.element_type не участвует ни в каком уникальном ключе — там
    просто UPDATE. label_visibility/default_contracts/element_shapes/
    contract_lines хранят element_type как часть первичного/уникального
    ключа — прямое переименование могло бы столкнуться с уже существующей
    строкой под русским именем; в этом случае оставляем русскую (считаем
    её уже осмысленно настроенной), английскую просто удаляем."""
    for old, new in _ELEMENT_TYPE_RENAMES.items():
        conn.execute("UPDATE elements SET element_type = ? WHERE element_type = ?", (new, old))

        if conn.execute("SELECT 1 FROM label_visibility WHERE element_type = ?", (new,)).fetchone():
            conn.execute("DELETE FROM label_visibility WHERE element_type = ?", (old,))
        else:
            conn.execute("UPDATE label_visibility SET element_type = ? WHERE element_type = ?", (new, old))

        if conn.execute("SELECT 1 FROM default_contracts WHERE element_type = ?", (new,)).fetchone():
            conn.execute("DELETE FROM default_contracts WHERE element_type = ?", (old,))
        else:
            conn.execute("UPDATE default_contracts SET element_type = ? WHERE element_type = ?", (new, old))

        for row in conn.execute("SELECT layer FROM element_shapes WHERE element_type = ?", (old,)).fetchall():
            layer = row["layer"]
            if conn.execute(
                "SELECT 1 FROM element_shapes WHERE layer = ? AND element_type = ?", (layer, new)
            ).fetchone():
                conn.execute("DELETE FROM element_shapes WHERE layer = ? AND element_type = ?", (layer, old))
            else:
                conn.execute(
                    "UPDATE element_shapes SET element_type = ? WHERE layer = ? AND element_type = ?",
                    (new, layer, old),
                )

        for row in conn.execute(
            "SELECT contract_id FROM contract_lines WHERE element_type = ?", (old,)
        ).fetchall():
            contract_id = row["contract_id"]
            if conn.execute(
                "SELECT 1 FROM contract_lines WHERE contract_id = ? AND element_type = ?", (contract_id, new)
            ).fetchone():
                conn.execute(
                    "DELETE FROM contract_lines WHERE contract_id = ? AND element_type = ?", (contract_id, old)
                )
            else:
                conn.execute(
                    "UPDATE contract_lines SET element_type = ? WHERE contract_id = ? AND element_type = ?",
                    (new, contract_id, old),
                )


def init_db() -> None:
    conn = get_connection()
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        _apply_migrations(conn)
        _migrate_contracts_structure(conn)
        _normalize_element_type_vocabulary(conn)
        conn.commit()
    finally:
        conn.close()
