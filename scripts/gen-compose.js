// 生成运行编排：bun scripts/gen-compose.js [--remote|--build] > build/docker-compose.yml
// 只有 api-svc + postgres 两个服务（所有科目共用一个 API 进程）；前端静态由宿主机 nginx 直接托管。
// 环境变量默认值是部署契约；策略判断与校验在 Go（internal/auth、cmd/apivc）。
import { loadSubjects } from "./config.js";

const mode = process.argv[2] || "--remote";
if (mode !== "--remote" && mode !== "--build") {
  console.error("用法：bun scripts/gen-compose.js --remote | --build");
  process.exit(1);
}
const subs = loadSubjects();
if (!subs.length) {
  console.error("subjects/ 下没有科目");
  process.exit(1);
}

const lines = [];
lines.push("# 由 scripts/gen-compose.js 生成，请勿手改");
lines.push("name: exam-sites");
lines.push("services:");
lines.push("  postgres:");
lines.push("    image: postgres:17-alpine");
lines.push("    restart: unless-stopped");
lines.push("    environment:");
lines.push("      POSTGRES_DB: ${POSTGRES_DB:-exam}");
lines.push("      POSTGRES_USER: ${POSTGRES_USER:-exam}");
lines.push("      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?请在 .env 配置 POSTGRES_PASSWORD}");
lines.push("    volumes:");
lines.push("      - pgdata:/var/lib/postgresql/data");
lines.push("    healthcheck:");
lines.push('      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]');
lines.push("      interval: 5s");
lines.push("      timeout: 3s");
lines.push("      retries: 10");
lines.push("");
lines.push("  api-svc:");
if (mode === "--remote") lines.push("    image: exam-api:latest");
else lines.push("    build:\n      context: .\n      dockerfile: backend/grade-svc/Dockerfile.api");
lines.push("    restart: unless-stopped");
lines.push("    depends_on:");
lines.push("      postgres:");
lines.push("        condition: service_healthy");
lines.push("    ports:");
lines.push('      - "127.0.0.1:8793:8793" # 仅回环：宿主机 nginx 反代 /api/');
lines.push("    volumes:");
lines.push("      - ./subjects:/app/subjects:ro");
lines.push("    environment:");
lines.push("      DATABASE_URL: postgres://${POSTGRES_USER:-exam}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-exam}?sslmode=disable");
lines.push("      SUBJECTS_DIR: /app/subjects");
lines.push("      QWEN_API_KEY: ${QWEN_API_KEY:-}");
lines.push("      QWEN_MODEL: ${QWEN_MODEL:-qwen3.8-flash}");
lines.push("      QWEN_BASE_URL: ${QWEN_BASE_URL:-}");
lines.push("      REGISTRATION_OPEN: ${REGISTRATION_OPEN:-1}");
lines.push("      MAX_USERS: ${MAX_USERS:-0}");
lines.push("      SESSION_TTL: ${SESSION_TTL:-720h}");
lines.push("      COOKIE_SECURE: ${COOKIE_SECURE:-auto}");
lines.push("      COOKIE_DOMAIN: ${COOKIE_DOMAIN:-}");
lines.push("      PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:-}");
lines.push("      REQUIRE_EMAIL_VERIFY: ${REQUIRE_EMAIL_VERIFY:-0}");
lines.push("      INTERNAL_TOKEN: ${INTERNAL_TOKEN:-}");
lines.push("      GRADE_HOURLY_LIMIT: ${GRADE_HOURLY_LIMIT:-0}");
lines.push("      MAIL_DRIVER: ${MAIL_DRIVER:-none}");
lines.push("      ALIYUN_ACCESS_KEY_ID: ${ALIYUN_ACCESS_KEY_ID:-}");
lines.push("      ALIYUN_ACCESS_KEY_SECRET: ${ALIYUN_ACCESS_KEY_SECRET:-}");
lines.push("      ALIYUN_DM_ACCOUNT_NAME: ${ALIYUN_DM_ACCOUNT_NAME:-}");
lines.push("      ALIYUN_DM_FROM_ALIAS: ${ALIYUN_DM_FROM_ALIAS:-自考押题站}");
lines.push("      ALIYUN_DM_ENDPOINT: ${ALIYUN_DM_ENDPOINT:-dm.aliyuncs.com}");
lines.push("      ALIYUN_DM_REGION: ${ALIYUN_DM_REGION:-}");
lines.push("");
lines.push("volumes:");
lines.push("  pgdata: # PostgreSQL 数据卷（v1 旧表由 apivc -migrate-v1 一次性迁移后删除）");
console.log(lines.join("\n"));