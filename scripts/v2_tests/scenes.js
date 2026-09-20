// Сцены: именованные состояния форм V2 для визуальной приёмки. Одни и те же
// сцены используются и для безголовых снимков (?scene=<id> в app.html, см.
// scripts/v2_shots.py), и для автоматических геометрических проверок
// (scenarios/vis.js). Каждая сцена: pre(ctl) — до загрузки V2 (сессия, права),
// open(a) — после загрузки, доводит экран до нужного состояния.
import { waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const section = (a, key) => a.click(a.$(`${NAV}[data-section="${key}"]`));
const uaTab = (a, title) => a.click(a.byText(".v2-nav button[data-page]", title));
const byLogin = (a, login) => a.ctl.data.users.find((u) => u.domain_login === login);
const waitList = (a) => waitFor(() => a.$("#ua-rows") && a.$$("#ua-rows tr").length, { what: "список пользователей" });

async function uaCard(a, login, tab) {
  await waitList(a);
  a.click(a.$(`[data-user="${byLogin(a, login).id}"]`));
  await waitFor(() => a.$("[data-tab]"), { what: "карточка" });
  if (tab) {
    a.click(a.$(`[data-tab="${tab}"]`));
    await waitFor(() => a.$(`[data-tab="${tab}"][aria-pressed="true"]`), { what: `вкладка ${tab}` });
    await a.settle(120);
  }
}
async function poOpen(a) {
  await waitFor(() => a.$(`${NAV}[data-section="projects-objects"]`), { what: "навигация" });
  section(a, "projects-objects");
  await waitFor(() => a.$("#po-tree [data-project]"), { what: "дерево" });
  await a.settle(80);
}
async function poObject(a, id) {
  const o = a.ctl.data.objects.find((x) => x.id === id);
  const f = a.$("#po-status-filter"); a.setValue(f, ""); await a.settle(60);
  if (!a.$(`[data-object="${o.id}"]`)) { a.click(a.$(`[data-project="${o.project_id}"]`)); await waitFor(() => a.$(`[data-object="${o.id}"]`), { what: "объект в дереве" }); }
  a.click(a.$(`[data-object="${o.id}"]`));
  await waitFor(() => a.$("#pf-name") && a.$("#pf-name").value === o.name, { what: "карточка объекта" });
  await a.settle(200);
}

export const SCENES = {
  "login": { title: "Вход", pre: (ctl) => ctl.setSession(false), open: async (a) => { await waitFor(() => a.$("input[type=password]"), { what: "форма входа" }); } },
  "no-sections": { title: "Нет доступных разделов", pre: (ctl) => ctl.setPermissions({ system_admin: false, features: {} }), open: async (a) => { await waitFor(() => a.doc.body.innerText.includes("Нет доступных разделов"), { what: "заглушка" }); } },
  "ua-users": { title: "UA: список пользователей", open: waitList },
  "ua-new-user": { title: "UA: форма нового пользователя", async open(a) {
    await waitList(a);
    a.click(a.byText("button", "Добавить пользователя"));
    await waitFor(() => a.$("#nu-last"), { what: "форма" });
    await a.type(a.$("#nu-last"), "QA-Иванов"); await a.type(a.$("#nu-login"), "qa_ivanov");
    a.$("#nu-last").blur(); await a.settle(120);
  } },
  "ua-card-profile": { title: "UA: карточка — профиль (есть несохранённое)", async open(a) {
    await uaCard(a, "qa.noaccess");
    await waitFor(() => a.$("#pf-pos"), { what: "форма профиля" });
    await a.type(a.$("#pf-pos"), " (правка)");
    await waitFor(() => a.$("#card-save"), { what: "подвал" });
    a.$("#pf-pos").blur(); await a.settle(120);
  } },
  "ua-card-access": { title: "UA: карточка — доступ к объектам (сводка)", async open(a) {
    await uaCard(a, "qa.grants", "access");
    await waitFor(() => a.$("#ua-access-search"), { what: "сводка доступа" });
  } },
  "ua-card-access-editor": { title: "UA: карточка — редактор области доступа", async open(a) {
    await uaCard(a, "qa.noaccess", "access");
    await waitFor(() => a.$("#ua-access-search"), { what: "сводка" });
    a.click(a.byText("button", "Показать все")); await a.settle(80);
    a.click(a.$$("[data-edit-area^='o:']")[0]);
    await waitFor(() => a.$("[data-grant-role]"), { what: "редактор" });
    a.click(a.$("[data-grant-role]")); await a.settle(150);
  } },
  "ua-card-security": { title: "UA: карточка — вход и безопасность", async open(a) { await uaCard(a, "qa.noaccess", "security"); await waitFor(() => a.$("#sec-auth-method"), { what: "вкладка" }); await a.settle(100); } },
  "ua-roles": { title: "UA: роли и матрица разрешений", async open(a) {
    await waitList(a); uaTab(a, "Роли");
    await waitFor(() => a.$("#role-editor .v2-perm"), { what: "матрица" }); await a.settle(120);
  } },
  "ua-roles-dirty": { title: "UA: роли — несохранённые ячейки", async open(a) {
    await waitList(a); uaTab(a, "Роли");
    await waitFor(() => a.$("#role-editor .v2-perm"), { what: "матрица" });
    a.click(a.$$("[data-perm]").find((b) => b.getAttribute("aria-pressed") !== "true"));
    await waitFor(() => a.$("#roles-save"), { what: "подвал" }); await a.settle(120);
  } },
  "ua-check": { title: "UA: проверка доступа (пользователь с ролями, объект выбран)", async open(a) {
    await waitList(a); uaTab(a, "Проверка доступа");
    await waitFor(() => a.$("#chk-user"), { what: "вкладка" });
    a.setValue(a.$("#chk-user"), String(byLogin(a, "qa.grants").id));
    a.click(a.$("#chk-toggle"));
    await waitFor(() => !a.$("#chk-panel").hidden, { what: "панель" });
    const opt = a.$$("#chk-list [data-object-id]").find((b) => b.dataset.objectId);
    opt.click();
    await waitFor(() => a.$$("#chk-result .v2-perm").length > 3, { what: "права" }); await a.settle(120);
  } },
  "po-tree": { title: "PO: дерево без выбора", open: poOpen },
  "po-object": { title: "PO: карточка объекта с вложениями", async open(a) { await poOpen(a); await poObject(a, 3); await waitFor(() => a.$$(".v2-attach-row").length >= 3, { what: "вложения" }); } },
  "po-object-long": { title: "PO: объект с очень длинными названием и адресом", async open(a) { await poOpen(a); await poObject(a, 16); } },
  "po-project-long": { title: "PO: проект с очень длинным названием", async open(a) {
    await poOpen(a);
    a.setValue(a.$("#po-status-filter"), ""); await a.settle(60);
    a.click(a.$('[data-project="10"]'));
    await waitFor(() => a.$("#pf-name") && a.$("#pf-name").value.length > 60, { what: "карточка" }); await a.settle(150);
  } },
  "po-new": { title: "PO: новый проект", async open(a) { await poOpen(a); a.click(a.$("#po-add-project")); await waitFor(() => a.$("#pf-name") && a.$("#pf-name").value === "", { what: "форма" }); await a.settle(120); } },
  "po-dirty-error": { title: "PO: ошибка сохранения при уходе (видна сразу)", async open(a) {
    await poOpen(a); await poObject(a, 1);
    await a.type(a.$("#pf-description"), "Z");
    await waitFor(() => a.$("#po-save"), { what: "подвал" });
    a.ctl.failNext("PATCH /objects/1", { status: 500, detail: "Диск переполнен" });
    a.click(a.$('[data-object="2"]'));
    await waitFor(() => a.dialog(), { what: "диалог" });
    await a.answerDialog("Сохранить и продолжить");
    await waitFor(() => a.$("#po-status").textContent.includes("Диск"), { what: "ошибка" }); await a.settle(150);
  } },
  "dialog-unsaved": { title: "Диалог: несохранённые изменения", async open(a) {
    await waitList(a);
    a.click(a.byText("button", "Добавить пользователя")); await waitFor(() => a.$("#nu-last"), { what: "форма" });
    await a.type(a.$("#nu-last"), "QA"); section(a, "projects-objects");
    await waitFor(() => a.dialog(), { what: "диалог" }); await a.settle(100);
  } },
  "dialog-confirm-danger": { title: "Диалог: подтверждение удаления (danger)", async open(a) {
    await poOpen(a); await poObject(a, 20);
    a.click(a.$("#po-delete")); await waitFor(() => a.dialog(), { what: "диалог" }); await a.settle(100);
  } },
};

// Сцены раздела «Контрагенты» добавляются в cp-scenes.js (после расширения
// фейкового бэкенда).
try { Object.assign(SCENES, (await import("/tests/cp-scenes.js")).CP_SCENES); } catch (e) { /* набора нет — ничего страшного */ }
