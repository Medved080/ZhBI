// The two issued-order panes scroll independently. No document/window listeners.
export function bindIssuedLayout(host) {
  const layout = host.querySelector('.snz-issued-layout'), handle = host.querySelector('[data-snz-splitter]');
  if (!layout || !handle) return;
  let fraction = .4;
  try { const saved = Number(localStorage.getItem('snz-issued-height')); if (saved >= .15 && saved <= .8) fraction = saved; } catch {}
  function apply(value) {
    fraction = Math.max(.15, Math.min(.8, value));
    layout.style.setProperty('--snz-upper-height', `${fraction * 100}%`);
    handle.setAttribute('aria-valuenow', Math.round(fraction * 100));
    try { localStorage.setItem('snz-issued-height', String(fraction)); } catch {}
  }
  apply(fraction);
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); handle.focus(); handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const box = layout.getBoundingClientRect();
    apply((e.clientY - box.top) / box.height);
  });
  handle.addEventListener('pointerup', e => { if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId); });
  handle.addEventListener('keydown', e => {
    const delta = {ArrowUp: -.05, ArrowDown: .05, Home: .15, End: .8}[e.key];
    if (delta == null) return;
    e.preventDefault(); apply(e.key === 'Home' || e.key === 'End' ? delta : fraction + delta);
  });
}
