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

// Все рёбра получают отдельную ручку. На коротких рёбрах значок выносится
// наружу, а линия от него указывает на точную середину редактируемого ребра.
export function edgeResizeHandles(outline, toScreen, width, height) {
  if (!Array.isArray(outline) || outline.length < 3) return [];
  const vertices = outline.map(toScreen);
  const center = vertices.reduce((sum, point) => [sum[0] + point[0] / vertices.length,
    sum[1] + point[1] / vertices.length], [0, 0]);
  const handles = outline.map((_, index) => {
    const a = vertices[index], b = vertices[(index + 1) % vertices.length];
    const anchorX = (a[0] + b[0]) / 2, anchorY = (a[1] + b[1]) / 2;
    return { index, x: anchorX, y: anchorY, anchorX, anchorY,
      length: Math.hypot(b[0] - a[0], b[1] - a[1]), angle: edgeResizeAngle(outline, index, toScreen) };
  });
  const placed = [];
  const inside = (x, y) => x >= 14 && y >= 14 && x <= width - 14 && y <= height - 14;
  const clear = (x, y) => placed.every((other) => Math.hypot(x - other.x, y - other.y) >= 28);
  for (const handle of [...handles].sort((a, b) => b.length - a.length)) {
    const short = handle.length < 28;
    if (!short && inside(handle.x, handle.y) && clear(handle.x, handle.y)) {
      placed.push(handle); continue;
    }
    const fromCenter = [handle.anchorX - center[0], handle.anchorY - center[1]];
    const magnitude = Math.hypot(...fromCenter);
    const outward = magnitude >= 1 ? fromCenter.map((value) => value / magnitude) :
      [Math.cos(handle.angle), Math.sin(handle.angle)];
    const side = [-outward[1], outward[0]];
    const candidates = [];
    if (!short) candidates.push([handle.anchorX, handle.anchorY]);
    for (const distance of [25, 42, 60, 80]) for (const direction of [outward, side, side.map((value) => -value), outward.map((value) => -value)])
      candidates.push([handle.anchorX + direction[0] * distance, handle.anchorY + direction[1] * distance]);
    const position = candidates.find(([x, y]) => inside(x, y) && clear(x, y)) ||
      candidates.find(([x, y]) => inside(x, y)) || [handle.anchorX, handle.anchorY];
    handle.x = position[0]; handle.y = position[1];
    placed.push(handle);
  }
  return handles;
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
