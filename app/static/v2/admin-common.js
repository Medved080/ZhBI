// Общие части экранов области «администрирование»: каркас страницы, текст ошибки, диалог с подтверждением вводом слова.
import { ApiError } from "./api.js";
import { esc } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";

export const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));

/** Общий каркас экрана: хлебные крошки, заголовок, статус реализации, пояснение. Возвращает узел содержимого. */
export function frame(el, screen, groupTitle) {
  el.className = "v2-page";
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div id="as-body"></div>
    </div>`;
  return el.querySelector("#as-body");
}


/** Подтверждение ВВОДОМ слова/названия — для необратимых операций: диалог перечисляет последствия, кнопка подтверждения доступна только после точного ввода
 *  (случайный Enter или двойной клик ничего не выполнят). Возвращает true/false. Escape и клик по фону — отказ; фокус ловится внутри диалога. */
export function askTyped(message, phrase, { confirmLabel = "Подтвердить", inputLabel = "Для подтверждения введите" } = {}) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "v2-dialog-backdrop";
    backdrop.innerHTML = `<div class="v2-dialog" role="alertdialog" aria-modal="true" aria-label="Подтверждение">
      <p style="white-space:pre-line">${esc(message)}</p>
      <label class="v2-field">${esc(inputLabel)}: <b>${esc(phrase)}</b><input id="ty-input" autocomplete="off" aria-label="Слово для подтверждения"></label>
      <div class="v2-dialog-actions"><button type="button" class="v2-btn" data-choice="cancel">Отмена</button>
        <button type="button" class="v2-btn v2-danger" data-choice="confirm" disabled>${esc(confirmLabel)}</button></div></div>`;
    const input = backdrop.querySelector("#ty-input"), okBtn = backdrop.querySelector('[data-choice="confirm"]');
    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      if (backdrop.isConnected) document.body.removeChild(backdrop);
      if (previouslyFocused && document.contains(previouslyFocused) && previouslyFocused.focus) previouslyFocused.focus();
      resolve(v);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter" && e.target === input) { e.preventDefault(); if (!okBtn.disabled) close(true); }
      else if (e.key === "Tab") {
        const items = [...backdrop.querySelectorAll("input, button:not([disabled])")], first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    input.addEventListener("input", () => { okBtn.disabled = input.value.trim() !== String(phrase).trim(); });
    backdrop.addEventListener("click", (e) => {
      const c = e.target.closest("[data-choice]")?.dataset.choice;
      if (c === "confirm" && !okBtn.disabled) close(true); else if (c === "cancel" || e.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
    input.focus();
  });
}
