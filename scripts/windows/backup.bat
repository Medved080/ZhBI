@echo off
chcp 65001 >nul
REM Резервная копия базы данных перед обновлением или просто "на всякий
REM случай" — двойной клик, копия появится в data\backups\.
REM Флаг -ExecutionPolicy Bypass действует только для этого запуска, не
REM меняет системную политику PowerShell на компьютере.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup.ps1"
pause
