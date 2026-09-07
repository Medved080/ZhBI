#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Готовит подложку для «Карты проектов» — файлы PMTiles.

Запускается НЕ на сервере, а на машине с интернетом (например, на ноутбуке
разработчика), потому что сервер наружу не ходит. Готовые файлы переносятся
на сервер в `data/map/` обычным копированием.

Зачем вообще файл. Тайловых сервисов у нас нет и быть не может: контур
закрытый. PMTiles — это один файл, который браузер читает по диапазонам
байт прямо с нашего сервера, без тайлового сервера и без интернета.

Что качаем. Ежедневную сборку OpenStreetMap от Protomaps (лицензия ODbL,
указание авторства — обязательное условие и оно вшито в карту). Из планеты
вырезаются только нужные области: полностью она весит больше сотни
гигабайт, а нам нужны обзор по стране и детальность там, где идёт стройка.

Что нужно поставить один раз: утилиту `pmtiles`
(https://github.com/protomaps/go-pmtiles/releases) — она умеет вырезать
кусок прямо из удалённого файла, не скачивая его целиком.

Примеры:

    python3 scripts/fetch_map_tiles.py                 # РФ обзорно + Москва и область детально
    python3 scripts/fetch_map_tiles.py --only ru       # только обзор по стране
    python3 scripts/fetch_map_tiles.py --list          # показать заготовленные области
    python3 scripts/fetch_map_tiles.py --bbox 60,54,64,58 --maxzoom 13 --name ekb
"""

import argparse
import os
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta

# Заготовленные области. Обзор по стране нужен, чтобы карта не была дырявой
# вокруг площадок; детальность — там, где действительно ведётся
# строительство (её и просил пользователь).
ОБЛАСТИ = {
    "ru": {
        "bbox": "19.0,41.0,180.0,78.0",
        "maxzoom": 8,
        "title": "Россия целиком, обзорно — города и крупные дороги",
    },
    "msk": {
        "bbox": "35.1,54.2,40.2,56.9",
        "maxzoom": 14,
        "title": "Москва и Московская область, детально — улицы и здания",
    },
}

ВЫХОД = "data/map"


def найти_pmtiles():
    путь = shutil.which("pmtiles")
    if путь:
        return путь
    print(
        "Не найдена утилита `pmtiles`.\n"
        "Она вырезает нужный кусок карты, не скачивая планету целиком.\n\n"
        "Поставить (macOS):   brew install protomaps/tap/pmtiles\n"
        "Либо скачать бинарь: https://github.com/protomaps/go-pmtiles/releases\n"
        "и положить его в PATH.",
        file=sys.stderr,
    )
    return None


def последняя_сборка():
    """Адрес свежей сборки планеты.

    Сборки выкладываются ежедневно, но сегодняшней может ещё не быть —
    отступаем назад по дням, пока не найдём готовую.
    """
    сегодня = datetime.utcnow().date()
    for назад in range(0, 10):
        день = (сегодня - timedelta(days=назад)).strftime("%Y%m%d")
        адрес = "https://build.protomaps.com/%s.pmtiles" % день
        # Своё имя клиента обязательно: без него раздача отвечает отказом
        # (403), и скрипт решал бы, что сборок нет вовсе.
        запрос = urllib.request.Request(
            адрес, method="HEAD", headers={"User-Agent": "zhbi-tool/1.0"})
        try:
            with urllib.request.urlopen(запрос, timeout=30) as ответ:
                if ответ.status == 200:
                    return адрес
        except Exception:
            continue
    return None


def вырезать(pmtiles, источник, имя, bbox, maxzoom):
    os.makedirs(ВЫХОД, exist_ok=True)
    цель = os.path.join(ВЫХОД, "basemap-%s.pmtiles" % имя)
    print("\n=== %s ===" % имя)
    print("  область:      %s" % bbox)
    print("  детальность:  до уровня %s" % maxzoom)
    print("  файл:         %s" % цель)
    print("  Идёт вырезка. Это долго: утилита читает удалённый файл кусками.")
    команда = [
        pmtiles, "extract", источник, цель,
        "--bbox=" + bbox,
        "--maxzoom=%d" % maxzoom,
    ]
    результат = subprocess.run(команда)
    if результат.returncode != 0:
        print("  ОШИБКА: вырезка не удалась (код %d)" % результат.returncode,
              file=sys.stderr)
        return False
    размер = os.path.getsize(цель) / (1024 ** 3)
    print("  Готово: %.2f ГБ" % размер)
    return True


def main():
    p = argparse.ArgumentParser(description="Подложка для карты проектов")
    p.add_argument("--list", action="store_true", help="показать заготовленные области")
    p.add_argument("--only", metavar="ИМЯ", help="взять только одну заготовленную область")
    p.add_argument("--bbox", help="своя область: запад,юг,восток,север")
    p.add_argument("--maxzoom", type=int, default=13, help="детальность своей области")
    p.add_argument("--name", default="custom", help="имя файла для своей области")
    p.add_argument("--source", help="свой файл-источник вместо свежей сборки")
    аргументы = p.parse_args()

    if аргументы.list:
        print("Заготовленные области:\n")
        for имя, о in ОБЛАСТИ.items():
            print("  %-5s  %s" % (имя, о["title"]))
            print("         область %s, до уровня %d" % (о["bbox"], о["maxzoom"]))
        return 0

    pmtiles = найти_pmtiles()
    if not pmtiles:
        return 1

    источник = аргументы.source
    if not источник:
        print("Ищем свежую сборку карты…")
        источник = последняя_сборка()
        if not источник:
            print("Не удалось найти сборку карты. Проверьте интернет "
                  "или укажите файл через --source.", file=sys.stderr)
            return 1
        print("  берём %s" % источник)

    задания = []
    if аргументы.bbox:
        задания.append((аргументы.name, аргументы.bbox, аргументы.maxzoom))
    elif аргументы.only:
        о = ОБЛАСТИ.get(аргументы.only)
        if not о:
            print("Неизвестная область: %s (см. --list)" % аргументы.only, file=sys.stderr)
            return 1
        задания.append((аргументы.only, о["bbox"], о["maxzoom"]))
    else:
        задания = [(имя, о["bbox"], о["maxzoom"]) for имя, о in ОБЛАСТИ.items()]

    успех = True
    for имя, bbox, maxzoom in задания:
        успех = вырезать(pmtiles, источник, имя, bbox, maxzoom) and успех

    if успех:
        print("\nГотово. Перенесите файлы на сервер:")
        print("  scp %s/basemap-*.pmtiles <сервер>:/opt/zhbi/data/map/" % ВЫХОД)
        print("\nПодложка появится на карте сразу — перезапуск не нужен.")
    return 0 if успех else 1


if __name__ == "__main__":
    sys.exit(main())
