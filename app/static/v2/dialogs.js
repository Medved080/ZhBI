// Общий для всех модулей V2 диалог "несохранённые изменения" — вынесен из
// users-access.js при переносе следующей группы форм, чтобы не заводить
// вторую копию (issue из ТЗ: "используй общие компоненты V2, а не копии").
// Один экземпляр на всё приложение: пока один модуль ждёт ответа, другой
// модуль тем же вызовом получит ТО ЖЕ обещание, а не второй диалог поверх.

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let openDialogPromise = null;

export function showUnsavedDialog(message) {
  if (openDialogPromise) return openDialogPromise;
  openDialogPromise = new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "v2-dialog-backdrop";
    backdrop.innerHTML = `
      <div class="v2-dialog" role="alertdialog" aria-modal="true" aria-label="Несохранённые изменения">
        <p>${escapeHtml(message)}</p>
        <div class="v2-dialog-actions">
          <button type="button" class="v2-btn" data-choice="cancel">Остаться</button>
          <button type="button" class="v2-btn" data-choice="discard">Не сохранять</button>
          <button type="button" class="v2-btn v2-primary" data-choice="save">Сохранить и продолжить</button>
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
    function onKeydown(e) {
      if (e.key === "Escape") { e.preventDefault(); close("cancel"); return; }
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
      else if (e.target === backdrop) close("cancel");
    });
    document.addEventListener("keydown", onKeydown, true);
    document.body.appendChild(backdrop);
    // Начальный фокус — на "Остаться": уход из формы отменой действия по
    // умолчанию безопаснее, чем случайное сохранение недописанного ввода
    // клавишей Enter.
    dialog.querySelector('[data-choice="cancel"]').focus();
  });
  return openDialogPromise;
}

// Общая логика диалога для любого {message, save, discard} — общий и для
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
