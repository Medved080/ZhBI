// Host ES module. No global state; the existing authenticated fetch wrapper
// (including CSRF behavior) and the selected object are explicit dependencies.
export function panelExtrusionHeight(element) {
  if (element.element_type !== 'Панель облицовки шахты') return null;
  if (!Number.isFinite(element.height_mm) || element.height_mm <= 0) {
    throw new Error(`У панели ${element.id} отсутствует высота из DXF`);
  }
  return element.height_mm;
}

// Разметка — общий язык форм сервиса (2026-09-08, живой запрос «дизайн
// формы в соответствии с общими правилами сервиса»): нумерованные шаги
// (.bulk-edit-steps/.bulk-edit-block/.step-num — тот же приём, что у
// «Массовой правки через Excel» и загрузки справочника объектов), кнопки
// .btn/.btn-primary/.btn-secondary, таблица .bulk-edit-table, чекбоксы
// label.toggle. Раньше форма была голой (button без класса, table без
// стиля) и выбивалась из остального интерфейса.
export function mountShaftImport(container, { objectId, request, onApplied }) {
  if (!Number.isInteger(objectId) || objectId <= 0) throw new Error('Выберите объект ЖБИ');
  const form = document.createElement('form');
  form.innerHTML = `
    <div class="modal-sticky-head">
      <h2>Панели облицовки лифтовых шахт</h2>
      <p class="hint-text">Развёртки ГП1/ГП2 привязываются к осям 5–7 / Е–Ж выбранного объекта.</p>
      <div class="bulk-edit-steps">
        <div class="bulk-edit-block bulk-edit-block-file">
          <div class="bulk-edit-block-title"><span class="step-num">1</span>Чертёж и толщина</div>
          <div class="bulk-edit-controls">
            <input name="drawing" type="file" accept=".dxf" required>
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px">
            Толщина панели, мм
            <input name="thickness" type="number" min="1" max="500" step="0.1"
                   placeholder="по паспорту изделия" style="width:90px">
          </label>
          <div class="bulk-edit-status">Без толщины доступно только распознавание лицевых
            поверхностей — размер стенки 300&nbsp;мм не подставляется как толщина панели.</div>
        </div>
        <div class="bulk-edit-block">
          <div class="bulk-edit-block-title"><span class="step-num">2</span>Распознать и проверить</div>
          <div class="bulk-edit-controls">
            <button type="submit" class="btn btn-primary">Распознать</button>
            <button type="button" class="btn btn-secondary" data-action="cancel">Отменить анализ</button>
          </div>
          <p role="status" class="bulk-edit-status" data-status></p>
        </div>
      </div>
    </div>
    <div class="modal-sticky-scroll" data-result></div>`;
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
    summary.className = 'hint-text';
    summary.textContent = `${data.drawing.panels.length} панелей; ${Object.keys(data.drawing.counts.by_mark).length} марок. Сетка: ${data.grid_source}.`;
    result.append(summary);
    const table = document.createElement('table');
    table.className = 'bulk-edit-table';
    const head = table.createTHead().insertRow();
    ['Марка','Шахта / сторона','Ш × В, мм','Расположение'].forEach(t => {
      const th = document.createElement('th'); th.textContent = t; head.append(th);
    });
    const body = table.createTBody();
    data.drawing.panels.forEach(p => {
      const row = body.insertRow();
      [p.mark, `${p.shaft}/${p.face}`, `${p.width_mm} × ${p.height_mm}`, p.address].forEach(t => row.insertCell().textContent = t);
    });
    const wrap = document.createElement('div');
    wrap.className = 'bulk-edit-table-wrap';
    wrap.style.maxHeight = '320px';
    wrap.style.overflowY = 'auto';
    wrap.append(table);
    result.append(wrap);
    if (data.drawing.warnings.length) {
      const warnBlock = document.createElement('div');
      warnBlock.className = 'bulk-edit-block';
      warnBlock.style.marginTop = '10px';
      const title = document.createElement('div');
      title.className = 'bulk-edit-block-title';
      title.textContent = 'Замечания к чертежу — подтвердите каждое';
      warnBlock.append(title);
      for (const warning of data.drawing.warnings) {
        const label = document.createElement('label'); label.className = 'toggle';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.warning = warning.code;
        label.append(checkbox, document.createTextNode(warning.message)); warnBlock.append(label);
      }
      result.append(warnBlock);
    }
    if (!data.analysis) return;
    const stepApply = document.createElement('div');
    stepApply.className = 'bulk-edit-block';
    stepApply.style.marginTop = '10px';
    const stepTitle = document.createElement('div');
    stepTitle.className = 'bulk-edit-block-title';
    stepTitle.innerHTML = '<span class="step-num">3</span>Применить';
    stepApply.append(stepTitle);
    const counts = document.createElement('div');
    counts.className = 'bulk-edit-status';
    counts.textContent = `Добавить: ${data.analysis.counts.new}; обновить: ${data.analysis.counts.updated}; без изменений: ${data.analysis.counts.unchanged}; отсутствуют в новой версии: ${data.analysis.counts.missing}.`;
    stepApply.append(counts);
    data.analysis.conflicts.forEach(c => {
      const p = document.createElement('p'); p.className = 'hint-text';
      p.textContent = `Элемент ${c.id}: ${c.reason}`; stepApply.append(p);
    });
    const retire = document.createElement('input'); retire.type = 'checkbox';
    const retireLabel = document.createElement('label'); retireLabel.className = 'toggle';
    retireLabel.append(retire, document.createTextNode('Снять актуальность отсутствующих панелей только ГП1/ГП2; сохранить их историю'));
    stepApply.append(retireLabel);
    const controls = document.createElement('div');
    controls.className = 'bulk-edit-controls';
    controls.style.marginTop = '8px';
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'btn btn-primary';
    apply.textContent = 'Добавить панели в объект';
    apply.disabled = data.analysis.conflicts.length > 0;
    controls.append(apply);
    stepApply.append(controls);
    result.append(stepApply);
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
