# Переход к объединению стоянок крана — журнал реализации

Рабочая ветка: `codex/crane-stance-union`.

## Этап 0 — изоляция и эталон

Managed worktree создан от `6d270733fba5826d4af5a939f8e609c6c4a2b3cc`.
Окружение подключено симлинком, `data/zhbi.anon.db` снята через SQLite
`Connection.backup`; отдельный `data/zhbi.baseline.db` сохраняет исходное
состояние. Эталон 14 506 текущих изделий записан в игнорируемый Git файл
`data/crane_assignment_baseline.json`, SHA-256
`1e255486e5f4726a62eee7738a1694868160383d86f729e736e4ef45a1b2685b`.
В исходной анонимной копии 193 объекта ЖБИ, таблицы версий ещё нет.

AST-инвентаризация вызовов привязки и писателей: `scripts/zone_binding.py`,
`scripts/new_standard_pipeline.py`, `app/crane_zone_editor.py`,
`app/zone_recalc.py`, `app/shaft_panels_host.py`; материализация в
`app/crane_zone_service.py`, `app/zone_sync.py`, `app/db.py`,
`app/dxf_import.py`, `scripts/import_elements.py`. Старые пути PATCH/undo
расположены в `app/main.py`, удаление зон — в `app/dict_delete.py`.
