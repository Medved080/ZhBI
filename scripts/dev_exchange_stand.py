"""Стенд для живой проверки «Обмена данными с другим сервером» (2026-10-08): два временных сервера на копиях обезличенной БД.

  * «этот» сервер — порт 18961 (полные данные), его открывает человек/браузер;
  * «чужой» сервер — порт 18962 (с намеренными расхождениями: нет части марок и позиций, цепочки контрагента, записей
    истории; другой цвет статуса; объект 2 переименован), помечен как ТЕСТОВЫЙ (ZHBI_TEST_SERVER_MAIN_URL).
Пароль администратора на обоих — Passw0rd-test-12, логин печатается при старте. Остановка — Ctrl+C. Боевые данные не затрагиваются.

    .venv312/bin/python scripts/dev_exchange_stand.py data/zhbi.anon.db
"""
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_data_exchange as v  # noqa: E402


def main():
    source = Path(sys.argv[1]).resolve()
    work = Path(tempfile.mkdtemp(prefix="dx-stand-"))
    path_a, env_a = v.prepare(work / "a", source, 18961, perturb=False)
    path_b, env_b = v.prepare(work / "b", source, 18962, perturb=True)
    cb = v.db(path_b)
    cb.execute("UPDATE objects SET name = name || ' (переименован)' WHERE id = 2")
    cb.commit()
    cb.close()
    env_b["ZHBI_TEST_SERVER_MAIN_URL"] = "https://main.example"
    login = v.db(path_a).execute("SELECT domain_login FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()["domain_login"]
    procs = [subprocess.Popen([v.PY, "-m", "uvicorn", "app.main:app", "--port", str(port), "--host", "127.0.0.1"], cwd=v.ROOT, env=env)
             for env, port in ((env_a, 18961), (env_b, 18962))]
    print(f"\nЭтот сервер: http://127.0.0.1:18961   чужой (тестовый): http://127.0.0.1:18962\nЛогин: {login}   Пароль: {v.PASSWORD}\n", flush=True)

    def stop(*_):
        for p in procs:
            p.terminate()
        shutil.rmtree(work, ignore_errors=True)
        sys.exit(0)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    while True:
        time.sleep(5)


if __name__ == "__main__":
    main()
