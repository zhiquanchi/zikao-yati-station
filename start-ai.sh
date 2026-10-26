#!/usr/bin/env bash
# 一键启动本地 AI 判分链路：Go 判分服务（后台）+ Bun 静态站（前台），Ctrl+C 一并退出。
# 用法：先 export QWEN_API_KEY=sk-xxx（平台控制台创建），再 ./start-ai.sh <科目目录名>
# 例：./start-ai.sh os13180   ·   ./start-ai.sh net04751
set -euo pipefail
cd "$(dirname "$0")"
: "${QWEN_API_KEY:?请先 export QWEN_API_KEY=sk-xxx（在平台控制台创建 API Key）}"

SUBJ="${1:?用法: ./start-ai.sh <科目目录名>（如 os13180 / net04751）}"
# 端口与科目名读自 subject.json（唯一身份源），不在脚本里写死
read -r SUBJECT_NAME WEB_PORT GRADE_PORT < <(bun -e '
  const { findSubject } = await import("./scripts/config.js");
  const s = findSubject(process.argv[1]);
  console.log(s.name, s.ports.web, s.ports.grade);
' "$SUBJ")

GRADE_PORT="${GRADE_PORT_OVERRIDE:-$GRADE_PORT}"
(cd backend/grade-svc && go build -o "/tmp/grade-svc-$SUBJ" .)
SUBJECT_DIR="$PWD/subjects/$SUBJ" QWEN_MODEL="${QWEN_MODEL:-qwen3.8-flash}" GRADE_PORT="$GRADE_PORT" \
  "/tmp/grade-svc-$SUBJ" > "/tmp/grade-svc-$SUBJ.log" 2>&1 &
SVC=$!
trap 'kill "$SVC" 2>/dev/null || true' EXIT INT TERM

echo "⏳ 启动 AI 判分服务（127.0.0.1:$GRADE_PORT，model=${QWEN_MODEL:-qwen3.8-flash}，科目 $SUBJECT_NAME）…"
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${GRADE_PORT}/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -sf "http://127.0.0.1:${GRADE_PORT}/api/health" >/dev/null 2>&1; then
  echo "❌ 判分服务未就绪，日志：/tmp/grade-svc-$SUBJ.log"; exit 1
fi
echo "🚀 启动练习站：http://127.0.0.1:${PORT:-$WEB_PORT}/ （简答题将升级为 AI 判分）"
# server.js 的判分代理默认指向线上（本机不常驻判分服务的部署约定）；
# 这里显式覆盖为脚本刚拉起的本地 Go 服务，本地联调走的才是本地判分
GRADE_API="http://127.0.0.1:${GRADE_PORT}/api/grade" bun server.js "$SUBJ"
