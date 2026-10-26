# 自考押题 · 多科目刷题站（前后端解耦）

2026 年 10 月自考押题自动判分练习站。**前端只做视图（原生 JS，零第三方依赖），所有业务口径在 Go**：判分、逐项解析、进度、组卷、统计、背题、考点、账号、游客、限流、邮件。一个仓库承载任意多个科目，同一份前端与同一个 API 进程服务全部科目。

- **前端可独立部署**：`frontend/` 产出 `build/web/`，任意静态服务器都能托管；接口地址由 `/config.json` 的 `apiBase` 指定。
- **科目 = 一个目录**：`subjects/<科目>/` 只放科目身份、题库源数据、解析器与参考资料。
- **无兼容层**：旧 `/api/store`、`/api/grade`、`/api/auth` 与 v1 blob 协议已删除；旧数据通过一次性迁移进入 v2 表。

当前科目：

| 科目目录 | 线上入口 | 题量 | 特性 |
|---|---|---|---|
| `os13180` | http://121.40.43.229/os/ | 190（58 单选 / 100 填空 / 32 简答） | 单选逐项解析；考前重点记忆 |
| `net04751` | http://121.40.43.229/net/ | 205（105 单选 / 70 填空 / 30 简答） | 单选逐项解析；重点优先背 |

## 快速使用

```bash
bun run build                 # 解析各科 docx 文本 → subjects/<科目>/data/questions.json
bun run stage                 # ＝build:web，复制单份前端到 build/web/
bun run start                 # 开发站：build/web + /api → 127.0.0.1:8793（默认主科目 os）
./start-ai.sh                 # 需 QWEN_API_KEY 与 DATABASE_URL：起 API + 前端
bun test                      # 前端纯净度 + reference.md↔导图守卫
cd backend/grade-svc && go test ./...   # Go 单测（DB 用例需 TEST_DATABASE_URL）
scripts/test-pg.sh            # 起临时 PostgreSQL 并跑全部测试
./deploy.sh                   # 线上一键发布（单 API 镜像 + 静态 + nginx）
```

本地跑完整链路（含判分与进度）需要 PostgreSQL：

```bash
docker run -d --rm --name exam-dev -e POSTGRES_PASSWORD=exam -e POSTGRES_USER=exam \
  -e POSTGRES_DB=exam_dev -p 127.0.0.1:55433:5432 postgres:17-alpine
export DATABASE_URL='postgres://exam:exam@127.0.0.1:55433/exam_dev?sslmode=disable'
export QWEN_API_KEY=sk-xxx        # 可选；不配则简答只走本机启发式
./start-ai.sh
```

线上统一入口 http://121.40.43.229/ （裸根落主科目）。页面必须通过站点地址访问；`file://` 直开只显示提示（判分与进度需要联网）。

## 新增一个科目

```bash
bun run new-subject db 06414 数据库系统
# 1) textutil -convert txt -stdout "<docx>" > subjects/db06414/data/raw.txt
# 2) 改 subjects/db06414/data/build_data.js 的「解析」段适配版式（装配走共享层）
# 3) bun run build db06414 && bun test
# 4) bun run stage && bun run start   → http://127.0.0.1:8791/db/
# 5) ./deploy.sh                      → 自动纳入 /db/
```

可选增强：放 `考点串讲-思维导图.md` 并在 `subject.json` 填 `mindmap.file/label`；需要单选逐项解析时把导图副本存 `grade/reference.md` 并置 `flags.explain: true`；需要重点优先背置 `flags.recite: true`。

## 仓库结构

```
frontend/                     index.html / styles.css / api.js / model.js / app.js / config.json
backend/grade-svc/            Go module
  cmd/apivc/                  单服务入口（-migrate-v1 / -reset-password）
  internal/subject/           运行时装载科目与题库
  internal/grading/           单选/填空/简答启发式（唯一实现）
  internal/gradeai/           简答 AI 判分 + 逐项解析
  internal/progress/          进度状态机/组卷/统计/背题/考点
  internal/auth/              账号/游客/会话/邮件/限流
  internal/store/             PG 连接 + 迁移 + 旧数据导入
  internal/httpapi/           /api/v1 路由与 SSE
subjects/<科目>/
  subject.json                科目身份唯一源
  data/                       raw.txt + build_data.js + questions.json + 可选解析/考点/并列清单
  mindmap.html                导图页（API 下发）
  grade/reference.md          逐项解析参考资料（与导图逐字一致）
scripts/                      构建期工具（build/stage/gen-compose/new-subject/config）
server.js                     开发静态服务器 + API 代理
deploy.sh                     发布脚本
```

## 判分与使用

- **单选**：点选项判对错，结果直接标在选项区（正确项「✓ 正确答案」、错选项「你的选择 ✗」），分数看顶栏胶囊。
- **填空**：题干下划线填写，答案与标准答案**完全一致**才给分（仅容忍全/半角、大小写、空白）。并列枚举的多空题（`data/unordered.json`）允许空位间对调，每空仍须逐字一致。
- **简答**：按得分点覆盖度打分（≥50% 视为命中该要点），标出答到的片段；配了 AI 时异步升级为语义判分（🤖 徽标 + 逐要点点评 + 整段总评）。
- **重新评分只作练习**：已判分的题再提交只展示「练习分 · 不计入掌握」，不改写首次成绩。想重新计分点「重做此题」。
- **解析**：每题随时可展开；点开过解析会记标记，组卷时更优先再考。开启 `flags.explain` 的科目，单选解析区有「🤖 逐项解析」：先依据科目资料，资料不足自动联网补充；失败保留错误条与重试。
- **随机组卷（约 100 分，`subject.json paper` 可配）**：服务端按题型与掌握情况加权抽样；从未出现的最易入选，看过解析/未作答/答错次之，已掌握降频。组卷即全新：卷内旧记录先归档再清空。组卷范围跟随当前筛选。
- **重点优先背**：按首次评分排未掌握题（答错 → 待提高 → 未作答；同档简答/填空优先），可在当前页练习，≥80 分移出队列。
- **考前重点记忆**：把串讲导图拆成考点小节，只列知识点、不显示题干；所挂题全部 ≥80 分即标为已掌握。
- **批量提交**：作答自动存草稿（仅本机），底部悬浮条可一次提交全部未判分草稿。
- **账号**：未登录也可直接做题（服务端游客会话，进度已保存）。登录后游客进度自动并入账号，换设备用同一邮箱登录即续用。支持邮箱验证与找回密码（需配置阿里云 DirectMail；未配置时找回密码用管理员 CLI）。
- **清空记录**：三道闸门（确认 → 随机码 → 最终确认），删除作答、得分、历史与出现标记。

## 数据管线（勿手改生成物）

题库唯一产物是 `subjects/<科目>/data/questions.json`：

```bash
textutil -convert txt -stdout "<新docx>" > subjects/<科目>/data/raw.txt && bun run build <科目> && bun test
```

- 科目 `data/build_data.js` 只负责把源文本解析成规范题目数组；装配（并列互换标记、精简考点、解析覆盖、变体生成）走 `scripts/build-lib.js`。
- 简答精简考点写 `data/essay_points.json`；主观题解析写 `data/explanations.json`（逐题参考串讲并标「考点X.Y」）；并列可互换题列 `data/unordered.json`。
- 「考前重点记忆」由 `scripts/memo-lib.js` 在 build 时从导图 md 拆出，并用「考点X.Y」把题挂到小节；没标注的题用 `data/memo_kp.json` 人工补。
- 改判分口径只需改 Go `internal/grading`，并跑 `go test`（全量题库不变量：标准答案满分、简答原文 ≥95、并列题任意轮换满分）。

## 账号与邮件

- 会话 Cookie `exam_session`（`HttpOnly; SameSite=Lax; Path=/`，默认 30 天）；库里只存 token 的 SHA-256。
- 密码 PBKDF2-SHA256 600k + 16 字节盐；注册/登录/邮件发送按 IP（+邮箱）限流。
- 注册默认开放（`REGISTRATION_OPEN=0` 关闭，`MAX_USERS` 限总量）。
- 阿里云 DirectMail（可选）：`MAIL_DRIVER=aliyun` + `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` / `ALIYUN_DM_ACCOUNT_NAME`。验证链接 24 小时、重置链接 30 分钟，单次使用。
- 未配置邮件时管理员重置：`docker compose exec api-svc apivc -reset-password <email>`（新密码从 stdin 读一行）。

## 部署

- `./deploy.sh`：构建题库与前端 → 交叉构建 `exam-api`（linux/amd64）→ 上传镜像 → rsync `build/web` 与科目配置 → 生成 compose（`postgres` + `api-svc`）→ 执行 `-migrate-v1` → 写 nginx。
- nginx：`/<prefix>/` 直接托管 `/opt/exam-sites/web`（同一份前端），`/api/` 反代 `127.0.0.1:8793`。
- 数据迁移：`apivc -migrate-v1 -dry-run` 先看统计，再正式执行；完成后旧 `sync/answers/history/explains` 表被删除。回滚手段是发布前的数据库快照。
- 服务器目标写在仓库根未跟踪的 `.deploy.env`（`SSH_HOST=user@host`），**勿提交**。
- **每次本地更新提交后必须跑 `./deploy.sh`** 并 curl 验证：`/<prefix>/` 200、`/api/v1/subjects` 200、`/api/v1/auth/me` 401。

## 科目档案

### os13180 · 操作系统（13180）

190 题：58 单选 / 100 填空 / 32 简答；源 docx 按「[单选]/[填空题]/[简答题]+解析」逐行解析。填空/简答解析依据《操作系统考点串讲》逐题撰写；简答精简考点在 `data/essay_points.json`；并列互换 32 题。思维导图 8 章 40 节（与 `grade/reference.md` 逐字同步）；`flags.explain: true`；`memo` 开启（8 章 46 个考点小节）。

### net04751 · 计算机网络安全（04751）

205 题：105 单选 / 70 填空 / 30 简答；源 docx 为「题目区 + 答案区」双连续编号大段文本；26 题因缺答/依赖题图被剔除。`flags.explain: true`、`flags.recite: true`。思维导图文字版 `计算机网络安全考点-思维导图.md`（与 `grade/reference.md` 逐字同步）。

## 历史

- 旧三仓（`~/自考操作系统` `~/自考网络安全` `~/自考押题门户`）仅作存档，不再改动。
- v1 的整 blob 云同步、前端判分/合并、匿名同步码已全部移除；升级时 PostgreSQL 旧 blob 由 `-migrate-v1` 转换，浏览器旧 `quizsync.*` 与本机分区键由前端一次性导入后删除。