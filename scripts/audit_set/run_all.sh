#!/bin/sh
# Полный прогон проверок аудита «настройки/справочники/служебные» на НАСТОЯЩЕМ сервере (scripts/real_auth_server.py).
#   sh scripts/audit_set/run_all.sh <копия БД сервера> <порт>
# Порядок: не разрушающие → разрушающие на копии (удаление зоны — последним).
DB="$1"; PORT="$2"; FAIL=0
for c in check_v1_smoke check_zones3d check_scheme_settings check_appearance check_subtype_replace check_db_status check_address \
         check_report_notes check_admin_guide check_fill_scope check_roles_misc check_zone_delete; do
  echo "=== $c"
  node "scripts/audit_set/$c.mjs" "$DB" "$PORT" 2>&1 | grep -E "^(FAIL|ИТОГО|СБОЙ)" || true
  node -e "process.exit(0)"
done
