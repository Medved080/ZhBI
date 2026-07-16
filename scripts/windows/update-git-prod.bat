@echo off
chcp 65001 >nul
REM Обновление ПРОДУКТОВОЙ установки — до конкретного релиза (тега), а
REM НЕ до последних изменений в разработке (для этого — update-git-test.bat
REM на тестовой установке). См. Docs/DEPLOYMENT_WINDOWS.md, раздел
REM "Тестовая и продуктовая установки".
REM
REM После выполнения репозиторий окажется в состоянии "detached HEAD" —
REM это нормально и ожидаемо для продуктовой установки: она закреплена
REM за конкретной проверенной версией, а не "едет" вместе с main.

cd /d "%~dp0..\.."

if not exist ".git" (
    echo [ОШИБКА] Это не git-репозиторий. Настройте git — см. Docs/DEPLOYMENT_WINDOWS.md.
    pause
    exit /b 1
)

echo Резервная копия базы данных...
if exist "data\zhbi.db" (
    if not exist "data\backups" mkdir "data\backups"
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup.ps1"
)

echo.
echo Загружаю список релизов...
git fetch --tags
if errorlevel 1 (
    echo [ОШИБКА] git fetch не завершился успешно — проверьте подключение к сети.
    pause
    exit /b 1
)

echo.
echo Доступные релизы (новые сверху):
git tag --sort=-creatordate
echo.

set RELEASE=
set /p RELEASE="Введите тег релиза для установки (точно как в списке выше): "
if "%RELEASE%"=="" (
    echo Ничего не введено, отмена.
    pause
    exit /b 1
)

git checkout "%RELEASE%"
if errorlevel 1 (
    echo [ОШИБКА] Не удалось переключиться на "%RELEASE%" — проверьте, что тег введён точно как в списке выше.
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat
echo Обновляю зависимости...
pip install -r requirements.txt

echo.
echo Продуктовая установка обновлена до релиза %RELEASE%. Запустите run.bat.
pause
