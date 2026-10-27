#!/usr/bin/env bash
# 回滚到指定的 exam-api 镜像 tag，并可选恢复 compose / nginx 备份。
# 用法：./rollback.sh <image-tag> [compose-backup.yml] [nginx-backup]
# 不带参数时列出远端可用 tag 与备份文件。
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .deploy.env ]; then set -a; . ./.deploy.env; set +a; fi
SSH_HOST="${SSH_HOST:?未配置 SSH_HOST：请在 .deploy.env 写入 SSH_HOST=<user@host>}"
REMOTE_DIR="${REMOTE_DIR:-/opt/exam-sites}"
IP="${SSH_HOST#*@}"

SSH_PORT=""
for P in 6000 22; do
  if ssh -p "$P" -o BatchMode=yes -o ConnectTimeout=6 "$SSH_HOST" true 2>/dev/null; then SSH_PORT="$P"; break; fi
done
[ -n "$SSH_PORT" ] || { echo "❌ $SSH_HOST 免密不可达"; exit 1; }
S() { ssh -p "$SSH_PORT" -o BatchMode=yes "$SSH_HOST" "bash -s" <<<"$*"; }

if [ "$#" -lt 1 ]; then
  echo "可用镜像 tag："
  S "docker images --format '{{.Tag}} {{.CreatedSince}}' exam-api | head -10"
  echo "可用备份："
  S "ls -1t $REMOTE_DIR/backups 2>/dev/null | head -10"
  echo "用法：./rollback.sh <tag> [compose-backup] [nginx-backup]"
  exit 0
fi
TAG="$1"
COMPOSE_BAK="${2:-}"
NGINX_BAK="${3:-}"

S "docker image inspect exam-api:$TAG >/dev/null 2>&1" || { echo "❌ 远端没有 exam-api:$TAG"; exit 1; }
S "cd $REMOTE_DIR && cp docker-compose.yml backups/docker-compose-before-rollback-\$(date +%Y%m%d-%H%M%S).yml 2>/dev/null || true"
S "cd $REMOTE_DIR && sed -i 's#image: exam-api:.*#image: exam-api:$TAG#' docker-compose.yml"
if [ -n "$COMPOSE_BAK" ]; then
  S "cd $REMOTE_DIR && test -f '$COMPOSE_BAK' && cp '$COMPOSE_BAK' docker-compose.yml && sed -i 's#image: exam-api:.*#image: exam-api:$TAG#' docker-compose.yml"
fi
S "cd $REMOTE_DIR && docker compose up -d --remove-orphans --wait --wait-timeout 120"

if [ -n "$NGINX_BAK" ]; then
  S "[ -f '$NGINX_BAK' ] && cp '$NGINX_BAK' /etc/nginx/sites-available/exam-site && nginx -t && systemctl reload nginx"
fi

PAGE=$(curl -fsS --max-time 15 "http://$IP/os/" || true)
if printf '%s' "$PAGE" | grep -q 'api.js'; then
  echo "✅ 已回滚到 exam-api:$TAG，站点正常"
else
  echo "⚠ 回滚后页面校验失败，请检查 docker compose logs 与 nginx"
  exit 1
fi