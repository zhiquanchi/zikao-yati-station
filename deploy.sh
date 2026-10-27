#!/usr/bin/env bash
# 一键发布（前后端解耦后的单服务形态）：
#   1) 构建题库 + 单份前端静态（build/web）
#   2) 交叉构建 exam-api:<git短SHA> 并打 latest → 管道上传 load
#   3) rsync 前端静态（科目与题库随镜像发布）
#   4) 生成 compose 起 api-svc + postgres；迁移前强制 pg_dump 快照
#   5) 执行 v1→v2 数据迁移（幂等；无旧表则跳过）
#   6) 宿主机 nginx：/<prefix>/ → 静态，/api/ → 127.0.0.1:8793（原子切换）
#   7) 安装每日备份 timer、清理旧镜像与旧目录、逐科目探活
# 服务器无需源码；可重复执行（幂等）。用法：./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .deploy.env ]; then set -a; . ./.deploy.env; set +a; fi
SSH_HOST="${SSH_HOST:?未配置 SSH_HOST：请在仓库根 .deploy.env（未跟踪）写入 SSH_HOST=<user@host>，或以环境变量传入}"
REMOTE_DIR="${REMOTE_DIR:-/opt/exam-sites}"
IP="${SSH_HOST#*@}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
STAMP=$(date +%Y%m%d-%H%M%S)

read -r -a PREFIXES <<<"$(bun -e 'import {loadSubjects} from "./scripts/config.js"; console.log(loadSubjects().map(s=>s.prefix).join(" "))')"
PRIMARY=$(bun -e 'import {loadSubjects} from "./scripts/config.js"; const s=loadSubjects().find(x=>x.primary)||loadSubjects()[0]; console.log(s.prefix)')
[ "${#PREFIXES[@]}" -ge 1 ] || { echo "❌ subjects/ 下没有科目"; exit 1; }
echo "📚 科目前缀：${PREFIXES[*]}（主科目 /${PRIMARY}/，镜像 tag $TAG）"

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

# —— 2. 单 API 镜像（tag + latest） ——
echo "🔨 构建 exam-api:$TAG（linux/amd64）…"
docker build --platform linux/amd64 -t "exam-api:$TAG" -f backend/grade-svc/Dockerfile.api .
docker tag "exam-api:$TAG" exam-api:latest
echo "📤 上传镜像…"
docker save "exam-api:$TAG" exam-api:latest | gzip -1 | ssh -p "$SSH_PORT" -o BatchMode=yes "$SSH_HOST" "gunzip | docker load"

# —— 3. 静态 ——
S "mkdir -p $REMOTE_DIR/web $REMOTE_DIR/backups"
R -a --delete build/web/ "$SSH_HOST:$REMOTE_DIR/web/"
# 科目与题库随 exam-api 镜像发布（服务器 Docker 为 snap 版，不允许 bind mount 宿主目录）

# —— 4. 编排、备份旧配置、启动 ——
bun scripts/gen-compose.js --remote > build/docker-compose.yml
S "cd $REMOTE_DIR && [ ! -f docker-compose.yml ] || cp docker-compose.yml backups/docker-compose-$STAMP.yml"
S "[ ! -f /etc/nginx/sites-available/exam-site ] || cp /etc/nginx/sites-available/exam-site /etc/nginx/sites-available/exam-site.bak-$STAMP"
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
S "cd $REMOTE_DIR && { grep -q '^GRADE_HOURLY_LIMIT=' .env || echo 'GRADE_HOURLY_LIMIT=200' >> .env; }"
S "cd $REMOTE_DIR && { grep -q '^MAX_GUESTS=' .env || echo 'MAX_GUESTS=200' >> .env; }"
S "cd $REMOTE_DIR && { grep -q '^ALLOW_LEGACY_IMPORT=' .env || echo 'ALLOW_LEGACY_IMPORT=0' >> .env; }"
S "cd $REMOTE_DIR && chmod 600 .env"
if ! S "cd $REMOTE_DIR && docker compose up -d --remove-orphans --wait --wait-timeout 150"; then
  echo "❌ compose 启动/健康检查失败，输出最近日志："
  S "cd $REMOTE_DIR && docker compose ps; docker compose logs --tail=50 api-svc" || true
  exit 1
fi

# —— 5. 迁移前强制快照 + 迁移 ——
echo "🗄 迁移前数据库快照…"
S "cd $REMOTE_DIR && TS=\$(date +%Y%m%d-%H%M%S) && docker compose exec -T postgres sh -c 'pg_dump -Fc -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' </dev/null > backups/pre-deploy-\$TS.dump && chmod 600 backups/pre-deploy-\$TS.dump && test -s backups/pre-deploy-\$TS.dump && echo \"快照：backups/pre-deploy-\$TS.dump\""
echo "🗃 v1 → v2 数据迁移（幂等；无旧表则跳过）…"
S "cd $REMOTE_DIR && docker compose exec -T api-svc apivc -migrate-v1 -dry-run"
S "cd $REMOTE_DIR && docker compose exec -T api-svc apivc -migrate-v1"

# —— 6. nginx（原子切换） ——
if S "command -v nginx >/dev/null 2>&1"; then
  echo "🧭 配置 nginx：静态 /<prefix>/ 与 /api/ → 127.0.0.1:8793"
  TMP=$(mktemp)
  cat > "$TMP" <<EOF
# 押题站（前后端解耦）：IP 直访进各科目前缀，由 deploy.sh 维护，勿手改
server {
    listen 80;
    server_name $IP;
    server_tokens off;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    location = / { return 302 /$PRIMARY/; }
    location = /favicon.ico { return 204; }

    location /api/ {
        proxy_pass http://127.0.0.1:8793;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Real-IP \$remote_addr;
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
  rm -f "$TMP"
  S "cat /tmp/exam-site.nginx > /etc/nginx/sites-available/exam-site.new && rm -f /tmp/exam-site.nginx"
  # 旧门户站点同名 server_name 会抢占请求（502/404），发布时一并移除
  S "rm -f /etc/nginx/sites-enabled/exam-portal /etc/nginx/sites-enabled/exam-sites 2>/dev/null || true"
  S "cp /etc/nginx/sites-available/exam-site /etc/nginx/sites-available/exam-site.prev 2>/dev/null || true"
  S "mv /etc/nginx/sites-available/exam-site.new /etc/nginx/sites-available/exam-site"
  S "ln -sf /etc/nginx/sites-available/exam-site /etc/nginx/sites-enabled/exam-site"
  if S "nginx -t"; then
    S "systemctl reload nginx"
    sleep 2
  else
    # 校验失败：恢复上一版并重新加载，发布中止
    S "if [ -f /etc/nginx/sites-available/exam-site.prev ]; then mv /etc/nginx/sites-available/exam-site.prev /etc/nginx/sites-available/exam-site; nginx -t && systemctl reload nginx; fi"
    echo "❌ nginx 配置校验失败，已回退旧配置（exam-site.bak-$STAMP）"
    exit 1
  fi
else
  echo "ℹ 服务器无 nginx：请自行把 $REMOTE_DIR/web 挂到静态根并反代 /api/ → 127.0.0.1:8793"
fi

# —— 7. 备份 timer、清理旧资源 ——
R scripts/backup.sh "$SSH_HOST:$REMOTE_DIR/backup.sh"
R ops/exam-backup.service ops/exam-backup.timer "$SSH_HOST:$REMOTE_DIR/"
S "chmod +x $REMOTE_DIR/backup.sh"
if S "cp $REMOTE_DIR/exam-backup.service $REMOTE_DIR/exam-backup.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now exam-backup.timer"; then
  echo "🗓 已启用每日备份 timer（03:30，保留 30 天）"
else
  echo "⚠ 备份 timer 安装失败（可手动执行 $REMOTE_DIR/backup.sh）"
fi
S "rm -rf $REMOTE_DIR/subjects"
S "docker image prune -f >/dev/null 2>&1 || true"
S "docker rmi exam-portal:latest exam-sync:latest exam-grade-os:latest exam-grade-net:latest 2>/dev/null || true"
S "docker images --format '{{.Tag}}' exam-api | grep -v '^latest$' | sort -r | tail -n +6 | xargs -r -I{} docker rmi exam-api:{} 2>/dev/null || true"

# —— 8. 探活 ——
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "http://$IP/api/v1/health" || true)
[ "$HEALTH" = "200" ] || { echo "❌ /api/v1/health 应为 200，实得 ${HEALTH:-无响应}"; exit 1; }
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
echo "🔐 API 与静态均已生效（/api/v1/health 200、未登录 me 401）"
echo "✅ 发布完成：http://$IP/${PREFIXES[0]}/ …（共 ${#PREFIXES[@]} 科，镜像 $TAG；回滚：./rollback.sh <上一tag>）"