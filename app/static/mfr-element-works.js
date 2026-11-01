// Общий вид связанных работ в свойствах V1/V2 и в подсказке модели МФР.
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const statusNames = { plan: 'Не начата', in_progress: 'В работе', done: 'Выполнена' };
const dateLabel = value => value ? String(value).slice(0,10).split('-').reverse().join('.') : '—';
export function renderElementWorks(data) {
  const works = data?.items || [];
  const context = [data?.category, data?.section, data?.level].filter(Boolean).join(' · ');
  const rows = works.map(work => {
    const percent = Math.max(0, Math.min(100, Number(work.percent) || 0));
    const dates = [['План',work.plan_start,work.plan_end],['Прогноз',work.forecast_start,work.forecast_end]]
      .filter(([,start,end]) => start || end).map(([label,start,end]) => `<div>${label}: ${escapeText(dateLabel(start))} — ${escapeText(dateLabel(end))}</div>`).join('');
    return `<li class="mfr-ew-item"><div class="mfr-ew-name">${work.code ? `<span class="mfr-ew-code">${escapeText(work.code)}</span> ` : ''}${escapeText(work.name)}</div>
      ${work.path ? `<div class="mfr-ew-path">WBS: ${escapeText(work.path)}</div>` : ''}
      <div class="mfr-ew-state"><span>${escapeText(statusNames[work.status] || 'Не начата')}</span><strong>${percent}%</strong></div>
      <div class="mfr-ew-bar" role="progressbar" aria-label="${escapeText(work.name)}" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><i style="width:${percent}%"></i></div>
      ${dates ? `<div class="mfr-ew-dates">${dates}</div>` : ''}</li>`;
  }).join('');
  return `<section class="mfr-ew" aria-label="Связанные работы"><h4>Связанные работы</h4>
    ${context ? `<div class="mfr-ew-context">${escapeText(context)}</div>` : ''}
    ${works.length ? `<div class="mfr-ew-scope">Текущий факт по работам в блоке «этаж × секция».</div><ul class="mfr-ew-list">${rows}</ul>`
      : `<div class="mfr-ew-empty">${escapeText(data?.reason || 'Связанные работы не настроены.')}</div>`}</section>`;
}

// Таймер и ответ привязаны к объекту, элементу и виду. Ушедший запрос
// не может показать карточку после смены цели, вращения или фильтра.
export function createElementWorksHover({load, context, enabled = () => true}) {
  let timer = null, controller = null, target = null, sequence = 0, tip = null;
  function hide() {
    clearTimeout(timer); timer = null; controller?.abort(); controller = null;
    target = null; sequence++; if (tip) tip.hidden = true;
  }
  function position(x,y) {
    const rect = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(10,Math.min(x+16,innerWidth-rect.width-10))}px`;
    tip.style.top = `${Math.max(10,Math.min(y+18,innerHeight-rect.height-10))}px`;
  }
  function move(pick,x,y) {
    if (!enabled()) { hide(); return; }
    const key = context();
    if (target?.key === key && Math.hypot(x-target.x,y-target.y) <= 1) return;
    hide(); target = {key,x,y}; const token = sequence;
    timer = setTimeout(async () => {
      if (token !== sequence || context() !== key || !enabled()) return;
      const id = pick(x,y);
      if (!id) return;
      controller = new AbortController();
      try {
        const card = await load(id,controller.signal);
        if (token !== sequence || target?.key !== key || context() !== key || !enabled()) return;
        if (!tip) {
          tip = document.createElement('div'); tip.id='mfr-element-works-tooltip'; tip.role='tooltip'; tip.hidden=true;
          tip.addEventListener('mouseleave',hide); document.body.append(tip);
        }
        tip.innerHTML = renderElementWorks(card['связанные_работы']); tip.hidden=false; position(x,y);
      } catch (error) { if (error.name !== 'AbortError') hide(); }
    },2000);
  }
  function leave(event) { if (!tip?.contains(event.relatedTarget)) hide(); }
  function keydown(event) { if (event.key === 'Escape') hide(); }
  function scroll(event) { if (!tip?.contains(event.target)) hide(); }
  document.addEventListener('keydown',keydown); window.addEventListener('blur',hide); window.addEventListener('resize',hide); document.addEventListener('scroll',scroll,true);
  return {move,hide,leave,dispose() { hide(); tip?.remove(); document.removeEventListener('keydown',keydown); window.removeEventListener('blur',hide); window.removeEventListener('resize',hide); document.removeEventListener('scroll',scroll,true); }};
}
