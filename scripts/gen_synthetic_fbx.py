"""Генератор МИНИМАЛЬНОГО, но НАСТОЯЩЕГО бинарного FBX (Kaydara FBX Binary,
версия 7400) с одним треугольным мешем — для проверки:
  (а) серверного ограниченного ридера app/fbx_global_settings.py
      (читает только GlobalSettings/Properties70);
  (б) реального парсера Three.js FBXLoader
      (app/static/vendor/three/examples/jsm/loaders/FBXLoader.js) —
      ему нужны Objects.Geometry / Objects.Model / Connections.

Без сторонних зависимостей — только stdlib (struct/argparse).

Формат узла (версия < 7500, все размерные поля 32-битные, little-endian):
    uint32 endOffset      — АБСОЛЮТНОЕ смещение конца узла от начала файла
    uint32 numProperties  — число свойств в списке
    uint32 propertyListLen— длина списка свойств в байтах
    uint8  nameLen
    bytes  name[nameLen]
    <properties...>
    <children...>
    [13 нулевых байт «нуль-рекорда» — ТОЛЬКО если у узла есть дети]

Запуск:
    .venv/bin/python scripts/gen_synthetic_fbx.py <выход.fbx> \
        [--variant ok|bad_axis|bad_unit|too_many_triangles]
"""
import argparse
import struct

MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"  # 21 байт подписи + 0x1A 0x00 = 23 байта
VERSION = 7400
NULL_RECORD = b"\x00" * 13  # версия < 7500 → 13-байтный нуль-рекорд закрытия узла с детьми

# Профиль осей, который сервер (assert_supported_axis_profile) считает
# поддержанным: Z-up, стандартный экспорт из 3ds Max/большинства CAD.
GOOD_AXIS = dict(up_axis=1, up_axis_sign=1, front_axis=2, front_axis_sign=1,
                  coord_axis=0, coord_axis_sign=1)


class Node:
    """Узел бинарного дерева FBX ДО сериализации.

    props — список пар (код_типа, значение); код_типа — однобуквенный код
    свойства FBX: S(строка) I(int32) D(double) L(int64) i(массив int32)
    d(массив double).
    """

    __slots__ = ("name", "props", "children")

    def __init__(self, name, props=None, children=None):
        self.name = name
        self.props = list(props or [])
        self.children = list(children or [])


def _encode_property(kind, value):
    if kind == "S":
        raw = value.encode("utf-8")
        return b"S" + struct.pack("<I", len(raw)) + raw
    if kind == "I":
        return b"I" + struct.pack("<i", value)
    if kind == "D":
        return b"D" + struct.pack("<d", value)
    if kind == "L":
        return b"L" + struct.pack("<q", value)
    if kind == "d":  # массив double, без сжатия (encoding=0)
        raw = struct.pack("<%dd" % len(value), *value)
        return b"d" + struct.pack("<III", len(value), 0, len(raw)) + raw
    if kind == "i":  # массив int32, без сжатия (encoding=0)
        raw = struct.pack("<%di" % len(value), *value)
        return b"i" + struct.pack("<III", len(value), 0, len(raw)) + raw
    raise ValueError(f"gen_synthetic_fbx: неподдерживаемый код свойства {kind!r}")


def _serialize_node(node: Node, offset: int) -> bytes:
    """Сериализует узел (с детьми), считая, что он начинается в файле по
    абсолютному смещению offset. endOffset у ОБОИХ ридеров (Python-ридера
    сервера и Three.js BinaryParser) — абсолютное смещение от начала
    файла, а не относительное внутри узла — отсюда рекурсия со счётчиком
    смещения, а не сборка узлов "снизу вверх" без привязки к позиции."""
    name_raw = node.name.encode("utf-8")
    props_bytes = b"".join(_encode_property(k, v) for k, v in node.props)
    header_len = 4 + 4 + 4 + 1 + len(name_raw)

    children_bytes = b""
    child_offset = offset + header_len + len(props_bytes)
    for child in node.children:
        child_bytes = _serialize_node(child, child_offset)
        children_bytes += child_bytes
        child_offset += len(child_bytes)
    if node.children:
        children_bytes += NULL_RECORD

    end_offset = offset + header_len + len(props_bytes) + len(children_bytes)
    header = struct.pack("<III", end_offset, len(node.props), len(props_bytes))
    header += struct.pack("<B", len(name_raw)) + name_raw
    return header + props_bytes + children_bytes


def _end_of_content(offset: int, size: int) -> bool:
    """Точная копия BinaryParser.endOfContent() из FBXLoader.js: проверяет,
    остановится ли парсер верхнего уровня НЕ читая больше узлов, при
    заданном текущем смещении offset и полном размере файла size."""
    if size % 16 == 0:
        return ((offset + 160 + 16) & ~0xF) >= size
    return (offset + 160 + 16) >= size


def _min_footer_pad(keep_reading_offsets, final_offset: int) -> int:
    """Подбирает минимальный «хвост» нулевых байт после ПОСЛЕДНЕГО узла
    верхнего уровня.

    Грабли: BinaryParser.endOfContent() в FBXLoader.js вызывается ПЕРЕД
    КАЖДОЙ попыткой прочитать очередной узел верхнего уровня — не только
    в самом конце. Если паддинг подобрать так, чтобы условие остановки
    выполнялось только после последнего узла (Connections), но не
    проверить его же на смещениях после ПРЕДЫДУЩИХ узлов (GlobalSettings,
    Objects) — при маленьком файле условие "конец контента" срабатывает
    досрочно, ещё до Objects/Connections: они молча не читаются, и Three.js
    получает пустой Connections (несмотря на то, что байты в файле
    присутствуют!). Поэтому ищем pad, при котором endOfContent() ЛОЖНО на
    всех промежуточных смещениях (keep_reading_offsets) и ИСТИННО на
    смещении сразу после последнего узла (final_offset)."""
    for pad in range(0, 4096):
        size = final_offset + pad
        if any(_end_of_content(off, size) for off in keep_reading_offsets):
            continue
        if not _end_of_content(final_offset, size):
            continue
        return pad
    raise RuntimeError("gen_synthetic_fbx: не удалось подобрать паддинг футера")


def _p_int(name: str, value: int) -> Node:
    return Node("P", props=[("S", name), ("S", "int"), ("S", "Integer"), ("S", ""), ("I", value)])


def _p_double(name: str, value: float) -> Node:
    return Node("P", props=[("S", name), ("S", "double"), ("S", "Number"), ("S", ""), ("D", value)])


def build_global_settings(unit_scale_factor=1.0, up_axis=None, up_axis_sign=None,
                            front_axis=None, front_axis_sign=None,
                            coord_axis=None, coord_axis_sign=None) -> Node:
    axis = dict(GOOD_AXIS)
    for k, v in dict(up_axis=up_axis, up_axis_sign=up_axis_sign, front_axis=front_axis,
                       front_axis_sign=front_axis_sign, coord_axis=coord_axis,
                       coord_axis_sign=coord_axis_sign).items():
        if v is not None:
            axis[k] = v
    properties70 = Node("Properties70", children=[
        _p_double("UnitScaleFactor", unit_scale_factor),
        _p_int("UpAxis", axis["up_axis"]),
        _p_int("UpAxisSign", axis["up_axis_sign"]),
        _p_int("FrontAxis", axis["front_axis"]),
        _p_int("FrontAxisSign", axis["front_axis_sign"]),
        _p_int("CoordAxis", axis["coord_axis"]),
        _p_int("CoordAxisSign", axis["coord_axis_sign"]),
    ])
    return Node("GlobalSettings", children=[properties70])


def build_geometry(geo_id: int, triangles: int) -> Node:
    """Строит узел Geometry с triangles треугольниками. Вершины треугольников
    НЕ переиспользуются между собой (каждый треугольник — свои 3 вершины) —
    так проще и надёжнее, чем правильная развёртка общей сетки, а для
    проверки ридеров это не важно."""
    vertices = []
    poly_index = []
    normals = []
    for i in range(triangles):
        base = float(i) * 1000.0  # развести треугольники в пространстве
        v0 = (base, 0.0, 0.0)
        v1 = (base + 100.0, 0.0, 0.0)
        v2 = (base, 100.0, 0.0)
        for v in (v0, v1, v2):
            vertices.extend(v)
        idx0 = i * 3
        # Последний индекс грани — побитовое НЕ (маркер конца полигона)
        poly_index.extend([idx0, idx0 + 1, (idx0 + 2) ^ -1])
        for _ in range(3):
            normals.extend((0.0, 0.0, 1.0))

    layer_normal = Node("LayerElementNormal", props=[("I", 0)], children=[
        Node("MappingInformationType", props=[("S", "ByPolygonVertex")]),
        Node("ReferenceInformationType", props=[("S", "Direct")]),
        Node("Normals", props=[("d", normals)]),
    ])

    return Node(
        "Geometry",
        props=[("L", geo_id), ("S", "Geometry::"), ("S", "Mesh")],
        children=[
            Node("Vertices", props=[("d", vertices)]),
            Node("PolygonVertexIndex", props=[("i", poly_index)]),
            layer_normal,
        ],
    )


def build_model(model_id: int) -> Node:
    return Node("Model", props=[("L", model_id), ("S", "Model::synthetic_mesh"), ("S", "Mesh")])


def build_connections(geo_id: int, model_id: int) -> Node:
    # "C" + fromID + toID = "потомок -> родитель" (стандартная семантика FBX)
    c_geo_to_model = Node("C", props=[("S", "OO"), ("L", geo_id), ("L", model_id)])
    c_model_to_root = Node("C", props=[("S", "OO"), ("L", model_id), ("L", 0)])
    return Node("Connections", children=[c_geo_to_model, c_model_to_root])


VARIANT_TRIANGLES = {
    "ok": 1,
    "bad_axis": 1,
    "bad_unit": 1,
    "too_many_triangles": 5000,
}


def generate(variant: str) -> bytes:
    if variant not in VARIANT_TRIANGLES:
        raise ValueError(f"неизвестный вариант: {variant}")

    if variant == "bad_axis":
        # Валидный UnitScaleFactor, но профиль осей не тот, что ждёт
        # assert_supported_axis_profile (там захардкожен только Z-up,
        # UpAxis=1 — тут подсовываем Y-up).
        gs = build_global_settings(unit_scale_factor=1.0, up_axis=2, up_axis_sign=1,
                                     front_axis=1, front_axis_sign=1,
                                     coord_axis=0, coord_axis_sign=1)
    elif variant == "bad_unit":
        # UnitScaleFactor <= 0 — read_fbx_global_settings должен отказать
        # ДО проверки профиля осей (оси тут — валидный профиль).
        gs = build_global_settings(unit_scale_factor=0.0)
    else:
        gs = build_global_settings(unit_scale_factor=1.0)

    geo_id = 2000000001
    model_id = 2000000002
    triangles = VARIANT_TRIANGLES[variant]

    geometry = build_geometry(geo_id, triangles)
    model = build_model(model_id)
    objects = Node("Objects", children=[geometry, model])
    connections = build_connections(geo_id, model_id)

    header = MAGIC + struct.pack("<I", VERSION)
    offset = len(header)
    body = b""
    checkpoints = []  # смещения после каждого узла, КРОМЕ последнего
    top_nodes = (gs, objects, connections)
    for i, node in enumerate(top_nodes):
        node_bytes = _serialize_node(node, offset)
        body += node_bytes
        offset += len(node_bytes)
        if i < len(top_nodes) - 1:
            checkpoints.append(offset)

    footer = b"\x00" * _min_footer_pad(checkpoints, offset)
    return header + body + footer


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("output", help="путь к выходному .fbx файлу")
    ap.add_argument("--variant", choices=sorted(VARIANT_TRIANGLES), default="ok")
    args = ap.parse_args()

    data = generate(args.variant)
    with open(args.output, "wb") as f:
        f.write(data)
    print(f"{args.output}: вариант={args.variant} размер={len(data)} байт")


if __name__ == "__main__":
    main()
