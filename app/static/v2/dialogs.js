// Общие для всех модулей V2 диалоги — вынесены из users-access.js при
// переносе следующей группы форм, чтобы не заводить вторую копию (issue из
// ТЗ: "используй общие компоненты V2, а не копии"). Один экземпляр на всё
// приложение: пока один диалог ждёт ответа, повторный вызов (из ЛЮБОГО
// модуля) получает ТО ЖЕ обещание, а не второй диалог поверх.
//
// 2026-09-19: обобщено до showChoiceDialog (произвольный набор кнопок) —
// добавлены showConfirmDialog (подтверждение опасного действия) и
// showInfoDialog (замена alert() для сообщений, которые раньше показывали
// системным alert — например, отказ в удалении из-за зависимостей).
// showUnsavedDialog не изменил поведения, только стал тонкой обёрткой.

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let openDialogPromise = null;

// choices: [{key, label, primary?, focus?}] — порядок = порядок кнопок.
// Ровно один элемент должен иметь focus:true (начальный фокус).
function showChoiceDialog(message, choices, { label = "Диалог", multiline = false } = {}) {
  if (openDialogPromise) return openDialogPromise;
  openDialogPromise = new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "v2-dialog-backdrop";
    const text = multiline
      ? `<p style="white-space:pre-line">${escapeHtml(message)}</p>`
      : `<p>${escapeHtml(message)}</p>`;
    backdrop.innerHTML = `
      <div class="v2-dialog" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(label)}">
        ${text}
        <div class="v2-dialog-actions">
          ${choices.map((c) => `<button type="button" class="v2-btn ${c.primary ? "v2-primary" : ""}" data-choice="${c.key}">${escapeHtml(c.label)}</button>`).join("")}
        </div>
      </div>`;
    const dialog = backdrop.querySelector(".v2-dialog");

    function close(choice) {
      document.removeEventListener("keydown", onKeydown, true);
      if (backdrop.isConnected) document.body.removeChild(backdrop);
      openDialogPromise = null;
      if (previouslyFocused && document.contains(previouslyFocused) && previouslyFocused.focus) {
        previouslyFocused.focus();
      }
      resolve(choice);
    }
    // Отмена (Escape/клик по фону) — это ключ ПЕРВОГО пункта, если он есть
    // отдельным "отменяющим" вариантом; для диалогов с одной кнопкой
    // (info) Escape и клик по фону закрывают тем же ключом.
    const cancelKey = choices[0].key;
    function onKeydown(e) {
      if (e.key === "Escape") { e.preventDefault(); close(cancelKey); return; }
      if (e.key === "Tab") {
        const items = [...dialog.querySelectorAll("button")];
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    backdrop.addEventListener("click", (e) => {
      const choice = e.target.closest("[data-choice]")?.dataset.choice;
      if (choice) close(choice);
      else if (e.target === backdrop) close(cancelKey);
    });
    document.addEventListener("keydown", onKeydown, true);
    document.body.appendChild(backdrop);
    const focusKey = choices.find((c) => c.focus)?.key ?? cancelKey;
    dialog.querySelector(`[data-choice="${focusKey}"]`).focus();
  });
  return openDialogPromise;
}

export function showUnsavedDialog(message) {
  return showChoiceDialog(message, [
    { key: "cancel", label: "Остаться", focus: true },
    { key: "discard", label: "Не сохранять" },
    { key: "save", label: "Сохранить и продолжить", primary: true },
  ], { label: "Несохранённые изменения" });
}

// Подтверждение опасного/необратимого действия (удаление и т.п.) — замена
// системного confirm(): та же клавиатурная доступность и фокус-ловушка,
// что и у остальных диалогов V2, а не браузерный попап без стилей.
export function showConfirmDialog(message, { confirmLabel = "Удалить", cancelLabel = "Отмена" } = {}) {
  return showChoiceDialog(message, [
    { key: "cancel", label: cancelLabel, focus: true },
    { key: "confirm", label: confirmLabel, primary: true },
  ], { label: "Подтверждение" }).then((choice) => choice === "confirm");
}

// Информационное сообщение (замена alert()) — например, отказ в удалении
// из-за найденных зависимостей.
export function showInfoDialog(message, { okLabel = "Понятно" } = {}) {
  return showChoiceDialog(message, [
    { key: "ok", label: okLabel, primary: true, focus: true },
  ], { label: "Сообщение", multiline: true });
}

// Общая логика диалога для любого {message, save, discard} — общая и для
// requestLeave(), и для формо-специфичных сторожей (например, roleFormDirty
// в users-access.js), которым нужно решить диалог без привязки к
// module-level currentDirty.
export async function resolveDirty(info, onError) {
  const choice = await showUnsavedDialog(info.message);
  if (choice === "cancel") return false;
  if (choice === "discard") { info.discard?.(); return true; }
  try {
    await info.save();
    return true;
  } catch (err) {
    onError?.(err);
    return false;
  }
}
