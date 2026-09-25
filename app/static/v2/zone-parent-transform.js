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

// Все стоянки яруса преобразуются ОДНОЙ матрицей. Независимое вписывание
// каждой стоянки сдвигает соседние границы по-разному и создаёт пересечения.
// У старых DXF встречаются стоянки за пределами крана: тогда всю группу
// сдвигаем/сжимаем вместе, сохраняя взаимное расположение.
export function fitChildrenToResizedParent(oldParent, newParent, outlines) {
  if (oldParent?.length !== 4 || newParent?.length !== 4 || !Array.isArray(outlines)) return null;
  const [a, b, , d] = oldParent;
  const ux = b[0] - a[0], uy = b[1] - a[1];
  const vx = d[0] - a[0], vy = d[1] - a[1];
  const det = ux * vy - uy * vx;
  if (Math.abs(det) < 1e-8) return null;
  const local = outlines.map((outline) => outline.map(([x, y]) => {
    const px = x - a[0], py = y - a[1];
    return [(px * vy - py * vx) / det, (ux * py - uy * px) / det];
  }));
  const all = local.flat();
  if (!all.length) return outlines.map(() => []);
  const axis = (index) => {
    const min = Math.min(...all.map((point) => point[index]));
    const max = Math.max(...all.map((point) => point[index]));
    const span = max - min;
    if (span > 1) return { scale: 1 / span, shift: -min / span };
    const shift = min < 0 ? -min : max > 1 ? 1 - max : 0;
    return { scale: 1, shift };
  };
  const u = axis(0), v = axis(1);
  const [na, nb, , nd] = newParent;
  const nux = nb[0] - na[0], nuy = nb[1] - na[1];
  const nvx = nd[0] - na[0], nvy = nd[1] - na[1];
  return local.map((outline) => outline.map(([x, y]) => {
    const px = x * u.scale + u.shift, py = y * v.scale + v.shift;
    return [na[0] + px * nux + py * nvx, na[1] + px * nuy + py * nvy];
  }));
}
