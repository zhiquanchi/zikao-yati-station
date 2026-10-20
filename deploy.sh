#!/usr/bin/env bash
# 一键发布：按 subjects/ 科目清单自动完成——重建题库与门户清单 → 暂存各科目前端产物 →
# 本机交叉构建 amd64 镜像（门户 + 云同步 sync-svc + 每科目判分服务）→ docker save 管道上传 → 服务器 docker load + compose up → nginx 循环生成 → 探活。
# 新增科目零改本脚本：进 subjects/ 后重新发布即自动纳入（前缀 location、判分服务、编排、门户切换器全循环生成）。
# 服务器无需源码；可重复执行（幂等）。用法：./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

SSH_HOST="${SSH_HOST:-<SSH_HOST见本地.deploy.env>}"
REMOTE_DIR="${REMOTE_DIR:-/opt/exam-sites}"

# —— 0. 科目清单（唯一事实源 subjects/<科目>/subject.json，slug + 前缀 + 主科目）——
read -r -a SLUGS <<<"$(bun -e 'import {loadSubjects} from "./scripts/config.js"; console.log(loadSubjects().map(s=>s.slug).join(" "))')"
read -r -a PREFIXES <<<"$(bun -e 'import {loadSubjects} from "./scripts/config.js"; console.log(loadSubjects().map(s=>s.prefix).join(" "))')"
PRIMARY=$(bun -e 'import {loadSubjects} from "./scripts/config.js"; const s=loadSubjects().find(x=>x.primary)||loadSubjects()[0]; console.log(s.prefix)')
[ "${#SLUGS[@]}" -ge 1 ] || { echo "❌ subjects/ 下没有科目"; exit 1; }
echo "📚 科目：${SLUGS[*]}（前缀 ${PREFIXES[*]}，主科目 /${PRIMARY}/）"

# —— 1. 探测免密 SSH（known_hosts 指纹在 6000 与 22 都留过）——
SSH_PORT=""
for P in 6000 22; do
  if ssh -p "$P" -o BatchMode=yes -o ConnectTimeout=6 "$SSH_HOST" true 2>/dev/null; then SSH_PORT="$P"; break; fi
done
[ -n "$SSH_PORT" ] || { echo "❌ $SSH_HOST 免密不可达（已试 6000/22），请检查公钥授权后重试"; exit 1; }
echo "🔌 SSH 就绪：$SSH_HOST:$SSH_PORT"

S() { ssh -p "$SSH_PORT" -o BatchMode=yes "$SSH_HOST" "$@"; }

# —— 2. 服务器前置：Docker 与目录（一次性）——
if ! S "command -v docker >/dev/null 2>&1"; then
  echo "🐳 服务器未装 Docker，开始安装（官方 apt 源 + 阿里云镜像加速）…"
  S "curl -fsSL https://get.docker.com | sudo sh -s -- --mirror Aliyun" || S "curl -fsSL https://get.docker.com | sh"
  S "systemctl enable --now docker"
fi
if ! S "docker compose version >/dev/null 2>&1"; then
  echo "🧩 服务器缺 docker compose 插件（Ubuntu docker.io 不含），安装 docker-compose-v2…"
  # 服务器上有历史第三方源可能签名过期，容忍 update 局部失败，索引已在即可装包
  S "DEBIAN_FRONTEND=noninteractive apt-get update -y || true; DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2" || { echo "❌ compose 插件安装失败"; exit 1; }
fi

# —— 3. 重建题库与派生清单，暂存各科目前端产物（build/stage/<prefix>/）——
bun run build
bun run stage

# —— 4. 本机交叉构建 linux/amd64 镜像（门户 + 云同步各 1 个 + 每科目判分 1 个，均取仓库根为上下文）——
echo "🔨 构建 exam-portal、exam-sync 与 exam-grade-<科目>（linux/amd64）…"
docker build --platform linux/amd64 -t exam-portal:latest -f portal/Dockerfile .
docker build --platform linux/amd64 -t exam-sync:latest -f grade-svc/Dockerfile.sync .
SAVE_IMAGES=(exam-portal:latest exam-sync:latest)
for i in "${!SLUGS[@]}"; do
  docker build --platform linux/amd64 -f grade-svc/Dockerfile --build-arg SUBJECT="${SLUGS[$i]}" -t "exam-grade-${PREFIXES[$i]}:latest" .
  SAVE_IMAGES+=("exam-grade-${PREFIXES[$i]}:latest")
done

# —— 5. 管道上传（gzip -1 提速；无 registry 依赖）——
echo "📤 上传镜像（docker save | ssh | docker load）…"
docker save "${SAVE_IMAGES[@]}" |
  gzip -1 |
  ssh -p "$SSH_PORT" -o BatchMode=yes "$SSH_HOST" "gunzip | docker load"

# —— 6. 同步运行编排与 env，启动（compose 按科目清单生成，勿手改）——
bun scripts/gen-compose.js --remote > build/docker-compose.yml
rsync -e "ssh -p $SSH_PORT -o BatchMode=yes" build/docker-compose.yml portal/.env.example "$SSH_HOST:$REMOTE_DIR/"
S "[ -f $REMOTE_DIR/.env ] || cp $REMOTE_DIR/.env.example $REMOTE_DIR/.env"
S "cd $REMOTE_DIR && docker compose up -d"

IP="${SSH_HOST#*@}"

# —— 7. 宿主 nginx 转发（服务器 80 已由 nginx 占着欢迎页）：
#     按 Host=IP 命中 portal 站点，各科目前缀转回环 8799，其余 Host 不受影响；
#     超时统一 120s：AI 判分两级上游链路 Go 侧预算 85s，须大于门户代理的 95s ——
if S "command -v nginx >/dev/null 2>&1"; then
  echo "🧭 配置 nginx：Host=$IP 的 /${PREFIXES[*]} → 127.0.0.1:8799"
  TMP=$(mktemp)
  cat > "$TMP" <<EOF
# 押题门户（exam-sites）：IP 直访进各科目站，由 deploy.sh 维护，勿手改
server {
    listen 80;
    server_name $IP;

    location = / { return 302 /$PRIMARY/; }
EOF
  for pre in "${PREFIXES[@]}"; do
    cat >> "$TMP" <<EOF
    location /$pre/ { proxy_pass http://127.0.0.1:8799; proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_read_timeout 120s; proxy_send_timeout 120s; }
EOF
  done
  cat >> "$TMP" <<EOF
}
EOF
  S "cat > /etc/nginx/sites-available/exam-portal" < "$TMP"
  rm -f "$TMP"
  S "ln -sf /etc/nginx/sites-available/exam-portal /etc/nginx/sites-enabled/exam-portal"
  if S "nginx -t"; then S "systemctl reload nginx"; else echo "❌ nginx 配置校验失败，已保留原状（未 reload）"; exit 1; fi
else
  echo "ℹ 服务器无 nginx：改直挂 80 需先释放端口（当前编排绑 127.0.0.1:8799）"
fi

# —— 8. 探活：逐科目前缀（静态 + 云同步链路：旧版兼容槽可读、Go 端拒收非法码）——
for pre in "${PREFIXES[@]}"; do
  curl -fsS -o /dev/null -w "本机外网探活 /$pre/ → HTTP %{http_code}\n" --max-time 15 "http://$IP/$pre/" || \
    echo "⚠ 本机访问 /$pre/ 失败：服务器上先自查 curl -H 'Host: $IP' http://127.0.0.1/$pre/ ；通则到阿里云控制台放行安全组 80"
  SYNC_JSON=$(curl -fsS --max-time 15 "http://$IP/$pre/api/store" || true)
  case "$SYNC_JSON" in
    *'"blob"'*) echo "☁️ /$pre/api/store 云同步（sync-svc）OK" ;;
    *) echo "❌ /$pre/api/store 云同步异常（查 sync-svc 容器与 portal 转发）"; exit 1 ;;
  esac
  BAD_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "http://$IP/$pre/api/store/ABCD")
  [ "$BAD_CODE" = "400" ] || { echo "❌ /$pre 非法同步码应 400，实得 $BAD_CODE（Go 校验或转发链路不对）"; exit 1; }
done
echo "✅ 发布完成：http://$IP/${PREFIXES[0]}/ …（共 ${#PREFIXES[@]} 科）"
