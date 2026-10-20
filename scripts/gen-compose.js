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
lines.push("  sync-svc:");
if (mode === "--remote") lines.push("    image: exam-sync:latest");
else lines.push("    build:\n      context: .\n      dockerfile: grade-svc/Dockerfile.sync");
lines.push('    volumes:\n      - portal-store:/data # 云同步 SQLite 落盘：卷沿用旧名（旧版 sync.db 原地复用，Go 启动自动完成单槽→(科目,用户) 迁移）；服务器 docker 为 snap 版，bind mount 必失败，故用命名卷');
lines.push("    user: root # snap 命名卷属主为 root：以 root 跑本服务以便写 /data/sync.db");
lines.push("    # 有意不做端口映射：进度存储只在编排内部网络可达，仅门户容器访问");
lines.push("    restart: unless-stopped");
for (const s of subs) {
  lines.push(`  grade-svc-${s.prefix}:`);
  if (mode === "--remote") lines.push(`    image: exam-grade-${s.prefix}:latest`);
  else lines.push(`    build:\n      context: .\n      dockerfile: grade-svc/Dockerfile\n      args:\n        SUBJECT: ${s.slug}`);
  lines.push("    environment:\n      QWEN_API_KEY: ${QWEN_API_KEY:-}\n      QWEN_MODEL: ${QWEN_MODEL:-qwen3.8-flash}");
  lines.push("    # 有意不做端口映射：密钥与判分服务只存在于编排内部网络，只有门户容器可达");
  lines.push("    restart: unless-stopped");
}
lines.push("volumes:\n  portal-store: # 命名卷由 docker 自管（snap docker 沙箱不允许 bind 宿主 /opt），数据存 /var/snap/docker/common/var-lib-docker/volumes；清理需显式 docker volume rm");
console.log(lines.join("\n"));
