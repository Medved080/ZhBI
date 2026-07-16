# Резервная копия базы данных ЖБИ (data\zhbi.db) с меткой даты/времени
# в имени файла. Вызывается через backup.bat (двойной клик) — не
# запускайте этот .ps1 напрямую, если не уверены в политике выполнения
# PowerShell на этом компьютере.

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dbPath = Join-Path $root "data\zhbi.db"
$backupDir = Join-Path $root "data\backups"

if (-not (Test-Path $dbPath)) {
    Write-Host "[ОШИБКА] Не найден data\zhbi.db — сервер ни разу не запускался?"
    exit 1
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$dest = Join-Path $backupDir "zhbi_$stamp.db"
Copy-Item $dbPath $dest

Write-Host "Резервная копия сохранена:"
Write-Host "  $dest"
