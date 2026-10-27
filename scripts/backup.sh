#!/usr/bin/env bash
# 每日 PostgreSQL 备份（服务器上由 exam-backup.timer 调用）。
# 产物：/opt/exam-sites/backups/daily-YYYYmmdd-HHMMSS.dump（pg_dump -Fc，自带压缩）
# 保留 30 天；权限 600。恢复：pg_restore -d <db> <file>
set -euo pipefail
cd "${REMOTE_DIR:-/opt/exam-sites}"
mkdir -p backups
TS=$(date +%Y%m%d-%H%M%S)
OUT="backups/daily-$TS.dump"
docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' </dev/null > "$OUT"
chmod 600 "$OUT"
# 保留最近 30 天
find backups -maxdepth 1 -name 'daily-*.dump' -type f -mtime +30 -delete
echo "备份完成：$OUT ($(du -h "$OUT" | cut -f1))"