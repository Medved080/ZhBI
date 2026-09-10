// Ограниченный reader метаданных GlobalSettings бинарного FBX 7.4/7.5.
// НЕ полный FBX-парсер: читает только заголовок и верхнеуровневый узел
// GlobalSettings/Properties70, массивы (Vertices и т.п.) пропускает по
// длине без распаковки, глубина обхода ограничена. Единственная цель —
// независимо от FBXLoader подтвердить единицы и оси перед импортом (см.
// Docs/fbx-ground-implementation-task.md §4). Ошибка формата/версии/
// комбинации осей — явный отказ, не угадывание.
//
// Первая и пока единственная поддерживаемая комбинация осей — профиль
// файла 0507_Aviomotornaya_ZU_5_Ground.fbx: UpAxis=1 (+1), FrontAxis=2
// (+1), CoordAxis=0 (+1). Другие комбинации отклоняются.

const MAX_DEPTH = 6;
const HEADER_MAGIC = "Kaydara FBX Binary  ";

export const SUPPORTED_AXIS_PROFILE = {
  upAxis: 1, upAxisSign: 1,
  frontAxis: 2, frontAxisSign: 1,
  coordAxis: 0, coordAxisSign: 1,
};

class Cursor {
  constructor(view, limit) {
    this.view = view;
    this.offset = 0;
    this.limit = limit;
  }
  need(n) {
    if (this.offset + n > this.limit) throw new RangeError("FBX: выход за границы буфера при чтении");
  }
  u8() { this.need(1); const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  u64() { this.need(8); const v = this.view.getBigUint64(this.offset, true); this.offset += 8; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  i64() { this.need(8); const v = this.view.getBigInt64(this.offset, true); this.offset += 8; return v; }
  f32() { this.need(4); const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  f64() { this.need(8); const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }
  bytes(n) { this.need(n); const v = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, n); this.offset += n; return v; }
  skip(n) { this.need(n); this.offset += n; }
}

function readProperty(c) {
  const type = String.fromCharCode(c.u8());
  switch (type) {
    case "Y": return c.i16();
    case "C": return c.u8() !== 0;
    case "I": return c.i32();
    case "F": return c.f32();
    case "D": return c.f64();
    case "L": return Number(c.i64());
    case "f": case "d": case "l": case "i": case "b": {
      // Массив: длина/кодировка/сжатая_длина, затем сами данные — ПРОПУСКАЕМ
      // без распаковки: значения GlobalSettings/Properties70 — всегда
      // скаляры, массивы тут не нужны и не читаются намеренно (§4).
      const arrayLen = c.u32();
      const encoding = c.u32();
      const compLen = c.u32();
      if (encoding === 0) {
        const elemSize = { f: 4, d: 8, l: 8, i: 4, b: 1 }[type];
        c.skip(arrayLen * elemSize);
      } else {
        c.skip(compLen);
      }
      return null;
    }
    case "S": case "R": {
      const n = c.u32();
      const raw = c.bytes(n);
      return type === "S" ? new TextDecoder("utf-8", { fatal: false }).decode(raw) : null;
    }
    default:
      throw new Error(`FBX: неизвестный тип свойства '${type}'`);
  }
}

function readNode(c, version, depth) {
  if (depth > MAX_DEPTH) throw new Error("FBX: превышена ограниченная глубина чтения GlobalSettings");
  let endOffset, numProps, propListLen;
  if (version >= 7500) {
    endOffset = Number(c.u64()); numProps = Number(c.u64()); propListLen = Number(c.u64());
  } else {
    endOffset = c.u32(); numProps = c.u32(); propListLen = c.u32();
  }
  const nameLen = c.u8();
  const nameBytes = c.bytes(nameLen);
  const name = new TextDecoder("utf-8", { fatal: false }).decode(nameBytes);
  if (endOffset === 0) return null; // NULL-запись конца списка
  if (endOffset > c.limit) throw new RangeError("FBX: endOffset узла выходит за пределы файла");
  const propsEnd = c.offset + propListLen;
  const props = [];
  for (let i = 0; i < numProps; i++) props.push(readProperty(c));
  if (c.offset > propsEnd) throw new RangeError("FBX: список свойств узла повреждён");
  c.offset = propsEnd;
  const children = [];
  const nullRecSize = version >= 7500 ? 25 : 13;
  while (c.offset < endOffset - nullRecSize) {
    const child = readNode(c, version, depth + 1);
    if (child === null) break;
    children.push(child);
  }
  c.offset = endOffset;
  return { name, props, children };
}

function findChild(node, name) {
  return node.children.find((n) => n.name === name) || null;
}

/**
 * Читает заголовок и GlobalSettings/Properties70 бинарного FBX.
 * @param {ArrayBuffer} buffer
 * @returns {{formatVersion:number, unitScaleFactor:number,
 *   originalUnitScaleFactor:number, upAxis:number, upAxisSign:number,
 *   frontAxis:number, frontAxisSign:number, coordAxis:number,
 *   coordAxisSign:number, mmPerUnit:number}}
 * @throws {Error} явная и понятная причина отказа — не угадывает
 */
export function readFbxGlobalSettings(buffer) {
  const view = new DataView(buffer);
  const headerBytes = new Uint8Array(buffer, 0, Math.min(21, buffer.byteLength));
  const header = new TextDecoder("ascii").decode(headerBytes);
  if (buffer.byteLength < 27 || !header.startsWith("Kaydara FBX Binary")) {
    throw new Error("Файл не является бинарным FBX (нет сигнатуры 'Kaydara FBX Binary'). ASCII FBX не поддерживается.");
  }
  const c = new Cursor(view, buffer.byteLength);
  c.offset = 23;
  const formatVersion = c.u32();
  if (formatVersion < 7400 || formatVersion >= 7700) {
    throw new Error(`Версия формата FBX ${formatVersion} не входит в поддерживаемый диапазон 7400–7699.`);
  }
  c.offset = 27;
  const nullRecSize = formatVersion >= 7500 ? 25 : 13;
  let globalSettingsNode = null;
  while (c.offset < c.limit - nullRecSize) {
    const node = readNode(c, formatVersion, 0);
    if (node === null) break;
    if (node.name === "GlobalSettings") { globalSettingsNode = node; break; }
    if (node.name === "Objects" || node.name === "Connections") break; // GlobalSettings всегда раньше — дальше не ищем
  }
  if (!globalSettingsNode) {
    throw new Error("В файле не найден узел GlobalSettings.");
  }
  const p70 = findChild(globalSettingsNode, "Properties70");
  if (!p70) throw new Error("В GlobalSettings нет Properties70.");
  const settings = {};
  for (const p of p70.children) {
    if (p.name !== "P" || !p.props.length) continue;
    settings[p.props[0]] = p.props.slice(4);
  }
  const num = (key, fallback) => {
    const arr = settings[key];
    return arr && arr[0] != null ? Number(arr[0]) : fallback;
  };
  const result = {
    formatVersion,
    unitScaleFactor: num("UnitScaleFactor", null),
    originalUnitScaleFactor: num("OriginalUnitScaleFactor", null),
    upAxis: num("UpAxis", null),
    upAxisSign: num("UpAxisSign", null),
    frontAxis: num("FrontAxis", null),
    frontAxisSign: num("FrontAxisSign", null),
    coordAxis: num("CoordAxis", null),
    coordAxisSign: num("CoordAxisSign", null),
  };
  if (result.unitScaleFactor == null || !Number.isFinite(result.unitScaleFactor) || result.unitScaleFactor <= 0) {
    throw new Error("GlobalSettings.UnitScaleFactor отсутствует или некорректен.");
  }
  for (const key of ["upAxis", "upAxisSign", "frontAxis", "frontAxisSign", "coordAxis", "coordAxisSign"]) {
    if (result[key] == null) throw new Error(`GlobalSettings.${key} отсутствует.`);
  }
  result.mmPerUnit = result.unitScaleFactor * 10; // FbxSystemUnit: единица файла в см, см→мм = ×10
  return result;
}

/** Отклоняет всё, кроме единственного подтверждённого профиля осей (§2, §4). */
export function assertSupportedAxisProfile(settings) {
  const p = SUPPORTED_AXIS_PROFILE;
  if (
    settings.upAxis !== p.upAxis || settings.upAxisSign !== p.upAxisSign ||
    settings.frontAxis !== p.frontAxis || settings.frontAxisSign !== p.frontAxisSign ||
    settings.coordAxis !== p.coordAxis || settings.coordAxisSign !== p.coordAxisSign
  ) {
    throw new Error(
      "Комбинация осей FBX не поддерживается в этой версии импорта " +
      `(UpAxis=${settings.upAxis}/${settings.upAxisSign}, FrontAxis=${settings.frontAxis}/${settings.frontAxisSign}, ` +
      `CoordAxis=${settings.coordAxis}/${settings.coordAxisSign}). ` +
      "Поддержан только профиль первого приёмочного файла.",
    );
  }
}
