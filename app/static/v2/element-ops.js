// Операции над изделиями на схеме (модель ЖБИ, АРМ прораба): карточка выбранного изделия и панель группового выделения.
//
// Что здесь: смена статуса (одного и пачки, с предпросмотром последствий), плановая дата (одного и пачки), контракт изделия, комментарий,
// правка и удаление записей истории статусов, форма реквизитов. Кадр со схемой по-прежнему только читает; ВСЕ записи идут отсюда через
// `api.js` и шлюз записи (`write-gate.js`). Правила и тексты последствий — `element-ops-rules.js`; серверные маршруты — `app/element_ops.py`.
//
// Принципы. (1) Клиент не присылает «контракты для записи»: в запросе только ожидаемое состояние изделия (статус, контракт) — расхождение
// с сервером даёт 409 без изменений, а не молчаливую перезапись. (2) Последствия, которые решают бизнес-правила (возврат на «Запланирован»
// снимает контракт и фактическую дату поставки), сервер отдаёт ДО записи (режим предпросмотра), интерфейс показывает их и просит подтверждение.
// (3) Повторная отправка при запросе в полёте невозможна; при обрыве связи исход неизвестен: автоповтора нет, состояние сверяется чтением.
// (4) После записи схема, карточка и показатели обновляются по ответу сервера (`applyElements`) и перечитыванием.
import { esc } from "./screen-view.js";
import { ApiError } from "./api.js";
import { showConfirmDialog, showInfoDialog, showUnsavedDialog } from "./dialogs.js";
import { checkWrite } from "./write-gate.js";
import { MAX_BATCH, consequenceLines, needsConfirm, conflictText } from "./element-ops-rules.js";

// стили модуля — отдельным файлом (не трогаем общий styles.css)
(() => {
  if (document.querySelector('link[data-eo-css]')) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/v2/element-ops.css"; l.setAttribute("data-eo-css", "1");
  document.head.appendChild(l);
})();

const fmtDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : (v ? String(v) : "—"); };
const fmtDateTime = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : fmtDate(v); };
const toLocalInput = (v) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(v || "")); return m ? `${m[1]}T${m[2]}` : ""; };
const serverDt = (local) => (local ? local.replace("T", " ") + ":00" : null);
const nf = (x) => Number(x).toLocaleString("ru-RU");
const norm = (x) => String(x ?? "").trim().toLowerCase();
const row = (k, v) => (v === null || v === undefined || v === "" ? "" : `<div class="ws-kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`);
const errText = (err, fallback) => (err instanceof ApiError ? (conflictText(err.rawDetail) || err.detail) : fallback);
// обрыв связи или ошибка сервера: запрос мог дойти до базы — исход неизвестен
const unknownOutcome = (err) => err instanceof ApiError && !err.blockedByPolicy && (err.status === 0 || err.status >= 500);

// ---------------------------------------------------------------- модальное окно формы (общий вид диалогов V2, свой состав)
function openModal({ title, width = 520, mount }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const bd = document.createElement("div");
    bd.className = "v2-dialog-backdrop";
    bd.innerHTML = `<div class="v2-dialog eo-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="width:${width}px">
      <div class="eo-dlg-head"><strong>${esc(title)}</strong><button type="button" class="eo-x" data-x aria-label="Закрыть">✕</button></div>
      <div class="eo-dlg-body"></div></div>`;
    const dlg = bd.querySelector(".eo-dialog"), body = bd.querySelector(".eo-dlg-body");
    let busy = false;
    const close = (value) => {
      document.removeEventListener("keydown", onKey, true);
      if (bd.isConnected) bd.remove();
      if (prev && document.contains(prev) && prev.focus) prev.focus();
      resolve(value);
    };
    const focusables = () => [...dlg.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent !== null);
    function onKey(e) {
      if (e.key === "Escape") {
        const top = Array.from(document.querySelectorAll(".v2-dialog-backdrop")).pop();
        if (top === bd && !busy) { e.preventDefault(); close(undefined); }      // над окном может быть диалог подтверждения — ему принадлежит Escape
        return;
      }
      if (e.key === "Tab") {
        const f = focusables(); if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    }
    bd.querySelector("[data-x]").addEventListener("click", () => { if (!busy) close(undefined); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(bd);
    mount(body, { close, setBusy: (b) => { busy = !!b; bd.querySelector("[data-x]").disabled = busy; }, focus: () => (focusables()[1] || focusables()[0])?.focus() });
    (focusables()[1] || focusables()[0])?.focus();
  });
}

export function createElementOps(ctx) {
  const { api, send, getScene, getObjectId, statusLabel, statusColor, repaint, reloadDetail, isDead, getDetail, groupOps = true } = ctx;
  const sc = () => getScene();
  const sw = (k) => statusColor(k);

  // ------------------------------------------------------------ права (по объекту, как в V1: раздел + порог «запись»)
  const R = { loaded: false, status: false, plannedDate: false, comment: false, history: false, fields: false };
  function setRights(r) {
    const can = (k) => !!r && (!!r.system_admin || (r.features?.[k] === "write" && !(r.not_applicable || []).includes(k)));
    Object.assign(R, { loaded: true, status: can("status"), plannedDate: can("planned_date"), comment: can("comment"), history: can("history"), fields: can("element_fields") });
    repaint();
  }
  function rightsFailed() { Object.assign(R, { loaded: true, status: false, plannedDate: false, comment: false, history: false, fields: false }); repaint(); }

  // ------------------------------------------------------------ состояние форм (по изделию: переключение выбора не теряет ввод)
  const forms = new Map();
  const F = (id) => { if (!forms.has(id)) forms.set(id, { st: { status: "", at: "", comment: "", contractId: null, contractLabel: "", busy: false, error: "", done: "", warn: "" },
    pd: { open: false, date: "", busy: false, error: "", done: "" }, cm: { open: false, text: "", busy: false, error: "", done: "" }, ct: { busy: false, error: "", done: "" },
    hs: { busy: false, error: "", done: "" }, ef: { done: "" } }); return forms.get(id); };
  // Итог групповой операции показывается вверху панели и переживает перечитывание схемы (оно снимает выделение вместе с формой)
  const banner = { kind: "", text: "" };
  const setBanner = (kind, text) => { banner.kind = kind; banner.text = text; };
  const bannerHtml = () => banner.text ? `<div class="eo-banner eo-banner-${banner.kind}" role="${banner.kind === "err" ? "alert" : "status"}"><span>${esc(banner.text)}</span><button type="button" class="eo-x" data-eo="banner-x" aria-label="Скрыть сообщение">✕</button></div>` : "";
  const G = { st: { status: "", at: "", comment: "", busy: false, error: "", done: "", prev: null }, pd: { date: "", busy: false, error: "", done: "" } };
  function reset() { forms.clear(); Object.assign(G.st, { status: "", at: "", comment: "", busy: false, error: "", done: "", prev: null }); Object.assign(G.pd, { date: "", busy: false, error: "", done: "" }); setBanner("", ""); contracts.byObject = null; }

  // ------------------------------------------------------------ контракты объекта (из кадра) и позиции (сервер)
  const contracts = { byObject: null, waiters: [] };
  function setContracts(objectId, items) {
    contracts.byObject = { objectId, items };
    for (const w of contracts.waiters.splice(0)) w(items);
  }
  function askContracts() {
    if (contracts.byObject && contracts.byObject.objectId === getObjectId()) return Promise.resolve(contracts.byObject.items);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("схема не прислала список контрактов")), 8000);
      contracts.waiters.push((items) => { clearTimeout(t); res(items); });
      send("getContracts");
    });
  }
  const cLabel = (c) => `Спецификация ${c.specification_date ? `${c.specification_number} от ${fmtDate(c.specification_date)}` : c.specification_number}${c.theme ? ` (${c.theme})` : ""}`;
  const cGroup = (c) => `${c.counterparty_short_name} · договор ${c.agreement_date ? `${c.agreement_number} от ${fmtDate(c.agreement_date)}` : c.agreement_number}`;

  // Выбор контракта (тот же смысл, что в V1: контракты объекта, у каждого — числа по позиции изделия; без позиции и без остатка выбрать нельзя).
  // options: {element, currentId, leading: [{value,label}]} → значение: id | "none" | undefined (закрыто)
  async function pickContract({ element, currentId, leading }) {
    let list, positions;
    try {
      list = (await askContracts()).filter((c) => !c.is_archived);
      positions = await api.get(`/contracts/positions?element_type=${encodeURIComponent(element.element_type)}`);
    } catch (err) {
      await showInfoDialog(`Не удалось загрузить контракты: ${err instanceof ApiError ? err.detail : (err.message || "нет ответа")}`);
      return undefined;
    }
    const mark = norm(element.mark);
    const byContract = new Map();
    for (const p of positions) {
      if (norm(p.mark) !== mark) continue;
      const a = byContract.get(p.contract_id) || { quantity: 0, fact: p.fact, damaged: p.damaged };
      a.quantity += p.quantity; a.fact = Math.max(a.fact, p.fact);
      byContract.set(p.contract_id, a);
    }
    for (const a of byContract.values()) a.remaining = a.quantity - a.fact - a.damaged;
    return openModal({ title: `Контракт · ${element.mark || "без марки"} · ${element.element_type}`, width: 640, mount(body, m) {
      const groups = new Map();
      for (const c of list) { const k = cGroup(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
      const rowHtml = (c) => {
        const p = byContract.get(c.id), own = c.id === currentId;
        const blocked = !own && (!p || p.remaining <= 0);
        const why = !p ? "нет позиции под эту марку" : `свободного количества нет (${nf(p.remaining)})`;
        return `<button type="button" class="eo-crow${own ? " on" : ""}${blocked ? " eo-blocked" : ""}${p ? "" : " eo-nopos"}" data-c="${c.id}" ${blocked ? "disabled" : ""} title="${esc(c.name)}${blocked ? " — " + why : ""}">
          <span class="eo-cname">${esc(cLabel(c))}</span>${p ? `<em title="Всего по позиции">${nf(p.quantity)}</em><em title="Уже разнесено">${nf(p.fact)}</em><em class="${p.remaining > 0 ? "ws-pos" : "ws-neg"}" title="Доступно">${nf(p.remaining)}</em>` : `<em class="eo-why">${esc(why)}</em>`}</button>`;
      };
      const sorted = Array.from(groups).sort((a, b) => a[0].localeCompare(b[0], "ru"));
      const withPos = (cs) => cs.filter((c) => byContract.has(c.id)).sort((a, b) => cLabel(a).localeCompare(cLabel(b), "ru"));
      const noPos = (cs) => cs.filter((c) => !byContract.has(c.id)).sort((a, b) => cLabel(a).localeCompare(cLabel(b), "ru"));
      body.innerHTML = `<p class="v2-muted eo-hint">Числа по позиции изделия: <b>всего</b> · <b>разнесено</b> · <b>доступно</b>. Контракт без позиции под эту марку или без свободного количества выбрать нельзя.</p>
        <div class="eo-clist">${(leading || []).map((x) => `<button type="button" class="eo-crow${String(x.value) === String(currentId ?? "") ? " on" : ""}" data-c="${esc(x.value)}"><span class="eo-cname">${esc(x.label)}</span></button>`).join("")}
        ${sorted.map(([g, cs]) => `<div class="eo-cg">${esc(g)}</div>${withPos(cs).map(rowHtml).join("")}${noPos(cs).map(rowHtml).join("")}`).join("") || `<p class="v2-muted">У объекта нет действующих контрактов.</p>`}</div>
        <div class="v2-dialog-actions"><button type="button" class="v2-btn" data-cancel>Отмена</button></div>`;
      body.querySelector("[data-cancel]").addEventListener("click", () => m.close(undefined));
      body.querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", () => m.close(b.dataset.c === "none" ? "none" : Number(b.dataset.c))));
      body.querySelector(".eo-crow.on")?.scrollIntoView({ block: "nearest" });
    } });
  }
  const contractLabelById = (id) => { const c = contracts.byObject?.items.find((x) => x.id === id); return c ? `${c.counterparty_short_name} · ${cLabel(c)}` : `контракт №${id}`; };

  // ------------------------------------------------------------ применение подтверждённого сервером к схеме
  const delta = (u) => ({ id: u.id, current_status: u.current_status, contract_id: u.contract_id ?? null, counterparty_code: u.counterparty_code ?? null,
    planned_delivery_date: u.planned_delivery_date ?? null, actual_delivery_date: u.actual_delivery_date ?? null, project_delivery_date: u.project_delivery_date ?? null,
    project_smr_start_date: u.project_smr_start_date ?? null });
  function applyToScene(list) {
    const items = (list || []).filter((u) => u && Number.isInteger(u.id));
    if (items.length) send("applyElements", { items: items.map(delta) });
    for (const u of items) if ("comment" in u) send("patchComment", { id: u.id, comment: u.comment ?? null });
  }
  const refreshDetailIfSelected = (id) => { const s = sc(); if (s?.selected?.id === id) reloadDetail(id); };

  // ------------------------------------------------------------ вспомогательное: предпросмотр и запись смены статуса (одно изделие или пачка)
  const statusBody = (mode, objectId, status, at, comment, assign, items, expect) => {
    const b = { mode, object_id: objectId, status, items };
    if (at) b.changed_at = serverDt(at);
    if (comment && comment.trim()) b.comment = comment.trim();
    if (assign) b.assign_contract_id = assign;
    if (mode === "apply") b.expect = expect;
    return b;
  };
  const toItems = (arr) => arr.map((i) => ({ element_id: i.id, expected_status: i.current_status, expected_contract_id: i.contract_id ?? null }));
  // Сверка после неопределённого исхода: пачка атомарна — достаточно первого и последнего изделия
  async function readBack(ids) {
    const probe = ids.length > 1 ? [ids[0], ids[ids.length - 1]] : [ids[0]];
    const out = [];
    for (const id of probe) out.push(await api.get(`/elements/${id}`));
    return out;
  }
  const consText = (cons, target) => consequenceLines(cons, statusLabel(target));

  // ================================================================ ОДНО ИЗДЕЛИЕ: карточка
  function cardHtml(e, { detail, detailError }) {
    const z = e.zones || {};
    const f = F(e.id);
    const hist = detail?.history || [];
    const canContract = R.status && e.current_status !== "planned";
    const contractBlock = e.contract_id
      ? `${row("Контрагент", e.supplier)}${row("Контракт", e.contractName)}` : row("Контракт", "не назначен");
    const histRows = hist.map((h) => `<li data-h="${h.id}"><i class="ws-sw" style="background:${esc(sw(h.status))}"></i><span>${esc(statusLabel(h.status))}</span>
        <small>${esc(fmtDateTime(h.changed_at))}${h.changed_by ? " · " + esc(h.changed_by) : ""}${h.comment ? ` · «${esc(h.comment)}»` : ""}</small>
        ${R.history ? `<span class="eo-row-actions"><button type="button" class="eo-link" data-eo="h-edit" data-id="${h.id}" title="Изменить запись истории">изменить</button><button type="button" class="eo-link eo-bad" data-eo="h-del" data-id="${h.id}" title="Удалить запись истории">удалить</button></span>` : ""}</li>`).join("");
    return `<div class="ws-pad"><div class="ws-card-head">
        <div class="ws-mark">${esc(e.mark || "—")}</div>
        <div class="ws-type">${esc(e.element_type)}${e.subtype ? ` <span class="v2-muted">· ${esc(e.subtype)}</span>` : ""}</div>
        <div class="ws-chip"><i class="ws-sw" style="background:${esc(sw(e.current_status))}"></i>${esc(statusLabel(e.current_status))}</div></div>
      <div class="ws-actions"><button type="button" class="v2-btn" data-act="locate">Показать на схеме</button><button type="button" class="v2-btn" data-act="clear-all">Снять выбор</button>${R.fields ? `<button type="button" class="v2-btn" data-eo="ef-open">Форма элемента…</button>` : ""}</div>
      ${f.ef.done ? `<p class="ws-ok" role="status">${esc(f.ef.done)}</p>` : ""}
      <h4>Размещение</h4><dl class="ws-dl">${row("Адрес по осям", e.address)}${row("Этаж", e.floor)}${row("Отметка, мм", e.elevation_mm)}${row("Захватка", z.zakhvatka)}${row("Кран", z.crane)}${row("Стоянка", z.stance)}</dl>
      <h4>Контрактация</h4><dl class="ws-dl">${contractBlock}</dl>
      ${canContract ? `<div class="ws-actions"><button type="button" class="v2-btn" data-eo="ct-pick" ${f.ct.busy ? "disabled" : ""}>${e.contract_id ? "Изменить контракт…" : "Назначить контракт…"}</button></div>` : ""}
      ${f.ct.error ? `<p class="ws-err" role="alert">${esc(f.ct.error)}</p>` : ""}${f.ct.done ? `<p class="ws-ok" role="status">${esc(f.ct.done)}</p>` : ""}
      <h4>Даты</h4><dl class="ws-dl">${row("Начало СМР", fmtDate(e.project_smr_start_date))}${row("Плановая поставка", fmtDate(e.planned_delivery_date))}${row("Фактическая поставка", fmtDate(e.actual_delivery_date))}${row("Завершение СМР", fmtDate(e.project_delivery_date))}</dl>
      ${plannedHtml(e, f)}
      <h4>Комментарий</h4>${commentHtml(e, f)}
      <h4>История статусов</h4>${detailError ? `<p class="v2-muted">${esc(detailError)}</p>` : !detail ? `<p class="v2-muted">Загрузка…</p>` : hist.length ? `<ul class="ws-hist eo-hist">${histRows}</ul>` : `<p class="v2-muted">Изменений статуса нет.</p>`}
      ${f.hs.error ? `<p class="ws-err" role="alert">${esc(f.hs.error)}</p>` : ""}${f.hs.done ? `<p class="ws-ok" role="status">${esc(f.hs.done)}</p>` : ""}
      ${statusFormHtml(e, f)}</div>`;
  }

  // ---- плановая дата одного изделия
  function plannedHtml(e, f) {
    if (!R.loaded) return "";
    if (!R.plannedDate) return "";
    const p = f.pd;
    if (!p.open) return `<div class="ws-actions"><button type="button" class="v2-btn" data-eo="pd-open">${e.planned_delivery_date ? "Изменить плановую дату…" : "Задать плановую дату…"}</button></div>${p.done ? `<p class="ws-ok" role="status">${esc(p.done)}</p>` : ""}${p.error ? `<p class="ws-err" role="alert">${esc(p.error)}</p>` : ""}`;
    return `<form class="ws-form eo-inline" id="eo-pd-form" autocomplete="off" novalidate><label class="ws-fld">Плановая дата поставки
        <input type="date" name="pd" value="${esc(p.date)}" ${p.busy ? "disabled" : ""}></label>
      <div class="ws-actions"><button type="submit" class="v2-btn v2-primary" ${p.busy ? "disabled" : ""}>${p.busy ? "Сохранение…" : "Сохранить"}</button>
        <button type="button" class="v2-btn" data-eo="pd-clear" ${p.busy || !e.planned_delivery_date ? "disabled" : ""}>Снять дату</button>
        <button type="button" class="v2-btn" data-eo="pd-cancel" ${p.busy ? "disabled" : ""}>Отмена</button></div>
      ${p.error ? `<p class="ws-err" role="alert">${esc(p.error)}</p>` : ""}</form>`;
  }
  async function submitPlanned(id, clear) {
    const e = sc()?.selected; const f = F(id), p = f.pd;
    if (p.busy || !R.plannedDate || !e || e.id !== id) return;
    const target = clear ? null : (p.date || null);
    if (!clear && !target) { p.error = "Укажите дату или нажмите «Снять дату»."; repaint(); return; }
    if ((e.planned_delivery_date || null) === target) { p.error = "Эта дата уже стоит — менять нечего."; repaint(); return; }
    p.busy = true; p.error = ""; p.done = ""; repaint();
    const body = { object_id: e.object_id ?? getObjectId(), planned_date: target, items: [{ element_id: id, expected_planned_date: e.planned_delivery_date ?? null }] };
    try {
      const res = await api.post("/element-ops/planned-date-batch", body);
      applyToScene([...(res.applied || []), ...(res.already || [])]);
      p.done = target ? `Плановая дата поставки: ${fmtDate(target)}.` : "Плановая дата снята."; p.open = false; p.date = "";
      refreshDetailIfSelected(id);
    } catch (err) {
      if (unknownOutcome(err)) {
        try {
          const d = await api.get(`/elements/${id}`);
          if ((d.planned_delivery_date || null) === target) { p.done = "Сервер подтвердил: плановая дата установлена."; p.open = false; applyToScene([d]); }
          else p.error = "Ответ не получен, изменение не подтверждено: на сервере прежняя дата. Введённое сохранено — проверьте связь и отправьте снова.";
        } catch (e2) { p.error = "Ответ не получен, и проверить результат не удалось: исход неизвестен. Ничего не отправлено повторно — обновите страницу и проверьте дату."; }
      } else {
        p.error = errText(err, "Не удалось сохранить плановую дату");
        if (err instanceof ApiError && err.status === 409) send("refreshElement", { id });
      }
    } finally { p.busy = false; if (!isDead()) repaint(); }
  }

  // ---- комментарий
  function commentHtml(e, f) {
    const c = f.cm;
    const view = e.comment ? `<p class="ws-comment">${esc(e.comment)}</p>` : `<p class="v2-muted">Комментария нет.</p>`;
    if (!R.comment) return view;
    if (!c.open) return `${view}<div class="ws-actions"><button type="button" class="v2-btn" data-eo="cm-open">${e.comment ? "Изменить комментарий…" : "Добавить комментарий…"}</button></div>${c.done ? `<p class="ws-ok" role="status">${esc(c.done)}</p>` : ""}`;
    return `<form class="ws-form eo-inline" id="eo-cm-form" autocomplete="off" novalidate><label class="ws-fld">Комментарий
        <textarea name="cm" rows="3" maxlength="2000" ${c.busy ? "disabled" : ""}>${esc(c.text)}</textarea></label>
      <div class="ws-actions"><button type="submit" class="v2-btn v2-primary" ${c.busy ? "disabled" : ""}>${c.busy ? "Сохранение…" : "Сохранить"}</button>
        <button type="button" class="v2-btn" data-eo="cm-cancel" ${c.busy ? "disabled" : ""}>Отмена</button></div>
      ${c.error ? `<p class="ws-err" role="alert">${esc(c.error)}</p>` : ""}</form>`;
  }
  async function submitComment(id) {
    const e = sc()?.selected; const f = F(id), c = f.cm;
    if (c.busy || !R.comment || !e || e.id !== id) return;
    const text = c.text.trim() || null;
    if ((e.comment || null) === text) { c.error = "Комментарий не изменился."; repaint(); return; }
    c.busy = true; c.error = ""; c.done = ""; repaint();
    try {
      const res = await api.patch(`/elements/${id}/comment`, { comment: text });
      send("patchComment", { id, comment: res?.comment ?? null });
      c.done = "Комментарий сохранён."; c.open = false; c.text = "";
    } catch (err) {
      if (unknownOutcome(err)) {
        try {
          const d = await api.get(`/elements/${id}`);
          if ((d.comment || null) === text) { c.done = "Сервер подтвердил: комментарий сохранён."; c.open = false; send("patchComment", { id, comment: d.comment ?? null }); }
          else c.error = "Ответ не получен, изменение не подтверждено. Введённое сохранено — проверьте связь и отправьте снова.";
        } catch (e2) { c.error = "Ответ не получен, и проверить результат не удалось: исход неизвестен. Ничего не отправлено повторно — обновите страницу."; }
      } else c.error = errText(err, "Не удалось сохранить комментарий");
    } finally { c.busy = false; if (!isDead()) repaint(); }
  }

  // ---- контракт изделия (без смены статуса)
  async function pickAndSetContract(id) {
    const e = sc()?.selected; const f = F(id), t = f.ct;
    if (t.busy || !R.status || !e || e.id !== id || e.current_status === "planned") return;
    const value = await pickContract({ element: e, currentId: e.contract_id ?? null, leading: e.contract_id ? [{ value: "none", label: "— снять контракт —" }] : [] });
    if (value === undefined || isDead()) return;
    const target = value === "none" ? null : value;
    if (target === (e.contract_id ?? null)) return;
    t.busy = true; t.error = ""; t.done = ""; repaint();
    const body = { element_id: id, expected_status: e.current_status, expected_contract_id: e.contract_id ?? null, contract_id: target };
    try {
      const res = await api.post("/element-ops/contract", body);
      applyToScene([res.element]);
      t.done = target ? "Контракт назначен. Статус не изменён." : "Контракт снят. Статус не изменён.";
      refreshDetailIfSelected(id);
    } catch (err) {
      if (unknownOutcome(err)) {
        try {
          const d = await api.get(`/elements/${id}`);
          if ((d.contract_id ?? null) === target) { t.done = "Сервер подтвердил: контракт установлен."; applyToScene([d]); }
          else t.error = "Ответ не получен, изменение не подтверждено: на сервере прежний контракт. Проверьте связь и повторите выбор.";
        } catch (e2) { t.error = "Ответ не получен, и проверить результат не удалось: исход неизвестен. Ничего не отправлено повторно — обновите страницу и проверьте контракт."; }
      } else {
        t.error = errText(err, "Не удалось изменить контракт");
        if (err instanceof ApiError && err.status === 409) send("refreshElement", { id });
      }
    } finally { t.busy = false; if (!isDead()) repaint(); }
  }

  // ---- история статусов: правка и удаление записи
  async function editHistory(id, hid) {
    const f = F(id), h = f.hs;
    const d = getDetail?.(id);
    const rec = d?.history?.find((x) => x.id === hid);
    if (!rec || h.busy || !R.history) return;
    const order = sc()?.statusOrder || [];
    const res = await openModal({ title: "Запись истории статусов", width: 480, mount(body, m) {
      body.innerHTML = `<form class="ws-form" id="eo-h-form" autocomplete="off" novalidate>
        <label class="ws-fld">Дата и время<input type="datetime-local" name="changed_at" value="${esc(toLocalInput(rec.changed_at))}"></label>
        <label class="ws-fld">Статус<select name="status">${order.map((k) => `<option value="${esc(k)}" ${k === rec.status ? "selected" : ""}>${esc(statusLabel(k))}</option>`).join("")}</select></label>
        <label class="ws-fld">Кто изменил<input type="text" name="changed_by" maxlength="200" value="${esc(rec.changed_by || "")}"></label>
        <label class="ws-fld">Комментарий<input type="text" name="comment" maxlength="500" value="${esc(rec.comment || "")}"></label>
        <p class="v2-muted ws-fnote">Правка записи пересчитывает текущий статус, фактическую дату поставки и контракт изделия по всей истории. Выполняется под вашим именем в журнале.</p>
        <div class="ws-actions eo-foot"><button type="button" class="v2-btn" data-cancel>Отмена</button><button type="submit" class="v2-btn v2-primary">Сохранить запись</button></div>
        <p class="ws-err" role="alert" hidden></p></form>`;
      const form = body.querySelector("form"), err = body.querySelector(".ws-err");
      body.querySelector("[data-cancel]").addEventListener("click", () => m.close(undefined));
      let busy = false;
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (busy) return;
        const v = (n) => form.elements[n].value;
        const payload = {};
        if (v("changed_at") && v("changed_at") !== toLocalInput(rec.changed_at)) payload.changed_at = v("changed_at").replace("T", " ") + ":00";
        if (!v("changed_at")) { err.hidden = false; err.textContent = "Дата записи не может быть пустой."; return; }
        if (v("status") !== rec.status) payload.status = v("status");
        if (v("changed_by").trim() !== (rec.changed_by || "")) payload.changed_by = v("changed_by").trim() || null;
        if (v("comment").trim() !== (rec.comment || "")) payload.comment = v("comment").trim() || null;
        if (!Object.keys(payload).length) { err.hidden = false; err.textContent = "Изменений нет."; return; }
        busy = true; m.setBusy(true); err.hidden = true; form.querySelector("[type=submit]").disabled = true;
        try { m.close({ ok: await api.patch(`/elements/${id}/history/${hid}`, payload), payload }); }
        catch (e) { busy = false; m.setBusy(false); form.querySelector("[type=submit]").disabled = false; if (unknownOutcome(e)) m.close({ unknown: true, payload }); else { err.hidden = false; err.textContent = errText(e, "Не удалось сохранить запись"); } }
      });
    } });
    if (!res || isDead()) return;
    h.done = ""; h.error = "";
    if (res.ok) { applyToScene([res.ok]); h.done = "Запись истории сохранена. Текущий статус пересчитан."; }
    else if (res.unknown) {
      try { const dd = await api.get(`/elements/${id}`); applyToScene([dd]); h.error = "Ответ не получен: состояние перечитано с сервера, проверьте историю ниже. Повторно ничего не отправлялось."; }
      catch (e2) { h.error = "Ответ не получен, и проверить результат не удалось: исход неизвестен. Обновите страницу и проверьте историю."; }
    }
    reloadDetail(id); repaint();
  }
  async function deleteHistory(id, hid) {
    const f = F(id), h = f.hs;
    const rec = getDetail?.(id)?.history?.find((x) => x.id === hid);
    if (!rec || h.busy || !R.history) return;
    const ok = await showConfirmDialog(`Удалить запись истории?\n\n«${statusLabel(rec.status)}» от ${fmtDateTime(rec.changed_at)}${rec.changed_by ? ", " + rec.changed_by : ""}.\n\nТекущий статус, фактическая дата поставки и контракт изделия пересчитаются по остальным записям. Отменить удаление здесь нельзя. Последнюю оставшуюся запись удалить нельзя.`, { confirmLabel: "Удалить запись", danger: true, multiline: true });
    if (!ok || isDead()) return;
    h.busy = true; h.error = ""; h.done = ""; repaint();
    try {
      const res = await api.delete(`/elements/${id}/history/${hid}`);
      applyToScene([res]);
      h.done = "Запись удалена. Текущий статус пересчитан по остальным записям.";
    } catch (err) {
      if (unknownOutcome(err)) {
        try {
          const d = await api.get(`/elements/${id}`);
          const gone = !(d.history || []).some((x) => x.id === hid);
          applyToScene([d]);
          if (gone) h.done = "Сервер подтвердил: запись удалена."; else h.error = "Ответ не получен, удаление не подтверждено: запись на месте. Проверьте связь и повторите.";
        } catch (e2) { h.error = "Ответ не получен, и проверить результат не удалось: исход неизвестен. Ничего не отправлено повторно — обновите страницу и проверьте историю."; }
      } else h.error = errText(err, "Не удалось удалить запись");
    } finally { h.busy = false; reloadDetail(id); if (!isDead()) repaint(); }
  }

  // ---- форма реквизитов (PATCH /elements/{id}/fields)
  const EF = [
    { key: "element_type", label: "Тип", kind: "type" }, { key: "subtype", label: "Подтип", kind: "subtype" }, { key: "mark", label: "Марка", kind: "mark" },
    { key: "elevation_mm", label: "Отметка, мм", type: "number" }, { key: "floor", label: "Этаж", type: "number" }, { key: "address", label: "Адрес по осям" },
    { key: "project_smr_start_date", label: "Начало СМР", type: "date" }, { key: "planned_delivery_date", label: "Плановая дата поставки", type: "date" },
    { key: "project_delivery_date", label: "Завершение СМР", type: "date" },
  ];
  async function openElementForm(id) {
    if (!R.fields) return;
    let el, marks = [], allowed = {};
    try {
      el = await api.get(`/elements/${id}`);
      if (el.object_id != null) {
        try { marks = await api.get(`/marks?object_id=${el.object_id}`); } catch (e) { marks = []; }
        try { allowed = await api.get(`/allowed-subtypes?object_id=${el.object_id}`); } catch (e) { allowed = {}; }
      }
    } catch (err) { await showInfoDialog(`Не удалось открыть форму: ${err instanceof ApiError ? err.detail : "нет связи"}`); return; }
    const f = F(id);
    const res = await openModal({ title: `Изделие · ${el.mark || "без марки"} · ${el.element_type}`, width: 620, mount(body, m) {
      const manual = new Set(el.manual_fields || []);
      const types = Array.from(new Set([...Object.keys(allowed || {}), el.element_type].filter(Boolean))).sort();
      const subOpts = (t, cur) => ['<option value="">— не задан —</option>'].concat((allowed[t] || []).map((v) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v)}</option>`)).join("");
      const markOpts = (t, cur) => { const l = marks.filter((x) => x.element_type === t).map((x) => x.name); if (cur && !l.includes(cur)) l.unshift(cur); return ['<option value="">— не задана —</option>'].concat(l.map((v) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v)}</option>`)).join(""); };
      const ctl = (x) => {
        const v = el[x.key] ?? "";
        if (x.kind === "type") return `<select name="element_type">${types.map((t) => `<option value="${esc(t)}" ${t === el.element_type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
        if (x.kind === "subtype") return `<select name="subtype">${subOpts(el.element_type, el.subtype)}</select>`;
        if (x.kind === "mark") return `<select name="mark">${markOpts(el.element_type, el.mark)}</select>`;
        return `<input type="${x.type || "text"}" name="${x.key}" value="${esc(v)}">`;
      };
      body.innerHTML = `<form class="ws-form eo-grid" id="eo-ef" autocomplete="off" novalidate>
        ${EF.map((x) => `<label class="ws-fld">${esc(x.label)}${manual.has(x.key) ? " ✎" : ""}${ctl(x)}</label>`).join("")}
        <p class="v2-muted ws-fnote eo-span">✎ — поле правлено руками: повторная загрузка чертежа его не перезапишет молча. Статус и контракт меняются в карточке изделия, комментарий — там же. Смена типа или марки отклоняется, если изделие перестаёт соответствовать позиции его контракта.</p>
        <div class="ws-actions eo-foot eo-span"><button type="button" class="v2-btn" data-cancel>Отмена</button><button type="submit" class="v2-btn v2-primary">Сохранить</button></div>
        <p class="ws-err eo-span" role="alert" hidden></p></form>`;
      const form = body.querySelector("form"), err = body.querySelector(".ws-err");
      const typeSel = form.elements.element_type;
      typeSel.addEventListener("change", () => { form.elements.subtype.innerHTML = subOpts(typeSel.value, ""); form.elements.mark.innerHTML = markOpts(typeSel.value, ""); });
      body.querySelector("[data-cancel]").addEventListener("click", () => m.close(undefined));
      let busy = false;
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (busy) return;
        const payload = {};
        for (const x of EF) {
          const raw = String(form.elements[x.key].value).trim();
          const was = el[x.key] === null || el[x.key] === undefined ? "" : String(el[x.key]);
          if (raw !== was) payload[x.key] = raw === "" ? null : raw;
        }
        if (!Object.keys(payload).length) { err.hidden = false; err.textContent = "Изменений нет."; return; }
        busy = true; m.setBusy(true); err.hidden = true; form.querySelector("[type=submit]").disabled = true;
        try { m.close({ ok: await api.patch(`/elements/${id}/fields`, payload) }); }
        catch (e) { busy = false; m.setBusy(false); form.querySelector("[type=submit]").disabled = false; if (unknownOutcome(e)) m.close({ unknown: true }); else { err.hidden = false; err.textContent = errText(e, "Не удалось сохранить"); } }
      });
    } });
    if (!res || isDead()) return;
    if (res.ok) { f.ef.done = "Реквизиты сохранены."; reloadKeepSelection(id); }
    else if (res.unknown) f.ef.done = "Ответ не получен: проверьте реквизиты изделия — повторно ничего не отправлялось.";
    reloadDetail(id); repaint();
  }

  // Смена типа/марки/адреса меняет подписи и отбор на схеме — она перечитывается целиком; выбор после этого возвращаем на то же изделие
  async function reloadKeepSelection(id) {
    send("reload");
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 300));
    while (Date.now() - t0 < 90000 && !isDead()) { const s = sc(); if (s && s.loaded && !s.loading && s.total > 0) break; await new Promise((r) => setTimeout(r, 300)); }
    if (!isDead()) send("select", { id });
  }

  // ---- смена статуса одного изделия
  function statusFormHtml(e, f) {
    if (!R.loaded) return "";
    if (!R.status) return `<p class="v2-muted ws-ro">Смена статуса недоступна: нет права изменять статусы на этом объекте.</p>`;
    const w = f.st;
    const opts = (sc()?.statusOrder || []).filter((k) => k !== e.current_status);
    const leavingPlanned = e.current_status === "planned" && w.status && w.status !== "planned";
    const toPlanned = w.status === "planned";
    return `<h4>Изменить статус</h4>
      <form class="ws-form" id="ws-sform" autocomplete="off" novalidate>
        <label class="ws-fld">Новый статус
          <select name="status" ${w.busy ? "disabled" : ""}><option value="">— выберите —</option>${opts.map((k) => `<option value="${esc(k)}" ${w.status === k ? "selected" : ""}>${esc(statusLabel(k))}</option>`).join("")}</select></label>
        ${leavingPlanned ? `<div class="ws-fld">Контракт <small>(необязательно)</small>
          <div class="eo-pickrow"><span class="eo-pickval">${w.contractId ? esc(w.contractLabel) : "без контракта"}</span>
            <button type="button" class="v2-btn" data-eo="st-contract" ${w.busy ? "disabled" : ""}>${w.contractId ? "Изменить…" : "Выбрать…"}</button>${w.contractId ? `<button type="button" class="v2-btn" data-eo="st-contract-clear" ${w.busy ? "disabled" : ""}>Убрать</button>` : ""}</div></div>` : ""}
        <label class="ws-fld">Дата и время изменения <small>(пусто — сейчас)</small>
          <input type="datetime-local" name="at" value="${esc(w.at)}" ${w.busy ? "disabled" : ""}></label>
        <label class="ws-fld">Комментарий
          <textarea name="comment" rows="2" maxlength="500" ${w.busy ? "disabled" : ""}>${esc(w.comment)}</textarea></label>
        <p class="v2-muted ws-fnote">${toPlanned ? "Возврат в «Запланирован» СНИМАЕТ контракт и очищает фактическую дату поставки: последствия будут показаны до записи." : "Контракт изделия сохраняется прежним."} Изменение попадёт в историю статусов; отменить его можно правкой или удалением записи истории.</p>
        <div class="ws-actions"><button type="submit" class="v2-btn v2-primary" ${w.busy || !w.status ? "disabled" : ""}>${w.busy ? "Сохранение…" : "Сохранить статус"}</button></div>
        ${w.error ? `<p class="ws-err" role="alert">${esc(w.error)}</p>` : ""}
        ${w.warn ? `<p class="ws-warnbox" role="status">${esc(w.warn)}</p>` : ""}
        ${w.done ? `<p class="ws-ok" role="status">${esc(w.done)}</p>` : ""}
      </form>`;
  }
  async function submitStatus(id) {
    const f = F(id), w = f.st;
    if (w.busy || !w.status || !R.status) return;               // повторная отправка, пока идёт запрос, невозможна
    const e = sc()?.selected;
    if (!e || e.id !== id) return;                               // форма всегда про ВЫБРАННОЕ изделие
    const wanted = w.status;
    const items = toItems([{ id, current_status: e.current_status, contract_id: e.contract_id }]);
    const objectId = e.object_id ?? getObjectId();
    const assign = e.current_status === "planned" && wanted !== "planned" ? (w.contractId || null) : null;
    w.busy = true; w.error = ""; w.done = ""; w.warn = ""; repaint();
    try {
      // 1) предпросмотр: сервер сообщает последствия, ничего не записывая
      const pre = await api.post("/element-ops/status-batch", statusBody("preview", objectId, wanted, w.at, w.comment, assign, items));
      if (pre.already_applied) { w.done = `Уже выполнено: статус «${statusLabel(wanted)}» установлен — повторная запись не выполнялась.`; applyToScene(pre.already); refreshDetailIfSelected(id); return; }
      if (pre.problems?.length) { w.error = `Контракт не позволяет записать: ${pre.problems.map((p) => p.message).join(" ")}`; return; }
      const lines = consText(pre.consequences, wanted);
      if (needsConfirm(pre.consequences)) {
        const msg = [`Изменить статус изделия «${e.mark || e.element_type}» на «${statusLabel(wanted)}»?`, "", ...lines.map((l) => "• " + l), "", "Изменение попадёт в историю статусов."].join("\n");
        const ok = await showConfirmDialog(msg, { confirmLabel: "Сохранить", multiline: true, danger: pre.consequences.release_contracts > 0 });
        if (!ok || isDead()) return;
      }
      // 2) запись с подтверждением увиденных последствий
      const cons = pre.consequences;
      const res = await api.post("/element-ops/status-batch", statusBody("apply", objectId, wanted, w.at, w.comment, assign, items, { release_contracts: cons.release_contracts, without_contract: cons.without_contract }));
      applyToScene([...(res.applied || []), ...(res.already || [])]);
      const after = (res.applied || res.already || [])[0];
      w.done = `Статус изменён: ${statusLabel(after?.current_status || wanted)}.`;
      const notes = consText(res.consequences, wanted).filter((l) => /^Превышение/.test(l));
      if (notes.length) w.warn = notes.join(" ");
      w.status = ""; w.at = ""; w.comment = ""; w.contractId = null; w.contractLabel = "";
      refreshDetailIfSelected(id);
    } catch (err) {
      if (unknownOutcome(err)) {
        // исход неизвестен: запрос мог дойти. Повторно НЕ отправляем — читаем изделие и говорим, что видит сервер
        try {
          const d = await api.get(`/elements/${id}`);
          if (d.current_status === wanted) { w.done = `Сервер подтвердил: статус «${statusLabel(d.current_status)}» уже установлен.`; w.status = ""; w.at = ""; w.comment = ""; applyToScene([d]); refreshDetailIfSelected(id); }
          else w.error = `Ответ не получен, изменение не подтверждено: сервер показывает статус «${statusLabel(d.current_status)}». Введённое сохранено — проверьте связь и отправьте снова.`;
        } catch (e2) { w.error = "Ответ не получен, и проверить результат не удалось: исход неизвестен. Ничего не отправлено повторно — обновите страницу и посмотрите историю статусов изделия."; }
      } else {
        w.error = errText(err, "Не удалось сохранить статус");   // ввод остаётся в форме
        if (err instanceof ApiError && err.status === 409) { send("refreshElement", { id }); refreshDetailIfSelected(id); }
      }
    } finally { w.busy = false; if (!isDead()) repaint(); }
  }

  // ================================================================ ГРУППОВОЕ ВЫДЕЛЕНИЕ
  function groupHtml() {
    const s = sc(); const m = s.multi;
    const items = s.multiItems;
    const withC = items ? items.filter((i) => i.contract_id != null).length : null;
    const chips = (arr, sw_) => arr.slice().sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="ws-chip eo-sumchip">${sw_ ? `<i class="ws-sw" style="background:${esc(sw(k))}"></i>` : ""}${esc(sw_ ? statusLabel(k) : k)}: <b>${n}</b></span>`).join("");
    const head = `<h3 class="ws-h">Выбрано элементов: ${m.count}</h3>
      <p class="v2-muted eo-hint">Щелчок — выбрать одно изделие; Ctrl (⌘) + щелчок — добавить или убрать; Shift + перетаскивание — рамка (добавляет к выбранному).</p>
      <div class="eo-sum"><div class="eo-sumrow"><span class="v2-muted">Типы</span>${chips(m.byType, false)}</div>
      <div class="eo-sumrow"><span class="v2-muted">Статусы</span>${chips(m.byStatus, true)}</div>
      ${withC !== null ? `<div class="eo-sumrow"><span class="v2-muted">Контракты</span><span class="ws-chip eo-sumchip">с контрактом: <b>${withC}</b></span><span class="ws-chip eo-sumchip">без контракта: <b>${items.length - withC}</b></span></div>` : ""}</div>
      <div class="ws-actions"><button type="button" class="v2-btn" data-act="clear-all">Снять выбор</button></div>`;
    if (!groupOps) return `<div class="ws-pad">${head}<p class="v2-muted ws-ro">Групповые изменения статуса и дат выполняются на рабочих местах «Модель» и «АРМ прораба».</p></div>`;
    if (!R.loaded) return `<div class="ws-pad">${head}</div>`;
    if (!R.status && !R.plannedDate) return `<div class="ws-pad">${head}<p class="v2-muted ws-ro">Групповые изменения недоступны: нет права изменять статусы и плановые даты на этом объекте.</p></div>`;
    if (!items) return `<div class="ws-pad">${head}<p class="ws-err" role="alert">Выбрано больше 3000 изделий — групповые операции недоступны. Уменьшите выбор.</p></div>`;
    if (items.length > MAX_BATCH) return `<div class="ws-pad">${head}<p class="ws-err" role="alert">Групповая операция принимает не больше ${nf(MAX_BATCH)} изделий за раз (выбрано ${nf(items.length)}). Уменьшите выбор.</p></div>`;
    return `<div class="ws-pad">${head}${R.status ? groupStatusHtml(items) : ""}${R.plannedDate ? groupPlannedHtml(items) : ""}</div>`;
  }
  const sigOf = (items, extra) => items.map((i) => `${i.id}:${i.current_status}:${i.contract_id ?? ""}`).join(",") + "|" + extra;

  function groupStatusHtml(items) {
    const g = G.st;
    const all = sc()?.statusOrder || [];
    const same = g.status ? items.filter((i) => i.current_status === g.status).length : 0;
    const pv = g.prev && g.prev.sig === sigOf(items, `${g.status}|${g.at}|${g.comment}`) ? g.prev : null;
    let prevHtml = "";
    if (pv) {
      const c = pv.resp.consequences, lines = consText(c, g.status);
      const probs = pv.resp.problems || [];
      prevHtml = `<div class="eo-preview" role="status"><b>Предпросмотр (ничего не записано)</b>
        <p>Будет изменено: <b>${nf(pv.body.items.length)}</b> изд.${pv.skipped ? `; не изменятся: ${nf(pv.skipped)} (уже «${esc(statusLabel(g.status))}»)` : ""}.</p>
        ${lines.length ? `<ul class="eo-cons">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : `<p class="v2-muted">Контракты сохраняются прежними. Последствий сверх смены статуса нет.</p>`}
        ${probs.length ? `<p class="ws-err" role="alert">Контракт не позволяет записать: ${esc(probs.slice(0, 3).map((p) => `${p.element_type} «${p.mark || "без марки"}» — ${p.message}`).join(" "))}${probs.length > 3 ? ` (и ещё ${probs.length - 3})` : ""}</p>` : ""}
        <div class="ws-actions"><button type="button" class="v2-btn v2-primary" data-eo="g-apply" ${g.busy || probs.length ? "disabled" : ""}>${g.busy ? "Сохранение…" : `Применить к ${nf(pv.body.items.length)} изд.`}</button>
          <button type="button" class="v2-btn" data-eo="g-cancel" ${g.busy ? "disabled" : ""}>Изменить</button></div></div>`;
    }
    return `<h4>Групповая смена статуса</h4>
      <form class="ws-form" id="eo-gform" autocomplete="off" novalidate>
        <label class="ws-fld">Новый статус
          <select name="status" ${g.busy ? "disabled" : ""}><option value="">— выберите —</option>${all.map((k) => `<option value="${esc(k)}" ${g.status === k ? "selected" : ""}>${esc(statusLabel(k))}</option>`).join("")}</select></label>
        <label class="ws-fld">Дата и время изменения <small>(пусто — сейчас)</small>
          <input type="datetime-local" name="at" value="${esc(g.at)}" ${g.busy ? "disabled" : ""}></label>
        <label class="ws-fld">Комментарий
          <textarea name="comment" rows="2" maxlength="500" ${g.busy ? "disabled" : ""}>${esc(g.comment)}</textarea></label>
        ${g.status && same ? `<p class="v2-muted ws-fnote">Уже «${esc(statusLabel(g.status))}»: ${nf(same)} из ${nf(items.length)} — они не изменятся.</p>` : ""}
        <p class="v2-muted ws-fnote">Контракты изделий СОХРАНЯЮТСЯ: форма не передаёт и не перезаписывает их. Контракт снимается только при возврате в «Запланирован» — сервер сообщит последствия до записи. Пачка применяется целиком либо не применяется.</p>
        <div class="ws-actions"><button type="submit" class="v2-btn" ${g.busy || !g.status ? "disabled" : ""}>Проверить последствия</button></div>
        ${g.error ? `<p class="ws-err" role="alert">${esc(g.error)}</p>` : ""}
        ${prevHtml}
      </form>`;
  }
  async function groupPreview() {
    const g = G.st; const s = sc();
    if (g.busy || !g.status || !R.status || !s?.multiItems) return;
    const all = s.multiItems;
    const items = all.filter((i) => i.current_status !== g.status);
    g.error = ""; g.done = ""; g.prev = null; setBanner("", "");
    if (!items.length) { g.error = `Все выделенные изделия уже в статусе «${statusLabel(g.status)}» — менять нечего.`; repaint(); return; }
    g.busy = true; repaint();
    const objectId = s.objectId ?? getObjectId();
    const sig = sigOf(all, `${g.status}|${g.at}|${g.comment}`);
    try {
      const body = statusBody("preview", objectId, g.status, g.at, g.comment, null, toItems(items));
      const resp = await api.post("/element-ops/status-batch", body);
      if (resp.already_applied) { setBanner("ok", "Уже выполнено: все изделия в нужном состоянии — повторная запись не нужна."); applyToScene(resp.already); return; }
      g.prev = { sig, body, resp, skipped: all.length - items.length, ids: items.map((i) => i.id) };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) { setBanner("err", `${errText(err, "Состояние изделий изменилось")} Схема обновлена — выберите изделия заново.`); send("reload"); }
      else g.error = errText(err, "Не удалось получить последствия");
    }
    finally { g.busy = false; if (!isDead()) repaint(); }
  }
  async function groupApply() {
    const g = G.st; const pv = g.prev;
    if (g.busy || !pv || !R.status) return;
    const c = pv.resp.consequences, lines = consText(c, g.status);
    const msg = [`Изменить статус у ${nf(pv.body.items.length)} изд. на «${statusLabel(g.status)}»?`, "", ...(lines.length ? lines.map((l) => "• " + l) : ["• Контракты сохраняются прежними."]), "",
      "Пачка применяется целиком либо не применяется. Каждое изменение попадёт в историю статусов и в журнал."].join("\n");
    const ok = await showConfirmDialog(msg, { confirmLabel: "Применить", multiline: true, danger: c.release_contracts > 0 });
    if (!ok || isDead() || g.busy) return;
    g.busy = true; g.error = ""; g.done = ""; setBanner("", ""); repaint();
    const body = { ...pv.body, mode: "apply", expect: { release_contracts: c.release_contracts, without_contract: c.without_contract } };
    const status = g.status;
    const reset = () => { g.status = ""; g.at = ""; g.comment = ""; };
    try {
      const res = await api.post("/element-ops/status-batch", body);
      applyToScene([...(res.applied || []), ...(res.already || [])]);
      setBanner(!res.already_applied && res.applied.length !== pv.body.items.length ? "warn" : "ok",
        res.already_applied ? `Уже выполнено: ${nf(res.already.length)} изд. — повторная запись не выполнялась.`
          : `Статус «${statusLabel(status)}» установлен у ${nf(res.applied.length)} изд. (по ответу сервера).${res.consequences.release_contracts ? ` Контракт снят у ${nf(res.consequences.release_contracts)} изд.` : ""}${res.applied.length !== pv.body.items.length ? ` Сервер подтвердил ${res.applied.length} из ${pv.body.items.length} изделий — проверьте историю.` : ""}`);
      g.prev = null; reset();
      const sel = sc()?.selected?.id; if (sel) reloadDetail(sel);
    } catch (err) {
      g.prev = null;
      if (unknownOutcome(err)) {
        try {
          const back = await readBack(pv.ids);
          if (back.every((d) => d.current_status === status)) { setBanner("ok", "Ответ не получен, но сервер подтвердил: статус установлен. Схема перечитана с сервера."); reset(); }
          else if (back.every((d, k) => d.current_status === pv.body.items[k === 0 ? 0 : pv.body.items.length - 1].expected_status)) setBanner("err", "Ответ не получен, изменение не подтверждено: изделия на сервере в прежнем статусе. Проверьте связь и повторите проверку последствий.");
          else setBanner("err", "Ответ не получен, состояние изделий на сервере неоднозначно. Ничего не отправлено повторно — схема перечитана, проверьте статусы.");
          send("reload");
        } catch (e2) { setBanner("err", "Ответ не получен, и проверить результат не удалось: исход неизвестен. Ничего не отправлено повторно — восстановите связь, обновите страницу и проверьте статусы."); }
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setBanner("err", `${errText(err, "Не удалось изменить статусы")} Ничего не изменено. Схема обновлена — выберите изделия заново.`);
        send("reload");                                              // расхождение: показываем актуальное
      } else g.error = errText(err, "Не удалось изменить статусы");
    } finally { g.busy = false; if (!isDead()) repaint(); }
  }

  // ---- плановая дата пачки
  function groupPlannedHtml(items) {
    const p = G.pd;
    const changed = p.date ? items.filter((i) => (i.planned_delivery_date || "") !== p.date).length : 0;
    const same = p.date ? items.length - changed : 0;
    const hasDate = items.filter((i) => i.planned_delivery_date).length;
    return `<h4>Плановая дата поставки</h4>
      <form class="ws-form" id="eo-gpd" autocomplete="off" novalidate>
        <label class="ws-fld">Дата
          <input type="date" name="pd" value="${esc(p.date)}" ${p.busy ? "disabled" : ""}></label>
        ${p.date ? `<p class="v2-muted ws-fnote">Будет установлена у ${nf(changed)} изд.${same ? `; уже стоит эта дата у ${nf(same)} — не изменятся` : ""}${changed && hasDate ? "; ранее заданные другие даты будут заменены" : ""}.</p>` : `<p class="v2-muted ws-fnote">Одна дата на все выделенные изделия. Ранее заданная дата сверяется с сервером: если её изменил кто-то другой, пачка не применится.</p>`}
        <div class="ws-actions"><button type="submit" class="v2-btn" ${p.busy || !p.date || !changed ? "disabled" : ""}>Установить дату…</button>
          <button type="button" class="v2-btn" data-eo="gpd-clear" ${p.busy || !hasDate ? "disabled" : ""}>Снять дату у ${nf(hasDate)}…</button></div>
        ${p.error ? `<p class="ws-err" role="alert">${esc(p.error)}</p>` : ""}
      </form>`;
  }
  async function groupPlanned(clear) {
    const p = G.pd; const s = sc();
    if (p.busy || !R.plannedDate || !s?.multiItems) return;
    const all = s.multiItems;
    const target = clear ? null : (p.date || null);
    if (!clear && !target) return;
    const items = all.filter((i) => (i.planned_delivery_date || null) !== target);
    p.error = ""; p.done = "";
    if (!items.length) { p.error = clear ? "У выделенных изделий плановой даты нет." : "Эта дата уже стоит у всех выделенных изделий."; repaint(); return; }
    const replaced = items.filter((i) => i.planned_delivery_date).length;
    const msg = [target ? `Установить плановую дату поставки ${fmtDate(target)} у ${nf(items.length)} изд.?` : `Снять плановую дату поставки у ${nf(items.length)} изд.?`, "",
      replaced ? `• Ранее заданная дата будет заменена${target ? "" : " (снята)"} у ${nf(replaced)} изд.` : "• Плановая дата ранее не была задана.",
      all.length - items.length ? `• Не изменятся: ${nf(all.length - items.length)} (уже ${target ? "с этой датой" : "без даты"}).` : "", "", "Пачка применяется целиком либо не применяется."].filter((x, i, a) => x !== "" || (i > 0 && a[i - 1] !== "")).join("\n");
    const ok = await showConfirmDialog(msg, { confirmLabel: target ? "Установить" : "Снять дату", multiline: true });
    if (!ok || isDead() || p.busy) return;
    p.busy = true; setBanner("", ""); repaint();
    const body = { object_id: s.objectId ?? getObjectId(), planned_date: target, items: items.map((i) => ({ element_id: i.id, expected_planned_date: i.planned_delivery_date ?? null })) };
    try {
      const res = await api.post("/element-ops/planned-date-batch", body);
      applyToScene([...(res.applied || []), ...(res.already || [])]);
      setBanner("ok", res.already_applied ? `Уже выполнено: дата стоит у ${nf(res.already.length)} изд.` : `${target ? `Плановая дата ${fmtDate(target)} установлена` : "Плановая дата снята"} у ${nf(res.applied.length)} изд. (по ответу сервера).`);
      p.date = "";
    } catch (err) {
      if (unknownOutcome(err)) {
        try {
          const back = await readBack(items.map((i) => i.id));
          if (back.every((d) => (d.planned_delivery_date || null) === target)) { setBanner("ok", "Ответ не получен, но сервер подтвердил: дата установлена. Схема перечитана."); p.date = ""; }
          else setBanner("err", "Ответ не получен, изменение не подтверждено. Ничего не отправлено повторно — схема перечитана, проверьте даты и повторите.");
          send("reload");
        } catch (e2) { setBanner("err", "Ответ не получен, и проверить результат не удалось: исход неизвестен. Ничего не отправлено повторно — восстановите связь, обновите страницу и проверьте даты."); }
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setBanner("err", `${errText(err, "Не удалось изменить плановые даты")} Ничего не изменено. Схема обновлена — выберите изделия заново.`);
        send("reload");
      } else p.error = errText(err, "Не удалось изменить плановые даты");
    } finally { p.busy = false; if (!isDead()) repaint(); }
  }

  // ================================================================ привязка обработчиков
  function bind(body) {
    const s = sc();
    const id = s?.selected?.id;
    const on = (sel, ev, fn) => body.querySelectorAll(sel).forEach((n) => n.addEventListener(ev, fn));
    // --- одно изделие
    const sf = body.querySelector("#ws-sform");
    if (sf && id != null) {
      const w = F(id).st;
      sf.querySelector('[name="status"]').addEventListener("change", (ev) => { w.status = ev.target.value; w.error = ""; w.done = ""; if (w.status === "planned") { w.contractId = null; w.contractLabel = ""; } repaint(); });
      sf.querySelector('[name="at"]').addEventListener("input", (ev) => { w.at = ev.target.value; });
      sf.querySelector('[name="comment"]').addEventListener("input", (ev) => { w.comment = ev.target.value; });
      sf.addEventListener("submit", (ev) => { ev.preventDefault(); submitStatus(id); });
    }
    on('[data-eo="st-contract"]', "click", async () => {
      const e = sc()?.selected; if (!e) return; const w = F(e.id).st;
      const v = await pickContract({ element: e, currentId: w.contractId, leading: [{ value: "none", label: "— без контракта —" }] });
      if (v === undefined || isDead()) return;
      w.contractId = v === "none" ? null : v; w.contractLabel = v === "none" ? "" : contractLabelById(v); repaint();
    });
    on('[data-eo="st-contract-clear"]', "click", () => { const e = sc()?.selected; if (!e) return; const w = F(e.id).st; w.contractId = null; w.contractLabel = ""; repaint(); });
    on('[data-eo="pd-open"]', "click", () => { const e = sc()?.selected; if (!e) return; const p = F(e.id).pd; p.open = true; p.date = e.planned_delivery_date || ""; p.error = ""; p.done = ""; repaint(); });
    on('[data-eo="pd-cancel"]', "click", () => { const e = sc()?.selected; if (!e) return; const p = F(e.id).pd; p.open = false; p.error = ""; repaint(); });
    on('[data-eo="pd-clear"]', "click", () => { if (id != null) submitPlanned(id, true); });
    const pf = body.querySelector("#eo-pd-form");
    if (pf && id != null) { const p = F(id).pd; pf.querySelector('[name="pd"]').addEventListener("input", (ev) => { p.date = ev.target.value; }); pf.addEventListener("submit", (ev) => { ev.preventDefault(); submitPlanned(id, false); }); }
    on('[data-eo="cm-open"]', "click", () => { const e = sc()?.selected; if (!e) return; const c = F(e.id).cm; c.open = true; c.text = e.comment || ""; c.error = ""; c.done = ""; repaint(); });
    on('[data-eo="cm-cancel"]', "click", () => { const e = sc()?.selected; if (!e) return; const c = F(e.id).cm; c.open = false; c.error = ""; repaint(); });
    const cf = body.querySelector("#eo-cm-form");
    if (cf && id != null) { const c = F(id).cm; cf.querySelector('[name="cm"]').addEventListener("input", (ev) => { c.text = ev.target.value; }); cf.addEventListener("submit", (ev) => { ev.preventDefault(); submitComment(id); }); }
    on('[data-eo="ct-pick"]', "click", () => { if (id != null) pickAndSetContract(id); });
    on('[data-eo="h-edit"]', "click", (ev) => { if (id != null) editHistory(id, Number(ev.currentTarget.dataset.id)); });
    on('[data-eo="h-del"]', "click", (ev) => { if (id != null) deleteHistory(id, Number(ev.currentTarget.dataset.id)); });
    on('[data-eo="ef-open"]', "click", () => { if (id != null) openElementForm(id); });
    on('[data-eo="banner-x"]', "click", () => { setBanner("", ""); repaint(); });
    // --- группа
    const gf = body.querySelector("#eo-gform");
    if (gf) {
      const g = G.st;
      gf.querySelector('[name="status"]').addEventListener("change", (ev) => { g.status = ev.target.value; g.error = ""; g.done = ""; g.prev = null; repaint(); });
      gf.querySelector('[name="at"]').addEventListener("input", (ev) => { g.at = ev.target.value; g.prev = null; });
      gf.querySelector('[name="comment"]').addEventListener("input", (ev) => { g.comment = ev.target.value; g.prev = null; });
      gf.addEventListener("submit", (ev) => { ev.preventDefault(); groupPreview(); });
    }
    on('[data-eo="g-apply"]', "click", () => groupApply());
    on('[data-eo="g-cancel"]', "click", () => { G.st.prev = null; repaint(); });
    const gp = body.querySelector("#eo-gpd");
    if (gp) {
      gp.querySelector('[name="pd"]').addEventListener("input", (ev) => { G.pd.date = ev.target.value; G.pd.error = ""; G.pd.done = ""; repaint(); });
      gp.addEventListener("submit", (ev) => { ev.preventDefault(); groupPlanned(false); });
    }
    on('[data-eo="gpd-clear"]', "click", () => groupPlanned(true));
  }

  // Фокус и позиция курсора переживают перерисовку панели (движок присылает снимки часто)
  function captureFocus(body) {
    const a = document.activeElement;
    if (!a || !body.contains(a) || !["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) return () => {};
    const form = a.closest("form")?.id, name = a.getAttribute("name");
    const pos = "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
    return () => {
      if (!form || !name) return;
      const n = body.querySelector(`#${form} [name="${name}"]`);
      if (n && !n.disabled) { n.focus(); if (pos && n.setSelectionRange) { try { n.setSelectionRange(pos[0], pos[1]); } catch (e) { /* type=date и т.п. */ } } }
    };
  }

  // ---- несохранённое и сторож ухода
  const dirtyOf = (w) => !w.busy && (w.status || w.comment.trim() || w.at);
  const hasUnsaved = () => Array.from(forms.values()).some((f) => dirtyOf(f.st)) || dirtyOf(G.st);
  async function guardLeave(submitSelected) {
    if (!hasUnsaved()) return true;
    const choice = await showUnsavedDialog("В форме смены статуса есть введённое, но не отправленное. Что сделать?");
    if (choice === "cancel") return false;
    if (choice === "discard") { for (const f of forms.values()) Object.assign(f.st, { status: "", at: "", comment: "", contractId: null, contractLabel: "" }); Object.assign(G.st, { status: "", at: "", comment: "", prev: null }); return true; }
    // «Сохранить и продолжить»: отправляем форму выбранного изделия и уходим только при успехе (групповую пачку так не отправляем — нужно подтверждение последствий)
    const id = sc()?.selected?.id;
    if (id && dirtyOf(F(id).st)) await submitStatus(id);
    if (dirtyOf(G.st)) return false;
    return !Array.from(forms.values()).some((f) => f.st.status || f.st.comment.trim() || f.st.at);
  }
  const canStatus = () => (R.loaded ? R.status : null);

  return { setRights, rightsFailed, reset, setContracts, cardHtml, groupHtml, bannerHtml, bind, captureFocus, hasUnsaved, guardLeave, canStatus, rights: R };
}
