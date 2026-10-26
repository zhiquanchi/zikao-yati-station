#!/usr/bin/env bash
# 本地 PostgreSQL 测试库：起一个一次性容器，导出 TEST_DATABASE_URL 后运行测试。
# 用法：
#   scripts/test-pg.sh                 # 跑 go test ./... 与 bun test
#   scripts/test-pg.sh bun test        # 只跑指定命令
# 可用 PG_TEST_PORT / PG_TEST_NAME 覆盖端口与容器名。
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${PG_TEST_NAME:-exam-pg-test}"
PORT="${PG_TEST_PORT:-55432}"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD=exam -e POSTGRES_USER=exam -e POSTGRES_DB=exam_test \
  -p "127.0.0.1:${PORT}:5432" postgres:17-alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U exam -d exam_test >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U exam -d exam_test >/dev/null

export TEST_DATABASE_URL="postgres://exam:exam@127.0.0.1:${PORT}/exam_test?sslmode=disable"
echo "🐘 测试库就绪：$TEST_DATABASE_URL"

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
(cd grade-svc && go test ./...)
bun test