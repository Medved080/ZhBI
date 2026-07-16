@echo off
chcp 65001 >nul
REM Запуск сервера ЖБИ. Держите это окно открытым, пока сервер должен
REM работать — закрытие окна (или Ctrl+C) останавливает сервер. Для
REM постоянной работы без открытого окна см. Docs/DEPLOYMENT_WINDOWS.md
REM (раздел про автозапуск / Планировщик заданий).

REM Порт можно поменять здесь при конфликте с другой программой.
set PORT=8000

cd /d "%~dp0..\.."

if not exist ".venv" (
    echo [ОШИБКА] .venv не найден — сначала запустите install.bat.
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat

echo Сервер запускается на порту %PORT% ...
echo На этом компьютере:  http://localhost:%PORT%
echo С других компьютеров сети: http://ЭТОТ-IP-АДРЕС:%PORT%
echo (см. Docs/DEPLOYMENT_WINDOWS.md про адрес и Брандмауэр Windows)
echo.

python -m uvicorn app.main:app --host 0.0.0.0 --port %PORT%

pause
