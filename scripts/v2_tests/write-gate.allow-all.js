// ТОЛЬКО ДЛЯ ТЕСТОВОГО СТЕНДА (`scripts/v2_test_server.py --gate all`): заглушка вместо `app/static/v2/write-gate.js`,
// разрешающая все операции записи. Нужна, чтобы полный набор сценариев самих операций (до ограниченного выпуска) продолжал
// проверять код операций. В приложение и в образ не входит: подставляется стендом по имени файла, поставка её не содержит.
export const EXPERIMENTAL_NOTICE =
  "Экспериментальный интерфейс. Часть функций ещё дорабатывается. Непроверенные операции выполняйте в текущем интерфейсе";
export const POLICY = [];
export const BLOCKED_EVENT = "v2:write-blocked";
export const checkWrite = () => ({ allowed: true, rule: null });
export const disabledForScreen = () => [];
export const allowedForScreen = () => [{}];
export const hasAllowedWrites = () => true;
export const announceBlocked = () => {};
