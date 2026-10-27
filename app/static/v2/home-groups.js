// Вторая группировка начальной страницы «Действия» — «по процессам» (первая, «по видам», — группы реестра `screens.json`).
//
// Данные реестра не трогаются: здесь только перенос разделов между карточками для этого одного экрана. Левая навигация и
// хлебные крошки по-прежнему берут группы из реестра.
//
// Раскладка бывает двух видов: исходная (код ниже — PROCESS_CARDS/PROCESS_OF) и сохранённая администратором (режим «Настройка»,
// app/home_layout.py): блоки, их названия, состав и порядок пунктов. Сохранённая раскладка заменяет исходную целиком; разделы,
// появившиеся позже сохранения, докладываются в свой исходный блок.

export const GROUPINGS = [
  { id: "kind", label: "По видам" },
  { id: "process", label: "По процессам" },
];

// Карточки режима «по процессам» в порядке показа. Группа реестра, не названная здесь, показывается как есть
// (под своим названием и на своём месте по порядку реестра — см. `processGroups`).
const PROCESS_CARDS = [
  { id: "p-model", title: "Настройка модели" },
  { id: "p-projects", title: "Проекты строительства" },
  { id: "work" },
  { id: "p-contract", title: "Контрактация" },
  { id: "p-schedule", title: "График" },
  { id: "accounting" },
  { id: "reports" },
  { id: "documents" },
  { id: "pp" },
  { id: "headcount" },
  { id: "dicts" },
  { id: "exchange" },
  { id: "admin" },
  { id: "settings" },
  { id: "help" },
];

// Раздел → карточка процесса. Разметка заказчика по скриншоту: зелёное — «Настройка модели», красное — «Проекты строительства»,
// голубое — «Контрактация», фиолетовое — «График», оранжевое — «Численность». Раздел, которого здесь нет, остаётся в своей группе.
// Revit/PDF-загрузки и массовая правка МФР на скриншоте не попали (скрыты по типу объекта) — отнесены к модели по смыслу.
// Правки 2026-10-26 (по скриншоту заказчика): «Динамика поставки и монтажа» → Контрактация; «Карточка объекта» и «События, задачи,
// вопросы» → График; «Обмен данными с другим сервером» → Настройка модели; «Моя работа» → Настройки.
const PROCESS_OF = {
  "upload-drawing": "p-model", "shaft-panels": "p-model", "external-models": "p-model", "revit-import": "p-model",
  "pdf-import": "p-model", "history-import": "p-model", "status-restore": "p-model", zones: "p-model", subtypes: "p-model",
  "mark-prefixes": "p-model", "element-catalog": "p-model", "import-input": "p-model", "settings-io": "p-model",
  "bulk-edit": "p-model", "blk-bulk": "p-model", "data-exchange": "p-model",

  map: "p-projects", "report-analytics": "p-projects", "projects-objects": "p-projects",
  "dict-smu": "p-projects", "dict-individuals": "p-projects",
  "objects-import": "p-projects", "team-access": "p-projects", "address-classifier": "p-projects", "map-admin": "p-projects",

  counterparties: "p-contract", contracts: "p-contract", "report-completion": "p-contract", "contracting-import": "p-contract",
  "supplier-change": "p-contract", "report-dynamics": "p-contract",

  "report-status": "p-schedule", "report-block-status": "p-schedule", "report-block-schedule": "p-schedule",
  "report-linear-track": "p-schedule", schedule: "p-schedule", "schedule-import": "p-schedule",
  "project-card": "p-schedule", "report-notes": "p-schedule",

  "work-codifier": "headcount",

  "report-mywork": "settings",
};

// «Встать сразу после»: порядок внутри карточки по умолчанию — вид раздела, затем реестр; эти разделы по просьбе заказчика стоят
// именно после названного, а не там, куда их ставит вид.
const PROCESS_AFTER = { "data-exchange": "bulk-edit", "report-mywork": "my-access", "report-dynamics": "report-completion" };

// Перечёркнуто на скриншоте: в режиме «по процессам» не показываются (в «по видам» и в левой навигации остаются).
const HIDDEN_IN_PROCESS = new Set(["export-xls", "export-pdf"]);

// Иерархия внутри карточки: отчёт → обмен → справочник → документ → прочее. Вид раздела — по его группе в реестре;
// «Контрактация и график» в реестре — это контрагенты и контракты, то есть справочники.
const KIND_RANK = { reports: 0, exchange: 1, contracting: 2, dicts: 2, documents: 3 };
const OTHER_RANK = 4;
const KIND_LABEL = ["Отчёты", "Обмен данными", "Справочники", "Документы", "Прочее"];
const kindRank = (s) => KIND_RANK[s.group] ?? OTHER_RANK;

// Исходная раскладка: [{ id, title, items: [id разделов] }] по ВСЕМ разделам реестра (права и тип объекта накладываются при показе).
export function defaultLayout(registryGroups, screens) {
  const groups = registryGroups.filter((g) => g.id !== "home");
  const title = new Map(groups.map((g) => [g.id, g.title]));
  const order = PROCESS_CARDS.map((c) => c.id);
  // Группа реестра, которой нет в списке карточек (добавят позже), не должна пропасть — дописывается в конец.
  for (const g of groups) if (!order.includes(g.id) && g.id !== "contracting") order.push(g.id);
  const titleOf = (id) => PROCESS_CARDS.find((c) => c.id === id)?.title ?? title.get(id) ?? id;
  const cardOf = (s) => PROCESS_OF[s.id] ?? (s.group === "contracting" ? "p-contract" : s.group);
  return order.map((id) => {
    const list = screens.filter((s) => !HIDDEN_IN_PROCESS.has(s.id) && cardOf(s) === id)
      .sort((a, b) => kindRank(a) - kindRank(b));   // сортировка устойчивая: внутри вида — порядок реестра
    for (const s of [...list]) {   // «встать после»: вынуть и вставить за названным, если тот в этой же карточке
      const anchor = PROCESS_AFTER[s.id];
      const at = anchor ? list.findIndex((x) => x.id === anchor) : -1;
      if (at < 0) continue;
      list.splice(list.indexOf(s), 1);
      list.splice(list.findIndex((x) => x.id === anchor) + 1, 0, s);
    }
    return { id, title: titleOf(id), items: list.map((s) => s.id) };
  });
}

// Раскладка для показа и правки: сохранённая (если есть) с докладкой новых разделов, иначе исходная.
export function effectiveLayout(saved, registryGroups, screens) {
  const base = defaultLayout(registryGroups, screens);
  if (!saved || !Array.isArray(saved.cards)) return { custom: false, cards: base };
  const known = new Set(screens.map((s) => s.id));
  const cards = saved.cards.map((c) => ({ id: c.id, title: c.title, items: (c.items || []).filter((id) => known.has(id)) }));
  const placed = new Set(cards.flatMap((c) => c.items));
  for (const b of base) {
    for (const id of b.items) {
      if (placed.has(id)) continue;
      let target = cards.find((c) => c.id === b.id);
      if (!target) { target = { id: b.id, title: b.title, items: [] }; cards.push(target); }
      target.items.push(id);
      placed.add(id);
    }
  }
  return { custom: true, cards };
}

// Карточки для показа: [{ id, title, items: [screen], labels: Map<индекс, подпись вида, с которого он начинается> }].
// `items` — уже отфильтрованные по правам разделы (порядок реестра сохраняется).
// `layout` — результат effectiveLayout (только для режима «по процессам»); `all` — показать и пустые карточки (режим настройки).
export function homeCards(mode, registryGroups, items, layout = null, all = false) {
  const groups = registryGroups.filter((g) => g.id !== "home");
  if (mode !== "process") {
    return groups.map((g) => ({ id: g.id, title: g.title, items: items.filter((s) => s.group === g.id), labels: new Map() }))
      .filter((c) => c.items.length);
  }
  const byId = new Map(items.map((s) => [s.id, s]));
  const cards = (layout ? layout.cards : defaultLayout(registryGroups, items)).map((c) => {
    const list = c.items.map((id) => byId.get(id)).filter(Boolean);
    // Подписи видов («Отчёты», «Обмен данными», …) — и в исходной, и в сохранённой раскладке: первое же сохранение в режиме «Настройка»
    // раньше превращало карточки в плоские списки (2026-10-27). Подпись ставится там, где вид меняется по ходу списка; у карточки
    // из одного вида её нет — она повторяла бы название карточки.
    const labels = new Map();
    if (new Set(list.map(kindRank)).size > 1) {
      list.forEach((s, i) => { if (!i || kindRank(s) !== kindRank(list[i - 1])) labels.set(i, KIND_LABEL[kindRank(s)]); });
    }
    return { id: c.id, title: c.title, items: list, labels, total: c.items.length };
  });
  return all ? cards : cards.filter((c) => c.items.length);
}
