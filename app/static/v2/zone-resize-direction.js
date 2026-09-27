// Направление сдвига грани в пикселях текущего вида. В 3D проекция
// нормали меняется вместе с камерой, поэтому одного угла ребра недостаточно.
export function edgeResizeAngle(outline, index, toScreen) {
  const a = outline?.[index], b = outline?.[(index + 1) % outline.length];
  if (!a || !b) return 0;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1) return 0;
  const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const step = Math.max(100, length / 5);
  const p = toScreen(middle);
  const q = toScreen([middle[0] - dy / length * step, middle[1] + dx / length * step]);
  const sx = q[0] - p[0], sy = q[1] - p[1];
  if (Number.isFinite(sx) && Number.isFinite(sy) && Math.hypot(sx, sy) >= 0.5) return Math.atan2(sy, sx);
  const sa = toScreen(a), sb = toScreen(b);
  return Math.atan2(sb[1] - sa[1], sb[0] - sa[0]) + Math.PI / 2;
}

const cursors = new Map();
export function edgeResizeCursor(angle) {
  // Стрелка двусторонняя: повороты на 180° выглядят одинаково.
  const degrees = ((Math.round(angle * 180 / Math.PI / 5) * 5 % 180) + 180) % 180;
  if (!cursors.has(degrees)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g transform="rotate(${degrees} 16 16)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16h22M5 16l6-5M5 16l6 5M27 16l-6-5M27 16l-6 5" stroke="white" stroke-width="5"/><path d="M5 16h22M5 16l6-5M5 16l6 5M27 16l-6-5M27 16l-6 5" stroke="#233d4b" stroke-width="2.5"/></g></svg>`;
    cursors.set(degrees, `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, ew-resize`);
  }
  return cursors.get(degrees);
}
