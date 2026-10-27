# AGENTS.md — 自考押题多科目刷题站（前后端解耦 · v2）

**硬边界：前端只做视图，Go 是所有业务口径的唯一实现。**

- `frontend/`（`api.js` / `model.js` / `app.js`）只负责渲染、交互、筛选与草稿；不得出现判分、合并、掌握判定、组卷权重、身份分区、权限判断。
- 所有业务（判分、逐项解析、进度、组卷、统计、背题、考点、账号、游客、限流、邮件）都在 `backend/grade-svc/` 的 Go 代码里。
- 前端与后端只通过 `api/v1` 契约通信；前端可单独部署到任意静态服务器，后端只依赖 `SUBJECTS_DIR`（随镜像发布）与 PostgreSQL。
- 不做兼容层：旧 `/api/store`、`/api/grade`、`/api/auth` 与 v1 blob 形状已删除，不恢复。

## 常用命令

```bash
bun run build                 # 各科 data/build_data.js → subjects/<科目>/data/questions.json
bun run stage                 # ＝bun run build:web，产出 build/web/（单份前端，全部科目共用）
bun run start                 # 开发静态站（build/web）+ /api → 127.0.0.1:8793；默认主科目 os
./start-ai.sh                 # 需 QWEN_API_KEY + DATABASE_URL：起 apivc + 前端
bun test                      # 前端纯净度守卫 + reference.md↔思维导图守卫
cd backend/grade-svc && go test ./...   # 判分/进度/认证单测（DB 用例需 TEST_DATABASE_URL）
scripts/test-pg.sh            # 起临时 PostgreSQL 并跑 go test + bun test
bun run new-subject <prefix> <code> <中文名>
./deploy.sh                   # 单 API 镜像 + 前端静态 + nginx 反向代理，幂等
```

## 结构

```
frontend/                 index.html / styles.css / api.js / model.js / app.js / config.json
backend/grade-svc/        Go module（module grade-svc）
  cmd/apivc/              单服务入口；-migrate-v1 / -reset-password
  internal/subject/       SUBJECTS_DIR 装载 subject.json + data/questions.json + reference.md + mindmap.html
  internal/grading/       单选/填空/简答启发式（Go 唯一实现）
  internal/gradeai/       简答 AI 判分 + 单选逐项解析
  internal/progress/      进度状态机 / 组卷 / 统计 / 背题 / 考点
  internal/auth/          注册/登录/游客/会话/密码/限流/邮件
  internal/store/         PostgreSQL 连接 + goose 迁移 + v1→v2 迁移
  internal/httpapi/       /api/v1 路由与 SSE
  internal/store/migrations/
subjects/<科目>/          subject.json（唯一身份源）、data/（raw.txt、build_data.js、questions.json）、
                         data/explanations.json / essay_points.json / unordered.json / memo_kp.json、
                         mindmap.html、grade/reference.md
scripts/                  构建期工具（build/stage/gen-compose/new-subject/config）
deploy.sh                 发布脚本
```

## 数据与判分

- 题库构建：`textutil -convert txt -stdout "<docx>" > subjects/<科目>/data/raw.txt && bun run build <科目>`；产物只有 `data/questions.json`，**勿手改**。
- 科目 build_data.js 只写解析；装配走 `scripts/build-lib.js`（变体、并列互换、精简考点、解析覆盖）。
- 判分口径：
  - 单选：完全一致。
  - 填空：仅容忍全半角/大小写/空白；`fallback` 才用包含兜底；`unordered` 多空按全排列取最大命中（n≤7）。
  - 简答：得分点覆盖度（二字分词/IDF/字面兜底/标题词），score＝cov 均值×100；AI 判分另走 `gradeai`（cov 由模型给，状态与分数仍由服务端重算）。
  - 掌握线 80、答错线 60 只在 `internal/progress` 定义。
- 题目内容只由服务端按 `qid` 取；前端提交的只有作答 `u`。

## API v1（同源 `/api/v1`）

- 账号：`POST auth/guest|register|login|logout|claim|request-reset|reset-password|verify-email|resend-verify`，`GET auth/me`。
- 科目：`GET subjects`、`GET subjects/{prefix}/catalog|mindmap`。
- 进度：`GET subjects/{prefix}/progress`；`POST .../answers`（`mode=submit|preview|ai`）、`POST .../answers/{qid}/redo`、`POST .../seen`、`POST .../progress/clear`。
- 组卷：`POST/DELETE subjects/{prefix}/papers`。
- 视图：`GET .../stats|recite|memo`。
- 解析：`POST .../explain`（`stream:true` 走 SSE：delta → done）。
- 迁移：`POST migrate`（浏览器旧 localStorage 一次性导入）。

## 进度语义（服务端唯一写入方）

- 首次评分写 `s`；`preview` 只返回练习分，不落账、不归档、不刷新分数。
- 重做：有分先归档（每题最多 10 条），再删记录；下次提交重新计分。
- 清空：删 progress/histories/seen 并记 `cleared_at`。
- 组卷：卷内旧记录先归档再清空（保留「看过解析」标记）；服务端加权抽样，`picked/order/total/seed` 落库。
- 出现标记在 `seen` 表（跨设备一致）；草稿只在本机 `localStorage`。

## 账号

- 游客由服务端签发（`users.is_guest`），可直接做题；注册/登录时自动并入账号；也可显式 `POST auth/claim {guest_slot}`。
- 会话 Cookie `exam_session`（`HttpOnly; SameSite=Lax; Path=/`，默认 30 天）；库里只存 token 的 SHA-256。
- 密码 PBKDF2-SHA256 600k + 16 字节盐；登录/注册/邮件发送均限流。
- 邮件（可选，阿里云 DirectMail）：`MAIL_DRIVER=aliyun` + AccessKey + `ALIYUN_DM_ACCOUNT_NAME`；验证链接 24h、重置 30min，单次使用；未配置时相关接口返回 503 `mail_unavailable`。

## 数据库

- 表：`users/sessions/email_tokens`、`progress/histories/papers/seen/cleared/explain_cache`。
- 迁移由 goose embed 自动执行（`internal/store/migrations`）。
- v1 数据迁移：`apivc -migrate-v1 -dry-run` 先看统计，再 `apivc -migrate-v1` 正式执行；完成后删除 `sync/answers/history/explains`（无回滚表，靠发布前数据库快照）。
- 管理员重置密码：`apivc -reset-password <email>`（新密码从 stdin 读一行）。

## 部署

- `deploy.sh`：build+stage → 构建 `exam-api`（linux/amd64）→ 上传镜像 → rsync `build/web` → 生成 compose（`postgres` + `api-svc`，科目与题库在镜像内）→ 执行迁移 → nginx：
  - `/<prefix>/` → `/opt/exam-sites/web`（同一份前端，URL 前缀决定科目）
  - `/api/` → `127.0.0.1:8793`
- 服务器目标写在仓库根未跟踪的 `.deploy.env`（`SSH_HOST=...`），**不得提交**。
- 发布后必须探活：`/<prefix>/` 200、`/api/v1/subjects` 200、`/api/v1/auth/me` 401。

## 开发约定

- 注释、文案、commit message 一律中文；改动随手提交。
- 前端不再有第三方依赖；新增交互只操作 DOM 与 `API`，不新增业务计算。
- 新增科目：`bun run new-subject ...` → 放 docx → 改 `build_data.js` 解析段 → `bun run build` → `./deploy.sh`。
- 测试守卫：`tests/frontend_purity.test.js`（前端不得出现判分/合并/旧接口）、`tests/ref_sync.test.js`（reference.md 与导图逐字一致）、Go 判分全量题库不变量。