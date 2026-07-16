@echo off
chcp 65001 >nul
REM Обновление ТЕСТОВОЙ установки — всегда до последних изменений в
REM ветке main (git pull) + переустановка зависимостей (на случай, если
REM requirements.txt изменился). Для ПРОДУКТОВОЙ установки используйте
REM update-git-prod.bat (конкретный релиз, не "последнее что есть") —
REM см. Docs/DEPLOYMENT_WINDOWS.md, раздел "Тестовая и продуктовая
REM установки".
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
