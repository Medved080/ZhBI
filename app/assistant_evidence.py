"""Компактные данные модели; полные проверяемые источники остаются в задании."""
from copy import deepcopy
import re


def explains_sources(question):
    text = question.casefold()
    return bool(re.search(r"(?:каки|како|кака).*(?:отч[её]т|источник).*(?:разн|расхожд|использ|эти)|откуда.*(?:числ|цифр|данн)|почему.*(?:расхожд|разн|цифр)", text))


def previous_context(job):
    sources = deepcopy(job.get("contextSources", []))
    for index, source in enumerate(sources, 1):
        source["id"] = f"previous-{index}"
    return {"sources": sources, "capturedAt": job["capturedAt"], "period": deepcopy(job["period"]),
            "area": job["area"], "objects": [], "warnings": list(job.get("warnings", [])),
            "searchGuards": list(job["guard"]), "previousAnswer": job["answer"],
            "sourceDiscussion": "Это источники предыдущего ответа, а не новый пересчёт. Выборка scope=search — SQL-выборка, не отдельный штатный отчёт. Расхождение чисел само по себе не доказывает различие методик; укажи определения и непроверенную причину."}


class AnswerContext:
    def __init__(self, data):
        self.data = deepcopy({k: v for k, v in data.items() if k != "sources"})
        self.data["objectCount"] = len(self.data.get("objects", []))
        self.data["objects"] = [{"id": o["id"], "name": o["name"]} for o in self.data.get("objects", [])] if self.data["objectCount"] <= 3 else []
        self.data["sources"] = []
        for source in data["sources"]:
            block = deepcopy({k: v for k, v in source.items() if k not in {"url", "feature", "projectName", "reportParams"}})
            block["kind"] = "Выборка данных сервиса" if source["scope"] == "search" else "Штатный отчёт"
            if isinstance(block["data"], dict):
                block["data"].pop("sql", None)
            self.data["sources"].append(block)
        self._shorten_text(self.data)

    def _shorten_text(self, value):
        if isinstance(value, dict):
            for key, child in list(value.items()):
                if isinstance(child, str) and len(child) > 600 and key not in {"definition", "sourceDiscussion"}:
                    value[key] = child[:599] + "…"
                    value["textPreviewOnly"] = True
                else:
                    self._shorten_text(child)
        elif isinstance(value, list):
            for child in value:
                self._shorten_text(child)

    def shrink(self):
        page = self.data.get("page")
        for key in ("text", "filters"):
            if page and page.get(key):
                page[key] = ""
                return True
        candidates = []
        def details(value):
            if isinstance(value, dict):
                if isinstance(value.get("rows"), list) and value["rows"] and not value.get("aggregate"):
                    candidates.append((value, "rows"))
                for child in value.values():
                    details(child)
            elif isinstance(value, list):
                for child in value:
                    details(child)
        for source in self.data["sources"]:
            details(source["data"])
            if isinstance(source["data"], list) and source["data"]:
                candidates.append((source, "data"))
        if candidates:
            # Сохраняем единственную строку агрегата. Детальные списки сокращаем
            # без изменения числовых значений; полный результат остаётся по ссылке.
            from app.assistant_llm import encoded
            larger = [item for item in candidates if len(item[0][item[1]]) > 1]
            if larger:
                value, key = max(larger, key=lambda item: len(encoded(item[0][item[1]])))
                value[key] = value[key][:max(1, len(value[key]) // 2)]
                value["returnedRows"] = len(value[key])
                value["truncated"] = True
                return True
        for source in self.data["sources"]:
            block = source["data"]
            if isinstance(block, dict) and block.get("conclusions"):
                block.pop("conclusions")
                block.setdefault("omittedFields", []).append("conclusions")
                return True
        def shorten(value):
            if isinstance(value, dict):
                for key, child in list(value.items()):
                    if isinstance(child, str) and len(child) > 180 and key not in {"id", "title", "objectName", "definition", "sourceDiscussion"}:
                        value[key] = child[:179] + "…"
                        value["textPreviewOnly"] = True
                        return True
                    if shorten(child):
                        return True
            elif isinstance(value, list):
                for child in value:
                    if shorten(child):
                        return True
            return False
        return shorten(self.data)
