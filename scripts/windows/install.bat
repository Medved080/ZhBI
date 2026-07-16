@echo off
chcp 65001 >nul
REM Первичная установка ЖБИ на Windows. Запускать ОДИН РАЗ, двойным
REM кликом, из любого места — сам находит корень проекта относительно
REM своего расположения (scripts\windows\install.bat).
REM См. Docs/DEPLOYMENT_WINDOWS.md.

cd /d "%~dp0..\.."

where python >nul 2>nul
if errorlevel 1 (
    echo [ОШИБКА] Python не найден в PATH.
    echo Установите Python с https://www.python.org/downloads/windows/
    echo При установке ОБЯЗАТЕЛЬНО отметьте галочку "Add python.exe to PATH".
    pause
    exit /b 1
)

if not exist ".venv" (
    echo Создаю виртуальное окружение .venv ...
    python -m venv .venv
) else (
    echo .venv уже существует, пропускаю создание.
)

call .venv\Scripts\activate.bat

echo Обновляю pip и ставлю зависимости из requirements.txt ...
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
    echo [ОШИБКА] Установка зависимостей не завершилась успешно — см. текст выше.
    pause
    exit /b 1
)

if not exist "Input" mkdir "Input"

echo.
echo Готово. Дальше используйте scripts\windows\run.bat для запуска сервера.
pause
