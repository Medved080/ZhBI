"""Имитация сообщения контакта боту eXpress — для живой проверки на стенде (scripts/dev_express_stand.py).

    .venv312/bin/python scripts/express_say.py <порт стенда> <логин> "<текст>" [JSON data кнопки]

Отправляет на стенд `POST /command` с подписью макета CTS — так же, как это сделал бы настоящий CTS. Чат и идентификатор контакта выводятся
из логина (одинаковые при каждом вызове), поэтому «/start» от одного и того же логина привязывает один и тот же чат.
Ответ бота смотрите в макете: http://127.0.0.1:8091/_mock/messages.
"""
import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import express_cts_mock as mock


def uuid_of(text: str) -> str:
    h = hashlib.md5(text.encode()).hexdigest()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__)
        return 1
    port, login, text = sys.argv[1], sys.argv[2], sys.argv[3]
    data = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
    huid = os.environ.get("HUID") or uuid_of("huid:" + login)           # HUID=… — чтобы совпасть с контактом, найденным в макете по e-mail
    payload = {"from": {"user_huid": huid, "ad_login": login, "group_chat_id": uuid_of("chat:" + login), "chat_type": "chat", "username": login},
               "command": {"body": text, "data": data, "command_type": "user"}, "bot_id": mock.BOT_ID}
    request = urllib.request.Request(f"http://127.0.0.1:{port}/command", data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": "Bearer " + mock.sign_jwt()})
    with urllib.request.urlopen(request, timeout=10) as response:
        print(response.status, response.read().decode())
    mock_port = os.environ.get("MOCK")                                   # MOCK=8091 — показать последнее сообщение бота из макета CTS
    if mock_port:
        time.sleep(1.2)
        with urllib.request.urlopen(f"http://127.0.0.1:{mock_port}/_mock/messages", timeout=10) as response:
            messages = json.loads(response.read().decode())
        if messages:
            print(">>", messages[-1]["text"].replace("\n", " / "))
            print("   кнопки:", messages[-1]["buttons"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
