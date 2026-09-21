"""Операции «Учёта по блокам» для интерфейса V2: предпросмотр групповых правок, проверка конкуренции и строгая (всё или ничего)
правка запланированных работ (ЗР) из Excel.

Зачем отдельный файл. Существующие групповые операции V1 (`app/main.py`, `app/block_works.py`, `app/block_bulk_edit.py`) не давали
трёх гарантий, которые нужны для опасных групповых правок в V2:
  * ПРЕДПРОСМОТР последствий (что именно изменится, что будет снято «мягко», что пропущено) — БЕЗ записи;
  * ПРОВЕРКА КОНКУРЕНЦИИ — сервер под блокировкой записи сверяет отпечаток состояния, который видел человек, с текущим и при расхождении
    отвечает 409, ничего не меняя;
  * ВСЁ ИЛИ НИЧЕГО — `apply_changes` Excel-правки фиксировал ЗР по одной и возвращал «пропущено» (частичный результат), а отказ на середине
    оставлял уже применённое.
Здесь — предпросмотры и строгая Excel-правка (`apply-strict`); остальные писатели (`app/main.py`) получили `begin_write`, журнал после
commit и необязательные `expected_*` на месте (старые вызовы V1 без этих полей работают как раньше).

Права те же, что у V1: раздел «Учёт по блокам» (`work_progress`): предпросмотры и правка — «write».
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import activity, block_works, work_fact
from app.auth import audit_display_name, get_current_user
from app.db import begin_write, get_connection

router = APIRouter(prefix="/objects", tags=["block-ops"])

MAX_IDS = 2000


def conflict(message: str, items: list, status_code: int = 409) -> HTTPException:
    """Отказ по устаревшим данным: `items` — что именно разошлось; ничего не изменено."""
    return HTTPException(status_code=status_code, detail={"message": message, "conflict": True, "items": items})


def stale_block_works(conn, object_id: int, expected: dict) -> list:
    """Сверка отпечатков ЗР (`block_works.rev_of`): что человек видел и что сейчас. Вызывать ПОД блокировкой записи."""
    if not expected:
        return []
    percents = work_fact.current_percents_by_block_work(conn, object_id)
    out = []
    for raw_id, rev in expected.items():
        bw_id = int(raw_id)
        row = conn.execute("SELECT * FROM block_works WHERE id = ? AND object_id = ?", (bw_id, object_id)).fetchone()
        if row is None:
            out.append({"id": bw_id, "reason": "deleted"})
        elif block_works.rev_of(row, percents.get(bw_id, 0)) != str(rev):
            out.append({"id": bw_id, "reason": "changed"})
    return out


def block_selection_rev(conn, block_id: int) -> str:
    """Отпечаток состава работ блока (активные и снятые ЗР): для проверки, что состав не менялся после предпросмотра."""
    import hashlib
    rows = conn.execute("SELECT work_type_id, retired_at IS NOT NULL AS r FROM block_works WHERE block_id = ? ORDER BY work_type_id",
                        (block_id,)).fetchall()
    return hashlib.sha1(",".join("%s:%s" % (r["work_type_id"], r["r"]) for r in rows).encode("utf-8")).hexdigest()[:12]


def stale_block_selections(conn, expected: dict) -> list:
    out = []
    for raw_id, rev in (expected or {}).items():
        block_id = int(raw_id)
        if block_selection_rev(conn, block_id) != str(rev):
            out.append({"id": block_id, "reason": "changed"})
    return out


def validate_block_work_patch(row, fields: dict) -> None:
    """Серверная проверка правки ЗР (PATCH): даты — существующие ГГГГ-ММ-ДД или null; конец не раньше начала в паре, которую правят;
    примечание — не длиннее 4000 знаков. Форма V1/V2 это обеспечивает, прямой вызов API — нет."""
    for f in ("plan_start", "plan_end", "forecast_start", "forecast_end"):
        if f in fields and fields[f] is not None and not work_fact.is_iso_date(fields[f]):
            raise HTTPException(status_code=422, detail="Неверная дата в поле «%s» — нужна существующая дата вида ГГГГ-ММ-ДД." % f)
    for a, b, title in (("plan_start", "plan_end", "базового срока"), ("forecast_start", "forecast_end", "прогноза")):
        if a in fields or b in fields:
            start = fields[a] if a in fields else row[a]
            end = fields[b] if b in fields else row[b]
            if start and end and end < start:
                raise HTTPException(status_code=422, detail="Конец %s раньше начала." % title)
    if "note" in fields and fields["note"] is not None and len(fields["note"]) > 4000:
        raise HTTPException(status_code=422, detail="Примечание длиннее 4000 знаков.")


def _feature_write(conn, user, object_id: int) -> None:
    from app.access import assert_object_feature
    assert_object_feature(conn, user, object_id, "work_progress", "write")


# ------------------------------------------------------------ предпросмотр групповой правки сроков

class BulkPreviewIn(BaseModel):
    block_work_ids: list[int]
    op: str                        # "shift" | "forecast_equals_plan"
    field: Optional[str] = None    # "plan" | "forecast" — для op="shift"
    days: Optional[int] = None


@router.post("/{object_id}/block-works/bulk-preview")
def bulk_preview(object_id: int, body: BulkPreviewIn, user=Depends(get_current_user)):
    """Что сделает `PUT /objects/{id}/block-works/bulk` с этим набором — БЕЗ записи. Правила те же, что у `block_works.bulk_edit`
    (сдвиг: пустая дата не сдвигается; «прогноз = план»: только у ещё не начатых). В ответе — отпечатки `expected` для проверки
    конкуренции при применении."""
    if not body.block_work_ids:
        raise HTTPException(status_code=422, detail="Не выбрана ни одна запланированная работа.")
    if len(body.block_work_ids) > MAX_IDS or len(set(body.block_work_ids)) != len(body.block_work_ids):
        raise HTTPException(status_code=422, detail="Набор работ пуст, повторяется или слишком велик.")
    if body.op == "shift":
        if body.field not in ("plan", "forecast"):
            raise HTTPException(status_code=422, detail="Для сдвига укажите field: 'plan' или 'forecast'.")
        if not isinstance(body.days, int) or body.days == 0 or abs(body.days) > 3650:
            raise HTTPException(status_code=422, detail="Укажите ненулевой сдвиг в днях (не больше 3650).")
    elif body.op != "forecast_equals_plan":
        raise HTTPException(status_code=422, detail="Неизвестная групповая операция «%s»." % body.op)
    conn = get_connection()
    try:
        _feature_write(conn, user, object_id)
        from datetime import date
        percents = work_fact.current_percents_by_block_work(conn, object_id)
        by_id = {r["id"]: r for r in block_works._list_rows(conn, object_id, None, None, include_retired=True)}
        items, will = [], 0
        for bw_id in body.block_work_ids:
            row = by_id.get(bw_id)
            if row is None:
                items.append({"id": bw_id, "reason": "not_found", "will_change": False})
                continue
            pct = percents.get(bw_id, 0)
            item = {"id": bw_id, "block_id": row["block_id"], "name": row["wt_name"], "code": row["wt_code"],
                    "section_code": row["section_code"], "level_floor": row["level_floor"], "percent": pct,
                    "retired": row["retired_at"] is not None,
                    "plan_start": row["plan_start"], "plan_end": row["plan_end"],
                    "forecast_start": row["forecast_start"], "forecast_end": row["forecast_end"],
                    "rev": block_works.rev_of(row, pct), "will_change": False, "after": None, "reason": ""}
            if body.op == "shift":
                pre = body.field
                try:
                    a = block_works._shift_date(row[pre + "_start"], body.days)
                    b = block_works._shift_date(row[pre + "_end"], body.days)
                except work_fact.FactError as exc:
                    item["reason"] = exc.message
                    item["blocked"] = True   # применение такого набора будет отклонено целиком (422)
                    items.append(item)
                    continue
                if a == row[pre + "_start"] and b == row[pre + "_end"]:
                    item["reason"] = "нет дат — сдвигать нечего"
                else:
                    item["will_change"] = True
                    item["after"] = {pre + "_start": a, pre + "_end": b}
            else:
                if pct != 0:
                    item["reason"] = "работа уже начата (%d %%) — не трогаем" % pct
                elif row["forecast_start"] == row["plan_start"] and row["forecast_end"] == row["plan_end"]:
                    item["reason"] = "прогноз уже равен плану"
                else:
                    item["will_change"] = True
                    item["after"] = {"forecast_start": row["plan_start"], "forecast_end": row["plan_end"]}
            will += 1 if item["will_change"] else 0
            items.append(item)
        return {"op": body.op, "field": body.field, "days": body.days, "requested": len(body.block_work_ids),
                "will_change": will, "items": items,
                "expected": {str(i["id"]): i["rev"] for i in items if "rev" in i},
                "note": "Версия прогноза копится и не отменяется" if (body.op == "forecast_equals_plan" or body.field == "forecast") else ""}
    finally:
        conn.close()


# ------------------------------------------------------------ предпросмотр состава работ блоков

class SettingsPreviewIn(BaseModel):
    block_ids: list[int]
    work_type_ids: list[int]


@router.post("/{object_id}/blocks/work-types-settings/preview")
def settings_preview(object_id: int, body: SettingsPreviewIn, user=Depends(get_current_user)):
    """Что сделает сохранение состава работ (`PUT .../work-types-settings`) — БЕЗ записи: добавится, вернётся из снятых, будет снято
    «мягко» (есть сроки или факт — строка не удаляется) или удалено (пустая ЗР). Отпечатки `expected` — для проверки конкуренции."""
    if not body.block_ids or len(set(body.block_ids)) != len(body.block_ids) or len(body.block_ids) > MAX_IDS:
        raise HTTPException(status_code=422, detail="Не выбран ни один блок или блоки повторяются.")
    conn = get_connection()
    try:
        _feature_write(conn, user, object_id)
        options = {o["id"]: o for o in work_fact._block_op_work_types(conn, object_id)}
        chosen = set(body.work_type_ids) & set(options)
        ignored = sorted(set(body.work_type_ids) - set(options))
        out, tot = [], {"add": 0, "reactivate": 0, "soft": 0, "hard": 0}
        for block_id in body.block_ids:
            b = conn.execute(
                "SELECT b.id, s.code AS s_code, l.floor AS floor, l.name AS l_name FROM blocks b "
                "JOIN object_sections s ON s.id = b.section_id JOIN object_levels l ON l.id = b.level_id "
                "WHERE b.id = ? AND b.object_id = ?", (block_id, object_id)).fetchone()
            if b is None:
                raise HTTPException(status_code=404, detail="Блок %s не найден." % block_id)
            rows = conn.execute("SELECT id, work_type_id, retired_at FROM block_works WHERE block_id = ?", (block_id,)).fetchall()
            active = {r["work_type_id"]: r["id"] for r in rows if r["retired_at"] is None}
            retired = {r["work_type_id"]: r["id"] for r in rows if r["retired_at"] is not None}
            add = chosen - active.keys() - retired.keys()
            react = (chosen - active.keys()) & retired.keys()
            remove = active.keys() - chosen
            soft, hard = [], []
            for wt in sorted(remove):
                name = (options.get(wt) or {}).get("name") or ("вид работ %s" % wt)
                (soft if work_fact._block_work_has_history(conn, active[wt]) else hard).append({"work_type_id": wt, "name": name})
            out.append({"block_id": block_id, "label": "%s · %s" % (b["s_code"], b["l_name"] or ("этаж %s" % b["floor"])),
                        "add": len(add), "reactivate": len(react), "soft": soft, "hard": hard, "keep": len(chosen & active.keys()),
                        "rev": block_selection_rev(conn, block_id)})
            tot["add"] += len(add); tot["reactivate"] += len(react); tot["soft"] += len(soft); tot["hard"] += len(hard)
        return {"blocks": out, "totals": tot, "ignored": ignored, "expected": {str(o["block_id"]): o["rev"] for o in out}}
    finally:
        conn.close()


# ------------------------------------------------------------ строгая (атомарная) правка ЗР из Excel

class StrictApplyIn(BaseModel):
    # Ровно те строки, что вернул analyze (`changes`), отфильтрованные флажками; у каждой — `was` (то, что видел человек)
    changes: list[dict]


@router.post("/{object_id}/block-works/bulk-edit/apply-strict")
def bulk_edit_apply_strict(object_id: int, body: StrictApplyIn, user=Depends(get_current_user)):
    """Применение Excel-правки ЗР, «всё или ничего». Отличия от `POST .../bulk-edit/apply` (V1):
      * блокировка записи первым действием, состояние `was` сверяется с текущим ПОД блокировкой: расхождение — 409 с перечнем и без
        каких-либо изменений (ничего не «пропускается» молча);
      * любая ошибка внутри — откат ВСЕГО (одна транзакция, один commit); «частичного результата» нет;
      * журнал — только после commit.
    Смысл правки тот же: сроки — `update_block_work`, процент — документ факта на дату (новый на пару блок×дата)."""
    from app import block_bulk_edit
    if not body.changes:
        raise HTTPException(status_code=400, detail="Не отмечено ни одного изменения")
    if len(body.changes) > 20000:
        raise HTTPException(status_code=400, detail="Слишком много изменений за один раз")
    allowed = {k for k, _, editable in block_bulk_edit.COLUMNS if editable}
    unknown = {str(sel.get("field")) for sel in body.changes} - allowed
    if unknown:
        raise HTTPException(status_code=400, detail="Недопустимые поля для правки: " + ", ".join(sorted(unknown)))
    # Копия базы перед применением — как у V1 (`backup_before_import`): до блокировки записи
    from app.backups import backup_before_import
    events = None
    conn = get_connection()
    try:
        from app.access import assert_object_feature
        assert_object_feature(conn, user, object_id, "work_progress", "write")
    finally:
        conn.close()
    backup_before_import("массовая правка ЗР через Excel (объект %s)" % object_id, audit_display_name(user), user["id"])

    conn = get_connection()
    events = activity.defer_begin()
    try:
        begin_write(conn)
        _feature_write(conn, user, object_id)
        percents = work_fact.current_percents_by_block_work(conn, object_id)
        active = {r["id"]: r for r in block_bulk_edit._block_work_rows(conn, object_id)}
        by_bw: dict = {}
        conflicts = []
        for sel in body.changes:
            try:
                bw_id = int(sel["bw_id"])
            except (KeyError, TypeError, ValueError):
                raise HTTPException(status_code=400, detail="У строки нет идентификатора работы")
            row = active.get(bw_id)
            if row is None:
                conflicts.append({"bw_id": bw_id, "field": sel.get("field"), "reason": "not_active"})
                continue
            field = sel["field"]
            cur = percents.get(bw_id, 0) if field == "percent" else row[field]
            if (cur if cur is not None else None) != (sel.get("was") if sel.get("was") != "" else None):
                conflicts.append({"bw_id": bw_id, "field": field, "was": sel.get("was"), "actual": cur, "reason": "changed"})
                continue
            by_bw.setdefault(bw_id, []).append(sel)
        if conflicts:
            raise conflict("Данные на сервере изменились после сверки файла или работа снята — ничего не применено. Загрузите файл заново.", conflicts)

        touched, facts = set(), {}
        for bw_id, items in by_bw.items():
            plan_kwargs = {}
            for sel in items:
                field = sel["field"]
                if field == "percent":
                    block_id, report_date, wt_id = sel.get("block_id"), sel.get("report_date"), sel.get("work_type_id")
                    if not report_date or block_id is None or wt_id is None:
                        raise HTTPException(status_code=422, detail="Неполные данные фиксации прогресса — ничего не применено")
                    facts.setdefault((int(block_id), str(report_date)), {})[int(wt_id)] = sel["now"]
                    touched.add(bw_id)
                else:
                    plan_kwargs[field] = sel["now"]
            if plan_kwargs:
                try:
                    block_works.update_block_work(conn, object_id, bw_id, user["id"], commit=False, **plan_kwargs)
                except work_fact.FactError as exc:
                    raise HTTPException(status_code=exc.status_code, detail="%s (ничего не применено)" % exc.message)
                touched.add(bw_id)
        reports = 0
        for (block_id, report_date), wt_percents in facts.items():
            try:
                work_fact.save_report(conn, object_id, user["id"], block_id, None, report_date, wt_percents, commit=False)
            except work_fact.FactError as exc:
                raise HTTPException(status_code=exc.status_code,
                                    detail="Блок %s, %s: %s (ничего не применено)" % (block_id, report_date, exc.message))
            reports += 1
        conn.commit()
        if touched:
            activity.log("block_bulk_edit", user_id=user["id"], entity_type="object", entity_id=object_id,
                         details={"block_works_updated": len(touched), "fact_reports_created": reports, "source": "xlsx"})
        activity.defer_flush(events)
        return {"block_works_updated": len(touched), "fact_reports_created": reports, "skipped": []}
    finally:
        activity.defer_end(events)
        conn.close()
