"""Серверный аналог app/static/external-models/fbx-global-settings.js —
ограниченный reader GlobalSettings бинарного FBX 7.4/7.5, БЕЗ зависимостей
(вызывается из app/external_models.py). Те же ограничения: глубина, только
верхний узел GlobalSettings/Properties70, массивы пропускаются по длине без
распаковки. Не доверяет тому, что прислал браузер, — независимая проверка
единиц/осей на сервере (см. §7 задания).
"""
import struct
from dataclasses import dataclass
from typing import Optional

MAX_DEPTH = 6

SUPPORTED_AXIS_PROFILE = {
    "up_axis": 1, "up_axis_sign": 1,
    "front_axis": 2, "front_axis_sign": 1,
    "coord_axis": 0, "coord_axis_sign": 1,
}


class FbxGlobalSettingsError(ValueError):
    pass


@dataclass
class Cursor:
    buf: bytes
    offset: int = 0

    def need(self, n):
        if self.offset + n > len(self.buf):
            raise FbxGlobalSettingsError("FBX: выход за границы буфера")

    def u8(self):
        self.need(1); v = self.buf[self.offset]; self.offset += 1; return v

    def u32(self):
        self.need(4); v = struct.unpack_from("<I", self.buf, self.offset)[0]; self.offset += 4; return v

    def u64(self):
        self.need(8); v = struct.unpack_from("<Q", self.buf, self.offset)[0]; self.offset += 8; return v

    def i16(self):
        self.need(2); v = struct.unpack_from("<h", self.buf, self.offset)[0]; self.offset += 2; return v

    def i32(self):
        self.need(4); v = struct.unpack_from("<i", self.buf, self.offset)[0]; self.offset += 4; return v

    def i64(self):
        self.need(8); v = struct.unpack_from("<q", self.buf, self.offset)[0]; self.offset += 8; return v

    def f32(self):
        self.need(4); v = struct.unpack_from("<f", self.buf, self.offset)[0]; self.offset += 4; return v

    def f64(self):
        self.need(8); v = struct.unpack_from("<d", self.buf, self.offset)[0]; self.offset += 8; return v

    def bytes(self, n):
        self.need(n); v = self.buf[self.offset:self.offset + n]; self.offset += n; return v

    def skip(self, n):
        self.need(n); self.offset += n


def _read_property(c: Cursor):
    t = chr(c.u8())
    if t == "Y": return c.i16()
    if t == "C": return c.u8() != 0
    if t == "I": return c.i32()
    if t == "F": return c.f32()
    if t == "D": return c.f64()
    if t == "L": return c.i64()
    if t in "fdlib":
        array_len = c.u32(); encoding = c.u32(); comp_len = c.u32()
        if encoding == 0:
            elem = {"f": 4, "d": 8, "l": 8, "i": 4, "b": 1}[t]
            c.skip(array_len * elem)
        else:
            c.skip(comp_len)
        return None
    if t == "S":
        n = c.u32(); raw = c.bytes(n)
        return raw.decode("utf-8", "replace")
    if t == "R":
        n = c.u32(); c.bytes(n); return None
    raise FbxGlobalSettingsError(f"FBX: неизвестный тип свойства {t!r}")


def _read_node(c: Cursor, version: int, depth: int):
    if depth > MAX_DEPTH:
        raise FbxGlobalSettingsError("FBX: превышена ограниченная глубина")
    if version >= 7500:
        end_offset, num_props, prop_list_len = c.u64(), c.u64(), c.u64()
    else:
        end_offset, num_props, prop_list_len = c.u32(), c.u32(), c.u32()
    name_len = c.u8()
    name = c.bytes(name_len).decode("utf-8", "replace")
    if end_offset == 0:
        return None
    if end_offset > len(c.buf):
        raise FbxGlobalSettingsError("FBX: endOffset вне файла")
    props_end = c.offset + prop_list_len
    props = []
    for _ in range(num_props):
        props.append(_read_property(c))
    if c.offset > props_end:
        raise FbxGlobalSettingsError("FBX: список свойств повреждён")
    c.offset = props_end
    children = []
    null_rec = 25 if version >= 7500 else 13
    while c.offset < end_offset - null_rec:
        child = _read_node(c, version, depth + 1)
        if child is None:
            break
        children.append(child)
    c.offset = end_offset
    return {"name": name, "props": props, "children": children}


def read_fbx_global_settings(buf: bytes) -> dict:
    if len(buf) < 27 or not buf.startswith(b"Kaydara FBX Binary"):
        raise FbxGlobalSettingsError(
            "Файл не является бинарным FBX (нет сигнатуры 'Kaydara FBX Binary'). ASCII FBX не поддерживается.")
    c = Cursor(buf, 23)
    format_version = c.u32()
    if not (7400 <= format_version < 7700):
        raise FbxGlobalSettingsError(f"Версия формата FBX {format_version} не входит в поддерживаемый диапазон.")
    c.offset = 27
    null_rec = 25 if format_version >= 7500 else 13
    global_settings = None
    while c.offset < len(buf) - null_rec:
        node = _read_node(c, format_version, 0)
        if node is None:
            break
        if node["name"] == "GlobalSettings":
            global_settings = node
            break
        if node["name"] in ("Objects", "Connections"):
            break
    if global_settings is None:
        raise FbxGlobalSettingsError("В файле не найден узел GlobalSettings.")
    p70 = next((n for n in global_settings["children"] if n["name"] == "Properties70"), None)
    if p70 is None:
        raise FbxGlobalSettingsError("В GlobalSettings нет Properties70.")
    settings = {}
    for p in p70["children"]:
        if p["name"] != "P" or not p["props"]:
            continue
        settings[p["props"][0]] = p["props"][4:]

    def num(key) -> Optional[float]:
        arr = settings.get(key)
        return float(arr[0]) if arr and arr[0] is not None else None

    result = {
        "format_version": format_version,
        "unit_scale_factor": num("UnitScaleFactor"),
        "up_axis": num("UpAxis"),
        "up_axis_sign": num("UpAxisSign"),
        "front_axis": num("FrontAxis"),
        "front_axis_sign": num("FrontAxisSign"),
        "coord_axis": num("CoordAxis"),
        "coord_axis_sign": num("CoordAxisSign"),
    }
    if not result["unit_scale_factor"] or result["unit_scale_factor"] <= 0:
        raise FbxGlobalSettingsError("GlobalSettings.UnitScaleFactor отсутствует или некорректен.")
    for key in ("up_axis", "up_axis_sign", "front_axis", "front_axis_sign", "coord_axis", "coord_axis_sign"):
        if result[key] is None:
            raise FbxGlobalSettingsError(f"GlobalSettings.{key} отсутствует.")
    result["mm_per_unit"] = result["unit_scale_factor"] * 10
    return result


def assert_supported_axis_profile(settings: dict) -> None:
    p = SUPPORTED_AXIS_PROFILE
    if (int(settings["up_axis"]) != p["up_axis"] or int(settings["up_axis_sign"]) != p["up_axis_sign"]
            or int(settings["front_axis"]) != p["front_axis"] or int(settings["front_axis_sign"]) != p["front_axis_sign"]
            or int(settings["coord_axis"]) != p["coord_axis"] or int(settings["coord_axis_sign"]) != p["coord_axis_sign"]):
        raise FbxGlobalSettingsError(
            "Комбинация осей FBX не поддерживается в этой версии импорта — поддержан только профиль первого приёмочного файла.")
