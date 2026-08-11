"""
ПЕРЕНОС БАЗЫ ЦЕЛИКОМ с боевого сервера на тестовый/девелоперский
(2026-08-11, живой запрос).

Зачем понадобилось. Три раздела «Массовой правки через Excel» (реквизиты,
история статусов, контрактация) переносят СРЕЗ данных и делают это
ДОПОЛНЕНИЕМ: строки сопоставляются с уже имеющимися, чего нет в файле —
остаётся как было. Для «потестировать на реальных данных» это негодный
инструмент: на приёмнике остаются свои элементы, свои контракты и своя
история, чужие id перемешиваются с местными, и целостность рвётся —
позиция контракта ссылается на спецификацию, которой в файле не было,
элемент на зону из другого чертежа. Здесь нужна не правка, а ЗАМЕНА.

Поэтому формат переноса — не таблица, а СНИМОК: файл базы целиком плюс
папка вложений. Решение пользователя 2026-08-11 из трёх вариантов
(снимок .db / выгрузка по таблицам в json / книга Excel). Причина: у
снимка целостность обеспечена физикой файла, а не кодом, — переносится
всё до последней строки, разъезжаться нечему, и на каждую новую таблицу
про неё не надо помнить. Построчная выгрузка терпимее к расхождению схем,
но её пришлось бы сопровождать вечно.

**Расхождение схем решается миграциями, а не форматом.** Тестовый сервер
обычно ОПЕРЕЖАЕТ боевой по версии, то есть в снимке приезжает схема
постарше. Ровно так же ведёт себя восстановление из резервной копии
(app/backups.py): после переноса данных вызывающий прогоняет `init_db()`
и обработки релиза (`release_tasks.run_pending()`), и схема догоняет код.
Обратный случай — снимок НОВЕЕ кода приёмника — не лечится ничем, миграции
назад не ходят; такой файл отвергается на сверке, до всякой замены.

Что внутри архива (zip):
  manifest.json — что это, откуда, когда, чем снято, сколько строк;
  db/zhbi.db    — файл базы, снятый штатным `Connection.backup()`;
  uploads/…     — вложения к проекту/объекту/изделию, как есть на диске.
Вложения включены намеренно (решение пользователя: «всё»): без файлов
строки `attachments` ссылались бы в пустоту — карточка вложение
показывает, а скачать нельзя.

**Загрузка идёт в два приёма: сверка и замена.** Сначала архив
СТАВИТСЯ В ОЧЕРЕДЬ (`stage`) — проверяется, что это вообще снимок, что
база в нём цела, и человеку показывают, ЧТО приехало против того, что
сейчас. И только потом, отдельным вызовом с кодовым словом, происходит
замена. Разделение не для красоты: замена стирает базу приёмника целиком,
и единственный способ не сделать этого по ошибке — сначала увидеть числа.

Защита от случайного запуска на БОЕВОМ сервере (решение пользователя
2026-08-11): служебная резервная копия снимается ВСЕГДА перед заменой, а
сама замена требует ввода кодового слова (`CONFIRM_WORD`). Флага
окружения намеренно нет — пользователь его отклонил: раздел и так за
администратором сервиса, а лишняя переменная в docker-compose означает,
что однажды её забудут и решат, что «сломалось обновление».
"""

import json
import shutil
import socket
import sqlite3
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import app.db as _db
from app import backups

ROOT = Path(__file__).resolve().parent.parent
UPLOADS_DIR = ROOT / "uploads"
# Куда кладётся присланный архив между сверкой и заменой. Рядом с базой и
# копиями: `data/` в Docker уже смонтирована томом, значит файл переживёт
# пересоздание контейнера и не упрётся в размер образа.
STAGING_DIR = ROOT / "data" / "transfer"

# Версия формата архива. Пишется в манифест и проверяется при загрузке:
# архив, снятый будущей версией с другим устройством, должен отвергаться
# внятной фразой, а не падать посреди распаковки.
FORMAT_VERSION = 1

# Кодовое слово подтверждения (решение пользователя 2026-08-11). Хранится
# здесь, а не в настройках: смысл его в том, чтобы палец не набрал его
# случайно, а не в секретности — раздел и так за администратором сервиса.
CONFIRM_WORD = "080"

# Имена внутри архива. Держатся константами, потому что проверяются при
# распаковке: всё, что не начинается с них, в архив не принимается.
MANIFEST_NAME = "manifest.json"
DB_MEMBER = "db/zhbi.db"
UPLOADS_PREFIX = "uploads/"

# Предохранитель от «зип-бомбы»: суммарный РАСПАКОВАННЫЙ размер архива.
# 20 ГБ — заведомо больше любой реальной базы с вложениями и заведомо
# меньше того, чем можно забить диск сервера.
MAX_UNPACKED_BYTES = 20 * 1024 * 1024 * 1024

# Таблицы, без которых файл — не база этого сервиса. Проверяются до
# замены: подсунутый посторонний .sqlite не должен затирать рабочую базу.
REQUIRED_TABLES = ("elements", "users", "app_settings")

# Сколько архивов держать в очереди. Каждый — копия всей базы, и забытые
# после неудачных попыток они съедят диск.
STAGING_KEEP = 3


class TransferError(Exception):
    """Ошибка переноса, которую надо показать человеку как есть."""

    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def _utc_now() -> datetime:
    """UTC, как везде в сервисе (см. app/backups.py): в местное время
    отметку переводит клиент при показе."""
    return datetime.now(timezone.utc)


def _stamp() -> str:
    return _utc_now().strftime("%Y%m%d_%H%M%S")


# ==================== ОПИСАНИЕ БАЗЫ ====================


def _table_counts(path: Path) -> dict:
    """Сколько строк в каждой таблице. Тот же приём, что у резервных копий:
    полнота снимка должна быть ВИДНА числами, а не продекларирована."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return {}
    try:
        conn.row_factory = sqlite3.Row
        tables = [r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()]
        counts = {}
        for t in tables:
            try:
                counts[t] = conn.execute(f'SELECT COUNT(*) AS n FROM "{t}"').fetchone()["n"]
            except sqlite3.Error:
                counts[t] = None
        return counts
    except sqlite3.Error:
        return {}
    finally:
        conn.close()


def _db_release_version(path: Path) -> Optional[str]:
    """Версия релиза, до которой доведена база (`db_release_version` в
    app_settings, см. app/release_tasks.py). Читается сырым SQL, а не через
    release_tasks: там функция работает с ТЕКУЩЕЙ базой, а нам нужна чужая
    из архива."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = ?",
            ("db_release_version",)).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def _uploads_stats(root: Path) -> dict:
    """Файлы вложений: сколько и на сколько байт."""
    files = 0
    size = 0
    if root.is_dir():
        for p in root.rglob("*"):
            if p.is_file():
                files += 1
                size += p.stat().st_size
    return {"files": files, "bytes": size}


def describe_current() -> dict:
    """Что сейчас в рабочей базе — левая колонка сверки «было/приедет».
    Считается по живому файлу, а не по последней резервной копии: человек
    должен видеть то, что действительно потеряет."""
    from app.release_tasks import code_version  # локально: избегаем цикла импорта

    path = Path(_db.DB_PATH)
    return {
        "db_path": str(path),
        "db_bytes": path.stat().st_size if path.exists() else 0,
        "code_version": code_version(),
        "db_version": _db_release_version(path),
        "tables": _table_counts(path),
        "uploads": _uploads_stats(UPLOADS_DIR),
        "host": socket.gethostname(),
    }


# ==================== ВЫГРУЗКА СНИМКА ====================


def build_archive(target: Path, user_name: Optional[str] = None) -> dict:
    """Собрать архив переноса в `target`. Возвращает манифест.

    База копируется `Connection.backup()`, а не `shutil.copy`: сервер в этот
    момент работает и пишет, а простое копирование файла может поймать базу
    посреди транзакции — ровно та неконсистентность, ради ухода от которой
    весь этот раздел и заводился (см. app/backups.py).
    """
    from app.release_tasks import code_version

    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        db_copy = Path(tmp) / "zhbi.db"
        source = sqlite3.connect(_db.DB_PATH)
        try:
            dest = sqlite3.connect(db_copy)
            try:
                source.backup(dest)
            finally:
                dest.close()
        finally:
            source.close()

        manifest = {
            "format": FORMAT_VERSION,
            "created_at": _utc_now().strftime("%Y-%m-%d %H:%M:%S"),
            "created_by": user_name,
            "host": socket.gethostname(),
            "code_version": code_version(),
            "db_version": _db_release_version(db_copy),
            "db_bytes": db_copy.stat().st_size,
            "tables": _table_counts(db_copy),
            "uploads": _uploads_stats(UPLOADS_DIR),
        }

        # ZIP_DEFLATED: файл базы сжимается в разы, а по сети его тащат
        # через VPN. Пишем во временный файл рядом и переименовываем в
        # конце — недособранный архив не должен выглядеть готовым.
        tmp_zip = target.with_suffix(target.suffix + ".part")
        with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
            zf.write(db_copy, DB_MEMBER)
            if UPLOADS_DIR.is_dir():
                for p in sorted(UPLOADS_DIR.rglob("*")):
                    if p.is_file():
                        zf.write(p, UPLOADS_PREFIX + p.relative_to(UPLOADS_DIR).as_posix())
        tmp_zip.replace(target)
    manifest["archive_bytes"] = target.stat().st_size
    return manifest


# ==================== ОЧЕРЕДЬ (СВЕРКА ПЕРЕД ЗАМЕНОЙ) ====================


def _staged_path(token: str) -> Path:
    """Путь к архиву в очереди по токену. Токен приходит из HTTP, поэтому
    он проверяется на формат: имя файла собирается из него, и без проверки
    заменой можно было бы натравить сервис на произвольный файл."""
    if not token or len(token) != 32 or any(c not in "0123456789abcdef" for c in token):
        raise TransferError(400, "Недопустимый идентификатор загруженного снимка")
    path = STAGING_DIR / f"{token}.zip"
    if not path.exists():
        raise TransferError(404, "Загруженный снимок не найден — загрузите файл заново")
    return path


def _cleanup_staging() -> None:
    """Оставить в очереди только последние архивы: каждый — копия всей
    базы, и брошенные после неудачных попыток они съедят диск."""
    if not STAGING_DIR.is_dir():
        return
    files = sorted(STAGING_DIR.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in files[STAGING_KEEP:]:
        try:
            path.unlink()
        except OSError:
            pass


def _read_manifest(zf: zipfile.ZipFile) -> dict:
    try:
        raw = zf.read(MANIFEST_NAME)
    except KeyError:
        raise TransferError(400, "Это не снимок базы: в архиве нет manifest.json. "
                                 "Нужен файл, выгруженный кнопкой «Выгрузить снимок базы».")
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise TransferError(400, "Манифест снимка повреждён — архив нечитаем")
    if manifest.get("format") != FORMAT_VERSION:
        raise TransferError(
            400,
            f"Формат снимка {manifest.get('format')!r} не поддерживается "
            f"(этот сервис понимает {FORMAT_VERSION}). Скорее всего, снимок снят "
            f"более новой версией сервиса — обновите приёмник.")
    return manifest


def _check_members(zf: zipfile.ZipFile) -> None:
    """Ни одного постороннего или опасного имени. Архив приходит по HTTP,
    и распаковка «как есть» — прямой путь к записи за пределы папки
    («../../app/main.py») и к забиванию диска зип-бомбой."""
    total = 0
    for info in zf.infolist():
        name = info.filename
        if name.endswith("/"):
            continue
        if name.startswith("/") or ".." in Path(name).parts or "\\" in name:
            raise TransferError(400, f"Недопустимое имя файла в архиве: {name}")
        if name != MANIFEST_NAME and name != DB_MEMBER and not name.startswith(UPLOADS_PREFIX):
            raise TransferError(400, f"В архиве посторонний файл: {name}")
        total += info.file_size
        if total > MAX_UNPACKED_BYTES:
            raise TransferError(400, "Архив слишком велик в распакованном виде — "
                                     "похоже, это не снимок базы")
    if DB_MEMBER not in zf.namelist():
        raise TransferError(400, "Это не снимок базы: в архиве нет файла базы")


def _check_db_file(path: Path) -> dict:
    """База из архива пригодна: открывается, цела, и это база ЭТОГО
    сервиса. Проверяется ДО замены — после уже поздно."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        raise TransferError(400, "Файл базы в архиве не открывается")
    try:
        try:
            # quick_check вместо integrity_check: на базе в десятки мегабайт
            # полная проверка идёт заметно дольше, а ловит она то же самое —
            # порчу страниц. Битые индексы всё равно пересоберутся миграцией.
            result = conn.execute("PRAGMA quick_check").fetchone()[0]
        except sqlite3.DatabaseError:
            raise TransferError(400, "Файл базы в архиве повреждён (не читается как SQLite)")
        if result != "ok":
            raise TransferError(400, f"Файл базы в архиве повреждён: {result}")
        names = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        missing = [t for t in REQUIRED_TABLES if t not in names]
        if missing:
            raise TransferError(400, "Это база не от этого сервиса: не хватает таблиц "
                                     + ", ".join(missing))
    finally:
        conn.close()
    return {"tables": _table_counts(path), "db_version": _db_release_version(path)}


def наборы_таблиц_совпадают(a: dict, b: dict) -> bool:
    """Совпадает ли НАБОР таблиц (не числа строк): разошёлся — значит
    снимок с другой версии схемы, и это стоит показать заранее."""
    return set(a or {}) == set(b or {})


def stage_archive(data: bytes, user_name: Optional[str] = None) -> dict:
    """Принять архив, проверить его и положить в очередь. НИЧЕГО НЕ МЕНЯЕТ.

    Возвращает токен для последующей замены, манифест снимка и описание
    текущей базы — чтобы человек увидел «было/станет» до того, как нажмёт
    кнопку, стирающую базу.
    """
    from app.release_tasks import code_version

    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    path = STAGING_DIR / f"{token}.zip"
    path.write_bytes(data)

    try:
        if not zipfile.is_zipfile(path):
            raise TransferError(400, "Файл не является архивом снимка (.zip)")
        with zipfile.ZipFile(path) as zf:
            manifest = _read_manifest(zf)
            _check_members(zf)
            # Базу распаковываем во временную папку и проверяем ЕЁ, а не
            # верим манифесту: манифест пишет отправитель, а рабочую базу
            # затирает содержимое.
            with tempfile.TemporaryDirectory() as tmp:
                db_copy = Path(tmp) / "zhbi.db"
                with zf.open(DB_MEMBER) as src, open(db_copy, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                факт = _check_db_file(db_copy)
                manifest["db_bytes"] = db_copy.stat().st_size
            uploads_files = sum(1 for n in zf.namelist()
                                if n.startswith(UPLOADS_PREFIX) and not n.endswith("/"))
            uploads_bytes = sum(i.file_size for i in zf.infolist()
                                if i.filename.startswith(UPLOADS_PREFIX))
    except TransferError:
        path.unlink(missing_ok=True)
        raise
    except (OSError, zipfile.BadZipFile) as exc:
        path.unlink(missing_ok=True)
        raise TransferError(400, f"Архив не читается: {exc}")

    _cleanup_staging()

    текущая = describe_current()
    # Числа в манифесте — со стороны отправителя; в сверке показываем
    # ПОСЧИТАННЫЕ по самому файлу базы. Расхождение возможно (архив собрали
    # руками), и верить надо файлу.
    снимок = {
        "created_at": manifest.get("created_at"),
        "created_by": manifest.get("created_by"),
        "host": manifest.get("host"),
        "code_version": manifest.get("code_version"),
        "db_version": факт["db_version"],
        "db_bytes": manifest.get("db_bytes"),
        "tables": факт["tables"],
        "uploads": {"files": uploads_files, "bytes": uploads_bytes},
        "archive_bytes": path.stat().st_size,
    }

    предупреждения = []
    # Снимок с БОЛЕЕ НОВОЙ версии кода — единственный случай, который не
    # лечится миграциями: они не ходят назад. Это предупреждение, а не
    # отказ: версии кода сравниваются строками («v0.41» против «v0.9»), и
    # ошибиться в порядке проще, чем зря запретить перенос.
    if снимок["code_version"] and текущая["code_version"] \
            and снимок["code_version"] != текущая["code_version"]:
        предупреждения.append(
            f"Снимок снят версией {снимок['code_version']}, здесь работает "
            f"{текущая['code_version']}. Если снимок НОВЕЕ — миграции схемы назад не "
            f"ходят, и база может не подняться; сначала обновите этот сервер.")
    if not наборы_таблиц_совпадают(снимок["tables"], текущая["tables"]):
        предупреждения.append(
            "Набор таблиц в снимке и в текущей базе различается — недостающие "
            "заведёт миграция схемы сразу после замены.")
    if снимок["uploads"]["files"] == 0 and текущая["uploads"]["files"]:
        предупреждения.append(
            f"В снимке нет файлов вложений, а здесь их {текущая['uploads']['files']} — "
            f"после замены вложения из карточек исчезнут.")

    return {
        "token": token,
        "snapshot": снимок,
        "current": текущая,
        "warnings": предупреждения,
        "confirm_hint": "Для замены введите кодовое слово",
    }


# ==================== ЗАМЕНА ====================


def apply_archive(token: str, confirm: str,
                  user_name: Optional[str] = None,
                  user_id: Optional[int] = None) -> dict:
    """Заменить базу и вложения содержимым архива из очереди.

    Порядок шагов выбран так, чтобы неудача на любом из них оставляла
    систему в понятном состоянии:
      1. кодовое слово — до всего остального;
      2. распаковка и проверка во ВРЕМЕННУЮ папку: битый архив не должен
         дойти до рабочих файлов;
      3. служебная резервная копия текущей базы (требование пользователя);
      4. подмена базы `Connection.backup()`, как при восстановлении из
         копии, — операция идёт в транзакции, и открытые соединения
         сервера не остаются без файла;
      5. подмена вложений: текущая папка не удаляется, а ОТЪЕЗЖАЕТ в
         `data/backups/uploads_<время>` — вернуть её потом есть откуда.

    Схему после этого догоняет вызывающий (`init_db()` и обработки
    релиза) — здесь этого нет намеренно: модуль не должен тянуть за собой
    половину приложения ради одного вызова, а порядок «сначала данные,
    потом миграции» одинаков с восстановлением из копии (app/main.py).
    """
    if (confirm or "").strip() != CONFIRM_WORD:
        raise TransferError(400, "Кодовое слово введено неверно — замена не выполнена")

    path = _staged_path(token)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        with zipfile.ZipFile(path) as zf:
            _check_members(zf)
            db_copy = tmp_path / "zhbi.db"
            with zf.open(DB_MEMBER) as src, open(db_copy, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            _check_db_file(db_copy)
            uploads_new = tmp_path / "uploads"
            for info in zf.infolist():
                if not info.filename.startswith(UPLOADS_PREFIX) or info.filename.endswith("/"):
                    continue
                rel = info.filename[len(UPLOADS_PREFIX):]
                dest = uploads_new / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)

        копия = backups.create_backup(
            kind=backups.KIND_BEFORE_TRANSFER,
            user_name=user_name,
            user_id=user_id,
            comment="автоматически перед полной заменой базы снимком другого сервера",
        )

        source = sqlite3.connect(f"file:{db_copy}?mode=ro", uri=True)
        try:
            target = sqlite3.connect(_db.DB_PATH)
            try:
                source.backup(target)
            finally:
                target.close()
        finally:
            source.close()

        отъехали = None
        if uploads_new.exists():
            backups.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            if UPLOADS_DIR.exists():
                отъехали = backups.BACKUP_DIR / f"uploads_{_stamp()}"
                shutil.move(str(UPLOADS_DIR), str(отъехали))
            shutil.move(str(uploads_new), str(UPLOADS_DIR))

    # Архив из очереди убираем: он уже применён, а лежит он копией всей
    # базы. Повторная замена тем же файлом — это заново его загрузить.
    path.unlink(missing_ok=True)

    итог = describe_current()
    return {
        "safety_backup": копия,
        "uploads_moved_to": отъехали.name if отъехали else None,
        "current": итог,
    }


def forget_staged(token: str) -> None:
    """Убрать архив из очереди, не применяя (кнопка «Отменить»)."""
    try:
        _staged_path(token).unlink(missing_ok=True)
    except TransferError:
        pass


def staging_size_bytes() -> int:
    """Сколько сейчас занято очередью — для памятки администратора."""
    if not STAGING_DIR.is_dir():
        return 0
    return sum(p.stat().st_size for p in STAGING_DIR.glob("*.zip"))
