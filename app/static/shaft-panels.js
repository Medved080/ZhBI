// Host ES module. No global state; the existing authenticated fetch wrapper
// (including CSRF behavior) and the selected object are explicit dependencies.
export function panelExtrusionHeight(element) {
  if (element.element_type !== 'Панель облицовки шахты') return null;
  if (!Number.isFinite(element.height_mm) || element.height_mm <= 0) {
    throw new Error(`У панели ${element.id} отсутствует высота из DXF`);
  }
  return element.height_mm;
}

export function mountShaftImport(container, { objectId, request, onApplied }) {
  if (!Number.isInteger(objectId) || objectId <= 0) throw new Error('Выберите объект ЖБИ');
  const form = document.createElement('form');
  form.innerHTML = `<h2>Панели облицовки лифтовых шахт</h2>
    <p>Развертки ГП1/ГП2 привязываются к осям 5–7 / Е–Ж выбранного объекта.</p>
    <label>Чертеж DXF <input name="drawing" type="file" accept=".dxf" required></label>
    <label>Толщина отдельной панели, мм <input name="thickness" type="number" min="1" max="150" step="0.1" placeholder="По данным изделия"></label>
    <p>Без толщины доступно распознавание лицевых поверхностей. Размер стенки 300 мм не подставляется как толщина панели.</p>
    <button type="submit">Распознать и проверить</button>
    <button type="button" data-action="cancel">Отменить анализ</button>
    <p role="status" data-status></p><div data-result></div>`;
  container.replaceChildren(form);
  let current = null, busy = false, disposed = false;
  const status = form.querySelector('[data-status]');
  const result = form.querySelector('[data-result]');
  async function api(url, options) {
    const response = await request(url, options);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(typeof error.detail === 'string' ? error.detail : `Ошибка ${response.status}`);
    }
    return response.json();
  }
  function pendingState(value) {
    busy = value;
    form.querySelectorAll('button,input').forEach(n => n.disabled = value);
  }
  async function cancel() {
    const old = current; current = null; result.replaceChildren();
    if (old) {
      const response = await request(`/shaft-panels/pending/${encodeURIComponent(old.token)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 410) throw new Error('Не удалось отменить предыдущий анализ');
    }
  }
  function drawPreview(data) {
    result.replaceChildren();
    const summary = document.createElement('p');
    summary.textContent = `${data.drawing.panels.length} панелей; ${Object.keys(data.drawing.counts.by_mark).length} марок. Сетка: ${data.grid_source}.`;
    result.append(summary);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    ['Марка','Шахта / сторона','Ш × В, мм','Расположение'].forEach(t => {
      const th = document.createElement('th'); th.textContent = t; head.append(th);
    });
    const body = table.createTBody();
    data.drawing.panels.forEach(p => {
      const row = body.insertRow();
      [p.mark, `${p.shaft}/${p.face}`, `${p.width_mm} × ${p.height_mm}`, p.address].forEach(t => row.insertCell().textContent = t);
    });
    const scroll = document.createElement('div'); scroll.style.cssText = 'max-height:320px;overflow:auto'; scroll.append(table); result.append(scroll);
    for (const warning of data.drawing.warnings) {
      const label = document.createElement('label'); label.style.display = 'block';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.warning = warning.code;
      label.append(checkbox, document.createTextNode(warning.message)); result.append(label);
    }
    if (!data.analysis) return;
    const counts = document.createElement('p');
    counts.textContent = `Добавить: ${data.analysis.counts.new}; обновить: ${data.analysis.counts.updated}; без изменений: ${data.analysis.counts.unchanged}; отсутствуют в новой версии: ${data.analysis.counts.missing}.`;
    result.append(counts);
    data.analysis.conflicts.forEach(c => { const p = document.createElement('p'); p.textContent = `Элемент ${c.id}: ${c.reason}`; result.append(p); });
    const retire = document.createElement('input'); retire.type = 'checkbox';
    const label = document.createElement('label'); label.append(retire, document.createTextNode('Снять актуальность отсутствующих панелей только ГП1/ГП2; сохранить их историю')); result.append(label);
    const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Добавить панели в объект';
    apply.disabled = data.analysis.conflicts.length > 0; result.append(apply);
    apply.addEventListener('click', async () => {
      if (busy || data.analysis.conflicts.length) return;
      const checks = [...result.querySelectorAll('[data-warning]')];
      if (checks.some(n => !n.checked)) { status.textContent = 'Подтвердите замечания к чертежу.'; return; }
      pendingState(true);
      try {
        const value = await api('/shaft-panels/apply', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:current.token, acknowledged_warnings:checks.map(n=>n.dataset.warning), retire_missing:retire.checked }) });
        current = null; result.replaceChildren(); status.textContent = `Готово. Добавлено ${value.new}, обновлено ${value.updated}.`;
        await onApplied(value);
      } catch (e) { status.textContent = e.message; }
      finally { if (!disposed) pendingState(false); }
    });
  }
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (busy) return; pendingState(true); status.textContent = 'Распознавание…';
    try {
      await cancel();
      const body = new FormData(); body.set('object_id', String(objectId)); body.set('file', form.elements.drawing.files[0]);
      if (form.elements.thickness.value) body.set('thickness_mm', form.elements.thickness.value);
      const data = await api('/shaft-panels/analyze', { method:'POST', body }); current = data;
      if (disposed) { await cancel(); return; }
      if (!disposed) { drawPreview(data); status.textContent = data.analysis ? 'Проверьте сводку перед применением.' : 'Панели распознаны. Для добавления объемов укажите толщину и повторите анализ.'; }
    } catch (e) { status.textContent = e.message; }
    finally { if (!disposed) pendingState(false); }
  });
  form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    if (!busy) cancel().then(() => status.textContent = 'Анализ отменен.').catch(e => status.textContent = e.message);
  });
  for (const field of [form.elements.drawing, form.elements.thickness]) field.addEventListener('change', () => {
    if (!busy && current) cancel().then(() => status.textContent = 'Параметры изменились — повторите анализ.').catch(e => status.textContent = e.message);
  });
  return () => { disposed = true; cancel().catch(() => {}); container.replaceChildren(); };
}
