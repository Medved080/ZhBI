// Перенос дочернего контура из старого прямоугольника крана в новый.
// Координаты относительно сторон крана сохраняются; стоянка остаётся внутри.
export function fitChildToResizedParent(oldParent, newParent, child) {
  if (oldParent?.length !== 4 || newParent?.length !== 4 || !child?.length) return null;
  const [a, b, , d] = oldParent;
  const ux = b[0] - a[0], uy = b[1] - a[1];
  const vx = d[0] - a[0], vy = d[1] - a[1];
  const det = ux * vy - uy * vx;
  if (Math.abs(det) < 1e-8) return null;
  const local = child.map(([x, y]) => {
    const px = x - a[0], py = y - a[1];
    return [(px * vy - py * vx) / det, (ux * py - uy * px) / det];
  });
  const fitAxis = (index) => {
    const values = local.map((point) => point[index]);
    const min = Math.min(...values), max = Math.max(...values), span = max - min;
    if (span > 1) return values.map((value) => (value - min) / span);
    const shift = min < 0 ? -min : max > 1 ? 1 - max : 0;
    return values.map((value) => Math.max(0, Math.min(1, value + shift)));
  };
  const us = fitAxis(0), vs = fitAxis(1);
  const [na, nb, , nd] = newParent;
  const nux = nb[0] - na[0], nuy = nb[1] - na[1];
  const nvx = nd[0] - na[0], nvy = nd[1] - na[1];
  return child.map((_, index) => [
    na[0] + us[index] * nux + vs[index] * nvx,
    na[1] + us[index] * nuy + vs[index] * nvy,
  ]);
}
