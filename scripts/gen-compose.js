// 按科目清单生成 docker-compose（compose 无循环语法，派生文件由本脚本保证与 subjects/ 同步）：
//   bun scripts/gen-compose.js --remote   → 线上编排（镜像已由 deploy.sh 预载，引用不 build），rsync 到服务器 /opt/exam-sites
//   bun scripts/gen-compose.js --build    → 本机全栈联调（portal + sync-svc + 每科目判分服务现场构建，上下文=仓库根）
// 判分服务容器内统一 8792、云同步服务 8793，均有意不映射宿主端口：密钥与存储只在编排内部网络可达，仅门户容器访问。
import { loadSubjects } from "./config.js";

const mode = process.argv[2];
if (mode !== "--remote" && mode !== "--build") {
  console.error("用法：bun scripts/gen-compose.js --remote | --build");
  process.exit(1);
}
const subs = loadSubjects().sort((a, b) => ((a.ports && a.ports.web) || 0) - ((b.ports && b.ports.web) || 0));
const up = (p) => p.toUpperCase();

const lines = [];
lines.push("# 由 scripts/gen-compose.js 按 subjects/ 科目清单生成，请勿手改（加科目重新生成本文件）");
lines.push("# 服务器运行：镜像由本机 deploy.sh 预载；本机联调：先 bun run build && bun run stage");
if (mode === "--remote") lines.push("# 访问：http://<服务器IP>/os/ 与 /net/ 等多科目；停止：docker compose down");
lines.push("name: exam-sites");
lines.push("services:");
lines.push("  portal:");
if (mode === "--remote") lines.push("    image: exam-portal:latest");
else lines.push("    build:\n      context: .\n      dockerfile: portal/Dockerfile");
lines.push('    ports:\n      - "127.0.0.1:8799:80" # 宿主 80 由 nginx 占用：门户绑回环 8799，nginx 按 Host=IP 转发各科目前缀');
lines.push("    environment:");
for (const s of subs) lines.push(`      GRADE_${up(s.prefix)}: http://grade-svc-${s.prefix}:8792/api/grade`);
lines.push("      SYNC_API: http://sync-svc:8793 # api/store 云同步转发上游（Go 服务，多用户槽位）");
lines.push("    depends_on:");
lines.push("      - sync-svc");
for (const s of subs) lines.push(`      - grade-svc-${s.prefix}`);
lines.push("    restart: unless-stopped");
// PostgreSQL：云同步与账号数据的唯一存储。仅编排内部网络可达，不映射宿主端口。
// 密码由 deploy.sh 首次生成并写入远端 .env；缺省库名/用户为 exam。
lines.push("  postgres:");
lines.push("    image: postgres:17-alpine");
lines.push("    environment:");
lines.push("      POSTGRES_DB: ${POSTGRES_DB:-exam}");
lines.push("      POSTGRES_USER: ${POSTGRES_USER:-exam}");
lines.push("      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?请在 .env 配置 POSTGRES_PASSWORD}");
lines.push('    volumes:\n      - pgdata:/var/lib/postgresql/data');
lines.push("    healthcheck:");
lines.push('      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]');
lines.push("      interval: 5s");
lines.push("      timeout: 3s");
lines.push("      retries: 10");
lines.push("    # 有意不做端口映射：数据库只在编排内部网络可达");
lines.push("    restart: unless-stopped");
lines.push("  sync-svc:");
if (mode === "--remote") lines.push("    image: exam-sync:latest");
else lines.push("    build:\n      context: .\n      dockerfile: grade-svc/Dockerfile.sync");
lines.push("    environment:");
lines.push("      DATABASE_URL: postgres://${POSTGRES_USER:-exam}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-exam}?sslmode=disable");
lines.push("      REGISTRATION_OPEN: ${REGISTRATION_OPEN:-1}");
lines.push("      MAX_USERS: ${MAX_USERS:-0}");
lines.push("      SESSION_TTL: ${SESSION_TTL:-720h}");
lines.push("      COOKIE_SECURE: ${COOKIE_SECURE:-auto}");
lines.push("      COOKIE_DOMAIN: ${COOKIE_DOMAIN:-}");
lines.push("      PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:-}");
lines.push("      INTERNAL_TOKEN: ${INTERNAL_TOKEN:-}");
lines.push("      MAIL_DRIVER: ${MAIL_DRIVER:-none}");
lines.push("      ALIYUN_ACCESS_KEY_ID: ${ALIYUN_ACCESS_KEY_ID:-}");
lines.push("      ALIYUN_ACCESS_KEY_SECRET: ${ALIYUN_ACCESS_KEY_SECRET:-}");
lines.push("      ALIYUN_DM_ACCOUNT_NAME: ${ALIYUN_DM_ACCOUNT_NAME:-}");
lines.push("      ALIYUN_DM_FROM_ALIAS: ${ALIYUN_DM_FROM_ALIAS:-自考押题站}");
lines.push("      ALIYUN_DM_ENDPOINT: ${ALIYUN_DM_ENDPOINT:-dm.aliyuncs.com}");
lines.push("      ALIYUN_DM_REGION: ${ALIYUN_DM_REGION:-}");
lines.push("      REQUIRE_EMAIL_VERIFY: ${REQUIRE_EMAIL_VERIFY:-0}");
lines.push("    depends_on:");
lines.push("      postgres:");
lines.push("        condition: service_healthy");
lines.push("    # 有意不做端口映射：进度存储只在编排内部网络可达，仅门户容器访问");
lines.push("    restart: unless-stopped");
for (const s of subs) {
  lines.push(`  grade-svc-${s.prefix}:`);
  if (mode === "--remote") lines.push(`    image: exam-grade-${s.prefix}:latest`);
  else lines.push(`    build:\n      context: .\n      dockerfile: grade-svc/Dockerfile\n      args:\n        SUBJECT: ${s.slug}`);
  lines.push("    environment:\n      QWEN_API_KEY: ${QWEN_API_KEY:-}\n      QWEN_MODEL: ${QWEN_MODEL:-qwen3.8-flash}\n      AUTH_VERIFY_URL: http://sync-svc:8793/internal/session\n      INTERNAL_TOKEN: ${INTERNAL_TOKEN:-}\n      GRADE_HOURLY_LIMIT: ${GRADE_HOURLY_LIMIT:-0}");
  lines.push("    depends_on:\n      - sync-svc");
  lines.push("    # 有意不做端口映射：密钥与判分服务只存在于编排内部网络，只有门户容器可达");
  lines.push("    restart: unless-stopped");
}
lines.push("volumes:\n  pgdata: # PostgreSQL 数据卷（旧 portal-store SQLite 卷保留在宿主机，供导出/回滚，不再由 compose 管理）");
console.log(lines.join("\n"));
