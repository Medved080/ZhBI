// Статусы изделий для локальных проверок запросов и подписей V2.
// Соответствие серверному Status/STATUS_LABELS_RU проверяет verify_v2_element_statuses.mjs.
export const ELEMENT_STATUS_LABELS = Object.freeze({
  planned: "Запланирован",
  contracting: "Контрактация",
  in_production: "В производстве",
  shipped: "Отгружен",
  delivered: "Доставлен",
  ready_for_installation: "Готов к монтажу",
  installed: "Смонтирован",
  accepted: "Принят",
});

export const ELEMENT_STATUSES = Object.freeze(Object.keys(ELEMENT_STATUS_LABELS));
