"""ВРЕМЕННАЯ обработка: заполнение пустых полей «Объект» и «Проект».

Зачем. Иерархия «Проект → Объект» вводилась поэтапно (этапы A–D,
`Docs/backlog.md` 2026-07-31…08-02), и часть записей накопилась ДО того,
как соответствующее поле появилось. Такая запись формально жива, но
принадлежит «ничему»: правила доступа выводят объект из сущности, а у
сущности его нет. Самый заметный случай — договоры: аудит 2026-08-03
нашёл, что у ВСЕХ накопленных договоров `object_id IS NULL`, из-за чего
цепочка Договор→Спецификация→Контракт была видна только администратору
сервиса, а у администратора объекта каскад в форме контракта оставался
пуст. Заводить такие записи заново нельзя (на них ссылаются контракты и
изделия), а править по одной — десятки форм.

Обработка ОДНОРАЗОВАЯ и помечена временной прямо в интерфейсе: она нужна,
пока в базе есть дообъектное наследие, и подлежит удалению, когда его не
останется. Новые записи заводятся уже с объектом — это проверяют сами
формы (`create_agreement` отвечает 400 без объекта), поэтому обработка не
должна становиться постоянной частью системы: её существование означало
бы, что где-то по-прежнему можно создать запись без владельца.

Что считается «пустым полем», а что — нет. Это не одно и то же, и здесь
проходит главная граница модуля. `NULL` в колонке объекта означает
«владелец неизвестен» только там, где владелец обязателен. В двух местах
`NULL` — законное ЗНАЧЕНИЕ со своим смыслом, и заполнение его сломало бы
систему, поэтому эти таблицы в перечень целей не входят вовсе:

* `app_settings.object_id IS NULL` — СИСТЕМНАЯ запись: маркеры выполненных
  миграций (`legacy_elements_purged`, `user_access_seeded`). Приписать их
  объекту значит объявить миграции невыполненными — при следующем старте
  чистка дообъектного наследия и раздача доступов пойдут заново.
* `user_access.project_id/object_id IS NULL` — УРОВЕНЬ гранта: оба NULL —
  «все проекты, включая будущие», один — «весь проект». Заполнение сузило
  бы права до одного объекта, то есть молча отобрало доступ.

Остальные пять таблиц с колонкой объекта (`label_visibility`,
`zone_colors`, `default_contracts`, `report_notes`, `object_drawings`)
объявлены `NOT NULL` ещё на этапе D — пустого поля там не бывает по схеме,
и целями они не являются.

Доступ — системный админ (`require_system_admin`): обработка смотрит и
пишет данные всех объектов сразу, объектная роль тут не годится.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import app.activity as activity
from app.access import require_system_admin
from app.db import assign_missing_element_uids, get_connection

router = APIRouter(tags=["fill-scope"])

# Сколько примеров записей показывать в форме. Смысл примеров — дать
# узнать записи в лицо («это те самые одиннадцать договоров»), а не
# перечислить их все: при дообъектном наследии в элементах счёт идёт на
# десятки тысяч, и список стал бы страницей, которую никто не читает.
SAMPLE_LIMIT = 10


class ЦельОбработки:
    """Одна колонка «Объект» или «Проект», которую обработка умеет заполнять.

    Описание декларативное, а не пять веток кода: перечень целей —
    единственное место, где написано, что именно обработка трогает, и
    добавление шестой цели не должно требовать правки ни сканирования, ни
    применения, ни формы.
    """

    def __init__(self, key, title, table, column, field, note, default_on=True):
        self.key = key
        self.title = title          # как справочник называется в меню
        self.table = table
        self.column = column
        self.field = field          # "object" | "project" — чем заполняем
        self.note = note            # что означает пустое поле и что даст заполнение
        self.default_on = default_on


ЦЕЛИ = [
    ЦельОбработки(
        key="agreements",
        title="Договоры (Контрагенты → Договоры)",
        table="agreements", column="object_id", field="object",
        note="Договор без объекта не попадает в каскад формы контракта и виден "
             "только администратору сервиса. После заполнения он появится у "
             "администратора выбранного объекта вместе со своими спецификациями "
             "и контрактами.",
    ),
    ЦельОбработки(
        key="objects",
        title="Объекты",
        table="objects", column="project_id", field="project",
        note="Объект без проекта недостижим ни через один переключатель. В норме "
             "не встречается: такие объекты подхватывает «Проект по умолчанию» "
             "при старте сервиса (_bootstrap_default_project).",
    ),
    ЦельОбработки(
        key="zones",
        title="Зоны (захватки, краны, стоянки)",
        table="zones", column="object_id", field="object",
        note="Дообъектное наследие: зоны версий чертежа, загруженных до введения "
             "Объекта. Помечены неактуальными и на схему не выводятся — "
             "заполнение поля привязывает их к объекту, но актуальными не делает.",
        default_on=False,
    ),
    ЦельОбработки(
        key="elements",
        title="Элементы",
        table="elements", column="object_id", field="object",
        note="Дообъектное наследие: изделия версий чертежа, загруженных до "
             "введения Объекта. Осторожно — их могут быть десятки тысяч. Они "
             "останутся НЕактуальными (со схемы не выводятся), но попадут в "
             "справочник элементов выбранного объекта; их файлы чертежей "
             "зарегистрируются как прошлые версии.",
        default_on=False,
    ),
]

ЦЕЛИ_ПО_КЛЮЧУ = {ц.key: ц for ц in ЦЕЛИ}

# Подпись строки в примерах. Отдельным запросом на цель, а не общей
# формулой: «узнать в лицо» договор можно по контрагенту и номеру, зону —
# по категории и названию, изделие — по чертежу и марке, и ничего из этого
# друг на друга не похоже.
ПРИМЕРЫ = {
    "agreements": (
        "SELECT a.id AS id, "
        "       COALESCE(cp.short_name, cp.full_name, '?') || ' · Договор № ' || a.number "
        "       || COALESCE(' от ' || a.agreement_date, '') AS label "
        "FROM agreements a LEFT JOIN counterparties cp ON cp.id = a.counterparty_id "
        "WHERE a.object_id IS NULL ORDER BY a.id LIMIT ?"
    ),
    "objects": (
        "SELECT id, name AS label FROM objects WHERE project_id IS NULL ORDER BY id LIMIT ?"
    ),
    "zones": (
        "SELECT id, category || ' · ' || COALESCE(name, '?') "
        "       || COALESCE(' · ' || source_file, '') AS label "
        "FROM zones WHERE object_id IS NULL ORDER BY id LIMIT ?"
    ),
    "elements": (
        "SELECT id, COALESCE(source_file, '?') || ' · ' || COALESCE(element_type, '?') "
        "       || ' · ' || COALESCE(mark, 'без марки') AS label "
        "FROM elements WHERE object_id IS NULL ORDER BY id LIMIT ?"
    ),
}


def _пусто(conn: sqlite3.Connection, цель: ЦельОбработки) -> int:
    return conn.execute(
        f"SELECT COUNT(*) AS n FROM {цель.table} WHERE {цель.column} IS NULL"
    ).fetchone()["n"]


def _конфликты_договоров(conn: sqlite3.Connection, object_id: int) -> list:
    """Договоры без объекта, которые НЕЛЬЗЯ отдать выбранному объекту.

    «Объект контракта = объект изделия» — инвариант схемы: объект контракта
    не хранится, а выводится по цепочке контракт → спецификация → договор.
    Значит, привязка договора к объекту молча уводит туда же все его
    контракты вместе с уже законтрактованными изделиями. Если по контрактам
    договора законтрактовано изделие ДРУГОГО объекта, привязка сделала бы
    инвариант ложным — такой договор пропускается с объяснением, а не
    заполняется «как получится».

    Та же проверка стоит в `update_agreement` (app/counterparties.py) —
    ручная смена объекта договора отклоняется по этой же причине; массовая
    обработка не имеет права быть мягче ручной правки.
    """
    return conn.execute(
        """
        SELECT a.id AS id,
               COALESCE(cp.short_name, cp.full_name, '?') || ' · Договор № ' || a.number AS label,
               COUNT(e.id) AS n
        FROM agreements a
        LEFT JOIN counterparties cp ON cp.id = a.counterparty_id
        JOIN specifications s ON s.agreement_id = a.id
        JOIN contracts co ON co.specification_id = s.id
        JOIN elements e ON e.contract_id = co.id AND e.object_id IS NOT ?
        WHERE a.object_id IS NULL
        GROUP BY a.id
        """,
        (object_id,),
    ).fetchall()


@router.get("/admin/fill-empty-scope")
def scan(admin: sqlite3.Row = Depends(require_system_admin)):
    """Что сейчас не заполнено. В базу не пишет — это предпросмотр."""
    conn = get_connection()
    try:
        targets = []
        for цель in ЦЕЛИ:
            n = _пусто(conn, цель)
            samples = [
                {"id": r["id"], "label": r["label"]}
                for r in conn.execute(ПРИМЕРЫ[цель.key], (SAMPLE_LIMIT,)).fetchall()
            ] if n else []
            targets.append({
                "key": цель.key, "title": цель.title, "field": цель.field,
                "table": цель.table, "column": цель.column, "note": цель.note,
                "default_on": цель.default_on, "empty": n, "samples": samples,
            })
        return {"targets": targets, "sample_limit": SAMPLE_LIMIT}
    finally:
        conn.close()


class ЗаявкаНаЗаполнение(BaseModel):
    project_id: Optional[int] = None
    object_id: Optional[int] = None
    keys: list[str] = []


@router.post("/admin/fill-empty-scope/apply")
def apply(body: ЗаявкаНаЗаполнение, admin: sqlite3.Row = Depends(require_system_admin)):
    """Заполнить выбранные поля выбранными объектом и проектом.

    Одна транзакция на все цели: наполовину привязанное наследие (зоны
    привязались, а их изделия нет) разбиралось бы дольше, чем не начатое.
    """
    неизвестные = [k for k in body.keys if k not in ЦЕЛИ_ПО_КЛЮЧУ]
    if неизвестные:
        raise HTTPException(status_code=400, detail=f"Неизвестные цели: {', '.join(неизвестные)}")
    if not body.keys:
        raise HTTPException(status_code=400, detail="Не выбрано ни одного справочника")

    выбранные = [ЦЕЛИ_ПО_КЛЮЧУ[k] for k in body.keys]
    нужен_объект = any(ц.field == "object" for ц in выбранные)
    нужен_проект = any(ц.field == "project" for ц in выбранные)
    if нужен_объект and not body.object_id:
        raise HTTPException(status_code=400, detail="Выберите объект")
    if нужен_проект and not body.project_id:
        raise HTTPException(status_code=400, detail="Выберите проект")

    conn = get_connection()
    try:
        объект = None
        if body.object_id:
            объект = conn.execute(
                "SELECT id, name, project_id FROM objects WHERE id = ?", (body.object_id,)
            ).fetchone()
            if объект is None:
                raise HTTPException(status_code=404, detail="Объект не найден")
        проект = None
        if body.project_id:
            проект = conn.execute(
                "SELECT id, name FROM projects WHERE id = ?", (body.project_id,)
            ).fetchone()
            if проект is None:
                raise HTTPException(status_code=404, detail="Проект не найден")
        # Проект и объект должны быть согласованы: заполнить договоры объектом
        # одной стройки, а объекты — проектом другой, человек может только по
        # ошибке, и заметит он её не скоро.
        if объект is not None and проект is not None and объект["project_id"] != проект["id"]:
            raise HTTPException(
                status_code=400,
                detail=f"Объект «{объект['name']}» относится к другому проекту — "
                       f"выберите объект внутри проекта «{проект['name']}»")

        результаты = []
        for цель in выбранные:
            результаты.append(_заполнить(conn, цель, объект, проект))
        conn.commit()
    finally:
        conn.close()

    всего = sum(r["filled"] for r in результаты)
    activity.log("fill_empty_scope", user=admin, entity_type="system",
                 new_value=str(всего),
                 details={"объект": объект["name"] if объект else None,
                          "проект": проект["name"] if проект else None,
                          "справочники": {r["key"]: r["filled"] for r in результаты},
                          "пропущено": {r["key"]: r["skipped"] for r in результаты if r["skipped"]}})
    return {"results": результаты, "total_filled": всего}


def _заполнить(conn: sqlite3.Connection, цель: ЦельОбработки, объект, проект) -> dict:
    """Одна цель. Возвращает строку отчёта: сколько заполнено, сколько
    пропущено и почему — «применено» без числа не отличить от «ничего не
    нашлось»."""
    отчёт = {"key": цель.key, "title": цель.title, "filled": 0, "skipped": 0,
             "reasons": [], "extra": []}
    было = _пусто(conn, цель)
    if not было:
        return отчёт

    if цель.key == "agreements":
        пропустить = _конфликты_договоров(conn, объект["id"])
        отчёт["skipped"] = len(пропустить)
        for r in пропустить:
            отчёт["reasons"].append(
                f"{r['label']}: по контрактам договора законтрактовано изделий другого "
                f"объекта — {r['n']}. Сначала снимите с них контракт.")
        исключить = [r["id"] for r in пропустить]
        плейсхолдеры = ",".join("?" * len(исключить))
        conn.execute(
            "UPDATE agreements SET object_id = ?, updated_at = datetime('now') "
            "WHERE object_id IS NULL"
            + (f" AND id NOT IN ({плейсхолдеры})" if исключить else ""),
            [объект["id"]] + исключить,
        )
        отчёт["filled"] = было - отчёт["skipped"]
        return отчёт

    if цель.key == "objects":
        conn.execute(
            "UPDATE objects SET project_id = ?, updated_at = datetime('now') "
            "WHERE project_id IS NULL", (проект["id"],))
        отчёт["filled"] = было
        return отчёт

    if цель.key == "zones":
        conn.execute("UPDATE zones SET object_id = ? WHERE object_id IS NULL", (объект["id"],))
        отчёт["filled"] = было
        return отчёт

    if цель.key == "elements":
        # Файлы чертежей этих изделий регистрируются за объектом как ПРОШЛЫЕ
        # версии (is_current = 0). Без этой строки объект не знает, откуда
        # изделие взялось, а форма версий чертежа его не показывает; ставить
        # is_current = 1 нельзя — актуальная версия у объекта одна, и наследие
        # вытеснило бы настоящий чертёж со схемы.
        файлы = [r["source_file"] for r in conn.execute(
            "SELECT DISTINCT source_file FROM elements "
            "WHERE object_id IS NULL AND source_file IS NOT NULL")]
        новых_версий = 0
        for f in файлы:
            есть = conn.execute(
                "SELECT 1 FROM object_drawings WHERE object_id = ? AND source_file = ?",
                (объект["id"], f)).fetchone()
            if есть:
                continue
            conn.execute(
                "INSERT INTO object_drawings (object_id, source_file, is_current) VALUES (?, ?, 0)",
                (объект["id"], f))
            новых_версий += 1
        conn.execute("UPDATE elements SET object_id = ? WHERE object_id IS NULL", (объект["id"],))
        # element_uid — сквозной ключ изделия, по нему его узнаёт переимпорт
        # чертежа и массовая правка через Excel. У дообъектного наследия его
        # нет: колонка появилась вместе с Объектом.
        uid = assign_missing_element_uids(conn, объект["id"])
        отчёт["filled"] = было
        if новых_версий:
            отчёт["extra"].append(f"зарегистрировано прошлых версий чертежа: {новых_версий}")
        if uid:
            отчёт["extra"].append(f"выдано сквозных идентификаторов изделий: {uid}")
        return отчёт

    raise HTTPException(status_code=500, detail=f"Цель {цель.key} не реализована")
