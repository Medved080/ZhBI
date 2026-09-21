// Ограниченный выпуск V2 (GT-*): пометка экспериментального режима, шлюз изменяющих операций (`write-gate.js`), пояснения.
// ЗАПУСКАТЬ на стенде БЕЗ заглушки шлюза: `python3 scripts/v2_test_server.py 8063` (настоящий `write-gate.js`, как в поставке).
// На стенде с `--gate all` эти сценарии не имеют смысла (шлюз там подменён) и пропускаются.
import { openApp, waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const NOTICE = "Экспериментальный интерфейс. Часть функций ещё дорабатывается. Непроверенные операции выполняйте в текущем интерфейсе";
// Изменяющие запросы к «серверу»: всё, кроме GET и POST-чтения отчётов (`/reports/*`).
const writes = (a) => a.ctl.log.filter((e) => e.method !== "GET" && !/^\/reports\//.test(e.path));
const gateIsReal = async () => { const g = await import("/static/v2/write-gate.js"); return g.POLICY.length > 0; };

async function guard(t, fn) {
  if (!(await gateIsReal())) { t.ok(true, "стенд с заглушкой шлюза (--gate all): сценарий выпуска пропущен"); return; }
  await fn();
}

export const tests = [
  {
    id: "GT-01", title: "Пометка экспериментального режима: точный текст предупреждения, возврат в V1 — в шапке и в пометке; на каждом экране",
    async run(t) {
      await guard(t, async () => {
        const a = await openApp({ home: true });
        await waitFor(() => a.$("#v2-exp-banner"), { what: "пометка" });
        t.has(a.$("#v2-exp-banner").textContent, NOTICE, "текст предупреждения — слово в слово");
        t.has(a.$(".v2-badge").textContent, "экспериментальный", "бейдж в шапке");
        t.ok(a.$("#v2-back-btn") && a.$("#v2-banner-back"), "есть кнопка возврата в шапке и ссылка в пометке");
        t.eq(a.$("#v2-banner-back").getAttribute("href"), "/?ui=v1", "возврат ведёт в V1 (и сбрасывает выбор)");
        t.ok(a.$("#v2-exp-banner").getClientRects().length > 0, "пометка видна");
        for (const key of ["dict-smu", "zones", "users-access"]) {
          a.click(a.$(`${NAV}[data-section="${key}"]`));
          await waitFor(() => a.$(`${NAV}[data-section="${key}"][aria-pressed="true"]`), { what: key });
          t.ok(a.$("#v2-exp-banner").getClientRects().length > 0, `пометка на экране ${key} на месте`);
        }
      });
    },
  },
  {
    id: "GT-02", title: "Политика: разрешённые операции проходят, отключённые и неизвестные — отказ; поля тела ограничены; GET не затрагивается",
    async run(t) {
      const g = await import("/static/v2/write-gate.js");
      if (!g.POLICY.length) { t.ok(true, "стенд с заглушкой шлюза: пропущено"); return; }
      const ok = (m, p, b) => g.checkWrite(m, p, b).allowed;
      for (const [m, p, b] of [
        ["PATCH", "/users/5/ui-theme", { ui_theme: "sand" }], ["PATCH", "/users/5/label-color", { label_color: null }], ["POST", "/changelog/ack", {}],
        ["POST", "/smu", { name: "x" }], ["PATCH", "/smu/3", { name: "x" }], ["POST", "/dictionaries/smu/3/delete", {}],
        ["PUT", "/settings/project-card?object_id=1", {}], ["PUT", "/settings/report-notes?object_id=1", { effective_date: "2026-09-01", key_events: [], key_tasks: [], open_questions: [] }],
        ["DELETE", "/settings/report-notes/2026-09-01?object_id=1", undefined], ["POST", "/allowed-subtypes", {}], ["POST", "/dictionaries/subtype/A%20B/delete", {}],
        ["POST", "/mark-type-prefixes", {}], ["POST", "/dictionaries/mark_prefix/QA/delete", {}], ["PUT", "/settings/info-plate?object_id=2", { late_threshold_days: 2 }],
        ["PUT", "/zone-colors?object_id=2", []], ["PUT", "/status-colors", {}], ["PUT", "/element-shapes", []], ["PUT", "/revit-plan/colors?object_id=4", {}],
        ["PATCH", "/objects/4/block-works/9", { plan_start: null, plan_end: null }], ["POST", "/login", {}],
        // область «администрирование» (2026-09-21): включено после проверки на настоящем backend и входе
        ["POST", "/users", { last_name: "x", first_name: "", domain_login: "x", role: "user" }], ["PATCH", "/users/5", { last_name: "x", expected_version: "v" }],
        ["POST", "/users/5/set-password", { password: "x", must_change_password: true }], ["PUT", "/users/5/access", { grants: [], expected_grants: [] }],
        ["POST", "/users/access-bulk", { changes: [{}], dry_run: true }], ["POST", "/users/5/impersonate", {}], ["POST", "/ldap-search", { login: "a", password: "b", query: "cc" }],
        ["POST", "/roles", { name: "x" }], ["PATCH", "/roles/x", { name: "y", expected_name: "x" }], ["PUT", "/roles/order", { keys: [] }],
        ["PUT", "/roles/features", { items: [{ role_key: "a", feature_key: "b", level: "read", was: "none" }] }], ["DELETE", "/roles/x?expected_granted=1", undefined],
        ["POST", "/me/change-password", { current_password: "a", new_password: "b" }], ["DELETE", "/me/sessions/abc", undefined], ["POST", "/me/sessions/close-others", {}],
        ["DELETE", "/sessions/abc", undefined], ["POST", "/sessions/close-others", {}], ["DELETE", "/users/5/sessions", undefined], ["POST", "/logout", {}],
        ["POST", "/individuals", { name: "x" }], ["PATCH", "/individuals/2", { name: "x" }], ["POST", "/dictionaries/individual/2/delete", {}],
        ["POST", "/projects", { name: "x" }], ["PATCH", "/projects/2", { name: "x", expected_version: "v" }], ["POST", "/objects", { name: "x", project_id: 1 }],
        ["PATCH", "/objects/1", { name: "x", expected_version: "v" }], ["PUT", "/objects/1/avatar", { attachment_id: 1 }], ["POST", "/attachments", undefined], ["DELETE", "/attachments/3", undefined],
        ["POST", "/dictionaries/object/1/delete", {}], ["POST", "/dictionaries/project/1/delete", {}],
        ["POST", "/admin/backups", { comment: "x" }], ["POST", "/admin/backups/a.db/restore", {}], ["DELETE", "/admin/backups/a.db", undefined],
        ["PUT", "/ldap-settings", { enabled: false }], ["POST", "/ldap-settings/test", { login: "a", password: "b", config: {} }], ["PUT", "/map/online-tiles", { enabled: true }], ["POST", "/map/tiles/upload", undefined],
        ["POST", "/activity/cleanup?before=2026-01-01", {}], ["POST", "/release-tasks/x/run", {}], ["POST", "/admin/reset-status-history", {}],
      ]) t.ok(ok(m, p, b), `разрешено: ${m} ${p}`);
      for (const [m, p, b] of [
        // формы тела не той, что проверена: без версии записи / без прежнего уровня / лишние поля — отказ даже у разрешённых путей
        ["PATCH", "/users/5", {}], ["PUT", "/users/5/access", { grants: [] }], ["PUT", "/roles/features", { items: [{ role_key: "a" }] }], ["POST", "/users", { last_name: "x", secret: 1 }],
        ["PATCH", "/projects/2", { name: "x" }], ["PATCH", "/objects/1", { name: "x" }], ["POST", "/users/access-bulk", { changes: [] }], ["POST", "/users/5/set-password", {}],
        ["POST", "/counterparties", {}], ["PATCH", "/counterparties/1", {}], ["POST", "/agreements", {}], ["POST", "/specifications", {}], ["POST", "/contracts", {}],
        ["PATCH", "/contracts/1", {}], ["POST", "/dictionaries/contract/1/delete", {}], ["POST", "/dictionaries/counterparty/1/delete", {}], ["PATCH", "/elements/1/planned-delivery-date", {}],
        ["POST", "/something-new", {}], ["PUT", "/imports/anything", {}], ["DELETE", "/smu/3", undefined], ["DELETE", "/projects/3", undefined],
        ["PATCH", "/objects/4/block-works/9", { note: "x" }], ["PATCH", "/objects/4/block-works/9", { forecast_start: "2026-01-01", forecast_end: null }], ["PATCH", "/objects/4/block-works/9", { plan_start: null, note: "x" }],
        ["PUT", "/settings/info-plate?object_id=2", { late_threshold_days: 2, other: 1 }],
      ]) t.ok(!ok(m, p, b), `отключено: ${m} ${p}${b && Object.keys(b).length ? " " + JSON.stringify(b) : ""}`);
      t.has(g.checkWrite("POST", "/counterparties", {}).message, "отключена в экспериментальном интерфейсе", "текст отказа");
      t.has(g.checkWrite("POST", "/counterparties", {}).message, "текущем интерфейсе", "текст отказа ведёт в V1");
    },
  },
  {
    id: "GT-03", title: "Отключённые записи не отправляют запросов: создание контрагента (кнопка); причина видна, ввод цел",
    async run(t) {
      await guard(t, async () => {
        const a = await openApp({ home: true });
        await waitFor(() => a.$(`${NAV}[data-section="counterparties"]`), { what: "навигация" });
        a.click(a.$(`${NAV}[data-section="counterparties"]`));
        await waitFor(() => a.$("#cp-add"), { what: "контрагенты" });
        a.click(a.$("#cp-add"));
        await waitFor(() => a.$("#cpf-short"), { what: "форма контрагента" });
        await a.type(a.$("#cpf-short"), "GT-Контрагент");
        await a.type(a.$("#cpf-full"), "GT Контрагент полное");
        await a.type(a.$("#cpf-inn"), "7700000009");
        await waitFor(() => a.$("#cp-save"), { what: "подвал" });
        a.click(a.$("#cp-save"));
        await waitFor(() => /отключена в экспериментальном интерфейсе/.test(a.doc.body.innerText), { what: "причина отказа" });
        t.eq(writes(a).length, 0, "контрагент: изменяющих запросов нет");
        t.ok(a.$("#cp-save"), "форма осталась открытой, ввод цел");
        t.ok(a.$("#v2-gate-note") && !a.$("#v2-gate-note").hidden, "пояснение над содержимым показано");
      });
    },
  },
  {
    id: "GT-04", title: "Сохранение из диалога ухода в отключённом разделе: запрос не уходит, переход отменён, ввод цел",
    async run(t) {
      await guard(t, async () => {
        const a = await openApp({ home: true });
        await waitFor(() => a.$(`${NAV}[data-section="counterparties"]`), { what: "навигация" });
        a.click(a.$(`${NAV}[data-section="counterparties"]`));
        await waitFor(() => a.$("#cp-add"), { what: "контрагенты" });
        a.click(a.$("#cp-add"));
        await waitFor(() => a.$("#cpf-short"), { what: "форма" });
        await a.type(a.$("#cpf-short"), "GT-Уход");
        await a.type(a.$("#cpf-full"), "GT Уход полное");
        await a.type(a.$("#cpf-inn"), "7700000010");
        a.click(a.$(`${NAV}[data-section="home"]`));
        await waitFor(() => a.dialog(), { what: "диалог несохранённого" });
        await a.answerDialog("Сохранить и продолжить");
        await a.settle(300);
        t.eq(writes(a).length, 0, "«Сохранить и продолжить»: изменяющих запросов нет");
        t.ok(a.$("#cpf-short"), "остались на форме — данные не потеряны молча");
        t.eq(a.$("#cpf-short").value, "GT-Уход", "ввод цел");
      });
    },
  },
  {
    id: "GT-05", title: "Экраны с частичной политикой: физлица и сеансы правятся (включены 2026-09-21); ЗР — прогноз и примечание отключены, базовый срок работает",
    async run(t) {
      await guard(t, async () => {
        const a = await openApp({ home: true });
        await waitFor(() => a.$(`${NAV}[data-section="dict-individuals"]`), { what: "навигация" });
        a.click(a.$(`${NAV}[data-section="dict-individuals"]`));
        await waitFor(() => a.$("#de-body tbody"), { what: "физлица" });
        t.ok(a.$("#de-add"), "форма добавления есть (физлица правятся)");
        t.ok(!/Операция отключена/.test(a.$("#v2-content").textContent), "отказов шлюза нет");
        a.click(a.$(`${NAV}[data-section="sessions"]`));
        await waitFor(() => a.$("#ss-body table"), { what: "сеансы" });
        t.ok(a.$("#ss-close-others"), "«Завершить все, кроме текущего» есть (свои сеансы завершаются)");
        const mfr = a.ctl.data.objects.find((o) => o.kind === "mfr");
        a.setValue(a.$("#v2-object"), String(mfr.id));
        await waitFor(() => a.$(`${NAV}[data-section="blocks"]`), { what: "учёт по блокам" });
        a.click(a.$(`${NAV}[data-section="blocks"]`));
        await waitFor(() => a.$$(".v2-read-tab").length === 3, { what: "вкладки" });
        a.click(a.$$(".v2-read-tab")[1]);
        await waitFor(() => a.$("[data-row-edit]"), { what: "таблица работ" });
        a.click(a.$('[data-row-edit="1"]'));
        await waitFor(() => a.$("[data-f=plan_start]") && a.$("#bw-status"), { what: "карточка работы" });
        t.ok(!a.$("[data-f=plan_start]").disabled, "базовый срок доступен");
        t.ok(a.$("[data-f=forecast_start]").disabled && a.$("[data-f=note]").disabled, "прогноз и примечание отключены");
        t.ok(!(a.$("[data-save=forecast]") || a.$("[data-save=note]")), "кнопок сохранения прогноза и примечания нет");
        t.has(a.$("#v2-content").textContent, "отключены", "объяснение на экране");
      });
    },
  },
  {
    id: "GT-06", title: "Разрешённая операция проходит шлюз и барьер: СМУ — добавление в режиме выпуска (ровно один POST); ЗР — базовый срок (PATCH только двух полей)",
    async run(t) {
      await guard(t, async () => {
        const a = await openApp({ home: true });
        await waitFor(() => a.$(`${NAV}[data-section="dict-smu"]`), { what: "навигация" });
        a.click(a.$(`${NAV}[data-section="dict-smu"]`));
        await waitFor(() => a.$("#de-add-input") && a.$("#de-body tbody"), { what: "СМУ" });
        await a.type(a.$("#de-add-input"), "GT-СМУ");
        a.click(a.$("#de-add-btn"));
        await waitFor(() => a.$$("#de-body tbody tr").some((tr) => tr.children[1].textContent.trim() === "GT-СМУ"), { what: "запись в списке" });
        t.eq(writes(a).length, 1, "ровно один изменяющий запрос");
        t.eq(writes(a)[0].body, { name: "GT-СМУ" }, "тело запроса верное");
        t.ok(!/Операция отключена/.test(a.$("#v2-content").textContent), "отказа нет");
        const mfr = a.ctl.data.objects.find((o) => o.kind === "mfr");
        a.setValue(a.$("#v2-object"), String(mfr.id));
        await waitFor(() => a.$(`${NAV}[data-section="blocks"]`), { what: "учёт по блокам" });
        a.click(a.$(`${NAV}[data-section="blocks"]`));
        await waitFor(() => a.$$(".v2-read-tab").length === 3, { what: "вкладки" });
        a.click(a.$$(".v2-read-tab")[1]);
        await waitFor(() => a.$("[data-row-edit]"), { what: "таблица" });
        a.click(a.$('[data-row-edit="1"]'));
        await waitFor(() => a.$("[data-f=plan_start]") && a.$("#bw-status"), { what: "карточка" });
        a.setValue(a.$("[data-f=plan_start]"), "2026-11-01");
        a.setValue(a.$("[data-f=plan_end]"), "2026-11-05");
        await waitFor(() => !a.$("[data-save=plan]").disabled, { what: "правка" });
        a.click(a.$("[data-save=plan]"));
        try { await waitFor(() => writes(a).length === 2, { what: "PATCH" }); }
        catch (e) { throw new Error(`${e.message}; статус: «${a.$("#bw-status")?.textContent}»; диалог: ${a.dialog() ? "да" : "нет"}; журнал: ${JSON.stringify(a.ctl.log.filter((x) => x.method !== "GET").map((x) => x.method + " " + x.path))}`); }
        const p = writes(a)[1];
        t.eq(p.method, "PATCH", "PATCH");
        t.eq(Object.keys(p.body).sort(), ["plan_end", "plan_start"], "в теле только поля базового срока");
      });
    },
  },
  {
    id: "GT-07", title: "Отказ шлюза — обычный отказ 4xx: не считается идущей записью, нет автоповтора; чтение отчётов шлюзом не блокируется",
    async run(t) {
      await guard(t, async () => {
        const { api, ApiError } = await import("/static/v2/api.js");
        let err = null;
        try { await api.post("/counterparties", { short_name: "x" }); } catch (e) { err = e; }
        t.ok(err instanceof ApiError, "ApiError");
        t.eq(err.status, 403, "статус 4xx (как отказ сервера) — модули оставляют ввод и не повторяют");
        t.ok(err.blockedByPolicy, "помечен как отказ политики");
        t.eq(api.hasPendingWrites(), false, "«идущей записи» нет");
        let err2 = null;
        try { await api.upload("/imports/x", new FormData()); } catch (e) { err2 = e; }
        t.ok(err2?.blockedByPolicy, "загрузка файла тоже отключена");
        let notBlocked = true;
        try { await api.readPost("/reports/no-such-report", {}); } catch (e) { notBlocked = !(e && e.blockedByPolicy); }
        t.ok(notBlocked, "POST-чтение отчёта не блокируется шлюзом");
      });
    },
  },
  {
    id: "GT-08", title: "Обязательная смена пароля и вход: настоящая форма смены (текущий, новый, повтор), политика пароля; на входе — предупреждение",
    async run(t) {
      await guard(t, async () => {
        const a = await openApp({ query: "loginAs=8" });
        await waitFor(() => a.$("#pw-form"), { what: "форма смены пароля" });
        t.ok(a.$("#pw-cur") && a.$("#pw-new") && a.$("#pw-rep"), "поля: текущий, новый, повтор");
        t.ok(a.$("#pw-logout"), "есть «Выйти»");
        t.eq(writes(a).length, 0, "запросов записи до отправки формы нет");
        const b = await openApp({ session: false });
        await waitFor(() => b.$("#v2-login-form"), { what: "вход" });
        t.has(b.doc.body.innerText, NOTICE, "на экране входа — предупреждение");
      });
    },
  },
];
