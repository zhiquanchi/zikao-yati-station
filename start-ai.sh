#!/usr/bin/env bash
# 本地 AI 联调：Go 单服务（判分/进度/账号）+ 前端静态站，Ctrl+C 一并退出。
# 用法：export QWEN_API_KEY=sk-xxx
#       export DATABASE_URL='postgres://exam:exam@127.0.0.1:55432/exam?sslmode=disable'
#       ./start-ai.sh
# 没有现成库时可用 scripts/test-pg.sh 起一个临时 PostgreSQL。
set -euo pipefail
cd "$(dirname "$0")"
: "${QWEN_API_KEY:?请先 export QWEN_API_KEY=sk-xxx}"
: "${DATABASE_URL:?请先 export DATABASE_URL（PostgreSQL DSN），或用 scripts/test-pg.sh 起临时库}"
API_PORT="${API_PORT:-8793}"

bun run build >/dev/null
bun run stage >/dev/null

(cd backend/grade-svc && go build -o /tmp/apivc ./cmd/apivc)
DATABASE_URL="$DATABASE_URL" SUBJECTS_DIR="$PWD/subjects" API_PORT="$API_PORT" \
  QWEN_MODEL="${QWEN_MODEL:-qwen3.8-flash}" /tmp/apivc > /tmp/apivc.log 2>&1 &
SVC=$!
trap 'kill "$SVC" 2>/dev/null || true' EXIT INT TERM

echo "⏳ 启动 API 服务（127.0.0.1:$API_PORT）…"
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${API_PORT}/api/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:${API_PORT}/api/v1/health" >/dev/null 2>&1 || { echo "❌ API 未就绪，日志：/tmp/apivc.log"; exit 1; }

echo "🚀 启动练习站：http://127.0.0.1:${PORT:-8791}/${PRIMARY_PREFIX:-os}/"
PRIMARY_PREFIX="${PRIMARY_PREFIX:-os}" API_ORIGIN="http://127.0.0.1:${API_PORT}" bun server.js