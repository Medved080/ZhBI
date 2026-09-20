// Сцены раздела «Контрагенты» (подключаются из scenes.js).
import { waitFor } from "/tests/helpers.js";

const NAV = ".v2-nav [data-section]";
const contractOf = (a, cid) => a.ctl.data.contracts.find((c) => c.id === cid);
const cpOfContract = (a, cid) => {
  const s = a.ctl.data.specifications.find((x) => x.id === contractOf(a, cid).specification_id);
  return a.ctl.data.agreements.find((g) => g.id === s.agreement_id).counterparty_id;
};

async function openCp(a) {
  await waitFor(() => a.$(`${NAV}[data-section="counterparties"]`), { what: "навигация" });
  a.click(a.$(`${NAV}[data-section="counterparties"]`));
  await waitFor(() => a.$("#cp-list [data-open]"), { what: "список контрагентов" });
  await a.settle(60);
}
async function openCard(a, id, tab) {
  a.click(a.$(`[data-open="${id}"]`));
  await waitFor(() => a.$("[data-tab]"), { what: "карточка" });
  if (tab) {
    a.click(a.$(`[data-tab="${tab}"]`));
    await waitFor(() => a.$(`[data-tab="${tab}"][aria-pressed="true"]`), { what: `вкладка ${tab}` });
    await a.settle(150);
  }
}
async function openContract(a, cid, tab = "lines", requisitesOpen = false) {
  await openCp(a);
  await openCard(a, cpOfContract(a, cid), "contracting");
  await waitFor(() => a.$(`[data-c-open="edit:${cid}"]`), { what: "контракт в списке" });
  a.click(a.$(`[data-c-open="edit:${cid}"]`));
  await waitFor(() => a.$("#ctr-back"), { what: "рабочее пространство" });
  if (requisitesOpen) { a.$("#ctr-requisites-details").open = true; }
  if (tab !== "lines") {
    a.click(a.$(`[data-ctr-tab="${tab}"]`));
    if (tab === "expanded") await waitFor(() => a.$$("[data-elem-planned]").length > 0, { what: "строки «Развёрнуто»" });
  }
  await a.settle(200);
}

export const CP_SCENES = {
  "cp-list": { title: "CP: список контрагентов", open: openCp },
  "cp-card-main": { title: "CP: карточка — основное", async open(a) { await openCp(a); await openCard(a, 1); await waitFor(() => a.$("#cpf-short"), { what: "форма" }); } },
  "cp-card-main-long": { title: "CP: карточка с очень длинными названиями", async open(a) { await openCp(a); await openCard(a, 3); await waitFor(() => a.$("#cpf-short"), { what: "форма" }); await a.settle(120); } },
  "cp-card-main-dirty": { title: "CP: карточка — есть несохранённое", async open(a) {
    await openCp(a); await openCard(a, 7); await waitFor(() => a.$("#cpf-contact-person"), { what: "форма" });
    await a.type(a.$("#cpf-contact-person"), " (правка)"); await waitFor(() => a.$("#cp-save"), { what: "подвал" });
    a.$("#cpf-contact-person").blur(); await a.settle(120);
  } },
  "cp-card-contracting": { title: "CP: карточка — контрактация (договоры, спецификации, контракты)", async open(a) {
    await openCp(a); await openCard(a, 1, "contracting");
    await waitFor(() => a.$$("[data-agreement]").length === 2, { what: "договоры" });
    a.$$("[data-agreement]").forEach((d) => { d.open = true; });
    await a.settle(60);
    a.$$("[data-spec]").forEach((d) => { d.open = true; });
    await a.settle(150);
  } },
  "cp-card-other": { title: "CP: карточка — ёмкость («Прочее»)", async open(a) { await openCp(a); await openCard(a, 1, "other"); await waitFor(() => a.$("#cp-capacity"), { what: "ёмкость" }); } },
  "cp-contract-lines": { title: "CP: контракт — позиции (реквизиты раскрыты)", open: (a) => openContract(a, 1, "lines", true) },
  "cp-contract-expanded": { title: "CP: контракт — «Развёрнуто» (плановые даты)", open: (a) => openContract(a, 1, "expanded") },
  "cp-contract-expanded-error": { title: "CP: контракт — «Развёрнуто», ошибка записи даты на строке", async open(a) {
    await openContract(a, 1, "expanded");
    a.ctl.failNext("PATCH /elements/101/planned-delivery-date", { status: 500, detail: "Сбой записи даты" });
    const el = a.$('[data-elem-planned="101"]'); el.value = "2026-10-05";
    el.dispatchEvent(new a.win.Event("change", { bubbles: true }));
    await waitFor(() => a.$("[data-elem-retry]"), { what: "ошибка на строке" }); await a.settle(120);
  } },
  "cp-contract-incidents": { title: "CP: контракт — инциденты", open: (a) => openContract(a, 1, "incidents") },
  "cp-contract-capacity": { title: "CP: контракт — производительность", open: (a) => openContract(a, 1, "capacity") },
  "cp-contract-long": { title: "CP: контракт с очень длинными названиями", open: (a) => openContract(a, 9, "lines", true) },
  "cp-contract-replacement": { title: "CP: контракт — выбор замены при удалении", async open(a) {
    await openContract(a, 1, "lines");
    const acts = a.byText("summary", "Действия"); if (acts) acts.click();
    a.click(a.$("#ctr-delete"));
    await waitFor(() => a.$("#ctr-replacement-select") || a.dialog(), { what: "пикер" });
    if (a.dialog()) { await a.answerDialog("Удалить"); await waitFor(() => a.$("#ctr-replacement-select"), { what: "пикер" }); }
    await a.settle(150);
  } },
};
