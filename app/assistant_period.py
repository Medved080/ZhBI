"""Однозначные периоды русского вопроса; остальные формулировки разбирает модель."""
import re
from datetime import date, timedelta

MONTHS = ("январ", "феврал", "март", "апрел", "ма[йя]", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр")


def question_period(question, end):
    text = question.lower().replace("ё", "е")
    if re.search(r"выбранн\w* (?:период|дат)|указанн\w* (?:период|дат)", text):
        return None
    for pattern, count, label in [(r"(?:за|последни\w*)\s+(?:последни\w*\s+)?месяц\b", 30, "Последние 30 дней"), (r"(?:за|последни\w*)\s+(?:последни\w*\s+)?недел[юя]\b", 7, "Последние 7 дней")]:
        if re.search(pattern, text):
            return end-timedelta(days=count), end, label
    m = re.search(r"(?:за\s+)?последни\w*\s+(\d{1,3})\s+дн", text)
    if m:
        n = int(m[1])
        if n > 0:
            return end-timedelta(days=n), end, f"Последние {n} дней"
    if re.search(r"\b(?:сегодня|за день)\b", text):
        return end-timedelta(days=1), end, "За день"
    if re.search(r"\bвчера\b", text):
        return end-timedelta(days=2), end-timedelta(days=1), "За вчера"
    if re.search(r"(?:этот|текущий) месяц|начала месяца", text):
        return end.replace(day=1)-timedelta(days=1), end, "С начала месяца"
    if re.search(r"(?:прошлый|предыдущий) месяц", text):
        last = end.replace(day=1)-timedelta(days=1)
        return last.replace(day=1)-timedelta(days=1), last, "Предыдущий календарный месяц"
    if re.search(r"(?:этот|текущий) год|начала года", text):
        return date(end.year-1, 12, 31), end, "С начала года"
    for month, pattern in enumerate(MONTHS, 1):
        match = re.search(r"за\s+(?:весь\s+)?("+pattern+r"\w*)\s*(20\d{2})?", text)
        if match:
            year = int(match[2]) if match[2] else end.year - int(month > end.month)
            first = date(year, month, 1)
            last = date(year+int(month == 12), month % 12+1, 1)-timedelta(days=1)
            return first-timedelta(days=1), last, f"За {match[1]} {year}"
    return None
