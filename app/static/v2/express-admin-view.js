// «Администрирование → Бот eXpress» в V2: подключение к серверу eXpress, ключ бота, проверка связи и журнал обмена (раздел `express_admin`).
// Экран ОБЩИЙ с V1 — `app/static/express-ui.js` в режиме admin (логика и разметка одни; здесь только каркас страницы и транспорт V2: запись идёт
// через шлюз `write-gate.js`, строки `express.*`). Расписания, запросы и контакты — на объекте: «Численность → Бот eXpress».
import { mountExpress } from "../express-ui.js";
import { frame } from "./admin-common.js";
import { showConfirmDialog } from "./dialogs.js";

export function mountExpressAdmin(el, { screen, groupTitle, api }) {
  const body = frame(el, screen, groupTitle);
  // как у численности: нулевая внутренняя ширина корня оставляет ширину за страницей, таблицы прокручиваются внутри себя
  body.style.contain = "inline-size";
  const view = mountExpress(body, {
    mode: "admin", api, canAdmin: true,
    confirm: (text, { danger = false } = {}) => showConfirmDialog(text, { confirmLabel: danger ? "Да, продолжить" : "Продолжить", danger, multiline: true }),
  });
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { view.destroy(); } };
}
