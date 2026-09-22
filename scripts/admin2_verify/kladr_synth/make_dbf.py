import struct

def write_dbf(path, fields, rows, encoding="cp866"):
    # fields: [(name, length)]
    n_fields = len(fields)
    header_size = 32 + 32 * n_fields + 1
    record_size = 1 + sum(l for _, l in fields)
    n_records = len(rows)
    with open(path, "wb") as f:
        f.write(struct.pack("<BBBBIHH20x", 0x03, 26, 9, 22, n_records, header_size, record_size))
        for name, length in fields:
            nm = name.encode("ascii")[:10].ljust(11, b"\x00")
            f.write(nm + b"C" + b"\x00" * 4 + bytes([length]) + b"\x00" + b"\x00" * 14)
        f.write(b"\x0d")
        for row in rows:
            f.write(b" ")  # not deleted
            for (name, length), val in zip(fields, row):
                b = str(val).encode(encoding, "replace")[:length]
                f.write(b.ljust(length, b" "))
        f.write(b"\x1a")

FIELDS = [("CODE", 13), ("NAME", 40), ("SOCR", 10), ("INDEX", 6), ("OCATD", 11)]
ROWS = [
    ("9900000000000", "Тестовая", "обл", "", ""),
    ("9900100100000", "Тестоград", "г", "199000", ""),
    ("9900100100100", "Первомайский", "п", "199001", ""),
]
write_dbf("KLADR.DBF", FIELDS, ROWS)
print("written KLADR.DBF")
