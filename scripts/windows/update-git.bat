@echo off
chcp 65001 >nul
REM Обновление кода через git pull + переустановка зависимостей (на
REM случай, если requirements.txt изменился). Требует, чтобы папка
REM проекта была git-репозиторием с настроенным remote — см.
REM Docs/DEPLOYMENT_WINDOWS.md, раздел "Обновление — вариант А (git)".
REM
REM Данные (data\, Input\, uploads\) НЕ в git (см. .gitignore) — git pull
REM их не трогает. Перед обновлением всё равно делаем резервную копию
REM базы — дополнительная страховка, не заменяет git.

cd /d "%~dp0..\.."

if not exist ".git" (
    echo [ОШИБКА] Это не git-репозиторий. Либо настройте git ^(см. Docs/DEPLOYMENT_WINDOWS.md^),
    echo либо обновляйтесь копированием файлов ^(вариант Б в том же документе^).
    pause
    exit /b 1
)

echo Резервная копия базы данных...
if exist "data\zhbi.db" (
    if not exist "data\backups" mkdir "data\backups"
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup.ps1"
)

echo.
echo Загружаю обновления...
git pull
if errorlevel 1 (
    echo [ОШИБКА] git pull не завершился успешно — см. текст выше ^(конфликты и т.п.^).
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat
echo Обновляю зависимости...
pip install -r requirements.txt

echo.
echo Готово. Запустите run.bat.
pause
