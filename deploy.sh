#!/usr/bin/env bash
# 一键发布（前后端解耦后的单服务形态）：
#   1) 构建题库 + 单份前端静态（build/web）
#   2) 交叉构建 exam-api 镜像 → 管道上传 load
#   3) rsync 前端静态与科目配置（仅 subject.json/questions.json/mindmap.html/reference.md）
#   4) 生成的 compose 起 api-svc + postgres；执行 v1→v2 一次性数据迁移
#   5) 宿主机 nginx：/<prefix>/ → 静态，/api/ → 127.0.0.1:8793
#   6) 逐科目探活
# 服务器无需源码；可重复执行（幂等）。用法：./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .deploy.env ]; then set -a; . ./.deploy.env; set +a; fi
SSH_HOST="${SSH_HOST:?未配置 SSH_HOST：请在仓库根 .deploy.env（未跟踪）写入 SSH_HOST=<user@host>，或以环境变量传入}"
REMOTE_DIR="${REMOTE_DIR:-/opt/exam-sites}"
IP="${SSH_HOST#*@}"

read -r -a PREFIXES <<<"$(bun -e 'import {loadSubjects} from "./scripts/config.js"; console.log(loadSubjects().map(s=>s.prefix).join(" "))')"
PRIMARY=$(bun -e 'import {loadSubjects} from "./scripts/config.js"; const s=loadSubjects().find(x=>x.primary)||loadSubjects()[0]; console.log(s.prefix)')
[ "${#PREFIXES[@]}" -ge 1 ] || { echo "❌ subjects/ 下没有科目"; exit 1; }
echo "📚 科目前缀：${PREFIXES[*]}（主科目 /${PRIMARY}/）"

SSH_PORT=""
for P in 6000 22; do
  if ssh -p "$P" -o BatchMode=yes -o ConnectTimeout=6 "$SSH_HOST" true 2>/dev/null; then SSH_PORT="$P"; break; fi
done
[ -n "$SSH_PORT" ] || { echo "❌ $SSH_HOST 免密不可达（已试 6000/22）"; exit 1; }
echo "🔌 SSH 就绪：$SSH_HOST:$SSH_PORT"
S() { ssh -p "$SSH_PORT" -o BatchMode=yes "$SSH_HOST" "bash -s" <<<"$*"; }
R() { rsync -e "ssh -p $SSH_PORT -o BatchMode=yes" "$@"; }

# —— 服务器前置 ——
if ! S "command -v docker >/dev/null 2>&1"; then
  echo "🐳 安装 Docker…"
  S "curl -fsSL https://get.docker.com | sudo sh -s -- --mirror Aliyun" || S "curl -fsSL https://get.docker.com | sh"
  S "systemctl enable --now docker"
fi
if ! S "docker compose version >/dev/null 2>&1"; then
  S "DEBIAN_FRONTEND=noninteractive apt-get update -y || true; DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2"
fi

# —— 1. 题库与前端静态 ——
bun run build
bun run stage

# —— 2. 单 API 镜像 ——
echo "🔨 构建 exam-api（linux/amd64）…"
docker build --platform linux/amd64 -t exam-api:latest -f backend/grade-svc/Dockerfile.api .
echo "📤 上传镜像…"
docker save exam-api:latest | gzip -1 | ssh -p "$SSH_PORT" -o BatchMode=yes "$SSH_HOST" "gunzip | docker load"

# —— 3. 静态与科目配置 ——
S "mkdir -p $REMOTE_DIR/web"
R -a --delete build/web/ "$SSH_HOST:$REMOTE_DIR/web/"
# 科目与题库随 exam-api 镜像发布（服务器 Docker 为 snap 版，不允许 bind mount 宿主目录）

# —— 4. 编排与迁移 ——
bun scripts/gen-compose.js --remote > build/docker-compose.yml
R build/docker-compose.yml "$SSH_HOST:$REMOTE_DIR/"
S "[ -f $REMOTE_DIR/.env ] || touch $REMOTE_DIR/.env"
S "cd $REMOTE_DIR && touch .env"
S "cd $REMOTE_DIR && { grep -q '^POSTGRES_DB=' .env || echo 'POSTGRES_DB=exam' >> .env; }"
S "cd $REMOTE_DIR && { grep -q '^POSTGRES_USER=' .env || echo 'POSTGRES_USER=exam' >> .env; }"
S "cd $REMOTE_DIR && { grep -q '^POSTGRES_PASSWORD=' .env || echo \"POSTGRES_PASSWORD=\$(openssl rand -hex 24)\" >> .env; }"
S "cd $REMOTE_DIR && { grep -q '^INTERNAL_TOKEN=' .env || echo \"INTERNAL_TOKEN=\$(openssl rand -hex 24)\" >> .env; }"
S "cd $REMOTE_DIR && { grep -q '^MAIL_DRIVER=' .env || echo 'MAIL_DRIVER=none' >> .env; }"
S "cd $REMOTE_DIR && { grep -q '^PUBLIC_ORIGIN=' .env || echo \"PUBLIC_ORIGIN=http://$IP\" >> .env; }"
S "cd $REMOTE_DIR && { grep -q '^REQUIRE_EMAIL_VERIFY=' .env || echo 'REQUIRE_EMAIL_VERIFY=0' >> .env; }"
S "cd $REMOTE_DIR && chmod 600 .env"
S "cd $REMOTE_DIR && (docker compose up -d --remove-orphans --wait --wait-timeout 120 || { docker compose up -d --remove-orphans; })"
echo "🗃 v1 → v2 数据迁移（幂等；无旧表则跳过）…"
S "cd $REMOTE_DIR && docker compose exec -T api-svc apivc -migrate-v1 -dry-run"
S "cd $REMOTE_DIR && docker compose exec -T api-svc apivc -migrate-v1"

# —— 5. nginx ——
if S "command -v nginx >/dev/null 2>&1"; then
  echo "🧭 配置 nginx：静态 /<prefix>/ 与 /api/ → 127.0.0.1:8793"
  TMP=$(mktemp)
  cat > "$TMP" <<EOF
# 押题站（前后端解耦）：IP 直访进各科目前缀，由 deploy.sh 维护，勿手改
server {
    listen 80;
    server_name $IP;

    location = / { return 302 /$PRIMARY/; }

    location /api/ {
        proxy_pass http://127.0.0.1:8793;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Prefix /;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        proxy_buffering off;
    }
EOF
  for pre in "${PREFIXES[@]}"; do
    cat >> "$TMP" <<EOF

    location /$pre/ {
        alias $REMOTE_DIR/web/;
        index index.html;
        try_files \$uri \$uri/ /$pre/index.html;
    }
EOF
  done
  cat >> "$TMP" <<EOF
}
EOF
  R "$TMP" "$SSH_HOST:/tmp/exam-site.nginx"
  S "cat /tmp/exam-site.nginx > /etc/nginx/sites-available/exam-site && rm -f /tmp/exam-site.nginx"
  rm -f "$TMP"
  # 旧门户站点同名 server_name 会抢占请求（502/404），发布时一并移除
  S "rm -f /etc/nginx/sites-enabled/exam-portal /etc/nginx/sites-enabled/exam-sites 2>/dev/null || true"
  S "ln -sf /etc/nginx/sites-available/exam-site /etc/nginx/sites-enabled/exam-site"
  if S "nginx -t"; then S "systemctl reload nginx"; sleep 2; else echo "❌ nginx 配置校验失败，未 reload"; exit 1; fi
else
  echo "ℹ 服务器无 nginx：请自行把 $REMOTE_DIR/web 挂到静态根并反代 /api/ → 127.0.0.1:8793"
fi

# —— 6. 探活 ——
for pre in "${PREFIXES[@]}"; do
  OK=""
  for _ in 1 2 3 4 5; do
    PAGE=$(curl -fsS --max-time 15 "http://$IP/$pre/" || true)
    if printf '%s' "$PAGE" | grep -q 'api.js'; then OK=1; break; fi
    sleep 2
  done
  if [ -n "$OK" ]; then
    echo "探活 /$pre/ → 应用页面正常"
  else
    echo "❌ /$pre/ 未返回应用页面（nginx 兜底可能落到了默认站点）"; exit 1
  fi
done
SUB_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "http://$IP/api/v1/subjects" || true)
[ "$SUB_CODE" = "200" ] || { echo "❌ /api/v1/subjects 应为 200，实得 ${SUB_CODE:-无响应}"; exit 1; }
ME_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "http://$IP/api/v1/auth/me" || true)
[ "$ME_CODE" = "401" ] || { echo "❌ /api/v1/auth/me 未登录应 401，实得 ${ME_CODE:-无响应}"; exit 1; }
echo "🔐 API 与静态均已生效（/api/v1/auth/me 未登录 401）"
echo "✅ 发布完成：http://$IP/${PREFIXES[0]}/ …（共 ${#PREFIXES[@]} 科）"