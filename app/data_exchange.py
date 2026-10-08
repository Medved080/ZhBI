"""
ОБМЕН ДАННЫМИ МЕЖДУ СЕРВЕРАМИ по выбранным разделам (2026-10-08, запрос пользователя).

Зачем отдельно от «Переноса базы» (app/db_transfer.py). Перенос ЗАМЕНЯЕТ базу снимком целиком. Здесь
нужно обратное: взять с другого сервера (или отправить на него) ТОЛЬКО выбранное — справочники, статусы,
документы контрактации, настройки — и не потерять то, что на принимающей стороне уже есть.

Устройство. Данные раздела — не строки таблиц, а СУЩНОСТИ с естественным ключом: у записи нет id, одинакового
на двух серверах, поэтому она находится по тому, что её определяет («объект + тип + марка», «контрагент + номер
договора», «изделие по UID + статус + момент»). У сущности есть поля (сравниваются и записываются) и ССЫЛКИ на
другие сущности — тоже по естественному ключу. Поток один и тот же в обе стороны:

    build_package(conn, разделы)  →  analyze(conn, пакет)  →  apply(conn, пакет, выбор)

* build_package — выгрузка выбранных разделов с исходной стороны;
* analyze — сверка с БАЗОЙ ПРИНИМАЮЩЕЙ СТОРОНЫ: каждая сущность «новая», «изменена», «совпадает» или
  «недоступна» (с причиной). Ничего не пишет;
* apply — применяет ровно отмеченное; одна транзакция под блокировкой записи, копия базы перед ней.

Принципы (решения пользователя 2026-10-08):
* по умолчанию существующее НЕ перезаписывается — «изменено» человек отмечает осознанно, группой или по одной;
* ничего не УДАЛЯЕТСЯ — записи, которых нет в пакете, остаются как были;
* ссылочная целостность — в четыре слоя: (1) на сверке у каждой сущности проверены ссылки: родитель есть на
  приёмнике, либо приходит в пакете как «новый»; нет — сущность «недоступна» с объяснением («объект «X»
  отсутствует на принимающем сервере»); (2) при применении сущность, чей родитель не отмечен, ПРОПУСКАЕТСЯ с
  объяснением, а не вставляется с пустой ссылкой; (3) после записи сверяются `PRAGMA foreign_key_check` (появились ли
  новые нарушения) и страж остатка контрактации (`contract_guard.regressions`, как у импорта истории): любое
  нарушение откатывает ВСЁ; (4) устаревшая сверка не применяется: если после неё данные приёмника изменились,
  применение отказывает и просит свериться заново.
* сопоставление объектов — по названию (UNIQUE в БД), изделий — по UID: сами объекты и изделия обменом не создаются.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import sqlite3
from datetime import datetime, timezone
from typing import Callable, Optional

FORMAT = 1

# ----------------------------------------------------------------------------- разделы
# Состав разделов — решение пользователя 2026-10-08: справочники, статусы (справочник и история — отдельно),
# документы (контрактация), настройки (все), роли, данные калькулятора (отдельный поток, app/data_exchange_calc.py).
SECTIONS = {
    "dict_types": {
        "title": "Справочники: типы, подтипы и марки",
        "hint": "Префиксы марок, допустимые подтипы и марки по объектам.",
        "kinds": ["mark_prefix", "allowed_subtype", "mark"],
    },
    "dict_works": {
        "title": "Справочники: виды работ, дорожки планирования, СМУ",
        "hint": "Дерево видов работ объекта (по пути), дорожки планирования, каталог СМУ.",
        "kinds": ["smu", "planning_track", "work_type"],
    },
    "status_dict": {
        "title": "Статусы: справочник (цвета)",
        "hint": "Цвета статусов изделий.",
        "kinds": ["status_color"],
    },
    "status_history": {
        "title": "Статусы: история изделий",
        "hint": "Записи истории статусов; изделие находится по UID. Текущий статус пересчитывается по истории.",
        "kinds": ["status_record"],
    },
    "settings": {
        "title": "Настройки",
        "hint": "Настройки системы и объектов (кроме служебных и секретных), видимость подписей, цвета зон.",
        "kinds": ["setting", "label_visibility", "zone_color"],
    },
    "roles": {
        "title": "Настройки: роли и их права",
        "hint": "Роли сервиса и права ролей по разделам (учётные записи и пароли НЕ передаются).",
        "kinds": ["role", "role_feature"],
    },
    "contracting": {
        "title": "Документы: контрактация",
        "hint": "Контрагенты, договоры, спецификации, контракты и их позиции, контракты по умолчанию.",
        "kinds": ["counterparty", "agreement", "specification", "contract", "contract_line", "default_contract"],
    },
}
SECTION_ORDER = list(SECTIONS)

KIND_TITLES = {
    "mark_prefix": "Префиксы марок", "allowed_subtype": "Допустимые подтипы", "mark": "Марки",
    "smu": "СМУ", "planning_track": "Дорожки планирования", "work_type": "Виды работ",
    "status_color": "Цвета статусов", "status_record": "Записи истории статусов",
    "setting": "Настройки", "label_visibility": "Видимость подписей", "zone_color": "Цвета зон",
    "role": "Роли", "role_feature": "Права ролей",
    "counterparty": "Контрагенты", "agreement": "Договоры", "specification": "Спецификации",
    "contract": "Контракты", "contract_line": "Позиции контрактов", "default_contract": "Контракты по умолчанию",
}
# Порядок применения: родители раньше потомков.
KIND_ORDER = [
    "mark_prefix", "smu", "status_color", "role", "role_feature", "setting", "label_visibility", "zone_color",
    "allowed_subtype", "mark", "planning_track", "work_type",
    "counterparty", "agreement", "specification", "contract", "contract_line", "default_contract",
    "status_record",
]
KIND_SECTION = {k: s for s, d in SECTIONS.items() for k in d["kinds"]}
# Внешние сущности: обменом не создаются, ищутся на приёмнике.
EXTERNAL = ("object", "element")

# Служебные и секретные настройки не передаются никогда.
_SETTING_SKIP = re.compile(r"(_seeded$|^db_release_version$|^legacy_|_purged$|token|secret|password|api[_-]?key|^release_)", re.I)

STATE_TITLES = {"new": "будет добавлено", "changed": "изменено", "blocked": "недоступно", "same": "совпадает"}


class ExchangeError(Exception):
    def __init__(self, message: str, status: int = 400, extra: Optional[dict] = None):
        super().__init__(message)
        self.status = status
        self.extra = extra or {}


# ----------------------------------------------------------------------------- вспомогательное
def _s(value) -> str:
    return "" if value is None else str(value)


def entity_id(kind: str, key) -> str:
    return hashlib.sha1((kind + "\x1f" + json.dumps(list(key), ensure_ascii=False)).encode("utf-8")).hexdigest()[:16]


def _ent(kind, key, fields=None, refs=None, label="", rowid=None) -> dict:
    return {"kind": kind, "key": [_s(k) for k in key], "fields": fields or {}, "refs": refs or {}, "label": label, "rowid": rowid}


def _ref(kind: str, key, opt: bool = False) -> dict:
    return {"kind": kind, "key": [_s(k) for k in key], "opt": opt}


def server_info(conn) -> dict:
    """Кто мы: роль сервера (по переменной тестового сервера), версия обработок, имя машины."""
    row = conn.execute("SELECT value FROM app_settings WHERE key = 'db_release_version' AND object_id IS NULL").fetchone()
    test = os.environ.get("ZHBI_TEST_SERVER_MAIN_URL", "").strip()
    from app.db import DB_PATH
    return {"role": "test" if test else "prod_or_dev", "release": row["value"] if row else None,
            "host": socket.gethostname(), "test_url": test or None,
            "db_id": hashlib.sha1(str(DB_PATH).encode("utf-8")).hexdigest()[:10]}


class _Ctx:
    """Справочники id → естественный ключ: считаются один раз на сверку/выгрузку."""

    def __init__(self, conn, objects_filter: Optional[set] = None):
        self.conn = conn
        self.flt = objects_filter
        self.obj = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM objects")}
        self.cp = {r["id"]: (r["short_name"], r["inn"]) for r in conn.execute("SELECT id, short_name, inn FROM counterparties")}
        self.agr = {r["id"]: (*self._cpk(r["counterparty_id"]), r["number"])
                    for r in conn.execute("SELECT id, counterparty_id, number FROM agreements")}
        self.spec = {r["id"]: (*self.agr.get(r["agreement_id"], ("", "", "")), r["number"])
                     for r in conn.execute("SELECT id, agreement_id, number FROM specifications")}
        self.contract = {r["id"]: (*self.spec.get(r["specification_id"], ("", "", "", "")), r["theme"] or "")
                         for r in conn.execute("SELECT id, specification_id, theme FROM contracts")}

    def _cpk(self, cp_id):
        short, inn = self.cp.get(cp_id, ("", ""))
        return (short, inn or "")

    def obj_ok(self, name) -> bool:
        return self.flt is None or name in self.flt

    def agr_ok(self, agreement_id) -> bool:
        """Договор попадает в выгрузку: без отбора — всегда, с отбором — только договоры выбранных объектов."""
        if self.flt is None:
            return True
        if not hasattr(self, "_ok_agr"):
            self._ok_agr = {r["id"] for r in self.conn.execute("SELECT id, object_id FROM agreements")
                            if self.obj.get(r["object_id"]) in self.flt}
        return agreement_id in self._ok_agr

    def contract_ok(self, contract_id) -> bool:
        if self.flt is None:
            return True
        row = self.conn.execute("SELECT s.agreement_id FROM contracts c JOIN specifications s ON s.id = c.specification_id "
                                "WHERE c.id = ?", (contract_id,)).fetchone()
        return bool(row) and self.agr_ok(row["agreement_id"])


def _oref(name, opt=False):
    return _ref("object", [name], opt)


# ----------------------------------------------------------------------------- загрузчики сущностей
# Каждый загрузчик читает ОДНУ базу (источника при выгрузке, приёмника при сверке) и отдаёт сущности с rowid.
def _load_mark_prefix(c: _Ctx):
    for r in c.conn.execute("SELECT prefix, element_type FROM mark_type_prefixes ORDER BY prefix"):
        yield _ent("mark_prefix", [r["prefix"]], {"element_type": r["element_type"]},
                   label=f"Префикс «{r['prefix']}» → {r['element_type']}", rowid=r["prefix"])


def _load_allowed_subtype(c: _Ctx):
    for r in c.conn.execute("SELECT object_id, element_type, subtype FROM allowed_subtypes ORDER BY 1, 2, 3"):
        o = c.obj.get(r["object_id"], "")
        if c.obj_ok(o):
            yield _ent("allowed_subtype", [o, r["element_type"], r["subtype"]], refs={"object": _oref(o)},
                       label=f"{o} · {r['element_type']} · подтип «{r['subtype']}»")


def _load_mark(c: _Ctx):
    for r in c.conn.execute("SELECT id, object_id, element_type, name FROM marks ORDER BY object_id, element_type, name"):
        o = c.obj.get(r["object_id"], "")
        if c.obj_ok(o):
            yield _ent("mark", [o, r["element_type"], r["name"]], refs={"object": _oref(o)},
                       label=f"{o} · {r['element_type']} · марка «{r['name']}»", rowid=r["id"])


def _load_smu(c: _Ctx):
    for r in c.conn.execute("SELECT id, name FROM smu_catalog ORDER BY name"):
        yield _ent("smu", [r["name"]], label=f"СМУ «{r['name']}»", rowid=r["id"])


def _load_planning_track(c: _Ctx):
    for r in c.conn.execute("SELECT id, object_id, code, name, note FROM planning_tracks ORDER BY object_id, code"):
        o = c.obj.get(r["object_id"], "")
        if c.obj_ok(o):
            yield _ent("planning_track", [o, r["code"]], {"name": r["name"], "note": r["note"]}, {"object": _oref(o)},
                       label=f"{o} · дорожка {r['code']} «{r['name']}»", rowid=r["id"])


def _load_work_type(c: _Ctx):
    paths = {r["id"]: r["path"] for r in c.conn.execute("SELECT id, path FROM work_types")}
    for r in c.conn.execute("SELECT id, object_id, parent_id, path, row_kind, code, name, unit, sort_order, retired_at, "
                            "note, planning_track_code FROM work_types ORDER BY object_id, length(path), path"):
        o = c.obj.get(r["object_id"], "")
        if not c.obj_ok(o):
            continue
        refs = {"object": _oref(o)}
        if r["parent_id"] is not None and r["parent_id"] in paths:
            refs["parent"] = _ref("work_type", [o, paths[r["parent_id"]]])
        yield _ent("work_type", [o, r["path"]],
                   {"row_kind": r["row_kind"], "code": r["code"], "name": r["name"], "unit": r["unit"],
                    "sort_order": r["sort_order"], "retired_at": r["retired_at"], "note": r["note"],
                    "planning_track_code": r["planning_track_code"]},
                   refs, label=f"{o} · {r['path']}", rowid=r["id"])


def _load_status_color(c: _Ctx):
    for r in c.conn.execute("SELECT status, color FROM status_colors ORDER BY status"):
        yield _ent("status_color", [r["status"]], {"color": r["color"]}, label=f"Цвет статуса «{r['status']}»", rowid=r["status"])


def _load_status_record(c: _Ctx):
    counter: dict = {}
    sql = ("SELECT h.id, h.element_id, h.status, h.changed_at, h.changed_by, h.comment, h.contract_id, e.element_uid, "
           "e.object_id, e.element_type, e.mark FROM status_history h JOIN elements e ON e.id = h.element_id "
           "WHERE e.element_uid IS NOT NULL ORDER BY e.element_uid, h.status, h.changed_at, h.id")
    for r in c.conn.execute(sql):
        o = c.obj.get(r["object_id"], "")
        if not c.obj_ok(o):
            continue
        planned = r["status"] == "planned"
        # Запись «Запланирован» датирована моментом импорта чертежа, у серверов он разный — сравнивается только факт.
        moment = "" if planned else _s(r["changed_at"])
        k = (r["element_uid"], r["status"], moment)
        counter[k] = counter.get(k, 0) + 1
        refs = {"element": _ref("element", [r["element_uid"]])}
        fields = {}
        if not planned:
            fields = {"changed_by": r["changed_by"], "comment": r["comment"]}
            refs["contract"] = (_ref("contract", c.contract[r["contract_id"]], True)
                                if r["contract_id"] in c.contract else None)
        what = (r["element_type"] or "") + " " + (r["mark"] or "")
        yield _ent("status_record", [*k, counter[k]], fields, refs,
                   label=f"{o} · {what.strip() or r['element_uid'][:8]} · «{r['status']}» {_s(r['changed_at'])}", rowid=r["id"])


def _load_setting(c: _Ctx):
    for r in c.conn.execute("SELECT key, object_id, value FROM app_settings ORDER BY key, object_id"):
        if _SETTING_SKIP.search(r["key"] or ""):
            continue
        o = c.obj.get(r["object_id"], "") if r["object_id"] is not None else ""
        if r["object_id"] is not None and (not o or not c.obj_ok(o)):
            continue
        if r["object_id"] is None and c.flt is not None:
            continue  # при отборе по объектам общие (серверные) настройки не передаются
        refs = {"object": _oref(o)} if o else {}
        yield _ent("setting", [r["key"], o], {"value": r["value"]}, refs,
                   label=("Настройка «%s»" % r["key"]) + (f" · {o}" if o else " (общая)"),
                   rowid=(r["key"], r["object_id"]))


def _load_label_visibility(c: _Ctx):
    for r in c.conn.execute("SELECT object_id, element_type, visible, dates_visible FROM label_visibility ORDER BY 1, 2"):
        o = c.obj.get(r["object_id"], "")
        if c.obj_ok(o):
            yield _ent("label_visibility", [o, r["element_type"]],
                       {"visible": r["visible"], "dates_visible": r["dates_visible"]}, {"object": _oref(o)},
                       label=f"{o} · подписи «{r['element_type']}»")


def _load_zone_color(c: _Ctx):
    for r in c.conn.execute("SELECT object_id, category, name, color FROM zone_colors ORDER BY 1, 2, 3"):
        o = c.obj.get(r["object_id"], "")
        if c.obj_ok(o):
            yield _ent("zone_color", [o, r["category"], r["name"]], {"color": r["color"]}, {"object": _oref(o)},
                       label=f"{o} · цвет зоны {r['category']} «{r['name']}»")


def _load_role(c: _Ctx):
    for r in c.conn.execute("SELECT id, key, name, rank FROM object_roles ORDER BY rank, key"):
        yield _ent("role", [r["key"]], {"name": r["name"], "rank": r["rank"]}, label=f"Роль «{r['name']}» ({r['key']})", rowid=r["id"])


def _load_role_feature(c: _Ctx):
    for r in c.conn.execute("SELECT role_key, feature_key, level FROM role_features ORDER BY 1, 2"):
        yield _ent("role_feature", [r["role_key"], r["feature_key"]], {"level": r["level"]}, {"role": _ref("role", [r["role_key"]])},
                   label=f"Роль {r['role_key']} · право «{r['feature_key']}»")


def _load_counterparty(c: _Ctx):
    for r in c.conn.execute("SELECT * FROM counterparties ORDER BY short_name, inn"):
        yield _ent("counterparty", [r["short_name"], r["inn"] or ""],
                   {k: r[k] for k in ("full_name", "kpp", "ogrn", "legal_address", "contact_person", "contact_phone", "code")},
                   label=f"Контрагент «{r['short_name']}»", rowid=r["id"])


def _load_agreement(c: _Ctx):
    for r in c.conn.execute("SELECT id, counterparty_id, number, agreement_date, object_id FROM agreements ORDER BY id"):
        if not c.agr_ok(r["id"]):
            continue
        short, inn = c._cpk(r["counterparty_id"])
        o = c.obj.get(r["object_id"]) if r["object_id"] is not None else None
        yield _ent("agreement", [short, inn, r["number"]], {"agreement_date": r["agreement_date"]},
                   {"counterparty": _ref("counterparty", [short, inn]), "object": _oref(o, True) if o else None},
                   label=f"Договор №{r['number']} · {short}", rowid=r["id"])


def _load_specification(c: _Ctx):
    for r in c.conn.execute("SELECT id, agreement_id, number, specification_date FROM specifications ORDER BY id"):
        if not c.agr_ok(r["agreement_id"]):
            continue
        akey = c.agr.get(r["agreement_id"])
        if akey is None:
            continue
        yield _ent("specification", [*akey, r["number"]], {"specification_date": r["specification_date"]},
                   {"agreement": _ref("agreement", akey)}, label=f"Спецификация №{r['number']} · договор №{akey[2]} · {akey[0]}", rowid=r["id"])


def _load_contract(c: _Ctx):
    for r in c.conn.execute("SELECT id, specification_id, theme, is_archived FROM contracts ORDER BY id"):
        skey = c.spec.get(r["specification_id"])
        if skey is None:
            continue
        if not c.contract_ok(r["id"]):
            continue
        yield _ent("contract", [*skey, r["theme"] or ""], {"is_archived": r["is_archived"]},
                   {"specification": _ref("specification", skey)},
                   label=f"Контракт «{r['theme'] or '—'}» · спец. №{skey[3]} · {skey[0]}", rowid=r["id"])


def _load_contract_line(c: _Ctx):
    for r in c.conn.execute("SELECT id, contract_id, element_type, mark, quantity FROM contract_lines ORDER BY id"):
        ckey = c.contract.get(r["contract_id"])
        if ckey is None or not c.contract_ok(r["contract_id"]):
            continue
        yield _ent("contract_line", [*ckey, r["element_type"] or "", r["mark"] or ""], {"quantity": r["quantity"]},
                   {"contract": _ref("contract", ckey)},
                   label=f"Позиция {r['element_type'] or '—'} {r['mark'] or ''} × {r['quantity']} · контракт «{ckey[4] or '—'}»".replace("  ", " "),
                   rowid=r["id"])


def _load_default_contract(c: _Ctx):
    for r in c.conn.execute("SELECT object_id, element_type, contract_id FROM default_contracts ORDER BY 1, 2"):
        o = c.obj.get(r["object_id"], "")
        if not c.obj_ok(o):
            continue
        ckey = c.contract.get(r["contract_id"]) if r["contract_id"] is not None else None
        yield _ent("default_contract", [o, r["element_type"]], {},
                   {"object": _oref(o), "contract": _ref("contract", ckey, True) if ckey else None},
                   label=f"{o} · контракт по умолчанию для «{r['element_type']}»")


LOADERS: dict[str, Callable] = {
    "mark_prefix": _load_mark_prefix, "allowed_subtype": _load_allowed_subtype, "mark": _load_mark,
    "smu": _load_smu, "planning_track": _load_planning_track, "work_type": _load_work_type,
    "status_color": _load_status_color, "status_record": _load_status_record,
    "setting": _load_setting, "label_visibility": _load_label_visibility, "zone_color": _load_zone_color,
    "role": _load_role, "role_feature": _load_role_feature,
    "counterparty": _load_counterparty, "agreement": _load_agreement, "specification": _load_specification,
    "contract": _load_contract, "contract_line": _load_contract_line, "default_contract": _load_default_contract,
}


def _kinds_for(sections) -> list:
    wanted = set()
    for s in sections:
        if s not in SECTIONS:
            raise ExchangeError(f"Неизвестный раздел «{s}»")
        wanted.update(SECTIONS[s]["kinds"])
    return [k for k in KIND_ORDER if k in wanted]


def _closure(kinds) -> list:
    """Виды сущностей, которые надо загрузить на приёмнике: выбранные и те, на которые они ссылаются."""
    need = set(kinds)
    parents = {"role_feature": ["role"], "work_type": ["work_type"], "agreement": ["counterparty"], "specification": ["agreement"],
               "contract": ["specification"], "contract_line": ["contract"], "default_contract": ["contract"],
               "status_record": ["contract"]}
    stack = list(need)
    while stack:
        for p in parents.get(stack.pop(), []):
            if p not in need:
                need.add(p)
                stack.append(p)
    # цепочка контракта тянет за собой всю цепочку документов
    if "contract" in need:
        need.update(["specification", "agreement", "counterparty"])
    return [k for k in KIND_ORDER if k in need]


# ----------------------------------------------------------------------------- выгрузка
def build_package(conn, sections, objects: Optional[list] = None) -> dict:
    """Выгрузка выбранных разделов. `objects` — названия объектов для отбора (None — все)."""
    sections = [s for s in SECTION_ORDER if s in set(sections)]
    if not sections:
        raise ExchangeError("Не выбрано ни одного раздела")
    c = _Ctx(conn, set(objects) if objects else None)
    entities = []
    for kind in _kinds_for(sections):
        for e in LOADERS[kind](c):
            e.pop("rowid", None)
            entities.append(e)
    return {"format": FORMAT, "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "sections": sections, "objects": sorted(objects) if objects else None,
            "source": server_info(conn), "entities": entities}


# Форма сущности каждого вида: длина ключа, обязательные поля, допустимые ссылки. Пакет приходит с ДРУГОГО сервера и принимается
# только после проверки формы: кривая запись не должна падать глубоко в записи (500), а отклоняется сразу с понятным текстом.
_SHAPE = {
    "mark_prefix": (1, ["element_type"], []), "allowed_subtype": (3, [], ["object"]), "mark": (3, [], ["object"]),
    "smu": (1, [], []), "planning_track": (2, ["name", "note"], ["object"]),
    "work_type": (2, ["row_kind", "code", "name", "unit", "sort_order", "retired_at", "note", "planning_track_code"], ["object", "parent"]),
    "status_color": (1, ["color"], []), "status_record": (4, [], ["element", "contract"]),
    "setting": (2, ["value"], ["object"]), "label_visibility": (2, ["visible", "dates_visible"], ["object"]),
    "zone_color": (3, ["color"], ["object"]), "role": (1, ["name", "rank"], []), "role_feature": (2, ["level"], ["role"]),
    "counterparty": (2, ["full_name", "kpp", "ogrn", "legal_address", "contact_person", "contact_phone", "code"], []),
    "agreement": (3, ["agreement_date"], ["counterparty", "object"]), "specification": (4, ["specification_date"], ["agreement"]),
    "contract": (5, ["is_archived"], ["specification"]), "contract_line": (7, ["quantity"], ["contract"]),
    "default_contract": (2, [], ["object", "contract"]),
}
_MOMENT = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}")


def _check_package(package) -> None:
    from app.models import STATUS_ORDER
    if not isinstance(package, dict) or package.get("format") != FORMAT or not isinstance(package.get("entities"), list):
        raise ExchangeError("Это не пакет обмена данными или он другой версии формата", 422)
    for e in package["entities"]:
        shape = _SHAPE.get(e.get("kind")) if isinstance(e, dict) else None
        if shape is None:
            raise ExchangeError("В пакете есть сущность неизвестного вида: " + str(e.get("kind") if isinstance(e, dict) else e)[:60], 422)
        n, fields, refs = shape
        key = e.get("key")
        if not isinstance(key, list) or len(key) != n or not all(isinstance(k, str) for k in key):
            raise ExchangeError(f"Повреждённый ключ записи вида «{e['kind']}» в пакете", 422)
        if not isinstance(e.get("fields"), dict) or any(f not in e["fields"] for f in fields):
            raise ExchangeError(f"У записи вида «{e['kind']}» в пакете не хватает полей", 422)
        if not isinstance(e.get("refs"), dict) or any(r not in refs for r in e["refs"]):
            raise ExchangeError(f"У записи вида «{e['kind']}» в пакете недопустимые ссылки", 422)
        for ref in e["refs"].values():
            if ref is not None and (not isinstance(ref, dict) or not isinstance(ref.get("kind"), str) or not isinstance(ref.get("key"), list)
                                    or not all(isinstance(k, str) for k in ref["key"])):
                raise ExchangeError(f"Повреждённая ссылка у записи вида «{e['kind']}» в пакете", 422)
        if not isinstance(e.get("label"), str):
            e["label"] = " / ".join(key)
        if e["kind"] == "status_record":
            if key[1] not in STATUS_ORDER or (key[1] != "planned" and not _MOMENT.match(key[2])):
                raise ExchangeError(f"В пакете запись истории с неизвестным статусом или моментом: {key[1]} {key[2]}", 422)


# ----------------------------------------------------------------------------- сверка
def _content(e: dict) -> dict:
    return {"fields": e["fields"], "refs": {k: (None if v is None else v["key"]) for k, v in e["refs"].items()}}


def _fp(e: dict) -> str:
    return hashlib.sha1(json.dumps(_content(e), ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:12]


def _norm(v):
    if isinstance(v, float) and v == int(v):
        return int(v)
    return v


def _changes(pe: dict, te: dict) -> list:
    out = []
    for f, now in pe["fields"].items():
        was = te["fields"].get(f)
        if _norm(was) != _norm(now) and not (was in (None, "") and now in (None, "")):
            out.append({"field": f, "was": was, "now": now})
    for name in sorted(set(pe["refs"]) | set(te["refs"])):
        pr, tr = pe["refs"].get(name), te["refs"].get(name)
        pk, tk = (pr["key"] if pr else None), (tr["key"] if tr else None)
        if pk != tk:
            out.append({"field": name, "was": " / ".join(tk) if tk else None, "now": " / ".join(pk) if pk else None})
    return out


def _target_maps(conn, kinds):
    """Сущности приёмника без отбора по объектам: родитель мог остаться за отбором."""
    c = _Ctx(conn, None)
    tmap: dict = {}
    dups: set = set()
    for kind in _closure(kinds):
        for e in LOADERS[kind](c):
            k = (e["kind"], tuple(e["key"]))
            if k in tmap:
                dups.add(k)
            tmap[k] = e
    objects = {r["name"] for r in conn.execute("SELECT name FROM objects")}
    elements = {r["element_uid"] for r in conn.execute("SELECT element_uid FROM elements WHERE element_uid IS NOT NULL")}
    return tmap, dups, objects, elements


def analyze(conn, package: dict) -> dict:
    """Сверка пакета с БАЗОЙ ЭТОГО сервера. Ничего не пишет."""
    _check_package(package)
    kinds = [k for k in KIND_ORDER if any(e["kind"] == k for e in package["entities"])]
    tmap, tdups, objects, elements = _target_maps(conn, kinds)
    pkg_count: dict = {}
    for e in package["entities"]:
        pkg_count[(e["kind"], tuple(e["key"]))] = pkg_count.get((e["kind"], tuple(e["key"])), 0) + 1
    order = {k: i for i, k in enumerate(KIND_ORDER)}
    ents = sorted(package["entities"], key=lambda e: order[e["kind"]])
    state: dict = {}
    result = []
    for pe in ents:
        key = (pe["kind"], tuple(pe["key"]))
        problems, warnings, needs, changes = [], [], [], []
        st = None
        if pkg_count[key] > 1:
            st, problems = "blocked", ["В пакете несколько записей с одинаковым ключом — сопоставить нельзя"]
        elif key in tdups:
            st, problems = "blocked", ["На принимающем сервере несколько записей с таким ключом — сопоставить нельзя"]
        te = tmap.get(key)
        if st is None:
            if te is None:
                st = "new"
            else:
                changes = _changes(pe, te)
                st = "changed" if changes else "same"
        if st in ("new", "changed"):
            for name, ref in pe["refs"].items():
                if ref is None:
                    continue
                rk = (ref["kind"], tuple(ref["key"]))
                if ref["kind"] == "object":
                    ok = ref["key"][0] in objects
                    if not ok:
                        problems.append(f"объект «{ref['key'][0]}» отсутствует на принимающем сервере")
                elif ref["kind"] == "element":
                    ok = ref["key"][0] in elements
                    if not ok:
                        problems.append(f"изделия с UID {ref['key'][0][:8]}… нет на принимающем сервере")
                elif rk in tmap:
                    ok = True
                elif state.get(rk) == "new":
                    ok = True
                    needs.append(rk)
                else:
                    ok = False
                    if not ref.get("opt"):
                        problems.append(f"{KIND_TITLES.get(ref['kind'], ref['kind'])}: «{' / '.join(ref['key'])}» нет на принимающем сервере и не приходит в пакете")
                if not ok and ref.get("opt"):
                    warnings.append(f"{KIND_TITLES.get(ref['kind'], ref['kind'])} «{' / '.join(ref['key'])}» не найден — ссылка останется пустой")
            if problems:
                st = "blocked"
        state[key] = st
        if st == "same":
            result.append({"id": entity_id(*key), "kind": pe["kind"], "state": "same"})
            continue
        result.append({"id": entity_id(*key), "kind": pe["kind"], "key": pe["key"], "state": st, "label": pe["label"],
                       "changes": changes, "problems": problems, "warnings": warnings,
                       "needs": [list(n[1]) for n in needs], "fp": _fp(te) if te else None})
    return {"entities": result, "counts": _counts(result), "source": package.get("source"), "sections": package.get("sections")}


def _counts(result) -> dict:
    out: dict = {}
    for r in result:
        g = out.setdefault(r["kind"], {"new": 0, "changed": 0, "blocked": 0, "same": 0})
        g[r["state"]] += 1
    return out


def group_id(kind: str, state: str) -> str:
    return f"{kind}:{state}"


def selected_ids(entities, selection: dict) -> set:
    """Выбор: целые группы («вид:состояние»), плюс отдельные id, минус исключённые."""
    groups = set(selection.get("groups") or [])
    include, exclude = set(selection.get("include") or []), set(selection.get("exclude") or [])
    out = set()
    for r in entities:
        if r["state"] not in ("new", "changed"):
            continue
        if r["id"] in exclude:
            continue
        if group_id(r["kind"], r["state"]) in groups or r["id"] in include:
            out.add(r["id"])
    return out


# ----------------------------------------------------------------------------- применение
def _fk_violations(conn) -> set:
    return {tuple(r) for r in conn.execute("PRAGMA foreign_key_check")}


def apply(conn, package: dict, analysis: dict, selection: dict, user_name: str, user_id: Optional[int]) -> dict:
    """Применяет отмеченное. Соединение уже под блокировкой записи (begin_write); commit — здесь."""
    from app import activity, contract_guard
    from app.contracts import adopt_contract_from_history, recompute_status_and_actual_date
    from app.db import touch_elements
    from app.history_import import _shift_planned_before_first_event

    fresh = analyze(conn, package)
    fresh_by_id = {r["id"]: r for r in fresh["entities"]}
    old_by_id = {r["id"]: r for r in analysis["entities"]}
    chosen = selected_ids(analysis["entities"], selection)
    if not chosen:
        raise ExchangeError("Не отмечено ничего, что можно применить")
    stale = [i for i in chosen if (fresh_by_id.get(i) or {}).get("state") != old_by_id[i]["state"]
             or (fresh_by_id.get(i) or {}).get("fp") != old_by_id[i].get("fp")]
    if stale:
        raise ExchangeError(f"Сверка устарела: у {len(stale)} отмеченных записей данные принимающего сервера изменились после сверки. "
                            "Ничего не применено — сверьтесь заново.", 409)

    ents = {}
    for e in package["entities"]:
        ents[entity_id(e["kind"], e["key"])] = e
    kinds_involved = sorted({ents[i]["kind"] for i in chosen}, key=KIND_ORDER.index)
    tmap, _, objects, _ = _target_maps(conn, kinds_involved)
    object_id = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM objects")}
    element_id = {r["element_uid"]: r["id"] for r in conn.execute("SELECT id, element_uid FROM elements WHERE element_uid IS NOT NULL")}
    created: dict = {}      # (kind, key) → rowid созданных в этом применении
    coverage_before = {r["id"]: contract_guard.coverage_state(conn, r["id"]) for r in conn.execute("SELECT id FROM contracts")}
    fk_before = _fk_violations(conn)

    def rid(ref):
        """id родителя на приёмнике: найденный, созданный сейчас — или None."""
        if ref is None:
            return None
        kind, key = ref["kind"], tuple(ref["key"])
        if kind == "object":
            return object_id.get(key[0])
        if kind == "element":
            return element_id.get(key[0])
        if (kind, key) in created:
            return created[(kind, key)]
        te = tmap.get((kind, key))
        return te["rowid"] if te else None

    done: dict = {}
    skipped: list = []
    touched_elements: set = set()
    order = {k: i for i, k in enumerate(KIND_ORDER)}
    # сортировка устойчива: внутри вида сохраняется порядок пакета (родители видов работ идут раньше потомков)
    queue = sorted((e for i, e in ents.items() if i in chosen), key=lambda e: order[e["kind"]])
    for e in queue:
        eid = entity_id(e["kind"], e["key"])
        kind, key, f, refs = e["kind"], tuple(e["key"]), e["fields"], e["refs"]
        why = None
        ids = {}
        for name, ref in refs.items():
            if ref is None:
                ids[name] = None
                continue
            got = rid(ref)
            if got is None and not ref.get("opt"):
                why = f"родитель не применён: {KIND_TITLES.get(ref['kind'], ref['kind'])} «{' / '.join(ref['key'])}» (не отмечен или недоступен)"
                break
            ids[name] = got
        if why:
            skipped.append({"id": eid, "label": e["label"], "reason": why})
            continue
        te = tmap.get((kind, key))
        try:
            new_rowid = _write(conn, kind, key, f, ids, te, user_name)
        except sqlite3.IntegrityError as exc:
            raise ExchangeError(f"Нарушена целостность при записи «{e['label']}»: {exc}. Ничего не применено.", 409)
        if te is None:
            created[(kind, key)] = new_rowid
        if kind == "status_record":
            touched_elements.add(ids["element"])
        d = done.setdefault(kind, {"new": 0, "changed": 0})
        d["new" if te is None else "changed"] += 1

    for el in touched_elements:
        _shift_planned_before_first_event(conn, el)
        effective, _ = recompute_status_and_actual_date(conn, el)
        adopt_contract_from_history(conn, el, effective)
        snap = conn.execute("SELECT element_type, subtype, mark FROM elements WHERE id = ?", (el,)).fetchone()
        activity.log("data_exchange_status", user_name=user_name, user_id=user_id, entity_type="element", entity_id=el,
                     element_type=snap["element_type"], subtype=snap["subtype"], mark=snap["mark"], new_value=effective,
                     details={"источник": (package.get("source") or {}).get("host")})

    # Целостность: новых нарушений внешних ключей быть не должно, страж остатка контрактации — как у импорта истории.
    new_fk = _fk_violations(conn) - fk_before
    if new_fk:
        raise ExchangeError(f"После записи нарушена ссылочная целостность ({len(new_fk)} нарушений). Ничего не применено.", 409)
    problems = []
    for r in conn.execute("SELECT id FROM contracts"):
        problems.extend(contract_guard.regressions(coverage_before.get(r["id"], {}), contract_guard.coverage_state(conn, r["id"])))
    if problems:
        raise ExchangeError("Применение нарушило бы остаток контрактации: " + "; ".join(problems[:8])
                            + (f" (и ещё {len(problems) - 8})" if len(problems) > 8 else "") + ". Ничего не применено.", 409)
    touch_elements(conn, touched_elements)
    conn.commit()
    return {"applied": done, "applied_total": sum(v["new"] + v["changed"] for v in done.values()), "skipped": skipped,
            "elements_recomputed": len(touched_elements)}


def _write(conn, kind, key, f, ids, te, user_name):
    """Запись одной сущности. te — найденная на приёмнике (UPDATE) или None (INSERT). Возвращает rowid."""
    ins = te is None
    if kind == "mark_prefix":
        if ins:
            conn.execute("INSERT INTO mark_type_prefixes (prefix, element_type) VALUES (?, ?)", (key[0], f["element_type"]))
        else:
            conn.execute("UPDATE mark_type_prefixes SET element_type = ? WHERE prefix = ?", (f["element_type"], key[0]))
        return key[0]
    if kind == "allowed_subtype":
        conn.execute("INSERT INTO allowed_subtypes (object_id, element_type, subtype) VALUES (?, ?, ?)", (ids["object"], key[1], key[2]))
        return None
    if kind == "mark":
        return conn.execute("INSERT INTO marks (object_id, element_type, name) VALUES (?, ?, ?)", (ids["object"], key[1], key[2])).lastrowid
    if kind == "smu":
        return conn.execute("INSERT INTO smu_catalog (name) VALUES (?)", (key[0],)).lastrowid
    if kind == "planning_track":
        if ins:
            return conn.execute("INSERT INTO planning_tracks (object_id, code, name, note) VALUES (?, ?, ?, ?)",
                                (ids["object"], key[1], f["name"], f["note"])).lastrowid
        conn.execute("UPDATE planning_tracks SET name = ?, note = ? WHERE id = ?", (f["name"], f["note"], te["rowid"]))
        return te["rowid"]
    if kind == "work_type":
        if ins:
            return conn.execute(
                "INSERT INTO work_types (object_id, parent_id, path, row_kind, code, name, unit, sort_order, retired_at, note, planning_track_code) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (ids["object"], ids.get("parent"), key[1], f["row_kind"], f["code"], f["name"], f["unit"], f["sort_order"],
                 f["retired_at"], f["note"], f["planning_track_code"])).lastrowid
        conn.execute("UPDATE work_types SET row_kind=?, code=?, name=?, unit=?, sort_order=?, retired_at=?, note=?, planning_track_code=?, "
                     "parent_id=? WHERE id=?",
                     (f["row_kind"], f["code"], f["name"], f["unit"], f["sort_order"], f["retired_at"], f["note"],
                      f["planning_track_code"], ids.get("parent"), te["rowid"]))
        return te["rowid"]
    if kind == "status_color":
        if ins:
            conn.execute("INSERT INTO status_colors (status, color) VALUES (?, ?)", (key[0], f["color"]))
        else:
            conn.execute("UPDATE status_colors SET color = ? WHERE status = ?", (f["color"], key[0]))
        return key[0]
    if kind == "setting":
        obj = ids.get("object")
        if ins:
            conn.execute("INSERT INTO app_settings (key, object_id, value) VALUES (?, ?, ?)", (key[0], obj, f["value"]))
        else:
            conn.execute("UPDATE app_settings SET value = ? WHERE key = ? AND COALESCE(object_id, -1) = COALESCE(?, -1)",
                         (f["value"], key[0], obj))
        return None
    if kind == "label_visibility":
        conn.execute("INSERT INTO label_visibility (object_id, element_type, visible, dates_visible) VALUES (?, ?, ?, ?) "
                     "ON CONFLICT (object_id, element_type) DO UPDATE SET visible = excluded.visible, dates_visible = excluded.dates_visible",
                     (ids["object"], key[1], f["visible"], f["dates_visible"]))
        return None
    if kind == "zone_color":
        conn.execute("INSERT INTO zone_colors (object_id, category, name, color) VALUES (?, ?, ?, ?) "
                     "ON CONFLICT (object_id, category, name) DO UPDATE SET color = excluded.color",
                     (ids["object"], key[1], key[2], f["color"]))
        return None
    if kind == "role":
        if ins:
            return conn.execute("INSERT INTO object_roles (key, name, rank) VALUES (?, ?, ?)", (key[0], f["name"], f["rank"])).lastrowid
        conn.execute("UPDATE object_roles SET name = ?, rank = ? WHERE id = ?", (f["name"], f["rank"], te["rowid"]))
        return te["rowid"]
    if kind == "role_feature":
        conn.execute("INSERT INTO role_features (role_key, feature_key, level, updated_at) VALUES (?, ?, ?, datetime('now')) "
                     "ON CONFLICT (role_key, feature_key) DO UPDATE SET level = excluded.level, updated_at = datetime('now')",
                     (key[0], key[1], f["level"]))
        return None
    cols = ("full_name", "kpp", "ogrn", "legal_address", "contact_person", "contact_phone", "code")
    if kind == "counterparty":
        if ins:
            return conn.execute(f"INSERT INTO counterparties (short_name, inn, {', '.join(cols)}) VALUES (?, ?, {', '.join('?' * len(cols))})",
                                (key[0], key[1] or None, *[f[c] for c in cols])).lastrowid
        conn.execute(f"UPDATE counterparties SET {', '.join(c + ' = ?' for c in cols)}, updated_at = datetime('now') WHERE id = ?",
                     (*[f[c] for c in cols], te["rowid"]))
        return te["rowid"]
    if kind == "agreement":
        if ins:
            return conn.execute("INSERT INTO agreements (counterparty_id, number, agreement_date, object_id) VALUES (?, ?, ?, ?)",
                                (ids["counterparty"], key[2], f["agreement_date"], ids.get("object"))).lastrowid
        conn.execute("UPDATE agreements SET agreement_date = ?, object_id = ?, updated_at = datetime('now') WHERE id = ?",
                     (f["agreement_date"], ids.get("object"), te["rowid"]))
        return te["rowid"]
    if kind == "specification":
        if ins:
            return conn.execute("INSERT INTO specifications (agreement_id, number, specification_date) VALUES (?, ?, ?)",
                                (ids["agreement"], key[3], f["specification_date"])).lastrowid
        conn.execute("UPDATE specifications SET specification_date = ?, updated_at = datetime('now') WHERE id = ?",
                     (f["specification_date"], te["rowid"]))
        return te["rowid"]
    if kind == "contract":
        if ins:
            return conn.execute("INSERT INTO contracts (specification_id, theme, is_archived) VALUES (?, ?, ?)",
                                (ids["specification"], key[4] or None, f["is_archived"])).lastrowid
        conn.execute("UPDATE contracts SET is_archived = ?, updated_at = datetime('now') WHERE id = ?", (f["is_archived"], te["rowid"]))
        return te["rowid"]
    if kind == "contract_line":
        if ins:
            return conn.execute("INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, ?)",
                                (ids["contract"], key[5] or None, key[6] or None, f["quantity"])).lastrowid
        conn.execute("UPDATE contract_lines SET quantity = ? WHERE id = ?", (f["quantity"], te["rowid"]))
        return te["rowid"]
    if kind == "default_contract":
        conn.execute("INSERT INTO default_contracts (object_id, element_type, contract_id) VALUES (?, ?, ?) "
                     "ON CONFLICT (object_id, element_type) DO UPDATE SET contract_id = excluded.contract_id",
                     (ids["object"], key[1], ids.get("contract")))
        return None
    if kind == "status_record":
        uid, status, moment, _n = key
        if status == "planned":
            conn.execute("INSERT INTO status_history (element_id, status, changed_by, comment) VALUES (?, 'planned', ?, ?)",
                         (ids["element"], user_name, "Обмен данными между серверами"))
            return None
        by = f.get("changed_by")
        conn.execute("INSERT INTO status_history (element_id, status, changed_at, changed_by, changed_by_user_id, comment, contract_id) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (ids["element"], status, moment, by, _user_id_for(conn, by), f.get("comment"), ids.get("contract")))
        return None
    raise ExchangeError("Вид сущности без записи: " + kind, 500)


def _user_id_for(conn, display_name) -> Optional[int]:
    """Учётная запись по ФИО (как у массовой правки истории): ФИО в истории — снимок «кто изменил тогда»."""
    if not display_name:
        return None
    from app.status_bulk_edit import _display_name
    for u in conn.execute("SELECT id, last_name, first_name, patronymic FROM users"):
        if _display_name(u) == display_name:
            return u["id"]
    return None
