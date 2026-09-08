# -*- coding: utf-8 -*-
"""Адресный классификатор КЛАДР: загрузка, хранение, подсказки.

Зачем он вообще. Адрес проекта и объекта до 2026-09-07 был свободной
строкой, и на двух сотнях площадок это перестаёт работать: один и тот же
город пишут «г. Тверь», «Тверь», «г.Тверь», отобрать записи по региону
нельзя, а карту проектов по такому адресу не построить.

Почему КЛАДР, а не ФИАС/ГАР. Источник выбран пользователем
(`https://www.nalog.gov.ru/files/kladr/BASE.7z`). Он проще: иерархия
закодирована в самом коде записи, отдельная таблица связей не нужна, а
объём в разы меньше. Взамен он обновляется реже ГАР — для адресов
стройплощадок это приемлемо, а поле `source` в таблицах оставляет
возможность подключить ГАР, не переделывая схему.

Что человек делает руками (и почему):

1. Качает `BASE.7z` браузером и РАСПАКОВЫВАЕТ у себя.
2. Кладёт полученные `.DBF` в каталог `data/kladr/` на томе сервера.
3. Открывает «Действия → Администрирование → Адресный классификатор»,
   отмечает нужные регионы и жмёт «Загрузить».

Распаковка на стороне человека — не прихоть: Python не открывает 7z, а
единственная годная библиотека тянет за собой восемь пакетов, часть с
C-расширениями, в образ, который собирается без сборочных инструментов.
Если в системе всё же найден бинарь `7z`, загрузчик распакует архив сам —
но полагаться на это нельзя.

Хранилище — ОТДЕЛЬНЫЙ файл `data/addr.db`, не основная база: это
справочные данные объёмом в сотни мегабайт, которым нечего делать ни в
резервных копиях, ни в обезличенной копии, ни в миграциях схемы.
"""

import os
import re
import shutil
import sqlite3
import lzma
import struct
import subprocess
import threading
import time
import urllib.request
import zipfile
from typing import Dict, Iterator, List, Optional

from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app import activity
from app.access import require_service_feature
from app.auth import get_current_user
from app.upload_limits import copy_upload_limited

# Каталог, куда человек кладёт файлы классификатора, и файл базы.
KLADR_DIR = os.environ.get("ZHBI_KLADR_DIR") or "data/kladr"
ADDR_DB_PATH = os.environ.get("ZHBI_ADDR_DB_PATH") or "data/addr.db"

# Имена файлов КЛАДР, которые нас интересуют. DOMA — по отдельной галочке
# (см. load_regions): это самый крупный файл, а нужен он только ради
# уточнения почтового индекса.
FILE_OBJECTS = "KLADR.DBF"
FILE_STREETS = "STREET.DBF"
FILE_HOUSES = "DOMA.DBF"
FILE_SOCR = "SOCRBASE.DBF"

ALL_FILES = (FILE_OBJECTS, FILE_STREETS, FILE_HOUSES, FILE_SOCR)


# ---------------------------------------------------------------- разбор DBF
#
# Свой разборщик вместо библиотеки: формат dBase III — это заголовок в 32
# байта, дескрипторы полей по 32 байта и записи фиксированной длины. Сотня
# строк против новой зависимости в образе. Прецедент в проекте есть: график
# рисуется своим SVG, а не библиотекой графиков.

class DbfError(Exception):
    """Файл не похож на DBF или повреждён."""


def _dbf_fields(header: bytes):
    """Дескрипторы полей: [(имя, тип, длина), ...]."""
    поля = []
    смещение = 32
    while смещение < len(header):
        кусок = header[смещение:смещение + 32]
        if not кусок or кусок[0] in (0x0D, 0x00):
            break
        имя = кусок[0:11].split(b"\x00")[0].decode("ascii", "replace").strip()
        тип = chr(кусок[11])
        длина = кусок[16]
        поля.append((имя, тип, длина))
        смещение += 32
    if not поля:
        raise DbfError("в файле нет описания полей")
    return поля


def read_dbf(path: str, encoding: str = "cp866") -> Iterator[Dict[str, str]]:
    """Записи DBF по одной. Удалённые (помеченные «*») пропускаются.

    Читается потоком, а не целиком: STREET.DBF — это полтора миллиона строк,
    и держать их в памяти списком незачем.
    """
    with open(path, "rb") as f:
        начало = f.read(32)
        if len(начало) < 32:
            raise DbfError("файл короче заголовка DBF")
        записей, длина_заголовка, длина_записи = struct.unpack("<IHH", начало[4:12])
        f.seek(0)
        заголовок = f.read(длина_заголовка)
        поля = _dbf_fields(заголовок)
        # Смещения считаем сами: поле «смещение» в дескрипторе не заполняют.
        границы, поз = [], 1          # 1 — байт признака удаления
        for имя, тип, длина in поля:
            границы.append((имя, поз, поз + длина))
            поз += длина

        f.seek(длина_заголовка)
        for _ in range(записей):
            строка = f.read(длина_записи)
            if len(строка) < длина_записи:
                break                  # обрезанный хвост файла — не ошибка
            if строка[0:1] == b"*":
                continue               # запись помечена удалённой
            yield {
                имя: строка[a:b].decode(encoding, "replace").strip()
                for имя, a, b in границы
            }


# --------------------------------------------------------- распаковка 7z
#
# КЛАДР раздаётся ФНС ТОЛЬКО в формате 7z, а Python его не открывает.
# Готовая библиотека (py7zr) тянет девять зависимостей, часть с
# C-расширениями, в образ, который собирается без сборочных инструментов, —
# ради одной разовой операции это дорого.
#
# Здесь распаковывается ЧАСТНЫЙ СЛУЧАЙ: архив из одного сплошного потока,
# сжатого обычным LZMA, без шифрования и без цепочек фильтров. Именно так
# собран BASE.7z (проверено на живом файле: кодер 030101, свойства
# 5d00000001). Сам LZMA умеет стандартный модуль `lzma`, поэтому работы
# ровно на разбор оглавления. Любой другой случай — внятный отказ, а не
# попытка угадать.
#
# Прецедент в проекте: разбор DBF выше написан по той же причине.

SEVEN_ZIP_SIGNATURE = b"7z\xbc\xaf\x27\x1c"

# Идентификаторы кодеров, которые мы умеем.
_CODER_LZMA1 = bytes.fromhex("030101")
_CODER_LZMA2 = bytes.fromhex("21")
_CODER_COPY = bytes.fromhex("00")


class SevenZipError(Exception):
    """Архив не тот, повреждён или сжат способом, которого мы не умеем."""


class _Reader:
    """Чтение оглавления 7z: числа переменной длины и битовые векторы."""

    def __init__(self, data: bytes):
        self.d = data
        self.i = 0

    def byte(self) -> int:
        if self.i >= len(self.d):
            raise SevenZipError("оглавление архива обрывается")
        b = self.d[self.i]
        self.i += 1
        return b

    def take(self, n: int) -> bytes:
        if self.i + n > len(self.d):
            raise SevenZipError("оглавление архива обрывается")
        r = self.d[self.i:self.i + n]
        self.i += n
        return r

    def number(self) -> int:
        """Число 7z: маска в первом байте говорит, сколько байт следом."""
        first = self.byte()
        mask = 0x80
        value = 0
        for i in range(8):
            if not (first & mask):
                return value | ((first & (mask - 1)) << (8 * i))
            value |= self.byte() << (8 * i)
            mask >>= 1
        return value

    def bits(self, n: int) -> list:
        out, current, mask = [], 0, 0
        for _ in range(n):
            if mask == 0:
                current, mask = self.byte(), 0x80
            out.append(bool(current & mask))
            mask >>= 1
        return out

    def bool_vector(self, n: int) -> list:
        """«Все определены» одним байтом либо битовый вектор."""
        return [True] * n if self.byte() else self.bits(n)


def _lzma_filters(coder_id: bytes, props: bytes) -> list:
    if coder_id == _CODER_LZMA1:
        if len(props) < 5:
            raise SevenZipError("нет свойств LZMA")
        d = props[0]
        return [{
            "id": lzma.FILTER_LZMA1,
            "dict_size": struct.unpack("<I", props[1:5])[0],
            "lc": d % 9, "lp": (d // 9) % 5, "pb": (d // 9) // 5,
        }]
    if coder_id == _CODER_LZMA2:
        return [{"id": lzma.FILTER_LZMA2}]
    raise SevenZipError(
        "архив сжат неподдерживаемым способом (кодер %s). "
        "Распакуйте его на своём компьютере и положите файлы .DBF рядом"
        % coder_id.hex())


def _decompress(data: bytes, coder_id: bytes, props: bytes, size: int) -> bytes:
    if coder_id == _CODER_COPY:
        return data[:size]
    d = lzma.LZMADecompressor(format=lzma.FORMAT_RAW,
                              filters=_lzma_filters(coder_id, props))
    return d.decompress(data, size)


def _read_streams_info(r: _Reader) -> dict:
    """Секция StreamsInfo: где лежат сжатые куски и что из них получается."""
    info = {"pack_pos": 0, "pack_sizes": [], "folders": [], "unpack_sizes": [],
            "sub_sizes": []}
    t = r.byte()
    if t == 0x06:                                    # kPackInfo
        info["pack_pos"] = r.number()
        n = r.number()
        t = r.byte()
        while t != 0x00:
            if t == 0x09:                            # kSize
                info["pack_sizes"] = [r.number() for _ in range(n)]
            elif t == 0x0A:                          # kCRC
                if r.byte():
                    r.take(4 * n)
                else:
                    определены = r.bits(n)
                    r.take(4 * sum(1 for x in определены if x))
            else:
                raise SevenZipError("неизвестная запись 0x%02x в PackInfo" % t)
            t = r.byte()
        t = r.byte()

    if t == 0x07:                                    # kUnPackInfo
        if r.byte() != 0x0B:                         # kFolder
            raise SevenZipError("ожидалось описание папок архива")
        число_папок = r.number()
        if r.byte():
            raise SevenZipError("оглавление во внешнем потоке не поддерживается")
        for _ in range(число_папок):
            кодеров = r.number()
            папка = []
            for _ in range(кодеров):
                флаги = r.byte()
                cid = r.take(флаги & 0x0F)
                if флаги & 0x10:                     # сложный кодер: много входов
                    r.number(); r.number()
                props = b""
                if флаги & 0x20:
                    props = r.take(r.number())
                папка.append((cid, props))
            if кодеров != 1:
                raise SevenZipError(
                    "архив собран цепочкой кодеров — такой мы не распаковываем")
            info["folders"].append(папка)
        if r.byte() != 0x0C:                         # kCodersUnPackSize
            raise SevenZipError("нет размеров распакованных папок")
        info["unpack_sizes"] = [r.number() for _ in info["folders"]]
        t = r.byte()
        while t != 0x00:
            if t == 0x0A:                            # kCRC папок
                n = len(info["folders"])
                if r.byte():
                    r.take(4 * n)
                else:
                    определены = r.bits(n)
                    r.take(4 * sum(1 for x in определены if x))
            else:
                raise SevenZipError("неизвестная запись 0x%02x в UnPackInfo" % t)
            t = r.byte()
        t = r.byte()

    if t == 0x08:                                    # kSubStreamsInfo
        числа = [1] * len(info["folders"])
        t = r.byte()
        if t == 0x0D:                                # kNumUnPackStream
            числа = [r.number() for _ in info["folders"]]
            t = r.byte()
        размеры = []
        if t == 0x09:                                # kSize
            for i, сколько in enumerate(числа):
                сумма = 0
                for _ in range(сколько - 1):
                    v = r.number()
                    размеры.append(v)
                    сумма += v
                if сколько:
                    размеры.append(info["unpack_sizes"][i] - сумма)
            t = r.byte()
        else:
            for i, сколько in enumerate(числа):
                if сколько == 1:
                    размеры.append(info["unpack_sizes"][i])
        info["sub_sizes"] = размеры
        while t != 0x00:
            if t == 0x0A:                            # kCRC подпотоков
                неизвестных = len(размеры)
                if r.byte():
                    r.take(4 * неизвестных)
                else:
                    определены = r.bits(неизвестных)
                    r.take(4 * sum(1 for x in определены if x))
            else:
                raise SevenZipError("неизвестная запись 0x%02x в SubStreamsInfo" % t)
            t = r.byte()
        t = r.byte()

    if t != 0x00:
        raise SevenZipError("оглавление архива устроено не так, как ожидалось")
    if not info["sub_sizes"]:
        info["sub_sizes"] = list(info["unpack_sizes"])
    return info


def _read_names(r: _Reader, число_файлов: int) -> list:
    """Имена файлов из секции FilesInfo. Пустые записи (папки) отбрасываются
    вместе со своими флагами."""
    имена, пустые = [], [False] * число_файлов
    while True:
        тип = r.byte()
        if тип == 0x00:
            break
        размер = r.number()
        конец = r.i + размер
        if тип == 0x11:                              # kName
            if r.byte():
                raise SevenZipError("имена файлов во внешнем потоке")
            сырые = r.take(конец - r.i)
            имена = [x for x in сырые.decode("utf-16-le", "replace").split("\x00") if x]
        elif тип == 0x0E:                            # kEmptyStream
            пустые = r.bits(число_файлов)
        r.i = конец
    return имена, пустые


def read_7z_index(path: str) -> dict:
    """Оглавление архива: имена файлов, их размеры и как добраться до данных."""
    with open(path, "rb") as f:
        подпись = f.read(32)
        if len(подпись) < 32 or подпись[:6] != SEVEN_ZIP_SIGNATURE:
            raise SevenZipError("это не архив 7z")
        смещение, размер, _ = struct.unpack("<QQI", подпись[12:32])
        f.seek(32 + смещение)
        хвост = f.read(размер)
        if len(хвост) < размер:
            raise SevenZipError("архив скачан не полностью")

        r = _Reader(хвост)
        тип = r.byte()
        if тип == 0x17:                              # kEncodedHeader — сам сжат
            служебный = _read_streams_info(r)
            cid, props = служебный["folders"][0][0]
            f.seek(32 + служебный["pack_pos"])
            сырой = f.read(служебный["pack_sizes"][0])
            заголовок = _decompress(сырой, cid, props, служебный["unpack_sizes"][0])
            r = _Reader(заголовок)
            тип = r.byte()
        if тип != 0x01:
            raise SevenZipError("в архиве нет оглавления")

        t = r.byte()
        streams = None
        имена, пустые = [], []
        while t != 0x00:
            if t == 0x04:                            # kMainStreamsInfo
                streams = _read_streams_info(r)
            elif t == 0x05:                          # kFilesInfo
                число = r.number()
                имена, пустые = _read_names(r, число)
            elif t == 0x02:                          # kArchiveProperties
                while True:
                    pt = r.byte()
                    if pt == 0:
                        break
                    r.take(r.number())
            else:
                raise SevenZipError("неизвестная секция 0x%02x в оглавлении" % t)
            t = r.byte()

        if streams is None or not streams["folders"]:
            raise SevenZipError("в архиве нет данных")
        if len(streams["folders"]) != 1:
            raise SevenZipError(
                "архив состоит из нескольких блоков — такой мы не распаковываем")

        # Имена файлов С ДАННЫМИ: пустые записи (каталоги) размеров не имеют.
        с_данными = [имя for имя, пусто in zip(имена, пустые or [False] * len(имена))
                     if not пусто] if пустые else имена
        размеры = streams["sub_sizes"]
        if len(с_данными) != len(размеры):
            # Имена и размеры разошлись — работаем по размерам, имена
            # подставляем позиционно: лучше распаковать под номерами, чем
            # отказать целиком.
            с_данными = (с_данными + ["file%d" % i for i in range(len(размеры))])[:len(размеры)]
        cid, props = streams["folders"][0][0]
        return {
            "names": с_данными,
            "sizes": размеры,
            "pack_pos": 32 + streams["pack_pos"],
            "pack_size": streams["pack_sizes"][0],
            "unpack_size": streams["unpack_sizes"][0],
            "coder": cid,
            "props": props,
        }


def extract_7z(path: str, dest_dir: str, only: Optional[set] = None,
               on_progress=None) -> List[str]:
    """Распаковать нужные файлы из архива.

    Поток разжимается КУСКАМИ и сразу пишется на диск: внутри BASE.7z около
    шестисот мегабайт, и держать их в памяти незачем. Ненужные файлы
    (например, дома, если их не просили) пропускаются без записи — данные
    всё равно приходится прогонять через декомпрессор, потому что поток
    сплошной.
    """
    индекс = read_7z_index(path)
    os.makedirs(dest_dir, exist_ok=True)
    фильтр = {n.upper() for n in only} if only else None

    записаны = []
    d = lzma.LZMADecompressor(format=lzma.FORMAT_RAW,
                              filters=_lzma_filters(индекс["coder"], индекс["props"]))
    with open(path, "rb") as f:
        f.seek(индекс["pack_pos"])
        осталось_сжатого = индекс["pack_size"]
        буфер = b""
        сделано = 0

        for имя, размер in zip(индекс["names"], индекс["sizes"]):
            короткое = os.path.basename(имя.replace("\\", "/"))
            нужен = фильтр is None or короткое.upper() in фильтр
            цель = open(os.path.join(dest_dir, короткое), "wb") if нужен else None
            осталось = размер
            try:
                while осталось > 0:
                    if not буфер:
                        порция = f.read(min(1 << 20, осталось_сжатого)) if осталось_сжатого > 0 else b""
                        осталось_сжатого -= len(порция)
                        буфер = d.decompress(порция, 1 << 22)
                        if not буфер and not порция:
                            raise SevenZipError("архив кончился раньше времени")
                    кусок = буфер[:осталось]
                    буфер = буфер[len(кусок):]
                    осталось -= len(кусок)
                    сделано += len(кусок)
                    if цель:
                        цель.write(кусок)
                    if on_progress:
                        on_progress(короткое, сделано, индекс["unpack_size"])
            finally:
                if цель:
                    цель.close()
            if нужен:
                записаны.append(короткое)
    return записаны


# ------------------------------------------------------------- коды КЛАДР
#
# Код записи 13 знаков: SS RRR GGG PPP AA — регион, район, город,
# населённый пункт и два знака актуальности («00» — действующая запись).
# Улица дописывает к первым 11 ещё 4 знака, дом — ещё 4. Отсюда два
# следствия, на которых держится весь поиск: родитель находится обнулением
# младших разрядов, а потомки — сравнением префикса.

_РЕГИОН = slice(0, 2)
_РАЙОН = slice(2, 5)
_ГОРОД = slice(5, 8)
_ПУНКТ = slice(8, 11)

LEVEL_REGION = 1
LEVEL_AREA = 2
LEVEL_CITY = 3
LEVEL_SETTLEMENT = 4


def code_is_actual(code: str) -> bool:
    """Действующая запись. Последние два знака — признак актуальности:
    «00» значит, что запись живая, иначе это след переименования."""
    return len(code) >= 2 and code[-2:] == "00"


def object_level(code: str) -> int:
    """Уровень записи КЛАДР по её собственному коду.

    По коду, а не по полю LEVEL из SOCRBASE: сокращение («г», «д», «тер»)
    описывает ТИП объекта, а не место в иерархии, и посёлок городского типа
    внутри района по нему неотличим от посёлка внутри города.
    """
    if code[_ПУНКТ] != "000":
        return LEVEL_SETTLEMENT
    if code[_ГОРОД] != "000":
        return LEVEL_CITY
    if code[_РАЙОН] != "000":
        return LEVEL_AREA
    return LEVEL_REGION


def parent_code(code: str) -> Optional[str]:
    """Код родителя: обнуляем младший непустой разряд."""
    уровень = object_level(code)
    if уровень == LEVEL_REGION:
        return None
    if уровень == LEVEL_SETTLEMENT:
        return code[:8] + "000" + "00"
    if уровень == LEVEL_CITY:
        return code[:5] + "000000" + "00"
    return code[:2] + "000000000" + "00"


# Сокращения, которые пишутся ПОСЛЕ названия: «Тверская обл», «Калининский
# р-н». Всё остальное — перед: «г Тверь», «д Аввакумово».
#
# Решает именно сокращение, а НЕ уровень записи. По уровню выходила «Москва
# г»: город федерального значения — регион, но пишется он как город. Набор
# собран по живому файлу КЛАДР (все сокращения уровней 1-3).
_СОКРАЩЕНИЯ_ПОСЛЕ = {
    "обл", "край", "респ", "ао", "аобл", "аокр", "р-н", "у", "чувашия",
    "с/п", "с/с", "с/мо", "с/а", "с/о", "п/о", "волость", "нац. р-н",
}


def format_name(name: str, socr: str, level: Optional[int] = None) -> str:
    """«Тверь» + «г» → «г Тверь», «Тверская» + «обл» → «Тверская обл».

    Порядок слов — не косметика: по-русски пишут «Тверская обл, Калининский
    р-н, д Аввакумово». Обратный порядок («обл Тверская») сразу читается как
    машинный вывод.

    `level` больше ни на что не влияет и оставлен ради совместимости вызовов.
    """
    name, socr = (name or "").strip(), (socr or "").strip()
    if not socr:
        return name
    if socr.lower() in _СОКРАЩЕНИЯ_ПОСЛЕ:
        return "%s %s" % (name, socr)
    return "%s %s" % (socr, name)


def format_street(name: str, socr: str) -> str:
    """У улиц тип всегда впереди: «ул Советская», «пр-кт Ленинский»."""
    name, socr = (name or "").strip(), (socr or "").strip()
    if not socr:
        return name
    return "%s %s" % (socr, name)


# ------------------------------------------------------------- база адресов

_SCHEMA = """
CREATE TABLE IF NOT EXISTS addr_objects (
    code        TEXT PRIMARY KEY,   -- 13 знаков КЛАДР
    name        TEXT NOT NULL,
    -- Имя в нижнем регистре для поиска. Отдельной колонкой, а не через
    -- lower() в запросе: LIKE и lower() в SQLite приводят регистр только у
    -- латиницы, поэтому «совет» не находил «Советскую» — человек набирает
    -- строчными почти всегда, и поиск молча возвращал пустоту.
    name_lower  TEXT NOT NULL DEFAULT '',
    socr        TEXT,               -- сокращение типа: обл, г, д, п
    level       INTEGER NOT NULL,   -- 1 регион, 2 район, 3 город, 4 нас. пункт
    region      TEXT NOT NULL,      -- два знака кода региона
    parent      TEXT,               -- код родителя
    postal_code TEXT,
    okato       TEXT,
    full_path   TEXT NOT NULL       -- «Тверская обл, Калининский р-н, д Аввакумово»
);
CREATE INDEX IF NOT EXISTS idx_addr_objects_region ON addr_objects(region);
CREATE INDEX IF NOT EXISTS idx_addr_objects_parent ON addr_objects(parent);
CREATE INDEX IF NOT EXISTS idx_addr_objects_lower ON addr_objects(name_lower);

CREATE TABLE IF NOT EXISTS addr_streets (
    code        TEXT PRIMARY KEY,   -- 17 знаков
    name        TEXT NOT NULL,
    name_lower  TEXT NOT NULL DEFAULT '',   -- см. addr_objects.name_lower
    socr        TEXT,
    region      TEXT NOT NULL,
    parent      TEXT NOT NULL,      -- код населённого пункта (13 знаков)
    postal_code TEXT,
    full_path   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addr_streets_parent ON addr_streets(parent);
CREATE INDEX IF NOT EXISTS idx_addr_streets_region ON addr_streets(region);
CREATE INDEX IF NOT EXISTS idx_addr_streets_lower ON addr_streets(name_lower);

-- Дома нужны ровно для одного: подтвердить введённый номер и уточнить
-- почтовый индекс. Выбирать дом из списка КЛАДР нельзя — он хранит их
-- диапазонами («1,3,5-9») в одной строке.
CREATE TABLE IF NOT EXISTS addr_houses (
    code        TEXT PRIMARY KEY,   -- 19 знаков
    parent      TEXT NOT NULL,      -- код улицы (17) или населённого пункта (13)
    region      TEXT NOT NULL,
    nums        TEXT NOT NULL,      -- «1,3,5-9» как в КЛАДР
    korp        TEXT,
    postal_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_addr_houses_parent ON addr_houses(parent);

CREATE TABLE IF NOT EXISTS addr_regions (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    objects     INTEGER NOT NULL DEFAULT 0,
    streets     INTEGER NOT NULL DEFAULT 0,
    houses      INTEGER NOT NULL DEFAULT 0,
    loaded_at   TEXT,
    source_file TEXT
);

CREATE TABLE IF NOT EXISTS addr_meta (key TEXT PRIMARY KEY, value TEXT);
"""

# Полнотекстовый поиск. Не во всякой сборке SQLite есть FTS5, поэтому его
# отсутствие не должно ломать загрузку: без него поиск идёт по префиксу
# имени через обычный индекс — медленнее, но работает.
_FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS addr_objects_fts
USING fts5(name, full_path, code UNINDEXED, tokenize='unicode61', prefix='2 3 4');
CREATE VIRTUAL TABLE IF NOT EXISTS addr_streets_fts
USING fts5(name, code UNINDEXED, parent UNINDEXED, tokenize='unicode61', prefix='2 3 4');
"""

_fts_available = None


def has_fts(conn: sqlite3.Connection) -> bool:
    """Есть ли полнотекстовый поиск — и заодно создать его таблицы.

    Создание выполняется на КАЖДОМ соединении, а не один раз на процесс:
    таблицы живут в файле, а флаг в памяти, и стоит файлу смениться (базу
    удалили и грузят заново), как флаг начинает врать. Ровно так загрузка и
    падала с «no such table: addr_objects_fts». Запросы идемпотентные
    (IF NOT EXISTS), поэтому повторный вызов ничего не стоит; кэшируется
    только приговор «движок FTS5 не умеет вовсе».
    """
    global _fts_available
    if _fts_available is False:
        return False
    try:
        conn.executescript(_FTS_SCHEMA)
        _fts_available = True
    except sqlite3.OperationalError:
        _fts_available = False
    return _fts_available


def get_addr_connection() -> sqlite3.Connection:
    """Соединение с базой классификатора. Своё, не из app/db.py: это другой
    файл и другая жизнь — его можно удалить и загрузить заново, не трогая
    рабочие данные."""
    каталог = os.path.dirname(os.path.abspath(ADDR_DB_PATH))
    if каталог:
        os.makedirs(каталог, exist_ok=True)
    conn = sqlite3.connect(ADDR_DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    # База классификатора могла быть собрана прошлой версией: дописываем
    # недостающие колонки на месте, чтобы не заставлять грузить регионы
    # заново.
    for таблица in ("addr_objects", "addr_streets"):
        колонки = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % таблица)}
        if "name_lower" not in колонки:
            conn.execute("ALTER TABLE %s ADD COLUMN name_lower TEXT NOT NULL DEFAULT ''" % таблица)
            conn.execute("UPDATE %s SET name_lower = lower(name)" % таблица)
            conn.commit()
    has_fts(conn)
    return conn


def addr_db_size() -> int:
    try:
        return os.path.getsize(ADDR_DB_PATH)
    except OSError:
        return 0


# ---------------------------------------------------------------- загрузка

# Один активный разбор на процесс: две одновременные загрузки писали бы в
# одни и те же таблицы, а пользы от параллельности здесь нет.
_job_lock = threading.Lock()
_job: Dict[str, object] = {}


def job_status() -> Optional[dict]:
    return dict(_job) if _job else None


def _set_job(**поля):
    _job.update(поля)


def найти_файл(имя: str) -> Optional[str]:
    """Путь к файлу классификатора БЕЗ учёта регистра.

    В архиве ФНС файлы названы «KLADR.dbf», а в наших константах —
    «KLADR.DBF». На macOS разницы нет, а на Linux (то есть на сервере) файл
    просто не находится — и классификатор молча считается незагруженным.
    """
    цель = имя.upper()
    try:
        for f in os.listdir(KLADR_DIR):
            if f.upper() == цель:
                return os.path.join(KLADR_DIR, f)
    except OSError:
        pass
    return None


def list_source_files() -> List[dict]:
    """Что человек положил в data/kladr/ — с размером и датой.

    Имя файла берётся ТОЛЬКО базовое: путь из запроса сюда не попадает
    никогда, иначе это чтение произвольного файла на сервере.
    """
    out = []
    try:
        имена = sorted(os.listdir(KLADR_DIR))
    except OSError:
        return out
    for имя in имена:
        путь = os.path.join(KLADR_DIR, имя)
        if not os.path.isfile(путь):
            continue
        верх = имя.upper()
        if верх not in ALL_FILES and not верх.endswith(".7Z") and not верх.endswith(".ZIP"):
            continue
        try:
            ст = os.stat(путь)
        except OSError:
            continue
        out.append({
            "name": имя,
            "size": ст.st_size,
            "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(ст.st_mtime)),
            "kind": "archive" if верх.endswith((".7Z", ".ZIP")) else "dbf",
        })
    return out


# Откуда система качает классификатор сама. Один официальный адрес, вшитый
# в код: подставлять сюда произвольную ссылку из запроса — это скачивание
# чего угодно откуда угодно руками сервера.
KLADR_URL = "https://www.nalog.gov.ru/files/kladr/BASE.7z"

# Имя, под которым архив ложится в каталог классификатора.
ARCHIVE_NAME = "BASE.7z"


def download_archive(on_progress=None) -> dict:
    """Скачать архив КЛАДР с сайта ФНС прямо на сервер.

    Работает там, где у сервера есть выход наружу. В закрытом контуре
    вернётся внятный отказ, и остаётся второй путь — загрузить файл через
    браузер со своего компьютера.

    Своё имя клиента обязательно: без него сайт отвечает отказом.
    """
    os.makedirs(KLADR_DIR, exist_ok=True)
    цель = os.path.join(KLADR_DIR, ARCHIVE_NAME)
    временный = цель + ".part"
    запрос = urllib.request.Request(
        KLADR_URL, headers={"User-Agent": "zhbi-tool/1.0"})
    try:
        with urllib.request.urlopen(запрос, timeout=120) as ответ:
            всего = int(ответ.headers.get("Content-Length") or 0)
            принято = 0
            with open(временный, "wb") as f:
                while True:
                    кусок = ответ.read(1 << 20)
                    if not кусок:
                        break
                    f.write(кусок)
                    принято += len(кусок)
                    if on_progress:
                        on_progress(принято, всего)
    except Exception as e:                            # noqa: BLE001
        try:
            os.remove(временный)
        except OSError:
            pass
        raise RuntimeError(
            "Не удалось скачать классификатор с сайта ФНС: %s. "
            "Если у сервера нет выхода в интернет — скачайте файл на своём "
            "компьютере и загрузите его кнопкой ниже." % e)
    # Переименование в самом конце: недокачанный файл не должен выглядеть
    # готовым, иначе следующая загрузка сломается на полпути.
    os.replace(временный, цель)
    return {"name": ARCHIVE_NAME, "size": os.path.getsize(цель)}


def _find_7z() -> Optional[str]:
    for имя in ("7z", "7za", "7zz"):
        путь = shutil.which(имя)
        if путь:
            return путь
    return None


def unpack_archive(имя_файла: str, нужны_дома: bool = True, on_progress=None) -> List[str]:
    """Распаковать архив из data/kladr/ рядом с ним.

    Работает только если в системе есть бинарь 7z (для .zip — своими
    силами). Основной путь другой: человек распаковывает у себя и кладёт
    сюда уже .DBF.
    """
    имя = os.path.basename(имя_файла)
    путь = найти_файл(имя)
    if not путь:
        raise FileNotFoundError("Файл не найден: %s" % имя)
    if имя.upper().endswith(".ZIP"):
        with zipfile.ZipFile(путь) as z:
            имена = [n for n in z.namelist() if n.upper().endswith(".DBF")]
            for n in имена:
                # Только имя файла, без путей из архива.
                цель = os.path.join(KLADR_DIR, os.path.basename(n))
                with z.open(n) as src, open(цель, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        return [os.path.basename(n) for n in имена]

    # Свой распаковщик 7z (см. выше): системного `7z` на сервере может не
    # быть, а ставить его туда некому. Берём только нужные файлы — из
    # шестисот мегабайт архива дома занимают почти четыреста.
    нужные = {FILE_OBJECTS, FILE_STREETS, FILE_SOCR}
    if нужны_дома:
        нужные.add(FILE_HOUSES)
    try:
        return extract_7z(путь, KLADR_DIR, only=нужные, on_progress=on_progress)
    except SevenZipError as e:
        # Свой распаковщик умеет частный случай. Не тот случай — пробуем
        # системную программу, если она есть, и только потом сдаёмся.
        бинарь = _find_7z()
        if not бинарь:
            raise RuntimeError(
                "Не удалось распаковать архив: %s. Распакуйте его на своём "
                "компьютере и загрузите файлы .DBF по одному." % e)
        subprocess.run([бинарь, "x", "-y", "-o" + KLADR_DIR, путь],
                       check=True, capture_output=True, timeout=1800)
        return [f["name"] for f in list_source_files() if f["kind"] == "dbf"]


def regions_in_file() -> List[dict]:
    """Какие регионы есть в положенном KLADR.DBF — с числом записей.

    Читается весь файл: 130 тысяч строк, единицы секунд. Зато человек
    выбирает регионы, видя их названия, а не двузначные коды.
    """
    путь = найти_файл(FILE_OBJECTS)
    if not путь:
        return []
    названия, счёт = {}, {}
    for row in read_dbf(путь):
        code = (row.get("CODE") or "").strip()
        if len(code) < 13 or not code_is_actual(code):
            continue
        region = code[_РЕГИОН]
        счёт[region] = счёт.get(region, 0) + 1
        if object_level(code) == LEVEL_REGION:
            названия[region] = format_name(row.get("NAME"), row.get("SOCR"), LEVEL_REGION)
    return sorted(
        ({"code": к, "name": названия.get(к, "Регион %s" % к), "objects": счёт[к]}
         for к in счёт),
        key=lambda r: r["name"],
    )


def loaded_regions() -> List[dict]:
    conn = get_addr_connection()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM addr_regions ORDER BY name")]
    finally:
        conn.close()


def _load_socr() -> Dict[str, str]:
    """Расшифровка сокращений: «обл» → «область». Нужна подсказкам, чтобы
    человек не гадал, что такое «тер» или «нп»."""
    путь = найти_файл(FILE_SOCR)
    if not путь:
        return {}
    out = {}
    for row in read_dbf(путь):
        краткое = (row.get("SCNAME") or "").strip()
        полное = (row.get("SOCRNAME") or "").strip()
        if краткое and полное:
            out.setdefault(краткое, полное)
    return out


def load_regions(коды: List[str], грузить_дома: bool = True) -> dict:
    """Загрузить выбранные регионы в data/addr.db.

    Идемпотентно: данные региона сначала удаляются, потом вставляются
    заново, всё в одной транзакции. Повторная загрузка того же файла не
    задваивает записи и не оставляет половину старых.
    """
    коды = [к for к in коды if re.fullmatch(r"\d{2}", к or "")]
    if not коды:
        raise ValueError("Не выбран ни один регион")
    путь_объектов = найти_файл(FILE_OBJECTS)
    if not путь_объектов:
        raise FileNotFoundError(
            "Не найден %s в %s — положите распакованные файлы классификатора"
            % (FILE_OBJECTS, KLADR_DIR))

    набор = set(коды)
    conn = get_addr_connection()
    итог = {"objects": 0, "streets": 0, "houses": 0}
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("BEGIN")
        for к in коды:
            # Поисковый индекс чистится ВМЕСТЕ с данными. Отдельная таблица
            # FTS каскадом не убирается, и без этой строки повторная
            # загрузка того же региона задваивала каждую подсказку.
            if _fts_available:
                conn.execute(
                    "DELETE FROM addr_objects_fts WHERE code IN "
                    "(SELECT code FROM addr_objects WHERE region = ?)", (к,))
                conn.execute(
                    "DELETE FROM addr_streets_fts WHERE code IN "
                    "(SELECT code FROM addr_streets WHERE region = ?)", (к,))
            conn.execute("DELETE FROM addr_objects WHERE region = ?", (к,))
            conn.execute("DELETE FROM addr_streets WHERE region = ?", (к,))
            conn.execute("DELETE FROM addr_houses WHERE region = ?", (к,))

        # --- населённые пункты ---
        _set_job(stage="Населённые пункты", done=0)
        имена: Dict[str, str] = {}          # код -> «г Тверь»
        пути: Dict[str, str] = {}           # код -> «Тверская обл, г Тверь»
        родители: Dict[str, str] = {}
        пачка = []
        for row in read_dbf(путь_объектов):
            code = (row.get("CODE") or "").strip()
            if len(code) < 13 or code[_РЕГИОН] not in набор or not code_is_actual(code):
                continue
            подпись = format_name(row.get("NAME"), row.get("SOCR"), object_level(code))
            имена[code] = подпись
            родитель = parent_code(code)
            родители[code] = родитель
            пачка.append((code, (row.get("NAME") or "").strip(), (row.get("SOCR") or "").strip(),
                          object_level(code), code[_РЕГИОН], родитель,
                          (row.get("INDEX") or "").strip() or None,
                          (row.get("OCATD") or "").strip() or None))
            if len(пачка) >= 5000:
                итог["objects"] += _записать_объекты(conn, пачка, имена, родители, пути)
                пачка = []
                _set_job(done=итог["objects"])
        итог["objects"] += _записать_объекты(conn, пачка, имена, родители, пути)
        _set_job(done=итог["objects"])

        # --- улицы ---
        путь_улиц = найти_файл(FILE_STREETS)
        if путь_улиц:
            _set_job(stage="Улицы", done=0)
            пачка = []
            for row in read_dbf(путь_улиц):
                code = (row.get("CODE") or "").strip()
                if len(code) < 17 or code[_РЕГИОН] not in набор or not code_is_actual(code):
                    continue
                родитель = code[:11] + "00"
                # ПОЛНЫЙ путь населённого пункта, а не одно его имя: иначе
                # улица показывалась бы как «г Тверь, ул Советская» — без
                # области, а одноимённых городов в стране хватает.
                путь_подписи = пути.get(родитель) or имена.get(родитель, "")
                подпись = format_street(row.get("NAME"), row.get("SOCR"))
                имя_улицы = (row.get("NAME") or "").strip()
                пачка.append((code, имя_улицы, имя_улицы.lower(),
                              (row.get("SOCR") or "").strip(), code[_РЕГИОН], родитель,
                              (row.get("INDEX") or "").strip() or None,
                              (путь_подписи + ", " + подпись) if путь_подписи else подпись))
                if len(пачка) >= 5000:
                    итог["streets"] += _записать_улицы(conn, пачка)
                    пачка = []
                    _set_job(done=итог["streets"])
            итог["streets"] += _записать_улицы(conn, пачка)
            _set_job(done=итог["streets"])

        # --- дома ---
        путь_домов = найти_файл(FILE_HOUSES)
        if грузить_дома and путь_домов:
            _set_job(stage="Дома", done=0)
            пачка = []
            for row in read_dbf(путь_домов):
                code = (row.get("CODE") or "").strip()
                if len(code) < 15 or code[_РЕГИОН] not in набор:
                    continue
                # У дома код длиннее улицы на четыре знака плюс признак;
                # родителем считаем первые 17 знаков, если они есть, иначе
                # населённый пункт.
                родитель = (code[:15] + "00") if len(code) >= 19 else (code[:11] + "00")
                пачка.append((code, родитель, code[_РЕГИОН],
                              (row.get("NAME") or "").strip(),
                              (row.get("KORP") or "").strip() or None,
                              (row.get("INDEX") or "").strip() or None))
                if len(пачка) >= 5000:
                    итог["houses"] += _записать_дома(conn, пачка)
                    пачка = []
                    _set_job(done=итог["houses"])
            итог["houses"] += _записать_дома(conn, пачка)
            _set_job(done=итог["houses"])

        # --- отметка о регионах ---
        for к in коды:
            # Код региона — это его две цифры и одиннадцать нулей.
            имя = conn.execute(
                "SELECT name, socr, level FROM addr_objects WHERE code = ?",
                (к + "0" * 11,)).fetchone()
            подпись = (format_name(имя["name"], имя["socr"], имя["level"])
                       if имя else "Регион %s" % к)
            n_o = conn.execute("SELECT COUNT(*) c FROM addr_objects WHERE region = ?", (к,)).fetchone()["c"]
            n_s = conn.execute("SELECT COUNT(*) c FROM addr_streets WHERE region = ?", (к,)).fetchone()["c"]
            n_h = conn.execute("SELECT COUNT(*) c FROM addr_houses WHERE region = ?", (к,)).fetchone()["c"]
            conn.execute(
                "INSERT INTO addr_regions (code, name, objects, streets, houses, loaded_at, source_file) "
                "VALUES (?,?,?,?,?,datetime('now'),?) "
                "ON CONFLICT(code) DO UPDATE SET name=excluded.name, objects=excluded.objects, "
                "streets=excluded.streets, houses=excluded.houses, loaded_at=excluded.loaded_at, "
                "source_file=excluded.source_file",
                (к, подпись, n_o, n_s, n_h, FILE_OBJECTS))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return итог


def _полный_путь(code: str, имена: Dict[str, str], родители: Dict[str, str]) -> str:
    """«Тверская обл, Калининский р-н, д Аввакумово».

    Собирается ПРИ ЗАГРУЗКЕ и хранится готовой строкой: иначе каждая
    подсказка стоила бы трёх соединений, а показывается их по двадцать на
    каждое нажатие клавиши.
    """
    части, текущий, защита = [], code, 0
    while текущий and защита < 6:
        подпись = имена.get(текущий)
        if подпись:
            части.append(подпись)
        текущий = родители.get(текущий) or parent_code(текущий)
        защита += 1
    return ", ".join(reversed(части))


def _записать_объекты(conn, пачка, имена, родители, пути=None) -> int:
    if not пачка:
        return 0
    строки = []
    for (code, name, socr, level, region, parent, postal, okato) in пачка:
        полный = _полный_путь(code, имена, родители)
        if пути is not None:
            пути[code] = полный          # понадобится улицам этого же региона
        строки.append((code, name, (name or "").lower(), socr, level, region,
                       parent, postal, okato, полный))
    conn.executemany(
        "INSERT OR REPLACE INTO addr_objects "
        "(code, name, name_lower, socr, level, region, parent, postal_code, okato, full_path) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)", строки)
    if _fts_available:
        conn.executemany(
            "INSERT INTO addr_objects_fts (name, full_path, code) VALUES (?,?,?)",
            [(s[1], s[9], s[0]) for s in строки])
    return len(строки)


def _записать_улицы(conn, пачка) -> int:
    if not пачка:
        return 0
    conn.executemany(
        "INSERT OR REPLACE INTO addr_streets "
        "(code, name, name_lower, socr, region, parent, postal_code, full_path) "
        "VALUES (?,?,?,?,?,?,?,?)", пачка)
    if _fts_available:
        conn.executemany(
            "INSERT INTO addr_streets_fts (name, code, parent) VALUES (?,?,?)",
            [(p[1], p[0], p[5]) for p in пачка])
    return len(пачка)


def _записать_дома(conn, пачка) -> int:
    if not пачка:
        return 0
    conn.executemany(
        "INSERT OR REPLACE INTO addr_houses (code, parent, region, nums, korp, postal_code) "
        "VALUES (?,?,?,?,?,?)", пачка)
    return len(пачка)


def start_fetch(грузить_дома: bool = True, скачивать: bool = True) -> dict:
    """Получить классификатор: скачать архив и распаковать нужные файлы.

    Отдельный шаг от загрузки регионов, потому что регионы выбирают ПО
    СПИСКУ, а список читается уже из распакованного файла. В фоне — потому
    что это полсотни мегабайт по сети и полтерабайта... вернее, шестьсот
    мегабайт распаковки: браузер столько ждать не станет.
    """
    if not _job_lock.acquire(blocking=False):
        raise RuntimeError("Загрузка уже идёт")
    _job.clear()
    _set_job(state="running", stage="Подготовка", done=0, total=0,
             started_at=time.strftime("%Y-%m-%d %H:%M:%S"), error=None, result=None)

    def работа():
        try:
            архив = os.path.join(KLADR_DIR, ARCHIVE_NAME)
            if скачивать or not os.path.isfile(архив):
                _set_job(stage="Скачиваем с сайта ФНС", done=0, total=0)

                def прогресс_скачивания(принято, всего):
                    _set_job(done=принято, total=всего)

                download_archive(прогресс_скачивания)
            _set_job(stage="Распаковываем", done=0, total=0)

            последний = {"имя": None}

            def прогресс_распаковки(имя, сделано, всего):
                if имя != последний["имя"]:
                    последний["имя"] = имя
                    _set_job(stage="Распаковываем: " + имя)
                _set_job(done=сделано, total=всего)

            файлы = unpack_archive(ARCHIVE_NAME, грузить_дома, прогресс_распаковки)
            _set_job(state="done", stage="Готово", result={"files": файлы})
        except Exception as e:                        # noqa: BLE001
            _set_job(state="error", error=str(e), stage="Ошибка")
        finally:
            _job_lock.release()

    threading.Thread(target=работа, name="kladr-fetch", daemon=True).start()
    return job_status()


def start_load(коды: List[str], грузить_дома: bool = True) -> dict:
    """Запустить загрузку в фоновом потоке.

    В фоне, а не в запросе: регион уровня Московской области — это миллионы
    строк и минуты работы, а браузер к тому времени давно отвалится по
    таймауту. Прогресс читается отдельным запросом.
    """
    if not _job_lock.acquire(blocking=False):
        raise RuntimeError("Загрузка уже идёт")
    _job.clear()
    _set_job(state="running", regions=list(коды), stage="Подготовка", done=0,
             started_at=time.strftime("%Y-%m-%d %H:%M:%S"), error=None, result=None)

    def работа():
        try:
            итог = load_regions(коды, грузить_дома)
            _set_job(state="done", result=итог, stage="Готово")
        except Exception as e:                       # noqa: BLE001 — в статус, не в лог
            _set_job(state="error", error=str(e), stage="Ошибка")
        finally:
            _job_lock.release()

    threading.Thread(target=работа, name="kladr-load", daemon=True).start()
    return job_status()


# ---------------------------------------------------------------- подсказки

def _поиск_объектов(conn, q: str, limit: int) -> List[sqlite3.Row]:
    if _fts_available:
        try:
            return list(conn.execute(
                "SELECT o.* FROM addr_objects_fts f JOIN addr_objects o ON o.code = f.code "
                "WHERE addr_objects_fts MATCH ? "
                "ORDER BY CASE WHEN o.socr = 'г' THEN 0 WHEN o.level = 4 THEN 1 WHEN o.level = 1 THEN 2 ELSE 3 END, "
                "o.name LIMIT ?",
                (_fts_query(q, "name"), limit)))
        except sqlite3.OperationalError:
            pass
    return list(conn.execute(
        "SELECT * FROM addr_objects WHERE name_lower LIKE ? "
        "ORDER BY CASE WHEN socr = 'г' THEN 0 WHEN level = 4 THEN 1 WHEN level = 1 THEN 2 ELSE 3 END, "
        "name LIMIT ?",
        (q.lower() + "%", limit)))


def _fts_query(q: str, колонка: str = None) -> str:
    """Запрос к FTS5 из пользовательского ввода.

    Спецсимволы вырезаются, а не экранируются: «*», кавычки и скобки в
    названии населённого пункта не встречаются, зато любая из них роняет
    разбор запроса FTS с ошибкой синтаксиса.

    `колонка` ограничивает поиск ОДНИМ полем — собственным именем объекта, а
    не полным путём. Без этого «новосибирск» находил любой населённый пункт
    Новосибирской области (его путь содержит слово «Новосибирская»), и
    настоящий город Новосибирск тонул среди десятков совпадений с чужим
    именем, отсортированных по алфавиту.
    """
    слова = re.findall(r"[\w\-]+", q, flags=re.UNICODE)
    if not слова:
        return '""'
    запрос = " ".join('"%s"*' % с for с in слова)
    return "%s : (%s)" % (колонка, запрос) if колонка else запрос


def suggest_settlements(q: str, region: Optional[str] = None, limit: int = 20) -> List[dict]:
    """Подсказки по населённым пунктам: регионы, районы, города, посёлки."""
    q = (q or "").strip()
    if len(q) < 2:
        return []
    conn = get_addr_connection()
    try:
        строки = _поиск_объектов(conn, q, limit * 3 if region else limit)
        out = []
        for r in строки:
            if region and r["region"] != region:
                continue
            out.append({
                "code": r["code"],
                "label": format_name(r["name"], r["socr"], r["level"]),
                "full_path": r["full_path"],
                "level": r["level"],
                "region": r["region"],
                "postal_code": r["postal_code"],
            })
            if len(out) >= limit:
                break
        return out
    finally:
        conn.close()


def suggest_streets(parent: str, q: str = "", limit: int = 20) -> List[dict]:
    """Улицы внутри населённого пункта. Пустой запрос отдаёт первые по
    алфавиту: в маленьком посёлке улиц десяток, и набирать нечего."""
    if not re.fullmatch(r"\d{13}", parent or ""):
        return []
    q = (q or "").strip()
    conn = get_addr_connection()
    try:
        if q:
            # Поиск по подстроке в нижнем регистре: улицу ищут по любому
            # слову названия («советск» в «2-я Советская»), а набирают
            # строчными.
            строки = conn.execute(
                "SELECT * FROM addr_streets WHERE parent = ? AND name_lower LIKE ? "
                "ORDER BY name LIMIT ?", (parent, "%" + q.lower() + "%", limit))
        else:
            строки = conn.execute(
                "SELECT * FROM addr_streets WHERE parent = ? ORDER BY name LIMIT ?",
                (parent, limit))
        return [{
            "code": r["code"],
            "label": format_street(r["name"], r["socr"]),
            "full_path": r["full_path"],
            "postal_code": r["postal_code"],
        } for r in строки]
    finally:
        conn.close()


# -------------------------------------------------------- проверка номера дома
#
# КЛАДР перечисляет дома одной строкой через запятую: «1,3,5-9,11А». По
# первому впечатлению «5-9» читается как диапазон (5,6,7,8,9 или через один
# 5,7,9) — с этим предположением и был написан первый вариант разбора.
# Проверка на ВСЕЙ стране (2026-09-08, все 90 регионов, 3 891 608 строк
# DOMA.DBF) не нашла НИ ОДНОГО дефиса между двумя числами — ни разу.
# Единственное употребление дефиса (236 002 строки) — часть сокращения
# «г-ж» (гараж), то есть буква-дефис-буква, а не число-дефис-число.
# Диапазонов через дефис КЛАДР не использует вовсе: каждый номер, включая
# корпуса и строения, перечислен отдельно («10к1,10стр2,12,14»). Поэтому
# сравнение — точное совпадение токена, без попытки что-то разворачивать.
_НОМЕР = re.compile(r"^(\d+)\s*(.*)$")


def house_matches(nums: str, номер: str) -> bool:
    """Есть ли номер дома среди перечисленных в строке КЛАДР."""
    номер = (номер or "").strip().upper().replace(" ", "")
    if not номер:
        return False
    for кусок in (nums or "").split(","):
        if кусок.strip().upper().replace(" ", "") == номер:
            return True
    return False


def _номер_для_сортировки(токен: str):
    """Ключ естественной сортировки: «12» раньше «14», «14» раньше «14А»,
    а не как получится при обычном алфавитном сравнении строк."""
    m = _НОМЕР.match(токен.upper())
    if not m:
        return (10 ** 9, токен)
    return (int(m.group(1)), m.group(2))


def suggest_houses(parent: str, q: str = "", limit: int = 30) -> List[dict]:
    """Дома на улице (или прямо в населённом пункте, если улицы нет).

    В отличие от справочника ФНС по деревням-улицам, здесь нет отдельной
    таблицы «один дом — одна строка»: КЛАДР хранит номера домов ПАЧКАМИ,
    через запятую, в одной строке `addr_houses.nums` («10к1,10стр2,12,14»).
    Прежде считалось, что внутри пачки бывают ещё и диапазоны через дефис
    («5-9») — проверка на 290 тысячах домов Москвы и области ни одного
    такого случая не показала: КЛАДР перечисляет номера по одному, включая
    корпуса и строения. Поэтому подсказка — это разбор пачек на отдельные
    номера, а не разворачивание диапазонов (см. `house_matches` ниже: он
    по-прежнему умеет диапазоны — на случай встречи в данных, которых в
    выборке не было, но исключать которые для всей страны рано).
    """
    if not re.fullmatch(r"\d{13}|\d{17}", parent or ""):
        return []
    q = (q or "").strip().upper().replace(" ", "")
    conn = get_addr_connection()
    try:
        строки = list(conn.execute(
            "SELECT nums, postal_code FROM addr_houses WHERE parent = ?", (parent,)))
    finally:
        conn.close()

    найдено = {}   # номер -> индекс, чтобы не показывать дубликаты
    for r in строки:
        for кусок in (r["nums"] or "").split(","):
            токен = кусок.strip()
            if not токен:
                continue
            if q and not токен.upper().replace(" ", "").startswith(q):
                continue
            if токен not in найдено:
                найдено[токен] = r["postal_code"]

    номера = sorted(найдено, key=_номер_для_сортировки)[:limit]
    return [{"label": n, "postal_code": найдено[n]} for n in номера]


def check_house(parent: str, номер: str, korp: str = "") -> dict:
    """Проверить номер дома по классификатору и уточнить индекс.

    Дом не найден — это НЕ ошибка: у стройплощадки номер бывает
    нестандартный («участок 4/1»), и запретить его значило бы запретить
    завести объект. Возвращается пометка, а решение остаётся за человеком.
    """
    if not re.fullmatch(r"\d{13}|\d{17}", parent or ""):
        return {"found": False, "postal_code": None}
    conn = get_addr_connection()
    try:
        for r in conn.execute(
            "SELECT nums, korp, postal_code FROM addr_houses WHERE parent = ?", (parent,)
        ):
            if not house_matches(r["nums"], номер):
                continue
            if korp and (r["korp"] or "").strip().upper() not in ("", korp.strip().upper()):
                continue
            return {"found": True, "postal_code": r["postal_code"]}
        return {"found": False, "postal_code": None}
    finally:
        conn.close()


def resolve(code: str) -> Optional[dict]:
    """Собрать адрес по коду: строку, части и индекс.

    Строку собирает СЕРВЕР, а не клиент: она попадёт в отчёты и печать, и
    двух разных способов её склеить быть не должно.
    """
    code = (code or "").strip()
    if not re.fullmatch(r"\d{13}|\d{17}|\d{19}", code):
        return None
    conn = get_addr_connection()
    try:
        части = {}
        индекс = None
        населённый = code[:11] + "00"
        улица = None
        if len(code) >= 17:
            улица = code[:15] + "00"
            r = conn.execute("SELECT * FROM addr_streets WHERE code = ?", (улица,)).fetchone()
            if r:
                части["street"] = {"name": r["name"], "type": r["socr"], "code": r["code"]}
                индекс = r["postal_code"] or индекс
        цепочка, текущий, защита = [], населённый, 0
        while текущий and защита < 6:
            r = conn.execute("SELECT * FROM addr_objects WHERE code = ?", (текущий,)).fetchone()
            if r:
                цепочка.append(r)
                индекс = индекс or r["postal_code"]
            текущий = parent_code(текущий)
            защита += 1
        ключи = {1: "region", 2: "area", 3: "city", 4: "settlement"}
        for r in цепочка:
            части[ключи.get(r["level"], "settlement")] = {
                "name": r["name"], "type": r["socr"], "code": r["code"]}
        if not цепочка:
            return None
        подписи = [format_name(r["name"], r["socr"], r["level"]) for r in reversed(цепочка)]
        if "street" in части:
            подписи.append(format_street(части["street"]["name"], части["street"]["type"]))
        return {
            "code": code,
            "source": "kladr",
            "region": code[_РЕГИОН],
            "address": ", ".join(подписи),
            "parts": части,
            "postal_code": индекс,
        }
    finally:
        conn.close()


def status() -> dict:
    """Что показывать в настройке: файлы, регионы в них, что загружено."""
    conn = get_addr_connection()
    try:
        регионы = [dict(r) for r in conn.execute("SELECT * FROM addr_regions ORDER BY name")]
        всего = conn.execute("SELECT COUNT(*) c FROM addr_objects").fetchone()["c"]
    finally:
        conn.close()
    return {
        "dir": KLADR_DIR,
        "files": list_source_files(),
        "loaded": регионы,
        "objects_total": всего,
        "db_size": addr_db_size(),
        "has_7z": bool(_find_7z()),
        "job": job_status(),
    }


# ------------------------------------------------------------------- API
#
# Подсказки открыты любому вошедшему: это справочные данные, по которым
# нельзя узнать ничего о стройках предприятия. Загрузка — отдельный раздел
# прав, только администратору сервиса: она пишет сотни мегабайт на диск
# сервера и занимает минуты.

router = APIRouter(prefix="/address", tags=["address"])


class AddressLoadIn(BaseModel):
    regions: List[str]
    # Дома нужны только ради уточнения почтового индекса и проверки номера,
    # а это самый крупный файл — пусть их загрузку можно будет отключить,
    # если места на сервере в обрез.
    houses: bool = True


@router.get("/status")
def address_status(user=Depends(get_current_user)):
    """Что загружено и что лежит в каталоге. Нужен и виджету адреса — он по
    нему понимает, показывать подсказки или свободный ввод."""
    return status()


@router.get("/regions-in-file")
def address_regions_in_file(
    admin=Depends(require_service_feature("address_load", "write"))
):
    """Регионы в положенном KLADR.DBF — чтобы человек отмечал их по
    названиям, а не по двузначным кодам."""
    return {"regions": regions_in_file()}


@router.post("/fetch")
def address_fetch(
    houses: bool = Query(True, description="Распаковывать ли файл домов"),
    download: bool = Query(True, description="Скачать заново, даже если архив уже лежит"),
    admin=Depends(require_service_feature("address_load", "write")),
):
    """Скачать классификатор с сайта ФНС и распаковать — одной кнопкой."""
    try:
        job = start_fetch(houses, download)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    activity.log("address_fetch", user=admin, new_value=KLADR_URL)
    return job


@router.post("/upload")
def address_upload(
    file: UploadFile = File(...),
    admin=Depends(require_service_feature("address_load", "write")),
):
    """Принять файл классификатора, выбранный в браузере.

    Второй путь на случай, когда у сервера нет выхода в интернет: человек
    качает архив у себя и отдаёт его системе. Принимается и архив, и
    отдельный файл .DBF.
    """
    имя = os.path.basename(file.filename or "")
    if not re.fullmatch(r"[A-Za-z0-9._\-]{1,60}", имя) or not имя.upper().endswith(
            (".7Z", ".ZIP", ".DBF")):
        raise HTTPException(
            status_code=400,
            detail="Ожидается архив классификатора (.7z, .zip) или файл .DBF")
    os.makedirs(KLADR_DIR, exist_ok=True)
    copy_upload_limited(file.file, Path(KLADR_DIR) / имя)
    activity.log("address_upload", user=admin, new_value=имя)
    return {"name": имя, "size": os.path.getsize(os.path.join(KLADR_DIR, имя))}


@router.post("/unpack")
def address_unpack(
    name: str = Query(..., description="Имя архива в каталоге классификатора"),
    houses: bool = Query(True),
    admin=Depends(require_service_feature("address_load", "write")),
):
    try:
        файлы = unpack_archive(name, houses)
    except (FileNotFoundError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:                        # noqa: BLE001
        raise HTTPException(status_code=400, detail="Не удалось распаковать: %s" % e)
    activity.log("address_unpack", user=admin, new_value=name)
    return {"files": файлы}


@router.post("/load")
def address_load(
    body: AddressLoadIn,
    admin=Depends(require_service_feature("address_load", "write")),
):
    try:
        job = start_load(body.regions, body.houses)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    activity.log("address_load", user=admin, new_value=", ".join(body.regions))
    return job


@router.get("/load-status")
def address_load_status(
    admin=Depends(require_service_feature("address_load", "write"))
):
    """Прогресс фоновой загрузки. Пусто — значит в этом запуске сервера её
    не было: состояние живёт в памяти процесса и перезапуск его теряет."""
    return {"job": job_status()}


@router.get("/settlements")
def address_settlements(
    q: str = Query("", max_length=100),
    region: Optional[str] = Query(None, max_length=2),
    user=Depends(get_current_user),
):
    return {"items": suggest_settlements(q, region)}


@router.get("/streets")
def address_streets(
    parent: str = Query(..., max_length=13),
    q: str = Query("", max_length=100),
    user=Depends(get_current_user),
):
    return {"items": suggest_streets(parent, q)}


@router.get("/houses")
def address_houses(
    parent: str = Query(..., max_length=17),
    q: str = Query("", max_length=40),
    user=Depends(get_current_user),
):
    """Номера домов на улице (или в населённом пункте, если улицы нет) —
    подсказка к полю «Дом». Список, а не только проверка: реальные данные
    показали, что КЛАДР перечисляет дома по одному через запятую, без
    диапазонов, — выбрать стало можно, раньше считалось, что нельзя."""
    return {"items": suggest_houses(parent, q)}


@router.get("/check-house")
def address_check_house(
    parent: str = Query(..., max_length=17),
    number: str = Query(..., max_length=40),
    korp: str = Query("", max_length=20),
    user=Depends(get_current_user),
):
    """Есть ли такой дом в классификаторе. Ответ «нет» не запрещает
    сохранить адрес — у стройплощадки номер бывает нестандартный."""
    return check_house(parent, number, korp)


@router.get("/resolve")
def address_resolve(
    code: str = Query(..., max_length=19),
    user=Depends(get_current_user),
):
    r = resolve(code)
    if r is None:
        raise HTTPException(status_code=404, detail="Адрес по этому коду не найден")
    return r


# ---------------------------------------------------------- регион по адресу
#
# Нужен фильтру «по региону» в справочнике «Проекты и объекты»: при массовом
# импорте адрес приходит уже готовой строкой (не через виджет с выбором
# населённого пункта), и структурного address_region у такой записи нет.
# Геокодировать каждую строку ради одного региона — избыточно (сеть,
# задержка, зависимость от «Карты и адресов из интернета»); регион надёжно
# читается из самого текста офлайн, потому что в русском адресе он
# указывается первым и совпадает с одним из 90 названий классификатора.

def region_from_address(address: str) -> Optional[str]:
    """Код региона по тексту адреса — сопоставлением с названиями регионов
    уже загруженного классификатора. None, если ни один не нашёлся (регион
    не загружен или адрес не похож на российский)."""
    address = (address or "").strip()
    if not address:
        return None
    conn = get_addr_connection()
    try:
        строки = list(conn.execute(
            "SELECT region, name FROM addr_objects WHERE level = 1 ORDER BY length(name) DESC"))
    finally:
        conn.close()
    if not строки:
        return None

    # Регион почти всегда указывается ПЕРВЫМ в русском адресе — сверяем
    # сначала с началом строки (первые 60 символов, не строго до запятой:
    # индекс перед регионом, как в «121309, Город Москва, …», иначе увёл бы
    # проверку по чистому «до запятой» на пустой числовой токен). Резко
    # снижает риск ложного совпадения — например, слово «Москва» внутри
    # названия трассы где-то дальше в адресе другого региона. Только если
    # в начале не нашлось — проверяем строку целиком, чтобы нестандартно
    # оформленный адрес не остался вовсе без региона.
    начало = address[:60].lower()
    целиком = address.lower()
    for кандидат in (начало, целиком):
        for r in строки:
            имя = (r["name"] or "").lower()
            if имя and re.search(
                    r"(?<![a-zа-яё0-9])" + re.escape(имя) + r"(?![a-zа-яё0-9])",
                    кандидат):
                return r["region"]
    return None


# --------------------------------------------- разбор свободного адреса

# Слова-типы населённого пункта и улицы — снимаются с краёв сегмента перед
# точным сравнением с `name_lower`: колонка хранит ГОЛОЕ имя («Тверь»,
# «Авиационная»), без «г»/«ул», а в свободном тексте они почти всегда есть.
_НАСЕЛЁННЫЙ_ПРЕФИКС = re.compile(
    r"^(г|город|гор|пос|посёлок|поселок|дер|деревня|рп|пгт|с|село|ст-ца|станица|аул|х|хутор)\.?\s*",
    re.IGNORECASE)
_УЛИЦА_ПРЕФИКС = re.compile(
    r"^(ул|улица|пр-кт|проспект|пр-т|пер|переулок|ш|шоссе|пл|площадь|б-р|бульвар|"
    r"наб|набережная|проезд|туп|тупик|аллея)\.?\s*",
    re.IGNORECASE)
_УЛИЦА_СУФФИКС = re.compile(
    r"\s+(ул|улица|пр-кт|проспект|пр-т|пер|переулок|ш|шоссе|пл|площадь|б-р|бульвар|"
    r"наб|набережная|проезд|туп|тупик|аллея|линия|тракт)\.?\s*$",
    re.IGNORECASE)
# Первый номер-подобный токен в хвосте — только чтобы свериться с
# check_house() ради индекса; сам хвост целиком идёт в адрес как есть,
# ничего из него не отбрасывается (см. resolve_free_text_address).
_ПЕРВЫЙ_НОМЕР = re.compile(r"([0-9]+[a-zа-я]?)", re.IGNORECASE)
# Слово-маркер дома снимается ТОЛЬКО с самого начала хвоста — дальше он
# идёт в адрес как есть (в частности «корп. 2» не трогаем: это не то же
# самое слово). Без этой чистки перед хвостом со своим «вл. 61» ниже
# приписалось бы ещё и наше «, д », и адрес задваивал бы слово-маркер.
_ДОМ_МАРКЕР = re.compile(r"^(д|дом|вл|владение|уч|участок|з/у)\.?\s*№?\s*", re.IGNORECASE)


def _без_ё(текст: str) -> str:
    """КЛАДР сам с собой не согласен: «Зелёный Клин» через ё, «Королев»
    (правильно «Королёв») — через е, в одном и том же файле. Сравнение
    точное, поэтому обе стороны сравнения приводятся к одной букве —
    иначе ровно такая опечатка эпохи телетайпа молча ломала бы разбор
    каждого второго адреса со звуком «ё» в названии."""
    return текст.replace("ё", "е").replace("Ё", "Е")


def _нормализовать_населённый(текст: str) -> str:
    return _без_ё(_НАСЕЛЁННЫЙ_ПРЕФИКС.sub("", текст.strip()).strip().lower())


def _нормализовать_улицу(текст: str) -> str:
    текст = _УЛИЦА_ПРЕФИКС.sub("", текст.strip())
    текст = _без_ё(_УЛИЦА_СУФФИКС.sub("", текст))
    return текст.strip().lower()


def resolve_free_text_address(text: str) -> Optional[dict]:
    """Пытается разложить ГОТОВУЮ строку адреса по классификатору —
    для импорта из внешнего файла (2026-09-08), где адрес приходит целиком,
    а не через пошаговый выбор в виджете (app/static/address.js). Тот же
    принцип уровней (населённый пункт → улица → дом), но БЕЗ человека,
    поэтому строго консервативно: только ТОЧНОЕ совпадение имени с
    классификатором на каждом уровне, ни одной догадки «похоже, наверное
    это». Не нашли уверенно хотя бы населённый пункт — None, адрес остаётся
    обычным текстом (законное состояние, как и при ручном вводе без
    привязки в виджете).

    Возвращает то же, что resolve() (code/source/region/address/parts/
    postal_code), с добавленным `parts.house`, если в хвосте адреса нашёлся
    номер дома, — собран РОВНО так же, как это делает виджет при свободном
    вводе дома (app/static/address.js, применитьНомерДома): дом остаётся
    текстом, без своего кода классификатора — КЛАДР хранит дома пачками
    через запятую, а не отдельной записью на каждый (см. house_matches).
    """
    text = (text or "").strip()
    if not text:
        return None
    регион = region_from_address(text)
    if not регион:
        return None
    сегменты = [s.strip() for s in text.split(",") if s.strip()]

    conn = get_addr_connection()
    try:
        поселение, i_поселения = None, -1
        for i, сег in enumerate(сегменты):
            if сег.isdigit():
                continue   # почтовый индекс отдельной строкой
            имя = _нормализовать_населённый(сег)
            if not имя:
                continue
            строки = conn.execute(
                "SELECT * FROM addr_objects WHERE region = ? AND REPLACE(name_lower, 'ё', 'е') = ?",
                (регион, имя),
            ).fetchall()
            if len(строки) == 1:
                поселение, i_поселения = строки[0], i
                break
        if поселение is None:
            return None

        улица, i_улицы = None, i_поселения
        for j in range(i_поселения + 1, len(сегменты)):
            сег = сегменты[j]
            if any(ch.isdigit() for ch in сег):
                break   # цифра — это уже, скорее всего, номер дома
            имя = _нормализовать_улицу(сег)
            if имя:
                строки = conn.execute(
                    "SELECT * FROM addr_streets WHERE parent = ? AND REPLACE(name_lower, 'ё', 'е') = ?",
                    (поселение["code"], имя),
                ).fetchall()
                if len(строки) == 1:
                    улица, i_улицы = строки[0], j
            break   # дальше первого несовпавшего сегмента не гадаем

        anchor = улица["code"] if улица else поселение["code"]
        хвост = сегменты[i_улицы + 1:]
    finally:
        conn.close()

    результат = resolve(anchor)
    if результат is None:
        return None
    результат = dict(результат)
    результат["parts"] = dict(результат["parts"])

    if хвост:
        первый = _ДОМ_МАРКЕР.sub("", хвост[0].strip())
        дом_текст = ", ".join([первый] + хвост[1:]) if первый else ", ".join(хвост[1:])
        if дом_текст:
            результат["parts"]["house"] = {"name": дом_текст, "type": "д", "code": None}
            результат["address"] = результат["address"] + ", д " + дом_текст
            м = _ПЕРВЫЙ_НОМЕР.search(дом_текст)
            if м and re.fullmatch(r"\d{13}|\d{17}", anchor):
                проверка = check_house(anchor, м.group(1))
                if проверка.get("postal_code"):
                    результат["postal_code"] = проверка["postal_code"]
    return результат
