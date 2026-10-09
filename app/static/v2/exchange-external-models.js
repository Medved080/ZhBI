// Экран «Загрузить из FBX» (external-models) — внешние 3D-модели объекта (благоустройство, фасад).
//
// С 2026-10-09 здесь та же панель, что в V1 (external-models-panel.js → общий модуль external-models/settings.js): список карточек
// с двумя колонками «Положение» / «Подобрать положение», загрузка с разбором файла в браузере, автосовмещение фасада (в том числе
// сразу после загрузки), «Перенести эту привязку на», «Сцентрировать с объектом», удаление. Прежний табличный экран V2 заменён:
// он умел меньше V1, а логика теперь одна на обе версии.
//
// Инструменты на сцене (мышью, «Совместить по точкам», «Настраивать поверх 3D», предпросмотр, оси) требуют 3D — на этой странице
// сцены нет, поэтому кнопок сцены в карточках здесь нет (как в V1 без открытой сцены). Они — в рабочем месте «Модель»/«Модель МФР»
// (кнопка «Внешние 3D-модели…» во вкладке «Вид», workspace.js), где сцена уже построена.
import { pageFrame } from "./exchange-common.js";
import { mountExternalModelsPanel } from "./external-models-panel.js";
import { showConfirmDialog } from "./dialogs.js";

export function mountExternalModels(el, ctx) {
  const { screen, groupTitle, api, objectId, rights } = ctx;
  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle,
    summary: "Внешние 3D-модели объекта (благоустройство, фасад). Видны слоем в 3D ЖБИ и «Модели МФР» — переключатель «Благоустройство» / «Фасады из FBX» там же, во вкладке «Вид». Положение модели можно задать числами здесь; настройка мышью, «Совместить по точкам» и предпросмотр на сцене — в рабочем месте «Модель» (3D): кнопка «Внешние 3D-модели…» во вкладке «Вид».",
    body: `<div id="em-panel"></div>
      <div class="v2-bar" style="margin-top:14px"><a class="v2-btn" href="#/ws-model" id="em-open-3d">Открыть 3D для настройки на сцене</a></div>`,
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
