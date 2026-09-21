// Точка входа экранов «Обмен данными» V2: по ключу `exchange` из screens.json выбирает реализацию операции. Экран без реализованной операции
// в этот модуль не попадает (остаётся «переход в V1» — screen-view.js). Реализации: exchange-import.js (загрузки Excel), exchange-bulk.js
// (массовая правка), позже — exchange-drawing.js (чертежи и связанные загрузки).
import { IMPORT_OPS } from "./exchange-import.js";
import { mountBulkEdit } from "./exchange-bulk.js";

const OPS = { ...IMPORT_OPS, "bulk-edit": mountBulkEdit };

export function hasExchangeOp(key) { return Object.prototype.hasOwnProperty.call(OPS, key); }

export function mountExchange(el, ctx) {
  return OPS[ctx.screen.exchange](el, ctx);
}
