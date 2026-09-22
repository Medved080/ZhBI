"""
Единая матрица пользовательских ОПЕРАЦИЙ V1 → V2 — рабочий список исполнения для переноса функций.

Порождает `Docs/v2-operations-matrix.md` (для людей) и `Docs/v2-operations-matrix.json` (для машинной обработки).
Файлы ГЕНЕРИРУЮТСЯ, руками не правятся: правится источник (backend, `app/static/v2/*`, `screens.json`, шлюз
`write-gate.js`), затем скрипт запускается заново.

Что такое «операция». Строка матрицы — один маршрут backend (метод + путь): это и есть то, что пользователь делает через
интерфейс (открыть список, сохранить, удалить, выгрузить отчёт, скачать файл). К ним добавлены строки «клиентских»
операций, у которых нет своего маршрута (печать, сохранение файла на стороне браузера) — они найдены в JS V1.
Ссылка в V1, заглушка и отключённая кнопка реализованной функцией V2 НЕ считаются.

Источники (везде разбор по синтаксису, не регулярками по тексту):
  * backend: `ast` по всем `app/**/*.py` — декораторы `@app.get/post/patch/put/delete`, `@router.*`, `include_router`,
    фабрики роутеров; права — вызовы `assert_object_feature`, `has_feature`, `require_*`, `Depends(...)` (в том числе через
    вспомогательные функции того же модуля); реестр разделов — `app/features.py`;
  * V1: токенизатор JS из `scripts/inventory_v1_ui.py` по `app/static/app.js` и соседним скриптам — обращения к путям API с
    методом; граф вызовов функций ↔ обработчики меню «Действия», кнопок панели и модальных окон (инвентаризация V1);
  * V2: тот же токенизатор по `app/static/v2/*.js` — `api.get/post/patch/put/delete/upload/readPost/download`, `fetch`;
    пути, заданные настройками экрана, раскрываются по `app/static/v2/screens.json`;
  * шлюз записи: `POLICY` из `app/static/v2/write-gate.js` вычисляется настоящим `node` (модуль импортируется, а не разбирается);
  * реестр экранов `screens.json` — статус (1–6), проверки, операции.

«Опубликовано на 8000» — то, что содержит ветка `--published-ref` (по умолчанию `main`: сервер отдаёт рабочее дерево `main`):
операция опубликована, если в этой ветке И шлюз разрешает её, И интерфейс V2 её вызывает, И маршрут есть в backend.

Запуск:
    .venv/bin/python scripts/gen_v2_operations.py                      # HEAD → Docs/v2-operations-matrix.{md,json}
    .venv/bin/python scripts/gen_v2_operations.py --ref WORKTREE       # брать файлы рабочего дерева (с незакоммиченным)
    .venv/bin/python scripts/gen_v2_operations.py --ref feature/v2-next --published-ref main
    .venv/bin/python scripts/gen_v2_operations.py --check              # только самопроверки, файлы не писать
    .venv/bin/python scripts/gen_v2_operations.py --out /tmp/x         # писать в другой каталог (без правки Docs/)

Самопроверки (итог — в начале документа; падение кодом 1 только у --strict): число маршрутов ast = независимый подсчёт
декораторов токенами `tokenize`; маршруты, не отнесённые к области/разделу; V1-маршруты без экрана; обращения V1/V2 к путям,
которых нет в backend (мёртвые или ошибочные); разделы V1, оставшиеся без операций.
"""
import argparse
import ast
import io
import json
import re
import subprocess
import sys
import tempfile
import tokenize as pytokenize
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inventory_v1_ui as inv  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "Docs"
MD_NAME = "v2-operations-matrix.md"
JSON_NAME = "v2-operations-matrix.json"
BLOCKERS_PATH = ROOT / "Docs" / "v2-progress" / "blockers.json"


def load_blockers():
    """Вручную-курируемый словарь {"МЕТОД путь": причина} — известные блокеры операций (внешняя система/данные
    недоступны в тестовой среде, нужно решение пользователя), собранные из разделов «НЕ сделано»/«Вопросы»
    `Docs/v2-progress/*.md` в `Docs/v2-progress/blockers.json` (читается напрямую с диска, не по `--ref`: список
    открытых вопросов актуален независимо от анализируемой ревизии кода)."""
    if not BLOCKERS_PATH.is_file():
        return {}
    doc = json.loads(BLOCKERS_PATH.read_text(encoding="utf-8"))
    return {k: v for k, v in doc.items() if not k.startswith("_")}


def apply_blocker(op, blockers):
    """Если у операции есть известный блокер и она ещё не реализована (не published/branch/unused/tech) — состояние
    «заблокирована внешним условием» вместо голого «нет в V2»/«только переход в V1»/«отключена шлюзом»: это НЕ
    отсутствие работы, а известное препятствие (см. Docs/v2-progress/blockers.json)."""
    reason = blockers.get(op["id"])
    if not reason or op["v2"]["state"] not in ("only_v1", "none", "gate_disabled"):
        return
    op["blocked_reason"] = reason
    op["v2"]["state"] = "blocked_external"
    op["action"] = f"заблокирована: {reason}"


# Вручную-курируемый словарь {"старый МЕТОД путь": (новый маршрут/операция или None, примечание)} — 2026-09-22,
# аудит по прямому требованию пользователя: «старый API, заменённый безопасным новым API, не означает отсутствие
# пользовательской функции». Старый маршрут матрица раньше числила «только переход в V1»/«заблокирована», хотя
# функция уже перенесена в V2 — либо под ДРУГИМ путём (новый безопасный API), либо ПОД ТЕМ ЖЕ путём, но вызов
# устроен так, что статический разбор (`api.get/post/...` от строкового литерала) его не видит: шаблонный литерал
# с обращением к полю объекта (`${spec.endpoint}`, `${sec.endpoint}`), путь картинки в `<img src>` не через `api.js`.
# Проверено ЖИВЫМ прогоном на настоящем backend (не только чтением кода) — Docs/v2-progress/gaps.md.
# Значение `None` вместо нового пути — «замены нет, это ТОТ ЖЕ маршрут» (просто не увиден статически).
# Старый маршрут НЕ убирается из backend (им пользуется V1) — только не считается отдельным пробелом V2.
REPLACED_BY = {
    "PATCH /elements/{element_id}/status": (
        "POST /element-ops/status-batch",
        "смена статуса ОДНОГО изделия — тот же маршрут, что у пачки (один элемент в списке `items`); безопасный "
        "режим — сервер сверяет ожидаемое состояние, а не «текущий контракт», предпросмотр последствий без записи "
        "(app/element_ops.py: status_batch; write-gate.js: element.status.batch)."),
    "PATCH /elements/bulk-status": (
        "POST /element-ops/status-batch",
        "массовая смена статуса — тот же маршрут, что у одного изделия (список `items` из нескольких элементов, "
        "единое значение статуса на всех); построчная версия с разным контрактом на строку — POST /element-ops/status-rows (app/element_rows.py)."),
    "PATCH /elements/bulk-planned-delivery-date": (
        "POST /element-ops/planned-date-batch",
        "массовая плановая дата — единое значение на всех выбранных изделиях, сверка прежней даты, всё или ничего "
        "(app/element_ops.py: planned_date_batch); построчная версия — POST /element-ops/planned-date-rows (app/element_rows.py)."),
    "PATCH /elements/{element_id}/contract": (
        "POST /element-ops/contract",
        "назначение/смена/снятие контракта БЕЗ смены статуса, со сверкой ожидаемого состояния и стражем остатка "
        "(app/element_ops.py: contract_set; write-gate.js: element.contract.set)."),
    "POST /objects/{object_id}/block-works/bulk-edit/apply": (
        "POST /objects/{object_id}/block-works/bulk-edit/apply-strict",
        "V2 использует более строгий вариант применения — «всё или ничего» со сверкой значений «было», изменившихся "
        "после сверки (app/block_ops.py; write-gate.js: bulk-edit.apply); V1-путь `apply` с другой семантикой (без "
        "«всё или ничего») сохранён сознательно для V1 — распространять ли строгий режим и на него, решения "
        "пользователя нет (mfr2.md; вопрос повторён в Docs/v2-progress/gaps.md)."),
    "КЛИЕНТ app.js:23021": (
        "клиентская операция read-screen.js: printReportTable()",
        "печать отчёта — общий узел печати `print.js` (кнопка «Печать», #rd-print), подключена ПО УМОЛЧАНИЮ на "
        "любом экране группы «Отчёты» (sec.printable !== false); живьём проверены все 10 read-экранов группы, "
        "печать заполняет узел содержимым и вызывает window.print() ровно один раз (scripts/verify_gaps_print.mjs)."),
    "КЛИЕНТ chess-flat.js:660": (
        "клиентская операция chess-flat-screen.js: бланк обхода (кнопка печати, форматы A4/A3)",
        "тот же общий узел печати `print.js`; оба формата бумаги проверены живьём — смена формата на A3 меняет "
        "класс листа в предпросмотре И в узле печати (scripts/verify_mfr2_browser.mjs)."),
    "POST /settings/import": (
        "POST /settings/import/analyze + POST /settings/import/apply",
        "V2 использует НОВЫЙ двухфазный безопасный вход: сверка (ничего не пишет) → применение по сверенному "
        "sha256-digest, одна транзакция, копия базы перед применением, 409 при подмене файла/базы после сверки "
        "(app/settings_import.py; write-gate.js: settings.analyze/settings.apply); старый одношаговый "
        "`POST /settings/import` сохранён для V1 (поведение не менялось, там же добавлена атомарность записи), "
        "но интерфейс V2 его не вызывает — exchange-settings.js вызывает только .../analyze и .../apply."),
    "POST /reports/delivery-schedule/cell": (
        None,
        "тот же маршрут уже вызывается из V2 (app/static/v2/reports-exchange.js — атрибут `data-gkeys` кликабельной "
        "ячейки листовой строки; app/static/v2/read-screen.js — обработчик клика, `api.readPost(`${sec.endpoint}/cell`, ...)`); "
        "живьём проверено: щелчок по развёрнутой ячейке шлёт запрос и открывает диалог разбора по маркам "
        "(разовая проверка сессии, не сохранена файлом). Генератор не разобрал вызов — путь собран из поля объекта "
        "(`sec.endpoint`), а не строкового литерала."),
    "GET /zones": (
        None,
        "тот же маршрут уже вызывается из V2 (app/static/v2/zones-edit.js: `api.get(`${spec.endpoint}?${q}`)`, "
        "`spec.endpoint` — значение из screens.json: `screen.zones.endpoint == \"/zones\"`); живьём проверено — "
        "экран «Зоны» получает 200 и показывает список (разовая проверка сессии, не сохранена файлом). Генератор раскрывает путь из "
        "screens.json только для модуля read-screen.js, для zones-edit.js — нет."),
    "GET /objects/{object_id}/avatar": (
        None,
        "тот же маршрут уже вызывается из V2, но не через api.js — прямая вставка `<img src=\"/objects/${id}/avatar?t=...\">` "
        "(app/static/v2/projects-objects.js: renderAvatar(), вкладка «Вложения» карточки объекта, при "
        "rec.has_avatar); генератор ищет только вызовы api.*()/fetch(), обычный `<img src>` не видит. Само "
        "назначение/снятие превью (PUT .../avatar) уже опубликовано (write-gate.js: objects.avatar)."),
    "GET /objects/{object_id}/work-progress": (
        "POST /reports/block-status",
        "«бывшая вкладка «Статусы» «Учёта по блокам», перенесённая в «Отчёты»» (дословно докстринг "
        "app/main.py:report_block_status) — тот же источник (work_progress_mod.matrix через "
        "block_works.status_report_with_deadlines), с добавлением срока по блоку; экран «report-block-status» "
        "опубликован и печать/правка ячейки проверены живьём (scripts/verify_gaps_print.mjs, "
        "scripts/verify_mfr2_browser.mjs). Правка значения — ТОТ ЖЕ маршрут, что был у старой вкладки "
        "(PUT /objects/{id}/work-progress/cell, без переноса в /reports/*), поэтому отдельным пробелом не числится."),
    "GET /objects/{object_id}/blocks/fact-changes": (
        "GET /objects/{object_id}/fact-journal",
        "«Журнал факта» (app/main.py, докстринг над block_work_types_endpoint) — «прямой доступ к документам "
        "work_fact_reports ВСЕГО объекта, без предварительного поиска блока/работы» — явный преемник старой сводки "
        "изменений факта (нужны были date_from/date_to/track_code ДО просмотра); экран `fact-journal` опубликован "
        "(матрица: статус 5, 7 операций)."),
    "POST /marks": (
        None,
        "тот же маршрут уже вызывается из V2 (app/static/v2/subtypes-edit.js: `api.post(markSpec.endpoint, ...)`, "
        "`markSpec.endpoint` — значение из screens.json: `screen.marks.endpoint == \"/marks\"`), строка шлюза "
        "`mark.create` разрешена (write-gate.js); живьём проверено — реальный ввод названия и клик «Добавить» "
        "создали запись в БД (одноразовая проверка сессии, экран «Типы, подтипы и марки элементов»)."),
    "PATCH /marks/{mark_id}": (
        None,
        "тот же маршрут уже вызывается из V2 (app/static/v2/subtypes-edit.js: `api.patch(`${markSpec.endpoint}/${mark.id}`, ...)` "
        "по уходу фокуса из поля названия, с диалогом-подтверждением плана последствий — сколько изделий и позиций "
        "контрактов затронет), строка шлюза `mark.rename` разрешена; живьём проверено — реальное редактирование поля, "
        "подтверждение диалога, новое имя в БД (одноразовая проверка сессии). Удаление с заменой ссылок — "
        "`POST /dictionaries/mark/{id}/delete` (строка `mark.delete`) — уже опубликовано (published) и в матрицу "
        "пробелом не попадало."),
    "GET /counterparties/full": (
        None,
        "функция (каскадные списки в форме контракта) достигнута ДРУГИМ способом: V2 строит каскад отдельными "
        "ленивыми запросами по выбору (app/static/v2/contracts-list.js: `GET /agreements?counterparty_id=…` → "
        "`GET /specifications?agreement_id=…`), а не одним вложенным деревом, как V1. Осознанная архитектурная "
        "разница, не пробел: у пользователя тот же результат (выбор договора сужает список спецификаций)."),
    "КЛИЕНТ app.js:16577": (
        "клиентская операция admin-guide-view.js: копирование одной команды",
        "кнопка «Копировать» у каждой команды памятки (data-copy) — тот же запасной путь через скрытое поле и "
        "execCommand, что в V1 (navigator.clipboard требует HTTPS/localhost, сервис часто работает по HTTP); "
        "живьём проверено — реальный клик поместил текст команды в буфер обмена браузера (Browser.grantPermissions "
        "+ navigator.clipboard.readText)."),
    "КЛИЕНТ app.js:16578": (
        "клиентская операция admin-guide-view.js: копирование всей памятки",
        "кнопки «Копировать» не хватало только для памятки ЦЕЛИКОМ (скачивание .md уже было) — добавлена кнопка "
        "«Копировать всю памятку» (2026-09-22), тот же приём (fetch .md → copyText). Живьём проверено — буфер "
        "обмена получил все 12099 символов текста памятки после клика."),
    "GET /map/tiles/{name}": (
        None,
        "тот же маршрут уже вызывается из V2 (2026-09-22) — экран «Проекты и объекты» (app/static/v2/"
        "projects-objects.js: mountAddressAndMap, `#po-pin-map`) динамически подключает ТОТ ЖЕ ES-модуль V1, что "
        "адресный классификатор (`import(\"/static/map.js\")`, тот же приём, что у address.js — см. docstring "
        "модуля), и строит мини-карту с пином объекта на каждое открытие карточки проекта/объекта. Файл подложки "
        "запрашивается MapLibre-протоколом `pmtiles://` (app/static/map.js: `url: \"pmtiles://\" + b.url`), а "
        "`b.url` — строка `\"/map/tiles/\" + имя`, пришедшая с сервера через `GET /map/config` (`basemaps()`), а "
        "не литерал в исходнике V2 — генератор ищет только литеральные пути в `api.*()`/`fetch()`, собранный из "
        "переменной путь (как markSpec.endpoint/sec.endpoint выше) не видит. Живьём проверено "
        "(scripts/verify_gaps2_map_tiles.mjs, headless Chrome с программным WebGL — `--use-angle=swiftshader`, "
        "иначе MapLibre не создаёт контекст в безголовом браузере и до сетевого запроса не доходит): открытие "
        "карточки объекта даёт `GET /map/config` (200) и несколько `GET /map/tiles/basemap-ru.pmtiles` (206, "
        "частичный контент — Range, как и описывает докстринг маршрута) от РЕАЛЬНОГО файла подложки. Своей "
        "подложки в V2 заводить не пришлось — используется файл сервера как есть."),
    "GET /objects/{object_id}/blocks/track-progress": (
        None,
        "тот же маршрут уже вызывается из V2 (2026-09-22) — но НЕ прямым `api.get()` в файле V2: рабочее место "
        "«Модель МФР» (app/static/v2/workspace.js) держит сцену V1 в кадре `?embed=scene` — сознательная "
        "архитектура («сцену рисует движок V1, всё остальное — шапка/панели/запись — оболочка V2», см. docstring "
        "workspace.js), НЕ «переход в V1». Правая панель «Вид» (app/static/v2/mfr-block-panel.js: viewHtml/bind, "
        "переключатель `data-mbp-c=\"mode\"` «по выполнению» / «по срокам») — настоящий элемент управления V2; "
        "переключение шлёт кадру команду моста `mfrChess` (протокол zhbi-scene/1), а кадр (app/static/app.js: "
        "selectMfrChessTrack) сам делает `GET .../blocks/track-progress?track_code=`. Генератор ищет только "
        "вызовы `api.*()` внутри `app/static/v2/*.js` — вызов через мост в чужом файле не видит. Живьём проверено "
        "(scripts/verify_gaps2_track_progress.mjs): выбор доски и переключение радиокнопки на «по срокам» дают "
        "ровно один GET-запрос 200 к track-progress, легенда сменяется на подписи DEADLINE (в графике/отстаёт/"
        "просрочена/не начата в срок/без сроков)."),
}


def apply_replacement(op):
    """Если у операции есть запись в REPLACED_BY и она ещё «только переход в V1» — состояние `replaced`: функция
    ДЕЙСТВИТЕЛЬНО перенесена (под тем же или под другим путём), просто это не увидел статический разбор или это
    сознательно другой безопасный маршрут. Старый маршрут не считается отдельным пробелом (см. REPLACED_BY)."""
    info = REPLACED_BY.get(op["id"])
    if not info or op["v2"]["state"] != "only_v1":
        return
    new_id, note = info
    op["replaced_by"] = {"by": new_id, "note": note}
    op["v2"]["state"] = "replaced"
    op["action"] = (f"перенесена: {note}" if not new_id else f"заменена на `{new_id}`: {note}")


HTTP = ("get", "post", "patch", "put", "delete", "head", "options")


# ======================================================================================================================
# Источник файлов: рабочее дерево или ревизия git
# ======================================================================================================================
class Source:
    """Читает файлы либо с диска (`WORKTREE`), либо из ревизии git (`git show ref:path`) — так «опубликованное» (main) и
    «текущее» (ветка) анализируются одним и тем же кодом."""

    def __init__(self, ref):
        self.ref = ref
        self.fs = ref == "WORKTREE"
        self._cache = {}
        self._tree = None
        if not self.fs:
            p = self._git("rev-parse", "--verify", "--quiet", ref + "^{commit}")
            if p.returncode != 0:
                sys.exit(f"ревизия «{ref}» не найдена в репозитории {ROOT}")
            self.commit = p.stdout.decode().strip()
        else:
            self.commit = None

    def _git(self, *args):
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True)

    def read(self, rel):
        if rel in self._cache:
            return self._cache[rel]
        if self.fs:
            p = ROOT / rel
            txt = p.read_text(encoding="utf-8") if p.is_file() else None
        else:
            r = self._git("show", f"{self.ref}:{rel}")
            txt = r.stdout.decode("utf-8") if r.returncode == 0 else None
        self._cache[rel] = txt
        return txt

    def files(self, prefix, suffix=""):
        """Пути файлов под каталогом `prefix` (относительно корня репозитория), отсортированные."""
        if self.fs:
            base = ROOT / prefix
            out = [str(p.relative_to(ROOT)) for p in base.rglob("*") if p.is_file() and p.name.endswith(suffix)
                   and "__pycache__" not in p.parts]
        else:
            if self._tree is None:
                self._tree = self._git("ls-tree", "-r", "--name-only", self.ref).stdout.decode("utf-8").splitlines()
            out = [p for p in self._tree if p.startswith(prefix.rstrip("/") + "/") and p.endswith(suffix)
                   and "__pycache__" not in p]
        return sorted(out)

    def dirty(self):
        """Незакоммиченные изменения отслеживаемых файлов кода: анализ HEAD их не видит."""
        if self.fs:
            return []
        r = self._git("status", "--porcelain", "--untracked-files=no", "--", "app", "scripts")
        return [ln[3:] for ln in r.stdout.decode("utf-8").splitlines()]

    def label(self):
        if self.fs:
            br = self._git("rev-parse", "--abbrev-ref", "HEAD").stdout.decode().strip()
            return f"рабочее дерево ветки {br}"
        return f"{self.ref}@{self.commit[:7]}"

    def short(self):
        if self.fs:
            return "WORKTREE"
        return f"{self.ref}@{self.commit[:7]}"


# ======================================================================================================================
# Backend: маршруты, права
# ======================================================================================================================
PERM_FUNCS = {
    # требования (отказ 403/404, если условие не выполнено)
    "assert_object_feature": "требуется", "assert_feature": "требуется", "assert_object_any_feature": "требуется",
    "assert_object_access": "требуется", "require_feature": "требуется", "require_any_feature": "требуется",
    "require_service_feature": "требуется", "require_system_admin": "требуется",
    # условные проверки (ветвление по праву)
    "has_feature": "условно", "has_any_feature": "условно", "has_object_access": "условно", "is_system_admin": "условно",
    "has_contracting_rights": "условно", "feature_level_for": "условно",
}
ANY_KEYS_FUNCS = {"assert_object_any_feature", "has_any_feature", "require_any_feature"}
# Локальные обёртки над проверками (`_guard_elements(conn, user, ids, "status", "write")`, `_guard_report(…, "report_status")`):
# считаются проверкой прав, если по имени похожи на проверку И в аргументах есть ключ раздела из реестра.
GENERIC_PERM_NAME = re.compile(r"guard|assert|require|check|allowed|access|permission|(^|_)can_", re.I)
LEVELS = {"read": "чтение", "write": "изменение", "READ": "чтение", "WRITE": "изменение"}


def parse_features(text):
    """Реестр разделов прав `app/features.py`: {ключ: {section, title, scope}} — по AST списка `FEATURES`."""
    out = {}
    if not text:
        return out
    tree = ast.parse(text)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Feature" and len(node.args) >= 3:
            a = node.args
            if all(isinstance(x, ast.Constant) and isinstance(x.value, str) for x in a[:3]):
                scope = a[5].id if len(a) > 5 and isinstance(a[5], ast.Name) else None
                out[a[0].value] = {"section": a[1].value, "title": a[2].value, "scope": scope}
    return out


class Module:
    """Один разобранный `app/**/*.py`: функции, константы, импорты, роутеры, маршруты."""

    def __init__(self, rel, text):
        self.rel = rel
        self.name = rel[:-3].replace("/", ".")
        if self.name.endswith(".__init__"):
            self.name = self.name[:-9]
        self.tree = ast.parse(text)
        self.consts = {}      # NAME = "строка" (верхний уровень)
        self.funcs = {}       # имя → FunctionDef (верхний уровень и вложенные, первое вхождение)
        self.imports = {}     # алиас → (модуль, имя)
        self.routers = {}     # (область, переменная) → {"prefix": str, "app": bool}
        self.routes = []      # разобранные декораторы
        self.includes = []    # (получатель (область, имя), аргумент выражением, prefix)
        self.factory_calls = {}   # (область, переменная) → (имя функции-фабрики, узел вызова)
        self.perm_aliases = {}    # NAME = require_service_feature("k","write") на верхнем уровне (готовые зависимости)
        self.dict_consts = {}     # NAME = {"вид": "значение", …} на верхнем уровне (например, KIND_FEATURES)
        self.list_consts = {}     # NAME = ("a", "b") / ["a", "b"] на верхнем уровне (например, DOC_FEATURES)
        self._collect()

    def _collect(self):
        for node in self.tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) \
                    and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                self.consts[node.targets[0].id] = node.value.value
            elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) \
                    and isinstance(node.value, ast.Call) and getattr(node.value.func, "id", None) in PERM_FUNCS:
                self.perm_aliases[node.targets[0].id] = node.value
            elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) \
                    and isinstance(node.value, (ast.Tuple, ast.List)):
                self.list_consts[node.targets[0].id] = [e.value for e in node.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
            elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) \
                    and isinstance(node.value, ast.Dict):
                self.dict_consts[node.targets[0].id] = [v.value for v in node.value.values
                                                        if isinstance(v, ast.Constant) and isinstance(v.value, str)]
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.funcs.setdefault(node.name, node)
            elif isinstance(node, ast.ImportFrom) and node.module:
                for al in node.names:
                    self.imports[al.asname or al.name] = (node.module, al.name)
        # область видимости для роутеров/маршрутов: "" — модуль, иначе имя функции верхнего уровня, внутри которой объявлено
        self._walk_scope(self.tree.body, "")

    def _resolve_str(self, node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            return self.consts.get(node.id)
        if isinstance(node, ast.JoinedStr):
            return None
        return None

    def _walk_scope(self, body, scope):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._scan_function_decorators(node, scope)
                inner = scope or node.name
                self._walk_scope(node.body, inner)
                continue
            if isinstance(node, ast.ClassDef):
                self._walk_scope(node.body, scope)
                continue
            for n in ast.walk(node):
                if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Call):
                    fn = n.value.func
                    fname = fn.id if isinstance(fn, ast.Name) else fn.attr if isinstance(fn, ast.Attribute) else None
                    var = n.targets[0].id
                    if fname == "APIRouter":
                        prefix = ""
                        for kw in n.value.keywords:
                            if kw.arg == "prefix":
                                prefix = self._resolve_str(kw.value) or ""
                        self.routers[(scope, var)] = {"prefix": prefix, "app": False}
                    elif fname == "FastAPI":
                        self.routers[(scope, var)] = {"prefix": "", "app": True}
                    elif fname and (fname in self.imports or fname in self.funcs) and fname != "Depends":
                        self.factory_calls[(scope, var)] = (fname, n.value)
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "include_router" and n.args:
                    prefix = ""
                    for kw in n.keywords:
                        if kw.arg == "prefix":
                            prefix = self._resolve_str(kw.value) or ""
                    recv = n.func.value.id if isinstance(n.func.value, ast.Name) else None
                    self.includes.append(((scope, recv), n.args[0], prefix))

    def _scan_function_decorators(self, fn, scope):
        for d in fn.decorator_list:
            if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and isinstance(d.func.value, ast.Name) \
                    and (d.func.attr in HTTP or d.func.attr == "api_route"):
                methods = [d.func.attr.upper()]
                if d.func.attr == "api_route":
                    methods = []
                    for kw in d.keywords:
                        if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)):
                            methods = [e.value.upper() for e in kw.value.elts if isinstance(e, ast.Constant)]
                path = self._resolve_str(d.args[0]) if d.args else None
                for m in methods:
                    self.routes.append({"scope": scope, "var": d.func.value.id, "method": m, "path": path, "fn": fn, "deco": d})


def decorator_count_by_tokens(text):
    """Независимый подсчёт: модуль `tokenize` (не AST) — сколько раз встречается `@<имя>.<get|post|…>(` в начале строки."""
    n = 0
    toks = list(pytokenize.generate_tokens(io.StringIO(text).readline))
    for i, t in enumerate(toks):
        if t.type == pytokenize.OP and t.string == "@" and i + 4 < len(toks):
            a, dot, b, par = toks[i + 1], toks[i + 2], toks[i + 3], toks[i + 4]
            if a.type == pytokenize.NAME and dot.string == "." and b.type == pytokenize.NAME and par.string == "(" \
                    and (b.string in HTTP or b.string == "api_route"):
                n += 1
    return n


def _const_str(node, mod):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in mod.consts:
            return mod.consts[node.id]
        if node.id in LEVELS:
            return LEVELS[node.id] and node.id.lower()
        imp = mod.imports.get(node.id)
        if imp and imp[1] in ("READ", "WRITE"):
            return imp[1].lower()
    return None


def _first_line(doc):
    if not doc:
        return ""
    line = doc.strip().splitlines()[0].strip()
    return line


ABBR = {"см", "т", "д", "п", "пп", "напр", "рис", "стр", "табл", "ср", "др", "проч", "им", "ул", "г", "гг", "и", "е", "ч", "св", "вкл", "мин", "макс", "прим"}


def _doc_summary(doc):
    """Первое законченное предложение первого абзаца докстринга (без разрыва на «см.», «т.е.», датах и номерах пунктов)."""
    if not doc:
        return ""
    para = []
    for ln in doc.strip().splitlines():
        if not ln.strip():
            break
        para.append(ln.strip())
    txt = " ".join(para)
    out, start = "", 0
    for m in re.finditer(r"[.!?…]\s+(?=[А-ЯЁA-Z«\"(])", txt):
        piece = txt[start:m.end()].strip()
        last_word = re.findall(r"([А-Яа-яЁёA-Za-z]+)\.$", txt[start:m.start() + 1])
        if last_word and last_word[-1].lower() in ABBR:
            continue
        if len(piece) < 25:
            continue
        out = piece
        break
    if not out:
        out = txt
    return out[:260]


def collect_perms(mod, fn, modules, feats, depth=3, seen=None, binds=None):
    """Права, которые проверяет обработчик: зависимости в декораторе/параметрах и вызовы проверок в теле — в том числе в
    вспомогательных функциях этого же модуля и импортированных из `app.*` (не глубже `depth` звеньев).

    Возвращает список {func, keys, level, mode (требуется/условно), via}."""
    seen = seen if seen is not None else set()
    binds = binds or {}
    out = []
    key = (mod.rel, fn.name)
    if key in seen:
        return out
    seen.add(key)

    def from_call(call, via, mod=mod):
        name = call.func.id if isinstance(call.func, ast.Name) else call.func.attr if isinstance(call.func, ast.Attribute) else None
        generic = name not in PERM_FUNCS and bool(name) and bool(GENERIC_PERM_NAME.search(name))
        if name in PERM_FUNCS or generic:
            keys, level = [], None
            for a in list(call.args) + [kw.value for kw in call.keywords]:
                if isinstance(a, (ast.List, ast.Tuple)):
                    for e in a.elts:
                        s = _const_str(e, mod)
                        if s in feats:
                            keys.append(s)
                    continue
                if isinstance(a, ast.Name) and a.id in mod.list_consts:
                    keys += [v for v in mod.list_consts[a.id] if v in feats]
                    continue
                if isinstance(a, ast.Call) and isinstance(a.func, ast.Name) and a.func.id in mod.funcs:
                    # ключ раздела выбирается функцией по словарю модуля (`_раздел(kind)` → KIND_FEATURES[kind])
                    for sub in ast.walk(mod.funcs[a.func.id]):
                        if isinstance(sub, ast.Subscript) and isinstance(sub.value, ast.Name) and sub.value.id in mod.dict_consts:
                            keys += [v for v in mod.dict_consts[sub.value.id] if v in feats]
                    continue
                s = _const_str(a, mod)
                if s in feats:
                    keys.append(s)
                elif s in ("read", "write"):
                    level = s
            if generic:
                if not keys:
                    return False
                out.append({"func": name, "keys": list(dict.fromkeys(keys)), "level": level or "read", "mode": "требуется", "via": via})
                return True
            if name in ("require_system_admin", "is_system_admin"):
                out.append({"func": name, "keys": [], "level": None, "mode": PERM_FUNCS[name], "via": via})
            elif name in ("assert_object_access", "has_object_access"):
                out.append({"func": name, "keys": [], "level": "access", "mode": PERM_FUNCS[name], "via": via})
            elif name == "has_contracting_rights":
                out.append({"func": name, "keys": ["counterparties"], "level": "write", "mode": PERM_FUNCS[name], "via": via})
            else:
                out.append({"func": name, "keys": keys, "level": level, "mode": PERM_FUNCS[name], "via": via,
                            "unresolved": not keys})
            return True
        return False

    # зависимости: `Depends(require_feature("k","write"))` в значениях по умолчанию параметров и в `dependencies=[…]` декоратора
    dep_nodes = list(fn.args.defaults) + [d for d in fn.args.kw_defaults if d is not None]
    for d in fn.decorator_list:
        if isinstance(d, ast.Call):
            for kw in d.keywords:
                if kw.arg == "dependencies":
                    dep_nodes.append(kw.value)
    for dn in dep_nodes:
        for c in ast.walk(dn):
            if isinstance(c, ast.Call):
                fname = c.func.id if isinstance(c.func, ast.Name) else None
                if fname == "Depends" and c.args:
                    a0 = c.args[0]
                    if isinstance(a0, ast.Call):
                        from_call(a0, "Depends")
                    elif isinstance(a0, ast.Name):
                        target = binds.get(a0.id, (mod, a0.id))   # параметр фабрики роутера → то, что передал хозяин
                        tmod, tname = target
                        alias = tmod.perm_aliases.get(tname)
                        if alias is None and tname in tmod.imports:
                            am = modules.get(tmod.imports[tname][0])
                            if am is not None and tmod.imports[tname][1] in am.perm_aliases:
                                alias, tmod = am.perm_aliases[tmod.imports[tname][1]], am
                        if alias is not None:
                            from_call(alias, "Depends", tmod)
                            continue
                        if tname == "get_current_user":
                            out.append({"func": "get_current_user", "keys": [], "level": None, "mode": "требуется", "via": "Depends"})
                        elif tname == "require_system_admin":
                            out.append({"func": "require_system_admin", "keys": [], "level": None, "mode": "требуется", "via": "Depends"})
                        elif tname in tmod.funcs and depth > 0:
                            out += collect_perms(tmod, tmod.funcs[tname], modules, feats, depth - 1, seen, binds)
    # проверка системной роли прямо в коде: `user["role"] != "admin"` / `== "admin"`
    for c in ast.walk(fn):
        if isinstance(c, ast.Compare):
            parts = [c.left] + list(c.comparators)
            has_role = any(isinstance(x, ast.Subscript) and isinstance(x.slice, ast.Constant) and x.slice.value == "role" for x in parts)
            has_admin = any(isinstance(x, ast.Constant) and x.value == "admin" for x in parts)
            if has_role and has_admin:
                out.append({"func": "role", "keys": [], "level": None, "mode": "требуется", "via": "тело"})
                break
    # тело
    for c in ast.walk(fn):
        if isinstance(c, ast.Call):
            if from_call(c, "тело" if depth == 3 else f"через {fn.name}"):
                continue
            # переход во вспомогательную функцию
            if depth > 0 and isinstance(c.func, ast.Name):
                callee = c.func.id
                if callee in binds and binds[callee][1] in binds[callee][0].funcs:
                    bm, bn = binds[callee]
                    out += collect_perms(bm, bm.funcs[bn], modules, feats, depth - 1, seen, binds)
                elif callee in mod.funcs and callee != fn.name:
                    out += collect_perms(mod, mod.funcs[callee], modules, feats, depth - 1, seen, binds)
                elif callee in mod.imports:
                    m2, n2 = mod.imports[callee]
                    mm = modules.get(m2)
                    if mm and n2 in mm.funcs and depth > 1:
                        out += collect_perms(mm, mm.funcs[n2], modules, feats, depth - 2, seen)
    return out


def perm_text(perms, feats):
    """Человекочитаемое описание прав + краткий машинный вид."""
    if not perms:
        return "", []
    items, seen = [], set()
    has_auth = any(p["func"] == "get_current_user" for p in perms)
    for p in perms:
        if p["func"] == "get_current_user":
            continue
        if p["func"] == "role":
            t = "системная роль admin (проверка в коде; может допускать и «свою запись»)"
        elif p["func"] in ("require_system_admin", "is_system_admin"):
            t = "администратор сервиса" + (" (условно)" if p["mode"] == "условно" else "")
        elif p["level"] == "access":
            t = "доступ к объекту" + (" (условно)" if p["mode"] == "условно" else "")
        else:
            names = ", ".join(f"«{feats.get(k, {}).get('title', k)}»" for k in p["keys"]) or "раздел не определён"
            lvl = LEVELS.get(p["level"], p["level"] or "уровень по условию")
            t = f"{names}: {lvl}" + (" (условно)" if p["mode"] == "условно" else "")
        if t not in seen:
            seen.add(t)
            items.append(t)
    if not items and has_auth:
        items = ["любой вошедший пользователь"]
    return "; ".join(items), items


def build_module_graph(src):
    files = src.files("app", ".py")
    modules = {}
    for rel in files:
        txt = src.read(rel)
        if txt is None:
            continue
        try:
            m = Module(rel, txt)
        except SyntaxError as e:
            sys.exit(f"{rel}: синтаксическая ошибка {e}")
        modules[m.name] = m
    return modules, files


def factory_binds(modules, fm, scope):
    """Роутер, объявленный внутри функции-фабрики (`build_router(*, get_user, assert_access, …)`): её параметры — это то,
    что передал вызывающий модуль (`router = build_router(get_user=get_current_user, assert_access=assert_access)`).
    Возвращает {имя параметра: (модуль хозяина, имя функции хозяина)}."""
    if not scope:
        return {}
    out = {}
    for hm in modules.values():
        for (_sc, _var), (fname, call) in hm.factory_calls.items():
            imp = hm.imports.get(fname)
            target_mod, target_name = (modules.get(imp[0]), imp[1]) if imp else (hm, fname)
            if target_mod is fm and target_name == scope:
                for kw in call.keywords:
                    if kw.arg and isinstance(kw.value, ast.Name):
                        out[kw.arg] = (hm, kw.value.id)
    return out


def scan_backend(src):
    """Все маршруты backend с учётом `include_router` и фабрик роутеров; права; независимый подсчёт декораторов."""
    modules, files = build_module_graph(src)
    feats = parse_features(src.read("app/features.py"))
    # независимый подсчёт декораторов (tokenize)
    indep = sum(decorator_count_by_tokens(src.read(rel)) for rel in files)
    ast_total = sum(len(m.routes) for m in modules.values())

    # --- роутеры → живые с префиксом: обходим от `app` в `app.main`
    def resolve_router_ref(mod, expr, scope):
        """Выражение из include_router → (модуль, область, переменная) роутера."""
        if isinstance(expr, ast.Name):
            nm = expr.id
            if (scope, nm) in mod.routers or ("", nm) in mod.routers:
                return (mod.name, scope if (scope, nm) in mod.routers else "", nm)
            imp = mod.imports.get(nm)
            if imp:
                m2, n2 = imp
                mm = modules.get(m2)
                if mm:
                    return follow_alias(mm, "", n2)
        if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
            imp = mod.imports.get(expr.value.id)
            return None
        return None

    def follow_alias(mm, scope, var):
        """Переменная модуля может быть результатом фабрики (`router = build_router(...)`)."""
        if (scope, var) in mm.routers:
            return (mm.name, scope, var)
        fac = mm.factory_calls.get((scope, var))
        if fac:
            fac = fac[0]
            imp = mm.imports.get(fac)
            fm, fname = (modules.get(imp[0]), imp[1]) if imp else (mm, fac)
            if fm and fname in fm.funcs:
                # роутеры, объявленные внутри функции-фабрики: одна переменная-роутер в области `fname`
                cands = [k for k in fm.routers if k[0] == fname]
                if cands:
                    return (fm.name, fname, cands[0][1])
        return None

    live = {}   # id роутера → префикс, накопленный от app
    main = modules.get("app.main")
    queue = []
    if main:
        for (scope, var), info in main.routers.items():
            if info["app"]:
                live[(main.name, scope, var)] = ""
                queue.append((main.name, scope, var))
    # рёбра include
    edges = defaultdict(list)   # получатель → [(роутер, prefix)]
    for m in modules.values():
        for (rscope, rvar), expr, prefix in m.includes:
            target = resolve_router_ref(m, expr, rscope)
            recv = (m.name, rscope, rvar)
            if target:
                edges[recv].append((target, prefix))
    while queue:
        cur = queue.pop()
        for target, prefix in edges.get(cur, []):
            if target not in live:
                live[target] = live[cur] + prefix
                queue.append(target)

    routes = []
    for m in modules.values():
        for r in m.routes:
            rid = (m.name, r["scope"], r["var"])
            info = m.routers.get((r["scope"], r["var"]), {"prefix": "", "app": False})
            base = live.get(rid)
            is_live = base is not None
            base = base or ""
            rp = "" if info["app"] else info["prefix"]
            path = (base + rp + (r["path"] or "")) or "/"
            fn = r["fn"]
            binds = factory_binds(modules, m, r["scope"])
            perms = collect_perms(m, fn, modules, feats, binds=binds)
            ptxt, pitems = perm_text(perms, feats)
            doc = ast.get_docstring(fn) or ""
            kw = {k.arg: ast.unparse(k.value) for k in r["deco"].keywords}
            routes.append({
                "method": r["method"], "path": path, "file": m.rel, "line": fn.lineno, "func": fn.name,
                "doc": _doc_summary(doc), "doc_full_first": _first_line(doc), "live": is_live,
                "perms": perms, "perm_text": ptxt, "perm_items": pitems,
                "response_class": kw.get("response_class"), "include_in_schema": kw.get("include_in_schema"),
                "feature_keys": sorted({k for p in perms for k in p["keys"]}),
            })
    routes.sort(key=lambda r: (r["path"], r["method"]))
    return {"routes": routes, "ast_total": ast_total, "indep_total": indep, "feats": feats,
            "unincluded": sorted({f"{k[0]}:{k[2]}" for k in {(m.name, r["scope"], r["var"]) for m in modules.values() for r in m.routes} if k not in live})}


# ======================================================================================================================
# JS: границы функций, вызовы API, граф вызовов (токенизатор inventory_v1_ui)
# ======================================================================================================================
def _t(toks, i):
    return toks[i] if 0 <= i < len(toks) else ("p", "", 0)


def _expr_end(toks, a):
    """Конец выражения-тела стрелочной функции: `;` или закрывающая скобка на нулевой глубине (не дальше 400 токенов)."""
    depth = 0
    for j in range(a, min(len(toks), a + 400)):
        k, v, _ = toks[j]
        if k == "p":
            if v in ("(", "[", "{"):
                depth += 1
            elif v in (")", "]", "}"):
                if depth == 0:
                    return j
                depth -= 1
            elif v in (";",) and depth == 0:
                return j
    return min(len(toks) - 1, a + 400)


def _parse_params(toks, po, pc):
    """Имена параметров верхнего уровня в `(...)` [po, pc] (индексы скобок): по положению (первый идентификатор
    верхнего уровня до следующей запятой) — умолчания (`x = 1`) берут имя `x`; деструктуризация/rest — `None`
    (позиция сохраняется, чтобы не сбить нумерацию, резолвер её просто не свяжет)."""
    params, cur, complex_, depth = [], None, False, 0
    for i in range(po + 1, pc):
        k, v, _ = toks[i]
        if k == "p" and v in ("(", "[", "{"):
            if depth == 0 and v in ("[", "{"):
                complex_ = True
            depth += 1
        elif k == "p" and v in (")", "]", "}"):
            depth -= 1
        elif depth == 0:
            if k == "id" and cur is None and not complex_:
                cur = v
            elif k == "p" and v == ",":
                params.append(None if complex_ else cur)
                cur, complex_ = None, False
    params.append(None if complex_ else cur)
    return params


def js_functions(toks):
    """Именованные функции файла с телом в фигурных скобках: `function f(`, `f = function(`, `f = (…) => {`, `f = async x => {`.
    Возвращает список [имя, начало, конец, индекс токена-имени, параметры]; вложенные функции — отдельными записями."""
    out = []
    n = len(toks)
    for i, (k, v, ln) in enumerate(toks):
        if k == "id" and v == "function":
            j = i + 1
            if _t(toks, j)[1] == "*":
                j += 1
            name = None
            if _t(toks, j)[0] == "id":
                name, j = toks[j][1], j + 1
            elif i >= 2 and toks[i - 1][1] in ("=",) and toks[i - 2][0] == "id":
                name = toks[i - 2][1]
            elif i >= 3 and toks[i - 1][1] == "async" and toks[i - 2][1] == "=" and toks[i - 3][0] == "id":
                name = toks[i - 3][1]
            if name and _t(toks, j)[1] == "(":
                e = inv.match_paren(toks, j)
                if _t(toks, e + 1)[1] == "{":
                    out.append([name, e + 1, inv.match_brace(toks, e + 1), i, _parse_params(toks, j, e)])
        elif k == "id" and _t(toks, i + 1)[1] == "=" and v not in ("const", "let", "var"):
            j = i + 2
            if _t(toks, j)[1] == "async":
                j += 1
            if _t(toks, j)[1] == "(":
                e = inv.match_paren(toks, j)
                if _t(toks, e + 1)[1] == "=>":
                    params = _parse_params(toks, j, e)
                    if _t(toks, e + 2)[1] == "{":
                        out.append([v, e + 2, inv.match_brace(toks, e + 2), i, params])
                    else:
                        out.append([v, e + 2, _expr_end(toks, e + 2), i, params])
            elif _t(toks, j)[0] == "id" and _t(toks, j + 1)[1] == "=>":
                params = [toks[j][1]]
                if _t(toks, j + 2)[1] == "{":
                    out.append([v, j + 2, inv.match_brace(toks, j + 2), i, params])
                else:
                    out.append([v, j + 2, _expr_end(toks, j + 2), i, params])
    return out


def innermost_owner(nfun, funs, ntoks):
    """owner[i] — индекс самой внутренней именованной функции, в чьём теле лежит токен i (или -1)."""
    owner = [-1] * ntoks
    order = sorted(range(nfun), key=lambda x: (funs[x][1], -funs[x][2]))
    stack = []
    p = 0
    for i in range(ntoks):
        while stack and funs[stack[-1]][2] < i:
            stack.pop()
        while p < len(order) and funs[order[p]][1] <= i:
            if funs[order[p]][2] >= i:
                stack.append(order[p])
            p += 1
        owner[i] = stack[-1] if stack else -1
    return owner


def enclosing_calls(toks, i, limit=700):
    """От токена i наружу: (имя вызываемого, индекс «(», индекс «)») для каждой охватывающей круглой скобки-вызова."""
    depth = 0
    j = i - 1
    lo = max(0, i - limit)
    while j >= lo:
        k, v, _ = toks[j]
        if k == "p":
            if v in (")", "]", "}"):
                depth += 1
            elif v in ("(", "[", "{"):
                if depth == 0:
                    if v == "(":
                        callee = toks[j - 1][1] if j > 0 and toks[j - 1][0] == "id" else ""
                        # `a.b.c(` — берём последнюю часть, но помним, что был получатель
                        yield callee, j, inv.match_paren(toks, j), (toks[j - 2][1] == "." if j >= 2 else False)
                else:
                    depth -= 1
        j -= 1


def _template_to_path(v):
    """Строка/шаблон JS → путь с `{}` на месте подстановок `${…}`; хвост после `?` отбрасывается."""
    out, i, n = [], 0, len(v)
    while i < n:
        if v.startswith("${", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if v[j] == "{":
                    depth += 1
                elif v[j] == "}":
                    depth -= 1
                j += 1
            out.append("{}")
            i = j
        else:
            out.append(v[i])
            i += 1
    s = "".join(out)
    s = re.split(r"\?", s)[0]
    s = re.sub(r"#.*$", "", s)
    return s


VERBS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
V1_WRAPPERS = {"api", "fetch", "downloadFromServer", "sendBeacon", "download", "apiForm"}


def method_in_options(toks, a, b):
    """Методы из `method: "POST"` (в том числе `method: x ? "PUT" : "POST"`) в диапазоне токенов [a, b]."""
    found = []
    for i in range(a, b):
        if toks[i][0] == "id" and toks[i][1] == "method" and _t(toks, i + 1)[1] == ":":
            j = i + 2
            depth = 0
            while j < b:
                kk, vv, _ = toks[j]
                if kk == "p" and vv in ("(", "[", "{"):
                    depth += 1
                elif kk == "p" and vv in (")", "]", "}"):
                    if depth == 0:
                        break
                    depth -= 1
                elif kk == "p" and vv == "," and depth == 0:
                    break
                elif kk == "str" and vv.upper() in VERBS:
                    found.append(vv.upper())
                j += 1
    return found


def scan_js_paths(text, fname, kind="v1"):
    """Обращения к путям API в JS-файле: [{path, method, line, func, callee, file, hole_names}].

    Ищутся ВСЕ строки и шаблоны, начинающиеся с «/» (кроме /static, разметки и якорей), а метод определяется по охватывающему
    вызову (`api(путь, {method})`, `fetch`, `objectUrl(...)` внутри `api(...)`). Путь, присвоенный переменной, доопределяется
    по первому же вызову `api(`/`fetch(` с этой переменной в пределах той же функции."""
    toks = inv.tokenize(text)
    funs = js_functions(toks)
    owner = innermost_owner(len(funs), funs, len(toks))
    res = []
    lead_alts = {}      # индекс токена → альтернативы пути у шаблона `${cond ? "/a" : "/b"}/x`
    for i, (k, v, ln) in enumerate(toks):
        if k == "tpl" and v.startswith("${"):
            d, j = 1, 2
            while j < len(v) and d:
                d += (v[j] == "{") - (v[j] == "}")
                j += 1
            head, rest = v[2:j - 1], v[j:]
            lits = [t[1] for t in inv.tokenize(head) if t[0] == "str" and t[1].startswith("/") and len(t[1]) > 1]
            if lits:
                lead_alts[i] = [_template_to_path(l + rest) for l in lits]
    for i, (k, v, ln) in enumerate(toks):
        if k not in ("str", "tpl") or (not v.startswith("/") and i not in lead_alts) or len(v) < 2:
            continue
        if "<" in v or v.startswith(("/static/", "//", "/#", "/v2")) or v.startswith("/**"):
            continue
        if i in lead_alts:
            for alt in lead_alts[i]:
                verbs = []
                for cal, o, c, _hr in enclosing_calls(toks, i):
                    if cal in V1_WRAPPERS:
                        verbs = method_in_options(toks, o, c) or ["GET"]
                        break
                fi = owner[i]
                res.append({"path": alt, "method": "/".join(sorted(set(verbs))) if verbs else "GET", "line": ln, "func": funs[fi][0] if fi >= 0 else None,
                            "callee": "api", "file": fname, "how": "lead-template", "tok": i})
            continue
        path = _template_to_path(v)
        if not path or path == "/" or " " in path:
            continue
        if not re.match(r"^/[A-Za-z0-9_.\-{}$%/:@А-Яа-яЁё]*$", path):
            continue
        method, callee, how = None, None, "?"
        prev = _t(toks, i - 1)
        if prev[1] in ("===", "==", "!==", "!=") or (prev[1] == "(" and _t(toks, i - 2)[1] in ("startsWith", "endsWith", "includes", "test", "indexOf")):
            continue   # сравнение адреса (`path === "/plan-data"`), а не обращение
        # значение поля `endpoint: "/reports/status"` в таблице отчётов V1 — запросы уходят POST (`downloadReport`)
        if prev[1] == ":" and _t(toks, i - 2)[1] == "endpoint":
            method, callee, how = "POST", "REPORTS.endpoint", "endpoint"
        elif prev[1] == ":" and _t(toks, i - 2)[0] == "id" and _t(toks, i - 2)[1] in ("path", "url", "api", "apiPath"):
            # адрес передан объектом настроек в общую функцию (`openSimpleCatalog({path: "/smu"})`): метод внутри неё, поэтому
            # обращение считается «любым методом» на этом пути и его прямых дочерних (`/smu/{id}`)
            method, callee, how = "*", _t(toks, i - 2)[1], "prop"
        else:
            for cal, o, c, has_recv in enclosing_calls(toks, i):
                if cal == "objectUrl" or cal in ("encodeURIComponent", "String", "Number", "URLSearchParams", "join"):
                    continue
                if cal in V1_WRAPPERS or kind == "v2" and cal in ("get", "post", "patch", "put", "delete", "upload", "readPost"):
                    callee = cal
                    verbs = method_in_options(toks, o, c)
                    if cal == "sendBeacon":
                        verbs = ["POST"]
                    method = "/".join(sorted(set(verbs))) if verbs else "GET"
                    how = "call"
                    break
                # прочий вызов, в аргументах которого лежит путь (обёртки вида deleteBlkEntity(путь, …))
                callee = cal or None
                verbs = method_in_options(toks, o, c)
                if verbs:
                    method = "/".join(sorted(set(verbs)))
                    how = "call"
                    break
                # вызов-обёртка над DELETE: ищем `method: "DELETE"` в её теле
                if cal and cal not in ("if", "for", "while", "switch", "catch", "return", "push", "add", "set", "has", "includes", "startsWith", "test"):
                    for f in funs:
                        if f[0] == cal:
                            vs = method_in_options(toks, f[1], f[2])
                            if vs:
                                method, how = "/".join(sorted(set(vs))), "wrapper"
                                break
                    if method:
                        break
        if method is None:
            # путь в присваивании / тернарнике: смотрим переменную, которой он достаётся
            j = i - 1
            depth = 0
            var = None
            while j > max(0, i - 40):
                kk, vv, _ = toks[j]
                if kk == "p" and vv in (")", "]", "}"):
                    depth += 1
                elif kk == "p" and vv in ("(", "[", "{"):
                    if depth == 0:
                        break
                    depth -= 1
                elif kk == "p" and vv in (";",) and depth == 0:
                    break
                elif kk == "p" and vv == "=" and depth == 0 and toks[j - 1][0] == "id":
                    var = toks[j - 1][1]
                    break
                j -= 1
            if var:
                fi = owner[i]
                lim = funs[fi][2] if fi >= 0 else min(len(toks) - 1, i + 400)
                for j in range(i + 1, min(lim, i + 1500)):
                    if toks[j][0] == "id" and toks[j][1] == var and _t(toks, j - 1)[1] == "(" and _t(toks, j - 2)[1] in V1_WRAPPERS:
                        o = j - 1
                        c = inv.match_paren(toks, o)
                        verbs = method_in_options(toks, o, c)
                        method = "/".join(sorted(set(verbs))) if verbs else "GET"
                        callee, how = toks[j - 2][1], "var:" + var
                        break
            if method is None and prev[1] in ("=", "?", ":") and _t(toks, i - 2)[1] in ("src", "href"):
                method, callee, how = "GET", _t(toks, i - 2)[1], "src"     # картинка/ссылка: браузер читает адрес
        if method is None:
            method, callee, how = "?", callee, "unresolved"
        fi = owner[i]
        res.append({"path": path, "method": method, "line": ln, "func": funs[fi][0] if fi >= 0 else None, "callee": callee,
                    "file": fname, "how": how, "tok": i})
    return res, toks, funs, owner


# ======================================================================================================================
# V2: вызовы api.* и раскрытие путей, заданных настройками экрана
# ======================================================================================================================
V2_API = {"get": "GET", "post": "POST", "patch": "PATCH", "put": "PUT", "delete": "DELETE", "upload": "POST",
          "readPost": "POST", "download": "POST", "fetchFile": "GET"}

# Модуль V2, читающий «настройки экрана» из screens.json → какие ключи спецификации и какие поля дают пути (`spec.endpoint`).
SPEC_MODULES = {
    "dict-edit.js": [("edit", ["endpoint", "dictKind"])],
    "prefix-edit.js": [("prefix", ["endpoint"])],
    "subtypes-edit.js": [("subtypes", ["endpoint"])],
    "shape-edit.js": [("shape", ["endpoint", "put"])],
    "color-edit.js": [("color", ["endpoint"])],
    "setting-edit.js": [("setting", ["endpoint"])],
    "card-edit.js": [("card", ["endpoint"]), ("notes", ["endpoint"])],
    "revit-colors-edit.js": [("revit", ["endpoint", "filters"])],
}


def hole_config(screens):
    """{файл: {выражение: [(значение, id экрана)]}} из screens.json — чем раскрываются `spec.endpoint` и подобные подстановки."""
    m = defaultdict(lambda: defaultdict(list))
    for s in screens:
        for fname, specs in SPEC_MODULES.items():
            for key, attrs in specs:
                spec = s.get(key)
                if isinstance(spec, dict):
                    for a in attrs:
                        if a in spec and isinstance(spec[a], str):
                            m[fname][f"spec.{a}"].append((spec[a], s["id"]))
    return m


def _split_ternary(toks_slice):
    """Разбить выражение на альтернативы по `?`, `:`, `||`, `??` верхнего уровня (условие тоже попадёт — отсеется по виду)."""
    parts, cur, depth = [], [], 0
    for t in toks_slice:
        if t[0] == "p" and t[1] in ("(", "[", "{"):
            depth += 1
        elif t[0] == "p" and t[1] in (")", "]", "}"):
            depth -= 1
        if depth == 0 and t[0] == "p" and t[1] in ("?", ":", "||", "??"):
            parts.append(cur)
            cur = []
            continue
        cur.append(t)
    parts.append(cur)
    return parts


def _stmt_tokens(toks, a):
    """Токены выражения от `a` до `;`/закрывающей скобки нулевой глубины."""
    e = _expr_end(toks, a)
    return toks[a:e]


def scan_object_props(toks):
    """Индекс «имя свойства → [(vstart, vend)]» по ВСЕМ `{...}` файла: `ключ: значение,` на верхнем уровне фигурных
    скобок. Не различает объектный литерал и обычный блок кода (`if (...) { a: ... }` — в JS такое означало бы метку,
    редкость) — это ЗАПАСНОЙ способ раскрыть `объект.свойство(...)`, когда `объект» не резолвится напрямую (параметр
    функции-обёртки, например `cfg.path(v)` в конфигурациях загрузки exchange-import.js: `cfg` передаётся вызовом
    `mountUploadOp(el, ctx, contractingCfg(ctx))`, а `contractingCfg = (ctx) => ({ path: (v) => `/import-...`, ... })` —
    без разбора параметров функций и мест их вызова проще и надёжнее взять ВСЕ объектные литералы файла со свойством
    таким именем: ложные срабатывания отсеивает самопроверка «обращения V2 к путям, которых нет в backend»."""
    idx = defaultdict(list)
    n = len(toks)
    for i in range(n):
        if toks[i][1] != "{":
            continue
        rb = inv.match_brace(toks, i)
        depth, j, key, vstart = 0, i + 1, None, None
        while j < rb:
            k, v, _ = toks[j]
            if k == "p" and v in ("{", "[", "("):
                depth += 1
            elif k == "p" and v in ("}", "]", ")"):
                depth -= 1
            if depth == 0:
                if key is None and k in ("id", "str") and _t(toks, j + 1)[1] == ":" and _t(toks, j - 1)[1] != ".":
                    key, vstart = v, j + 2
                    j = vstart
                    continue
                if key is not None and k == "p" and v == ",":
                    idx[key].append((vstart, j - 1))
                    key, vstart = None, None
            j += 1
        if key is not None and vstart is not None and vstart <= rb - 1:
            idx[key].append((vstart, rb - 1))
    return idx


def _arrow_value_alts(resolver, vstart, vend, depth):
    """Значение свойства объектного литерала → альтернативы пути: разворачивает стрелочную функцию `(парам) => ВЫРАЖЕНИЕ`
    / `парам => ВЫРАЖЕНИЕ` / `(парам) => { … return ВЫРАЖЕНИЕ … }`, иначе разбирает значение как выражение целиком."""
    toks = resolver.toks
    i = vstart
    if _t(toks, i)[1] == "async":
        i += 1
    body0 = None
    if _t(toks, i)[1] == "(":
        e = inv.match_paren(toks, i)
        if e <= vend and _t(toks, e + 1)[1] == "=>":
            body0 = e + 2
    elif toks[i][0] == "id" and i + 1 <= vend and toks[i + 1][1] == "=>":
        body0 = i + 2
    if body0 is not None and body0 <= vend:
        if _t(toks, body0)[1] == "{":
            rb = inv.match_brace(toks, body0)
            alts = []
            for k in range(body0, min(rb, vend + 1)):
                if toks[k][0] == "id" and toks[k][1] == "return":
                    alts += resolver.expr_alts(_stmt_tokens(toks, k + 1), k, depth + 1) or []
            return alts
        return resolver.expr_alts(toks[body0:vend + 1], body0, depth + 1)
    return resolver.expr_alts(toks[vstart:vend + 1], vstart, depth + 1)


class V2Resolver:
    def __init__(self, fname, toks, funs, owner, holes):
        self.f, self.toks, self.funs, self.owner, self.holes = fname, toks, funs, owner, holes
        self._obj_index = None

    def obj_index(self):
        if self._obj_index is None:
            self._obj_index = scan_object_props(self.toks)
        return self._obj_index

    def chain_call_alts(self, chain, depth):
        """`объект.свойство(...)`, где `объект` не резолвится напрямую (параметр функции-обёртки, а не локальная
        переменная): запасной раскрыв по имени последнего звена цепочки — см. `scan_object_props`."""
        if depth > 4:
            return None
        prop = chain[-1]
        cands = self.obj_index().get(prop, [])
        alts = []
        for (vs, ve) in cands:
            alts += _arrow_value_alts(self, vs, ve, depth) or []
        seen, out = set(), []
        for a in alts:
            if a not in seen:
                seen.add(a)
                out.append(a)
        return out or None

    def var_alts(self, name, at, depth):
        toks = self.toks
        fi = self.owner[at]
        rng = (self.funs[fi][1], at) if fi >= 0 else (0, at)
        best = None
        for j in range(rng[1] - 1, rng[0] - 1, -1):
            if toks[j][0] == "id" and toks[j][1] == name and _t(toks, j + 1)[1] == "=" and _t(toks, j - 1)[1] != ".":
                best = j
                break
        if best is None and fi >= 0:   # модульная переменная
            for j in range(0, at):
                if toks[j][0] == "id" and toks[j][1] == name and _t(toks, j + 1)[1] == "=" and _t(toks, j - 1)[1] in ("const", "let", "var"):
                    best = j
                    break
        if best is None:
            return None
        return self.expr_alts(_stmt_tokens(toks, best + 2), best, depth + 1)

    def param_alts(self, name, at, depth):
        """Значение переменной — не найдено локальным присваиванием (`var_alts`): возможно, это ПАРАМЕТР функции-
        обёртки (`function patchChecked(kind, id, path, body, current) { … api.patch(path, …) … }`, путь передаёт
        КАЖДЫЙ вызывающий литералом — `patchChecked("counterparty", id, \\`/counterparties/${id}\\`, body)`).
        Находит охватывающую именованную функцию, где `name` — параметр, ищет её вызовы ПО ИМЕНИ в том же файле и
        раскрывает аргумент на той же позиции в каждом найденном вызове."""
        if depth > 4:
            return None
        toks = self.toks
        fi = self.owner[at]
        seen_fi = set()
        params = fname = ntok = None
        while fi is not None and fi >= 0 and fi not in seen_fi:
            seen_fi.add(fi)
            cand_name, _fs, _fe, cand_ntok, cand_params = self.funs[fi]
            if name in cand_params:
                fname, ntok, params = cand_name, cand_ntok, cand_params
                break
            # не параметр этой функции — возможно, замыкание над параметром ОХВАТЫВАЮЩЕЙ (`const send = (v) => api.patch(path, …)`
            # внутри `patchChecked(..., path, ...)`): подняться к владельцу токена-имени этой функции (её объявление лежит
            # СНАРУЖИ её собственного тела, поэтому `owner` в этой точке — уже родитель, а не сама функция)
            parent = self.owner[cand_ntok] if 0 <= cand_ntok < len(self.owner) else -1
            fi = parent if parent != fi else -1
        if params is None:
            return None
        idx = params.index(name)
        alts = []
        for i, (k, v, _ln) in enumerate(toks):
            if not (k == "id" and v == fname and i != ntok and _t(toks, i + 1)[1] == "(" and _t(toks, i - 1)[1] != "."):
                continue
            co = i + 1
            cc = inv.match_paren(toks, co)
            args, cur, d = [], [], 0
            for j in range(co + 1, cc):
                t = toks[j]
                if t[0] == "p" and t[1] in ("(", "[", "{"):
                    d += 1
                elif t[0] == "p" and t[1] in (")", "]", "}"):
                    d -= 1
                if d == 0 and t[0] == "p" and t[1] == ",":
                    args.append(cur)
                    cur = []
                else:
                    cur.append(t)
            args.append(cur)
            if idx < len(args) and args[idx]:
                alts += self.expr_alts(args[idx], co, depth + 1) or []
        seen, out = set(), []
        for a in alts:
            if a not in seen:
                seen.add(a)
                out.append(a)
        return out or None

    def func_return_alts(self, name, depth):
        out = []
        for f in self.funs:
            if f[0] == name:
                for j in range(f[1], f[2]):
                    if self.toks[j][0] == "id" and self.toks[j][1] == "return":
                        out += self.expr_alts(_stmt_tokens(self.toks, j + 1), j, depth + 1) or []
        return out or None

    def expr_alts(self, sl, at, depth=0):
        """Выражение → список вариантов пути [(строка с {} и «дырками»)], где дырка — `⟦spec.endpoint⟧`."""
        if depth > 5 or not sl:
            return []
        alts = []
        for part in _split_ternary(sl):
            if not part:
                continue
            cur = [""]
            i = 0
            ok = True
            while i < len(part):
                k, v, _ = part[i]
                if k == "str":
                    cur = [c + v for c in cur]
                elif k == "tpl":
                    cur = self._tpl(cur, v, at, depth)
                elif k == "p" and v == "+":
                    pass
                elif k == "id" and v in ("encodeURIComponent", "String", "Number", "encodeURI") and _t(part, i + 1)[1] == "(":
                    cur = [c + "{}" for c in cur]
                    depth_p = 0
                    j = i + 1
                    while j < len(part):
                        if part[j][1] == "(":
                            depth_p += 1
                        elif part[j][1] == ")":
                            depth_p -= 1
                            if depth_p == 0:
                                break
                        j += 1
                    i = j
                elif k == "id":
                    chain = [v]
                    j = i + 1
                    while j + 1 < len(part) and part[j][1] == "." and part[j + 1][0] == "id":
                        chain.append(part[j + 1][1])
                        j += 2
                    if _t(part, j)[1] == "(":     # вызов функции: вернуть значение её return
                        alts2 = self.func_return_alts(chain[-1], depth) if len(chain) == 1 else self.chain_call_alts(chain, depth)
                        depth_p = 0
                        while j < len(part):
                            if part[j][1] == "(":
                                depth_p += 1
                            elif part[j][1] == ")":
                                depth_p -= 1
                                if depth_p == 0:
                                    break
                            j += 1
                        if alts2:
                            cur = [c + a for c in cur for a in alts2]
                        else:
                            cur = [c + "{}" for c in cur]
                    elif len(chain) == 1:
                        alts2 = self.var_alts(v, at, depth) or self.param_alts(v, at, depth)
                        if alts2:
                            cur = [c + a for c in cur for a in alts2]
                        else:
                            cur = [c + "⟦" + v + "⟧" for c in cur]
                    else:
                        cur = [c + "⟦" + ".".join(chain) + "⟧" for c in cur]
                    i = j
                else:
                    pass
                i += 1
            alts += cur
        return alts

    def _tpl(self, cur, raw, at, depth):
        out = cur
        i, n = 0, len(raw)
        lit = []
        while i < n:
            if raw.startswith("${", i):
                d, j = 1, i + 2
                while j < n and d:
                    if raw[j] == "{":
                        d += 1
                    elif raw[j] == "}":
                        d -= 1
                    j += 1
                expr = raw[i + 2:j - 1]
                out = [c + "".join(lit) for c in out]
                lit = []
                sub = inv.tokenize(expr)
                alts = self.expr_alts(sub, at, depth + 1) if sub else []
                alts = [a for a in alts if a] or ["{}"]
                # подстановка, не похожая на путь и не дырка (обычный идентификатор/число) → {}
                norm = []
                for a in alts:
                    norm.append(a if (a.startswith("/") or "⟦" in a) else "{}")
                out = [c + a for c in out for a in dict.fromkeys(norm)]
                i = j
            else:
                lit.append(raw[i])
                i += 1
        return [c + "".join(lit) for c in out]


V2_CALL_RE = re.compile(r"\bapi\s*\.\s*(get|post|patch|put|delete|upload|readPost|download|fetchFile)\s*\(|(?<![.\w])fetch\s*\(")


def v2_call_count_by_regex(text):
    """Независимый подсчёт вызовов V2 (не токенизатором `inv.tokenize`, а обычным regex по тексту файла) — сколько раз
    встречается `api.<метод>(` (из `V2_API`) или отдельно стоящий `fetch(`; сверяется с числом вызовов, которое находит
    структурный разбор `scan_v2_file` (по тем же признакам, но токенами) — как для backend `ast` vs `tokenize`."""
    return len(V2_CALL_RE.findall(text))


V2_CALL_LITERAL_RE = re.compile(
    r"\bapi\s*\.\s*(get|post|patch|put|delete|upload|readPost|download|fetchFile)\s*\(\s*(`[^`]*`|\"[^\"]*\"|'[^']*')")


def v2_calls_regex_fallback(fname, text):
    """Резервный проход РЕГУЛЯРКОЙ по литеральным вызовам `api.<метод>(литерал)` — НЕ основной способ разбора (основной
    — токенизатор `inv.tokenize`/`scan_v2_file`, он и остаётся источником для всего остального: методов, `screens.json`,
    экспорта дырок и т.д.), а СТРАХОВКА от подтверждённого дефекта самого токенизатора на сложных ВЛОЖЕННЫХ шаблонных
    литералах (например, `app/static/v2/users-access.js`: длинный HTML-шаблон формы роли обрывает отслеживание глубины
    `${…}`/обратных кавычек на несколько сотен строк раньше настоящего конца, из-за чего реальный код — в том числе
    `api.patch(\\`/roles/${role.key}\\`, …)` — целиком выпадает из токенов; воспроизведено и НЕ устранено здесь: файл
    `scripts/inventory_v1_ui.py` вне списка файлов, которые может менять этот исполнитель, — заведён отдельный блокер).
    Ловит только простые вызовы с ОДНИМ прямым литералом первым аргументом (шаблон без вложенных вызовов в дырке —
    `_template_to_path` даёт «{}» на месте `${…}`); используется в `load_side` ТОЛЬКО как добавка для (метод, путь),
    которых структурный разбор во ВСЁМ файле не нашёл вовсе — не подменяет и не дублирует то, что уже нашли токены."""
    out = []
    for m in V2_CALL_LITERAL_RE.finditer(text):
        api_name, raw = m.group(1), m.group(2)
        lit = raw[1:-1]
        path = _template_to_path(lit) if raw[0] == "`" else lit
        path = strip_query_hole(re.split(r"\?", path)[0])
        if not path.startswith("/") or path == "/" or path.startswith("/static/"):
            continue
        ln = text.count("\n", 0, m.start()) + 1
        method = V2_API.get(api_name, "GET")
        if api_name in ("download", "fetchFile", "fetch"):
            mm = re.search(r'method\s*:\s*"(GET|POST|PUT|PATCH|DELETE)"', text[m.end():m.end() + 200])
            if mm:
                method = mm.group(1)
        out.append({"file": fname, "line": ln, "api": api_name, "method": method,
                    "alts": [(path, None)], "func": None,
                    "raw_arg": f"{raw} (регэксп-страховка — токенизатор пропустил этот вызов целиком)"})
    return out


def scan_v2_file(fname, text, holes):
    """Вызовы API в модуле V2: [{file, line, api, method, alts: [(путь, экран|None)], func}]."""
    toks = inv.tokenize(text)
    funs = js_functions(toks)
    owner = innermost_owner(len(funs), funs, len(toks))
    rs = V2Resolver(fname, toks, funs, owner, holes)
    calls = []
    for i in range(1, len(toks) - 2):
        api_name = None
        if toks[i][1] == "." and toks[i + 1][0] == "id" and toks[i + 1][1] in V2_API and toks[i + 2][1] == "(" and toks[i - 1][1] == "api":
            api_name, po = toks[i + 1][1], i + 2
        elif toks[i][0] == "id" and toks[i][1] == "fetch" and toks[i + 1][1] == "(" and toks[i - 1][1] != ".":
            api_name, po = "fetch", i + 1
        if not api_name:
            continue
        pc = inv.match_paren(toks, po)
        arg, depth = [], 0
        for k in range(po + 1, pc):
            t = toks[k]
            if t[0] == "p" and t[1] in ("(", "[", "{"):
                depth += 1
            elif t[0] == "p" and t[1] in (")", "]", "}"):
                depth -= 1
            elif t[0] == "p" and t[1] == "," and depth == 0:
                break
            arg.append(t)
        raw = rs.expr_alts(arg, po)
        method = V2_API.get(api_name, "GET")
        if api_name == "download":
            verbs = method_in_options(toks, po, pc)
            method = verbs[0] if verbs else "POST"
        elif api_name in ("fetch", "fetchFile"):
            verbs = method_in_options(toks, po, pc)
            method = verbs[0] if verbs else "GET"
        alts = []
        for a in raw:
            a2 = re.split(r"\?", a)[0]
            a2 = re.sub(r"⟦[^⟧]*⟧$", lambda m: m.group(0), a2)
            if not (a2.startswith("/") or a2.startswith("⟦")):
                continue
            # раскрыть «дырки» настройками экрана
            expanded = [(a2, None)]
            for m in re.finditer(r"⟦([^⟧]*)⟧", a2):
                expr = m.group(1)
                cfg = holes.get(fname, {}).get(expr)
                new = []
                for (cur, scr) in expanded:
                    if cfg:
                        for val, sid in cfg:
                            new.append((cur.replace(m.group(0), val, 1), sid or scr))
                    else:
                        new.append((cur.replace(m.group(0), "{}", 1), scr))
                expanded = new
            alts += expanded
        fi = owner[i]
        calls.append({"file": fname, "line": toks[i + 1][2] if api_name != "fetch" else toks[i][2], "api": api_name, "method": method,
                      "alts": alts, "func": funs[fi][0] if fi >= 0 else None, "raw_arg": "".join(f"`{t[1]}`" if t[0] == "tpl" else f'"{t[1]}"' if t[0] == "str" else t[1] for t in arg)[:120]})
    return calls


def read_screen_usage(screens):
    """`read-screen.js` — универсальный модуль чтения: его запросы определяет `screens.json` (`read.sections`), поэтому usage строится
    по нему: GET раздела, POST-чтение отчёта, выгрузка `.xlsx/.pdf`, отметка `ack`."""
    out = []
    for s in screens:
        if s.get("impl") != "read":
            continue
        for sec in (s.get("read") or {}).get("sections", []):
            ep = re.split(r"\?", sec["endpoint"])[0].replace("{object}", "{}")
            if sec.get("kind") == "report":
                out.append({"file": "read-screen.js", "line": 204, "api": "readPost", "method": "POST", "alts": [(ep, s["id"])], "func": "exportReport/load", "raw_arg": "sec.endpoint (screens.json)"})
                for ext in sec.get("exports", []):
                    out.append({"file": "read-screen.js", "line": 180, "api": "download", "method": "POST", "alts": [(f"{ep}.{ext}", s["id"])], "func": "exportReport", "raw_arg": f"sec.endpoint.{ext} (screens.json)"})
            else:
                out.append({"file": "read-screen.js", "line": 205, "api": "get", "method": "GET", "alts": [(ep, s["id"])], "func": "load", "raw_arg": "urlFor(sec) (screens.json)"})
                if sec.get("ack"):
                    out.append({"file": "read-screen.js", "line": 235, "api": "post", "method": "POST", "alts": [(sec["ack"]["path"], s["id"])], "func": "ack", "raw_arg": "sec.ack.path (screens.json)"})
    return out


# ======================================================================================================================
# V1: граф вызовов и точки входа интерфейса (меню «Действия», кнопки панели, модальные окна)
# ======================================================================================================================
def find_handler_roots(toks):
    """{id элемента: [(начало, конец)]} — диапазоны токенов аргументов `addEventListener(...)` для `getElementById("id")`
    (напрямую или через переменную-псевдоним `const x = document.getElementById("id")`)."""
    roots = defaultdict(list)
    aliases = {}
    n = len(toks)
    for i in range(n - 6):
        if toks[i][1] == "getElementById" and toks[i + 1][1] == "(" and toks[i + 2][0] == "str" and toks[i + 3][1] == ")":
            eid = toks[i + 2][1]
            if i >= 4 and toks[i - 3][1] == "=" and toks[i - 4][0] == "id":
                aliases.setdefault(toks[i - 4][1], eid)
            if toks[i + 4][1] == "." and toks[i + 5][1] == "addEventListener" and toks[i + 6][1] == "(":
                roots[eid].append((i + 6, inv.match_paren(toks, i + 6)))
    for i in range(n - 3):
        if toks[i][0] == "id" and toks[i][1] in aliases and toks[i + 1][1] == "." and toks[i + 2][1] == "addEventListener" and toks[i + 3][1] == "(":
            roots[aliases[toks[i][1]]].append((i + 3, inv.match_paren(toks, i + 3)))
    return roots, aliases


class V1Graph:
    """Граф вызовов app.js + точки входа. Точка входа → функции, которые она запускает (расстояние в шагах)."""

    def __init__(self, text, html_tree):
        self.toks = inv.tokenize(text)
        self.funs = js_functions(self.toks)
        self.owner = innermost_owner(len(self.funs), self.funs, len(self.toks))
        self.byname = defaultdict(list)
        for idx, f in enumerate(self.funs):
            self.byname[f[0]].append(idx)
        self.edges = defaultdict(set)
        toks = self.toks
        for i, (k, v, _) in enumerate(toks):
            if k == "id" and v in self.byname and self.owner[i] >= 0:
                prev = toks[i - 1][1] if i else ""
                nxt = toks[i + 1][1] if i + 1 < len(toks) else ""
                if prev == "." or prev == "function" or nxt == ":" or (nxt == "=" and prev in ("const", "let", "var")):
                    continue
                for callee in self.byname[v]:
                    if callee != self.owner[i]:
                        self.edges[self.owner[i]].add(callee)
        self.roots, self.aliases = find_handler_roots(toks)
        self.menu = inv.menu_entries(html_tree)
        self.modals = inv.modals(html_tree)
        self.toolbar = inv.toolbar(html_tree)
        self.entries = {}   # ключ → {kind, id, label}
        for m in self.menu:
            if m["id"]:
                self.entries[("menu", m["id"])] = {"kind": "menu", "id": m["id"],
                                                    "label": "Действия › " + " › ".join(m["path"] + [m["label"]]) if m["path"] else "Действия › " + m["label"]}
        for t in self.toolbar:
            self.entries[("toolbar", t["id"])] = {"kind": "toolbar", "id": t["id"], "label": f"кнопка «{t['text'] or t['id']}» (`{t['id']}`)"}
        for m in self.modals:
            self.entries[("modal", m["id"])] = {"kind": "modal", "id": m["id"], "label": f"окно «{m['title'] or m['id']}» (`{m['id']}`)"}
        # функции-владельцы модальных окон: где встречается `getElementById("<id>")` или переменная-псевдоним
        alias_by_id = defaultdict(set)
        for a, e in self.aliases.items():
            alias_by_id[e].add(a)
        self.modal_funcs = defaultdict(set)
        for i, (k, v, _) in enumerate(toks):
            if self.owner[i] < 0:
                continue
            if k == "str" and ("modal", v) in self.entries:
                self.modal_funcs[v].add(self.owner[i])
            elif k == "id":
                for e in ():
                    pass
        alias_to_modal = {a: e for a, e in self.aliases.items() if ("modal", e) in self.entries}
        for i, (k, v, _) in enumerate(toks):
            if k == "id" and v in alias_to_modal and self.owner[i] >= 0 and (toks[i - 1][1] != ".") :
                self.modal_funcs[alias_to_modal[v]].add(self.owner[i])
        # кнопки внутри модального окна → их обработчики тоже стартуют от этого окна
        self.modal_buttons = {m["id"]: [b["id"] for b in m["buttons"]] for m in self.modals}
        self._dist_cache = {}

    def refs_in_range(self, a, b):
        out = set()
        for i in range(a, b + 1):
            k, v, _ = self.toks[i]
            if k == "id" and v in self.byname and (i == 0 or self.toks[i - 1][1] != "."):
                out.update(self.byname[v])
        return out

    def bfs(self, seeds, max_depth):
        dist = {}
        frontier = [(s, 0) for s in seeds]
        for s, d in frontier:
            dist[s] = d
        q = list(frontier)
        while q:
            cur, d = q.pop(0)
            if d >= max_depth:
                continue
            for nx in self.edges.get(cur, ()):
                if nx not in dist:
                    dist[nx] = d + 1
                    q.append((nx, d + 1))
        return dist

    def entry_reach(self, max_depth=5):
        """{ключ входа: {индекс функции: расстояние}}."""
        reach = {}
        for key, e in self.entries.items():
            seeds = set()
            if e["kind"] in ("menu", "toolbar"):
                for (a, b) in self.roots.get(e["id"], []):
                    seeds |= self.refs_in_range(a, b)
                    if self.owner[a] >= 0 and False:
                        seeds.add(self.owner[a])
                d0 = 1
            else:
                seeds |= self.modal_funcs.get(e["id"], set())
                for bid in self.modal_buttons.get(e["id"], []):
                    for (a, b) in self.roots.get(bid, []):
                        seeds |= self.refs_in_range(a, b)
                d0 = 0
            if seeds:
                reach[key] = {f: d + d0 for f, d in self.bfs(seeds, max_depth).items()}
        return reach

    def func_name(self, idx):
        return self.funs[idx][0] if idx >= 0 else None


# файлы V1, вызываемые не из app.js: их код запускается с известных точек входа
V1_FILE_ENTRIES = {
    "chess-flat.js": [("menu", "menu-chess-flat-open")],
    "shaft-panels.js": [("toolbar", "btn-upload-shaft-panels")],
    "address.js": [("menu", "menu-catalog"), ("menu", "menu-address-classifier")],
    "map.js": [("menu", "menu-report-map"), ("menu", "menu-map-admin"), ("toolbar", "btn-toolbar-map")],
    "embed-bridge.js": [],
}
V1_EXTRA_FILES = ["app/static/chess-flat.js", "app/static/shaft-panels.js", "app/static/address.js", "app/static/map.js",
                  "app/static/embed-bridge.js"]


# ======================================================================================================================
# Шлюз записи V2: POLICY, вычисленный настоящим node
# ======================================================================================================================
GATE_JS = r"""
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[2]).href);
const rows = mod.POLICY.map((r) => ({
  id: r.id, screen: r.screen || null, action: r.action || "", method: r.method, allowed: !!r.allowed,
  path_source: r.path instanceof RegExp ? r.path.source : String(r.path),
  onlyKeys: r.onlyKeys || null, hasCheck: typeof r.check === "function", checkName: typeof r.check === "function" ? (r.check.name || "check") : null,
  risk: r.risk || "", why: r.why || "", proof: r.proof || "",
}));
process.stdout.write(JSON.stringify({ rows, flags: { ALLOCATION_ENABLED: mod.ALLOCATION_ENABLED ?? null } }));
"""


def gate_row_areas(text):
    """{id строки POLICY: область} — по заголовкам `// ==== область: ИМЯ (...) ====`, которыми BRIEF требует размечать
    блоки шлюза («Строки — ТОЛЬКО в блоке своей области»): это авторитетный источник области для ЗАПИСЫВАЮЩИХ операций,
    точнее эвристики по пути (`RULES`) — путь бывает общим у операций разных исполнителей (например
    `/objects/{id}/block-works/bulk-edit/…` относится к пути «Импорт и экспорт», но строки `bulk-edit.analyze`/
    `bulk-edit.apply` описаны в блоке области mfr, как и остальной учёт по блокам). НЕ разбор вызовов — построчный
    просмотр организационных заголовков-комментариев, отдельно от токенизации JS-выражений."""
    out = {}
    area = None
    for line in text.splitlines():
        m = re.search(r"====\s*область:\s*([a-zA-Zа-яА-Я]+)", line)
        if m:
            area = m.group(1)
            continue
        m = re.search(r'\bid:\s*"([^"]+)"', line)
        if m and area:
            out[m.group(1)] = area
    return out


def eval_gate(src):
    """Таблица POLICY из `write-gate.js` выбранной ревизии (модуль вычисляется `node`). None — файла или node нет."""
    text = src.read("app/static/v2/write-gate.js")
    if text is None:
        return None
    row_areas = gate_row_areas(text)
    with tempfile.TemporaryDirectory() as d:
        gp = Path(d) / "write-gate.mjs"
        gp.write_text(text, encoding="utf-8")
        # Модули, которые шлюз импортирует (правила форм тела областей): переносим их из той же ревизии, рекурсивно
        todo, seen = [text], set()
        while todo:
            for name in re.findall(r'from\s+"\./([A-Za-z0-9_.-]+\.js)"', todo.pop()):
                if name in seen:
                    continue
                seen.add(name)
                dep = src.read("app/static/v2/" + name)
                if dep is not None:
                    (Path(d) / name).write_text(dep, encoding="utf-8")
                    todo.append(dep)
        rp = Path(d) / "run.mjs"
        rp.write_text(GATE_JS, encoding="utf-8")
        try:
            r = subprocess.run(["node", str(rp), str(gp)], capture_output=True, text=True, timeout=60)
        except FileNotFoundError:
            sys.exit("не найден node: он нужен, чтобы вычислить POLICY шлюза (write-gate.js)")
        if r.returncode != 0:
            sys.exit("node не смог вычислить POLICY:\n" + r.stderr[:800])
    data = json.loads(r.stdout)
    for row in data["rows"]:
        row["path_re"] = re.compile("^" + row["path_source"] + "$")
        row["methods"] = [m.strip() for m in row["method"].split("/")]
        row["area"] = row_areas.get(row["id"])
    return data


def gate_for(gate, method, path_sample):
    """Строки шлюза для (метод, путь): разрешающие и отключённые. Пример пути — с `1` вместо параметров."""
    allowed, disabled = [], []
    if not gate:
        return allowed, disabled
    for r in gate["rows"]:
        if not r["path_re"].match(path_sample):
            continue
        if r["allowed"]:
            if method in r["methods"]:
                allowed.append(r)
        else:
            disabled.append(r)
    return allowed, disabled


# ======================================================================================================================
# Сопоставление обращений (V1/V2) с маршрутами backend
# ======================================================================================================================
def _segs(p):
    return [x for x in p.strip("/").split("/")] if p.strip("/") else []


def _norm_route(p):
    return re.sub(r"\{[^}]*\}", "{}", p)


def compat(usage, route):
    """Оценка совместимости пути обращения (`{}` — подстановка) и пути маршрута; None — не подходит."""
    us, rs = _segs(usage), _segs(route)
    if len(us) != len(rs):
        return None
    score = 0
    for u, r in zip(us, rs):
        rparam = r.startswith("{")
        if u == r:
            score += 3
        elif rparam:
            score += 2 if "{}" in u else 1
        elif "{}" in u:
            if u == "{}":
                score += 0
            else:
                rx = "^" + re.escape(u).replace(r"\{\}", "[^/]+") + "$"
                if re.match(rx, r):
                    score += 1
                else:
                    return None
        else:
            return None
    return score


def method_ok(um, rm):
    return um == "*" or rm in um.split("/") or (um == "?" )


def match_usages(routes, usages):
    """Каждому обращению — лучшие маршруты. Возвращает (по маршруту: [обращения], несопоставленные обращения)."""
    norm = [(r, _norm_route(r["path"])) for r in routes]
    by_route = defaultdict(list)
    unmatched = []
    for u in usages:
        best, best_score = [], -1
        for r, rp in norm:
            if u["method"] == "*":
                # «любой метод» на пути и его прямых дочерних `/x/{id}`
                us, rs = _segs(u["path"]), _segs(rp)
                ok = (len(rs) == len(us) and compat(u["path"], rp) is not None) or \
                     (len(rs) == len(us) + 1 and rs[-1] == "{}" and compat(u["path"], "/".join(rs[:-1])) is not None)
                sc = 1 if ok else None
            elif method_ok(u["method"], r["method"]):
                sc = compat(u["path"], rp)
            else:
                sc = None
            if sc is None:
                continue
            if sc > best_score:
                best, best_score = [r], sc
            elif sc == best_score:
                best.append(r)
        if best:
            for r in best:
                by_route[(r["method"], r["path"])].append(u)
        else:
            unmatched.append(u)
    return by_route, unmatched


# ======================================================================================================================
# Правила: раздел V1, область переноса, экран V2 — по пути маршрута
# ======================================================================================================================
S_WS, S_BLK, S_USR, S_PRJ = "Рабочие места", "Учёт по блокам (МФР)", "Пользователи и роли", "Проекты и объекты"
S_CP, S_AG, S_SP, S_CT, S_DOC = "Контрагенты", "Договоры", "Спецификации", "Контракты", "Документы"
S_DICT, S_REP, S_IO, S_SET, S_SVC, S_SCH = "Справочники", "Отчёты", "Импорт и экспорт", "Настройки", "Служебные функции", "График СМР"
REQUIRED_SECTIONS = [S_WS, S_USR, S_PRJ, S_CP, S_AG, S_SP, S_CT, S_DOC, S_DICT, S_REP, S_IO, S_SET, S_SVC]
SECTIONS = REQUIRED_SECTIONS + [S_BLK, S_SCH]
AREAS = ["model", "mfr", "picker", "admin", "exchange", "прочее"]
AREA_TITLES = {
    "model": "model — прораб, модель ЖБИ, операции над элементами, групповая смена статуса, даты, комментарии, контракты изделий",
    "mfr": "mfr — МФР, учёт по блокам, факт, сроки, шахматка, динамика",
    "picker": "picker — комплектовщик, контрагенты, договоры, спецификации, контракты, замена поставщика, обмен привязками",
    "admin": "admin — пользователи, роли, доступы, пароли, сеансы, проекты и объекты, справочники, настройки, резервные копии, служебные",
    "exchange": "exchange — импорт, экспорт, документы, отчёты",
    "прочее": "прочее — не отнесено ни к одной из пяти областей",
}

_ID = r"\{[^}]+\}"
# (регэксп пути, методы или None, раздел, область, экран V2 или None). Первое совпадение выигрывает.
RULES = [
    (r"^/plan-data$", None, S_WS, "model", "ws-model"),
    (r"^/(axis-grid|layers|changes|status-summary|source-files)$", None, S_WS, "model", "ws-model"),
    (r"^/elements/changed$", None, S_WS, "model", "ws-model"),
    (r"^/elements$", None, S_WS, "model", "ws-model"),
    (r"^/elements/bulk-edit/", None, S_IO, "exchange", "bulk-edit"),
    (r"^/elements/bulk-(status|planned-delivery-date)$", None, S_WS, "model", "element-ops"),
    (r"^/element-ops/", None, S_WS, "model", "element-ops"),
    (rf"^/elements/{_ID}/(status|comment|contract|planned-delivery-date|fields|history)", None, S_WS, "model", "element-ops"),
    (rf"^/elements/{_ID}(/context|/activity)?$", None, S_WS, "model", "ws-model"),
    (rf"^/contracts/{_ID}/allocations$", None, S_WS, "picker", "ws-picker"),
    (r"^/allocation-state$", None, S_WS, "picker", "ws-picker"),
    (r"^/contracts", None, S_CT, "picker", "contracts"),
    (r"^/agreements", None, S_AG, "picker", "counterparties"),
    (r"^/specifications", None, S_SP, "picker", "counterparties"),
    (r"^/counterparties", None, S_CP, "picker", "counterparties"),
    (r"^/supplier-changes", None, S_DOC, "picker", "supplier-change"),
    (r"^/attachments", None, S_DOC, "admin", "projects-objects"),
    (rf"^/objects/{_ID}/avatar$", None, S_PRJ, "admin", "projects-objects"),
    (r"^/(projects|projects-tree)", None, S_PRJ, "admin", "projects-objects"),
    (rf"^/objects$|^/objects/{_ID}$", None, S_PRJ, "admin", "projects-objects"),
    (r"^/objects-import/", None, S_IO, "exchange", "objects-import"),
    (rf"^/objects/{_ID}/external-models", None, S_IO, "exchange", "external-models"),
    (rf"^/objects/{_ID}/drawings$", None, S_IO, "exchange", "upload-drawing"),
    (rf"^/objects/{_ID}/clear-import-data$", None, S_IO, "exchange", "revit-import"),
    (rf"^/objects/{_ID}/block-works/bulk-edit/", None, S_IO, "exchange", "blk-bulk"),
    (rf"^/objects/{_ID}/work-types/(analyze|apply)$", None, S_IO, "exchange", "blocks"),
    (rf"^/objects/{_ID}/blocks/chess-flat", None, S_BLK, "mfr", "chess-flat"),
    (rf"^/objects/{_ID}/fact-journal$", None, S_BLK, "mfr", "fact-journal"),
    (rf"^/objects/{_ID}/blocks/{_ID}/(fact-reports|work-types/{_ID}/fact-history)", None, S_BLK, "mfr", "fact-journal"),
    (rf"^/objects/{_ID}/blocks/fact-changes$", None, S_BLK, "mfr", "fact-journal"),
    (rf"^/objects/{_ID}/(blocks|block-works|block-work-types|sections|levels|work-progress|planning-tracks|plan-images|grids)", None, S_BLK, "mfr", "blocks"),
    (r"^/revit-plan/", None, S_WS, "mfr", "ws-mfr"),
    (r"^/zones", None, S_DICT, "admin", "zones"),
    (r"^/smu", None, S_DICT, "admin", "dict-smu"),
    (r"^/individuals", None, S_DICT, "admin", "dict-individuals"),
    (r"^/allowed-subtypes", None, S_DICT, "admin", "subtypes"),
    (r"^/mark-type-prefixes", None, S_DICT, "admin", "mark-prefixes"),
    (r"^/marks", None, S_DICT, "admin", None),
    (r"^/element-catalog", None, S_DICT, "admin", "element-catalog"),
    (r"^/(status-colors)", None, S_SET, "admin", "status-colors"),
    (r"^/(zone-colors)", None, S_SET, "admin", "zone-colors"),
    (r"^/(element-shapes|layer-type-combinations)", None, S_SET, "admin", "marker-shapes"),
    (r"^/(label-visibility|label-dates-visibility)", None, S_SET, "admin", None),
    (r"^/settings/(export|import)$", None, S_IO, "exchange", "settings-io"),
    (r"^/settings/info-plate", None, S_SET, "admin", "late-threshold"),
    (r"^/settings/project-card", None, S_SET, "admin", "project-card"),
    (r"^/settings/report-notes", None, S_SET, "admin", "report-notes"),
    (rf"^/users/{_ID}/ui-theme$", None, S_SET, "admin", "appearance"),
    (rf"^/users/{_ID}/label-color$", None, S_SET, "admin", "label-color"),
    (rf"^/users/{_ID}/(menu-prefs|min-label-px|view3d)$", None, S_SET, "admin", "appearance"),
    (rf"^/users/{_ID}/(sessions)$|^/sessions|^/me/sessions", None, S_USR, "admin", "sessions"),
    (r"^/users|^/roles", None, S_USR, "admin", "users-access"),
    (r"^/ldap", None, S_USR, "admin", "ldap"),
    (r"^/me/change-password$", None, S_USR, "admin", "change-password"),
    (r"^/password-policy$", None, S_USR, "admin", "change-password"),
    (r"^/me", None, S_SVC, "admin", "shell-context"),
    (r"^/map/config$|^/map/online-tiles$|^/map/tiles/upload$", None, S_PRJ, "admin", "map-admin"),
    (r"^/map/", None, S_PRJ, "admin", "map"),
    (r"^/address/(upload|fetch|unpack|load|load-status|regions-in-file|status)$", None, S_DICT, "admin", "address-classifier"),
    (r"^/address/", None, S_DICT, "admin", "project-card"),
    (r"^/reports/", None, S_REP, "exchange", None),          # экран отчёта уточняется ниже (report-<имя>)
    (r"^/report-help/", None, S_REP, "exchange", None),
    (rf"^/objects/{_ID}/activity-users$", None, S_REP, "exchange", "report-mywork"),
    (r"^/export\.(xlsx|pdf)$", None, S_IO, "exchange", None),
    (r"^/import-(dxf|pdf|pdf-facade|revit)|^/shaft-panels", None, S_IO, "exchange", None),
    (r"^/import-(history|contracting|schedule)-xlsx|^/import-templates", None, S_IO, "exchange", None),
    (r"^/admin/(import-input|input-files)", None, S_IO, "exchange", "import-input"),
    (r"^/admin/(backups|disk-space)", None, S_SVC, "admin", "backups"),
    (r"^/admin/db-status", None, S_SVC, "admin", "db-status"),
    (r"^/admin/db-transfer", None, S_SVC, "admin", None),
    (r"^/admin/fill-empty-scope", None, S_SVC, "admin", "fill-scope"),
    (r"^/admin/reset-status-history(/preview)?$", None, S_SVC, "admin", "reset-history"),
    (r"^/activity", None, S_SVC, "admin", "activity"),
    (r"^/admin-guide", None, S_SVC, "admin", "admin-guide"),
    (r"^/training", None, S_SVC, "admin", "training"),
    (r"^/(changelog|release-status|release-tasks|app-build)", None, S_SVC, "admin", "changelog"),
    (r"^/(schedule-versions|schedule-calc)", None, S_SCH, "picker", "schedule"),
    (r"^/(health|login|logout|login-users|v2)$|^/$", None, S_SVC, "admin", "shell-context"),
]
RULES_C = [(re.compile(p), m, s, a, sc) for p, m, s, a, sc in RULES]

# `/dictionaries/{kind}/…` — по видам справочника (реестр KINDS в app/dict_delete.py)
DICT_KIND_RULES = {
    "smu": (S_DICT, "admin", "dict-smu"), "individual": (S_DICT, "admin", "dict-individuals"),
    "subtype": (S_DICT, "admin", "subtypes"), "mark_prefix": (S_DICT, "admin", "mark-prefixes"),
    "mark": (S_DICT, "admin", None),
    "counterparty": (S_CP, "picker", "counterparties"), "agreement": (S_AG, "picker", "counterparties"),
    "specification": (S_SP, "picker", "counterparties"), "contract": (S_CT, "picker", "contracts"),
    "project": (S_PRJ, "admin", "projects-objects"), "object": (S_PRJ, "admin", "projects-objects"),
}

# служебные маршруты: не пользовательские операции (оболочка, вход, версия сборки) — считаются отдельно
TECH_PATHS = {"/", "/v2", "/health", "/login", "/logout", "/login-users", "/app-build", "/me", "/me/permissions", "/me/last-object"}
TECH_ROUTES = {"POST /activity"}      # пачка клиентских событий (телеметрия): пользователь её не вызывает

REPORT_SCREEN = {"status": "report-status", "dynamics": "report-dynamics", "delivery-schedule": "report-delivery",
                 "completion": "report-completion", "my-work": "report-mywork", "contracting-schedule": "report-contracting",
                 "analytics": "report-analytics", "block-status": "report-block-status", "block-schedule": "report-block-schedule",
                 "linear-track": "report-linear-track"}
IMPORT_SCREEN = {"/import-dxf": "upload-drawing", "/import-pdf": "pdf-import", "/import-revit": "revit-import",
                 "/import-history-xlsx": "history-import", "/import-contracting-xlsx": "contracting-import",
                 "/import-schedule-xlsx": "schedule-import", "/shaft-panels": "shaft-panels", "/import-templates": None,
                 "/export.xlsx": "export-xls", "/export.pdf": "export-pdf"}


# запасное отнесение по разделу прав (`Feature.section` в app/features.py), когда правила пути нет; отмечается в самопроверке
FEATURE_SECTION_FALLBACK = {
    "Схема объекта": (S_WS, "model"), "Рабочие места": (S_WS, "model"), "Зоны и чертёж": (S_DICT, "admin"), "Контрактация": (S_CT, "picker"),
    "Отчёты": (S_REP, "exchange"), "Справочники": (S_DICT, "admin"), "Настройки объекта": (S_SET, "admin"),
    "Загрузка данных файлом": (S_IO, "exchange"), "Ведение сервиса": (S_SVC, "admin"),
}


def classify(method, path, dict_kind=None, feature_sections=()):
    """(раздел, область, экран V2 или None, найдено ли правило). Нет правила пути — запасное отнесение по разделу прав, признак False."""
    if dict_kind is not None:
        s, a, sc = DICT_KIND_RULES.get(dict_kind, (S_DICT, "admin", None))
        return s, a, sc, True
    for rx, ms, s, a, sc in RULES_C:
        if rx.search(path) and (ms is None or method in ms):
            if s == S_REP and path.startswith("/reports/"):
                nm = re.sub(r"\.(xlsx|pdf)$", "", path[len("/reports/"):]).split("/")[0]
                sc = REPORT_SCREEN.get(nm)
            elif s == S_IO:
                for pre, scr in IMPORT_SCREEN.items():
                    if path.startswith(pre):
                        sc = scr
                        break
            return s, a, sc, True
    for fs in feature_sections:
        if fs in FEATURE_SECTION_FALLBACK:
            s, a = FEATURE_SECTION_FALLBACK[fs]
            return s, a, None, False
    return S_SVC, "прочее", None, False


# ======================================================================================================================
# Загрузка состояния одной ревизии: backend + V2 + шлюз (+ V1)
# ======================================================================================================================
def dict_kinds(src):
    """{вид: название} из реестра KINDS в `app/dict_delete.py` (по AST)."""
    text = src.read("app/dict_delete.py")
    out = {}
    if not text:
        return out
    for node in ast.parse(text).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "KINDS" for t in node.targets) and isinstance(node.value, ast.Dict):
            for k, v in zip(node.value.keys, node.value.values):
                if isinstance(k, ast.Constant) and isinstance(v, ast.Dict):
                    title = k.value
                    for kk, vv in zip(v.keys, v.values):
                        if isinstance(kk, ast.Constant) and kk.value == "title" and isinstance(vv, ast.Constant):
                            title = vv.value
                    out[k.value] = title
    return out


def expand_dictionary_routes(routes, kinds):
    """`/dictionaries/{kind}/…` — одна функция на все справочники; в матрице это отдельные операции по видам записи."""
    out = []
    for r in routes:
        if r["path"].startswith("/dictionaries/{kind}") and kinds:
            for k, title in kinds.items():
                r2 = dict(r)
                r2["path"] = r["path"].replace("{kind}", k, 1)
                r2["dict_kind"] = k
                r2["dict_title"] = title
                out.append(r2)
        else:
            out.append(r)
    return out


def strip_query_hole(p):
    """Хвостовая подстановка `…/x${query}` — это строка запроса, а не сегмент пути; `gantt.${ext}` и `/{id}` остаются."""
    return re.sub(r"(?<=[A-Za-z0-9_)\]])\{\}$", "", p)


def path_sample(p):
    """Образец пути для сверки с шаблонами шлюза (самопроверка «строки шлюза, не совпадающие ни с одним маршрутом»).
    Обычный параметр — «1» (числовой id); токен (имя параметра содержит «token») — 32 буквенно-цифровых символа:
    короткая «1» не проходит длину `{20,64}` у токенов вроде `TOKEN_URLSAFE` (write-gate.js) и самопроверка ложно
    считала строку шлюза «осиротевшей» (2026-09-22, DELETE /shaft-panels/pending/{token} — Docs/v2-progress/gaps.md)."""
    def sub(m):
        return "sample12345678901234567890123456" if "token" in m.group(0)[1:-1].lower() else "1"
    return re.sub(r"\{[^}]*\}", sub, p)


def module_screens(screens, v2_files):
    """{файл модуля V2: [id экранов]} — по реестру `screens.json` (поле `impl` и правка строки `rowEdit`)."""
    m = defaultdict(list)
    names = set(v2_files)
    for s in screens:
        impl = s.get("impl", "")
        f = None
        if impl.startswith("module:"):
            f = impl.split(":", 1)[1] + ".js"
        elif impl == "notes-edit":
            f = "card-edit.js"
        elif impl in ("read", "v1"):
            f = "read-screen.js" if impl == "read" else None
        elif impl:
            f = impl + ".js"
        if f and f in names:
            m[f].append(s["id"])
        re_ = (s.get("read") or {}).get("sections", [])
        for sec in re_:
            if sec.get("rowEdit", {}).get("kind") == "block-work" and "block-work-form.js" in names:
                m["block-work-form.js"].append(s["id"])
    for f in ("main.js", "login.js", "registry.js"):
        if f in names:
            m[f].append("shell-context")
    return m


def load_side(src, kinds_needed=True):
    """Всё, что можно узнать о ревизии без V1: маршруты (с разворотом справочников), вызовы V2, шлюз, экраны."""
    be = scan_backend(src)
    kinds = dict_kinds(src)
    routes = expand_dictionary_routes(be["routes"], kinds)
    screens_doc = json.loads(src.read("app/static/v2/screens.json") or '{"screens": []}')
    screens = screens_doc["screens"]
    holes = hole_config(screens)
    v2_files = src.files("app/static/v2", ".js")
    v2_names = [f.split("/")[-1] for f in v2_files]
    calls = []
    file_lits = {}
    file_texts = {}
    v2_call_indep_total = 0
    for rel in v2_files:
        name = rel.split("/")[-1]
        if name == "api.js":
            continue
        text = src.read(rel)
        file_texts[name] = text
        calls += scan_v2_file(name, text, holes)
        v2_call_indep_total += v2_call_count_by_regex(text)
        file_lits[name] = {t[1] for t in inv.tokenize(text) if t[0] == "str"}
    v2_call_struct_total = len(calls)     # ДО read_screen_usage/shared/fallback — те не из структурного разбора этих файлов
    # резервный проход регэкспом (см. `v2_calls_regex_fallback`): добавляет (метод, путь), которых структурный разбор
    # НЕ нашёл вовсе НИ ОДНИМ вызовом во всём файле — страховка от дефекта токенизатора на сложных вложенных шаблонах
    known_route_keys = {(c["method"], strip_query_hole(re.split(r"\?", p)[0])) for c in calls for (p, _s) in c["alts"]}
    fallback_calls = []
    for name, text in file_texts.items():
        for fb in v2_calls_regex_fallback(name, text):
            key = (fb["method"], fb["alts"][0][0])
            if key not in known_route_keys:
                known_route_keys.add(key)
                fallback_calls.append(fb)
    calls += fallback_calls
    calls += read_screen_usage(screens)
    mscreens = module_screens(screens, v2_names)
    # V2 использует общие с V1 модули адреса и карты (`import("/static/address.js")`), их запросы идут от имени V2
    shared = []
    if "projects-objects.js" in v2_names:
        for rel in ("app/static/address.js", "app/static/map.js"):
            t = src.read(rel)
            if t:
                res, *_ = scan_js_paths(t, rel.split("/")[-1])
                for u in res:
                    shared.append({"file": "projects-objects.js", "line": u["line"], "api": "shared:" + rel.split("/")[-1], "method": u["method"],
                                   "alts": [(u["path"], None)], "func": u["func"], "raw_arg": u["path"]})
    calls += shared
    usages = []
    for c in calls:
        for (p, scr) in dict.fromkeys(c["alts"]):
            p = strip_query_hole(p)          # хвост «?query»-подстановки
            if not p.startswith("/") or p.startswith("/static/") or p == "{}":
                continue
            for pp in expand_kind_holes(p, kinds, file_lits.get(c["file"], set()), mscreens.get(c["file"])):
                usages.append({"path": pp, "method": c["method"], "file": c["file"], "line": c["line"], "api": c["api"], "func": c["func"],
                               "screens": [scr] if scr else mscreens.get(c["file"], []), "resolved_screen": bool(scr)})
    by_route, unmatched = match_usages(routes, usages)
    matched_calls = {(u["file"], u["line"], u["api"]) for us in by_route.values() for u in us}
    unmatched = [u for u in unmatched if (u["file"], u["line"], u["api"]) not in matched_calls]
    gate = eval_gate(src)
    return {"src": src, "be": be, "routes": routes, "kinds": kinds, "screens": screens, "screens_doc": screens_doc, "gate": gate,
            "v2_calls": calls, "v2_usages": usages, "v2_by_route": by_route, "v2_unmatched": unmatched, "module_screens": mscreens,
            "unresolved_calls": [c for c in calls if not c["alts"]],
            "v2_call_struct_total": v2_call_struct_total, "v2_call_indep_total": v2_call_indep_total, "v2_fallback_calls": fallback_calls}


def expand_kind_holes(path, kinds, file_strs, screens_of_module=None):
    """`/dictionaries/{}/…` (вид записи задан переменной) → варианты по видам. У модуля V2 виды сужаются экранами модуля
    (`counterparties.js` → контрагент, договор, спецификация, контракт); иначе — по строкам, встречающимся в файле."""
    if path.startswith("/dictionaries/{}") and kinds:
        cand = []
        if screens_of_module:
            cand = [k for k in kinds if DICT_KIND_RULES.get(k, (None, None, None))[2] in screens_of_module]
        if not cand:
            cand = [k for k in kinds if k in file_strs] or list(kinds)
        return [path.replace("{}", k, 1) for k in cand]
    return [path]


# ======================================================================================================================
# V1: обращения с точками входа
# ======================================================================================================================
def _aff_tokens(path):
    toks = []
    for seg in _segs(path):
        if seg.startswith("{") or seg == "{}":
            continue
        t = re.sub(r"[^a-z]", "", re.sub(r"\.(xlsx|pdf)$", "", seg.lower()))
        if len(t) >= 4:
            toks.append(t)
    return toks


def load_v1(src, screens):
    html = src.read("app/static/index.html") or ""
    tree = inv.Tree()
    tree.feed(html)
    js_text = src.read("app/static/app.js") or ""
    G = V1Graph(js_text, tree)
    reach = G.entry_reach()
    res, toks, funs, owner = scan_js_paths(js_text, "app.js")
    entry_screen = {}
    for s in screens:
        for i in s.get("v1", {}).get("menu", []):
            entry_screen[("menu", i)] = s["id"]
        for i in s.get("v1", {}).get("modals", []):
            entry_screen[("modal", i)] = s["id"]
        for i in s.get("v1", {}).get("toolbar", []):
            entry_screen[("toolbar", i)] = s["id"]
    # диапазоны обработчиков для токенов вне именованных функций
    intervals = []
    modal_of_button = {}
    for m in G.modals:
        for b in m["buttons"]:
            modal_of_button[b["id"]] = m["id"]
    for eid, rngs in G.roots.items():
        for (a, b) in rngs:
            intervals.append((a, b, eid))
    intervals.sort()

    def keys_of_eid(eid):
        ks = []
        if ("menu", eid) in G.entries:
            ks.append(("menu", eid))
        if ("toolbar", eid) in G.entries:
            ks.append(("toolbar", eid))
        if eid in modal_of_button:
            ks.append(("modal", modal_of_button[eid]))
        return ks

    kind_order = {"menu": 0, "toolbar": 1, "modal": 2}

    def entries_for(tok_i, path):
        """Кандидаты точек входа для обращения: {ключ: расстояние} (не более 12 ближайших) и признак «общий код»."""
        cands = {}
        for (a, b, eid) in intervals:
            if a <= tok_i <= b:
                for k in keys_of_eid(eid):
                    cands[k] = min(cands.get(k, 99), 0.5)
        fi = owner[tok_i]
        if fi >= 0:
            for k, dmap in reach.items():
                if fi in dmap:
                    cands[k] = min(cands.get(k, 99), dmap[fi])
        if not cands:
            return {}, False
        dmin = min(cands.values())
        sel = {k: d for k, d in cands.items() if d <= dmin + 2}
        generic = len(sel) > 12
        if generic:
            sel = dict(sorted(sel.items(), key=lambda kv: (kv[1], kind_order[kv[0][0]], kv[0][1]))[:12])
        return sel, generic

    usages = []
    for u in res:
        keys, generic = entries_for(u["tok"], u["path"])
        u["entries"] = keys          # {(вид, id): расстояние}
        u["generic"] = generic
        usages.append(u)
    # обращения из соседних скриптов V1
    for rel in V1_EXTRA_FILES + [f for f in src.files("app/static/external-models", ".js")]:
        t = src.read(rel)
        if not t:
            continue
        name = rel.split("static/")[-1]
        r2, *_ = scan_js_paths(t, name)
        base = name.split("/")[-1]
        keys = list(V1_FILE_ENTRIES.get(base, [])) or ([("menu", "menu-external-models")] if name.startswith("external-models/") else [])
        for u in r2:
            u["entries"] = {k: 1 for k in keys if k in G.entries}
            u["generic"] = False
            usages.append(u)
    # таблица отчётов V1 (`REPORTS = { status: {endpoint: "/reports/status"} }`) лежит вне функций: точка входа — пункт меню
    # «Отчёты › …» с тем же именем (`menu-report-status` ↔ `/reports/status`)
    for u in usages:
        if u["how"] == "endpoint" and not u.get("entries"):
            last = re.sub(r"[^a-z]", "", _segs(u["path"])[-1].lower())
            ents = {}
            for k in G.entries:
                if k[0] == "menu" and k[1].startswith("menu-report-"):
                    suffix = re.sub(r"[^a-z]", "", k[1][len("menu-report-"):].lower())
                    if suffix and (suffix == last or suffix in last or last in suffix):
                        ents[k] = 1
            u["entries"] = ents
    # варианты `.xlsx` / `.pdf` отчётов: `downloadReport(суффикс)` дописывает их к `endpoint`
    extra = []
    for u in usages:
        if u["how"] == "endpoint":
            for ext in ("xlsx", "pdf"):
                v = dict(u)
                v["path"] = u["path"] + "." + ext
                v["synthetic"] = True
                extra.append(v)
    usages += extra
    return {"graph": G, "reach": reach, "usages": usages, "entry_screen": entry_screen, "toks": toks, "funs": funs, "owner": owner}


def dynamic_v1_calls(src):
    """Вызовы `api(`/`fetch(` в V1, у которых первый аргумент не литерал-путь (переменная, свойство, вызов) — «слепые пятна» разбора.
    Возвращает (всего вызовов, список нелитеральных)."""
    out = []
    total = 0
    for rel in ["app/static/app.js", "app/static/chess-flat.js", "app/static/map.js", "app/static/address.js", "app/static/shaft-panels.js",
                "app/static/external-models/settings.js"]:
        text = src.read(rel)
        if not text:
            continue
        toks = inv.tokenize(text)
        for i, (k, v, l) in enumerate(toks):
            if k == "id" and v in ("api", "fetch", "downloadFromServer", "sendBeacon") and _t(toks, i + 1)[1] == "(" and _t(toks, i - 1)[1] != "function":
                total += 1
                pc = inv.match_paren(toks, i + 1)
                depth, arg = 0, []
                for t in toks[i + 2:pc]:
                    if t[0] == "p" and t[1] in ("(", "[", "{"):
                        depth += 1
                    elif t[0] == "p" and t[1] in (")", "]", "}"):
                        depth -= 1
                    elif t[0] == "p" and t[1] == "," and depth == 0:
                        break
                    arg.append(t)
                if not any(t[0] in ("str", "tpl") and (t[1].startswith("/") or t[1].startswith("${")) for t in arg):
                    out.append(f"{rel.split('/')[-1]}:{l} {v}({' '.join(str(t[1]) for t in arg)[:60]})")
    return total, out


def client_ops(src, v1):
    """Операции без API: печать, копирование в буфер (клиентская часть V1) — по токенам `print(`/`clipboard`."""
    out = []
    G = v1["graph"]
    for rel in ["app/static/app.js", "app/static/chess-flat.js"]:
        text = src.read(rel)
        if not text:
            continue
        toks = inv.tokenize(text)
        funs = js_functions(toks)
        owner = innermost_owner(len(funs), funs, len(toks))
        for i, (k, val, ln) in enumerate(toks):
            kind = None
            if k == "id" and val == "print" and i >= 2 and toks[i - 1][1] == "." and toks[i - 2][1] == "window" and _t(toks, i + 1)[1] == "(":
                kind = "print"
            elif k == "id" and val == "clipboard" and i >= 2 and toks[i - 1][1] == "." and toks[i - 2][1] == "navigator":
                kind = "clipboard"
            if kind:
                fi = owner[i]
                fname = funs[fi][0] if fi >= 0 else None
                out.append({"kind": kind, "file": rel.split("/")[-1], "line": ln, "func": fname, "tok": i, "path": rel})
    # точки входа
    res = []
    for c in out:
        keys = []
        if c["file"] == "app.js":
            # обработчик на месте (`report-print` → window.print) или через функцию
            for (a, b, eid) in [(a, b, e) for e, rr in G.roots.items() for (a, b) in rr]:
                if a <= c["tok"] <= b:
                    if ("menu", eid) in G.entries or ("toolbar", eid) in G.entries:
                        keys.append(("toolbar" if ("toolbar", eid) in G.entries else "menu", eid))
                    else:
                        keys.append(("element", eid))
        else:
            keys = list(V1_FILE_ENTRIES.get(c["file"], []))
        c["entries"] = keys
        res.append(c)
    return res


def storage_sites(src, files):
    """Места записи настроек вида в браузер (`localStorage.setItem`/`sessionStorage.setItem`) — по токенам; {файл: число}."""
    out = {}
    for rel in files:
        text = src.read(rel)
        if not text:
            continue
        toks = inv.tokenize(text)
        n = sum(1 for i, t in enumerate(toks) if t[0] == "id" and t[1] in ("localStorage", "sessionStorage") and _t(toks, i + 1)[1] == "."
                and _t(toks, i + 2)[1] == "setItem")
        if n:
            out[rel.split("/")[-1]] = n
    return out


CLIENT_TEXT = {
    ("print", "report-print"): "Печать отчёта (окно печати браузера)",
    ("print", "doPrintAction"): "Печать бланка обхода шахматки, форматы A4/A3 (окно печати браузера)",
    ("clipboard", "copyText"): "Копирование текста в буфер обмена (памятка администратора)",
}


# ======================================================================================================================
# Сборка матрицы
# ======================================================================================================================
# Ресурсы, адрес которых V1 не пишет в коде, а получает от сервера или библиотеки (`<img src>` из ответа, плитки карты): статический разбор
# их не видит, поэтому без этой пометки они выглядели бы «не вызываемыми». Перечень короткий и проверяемый вручную.
INDIRECT_USE = {
    ("GET", "/objects/{object_id}/plan-images/{level_id}.png"): {"note": "картинка подложки: адрес приходит в ответе GET /objects/{id}/plan-images", "scene": True},
    ("GET", "/map/tiles/{name}"): {"note": "плитки карты: адрес формирует библиотека карты по настройкам GET /map/config", "scene": False},
}

# Данные, которые читает сцена схемы V1 в кадре рабочих мест V2 (Docs/v2-workspaces.md §1–2, протокол zhbi-scene/1). Перечень
# ограничивает граф вызовов от bootApp (в нём много несвязанного: список пользователей, обновления и т.п.).
SCENE_DATA_RE = re.compile(r"^(/plan-data|/changes|/source-files|/elements/changed|/elements/\{[^}]+\}|/elements/\{[^}]+\}/activity|/revit-plan/[a-z]+|"
                           r"/objects/\{[^}]+\}/(grids|plan-images|plan-images/\{[^}]+\}\.png|blocks/geometry|blocks/planning-tracks|blocks/\{[^}]+\}/card|"
                           r"external-models|external-models/\{[^}]+\}/content))$")
READ_POST_RE = re.compile(r"^/reports/|^/export\.|/export$|/export\.(xlsx|pdf)$|^/plan-data$|^/elements/changed$|^/schedule-versions/deviation$|"
                          r"/chess-flat-export|^/ldap-search$|^/reports/delivery-schedule/cell$|"
                          # предпросмотры (считают последствия, ничего не пишут) — вызываются через api.readPost(), не через
                          # запись, значит write-gate.js POLICY им не нужен (app/static/v2/api.js: request(), read:true пропускает
                          # checkWrite целиком); без этой строки ANALYZE_RE ловил бы «…/preview» effect=analyze и генератор ошибочно
                          # требовал бы строку шлюза — «в V2, но отключена шлюзом» вместо факта (2026-09-22, gaps.md)
                          r"^/objects/\{[^}]+\}/block-works/bulk-preview$|^/objects/\{[^}]+\}/blocks/work-types-settings/preview$")
ANALYZE_RE = re.compile(r"/analyze|/parse$|/settings/test$|/preview$|/analyze/start$")
FILE_OUT_RE = re.compile(r"\.(pdf|xlsx|md|png)$|/download$|/content$|/sample$|/export$|^/export\.")
V1_PATHS_IGNORE = ("/static", "/v2")
VERB_RU = {"GET": "Просмотр", "POST": "Создание / действие", "PATCH": "Изменение", "PUT": "Сохранение", "DELETE": "Удаление"}

SECTION_WEIGHT = {S_WS: 5, S_BLK: 5, S_CT: 4, S_DOC: 4, S_CP: 4, S_AG: 4, S_SP: 4, S_REP: 3, S_IO: 3, S_PRJ: 3, S_USR: 3, S_SCH: 3,
                  S_DICT: 2, S_SET: 1, S_SVC: 1}
RARE_RE = re.compile(r"db-transfer|/restore|reset-status-history|/cleanup|/impersonate|release-tasks|ldap|/me/last-object|fill-empty-scope|"
                     r"backups|disk-space|db-status|admin-guide|/activity/stats|/app-build|address/(fetch|unpack|upload|load)")


def effect_of(method, path):
    if method in ("GET", "HEAD"):
        return "read"
    if READ_POST_RE.search(path):
        return "read-post"
    if ANALYZE_RE.search(path):
        return "analyze"
    return "write"


def is_ru(text):
    letters = re.findall(r"[A-Za-zА-Яа-яЁё]", text or "")
    if not letters:
        return False
    return sum(1 for c in letters if re.match(r"[А-Яа-яЁё]", c)) / len(letters) > 0.5


def check_level(text):
    t = (text or "").lower()
    if not t:
        return "не проверено"
    if "на настоящем backend" in t or "настоящий backend" in t or "настоящем backend" in t or "живая проверка" in t or "по http" in t:
        return "настоящий backend"
    if "стенд" in t:
        return "стенд (имитация)"
    if "каркас" in t:
        return "каркас, не проверено"
    return "не проверено"


VERIFY_PY_GLOB_PREFIX = "verify_"


def verify_sources(src):
    """{путь файла: текст} — проверочные наборы, которые МОГУТ доказывать работоспособность операции (по коду, а не по
    самоотчёту `proof` строки шлюза — «наличие разрешения в шлюзе не является доказательством работоспособности»):
    `scripts/verify_*.py`, `scripts/verify_*.mjs`, `scripts/picker_verify/*.mjs`, `scripts/v2_tests/exchange/chk_*.mjs`
    (в т.ч. `scripts/verify_mfr_browser_*.mjs` — подпадает под `verify_*.mjs`)."""
    out = {}
    for rel in src.files("scripts", ".py"):
        if rel.split("/")[-1].startswith(VERIFY_PY_GLOB_PREFIX):
            out[rel] = src.read(rel) or ""
    for rel in src.files("scripts", ".mjs"):
        name = rel.split("/")[-1]
        if name.startswith("verify_") or rel.startswith("scripts/picker_verify/") or rel.startswith("scripts/v2_tests/exchange/chk_"):
            out[rel] = src.read(rel) or ""
    return out


def route_signature_re(path):
    """Регэксп по СЕГМЕНТАМ маршрута (параметр `{...}` → любой непустой сегмент без «/»); совпадению должна
    предшествовать кавычка/обратная кавычка/начало текста — иначе короткие пути (`/users`) ложно совпадали бы внутри
    прозы комментария. Используется, чтобы найти, ссылается ли КОД проверочного набора на этот путь — не текстовый
    пересказ («живая проверка») из `proof` строки шлюза, а факт наличия набора, который его вызывает."""
    segs = _segs(path)
    if not segs:
        return None
    parts = [r"[^/\s\"'`]+" if s.startswith("{") else re.escape(s) for s in segs]
    body = "/" + "/".join(parts)
    return re.compile(r"(?:^|[\"'`])" + body)


def proof_for_op(path, verify_idx, scr):
    """Источники, чей код (проверочный скрипт) или `screens.json.checks` экрана ссылаются на путь операции — «наличие
    проверочного набора», не факт разрешения шлюза. Пустой список → «не проверена»."""
    rx = route_signature_re(path)
    if rx is None:
        return []
    hits = sorted(name for name, text in verify_idx.items() if rx.search(text))
    if scr and scr.get("checks") and rx.search(scr["checks"]):
        hits.append(f"screens.json:{scr['id']}")
    return hits


def shorten(text, n=220):
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[:n - 1].rstrip() + "…"


def build_matrix(cur_ref, pub_ref):
    cur, pub = Source(cur_ref), Source(pub_ref)
    C = load_side(cur)
    P = load_side(pub)
    verify_idx = verify_sources(cur)
    screens = {s["id"]: s for s in C["screens"]}
    pub_screens = {s["id"]: s for s in P["screens"]}
    v1 = load_v1(cur, C["screens"])
    G = v1["graph"]
    routes = C["routes"]
    # обращения V1 → маршруты
    v1_usages = [u for u in v1["usages"] if not u["path"].startswith(V1_PATHS_IGNORE)]
    for u in v1_usages:
        u["path"] = strip_query_hole(u["path"])          # хвост `${query}` — не сегмент пути
    # варианты по видам справочника у динамических обращений V1
    expanded = []
    app_strs = {t[1] for t in v1["toks"] if t[0] == "str"}
    for u in v1_usages:
        for pp in expand_kind_holes(u["path"], C["kinds"], app_strs):
            v = dict(u)
            v["path"] = pp
            expanded.append(v)
    v1_by_route, v1_unmatched = match_usages(routes, expanded)
    v1_unmatched = [u for u in v1_unmatched if not u.get("synthetic")]
    # сцена V1 в кадре: GET-чтения, достижимые из bootApp
    boot_idx = G.byname.get("bootApp", [])
    scene_funcs = set(G.bfs(set(boot_idx), 6)) if boot_idx else set()
    scene_routes = set()
    for u in v1_usages:
        fi = v1["owner"][u["tok"]] if "tok" in u and u["file"] == "app.js" else -1
        if fi in scene_funcs and u["method"] in ("GET", "POST") and u["file"] == "app.js":
            scene_routes.add((u["method"], u["path"]))
    scene_by_route, _ = match_usages([r for r in routes if r["method"] in ("GET", "POST")],
                                      [{"path": p, "method": m} for (m, p) in scene_routes])
    scene_keys = {k for k in scene_by_route if SCENE_DATA_RE.match(k[1])}
    pub_scene_ok = any(f.endswith("workspace.js") for f in pub.files("app/static/v2", ".js")) and any(s.get("impl") == "workspace" for s in P["screens"])
    pub_route_keys = {(r["method"], r["path"]) for r in P["routes"]}
    entry_screen = v1["entry_screen"]

    ops = []
    for r in routes:
        key = (r["method"], r["path"])
        fsecs = [C["be"]["feats"].get(k, {}).get("section") for k in r["feature_keys"]]
        sec, area, hint, found = classify(r["method"], r["path"], r.get("dict_kind"), fsecs)
        eff = effect_of(r["method"], r["path"])
        tech = r["path"] in TECH_PATHS or f"{r['method']} {r['path']}" in TECH_ROUTES
        v1u = v1_by_route.get(key, [])
        v2u = C["v2_by_route"].get(key, [])
        pv2u = P["v2_by_route"].get(key, [])
        indirect = INDIRECT_USE.get(key)
        scene = (key in scene_keys or bool(indirect and indirect["scene"])) and eff in ("read", "read-post")
        # шлюз
        sample = path_sample(r["path"])
        allowed, disabled = gate_for(C["gate"], r["method"], sample) if eff in ("write", "analyze") else ([], [])
        pallowed, _pd = gate_for(P["gate"], r["method"], sample) if eff in ("write", "analyze") else ([], [])
        restricted = any(a["onlyKeys"] or a["hasCheck"] for a in allowed)
        # область по блоку шлюза (`// ==== область: ИМЯ ====`) точнее правила по пути: путь у операций разных
        # исполнителей бывает общим (например, у учёта по блокам и обмена данными), а блок шлюза — объявление
        # исполнителя, чья это строка (BRIEF: «строки — ТОЛЬКО в блоке своей области»)
        gate_areas = {a["area"] for a in (allowed + disabled) if a.get("area")}
        if len(gate_areas) == 1:
            (ga,) = gate_areas
            if ga in AREAS and ga != area:
                area = ga
        # экраны V2, где операция реализована
        v2_screens = []
        for row in allowed:                       # у строки шлюза известен свой экран (ws-model / ws-picker …)
            if row["screen"] in screens and row["screen"] not in v2_screens:
                v2_screens.append(row["screen"])
        if not v2_screens:
            for u in v2u:
                for sid in u["screens"]:
                    if sid and sid not in v2_screens:
                        v2_screens.append(sid)
        # экран V2 «по замыслу»: правило пути или экран, которому принадлежит точка входа V1
        v1_cands = {}
        for u in v1u:
            for k, d in u.get("entries", {}).items():
                v1_cands[k] = min(v1_cands.get(k, 99), d)
        v1_screens = []
        for k, d in sorted(v1_cands.items(), key=lambda kv: (kv[1], kv[0])):
            sid = entry_screen.get(k)
            if sid and sid not in v1_screens:
                v1_screens.append(sid)
        primary = v2_screens[0] if v2_screens else (hint if hint in screens else (v1_screens[0] if v1_screens else None))
        scr = screens.get(primary) if primary else None
        # точки входа V1: сначала принадлежащие экрану операции, иначе ближайшие
        keys = list(v1_cands)
        want = hint if hint in screens else primary
        exact = False
        if want:
            own = [k for k in keys if entry_screen.get(k) == want]
            if own:
                keys, exact = own, True
        if len(keys) > 3:
            aff = _aff_tokens(r["path"])
            hit = [k for k in keys if any(t in re.sub(r"[^a-z]", "", k[1].lower()) for t in aff)]
            if hit:
                keys = hit
        kind_order = {"menu": 0, "toolbar": 1, "modal": 2}
        keys = sorted(keys, key=lambda k: (v1_cands[k], kind_order.get(k[0], 3), k[1]))[:3]
        if not exact and len(v1_cands) > 2:
            keys = []          # ни одна точка входа не принадлежит экрану операции, а кандидатов много: это общий код (загрузка, опрос, справочники)
            generic_v1 = True
        else:
            generic_v1 = False
        v1_entries = [G.entries[k]["label"] if k in G.entries else f"элемент `{k[1]}`" for k in keys]
        v1_calls = []
        generic = generic_v1
        for u in v1u:
            generic = generic or bool(u.get("generic"))
            call = f"{u['file']}:{u['line']}" + (f" {u['func']}()" if u.get("func") else "")
            if call not in v1_calls:
                v1_calls.append(call)
        # состояние реализации в V2
        v2_impl = bool(v2u) or scene
        if tech:
            state = "tech"
        elif eff in ("read", "read-post"):
            if v2_impl:
                pub_impl = bool(pv2u) or (scene and pub_scene_ok)
                state = "published" if pub_impl and key in pub_route_keys else "branch"
            elif not v1u and not indirect:
                state = "unused"
            else:
                state = "only_v1" if scr else "none"
        else:
            if v2u:
                if allowed:
                    pub_impl = bool(pv2u) and bool(pallowed) and key in pub_route_keys
                    state = "published" if pub_impl else "branch"
                else:
                    state = "gate_disabled"
            elif not v1u:
                state = "unused"
            else:
                state = "only_v1" if scr else "none"
        # проверки — доказательство работоспособности: НЕ факт разрешения шлюза (строка `proof` — самоотчёт исполнителя
        # внутри той же строки, что и `allowed`), а наличие проверочного набора, чей код ссылается на этот путь
        if state in ("only_v1", "none", "tech", "unused"):
            chk_level, chk_note, verify_hits = "—", "", []
        else:
            verify_hits = proof_for_op(r["path"], verify_idx, scr)
            if verify_hits:
                screens_hit = next((h for h in verify_hits if h.startswith("screens.json:")), None)
                chk_level = check_level(scr["checks"]) if screens_hit and scr else "проверена"
                scripts_hit = [h for h in verify_hits if not h.startswith("screens.json:")]
                chk_note = ("; ".join(scripts_hit) + (" · и " if scripts_hit and screens_hit else "") + (shorten(scr["checks"], 200) if screens_hit and scr else "")).strip(" ·")
            else:
                chk_level, chk_note = "не проверена", ""
        status = scr["status"] if scr else None
        # права
        ptxt = r["perm_text"] or ("без входа" if not r["perms"] else "")
        # сценарий
        scenario = scenario_for(r, C, allowed, v1_entries, scr)
        op = {
            "id": f"{r['method']} {r['path']}", "kind": "route", "method": r["method"], "path": r["path"],
            "section": sec, "area": area, "area_rule_found": found, "effect": eff, "tech": tech,
            "download": bool(FILE_OUT_RE.search(r["path"])) and eff != "write",
            "scenario": shorten(scenario, 240), "backend": f"{r['file']}:{r['line']} {r['func']}",
            "perms": ptxt, "perm_items": r["perm_items"], "feature_keys": r["feature_keys"],
            "v1": {"used": bool(v1u) or bool(indirect), "entries": v1_entries, "calls": v1_calls[:3] + ([indirect["note"]] if indirect else []),
                   "generic_entry": generic},
            "v2": {"state": state, "impl": v2_impl, "scene": scene,
                   "calls": [f"{u['file']}:{u['line']}" for u in v2u][:4], "modules": sorted({u["file"] for u in v2u}),
                   "screens": v2_screens, "screen": primary, "screen_title": scr["title"] if scr else None,
                   "screen_impl": scr.get("impl") if scr else None, "screen_status": status,
                   },
            "gate": {"applies": eff in ("write", "analyze"), "restricted": restricted,
                     "allowed_rows": [{"id": a["id"], "onlyKeys": a["onlyKeys"], "check": a["checkName"], "proof": a["proof"]} for a in allowed],
                     "disabled_rows": [{"id": d["id"], "why": d["why"], "screen": d["screen"], "action": d["action"]} for d in disabled]},
            "checks": {"level": chk_level, "note": chk_note, "sources": verify_hits},
            "published": state == "published",
            "hint_screen": hint,
        }
        op["action"] = derive_action(op, scr, C)
        op["priority"] = priority_of(op)
        ops.append(op)
    # клиентские операции (без API)
    for c in client_ops(cur, v1):
        labs = []
        for k in c["entries"]:
            if k in G.entries:
                labs.append(G.entries[k]["label"])
            elif k[0] == "element":
                labs.append(f"кнопка `{k[1]}`")
        txt = CLIENT_TEXT.get((c["kind"], c["func"])) or next((CLIENT_TEXT[(c["kind"], k[1])] for k in c["entries"] if (c["kind"], k[1]) in CLIENT_TEXT), None) \
            or f"Клиентская операция «{c['kind']}» (функция {c['func'] or 'верхнего уровня'})"
        hint = "chess-flat" if c["file"] == "chess-flat.js" else ("report-status" if c["kind"] == "print" and c["file"] == "app.js" else "admin-guide" if c["kind"] == "clipboard" else None)
        sec = S_REP if c["kind"] == "print" and c["file"] == "app.js" else (S_BLK if c["file"] == "chess-flat.js" else S_SVC)
        area = "exchange" if sec == S_REP else ("mfr" if sec == S_BLK else "admin")
        scr = screens.get(hint)
        op = {"id": f"КЛИЕНТ {c['file']}:{c['line']}", "kind": "client", "method": "КЛИЕНТ", "path": f"(без API) {c['file']}:{c['line']}",
              "section": sec, "area": area, "area_rule_found": True, "effect": "client", "tech": False, "download": False,
              "scenario": txt, "backend": "нет маршрута: выполняется в браузере", "perms": "как у экрана V1", "perm_items": [], "feature_keys": [],
              "v1": {"used": True, "entries": labs[:3], "calls": [f"{c['file']}:{c['line']} {c['func'] or ''}".strip()], "generic_entry": False},
              "v2": {"state": "none", "impl": False, "scene": False, "calls": [], "modules": [], "screens": [], "screen": hint,
                     "screen_title": scr["title"] if scr else None, "screen_impl": scr.get("impl") if scr else None,
                     "screen_status": scr["status"] if scr else None},
              "gate": {"applies": False, "allowed_rows": [], "disabled_rows": []}, "checks": {"level": "—", "note": "", "sources": []}, "published": False,
              "hint_screen": hint}
        op["v2"]["state"] = "only_v1" if scr else "none"
        op["action"] = derive_action(op, scr, C)
        op["priority"] = priority_of(op)
        ops.append(op)
    # запоминание настроек вида в браузере — одна сводная строка (это не операция с сервером и не отдельный сценарий)
    v1_files = ["app/static/app.js"] + V1_EXTRA_FILES
    v2_files = C["src"].files("app/static/v2", ".js")
    st1, st2 = storage_sites(cur, v1_files), storage_sites(cur, v2_files)
    if st1:
        ops.append({
            "id": "КЛИЕНТ localStorage", "kind": "client", "method": "КЛИЕНТ", "path": "(без API) настройки вида в браузере (localStorage)",
            "section": S_SET, "area": "прочее", "area_rule_found": True, "effect": "client", "tech": True, "download": False,
            "scenario": "Запоминание в браузере настроек вида: режим вида, скин, ширина панелей, свёрнутые секции, последняя вкладка окна",
            "backend": "нет маршрута: выполняется в браузере", "perms": "—", "perm_items": [], "feature_keys": [],
            "v1": {"used": True, "entries": [], "calls": [f"{f}: {n} мест" for f, n in st1.items()], "generic_entry": False},
            "v2": {"state": "tech", "impl": bool(st2), "scene": False, "calls": [f"{f}: {n} мест" for f, n in st2.items()], "modules": sorted(st2),
                   "screens": [], "screen": None, "screen_title": None, "screen_impl": None, "screen_status": None},
            "gate": {"applies": False, "restricted": False, "allowed_rows": [], "disabled_rows": []}, "checks": {"level": "—", "note": "", "sources": []},
            "published": False, "hint_screen": None,
            "action": (f"сводная строка, в счёт не входит: в V1 {sum(st1.values())} мест записи настроек вида, в V2 {sum(st2.values())} (собственные); "
                       "совпадение набора не проверялось — при переносе экрана сверить, какие настройки вида пользователь ожидает сохранить"),
            "priority": -99,
        })
    for o in ops:
        apply_replacement(o)
    used_replacements = {o["id"] for o in ops if o.get("replaced_by")}
    stale_replacements = sorted(set(REPLACED_BY) - used_replacements)
    blockers = load_blockers()
    for o in ops:
        apply_blocker(o, blockers)
    used_blockers = {o["id"] for o in ops if o.get("blocked_reason")}
    stale_blockers = sorted(set(blockers) - used_blockers)
    ops.sort(key=lambda o: (SECTIONS.index(o["section"]) if o["section"] in SECTIONS else 99, o["path"], o["method"]))
    for i, o in enumerate(ops, 1):
        o["n"] = i
    return {"ops": ops, "C": C, "P": P, "v1": v1, "v1_by_route": v1_by_route, "v1_unmatched": v1_unmatched,
            "cur": cur, "pub": pub, "screens": screens, "pub_screens": pub_screens, "scene_keys": scene_keys,
            "stale_blockers": stale_blockers, "stale_replacements": stale_replacements}


ACTION_RU = {
    "apply": "Применение сверенных изменений", "analyze": "Сверка файла перед применением", "export": "Выгрузка", "post": "Проведение",
    "unpost": "Отмена проведения", "undo": "Отмена", "bulk": "Массовое сохранение", "close-others": "Завершение остальных сеансов",
    "set-password": "Задание пароля", "impersonate": "Вход от имени пользователя", "recalc-membership": "Пересчёт принадлежности блоков",
    "allocations": "Распределение изделий", "delete": "Удаление", "restore": "Восстановление из копии", "ack": "Отметка «Ознакомился»",
    "test": "Проверка подключения", "upload": "Загрузка файла", "stage": "Приём файла", "forget": "Сброс приёма файла", "cleanup": "Очистка",
    "run": "Запуск обработки", "answer": "Ответ на вопрос", "start": "Запуск", "progress": "Ход выполнения", "candidates": "Кандидаты для замены",
    "delete-plan": "План последствий удаления", "context": "Контекст", "activity": "Действия", "card": "Карточка", "geometry": "Геометрия",
    "download": "Скачивание", "content": "Содержимое", "fetch": "Загрузка с сайта ФНС", "unpack": "Распаковка", "load": "Загрузка",
    "load-status": "Ход загрузки", "check-house": "Проверка дома", "resolve": "Разбор кода", "changed": "Изменённые элементы", "access": "Доступ",
    "avatar": "Превью", "sample": "Образец файла", "recenter": "Перецентровка", "chess-flat-batch": "Пакетный ввод факта", "parse": "Разбор файла",
}
NOUN_RU = {
    "settlements": "населённые пункты (классификатор адресов)", "streets": "улицы (классификатор адресов)", "houses": "номера домов (классификатор адресов)",
    "health": "проверка работоспособности сервера", "element": "карточка элемента модели МФР", "tables": "строки таблицы БД",
    "bulk-edit": "массовая правка через Excel", "import-dxf": "загрузка чертежа DXF", "import-pdf": "загрузка планировок из PDF",
    "import-pdf-facade": "загрузка фасада из PDF", "import-revit": "загрузка из Revit", "objects-import": "загрузка справочника объектов из Excel",
    "import-history-xlsx": "импорт истории статусов из XLS", "import-contracting-xlsx": "импорт контрактации из XLS",
    "import-schedule-xlsx": "импорт графика MS Project из XLS", "clear-import-data": "очистка данных импорта объекта",
    "chess-flat-export": "плоская шахматка", "chess-flat-layout": "плоская шахматка (раскладка)", "chess-flat-batch": "плоская шахматка (пакет факта)",
    "fact-changes": "изменения факта", "track-progress": "выполнение по трекам", "progress": "выполнение блока", "active-counts": "счётчики активных работ",
    "recalc-membership": "принадлежность блоков", "geometry": "геометрия", "card": "карточка блока", "planning-tracks": "треки планирования",
    "axis-grid": "сетка осей", "layers": "слои чертежа", "status-summary": "сводка по статусам", "changes": "изменения элементов чертежа",
    "blocks": "блоки объекта", "block-works": "запланированные работы", "sections": "секции", "levels": "этажи и уровни", "boxes": "геометрия блока",
    "fact-reports": "отчёты о выполнении (факт)", "work-types-settings": "настройки видов работ", "work-progress": "выполнение работ",
    "work-progress-cell": "процент выполнения в ячейке", "work-types": "виды работ", "block-work-types": "виды работ блока",
    "planning-tracks": "треки планирования", "plan-images": "подложки планов", "grids": "оси", "fact-journal": "журнал факта",
    "external-models": "внешние 3D-модели", "counterparties": "контрагенты", "agreements": "договоры", "specifications": "спецификации",
    "contracts": "контракты", "default-map": "контракт по умолчанию по типу", "positions": "позиции контрактов", "supplier-changes": "документы контрактации",
    "users": "пользователи", "roles": "роли", "features": "матрица прав ролей", "order": "порядок ролей", "sessions": "сеансы", "access-matrix": "сводка доступа",
    "rights-matrix": "матрица прав пользователя", "projects": "проекты", "objects": "объекты", "projects-tree": "дерево проектов и объектов",
    "attachments": "вложения", "smu": "СМУ", "individuals": "физлица", "allowed-subtypes": "подтипы элементов", "mark-type-prefixes": "префиксы марок",
    "marks": "марки", "zones": "зоны", "zone-colors": "цвета зон", "status-colors": "цвета статусов", "element-shapes": "формы маркеров",
    "layer-type-combinations": "сочетания слой/тип", "label-visibility": "видимость подписей", "label-dates-visibility": "видимость дат в подписях",
    "elements": "элементы", "status": "статус", "comment": "комментарий", "contract": "контракт изделия", "planned-delivery-date": "плановая дата поставки",
    "fields": "реквизиты", "history": "история статусов", "bulk-status": "массовая смена статуса", "bulk-planned-delivery-date": "массовая плановая дата",
    "backups": "резервные копии", "db-status": "состояние БД", "db-transfer": "перенос базы", "activity": "журнал действий", "training": "обучение",
    "attempts": "попытки теста", "ratings": "итоги обучения", "guide": "инструкция", "schedule-versions": "версии графика СМР", "schedule-calc": "расчёт графика СМР",
    "inputs": "исходные данные расчёта", "gantt": "диаграмма Ганта", "deviation": "отклонение графика", "changelog": "журнал версий",
    "settings": "настройки", "project-card": "карточка объекта", "report-notes": "события, задачи, вопросы", "info-plate": "порог опоздания поставки",
    "revit-plan": "модель МФР", "colors": "цвета модели МФР", "filters": "фильтры модели", "map": "карта", "config": "настройки карты", "address": "адресный классификатор",
    "ldap-settings": "настройки домена", "ldap-search": "поиск в домене", "me": "текущий пользователь", "permissions": "права текущего пользователя",
    "import-templates": "образцы файлов импорта", "release-tasks": "обработки данных при обновлении", "release-status": "состояние обновления",
    "admin-guide": "памятка администратора", "reports": "отчёты", "element-catalog": "каталог элементов", "source-files": "чертежи", "drawings": "чертежи",
    "shaft-panels": "панели облицовки шахты", "export": "выгрузка", "fill-empty-scope": "заполнение пустых объекта и проекта",
    "reset-status-history": "очистка истории статусов", "disk-space": "место на диске", "import-input": "загрузка из папки Input", "input-files": "файлы папки Input",
}


def _noun(seg):
    seg = re.sub(r"\.(xlsx|pdf|png|md)$", "", seg)
    return NOUN_RU.get(seg) or NOUN_RU.get(seg.replace(".", "-"))


def fallback_scenario(r):
    """Сценарий по адресу маршрута, если у него нет пригодного докстринга: «Глагол: предмет» из справочников выше."""
    segs = [x for x in _segs(r["path"]) if not x.startswith("{")]
    last = segs[-1] if segs else ""
    last_clean = re.sub(r"\.(xlsx|pdf|png|md)$", "", last)
    tail_param = _segs(r["path"])[-1].startswith("{") if _segs(r["path"]) else False
    fmt = re.search(r"\.(xlsx|pdf)$", last)
    if last_clean in ACTION_RU and len(segs) >= 2:
        parent = _noun(segs[-2]) or segs[-2]
        return f"{ACTION_RU[last_clean]}: {parent}"
    if r["path"].startswith("/reports/"):
        nm = REPORT_NAMES.get(re.sub(r"\.(xlsx|pdf)$", "", last_clean), last_clean)
        return f"Отчёт «{nm}»" + (f": выгрузка в {fmt.group(1).upper()}" if fmt else ": данные для экрана")
    noun = _noun(last_clean)
    if not noun:
        return ""
    verb = {"GET": "Список" if not tail_param else "Просмотр", "POST": "Создание", "PATCH": "Изменение", "PUT": "Сохранение", "DELETE": "Удаление"}.get(r["method"], r["method"])
    if fmt:
        verb = f"Выгрузка в {fmt.group(1).upper()}"
    return f"{verb}: {noun}"


REPORT_NAMES = {"status": "Статус монтажа", "dynamics": "Динамика поставки и монтажа", "delivery-schedule": "График поставки",
                "completion": "Статус комплектации", "my-work": "Моя работа", "contracting-schedule": "График контрактации и поставки",
                "analytics": "Аналитическая справка", "block-status": "Учёт по блокам: статусы", "block-schedule": "График работ по блокам",
                "linear-track": "Линейный трек"}
DICT_ACTION_RU = {"candidates": "Кандидаты для замены записи справочника", "delete-plan": "План последствий удаления записи справочника",
                  "delete": "Удаление записи справочника с заменой ссылок"}


def scenario_for(r, C, allowed, v1_entries, scr):
    """Пользовательский сценарий по-русски: справочник видов записи → описание строки шлюза → докстринг маршрута → «глагол: предмет»
    по адресу → раздел прав."""
    kind_suffix = f" — вид записи «{r['dict_title']}»" if r.get("dict_kind") else ""
    if r.get("dict_kind"):
        tail = _segs(r["path"])[-1]
        return DICT_ACTION_RU.get(tail, "Операция над записью справочника") + f" «{r['dict_title']}»"
    doc = r["doc"] if is_ru(r["doc"]) and len(r["doc"]) >= 25 and not re.match(r"^(См\.|Смотри)", r["doc"]) else ""
    for a in allowed:
        row = next((x for x in C["gate"]["rows"] if x["id"] == a["id"]), None)
        if row and row["action"] and not doc:
            return row["action"]
    fb = fallback_scenario(r)
    if doc:
        return f"{fb} — {doc}" if (fb and len(doc) < 60) else doc
    if fb:
        return fb
    verb = VERB_RU.get(r["method"], r["method"])
    ft = next((C["be"]["feats"].get(k, {}).get("title", "") for k in r["feature_keys"][:1]), "")
    return f"{verb}: {ft or r['func']}"


def derive_action(op, scr, C):
    """Конкретное оставшееся действие — по состоянию операции (только факты из анализа, без выдумок)."""
    st = op["v2"]["state"]
    eff = op["effect"]
    title = op["v2"]["screen_title"]
    mods = ", ".join(op["v2"]["modules"])
    calls = ", ".join(op["v2"]["calls"][:2])
    write = eff in ("write", "analyze")
    area = op["area"]
    if st == "tech":
        return "служебный маршрут (вход, оболочка, версия сборки): не пользовательская операция, отдельно не переносится"
    if st == "unused":
        return "не вызывается ни V1, ни V2 (API без интерфейса: внешний клиент, устаревший или служебный маршрут): переносить нечего; решить, нужен ли маршрут"
    if op["kind"] == "client":
        return (f"нет в V2: добавить клиентскую операцию на экране «{title}»" if title else "нет в V2: добавить клиентскую операцию") + \
               " (печатная форма / буфер обмена, без API — шлюз не нужен)"
    if st == "published":
        s = op["v2"]["screen_status"] or 0
        if write:
            extra = ""
            if op["gate"]["disabled_rows"] and op["gate"]["restricted"]:
                dis = op["gate"]["disabled_rows"][0]
                extra = f"; поля/тело вне разрешённой формы отклоняет строка {dis['id']} ({shorten(dis['why'], 70)})"
            base = f"готово и опубликовано (шлюз: {op['gate']['allowed_rows'][0]['id']}){extra}"
        else:
            base = "чтение опубликовано"
        tail = f"; экран «{title}» в статусе {s}: до «5» — права других ролей, регрессия V1, прогон на итоговой сборке" if s < 5 else ""
        return base + tail
    if st == "branch":
        if write:
            return f"разрешена шлюзом ({op['gate']['allowed_rows'][0]['id']}) и вызывается из V2 ({calls}) в этой ветке; в опубликованной ветке нет: слияние и публикация, затем проверка на 8000"
        return f"подключено в этой ветке ({calls or 'сцена V1 в кадре'}); в опубликованной нет: публикация"
    if st == "gate_disabled":
        dis = op["gate"]["disabled_rows"]
        why = f"{dis[0]['id']}: {shorten(dis[0]['why'], 90)}" if dis else "строки в POLICY нет — запрещено по умолчанию"
        return f"форма есть ({calls}), шлюз отключён ({why}); нужны проверки (см. «Перечень проверок») и строка `allowed: true` в блоке области {area}"
    verb = {"read": "чтение (GET)", "read-post": "отчёт/выгрузку", "analyze": "разбор файла", "write": "изменение"}.get(eff, "операцию")
    lim = (scr or {}).get("limits") if scr else None
    lim_txt = f" Реестр экранов: «{shorten(lim, 120)}»" if lim else ""
    if st == "only_v1":
        if write:
            return (f"нет формы: экран «{title}» лишь ведёт в V1; нужны форма/диалог V2, строка `allowed: true` в блоке области {area} "
                    f"и проверки (см. «Перечень проверок»).{lim_txt}")
        simg = op["v2"]["screen_impl"] or ""
        if not write and simg not in ("v1", "read", "workspace", ""):
            return (f"экран «{title}» реализован в V2 модулем `{simg.split(':')[-1]}`, но это чтение он не вызывает — вероятно, заменено другим запросом; "
                    f"сверить с V1 и подключить, если данные нужны пользователю.{lim_txt}")
        return f"нет в V2: экран «{title}» лишь ведёт в V1; подключить {verb} в экран.{lim_txt}"
    if write:
        return f"нет экрана и формы: завести экран, форму, строку шлюза в блоке области {area} и проверки (см. «Перечень проверок»)"
    return f"нет экрана в V2 для этой операции: завести экран и подключить {verb}"


# Повседневные сценарии, которые выносятся вперёд (суждение о предметной области, а не вычисление): (регэксп «МЕТОД путь», прибавка, почему)
DAILY_BOOST = [
    (r"^PATCH /elements/(bulk-status|bulk-planned-delivery-date|\{[^}]+\}/(status|planned-delivery-date|comment|contract))$", 7,
     "прораб/модель: статус, даты, комментарий и контракт изделия, в том числе группой"),
    (r"^(POST|PUT) /objects/\{[^}]+\}/blocks/(\{[^}]+\}/(fact-reports(/\{[^}]+\})?|work-progress-cell)|chess-flat-batch)$", 7,
     "МФР: ввод факта выполнения по блокам"),
    (r"^(PUT|PATCH) /objects/\{[^}]+\}/block-works(/bulk|/\{[^}]+\})$", 5, "МФР: сроки запланированных работ"),
    (r"^(POST|PATCH|PUT) /(contracts|agreements|specifications|counterparties)(/\{[^}]+\}|/default-map)?$", 6,
     "комплектовщик: контрагенты, договоры, спецификации, контракты"),
    (r"^(POST|PATCH|DELETE) /supplier-changes(/\{[^}]+\}(/post|/unpost)?)?$", 5, "комплектовщик: замена поставщика и обмен привязками"),
    (r"^POST /(import-dxf/apply|import-revit/apply|import-pdf/apply|import-history-xlsx|import-contracting-xlsx|elements/bulk-edit/apply)$", 4,
     "обмен: загрузка данных из файлов"),
    (r"^POST /reports/[a-z-]+\.(xlsx|pdf)$|^POST /export\.xlsx$|^GET /export\.pdf$", 3, "обмен: выгрузка отчётов и схемы"),
    (r"^(POST|PATCH|PUT) /(users|projects|objects)(/\{[^}]+\}(/access)?)?$|^POST /roles$|^PUT /roles/features$", 3, "админ: пользователи, доступы, проекты и объекты"),
]
DAILY_BOOST_C = [(re.compile(p), b, why) for p, b, why in DAILY_BOOST]


def priority_of(op):
    """Оценка «важности для повседневной работы» (для списка первых операций по областям) — эвристика, не решение."""
    if op["tech"]:
        return -99
    base = SECTION_WEIGHT.get(op["section"], 1)
    eff = op["effect"]
    w = {"write": 3, "read-post": 3, "analyze": 1, "read": 2, "client": 2}.get(eff, 1)
    if op["download"]:
        w += 1
    if op["v1"]["used"] and op["v1"]["entries"]:
        w += 2
    if RARE_RE.search(op["path"]):
        w -= 4
    if op["method"] == "DELETE":
        w -= 1
    boost = 0
    for rx, b, why in DAILY_BOOST_C:
        if rx.search(op["id"]):
            boost = max(boost, b)
    return base + w + boost


# ======================================================================================================================
# Самопроверки
# ======================================================================================================================
class _ScriptCollector(inv.HTMLParser):
    """Встроенные `<script>` (без `src`, не importmap) и атрибуты-обработчики `onclick=` в разметке."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.inline, self.on_attrs, self._cur = [], 0, None

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        self.on_attrs += sum(1 for k in d if k.startswith("on"))
        if tag == "script":
            self._cur = None if (d.get("src") or d.get("type") == "importmap") else []

    def handle_endtag(self, tag):
        if tag == "script" and self._cur is not None:
            self.inline.append("".join(self._cur))
            self._cur = None

    def handle_data(self, data):
        if self._cur is not None:
            self._cur.append(data)


def self_checks(M):
    C, P, ops = M["C"], M["P"], M["ops"]
    be = C["be"]
    checks = {"problems": [], "info": {}}
    pr = checks["problems"]
    checks["info"]["маршрутов_ast"] = be["ast_total"]
    checks["info"]["маршрутов_независимый_подсчёт_tokenize"] = be["indep_total"]
    checks["info"]["маршрутов_после_разворота_справочников"] = len(C["routes"])
    sc = _ScriptCollector()
    sc.feed(M["cur"].read("app/static/index.html") or "")
    inline_paths = 0
    for t in sc.inline:
        inline_paths += len(scan_js_paths(t, "index.html")[0])
    checks["info"]["index.html_встроенных_скриптов"] = len(sc.inline)
    checks["info"]["index.html_обращений_к_API_во_встроенных_скриптах"] = inline_paths
    checks["info"]["index.html_атрибутов_on*"] = sc.on_attrs
    checks["info"]["обращений_V1_найдено"] = len(M["v1"]["usages"])
    checks["info"]["обращений_V2_найдено"] = len(C["v2_usages"])
    checks["info"]["вызовов_V2_структурный_разбор"] = C["v2_call_struct_total"]
    checks["info"]["вызовов_V2_независимый_подсчёт_regex"] = C["v2_call_indep_total"]
    if be["ast_total"] != be["indep_total"]:
        pr.append(f"число маршрутов: ast {be['ast_total']} ≠ независимый подсчёт декораторов {be['indep_total']}")
    if C["v2_call_struct_total"] != C["v2_call_indep_total"]:
        pr.append(f"число вызовов V2: структурный разбор {C['v2_call_struct_total']} ≠ независимый подсчёт regex {C['v2_call_indep_total']} "
                  "(известная причина — дефект токенизатора inventory_v1_ui.py на сложных вложенных шаблонных литералах, "
                  "см. список ниже и Docs/v2-progress/matrix.md)")
    if be["unincluded"]:
        pr.append("роутеры, объявленные, но не подключённые к приложению (их маршруты не живые): " + ", ".join(be["unincluded"]))
    dead = [r for r in be["routes"] if not r["live"]]
    if dead:
        pr.append(f"маршрутов вне подключённых роутеров: {len(dead)}")
    route_ops = [o for o in ops if o["kind"] == "route"]
    checks["lists"] = {}
    checks["lists"]["вызовы V2, найденные ТОЛЬКО регэксп-страховкой (структурный разбор пропустил файл целиком в этом месте — дефект токенизатора вложенных шаблонов, inventory_v1_ui.py, вне файлов этого исполнителя)"] = \
        sorted(f"{c['file']}:{c['line']} api.{c['api']}({c['raw_arg']})" for c in C.get("v2_fallback_calls", []))
    unmapped = [o["id"] for o in route_ops if not o["area_rule_found"]]
    checks["lists"]["маршруты, не отнесённые к области/разделу правилами"] = unmapped
    v1_no_screen = [o["id"] for o in route_ops if o["v1"]["used"] and not o["v2"]["screen"] and not o["tech"]]
    checks["lists"]["маршруты V1 без экрана V2 (ни правило пути, ни точка входа V1, ни V2 экрана не дали)"] = v1_no_screen
    checks["lists"]["обращения V1 к путям, которых нет в backend (мёртвые или ошибочные)"] = sorted(
        {f"{u['method']} {u['path']}  ({u['file']}:{u['line']})" for u in M["v1_unmatched"]})
    checks["lists"]["обращения V2 к путям, которых нет в backend (мёртвые или ошибочные)"] = sorted(
        {f"{u['method']} {u['path']}  ({u['file']}:{u['line']})" for u in C["v2_unmatched"]})
    checks["lists"]["вызовы V2, путь которых не удалось определить статически (проверить вручную)"] = sorted(
        {f"{c['file']}:{c['line']} api.{c['api']}({c['raw_arg']})" for c in C["unresolved_calls"]
         if c["file"] != "read-screen.js" and (c["api"] != "fetch" or not c["raw_arg"].startswith('"/static'))})
    unresolved_v1 = [f"{u['file']}:{u['line']} {u['path']}" for u in M["v1"]["usages"] if u["method"] == "?"]
    dyn_total, dyn_list = dynamic_v1_calls(M["cur"])
    checks["info"]["вызовов_api_fetch_V1_всего"] = dyn_total
    checks["lists"]["вызовы V1 api()/fetch() с путём не литералом (разобраны по присваиваниям и настройкам объектов, остальное — слепое пятно)"] = dyn_list
    checks["lists"]["обращения V1, метод которых не определён"] = unresolved_v1
    unused = [o["id"] for o in route_ops if not o["v1"]["used"] and not o["v2"]["impl"] and not o["tech"]]
    checks["lists"]["маршруты, которых не вызывает ни V1, ни V2 (внешние клиенты, служебные или мёртвые)"] = unused
    # строки шлюза, не соответствующие ни одному маршруту
    if C["gate"]:
        sample = {(o["method"], path_sample(o["path"])) for o in route_ops}
        orphan = []
        for row in C["gate"]["rows"]:
            hit = any(row["path_re"].match(p) and (not row["allowed"] or m in row["methods"]) for (m, p) in sample)
            if not hit:
                orphan.append(f"{row['id']} ({row['method']} /{row['path_source']})")
        checks["lists"]["строки шлюза, не совпадающие ни с одним маршрутом backend"] = orphan
    empty = [s for s in REQUIRED_SECTIONS if not any(o["section"] == s for o in ops)]
    checks["lists"]["разделы V1 без единой операции"] = empty
    if empty:
        pr.append("разделы без операций: " + ", ".join(empty))
    if unmapped:
        pr.append(f"маршрутов без правила области/раздела: {len(unmapped)}")
    stale_blockers = M.get("stale_blockers") or []
    checks["lists"]["blockers.json: записи без операции в матрице или для уже реализованной/опубликованной операции (проверить, не устарели ли)"] = stale_blockers
    if stale_blockers:
        pr.append(f"blockers.json: устаревших записей {len(stale_blockers)}")
    stale_replacements = M.get("stale_replacements") or []
    checks["lists"]["REPLACED_BY (gen_v2_operations.py): записи без операции в матрице или для уже НЕ «только переход в V1» операции (проверить, не устарели ли)"] = stale_replacements
    if stale_replacements:
        pr.append(f"REPLACED_BY: устаревших записей {len(stale_replacements)}")
    for k, v in checks["lists"].items():
        if v and k.startswith(("обращения V1 к путям", "обращения V2 к путям")):
            pr.append(f"{k}: {len(v)}")
    return checks


# ======================================================================================================================
# Вывод
# ======================================================================================================================
STATE_LABEL = {
    "published": "реализована и опубликована на 8000",
    "branch": "реализована в ветке, не опубликована/не проверена",
    "gate_disabled": "в V2, но отключена шлюзом",
    "replaced": "функция перенесена (замена старого маршрута, см. REPLACED_BY)",
    "only_v1": "только переход в V1",
    "blocked_external": "заблокирована внешним условием",
    "none": "отсутствует",
    "unused": "не вызывается интерфейсами (нет в V1 и V2)",
}
STATE_ORDER = ["published", "branch", "gate_disabled", "replaced", "only_v1", "blocked_external", "none", "unused"]
EFFECT_LABEL = {"read": "чтение", "read-post": "чтение (POST)", "analyze": "разбор файла", "write": "запись", "client": "клиентская"}


def cell(x):
    return str(x).replace("|", "\\|").replace("\n", " ")


def summary_counts(ops, key):
    """{группа: Counter(состояние)} для операций, кроме служебных."""
    out = defaultdict(Counter)
    for o in ops:
        if o["tech"]:
            continue
        out[o[key]][o["v2"]["state"]] += 1
    return out


def v2_cell(o):
    v = o["v2"]
    st = v["state"]
    if st == "tech":
        return "служебный"
    if st in ("published", "branch", "gate_disabled"):
        where = ", ".join(v["calls"][:2]) if v["calls"] else "сцена V1 в кадре"
        scr = f" · экран `{v['screen']}`" if v["screen"] else ""
        return f"{'есть' if st != 'gate_disabled' else 'форма есть'}: {where}{scr}"
    if st == "replaced":
        rep = o.get("replaced_by") or {}
        return f"заменена на `{rep.get('by')}`" if rep.get("by") else "перенесена (тот же маршрут, не увиден статически)"
    if st == "only_v1":
        return f"только переход в V1 (экран `{v['screen']}`, статус {v['screen_status']})"
    return "нет" + (f" (ближайший экран `{v['screen']}`)" if v["screen"] else "")


def gate_cell(o):
    g = o["gate"]
    if not g["applies"]:
        return "не ограничивается (чтение)" if o["effect"] in ("read", "read-post") else "—"
    parts = []
    for a in g["allowed_rows"]:
        extra = f", поля: {'/'.join(a['onlyKeys'])}" if a["onlyKeys"] else ""
        extra += f", проверка тела" if a["check"] else ""
        parts.append(f"разрешена `{a['id']}`{extra}")
    for d in g["disabled_rows"]:
        if g["allowed_rows"] and not g["restricted"]:
            continue     # перекрыта разрешающей строкой без ограничений — на запрос не влияет
        parts.append(("вне формы разрешённой строки — отключена `" if g["allowed_rows"] else "отключена `") + d["id"] + "`")
    return "; ".join(parts) or "нет строки (запрещено по умолчанию)"


def v1_cell(o):
    v = o["v1"]
    if o["kind"] == "client":
        return "; ".join(v["entries"] + v["calls"])
    if not v["used"]:
        return "не вызывается из V1"
    ents = "; ".join(v["entries"][:2]) or ("общий код V1 (вызывается из многих мест)" if v["generic_entry"] else "точка входа не установлена статически")
    if v["generic_entry"] and v["entries"]:
        ents += " (и др.)"
    return f"{ents} — {', '.join(v['calls'][:2])}"


def render_md(M, checks, cur_ref, pub_ref):
    ops = M["ops"]
    cur, pub = M["cur"], M["pub"]
    L = []
    w = L.append
    non_tech = [o for o in ops if not o["tech"]]
    w("# Матрица пользовательских операций V1 → V2")
    w("")
    w("> Файл **генерируется** скриптом `scripts/gen_v2_operations.py`; руками не править. Машинный вид — `Docs/v2-operations-matrix.json`.")
    w(f"> Пересоздать: `.venv/bin/python scripts/gen_v2_operations.py --ref {cur_ref} --published-ref {pub_ref}` (после каждого слияния).")
    w("")
    w(f"- Анализируется: **{cur.label()}** (`--ref {cur_ref}`). «Опубликовано на 8000» — по **{pub.label()}** (`--published-ref {pub_ref}`): "
      f"операция опубликована, если в этой ветке шлюз её разрешает, интерфейс V2 её вызывает и маршрут есть в backend. Дата: {date.today().isoformat()}.")
    dirty = cur.dirty()
    if dirty:
        w(f"- **Внимание:** в рабочем дереве есть незакоммиченные изменения ({len(dirty)} файл.: {', '.join(dirty[:4])}{'…' if len(dirty) > 4 else ''}); "
          f"матрица построена по `{cur_ref}` и их не учитывает (`--ref WORKTREE` — учесть).")
    w(f"- Операций (строк): **{len(ops)}**, из них пользовательских {len(non_tech)}, служебных {len(ops) - len(non_tech)} (вход, оболочка, версия сборки — в сводку не входят).")
    w("- **Ссылка в V1, заглушка и отключённая кнопка не считаются реализованной функцией V2.** «Только переход в V1» — в V2 есть экран, который лишь ведёт в V1; "
      "«в V2, но отключена шлюзом» — форма есть, но `write-gate.js` не разрешает запрос, пользователь её выполнить не может.")
    w("")
    w("**Перечень проверок изменяющей операции** (условие статуса «5» и включения строки в шлюзе; на настоящем backend, в браузере, на временной копии БД): "
      "успех и результат ПОСЛЕ перезагрузки страницы; отказ 403 у ограниченной роли (`user2`, `user4`); серверная валидация; конфликт устаревших данных; "
      "двойная отправка — один запрос; сетевой сбой и неизвестный исход без автоповтора, сверка с сервером; отсутствие частичных и побочных изменений (SQL до/после); "
      "правдивый журнал (`activity_log`); совместимость V1; для групповых опасных — ещё конкуренция и полный откат пачки.")
    w("")
    w("## Сводка")
    w("")
    w("Число пользовательских операций по областям переноса и состоянию в V2:")
    w("")
    w("| Область | " + " | ".join(STATE_LABEL[s] for s in STATE_ORDER) + " | Всего |")
    w("| --- | " + " | ".join("---" for _ in STATE_ORDER) + " | --- |")
    sc = summary_counts(ops, "area")
    tot = Counter()
    for a in AREAS:
        c = sc.get(a, Counter())
        if not c and a == "прочее":
            continue
        tot.update(c)
        w(f"| {a} | " + " | ".join(str(c.get(s, 0)) for s in STATE_ORDER) + f" | {sum(c.values())} |")
    w("| **Итого** | " + " | ".join(f"**{tot.get(s, 0)}**" for s in STATE_ORDER) + f" | **{sum(tot.values())}** |")
    w("")
    w("Из них **изменяющие** операции (запись и разбор файла — то, что проходит через шлюз):")
    w("")
    w("| Область | " + " | ".join(STATE_LABEL[s] for s in STATE_ORDER) + " | Всего |")
    w("| --- | " + " | ".join("---" for _ in STATE_ORDER) + " | --- |")
    wr = defaultdict(Counter)
    for o in non_tech:
        if o["effect"] in ("write", "analyze"):
            wr[o["area"]][o["v2"]["state"]] += 1
    tot = Counter()
    for a in AREAS:
        c = wr.get(a, Counter())
        if not c and a == "прочее":
            continue
        tot.update(c)
        w(f"| {a} | " + " | ".join(str(c.get(s, 0)) for s in STATE_ORDER) + f" | {sum(c.values())} |")
    w("| **Итого** | " + " | ".join(f"**{tot.get(s, 0)}**" for s in STATE_ORDER) + f" | **{sum(tot.values())}** |")
    w("")
    w("По разделам V1:")
    w("")
    w("| Раздел | " + " | ".join(STATE_LABEL[s] for s in STATE_ORDER) + " | Всего |")
    w("| --- | " + " | ".join("---" for _ in STATE_ORDER) + " | --- |")
    ss = summary_counts(ops, "section")
    for s in SECTIONS:
        c = ss.get(s, Counter())
        w(f"| {s} | " + " | ".join(str(c.get(x, 0)) for x in STATE_ORDER) + f" | {sum(c.values())} |")
    w("")
    # замены: старый маршрут числился бы «только переход в V1», но функция уже перенесена (REPLACED_BY, 2026-09-22)
    w("## Замены маршрутов V1 → V2")
    w("")
    w("Пользователь прямо указал: «старый API, заменённый безопасным новым API, не означает отсутствие пользовательской "
      "функции» — раз функция перенесена, старый маршрут не пробел, даже если им продолжает пользоваться V1. Строки ниже "
      "(словарь `REPLACED_BY` в `scripts/gen_v2_operations.py`) числились бы «только переход в V1»/«заблокирована», но "
      "проверкой (чтением кода и, где отмечено, живым прогоном) подтверждено, что функция уже в V2 — под тем же путём "
      "(генератор не разобрал вызов статически) или под новым, более безопасным. В сводках выше это состояние "
      f"«{STATE_LABEL['replaced']}», отдельной строкой — не гол-пробел.")
    w("")
    w("| Старый маршрут (V1) | Новый маршрут/операция (V2) | Примечание |")
    w("| --- | --- | --- |")
    replaced_ops = {o["id"]: o for o in ops if o["v2"]["state"] == "replaced"}
    for old_id, (new_id, note) in REPLACED_BY.items():
        op = replaced_ops.get(old_id)
        mark = "" if op else " ⚠ не найдена в текущей матрице — проверить актуальность записи"
        w(f"| `{cell(old_id)}` | {cell(new_id) if new_id else '_тот же маршрут_'} | {cell(note)}{mark} |")
    w("")
    if checks["lists"].get("REPLACED_BY (gen_v2_operations.py): записи без операции в матрице или для уже НЕ «только переход в V1» операции (проверить, не устарели ли)"):
        w("**Внимание:** есть устаревшие записи `REPLACED_BY` — см. «Самопроверки генератора» ниже.")
        w("")
    # экраны
    w("## Экраны V2: статус и состав операций")
    w("")
    w("Экран операции — где она реализована в V2, а если не реализована, то экран, который лишь ведёт в V1 (по правилу пути и точкам входа V1). "
      "Статус — из `screens.json` (1 не начат … 5 рабочий и проверенный).")
    w("")
    w("| Экран | Название | Статус | Реализация | " + " | ".join(STATE_LABEL[s] for s in STATE_ORDER) + " |")
    w("| --- | --- | --- | --- | " + " | ".join("---" for _ in STATE_ORDER) + " |")
    by_screen = defaultdict(Counter)
    for o in non_tech:
        if o["v2"]["screen"]:
            by_screen[o["v2"]["screen"]][o["v2"]["state"]] += 1
    for sid, sc_ in M["screens"].items():
        c = by_screen.get(sid, Counter())
        w(f"| `{sid}` | {cell(sc_['title'])} | {sc_['status']} | {cell(sc_.get('impl', ''))} | " + " | ".join(str(c.get(x, 0)) for x in STATE_ORDER) + " |")
    w("")
    # самопроверки
    w("## Самопроверки генератора")
    w("")
    info = checks["info"]
    w(f"- Маршрутов backend: `ast` **{info['маршрутов_ast']}** = независимый подсчёт декораторов токенами `tokenize` **{info['маршрутов_независимый_подсчёт_tokenize']}**"
      + (" — совпало." if info['маршрутов_ast'] == info['маршрутов_независимый_подсчёт_tokenize'] else " — **РАСХОДЯТСЯ**.")
      + f" После разворота `/dictionaries/{{kind}}` по видам справочника ({len(M['C']['kinds'])}) строк: {info['маршрутов_после_разворота_справочников']}.")
    w(f"- `index.html`: встроенных скриптов (кроме importmap) {info['index.html_встроенных_скриптов']}, обращений к API в них {info['index.html_обращений_к_API_во_встроенных_скриптах']}, "
      f"атрибутов-обработчиков `on*=` {info['index.html_атрибутов_on*']} — весь код V1 в `app.js` и соседних скриптах. Вызовов `api()`/`fetch()` в V1 всего {info['вызовов_api_fetch_V1_всего']}; найдено обращений к путям: V1 {info['обращений_V1_найдено']} (включая строки-адреса и таблицу отчётов), V2 {info['обращений_V2_найдено']} (модуль `read-screen.js` раскрыт по `screens.json`).")
    if checks["problems"]:
        w("- **Проблемы:**")
        for p in checks["problems"]:
            w(f"  - {p}")
    else:
        w("- Проблем не найдено.")
    for k, v in checks["lists"].items():
        w(f"- {k}: **{len(v)}**" + ("" if not v else ""))
        for x in v[:40]:
            w(f"  - `{x}`")
        if len(v) > 40:
            w(f"  - … и ещё {len(v) - 40} (полный список — в JSON)")
    w("")
    # топ-20
    w("## Первые отсутствующие операции по областям (эвристика важности)")
    w("")
    w("Отсутствующие = состояние «нет в V2», «только переход в V1» или «отключена шлюзом»; порядок — по эвристике (вес раздела, запись/отчёт, есть ли точка входа в V1, редкие служебные вниз). Это подсказка очерёдности, а не решение.")
    w("")
    for a in AREAS:
        miss = [o for o in non_tech if o["area"] == a and o["v2"]["state"] in ("none", "only_v1", "gate_disabled")]
        if not miss:
            continue
        miss.sort(key=lambda o: (-o["priority"], o["n"]))
        w(f"### {AREA_TITLES[a]}")
        w("")
        w(f"Отсутствует {len(miss)} из {sum(1 for o in non_tech if o['area'] == a)}. Первые {min(20, len(miss))}:")
        w("")
        w("| № | Раздел | Операция | Сценарий | V2 |")
        w("| --- | --- | --- | --- | --- |")
        for o in miss[:20]:
            w(f"| {o['n']} | {cell(o['section'])} | `{cell(o['id'])}` | {cell(shorten(o['scenario'], 110))} | {cell(STATE_LABEL[o['v2']['state']])} |")
        w("")
    # полные таблицы
    w("## Матрица по областям")
    w("")
    w("Для каждой области — две таблицы: **К выполнению** (состояния «в V2, но отключена шлюзом», «только переход в V1», «нет в V2», «в ветке, не опубликована») — это рабочий список исполнителя; "
      "**Уже в V2 и прочее** (опубликованные, не вызываемые интерфейсами, служебные).")
    w("")
    w("Столбцы: **Операция** (метод и путь backend); **Сценарий** (докстринг маршрута, при его отсутствии — по адресу); **Права** (проверки backend: раздел прав и уровень, «условно» — ветвление по праву); "
      "**V1** (точка входа в интерфейсе — по графу вызовов, приближённо — и место вызова в `app.js`); **V2** (где вызывается интерфейсом V2); "
      "**Вид · проверка** (чтение/запись; «доказательство работоспособности» — НЕ факт разрешения шлюза и НЕ текст `proof` строки шлюза (это самоотчёт внутри той же строки), "
      "а наличие проверочного набора, чей код ссылается на путь операции: `scripts/verify_*.py`, `scripts/verify_*.mjs`, `scripts/picker_verify/*.mjs`, `scripts/v2_tests/exchange/chk_*.mjs` "
      "или текст `screens.json.checks` экрана; «не проверена» — набора не нашлось); **Шлюз** (строки `write-gate.js`); **Опубл.** (в `" + pub_ref + "`); **Что осталось**.")
    w("")
    todo_states = ("gate_disabled", "only_v1", "none", "branch", "blocked_external")
    for a in AREAS:
        rows = [o for o in ops if o["area"] == a]
        if not rows:
            continue
        w(f"### {AREA_TITLES[a]}")
        w("")
        todo = [o for o in rows if o["v2"]["state"] in todo_states]
        done = [o for o in rows if o["v2"]["state"] not in todo_states]
        w(f"**К выполнению: {len(todo)}**")
        w("")
        w("| № | Раздел | Операция | Сценарий | Права | V1 | V2 | Вид · проверка | Шлюз | Что осталось |")
        w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for o in todo:
            w("| " + " | ".join(cell(x) for x in [
                o["n"], o["section"], op_name(o), shorten(o["scenario"], 100), shorten(o["perms"], 70), shorten(v1_cell(o), 110), shorten(v2_cell(o), 90),
                kind_check(o, 50), shorten(gate_cell(o), 90), shorten(o["action"], 330)]) + " |")
        w("")
        w(f"**Уже в V2 и прочее: {len(done)}**")
        w("")
        w("| № | Раздел | Операция | Сценарий | Состояние | V2 | Вид · проверка | Шлюз | Что осталось |")
        w("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for o in done:
            w("| " + " | ".join(cell(x) for x in [
                o["n"], o["section"], op_name(o), shorten(o["scenario"], 90), STATE_LABEL.get(o["v2"]["state"], "служебная"), shorten(v2_cell(o), 80),
                kind_check(o, 50), shorten(gate_cell(o), 80), shorten(o["action"], 160)]) + " |")
        w("")
    return "\n".join(L) + "\n"


def op_name(o):
    return f"`{o['method']} {o['path']}`" if o["kind"] == "route" else f"`{o['path']}`"


def kind_check(o, n):
    kind = EFFECT_LABEL.get(o["effect"], o["effect"]) + (" (файл)" if o["download"] else "")
    return f"{kind} · {o['checks']['level']}" + (f": {shorten(o['checks']['note'], n)}" if o["checks"]["note"] and o["checks"]["level"] != "—" else "")


def to_json(M, checks, cur_ref, pub_ref):
    cur, pub = M["cur"], M["pub"]
    ops = []
    for o in M["ops"]:
        ops.append(o)
    sc = summary_counts(M["ops"], "area")
    return {
        "meta": {"generator": "scripts/gen_v2_operations.py", "ref": cur_ref, "ref_label": cur.label(), "published_ref": pub_ref,
                 "published_label": pub.label(), "date": date.today().isoformat(), "operations": len(ops)},
        "statement": "Ссылка в V1, заглушка и отключённая кнопка не считаются реализованной функцией V2.",
        "states": STATE_LABEL, "areas": AREA_TITLES,
        "summary_by_area": {a: {s: sc.get(a, Counter()).get(s, 0) for s in STATE_ORDER} for a in AREAS},
        "screens": {sid: {"title": sc_["title"], "group": sc_.get("group"), "status": sc_["status"], "impl": sc_.get("impl"), "ops": sc_.get("ops"),
                          "checks": sc_.get("checks"), "limits": sc_.get("limits")} for sid, sc_ in M["screens"].items()},
        "checks": checks, "operations": ops,
    }


def dump_json(doc):
    """JSON с одной операцией на строку: удобно читать `diff`, файл заметно меньше, чем с отступом на каждое поле."""
    ops = doc.pop("operations")
    head = json.dumps(doc, ensure_ascii=False, indent=1)
    body = ",\n".join("  " + json.dumps(o, ensure_ascii=False, separators=(",", ":")) for o in ops)
    return head[:-2] + ',\n "operations": [\n' + body + "\n ]\n}\n"


def main():
    ap = argparse.ArgumentParser(description="Матрица операций V1 → V2")
    ap.add_argument("--ref", default="HEAD", help="ревизия git для анализа или WORKTREE (файлы рабочего дерева); по умолчанию HEAD")
    ap.add_argument("--published-ref", default="main", help="ревизия, которую обслуживает сервер на 8000 (по умолчанию main)")
    ap.add_argument("--out", help="каталог вывода (по умолчанию Docs/)")
    ap.add_argument("--check", action="store_true", help="только самопроверки и сводка, файлы не писать")
    ap.add_argument("--strict", action="store_true", help="код возврата 1 при найденных проблемах самопроверки")
    a = ap.parse_args()
    M = build_matrix(a.ref, a.published_ref)
    checks = self_checks(M)
    non_tech = [o for o in M["ops"] if not o["tech"]]
    c = Counter(o["v2"]["state"] for o in non_tech)
    print(f"операций: {len(M['ops'])} (пользовательских {len(non_tech)}); " + "; ".join(f"{STATE_LABEL[s]}: {c.get(s, 0)}" for s in STATE_ORDER))
    for p in checks["problems"]:
        print("  ПРОБЛЕМА:", p)
    if not a.check:
        out = Path(a.out) if a.out else DEFAULT_OUT
        out.mkdir(parents=True, exist_ok=True)
        (out / MD_NAME).write_text(render_md(M, checks, a.ref, a.published_ref), encoding="utf-8")
        (out / JSON_NAME).write_text(dump_json(to_json(M, checks, a.ref, a.published_ref)), encoding="utf-8")
        print(f"записано: {out / MD_NAME}, {out / JSON_NAME}")
    sys.exit(1 if (a.strict and checks["problems"]) else 0)


if __name__ == "__main__":
    main()
