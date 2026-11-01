// Не схлопываем прокрученную карточку до «Загрузка…» между ответами API.
// Как в V1: сохраняем заполненный каркас до прихода следующей карточки.
export function createDetailPanelScroll({ alive = () => true, schedule = cb => requestAnimationFrame(cb) } = {}) {
  let previous = null, revision = 0;
  return {
    update(body, { scope = null, loading = false, complete = false }, render) {
      const current = ++revision;
      if (loading && scope && previous?.scope === scope && previous.complete && body.firstElementChild) {
        body.setAttribute('aria-busy', 'true');
        // Старые значения видны только как фон загрузки; кнопки предыдущего
        // элемента недоступны, пока выбор уже указывает на следующий.
        body.firstElementChild.inert = true;
        body.firstElementChild.style.opacity = '0.55';
        return false;
      }
      const top = body.scrollTop, left = body.scrollLeft;
      render();
      body.removeAttribute('aria-busy');
      if (body.firstElementChild) {
        body.firstElementChild.inert = false;
        body.firstElementChild.style.opacity = '';
      }
      body.scrollTop = top; body.scrollLeft = left;
      const appliedTop = body.scrollTop, appliedLeft = body.scrollLeft;
      previous = { scope, complete };
      schedule(() => {
        if (!alive() || current !== revision) return;
        // Учитываем следующий кадр, но не отменяем ручную прокрутку человека.
        if (body.scrollTop === appliedTop) body.scrollTop = top;
        if (body.scrollLeft === appliedLeft) body.scrollLeft = left;
      });
      return true;
    },
  };
}
