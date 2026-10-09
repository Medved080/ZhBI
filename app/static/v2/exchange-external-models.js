// Экран «Загрузить из FBX» (external-models) — внешние 3D-модели объекта (благоустройство, фасад).
//
// С 2026-10-09 здесь та же панель, что в V1 (external-models-panel.js → общий модуль external-models/settings.js): список карточек
// с двумя колонками «Положение» / «Подобрать положение», загрузка с разбором файла в браузере, автосовмещение фасада (в том числе
// сразу после загрузки), «Перенести эту привязку на», «Сцентрировать с объектом», удаление. Прежний табличный экран V2 заменён:
// он умел меньше V1, а логика теперь одна на обе версии.
//
// ЭТА СТРАНИЦА — ЗАПАСНОЙ путь. Пункт меню «Загрузить из FBX» (main.js, openSection) ведёт на рабочее место объекта («Модель» у ЖБИ,
// «Модель МФР» у МФР) и открывает окно панели поверх схемы — как в V1, где диалог лежит над сценой, и со всеми инструментами на сцене
// (workspace-external-models.js). Эта страница показывается, только когда рабочее место роли недоступно: тогда сцены нет, и кнопок
// сцены (мышью, «Совместить по точкам», «Настраивать поверх 3D», предпросмотр, оси) в карточках нет.
import { pageFrame } from "./exchange-common.js";
import { mountExternalModelsPanel } from "./external-models-panel.js";
import { showConfirmDialog } from "./dialogs.js";

export function mountExternalModels(el, ctx) {
  const { screen, groupTitle, api, objectId, rights } = ctx;
  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle,
    summary: "Внешние 3D-модели объекта (благоустройство, фасад). Эта страница открывается, когда у роли нет рабочего места «Модель»/«Модель МФР»: загрузка с предпросмотром файла и числовые поля положения работают, а настройка мышью, «Совместить по точкам» и предпросмотр на сцене — в рабочем месте «Модель» (3D): «Загрузить из FBX» в меню открывает окно прямо поверх схемы.",
    body: `<div id="em-panel"></div>`,
  });
  const canEdit = !!(rights?.system_admin || rights?.features?.external_models === "write");
  const panel = mountExternalModelsPanel(el.querySelector("#em-panel"), { api, objectId, canEdit });
  return {
    hasUnsavedChanges: () => panel.isDirty(),
    // Черновик положения (числа в карточке) не записан — без вопроса уйти нельзя
    guardLeave: async () => !panel.isDirty() || showConfirmDialog("В карточке модели есть несохранённые изменения положения. Уйти без сохранения?", { confirmLabel: "Уйти без сохранения", multiline: true }),
    destroy() { panel.destroy(); },
  };
}
