"""
Вложения к Проекту, Объекту и Элементу (2026-08-02, живой запрос).

Произвольные файлы у сущности справочника: фото дефекта, акт, письмо
согласования, скан накладной. Одна таблица и один роутер на все три вида —
набор полей у файла одинаков, различается только владелец; три таблицы
означали бы три копии загрузки, скачивания, удаления и проверки прав.

**Имя файла с диска и имя от пользователя — разные вещи.** На диск файл
кладётся под сгенерированным именем (uuid + расширение), исходное имя
живёт в базе и отдаётся только заголовком скачивания. Класть присланное
имя в путь — прямой путь к «../../» и к затиранию чужого файла совпавшим
именем.

**Права выводятся из владельца, а не принимаются параметром:**
  элемент  -> объект элемента;
  объект   -> он сам;
  проект   -> администратор сервиса (проекты и так его епархия).
Читать может любой, у кого есть доступ к объекту; прикладывать — роль не
ниже `user` (приложить фото дефекта это работа прораба); удалять — `admin`
на объекте: удалённое вложение восстановить нечем, и снимать чужое
доказательство не должен тот, кто его не заводил.
"""

import re
import sqlite3
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile

from app import activity
from app.access import assert_object_access, is_system_admin, require_system_admin
from app.auth import audit_display_name, get_current_user
from app.db import get_connection
from app.upload_limits import read_upload_limited

router = APIRouter(prefix="/attachments", tags=["attachments"])

ATTACHMENTS_DIR = Path(__file__).resolve().parent.parent / "uploads" / "attachments"

ENTITY_TYPES = ("project", "object", "element")
ENTITY_LABELS = {"project": "проект", "object": "объект", "element": "элемент"}


def _object_of(conn, entity_type: str, entity_id: int) -> Optional[int]:
    """Объект, по которому проверяются права на вложение. None — владелец
    объекту не принадлежит (проект) либо владельца нет вовсе."""
    if entity_type == "object":
        row = conn.execute("SELECT id FROM objects WHERE id = ?", (entity_id,)).fetchone()
        return row["id"] if row else None
    if entity_type == "element":
        row = conn.execute("SELECT object_id FROM elements WHERE id = ?", (entity_id,)).fetchone()
        return row["object_id"] if row else None
    return None


def _guard(conn, user, entity_type: str, entity_id: int, minimum: str) -> None:
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(status_code=400, detail=f"Неизвестный вид сущности «{entity_type}»")
    if entity_type == "project":
        # Проекты ведёт администратор сервиса — вложение к проекту той же
        # природы, что и сам проект.
        if not is_system_admin(user):
            raise HTTPException(status_code=403,
                                detail="Вложения проекта правит администратор сервиса")
        if conn.execute("SELECT 1 FROM projects WHERE id = ?", (entity_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Проект не найден")
        return
    object_id = _object_of(conn, entity_type, entity_id)
    if object_id is None:
        # Владельца нет или он без объекта: в обоих случаях это данные без
        # известного хозяина — только администратору сервиса.
        if not is_system_admin(user):
            raise HTTPException(
                status_code=404,
                detail=f"{ENTITY_LABELS[entity_type].capitalize()} не найден",
            )
        return
    assert_object_access(conn, user, object_id, minimum)


def _row_out(row: sqlite3.Row) -> dict:
    d = dict(row)
    d.pop("stored_name", None)   # путь на диске наружу не отдаём
    return d


# Тип содержимого, с которым вложение ОТДАЁТСЯ. Всегда один и тот же, и это
# не перестраховка (аудит безопасности 2026-08-03).
#
# Раньше в ответ шёл `content_type`, присланный самим загружающим. Заголовок
# `Content-Disposition: attachment` защищает только от перехода по ссылке —
# он НЕ мешает подключить тот же адрес подресурсом: `<script
# src="/attachments/17/download">`. `X-Content-Type-Options: nosniff` тут
# тоже не помощник: он требует, чтобы MIME был скриптовым, а MIME задавал
# сам атакующий. То есть любой, кому можно приложить файл (роль `user` хотя
# бы на одном объекте), клал на наш же origin произвольный JS — и
# `script-src 'self'` в CSP переставал что-либо значить.
#
# `application/octet-stream` + nosniff — браузер отказывается исполнять файл
# как скрипт. Для пользователя не меняется ничего: файл и так скачивается, а
# чем его открыть, ОС решает по расширению имени из `Content-Disposition`.
DOWNLOAD_CONTENT_TYPE = "application/octet-stream"

# Что кладём в БД. Значение информационное (показывается в списке вложений),
# но приходит от клиента, поэтому принимаем только опрятный MIME-токен —
# иначе в интерфейс попадёт произвольная строка.
_MIME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$")


def sanitize_content_type(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    # Параметры (`; charset=utf-8`) отбрасываем — храним только сам тип.
    основной = value.split(";")[0].strip().lower()
    return основной if _MIME_RE.match(основной) else None


def list_for(conn, entity_type: str, entity_id: int) -> list:
    return [
        _row_out(r) for r in conn.execute(
            "SELECT id, entity_type, entity_id, filename, size, content_type, description, "
            "uploaded_at, uploaded_by FROM attachments "
            "WHERE entity_type = ? AND entity_id = ? ORDER BY uploaded_at DESC, id DESC",
            (entity_type, entity_id),
        )
    ]


def counts_for(conn, entity_type: str, entity_ids) -> dict:
    """{entity_id: сколько файлов} для пачки сущностей — справочник
    элементов рисует скрепку у каждой строки, и запрос на строку был бы
    двухсотым запросом на страницу."""
    ids = list(entity_ids)
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    return {
        r["entity_id"]: r["n"]
        for r in conn.execute(
            f"SELECT entity_id, COUNT(*) AS n FROM attachments "
            f"WHERE entity_type = ? AND entity_id IN ({marks}) GROUP BY entity_id",
            (entity_type, *ids),
        )
    }


def delete_for_entity(conn, entity_type: str, entity_id: int) -> int:
    """Снести вложения вместе с владельцем. Внешнего ключа на три разные
    таблицы не выразить, поэтому каскад — руками, из тех мест, где владелец
    удаляется."""
    rows = conn.execute(
        "SELECT stored_name FROM attachments WHERE entity_type = ? AND entity_id = ?",
        (entity_type, entity_id),
    ).fetchall()
    for r in rows:
        _unlink(r["stored_name"])
    conn.execute("DELETE FROM attachments WHERE entity_type = ? AND entity_id = ?",
                 (entity_type, entity_id))
    return len(rows)


def _unlink(stored_name: str) -> None:
    """Файла может не быть (перенос сервера, ручная чистка) — это не повод
    ронять удаление записи: запись без файла бесполезна, файл без записи
    невидим, из двух зол убираем оба."""
    try:
        (ATTACHMENTS_DIR / stored_name).unlink()
    except OSError:
        pass


@router.get("")
def list_attachments(entity_type: str = Query(...), entity_id: int = Query(...),
                     user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _guard(conn, user, entity_type, entity_id, "view")
        return {"attachments": list_for(conn, entity_type, entity_id)}
    finally:
        conn.close()


@router.post("")
def upload_attachment(
    entity_type: str = Form(...),
    entity_id: int = Form(...),
    description: Optional[str] = Form(None),
    file: UploadFile = File(...),
    user: sqlite3.Row = Depends(get_current_user),
):
    conn = get_connection()
    try:
        _guard(conn, user, entity_type, entity_id, "user")
    finally:
        conn.close()

    исходное = (file.filename or "файл").strip() or "файл"
    # Из присланного имени берём ТОЛЬКО расширение и только безопасное:
    # оно нужно, чтобы браузер и ОС открыли скачанный файл нужной
    # программой. Само имя на диск не попадает.
    расширение = Path(исходное).suffix.lower()
    if len(расширение) > 12 or not расширение[1:].isalnum():
        расширение = ""
    stored = f"{uuid.uuid4().hex}{расширение}"

    содержимое = read_upload_limited(file.file)
    if not содержимое:
        raise HTTPException(status_code=400, detail="Файл пустой")
    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
    (ATTACHMENTS_DIR / stored).write_bytes(содержимое)

    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO attachments (entity_type, entity_id, filename, stored_name, size, "
            "content_type, description, uploaded_by, uploaded_by_user_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (entity_type, entity_id, исходное[:255], stored, len(содержимое),
             sanitize_content_type(file.content_type), (description or "").strip() or None,
             audit_display_name(user), user["id"]),
        )
        conn.commit()
        итог = list_for(conn, entity_type, entity_id)
    finally:
        conn.close()
    activity.log("attachment_add", user=user, entity_type=entity_type, entity_id=entity_id,
                 new_value=исходное[:255])
    return {"attachments": итог}


@router.get("/{attachment_id}/download")
def download_attachment(attachment_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM attachments WHERE id = ?", (attachment_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Вложение не найдено")
        _guard(conn, user, row["entity_type"], row["entity_id"], "view")
    finally:
        conn.close()

    путь = ATTACHMENTS_DIR / row["stored_name"]
    if not путь.is_file():
        raise HTTPException(status_code=410, detail="Файл вложения отсутствует на диске")
    from urllib.parse import quote
    имя = row["filename"]
    return Response(
        content=путь.read_bytes(),
        media_type=DOWNLOAD_CONTENT_TYPE,  # см. комментарий у константы
        headers={"Content-Disposition":
                 f"attachment; filename=\"file\"; filename*=UTF-8''{quote(имя)}"},
    )


@router.delete("/{attachment_id}")
def delete_attachment(attachment_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM attachments WHERE id = ?", (attachment_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Вложение не найдено")
        _guard(conn, user, row["entity_type"], row["entity_id"], "admin")
        conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
        conn.commit()
        итог = list_for(conn, row["entity_type"], row["entity_id"])
    finally:
        conn.close()
    _unlink(row["stored_name"])
    activity.log("attachment_delete", user=user, entity_type=row["entity_type"],
                 entity_id=row["entity_id"], old_value=row["filename"])
    return {"attachments": итог}
