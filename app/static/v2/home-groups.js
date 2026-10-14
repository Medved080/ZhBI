// Вторая группировка начальной страницы «Действия» — «по процессам» (первая, «по видам», — группы реестра `screens.json`).
//
// Данные реестра не трогаются: здесь только перенос разделов между карточками для этого одного экрана. Левая навигация и
// хлебные крошки по-прежнему берут группы из реестра.

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
const PROCESS_OF = {
  "upload-drawing": "p-model", "shaft-panels": "p-model", "external-models": "p-model", "revit-import": "p-model",
  "pdf-import": "p-model", "history-import": "p-model", "status-restore": "p-model", zones: "p-model", subtypes: "p-model",
  "mark-prefixes": "p-model", "element-catalog": "p-model", "import-input": "p-model", "settings-io": "p-model",
  "bulk-edit": "p-model", "blk-bulk": "p-model",

  map: "p-projects", "report-dynamics": "p-projects", "report-analytics": "p-projects", "projects-objects": "p-projects",
  "project-card": "p-projects", "dict-smu": "p-projects", "dict-individuals": "p-projects", "report-notes": "p-projects",
  "objects-import": "p-projects", "team-access": "p-projects", "address-classifier": "p-projects", "map-admin": "p-projects",

  counterparties: "p-contract", contracts: "p-contract", "report-completion": "p-contract", "contracting-import": "p-contract",
  "supplier-change": "p-contract",

  "report-status": "p-schedule", "report-block-status": "p-schedule", "report-block-schedule": "p-schedule",
  "report-linear-track": "p-schedule", schedule: "p-schedule", "schedule-import": "p-schedule",

  "work-codifier": "headcount",
};

// Перечёркнуто на скриншоте: в режиме «по процессам» не показываются (в «по видам» и в левой навигации остаются).
const HIDDEN_IN_PROCESS = new Set(["export-xls", "export-pdf"]);

// Иерархия внутри карточки: отчёт → обмен → справочник → документ → прочее. Вид раздела — по его группе в реестре;
// «Контрактация и график» в реестре — это контрагенты и контракты, то есть справочники.
const KIND_RANK = { reports: 0, exchange: 1, contracting: 2, dicts: 2, documents: 3 };
const OTHER_RANK = 4;
const kindRank = (s) => KIND_RANK[s.group] ?? OTHER_RANK;

// Карточки для показа: [{ id, title, items: [screen], gaps: Set<индекс, перед которым начинается новый вид> }].
// `items` — уже отфильтрованные по правам разделы (порядок реестра сохраняется).
export function homeCards(mode, registryGroups, items) {
  const groups = registryGroups.filter((g) => g.id !== "home");
  if (mode !== "process") {
    return groups.map((g) => ({ id: g.id, title: g.title, items: items.filter((s) => s.group === g.id), gaps: new Set() }))
      .filter((c) => c.items.length);
  }
  const title = new Map(groups.map((g) => [g.id, g.title]));
  const order = PROCESS_CARDS.map((c) => c.id);
  // Группа реестра, которой нет в списке карточек (добавят позже), не должна пропасть — дописывается в конец.
  for (const g of groups) if (!order.includes(g.id) && g.id !== "contracting") order.push(g.id);
  const titleOf = (id) => PROCESS_CARDS.find((c) => c.id === id)?.title ?? title.get(id) ?? id;
  const cardOf = (s) => PROCESS_OF[s.id] ?? (s.group === "contracting" ? "p-contract" : s.group);
  const cards = order.map((id) => {
    const list = items.filter((s) => !HIDDEN_IN_PROCESS.has(s.id) && cardOf(s) === id)
      .sort((a, b) => kindRank(a) - kindRank(b));   // сортировка устойчивая: внутри вида — порядок реестра
    const gaps = new Set();
    list.forEach((s, i) => { if (i && kindRank(s) !== kindRank(list[i - 1])) gaps.add(i); });
    return { id, title: titleOf(id), items: list, gaps };
  });
  return cards.filter((c) => c.items.length);
}
