# -*- coding: utf-8 -*-
# Тестовые строки для scripts/verify_tables_ui.mjs — вставляются в РАБОЧУЮ копию БД сервера (work.db), поднятого
# scripts/real_auth_server.py. Без этого шага таблицы «Элементы»/«Журнал действий» на копии обезличенной БД не содержат
# строк с нужными для проверки признаками (короткий тип без пробелов, пустые поля, длинные непрерывные строки).
# Запуск:  .venv/bin/python scripts/seed_tables_check.py <путь к work.db>
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else ".run/tables_check/work.db"
c = sqlite3.connect(DB)

tpl = c.execute("SELECT * FROM elements WHERE object_id = 1 LIMIT 1").fetchone()
cols = [d[0] for d in c.execute("SELECT * FROM elements LIMIT 1").description]
base = dict(zip(cols, tpl))
base.pop("id", None)

rows = [
    # ТСТ-К1: «Колонна», короткий подтип «верхняя» — не должны рваться по буквам (сам заявленный дефект).
    {**base, "element_type": "Колонна", "mark": "ТСТ-К1", "subtype": "верхняя", "address": "5-7/В-Г", "current_status": "planned",
     "floor": 2, "planned_delivery_date": "2026-10-15", "actual_delivery_date": None, "source_file": "Чертёж-1.dxf"},
    # ТСТ-Б7: пустые необязательные поля (адрес/этаж/даты) не должны ломать раскладку.
    {**base, "element_type": "Балка", "mark": "ТСТ-Б7", "subtype": None, "address": None, "current_status": "planned",
     "floor": None, "planned_delivery_date": None, "actual_delivery_date": None},
    # Длинное непрерывное имя чертежа без пробелов + длинная марка — аварийный перенос допустим, страница не растягивается.
    {**base, "element_type": "Плита перекрытия", "mark": "ТСТ-ДЛИННАЯ-МАРКА-БЕЗ-ПРОБЕЛОВ-0000000001234567890",
     "subtype": "на отм. +99.900", "address": "1-99/А-Я", "current_status": "delivered",
     "floor": 9, "planned_delivery_date": "2026-11-01", "actual_delivery_date": "2026-11-05",
     "source_file": "Чертёж-ОченьДлинноеНепрерывноеИмяФайлаБезПробеловДляПроверкиПереносаКолонки-2026.dxf"},
]
for i, r in enumerate(rows):
    r["element_uid"] = None          # UNIQUE INDEX ... WHERE element_uid IS NOT NULL — не дублировать шаблонный
    r["dxf_handle"] = f"TBLTEST{i}"  # UNIQUE(source_file, dxf_handle) — свой на каждую строку
    r["mark_id"] = None
    r["is_current"] = 1              # шаблонная строка может быть архивной версией чертежа — иначе не видна в списке
    r["contract_id"] = None
    keys = [k for k in cols if k != "id"]
    c.execute(f"INSERT INTO elements ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})", [r.get(k) for k in keys])

# Журнал: «Запланирован» целиком (проверка на разрыв по буквам) + длинное ФИО/марка (перенос по словам, не через <br> по буквам).
c.execute(
    "INSERT INTO activity_log (at, source, user_id, user_name, action, entity_type, entity_id, element_type, subtype, mark, "
    "old_value, new_value, category) VALUES (datetime('now'), 'server', 1, "
    "'Тестовый Пользователь ОченьДлинноеИмяДляПроверкиПереносаЯчейкиЖурнала', 'status_change', 'element', 999999, "
    "'Плита перекрытия', 'на отм. +99.900', 'ТСТ-ДЛИННАЯ-МАРКА-БЕЗ-ПРОБЕЛОВ-0000000001234567890', "
    "'Проектирование', 'Запланирован', 'data')"
)
c.commit()
print(f"вставлено строк elements: {len(rows)}, activity_log: 1")
