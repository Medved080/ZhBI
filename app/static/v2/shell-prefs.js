// Личные настройки оболочки V2 (2026-09-22): закреплённые объекты выбора объекта в шапке и состояние левой
// навигации (закреплена/нет, ширина, раскрытые группы меню). Хранятся ЗА ПОЛЬЗОВАТЕЛЕМ на сервере
// (`PATCH /users/{id}/v2-shell-prefs`, столбец `users.recent_objects` переиспользован — см. app/users.py) по той
// же причине, что и menu_prefs/ui_theme рядом: настройка должна следовать за человеком между сеансами и машинами,
// а не жить в localStorage одного браузера. Сеансовые мелочи (что сейчас набрано в поиске меню, какая группа
// временно раскрыта результатами поиска) сюда НЕ входят — им незачем переживать перезагрузку страницы.

export const NAV_WIDTH_MIN = 220;
export const NAV_WIDTH_MAX = 380;
export const NAV_WIDTH_DEFAULT = 260;
// Свёрнутая полоса — фиксированной ширины (п.2а задания), участвует в раскладке независимо от состояния.
export const NAV_COLLAPSED_WIDTH = 50;

export function clampNavWidth(w) {
  const n = Number(w);
  return Number.isFinite(n) ? Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, Math.round(n))) : NAV_WIDTH_DEFAULT;
}

function normalize(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pinnedObjects = Array.isArray(r.pinned_objects)
    ? [...new Set(r.pinned_objects.filter((x) => Number.isInteger(x) && x > 0))]
    : [];
  const navGroupState = r.nav_group_state && typeof r.nav_group_state === "object" && !Array.isArray(r.nav_group_state)
    ? Object.fromEntries(Object.entries(r.nav_group_state).filter(([, v]) => typeof v === "boolean"))
    : {};
  return {
    pinnedObjects,
    navPinned: r.nav_pinned === true,
    navWidth: r.nav_width != null ? clampNavWidth(r.nav_width) : NAV_WIDTH_DEFAULT,
    navGroupState,
  };
}

/** Хранилище личных настроек оболочки: читает начальное значение из уже загруженного /me (`user.v2_shell_prefs`,
 * лишнего запроса не требует), пишет через шлюз записи (`api.patch`) с задержкой — черновик резких изменений
 * (перетаскивание ширины, быстрые клики закрепления) не должен слать запрос на каждый пиксель/клик. */
export function createShellPrefsStore({ api, user }) {
  let prefs = normalize(user.v2_shell_prefs);
  let timer = null;
  let dirty = false;

  function payload() {
    return {
      pinned_objects: prefs.pinnedObjects,
      nav_pinned: prefs.navPinned,
      nav_width: prefs.navWidth,
      nav_group_state: prefs.navGroupState,
    };
  }

  async function flush() {
    clearTimeout(timer); timer = null;
    if (!dirty) return;
    dirty = false;
    try { await api.patch(`/users/${user.id}/v2-shell-prefs`, payload()); }
    catch (e) { /* личная настройка — молчаливый отказ (сеть/сессия) не должен мешать работе с оболочкой;
                   следующее изменение (или flush() при выгрузке страницы) попробует снова с уже АКТУАЛЬНЫМ prefs */ }
  }
  function schedule(delayMs) {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  }
  // Уходя со страницы — сохранить последнее состояние синхронно не получится (fetch асинхронный), но попытка
  // лучше молчания: браузер обычно успевает отправить быстрый запрос, начатый в beforeunload.
  window.addEventListener("beforeunload", () => { if (dirty) flush(); });

  return {
    /** Снимок текущих настроек — только чтение, новый вызов после любого set* отражает изменение сразу
     * (оптимистично, ДО ответа сервера): переключатели не должны ждать сеть, чтобы отработать визуально. */
    get: () => prefs,
    isPinnedObject: (id) => prefs.pinnedObjects.includes(id),
    /** Закрепить/открепить объект в выборе шапки. Возвращает новое состояние (true — теперь закреплён). */
    togglePinnedObject(id) {
      const now = !prefs.pinnedObjects.includes(id);
      prefs = { ...prefs, pinnedObjects: now ? [...prefs.pinnedObjects, id] : prefs.pinnedObjects.filter((x) => x !== id) };
      schedule(300);
      return now;
    },
    /** Молча убрать из закреплённых объекты, которых больше нет в дереве (объект удалён/стал недоступен) —
     * без обращения к серверу немедленно: следующее любое изменение (или следующая сессия) донесёт правку. */
    prunePinned(existingIds) {
      const kept = prefs.pinnedObjects.filter((id) => existingIds.has(id));
      if (kept.length === prefs.pinnedObjects.length) return;
      prefs = { ...prefs, pinnedObjects: kept };
      schedule(2000);
    },
    setNavPinned(v) { prefs = { ...prefs, navPinned: !!v }; schedule(200); },
    setNavWidth(px) { prefs = { ...prefs, navWidth: clampNavWidth(px) }; schedule(500); },
    /** Явное раскрытие/сворачивание группы меню пользователем (не путать с расчётным «раскрыта по умолчанию,
     * потому что в ней текущий экран» — то состояние в хранилище не попадает, см. shell-nav.js::isGroupOpen). */
    setGroupOpen(groupId, isOpen) {
      prefs = { ...prefs, navGroupState: { ...prefs.navGroupState, [groupId]: !!isOpen } };
      schedule(300);
    },
    flush,
  };
}
