# -*- coding: utf-8 -*-
"""
Раздел «Обучение»: инструкция под свои роли и тест по ней (2026-08-14).

Материал лежит в app/training_content.py и пишется НА РАЗДЕЛ прав, а не на
роль (почему — см. заголовок того модуля). Здесь только сборка под
конкретного человека, ведение попытки и история прохождений.

Что сделано намеренно:

- **Правильный вариант не покидает сервер до ответа.** Клиенту уходят
  только тексты вариантов; какой из них верный, он узнаёт вместе с
  разбором, то есть уже после того, как ответ записан. Иначе тест
  проходится инструментами разработчика за минуту.
- **Варианты тасуются на каждую выдачу**, а порядок запоминается в попытке
  (`current_options`). Без этого правильный ответ стоял бы там, куда его
  поставил автор материала, и тест проверял бы наблюдательность.
- **Время «сколько думал» считает сервер** (`asked_at` → момент ответа).
  Время, присланное клиентом, подделывается тривиально, а ради него
  история и ведётся.
- **Ответ неизменяем.** Повторный ответ на тот же вопрос — 409. Иначе итог
  показывал бы не знание, а упорство.
- **Текст вопроса и вариантов пишется снимком** в `training_answers`:
  правка формулировок в новой версии не должна задним числом менять то, на
  что человек отвечал. Рядом лежит редакция материала (`content_version`).

Чужая история закрыта разделом `training_admin`; свою видит каждый — это
«своё», как личные настройки.
"""

import json
import random
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import activity
from app.access import (
    feature_level_for,
    has_feature,
    require_service_feature,
    role_labels,
    role_level,
)
from app.db import get_connection
from app.features import FEATURES, READ
from app.training_content import (
    CONTENT_VERSION,
    blocks_for,
    missing_features,
    question as найти_вопрос,
    questions_for,
)

router = APIRouter(prefix="/training", tags=["training"])

# Вопросов в одной попытке. Двадцать — решение пользователя 2026-08-14:
# полный прогон по всем разделам роли даёт у комплектовщика и администратора
# сотню с лишним вопросов за раз, и до конца доходят единицы. Меньше, чем
# доступно, — берётся сколько есть.
QUESTIONS_PER_ATTEMPT = 20

# Момент с долями секунды: обычный datetime('now') округляет до секунды, а
# «сколько думал» на быстрых вопросах тогда сплющивается в ноль.
_NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')"


def _уровни(conn: sqlite3.Connection, user: sqlite3.Row, object_id: Optional[int]) -> dict:
    """{ключ раздела: уровень} для ЭТОГО человека — теми же вызовами,
    которыми отвечают сами эндпоинты (app/access.has_feature)."""
    return {f.key: feature_level_for(conn, user, f.key, object_id) for f in FEATURES}


def _уровни_роли(conn: sqlite3.Connection, role_key: str) -> dict:
    """{ключ раздела: уровень} для ОДНОЙ роли — режим «посмотреть глазами
    роли». Считается по той же таблице role_features, что и права."""
    return {f.key: role_level(conn, [role_key], f.key) for f in FEATURES}


def _может_смотреть_чужое(conn: sqlite3.Connection, user: sqlite3.Row) -> bool:
    return has_feature(conn, user, "training_admin", READ)


def _собрать_инструкцию(levels: dict) -> list:
    разделы = []
    for блок, абзацы, уровень in blocks_for(levels):
        разделы.append({
            "key": блок.key,
            "feature": блок.feature,
            "title": блок.title,
            "level": уровень,
            "paragraphs": [p.text for p in абзацы],
        })
    return разделы


@router.get("/guide")
def read_guide(object_id: Optional[int] = Query(None),
               role_key: Optional[str] = Query(None),
               user: sqlite3.Row = Depends(require_service_feature("training", "read"))):
    """Инструкция под права спрашивающего (или под выбранную роль).

    `role_key` — режим «что видит эта роль»; он нужен тому, кто раздаёт
    роли, до того как их выдали живому человеку, поэтому закрыт правом на
    настройку ролей или на чужую историю обучения. Себе человек этим ничего
    не открывает: показывается ТЕКСТ, а не доступ к операциям.
    """
    conn = get_connection()
    try:
        if role_key:
            if not (has_feature(conn, user, "roles", READ) or _может_смотреть_чужое(conn, user)):
                raise HTTPException(
                    status_code=403,
                    detail="Смотреть инструкцию чужой роли может тот, кому доступна "
                           "настройка ролей или история обучения")
            if conn.execute("SELECT 1 FROM object_roles WHERE key = ?", (role_key,)).fetchone() is None:
                raise HTTPException(status_code=404, detail="Роль не найдена")
            levels = _уровни_роли(conn, role_key)
        else:
            levels = _уровни(conn, user, object_id)
        return {
            "content_version": CONTENT_VERSION,
            "role_key": role_key,
            "role_name": role_labels(conn).get(role_key) if role_key else None,
            "object_id": object_id,
            "blocks": _собрать_инструкцию(levels),
            "questions_total": len(questions_for(levels)),
            "questions_per_attempt": QUESTIONS_PER_ATTEMPT,
            # Разделы, для которых материал ещё не написан. Показывается
            # плашкой на экране: материал пишется этапами, и «чего ещё нет»
            # должно быть видно, а не подразумеваться.
            "missing": missing_features(),
            "roles": [dict(r) for r in conn.execute(
                "SELECT key, name FROM object_roles ORDER BY rank")]
            if (has_feature(conn, user, "roles", READ) or _может_смотреть_чужое(conn, user))
            else [],
        }
    finally:
        conn.close()


def _вопрос_наружу(conn: sqlite3.Connection, попытка: sqlite3.Row) -> Optional[dict]:
    """Текущий вопрос попытки в том виде, в каком его видит отвечающий, —
    без единого признака правильного варианта."""
    if not попытка["current_question"]:
        return None
    найдено = найти_вопрос(попытка["current_question"])
    if найдено is None:
        return None
    блок, вопрос = найдено
    порядок = json.loads(попытка["current_options"] or "[]")
    return {
        "key": вопрос.key,
        "block_title": блок.title,
        "feature": блок.feature,
        "text": вопрос.text,
        "options": [вопрос.options[i] for i in порядок],
        "number": попытка["answered"] + 1,
        "total": попытка["questions"],
    }


def _задать_вопрос(conn: sqlite3.Connection, попытка_id: int, levels: dict) -> None:
    """Выбрать очередной вопрос и записать его в попытку.

    Список вопросов заранее не составляется: он всё равно проверялся бы на
    каждом шаге (материал мог обновиться, права — измениться), а храниться
    ему пришлось бы отдельной таблицей ради того же результата.
    """
    заданные = {r["question_key"] for r in conn.execute(
        "SELECT question_key FROM training_answers WHERE attempt_id = ?", (попытка_id,))}
    доступные = [в for _б, в in questions_for(levels) if в.key not in заданные]
    if not доступные:
        _завершить(conn, попытка_id)
        return
    вопрос = random.choice(доступные)
    порядок = list(range(len(вопрос.options)))
    random.shuffle(порядок)
    conn.execute(
        f"UPDATE training_attempts SET current_question = ?, current_options = ?, "
        f"asked_at = {_NOW} WHERE id = ?",
        (вопрос.key, json.dumps(порядок), попытка_id))


def _завершить(conn: sqlite3.Connection, попытка_id: int) -> None:
    conn.execute(
        "UPDATE training_attempts SET finished_at = datetime('now'), "
        "current_question = NULL, current_options = NULL, asked_at = NULL WHERE id = ?",
        (попытка_id,))


def _попытка(conn: sqlite3.Connection, attempt_id: int) -> sqlite3.Row:
    строка = conn.execute(
        "SELECT * FROM training_attempts WHERE id = ?", (attempt_id,)).fetchone()
    if строка is None:
        raise HTTPException(status_code=404, detail="Попытка не найдена")
    return строка


class StartIn(BaseModel):
    object_id: Optional[int] = None
    role_key: Optional[str] = None


class AnswerIn(BaseModel):
    question_key: str
    option: int          # индекс в ПОКАЗАННОМ порядке вариантов


@router.get("/state")
def read_state(object_id: Optional[int] = Query(None),
               user: sqlite3.Row = Depends(require_service_feature("training", "read"))):
    """Что показать на экране теста до его начала: незавершённая попытка,
    если она есть, и собственный итог."""
    conn = get_connection()
    try:
        текущая = conn.execute(
            "SELECT * FROM training_attempts WHERE user_id = ? AND finished_at IS NULL "
            "ORDER BY id DESC LIMIT 1", (user["id"],)).fetchone()
        return {
            "attempt": ({"id": текущая["id"], "answered": текущая["answered"],
                         "correct": текущая["correct"], "questions": текущая["questions"],
                         "question": _вопрос_наружу(conn, текущая)} if текущая else None),
            "rating": rating_for(conn, [user["id"]]).get(user["id"]),
            "questions_per_attempt": QUESTIONS_PER_ATTEMPT,
        }
    finally:
        conn.close()


@router.post("/attempts", status_code=201)
def start_attempt(body: StartIn,
                  user: sqlite3.Row = Depends(require_service_feature("training", "read"))):
    """Начать попытку. Незавершённая уже есть — возвращается она.

    Возвращается, а не заводится новая: брошенная на середине попытка иначе
    копилась бы десятками, а «начать заново» превратилось бы в способ
    выбросить неудачный результат до его записи.
    """
    conn = get_connection()
    try:
        текущая = conn.execute(
            "SELECT * FROM training_attempts WHERE user_id = ? AND finished_at IS NULL "
            "ORDER BY id DESC LIMIT 1", (user["id"],)).fetchone()
        if текущая:
            return {"id": текущая["id"], "resumed": True,
                    "answered": текущая["answered"], "correct": текущая["correct"],
                    "questions": текущая["questions"],
                    "question": _вопрос_наружу(conn, текущая)}

        if body.role_key:
            # Проходить можно и «за роль» — например, когда ролей несколько
            # и человек хочет проверить себя по одной из них. Чужой набор
            # прав так не открывается: спрашивают по МАТЕРИАЛУ, а не по
            # доступу к операциям.
            if conn.execute("SELECT 1 FROM object_roles WHERE key = ?",
                            (body.role_key,)).fetchone() is None:
                raise HTTPException(status_code=404, detail="Роль не найдена")
            levels = _уровни_роли(conn, body.role_key)
        else:
            levels = _уровни(conn, user, body.object_id)

        доступно = len(questions_for(levels))
        if not доступно:
            raise HTTPException(
                status_code=400,
                detail="По доступным разделам вопросов пока нет — материал ещё пишется")
        всего = min(QUESTIONS_PER_ATTEMPT, доступно)
        cur = conn.execute(
            "INSERT INTO training_attempts (user_id, role_key, object_id, content_version, "
            "questions) VALUES (?, ?, ?, ?, ?)",
            (user["id"], body.role_key, body.object_id, CONTENT_VERSION, всего))
        попытка_id = cur.lastrowid
        _задать_вопрос(conn, попытка_id, levels)
        conn.commit()
        строка = _попытка(conn, попытка_id)
        return {"id": попытка_id, "resumed": False, "answered": 0, "correct": 0,
                "questions": всего, "question": _вопрос_наружу(conn, строка)}
    finally:
        conn.close()


@router.post("/attempts/{attempt_id}/answer")
def answer(attempt_id: int, body: AnswerIn,
           user: sqlite3.Row = Depends(require_service_feature("training", "read"))):
    """Зафиксировать ответ и вернуть разбор вместе со следующим вопросом.

    Ответ записывается ДО того, как человек узнаёт правильный вариант, и
    больше не меняется.
    """
    conn = get_connection()
    try:
        попытка = _попытка(conn, attempt_id)
        if попытка["user_id"] != user["id"]:
            # Не 403 с объяснением, а именно «не найдена»: чужая попытка —
            # не ваше дело, и подтверждать её существование незачем.
            raise HTTPException(status_code=404, detail="Попытка не найдена")
        if попытка["finished_at"]:
            raise HTTPException(status_code=409, detail="Попытка уже завершена")
        if попытка["current_question"] != body.question_key:
            raise HTTPException(
                status_code=409,
                detail="Этот вопрос уже отвечен: ответ не меняется")

        найдено = найти_вопрос(body.question_key)
        if найдено is None:
            # Материал обновился прямо посреди попытки. Вопрос пропускаем,
            # выдавая следующий: засчитать ответ на исчезнувший вопрос
            # нельзя, а рушить попытку из-за выхода версии — тем более.
            levels = (_уровни_роли(conn, попытка["role_key"]) if попытка["role_key"]
                      else _уровни(conn, user, попытка["object_id"]))
            _задать_вопрос(conn, attempt_id, levels)
            conn.commit()
            строка = _попытка(conn, attempt_id)
            return {"skipped": True, "question": _вопрос_наружу(conn, строка),
                    "finished": bool(строка["finished_at"])}

        блок, вопрос = найдено
        порядок = json.loads(попытка["current_options"] or "[]")
        if not 0 <= body.option < len(порядок):
            raise HTTPException(status_code=400, detail="Такого варианта ответа нет")
        исходный = порядок[body.option]
        верно = исходный == вопрос.correct

        conn.execute(
            "INSERT INTO training_answers (attempt_id, ord, question_key, feature_key, "
            "question_text, chosen_text, correct_text, is_correct, spent_ms, answered_at) "
            f"VALUES (?, ?, ?, ?, ?, ?, ?, ?, "
            f"CAST((julianday({_NOW}) - julianday(?)) * 86400000 AS INTEGER), datetime('now'))",
            (attempt_id, попытка["answered"] + 1, вопрос.key, блок.feature, вопрос.text,
             вопрос.options[исходный], вопрос.options[вопрос.correct], 1 if верно else 0,
             попытка["asked_at"]))
        conn.execute(
            "UPDATE training_attempts SET answered = answered + 1, correct = correct + ? "
            "WHERE id = ?", (1 if верно else 0, attempt_id))

        строка = _попытка(conn, attempt_id)
        завершена = строка["answered"] >= строка["questions"]
        if завершена:
            _завершить(conn, attempt_id)
        else:
            levels = (_уровни_роли(conn, попытка["role_key"]) if попытка["role_key"]
                      else _уровни(conn, user, попытка["object_id"]))
            _задать_вопрос(conn, attempt_id, levels)
        conn.commit()

        строка = _попытка(conn, attempt_id)
        if строка["finished_at"]:
            activity.log("training_attempt", user=user,
                         new_value=f"{строка['correct']} из {строка['answered']}",
                         details={"attempt_id": attempt_id,
                                  "content_version": строка["content_version"]})
        return {
            "correct": верно,
            "correct_text": вопрос.options[вопрос.correct],
            "explain": вопрос.explain,
            "score": {"correct": строка["correct"], "answered": строка["answered"],
                      "questions": строка["questions"]},
            "finished": bool(строка["finished_at"]),
            "question": _вопрос_наружу(conn, строка),
        }
    finally:
        conn.close()


def rating_for(conn: sqlite3.Connection, user_ids: list) -> dict:
    """Итог обучения по людям: лучшая ЗАВЕРШЁННАЯ попытка и число попыток.

    Лучшая, а не последняя: рейтинг отвечает на вопрос «человек это знает»,
    и неудачный второй заход после успешного первого знания не отменяет.
    Незавершённые попытки не считаются вовсе — брошенный на третьем вопросе
    тест не результат.

    Живёт здесь, а не в app/users.py: список пользователей показывает
    колонку, но правило «что такое результат» принадлежит обучению.
    """
    if not user_ids:
        return {}
    метки = ",".join("?" for _ in user_ids)
    итог = {}
    for r in conn.execute(
        f"SELECT user_id, COUNT(*) AS attempts, MAX(correct) AS best, "
        f"MAX(questions) AS total FROM training_attempts "
        f"WHERE finished_at IS NOT NULL AND user_id IN ({метки}) GROUP BY user_id",
        user_ids,
    ):
        итог[r["user_id"]] = {"attempts": r["attempts"], "best": r["best"],
                              "total": r["total"]}
    return итог


@router.get("/ratings")
def read_ratings(user: sqlite3.Row = Depends(require_service_feature("training_admin", "read"))):
    """Итоги обучения всех людей — колонка «Обучение» в списке пользователей.

    Отдельным запросом, а не полем в списке пользователей: `UserOut`
    обслуживает и вход, и добавить туда счёт обучения значило бы считать
    его при каждом логине ради колонки, которую видит один администратор.
    """
    conn = get_connection()
    try:
        # ФИО отдаются здесь же, а не берутся из списка пользователей:
        # раздел «Пользователи» и раздел «История прохождения тестов» —
        # разные права, и требовать первый ради подписи строки значило бы
        # открыть историю обучения только тем, кто и так ведёт учётные
        # записи.
        люди = conn.execute(
            "SELECT id, last_name, first_name, patronymic, position "
            "FROM users ORDER BY last_name, first_name").fetchall()
        итоги = rating_for(conn, [r["id"] for r in люди])
        return {"users": [{
            "id": r["id"],
            "name": " ".join(x for x in (r["last_name"], r["first_name"], r["patronymic"]) if x),
            "position": r["position"],
            "rating": итоги.get(r["id"]),
        } for r in люди]}
    finally:
        conn.close()


@router.get("/attempts")
def list_attempts(user_id: Optional[int] = Query(None),
                  user: sqlite3.Row = Depends(require_service_feature("training", "read"))):
    """История попыток: своя — всегда, чужая — по разделу «История
    прохождения тестов другими людьми»."""
    conn = get_connection()
    try:
        кого = user_id if user_id is not None else user["id"]
        if кого != user["id"] and not _может_смотреть_чужое(conn, user):
            raise HTTPException(
                status_code=403,
                detail="Смотреть чужую историю обучения может тот, кому выдан раздел "
                       "«История прохождения тестов другими людьми»")
        строки = conn.execute(
            "SELECT * FROM training_attempts WHERE user_id = ? ORDER BY id DESC", (кого,)
        ).fetchall()
        подписи = role_labels(conn)
        return {
            "user_id": кого,
            "attempts": [{
                "id": r["id"],
                "role_key": r["role_key"],
                "role_name": подписи.get(r["role_key"]) if r["role_key"] else "все свои роли",
                "content_version": r["content_version"],
                "questions": r["questions"], "answered": r["answered"],
                "correct": r["correct"],
                "started_at": r["started_at"], "finished_at": r["finished_at"],
            } for r in строки],
        }
    finally:
        conn.close()


@router.get("/attempts/{attempt_id}")
def read_attempt(attempt_id: int,
                 user: sqlite3.Row = Depends(require_service_feature("training", "read"))):
    """Разбор попытки по ответам: что спрашивали, что человек выбрал, верно
    ли и сколько думал."""
    conn = get_connection()
    try:
        попытка = _попытка(conn, attempt_id)
        if попытка["user_id"] != user["id"] and not _может_смотреть_чужое(conn, user):
            raise HTTPException(status_code=404, detail="Попытка не найдена")
        ответы = conn.execute(
            "SELECT * FROM training_answers WHERE attempt_id = ? ORDER BY ord",
            (attempt_id,)).fetchall()
        return {
            "id": попытка["id"], "user_id": попытка["user_id"],
            "content_version": попытка["content_version"],
            "questions": попытка["questions"], "answered": попытка["answered"],
            "correct": попытка["correct"],
            "started_at": попытка["started_at"], "finished_at": попытка["finished_at"],
            "answers": [{
                "ord": r["ord"], "feature": r["feature_key"],
                "question": r["question_text"], "chosen": r["chosen_text"],
                "correct_text": r["correct_text"], "is_correct": bool(r["is_correct"]),
                "spent_ms": r["spent_ms"], "answered_at": r["answered_at"],
            } for r in ответы],
        }
    finally:
        conn.close()
