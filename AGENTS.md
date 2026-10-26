# AGENTS.md — 自考押题多科目刷题站（单仓）

本地纯前端多科目练习站 + Go 后端服务（AI 判分 / 账号认证 / 云同步）。**技术栈是硬边界：Bun + 原生 JS 只做前端演示与构建工具链，运行时后端逻辑一律 Go**（详见下节「技术栈」）。前端零第三方依赖；判分服务 `grade-svc/` 为独立 Go module（OpenAI Go SDK · 千问兼容模式），账号/云同步 `sync-svc` 同仓，存储为 PostgreSQL。共享引擎唯一份（`web/` `grade-svc/` `portal/`），**科目 = `subjects/<科目>/` 目录**——严禁把引擎文件复制进科目目录，严禁新增「按科目 fork 代码」的做法；旧三仓（~/自考操作系统 ~/自考网络安全 ~/自考押题门户）为存档，不再改动。

## 技术栈（边界硬约束）

- **前端演示层＝Bun + 原生 JS**：`web/` 浏览器脚本（零第三方依赖、经典脚本按序加载）、`subjects/<科目>/data.js`（生成物）、`server.js`（本地静态服务器 + 薄代理）、`portal/portal.js`（线上门户壳：前缀路由 + 纯转发）。职责仅限渲染、交互、本地状态与离线可用；浏览器端交互算法（组卷权重、筛选排序、背题队列、模板渲染）可留在 JS，但它们只服务于演示，云端事实以 Go 合并结果为准。
- **后端逻辑层＝Go（唯一实现）**：判分/逐项解析/SSE 流式（`grade-svc/`）、账号注册登录/会话/限流、云同步合并/槽位/存储/统计（`grade-svc/cmd/syncsvc/`，PostgreSQL + pgx + goose 迁移）。今后任何服务端能力——鉴权、调度、上游调用、数据加工、持久化、合并裁决——一律新写或扩展 Go module，**不得用 Bun/JS 实现**。
- **代理/静态壳零业务逻辑**：`server.js`、`portal/portal.js` 只做静态文件、前缀路由、超时/错误码映射与纯转发；一旦出现判断、计算、落库、合并等业务分支，必须下沉到 Go 服务，JS 侧不得自行实现。
- **既有跨语言双实现是兼容基线，不是新增模板**：`web/grading.js`（浏览器离线判分演示）、`web/sync.js`（本地合并）为前端离线演示保留，权威口径在 Go（`grader.go`、`syncsvc`）；改判分/合并口径须两处同改并跑跨语言夹具（`test/fixtures/merge_golden.json`）。新增逻辑不再往 JS 复制一份。
- **构建期 JS 工具不算后端**：`scripts/`（docx 解析、build/stage、gen-compose、gen-merge-golden 等）与 `bun test` 属工程工具链，只产出前端产物/部署物，不常驻、不提供运行时服务、不承担运行时业务决策。

## 常用命令

- `bun run start <科目>` — 本地静态服务器（默认 http://127.0.0.1:8791/ os、8793/ net，端口读 subject.json；`PORT=` 覆盖）；`/api/grade` `/api/auth/*` `/api/store[/<slot>]` 默认代理线上（本机不常驻服务，本机与线上同账号互通）。双击 `build/stage/<prefix>/index.html` 本机直开（file:// 无 AI 判分、无云同步）
- `bun run build [科目…]` — 重新生成各科 data.js/questions.json + 刷新派生清单（web/subjects.js、portal/subjects.json）；`--manifest` 只刷清单
- `bun run stage [科目…]` — 合成部署形态 `build/stage/<prefix>/`（web/ 引擎 + 科目产物）
- `./start-ai.sh <科目>` — 本地 AI 判分联调（后台 Go + 前台站点，需 `export QWEN_API_KEY=sk-xxx`；自动 GRADE_API 指向本地；本地未配 `AUTH_VERIFY_URL` 时判分按开发模式放行）
- `bun test` — 引擎回归 + 逐科目数据不变量 + 账号/云同步/代理（store.test.js 构建并起 Go sync-svc；**需 PostgreSQL**：`scripts/test-pg.sh` 或 `export TEST_DATABASE_URL`）+ 代理/清单守卫（改判分/合并/鉴权/部署逻辑后必跑）
- `cd grade-svc && go test ./...` — Go 判分/认证/云同步单测（httptest 假上游 + 测试 PostgreSQL；未设 `TEST_DATABASE_URL` 时 DB 用例 skip）
- `bun run new-subject <prefix> <code> <中文名>` — 生成新科目骨架（端口自动分配）
- `./deploy.sh` — 线上一键发布（**每次本地更新提交后必须跑**，遍历科目，幂等）

## 结构

- 前端经典脚本按序加载（web/index.html）：`data.js`（window.QUIZ_DATA，科目产物）→ `grading.js`（window.GRADER）→ `sync.js`（window.SYNC）→ `identity.js`（window.IDENTITY，账号/匿名分区）→ `auth.js`（window.AUTH，登录接口封装）→ `recite.js`（window.RECITE，重点优先背纯排序）→ `memo.js`（window.MEMO，考前重点记忆按掌握度过滤考点）→ `subjects.js`（window.SUBJECTS，切换器清单，生成物）→ `app.js` → `subject-switch.js`。**科目身份全部来自 `QUIZ_DATA.meta`**（build 时由 subject.json 注入）：存储键、标题文案、题型分值/组卷目标、特性开关——新增「这科和那科不一样」的东西，加 subject.json 字段 + meta，不在引擎里写死。
- `subjects/<科目>/`：`subject.json`（身份唯一源：prefix/code/name/标题/storageKey/ports/flags/paper/mindmap/memo/grade）、`data/`（raw.txt、**build_data.js＝该科 docx 专属解析器**、questions.json、可选 explanations/essay_points/unordered/memo_kp）、`data.js`（生成物，有意提交）、`mindmap.html`（导图页，数据内联）、科目根导图 md、`grade/reference.md`（可选：单选逐项解析参考资料，须与导图逐字一致）。`_template/` 为新科目骨架。
- `scripts/`：`config.js`（loadSubjects/findSubject/metaOf——server/build/deploy/测试共用）、`build-lib.js`（装配共享层：fullRef/variantsOf/orderVariants/splitBlanks/applyUnordered/applyEssayPoints/applyExplains/writeArtifacts）、`memo-lib.js`（考前重点记忆装配：串讲 md→考点小节 + 题目映射 + `data/memo_kp.json` 补齐）、`build.js`、`stage.js`、`gen-compose.js`、`new-subject.js`、`gen-merge-golden.js`（云同步跨语言夹具生成器）、`test-pg.sh`（临时 PostgreSQL 测试库）。
- `grade-svc/` 为独立 Go module：main.go 路由、grader.go prompt/上游/normalize/缓存、explain.go 单选逐项解析、subject.go 科目配置装载、auth.go 判分会话校验（内网 `/internal/session` + 45s 缓存 + 可选小时配额）；`cmd/syncsvc/` ＝账号/云同步服务 sync-svc（db.go：pgx 连接池 + goose embed 迁移；store.go：合并/整形校验/(科目,账号 slot) 槽位；rows.go：派生行与统计；auth.go/session.go/password.go/ratelimit.go：注册/登录/会话/限流；`-normalize` stdio 夹具模式、`-reset-password <email>` 管理员重置），`Dockerfile.sync` 独立出镜像。
- `portal/`：portal.js（科目清单读生成的 portal/subjects.json，前缀路由/判分上游/裸根重定向全循环；api/auth 与 api/store 纯转发上游 SYNC_API，并透传 Cookie/Set-Cookie/X-Forwarded-*，门户不执行业务逻辑）。

## 数据管线（勿手改生成物）

- 各科 `data.js` 与 `data/questions.json` 由 build 生成，**严禁手改**（文件头有声明）；data.js 有意提交进 git。更新流程：`textutil -convert txt -stdout "<docx>" > subjects/<科目>/data/raw.txt && bun run build <科目> && bun test`。
- **科目 build_data.js 只写「解析」**（源文本 → 规范题目数组 {id,chapter,type,stem,ref,options/answer/blanks/points/explanation…}），装配（unordered 标记、essay_points 精简考点与 `**关键词**` 剥标、explanations 合并、变体、meta 注入、落盘）一律走 `scripts/build-lib.js`；缺省行为用其选项参数（os=allTypes 解析+缺考点/缺解析告警；net=单选回落、可选文件不告警）。
- 主观题解析文案写在科目 `data/explanations.json`，撰写必须逐题参考该科串讲/考点资料并标注考点；简答精简考点写 `data/essay_points.json`（保持参考答案词序，否则「原文≈满分 ≥95」锚点掉分）。加粗标记 `**…**` 内不得含 `；;。`。
- 并列可互换多空题列科目 `data/unordered.json`（ids=跨空互换题、single=单空两项枚举题），判分引擎按标记做跨空最大匹配——有先后语义的空题严禁入清单，新增 id 逐题复核；官方认可的其他写法改数据/源文本（variantsOf/变体），不改判分引擎。

## 判分与前端约定

- `grading.js` 纯函数、无 DOM、零网络，浏览器挂 `window.GRADER`、bun 测试经 import 副作用挂 `globalThis.GRADER`，保持 UMD IIFE 结构。
- 文案与 UI 忌大段文字：解析结构化「考点标签→答案行→逐条短句（关键词加粗）→简答得分点编号列表」；按真实考卷分值思考（默认单选 1/填空 2/简答 5，组卷约 100 分——均在 subject.json `paper` 可配）。单选题无独立结果区与底部面板：判分结果内联选项区（正确项 `.opt.right`+「✓ 正确答案」、错选 `.opt.wrong`+「你的选择 ✗」、其余 `.dim`），解析面板 `.explain` 在 `.opts` 末尾；未判分开解析同样标 ✓；背答案同理；选项锁定判据＝卡上有 `.redo-btn`。填空/简答走「结果区+底部面板」。
- 填空题答案**完全一致才给分**（仅容忍全半角/大小写/空格，fallback 整句兜底除外）。
- 用户数据 localStorage，键基座=subject.json `storageKey` + 账号 slot 分区后缀（未登录用匿名码分区，仅本机、不上云；派生键 `.shuffle` `.syncsnap` `.synccleared` `.hist` `.expl` `.seen` 全部随分区派生）：改存储结构评估升版本；云同步只增删记录键不改单条形状。身份键：`quizsync.account`（账号 slot）+ `quizsync.accountEmail`（显示用），未登录回退 `quizsync.code`（匿名码，identity.js 管理：静默签发/切换/迁移搬键）。登录首启 `ID.adoptLocal` 把匿名/旧版裸键分区的用户数据搬入账号分区（只搬 `""/.shuffle/.hist/.expl/.seen`，不搬 `.syncsnap/.synccleared`）。app.js 启动先 `AUTH.me()`（3s 超时）→ 设账号 → 算 KEY → 仅登录时 `SYNC.prefetch`。app.js 启动对已判分填空记录按当前引擎重算（只改 s/ts，不动形状）。数据完全上云（v2）：`.hist`（每题最近 10 次，界面不显示）与 `.expl`（AI 解析缓存，saveExplCache 落 `ts`）随同步推送/写回；历史归档与解析缓存跨设备续用。「清空记录」三道闸门连 `.hist` 与本机出现标记 `.seen` 一并清除（clearedAt 压制仅本人槽位，且不洗 `.expl`）。
- 随机组卷即全新：勾选或换一批都 `newShuffle`——先 `archiveHist` 再清卷内作答（保留 v 看过标记供加权），删除经墓碑同步云端；刷新不触发清理。抽题权重＝题型×状态四档：从未出现（题卡未滚进过刷题/组卷视口、未进卷面、无任何记录——本机派生键 `.seen` 标记，不入云同步；背答案滚动不算出现）×8 ＞ 出现过且看过解析/未答/错 ×4 ＞ 60~79 ×1 ＞ 已掌握未看解析 ×0.3。组卷抽题池跟随当前筛选（`passFilters(q, true)`）；卷激活后状态筛选不再影响卷面，章节/题型/搜索卷内收窄；池空不组卷（勾选回退/换一批保留原卷）；卷面恢复只验 picked 题号。
- 评分只记首次：`store[q.id].s` 由第一次「提交评分」写入并决定掌握状态（统计/筛选/组卷权重全看它）；此后点「重新评分」只算 `out.practice` 展示（按钮旁「练习分 · 不计入掌握」），不写 store、不归档 `.hist`、也不刷新分数胶囊；简答的 AI 升级同理传 `record=false` 只展示不上账。想重新计分走「重做此题」（清记录后再次提交即新首次）。
- AI 判分链路保持：`grade()` 纯同步，AI 只出现在 upgradeEssay 异步链；`svc_down/no_key/bad_key` 会话熔断 `aiOff`；`unauthorized/auth_unavailable/too_many_requests` 只提示不熔断（登录后可继续）；restore 有 `g` 不再打网络。单选逐项解析按钮仅当 `meta.flags.explain` 为真时渲染。
- 重点优先背（`web/recite.js` 纯函数 + app.js 弹层）：科目 `meta.flags.recite` 为真才注入顶栏入口；未掌握＝首次评分 <80（含未作答），队列排序「答错（分低在前）→ 待提高 60~79 → 未作答；同档简答/填空先背，未作答中看过解析的优先」；掌握线常量 MASTER=80 与状态筛选口径一致，改阈值两处同改。全屏弹层复用 `explainHTML(q,{noAI/noAns/noPts})` 静态展示答案，不渲染逐项解析按钮。**「开始/重做并练习」在当前背题页内联作答（复用 `collect`/`grade`/首次与重做语义），提交后原地出分、逐项反馈与解析，不跳主列表、不清筛选/组卷**；已判分题提交时 `archiveHist` 旧记录并覆盖新成绩（取消不写盘），简答同主站异步升级 AI 判分。**手机/窄屏默认收起统计与筛选**（`recite.folded` ↔ `.recite-shell.folded`；头部 `#reciteFold` 切换、`matchMedia(max-width:900px)` 定默认、手动选择后本次会话记住；收起后题卡区占满剩余高度，副标题只留一行战况，不新增存储键）。只读 store、不改云同步形状。
- 考前重点记忆（`web/memo.js` 纯函数 + app.js 弹层）：科目 `meta.memo` 为真才注入顶栏入口；数据 `QUIZ_DATA.memo`＝build 时由 `scripts/memo-lib.js` 从科目串讲导图 md 拆出的「章→节→要点」＋每节挂的题目 id（`data/explanations.json` 的「考点X.Y」标注自动映射，无标注的题在 `data/memo_kp.json` 人工补，缺映射 build 告警）。前端只读 store：某节所挂题**全部 ≥80**（与 `RECITE.MASTER` 同一掌握线）即标已掌握、移出默认「未掌握」视图，并展示答错/待提高/未作答题数分布；「❗ 答错」视图只留有答错题的考点、按答错数重排章与节（考前先啃失分点）；**只列知识点、不显示题干、不判分、不新增存储键**。手机端战况横滑、说明收起、题型标签让位；改掌握阈值与 `recite.js`/状态筛选同改。

## 判分 AI 服务（grade-svc · /api/grade）

- 链路：前端同源 POST → server.js（本地）或 portal.js（线上）代理 → 每科目一个 Go 容器（镜像 `exam-grade-<prefix>`，同一份源码 `--build-arg SUBJECT` 注入科目目录到镜像 `/app/subject/`）→ 千问兼容模式（默认 `qwen3.8-flash`）。密钥只走 `QWEN_API_KEY` 环境变量、只存在于 Go 进程；**严禁写进前端源码或 data 文件**。
- **科目身份经 `SUBJECT_DIR` 注入**（subject.go：科目名/资料名 prompt、`reference.md`/`grade/reference.md` 可选参考资料）：未设或解析失败**拒启**，绝不拿错科目判分。判分口径三处同步约束：normalize 按 cov 推 state（hit≥0.5/part≥0.22，与 grading.js 同阈值）、score=cov 均值×100——改口径 grading.js 与 grader.go 两处同改（有测试锁）。
- 响应契约与 gradeEssay 兼容：`{engine,score,summary,per:[{text,cov,state,comment,segs}]}`——`summary` 为整段总评（「AI 完整回复」，prompt 要 80~200 字完整成句，Go 侧防御截断 600 字、上游 `max_tokens` 留 2048 防截断；缺省容错不判失败，旧缓存无此字段前端不渲染），前端随作答记录 `g.summary` 持久化（云同步照原样带，旧客户端忽略）；explain 任务 `{task:"explain",source,items:[{key,correct,why,src}]}`，correct 一律按题面答案推导。两级链路（资料级 found=false 或失败→enable_search 联网级；网关拒参自动去参重出）。超时预算：Go 85s、代理 95s、线上 nginx 120s。
- **explain 流式输出**：请求体带 `stream:true` 时 Go 以 SSE 应答（`explain_stream.go`：事件 reason/delta/reset/done/error；上游请求带 `enable_thinking:false` 彻底关闭思考（被拒自动去参重出），reason＝模型思考过程增量（非标字段 `delta.reasoning_content` 经 SDK `ExtraFields` 透传）——通道保留作兜底：网关静默忽略关参时思考照常展示而非白屏，正常线上无 reason 事件；delta＝逐选项增量，reset＝资料级输出弃用清屏（思考面板同清），done＝与非流式**完全同形**的 ExplainResp（思考不入契约、不入缓存），权威整形只在末尾对全量 content 做一次）。响应带 `X-Accel-Buffering: no`（nginx 默认尊重该头关缓冲，无需改 location 配置）；server.js/portal.js 对 text/event-stream 逐帧透传不聚合。前端 app.js 实时落行渲染、done 后整包重排并落 `.expl` 缓存——逐项标签按「是否本题答案」标注（`✓ 本题答案` / `✗ 非本题答案`），system prompt 同步要求解释落到「为什么是/不是本题答案」并覆盖否定式题干（不正确的是/不属于/不包括），不改 JSON 契约；思考内容渲染为可折叠面板（生成中自动展开「🧠 思考中…」、done 后自动收起为「🧠 思考过程」、点击标题手动切换）；应答非 SSE（旧服务/错误体）自动回落整包 JSON 口径。**失败可见可恢复**：点按钮立即落「生成中」占位（不等首帧 delta）；联网级输出不可解析（闲话/半截 JSON）时追加格式提醒重出一次（流式重出前先 reset 清屏），仍失败才发 error；前端失败不清空面板——有旧结果则回滚并附「⚠ 错误条 + 重试」，无旧结果则整屏错误条 + 重试，`network/timeout/incomplete` 等前端错误码有中文文案。代理把超时与不可达分开：超时 504 `timeout`（不触发 aiOff 熔断），连接失败仍 502 `svc_down`。explain 成功/失败/耗时写容器日志（`docker logs exam-sites-grade-svc-<前缀>-1` 可查定位）。改流式扫描器必跑 `explain_stream_test.go`（任意切块/转义/乱序/reason 夹具断言 + 联网级重出一轮/两轮失败）。
- `subjects/<科目>/grade/reference.md` 更新后须与科目导图 md 逐字一致（`test/ref_sync.test.js` 值守卫）。

## 账号与云同步（auth.js / identity.js / sync.js ↔ grade-svc/cmd/syncsvc）

- 身份=账号：邮箱 + 密码注册/登录；服务端签发 10 位账号 slot（格式 `[a-z2-9]{4,10}`，与前端 `CODE_RE`/Go `userRe` 一致），云端槽位=(科目, slot)，本机键按 slot 分区。会话 Cookie `exam_session`（`HttpOnly; SameSite=Lax; Path=/`，默认 30 天，`Secure` 由 `COOKIE_SECURE`/`PUBLIC_ORIGIN` 判断），数据库只存 token 的 SHA-256。注册默认开放（`REGISTRATION_OPEN=0` 关闭；`MAX_USERS` 限总量；users 为空时仍允许创建首个账号），登录/注册按 IP（+邮箱）限流；密码 PBKDF2-SHA256 600k + 16 字节盐；无邮件服务，忘记密码用 `syncsvc -reset-password <email>`。
- 鉴权边界：`/api/store` 与 `/api/grade` 必须有效会话；`/store/<subject>/<slot>` 路径 slot 只做一致性校验，与服务端账号 slot 不一致返回 403 `forbidden_slot`；路径格式校验先于鉴权（非法码仍 400）。未登录可浏览题库与本地判分。判分服务经内网 `GET /internal/session` 校验（45s 缓存；校验不可用 503 失败关闭），可选 `GRADE_HOURLY_LIMIT` 按账号限额。
- 邮件（可选，阿里云 DirectMail）：`MAIL_DRIVER=aliyun` + `ALIYUN_ACCESS_KEY_ID/SECRET` + `ALIYUN_DM_ACCOUNT_NAME`（控制台已认证的发件地址）；验证链接 24h、重置链接 30min，单次使用，库里只存 token 的 SHA-256；发送类接口（request-reset/resend-verify）对未知邮箱也返回 202，未配置邮件时统一 503 `mail_unavailable`；`REQUIRE_EMAIL_VERIFY=1` 时未验证邮箱登录返回 403 `email_not_verified`。邮件链接优先 `PUBLIC_ORIGIN`，否则按 `X-Forwarded-Proto/Host/Prefix` 还原。
- 合并语义：逐题 rec.ts LWW；本地删除发墓碑 `{u:null,s:null,ts}`；已同步墓碑按原 ts 幂等重放；「清空记录」clearedAt 压制（`.synccleared`，仅本人槽）。v2 扩展：blob 新增可选 `hist`（逐题并集去重、同 ts 先到先得、升序留 10、受 clearedAt 压制）与 `expl`（逐题 ts LWW、不受压制）；**两端皆无该段时输出不含键**——旧版 blob 形状逐字节不变（兼容基线）；载荷上限 4MB。
- **存储双形态（PostgreSQL）**：`sync` 表整 blob 仍是线上协议与合并事实源（旧客户端零破坏）；每次 PUT 在同一事务里 `INSERT ... FOR UPDATE` 锁住 `(subject, user_slot)` 后合并，再 upsert blob 并展开逐题行 `answers/history/explains`（派生读模型，`rows.go`），启动即全量重建自愈。schema 由 `migrations/*.sql`（goose embed）管理；统计走内网 `GET /stats/<subject>`（portal 不转发、compose 不映射宿主端口）。
- **两处实现（跨语言）、一处守卫**：`web/sync.js` mergeBlobs/payload* ↔ Go syncsvc mergeBlobs/normalizeIncoming，两侧分别断言单一夹具 `test/fixtures/merge_golden.json`（JS 侧 `test/merge_xcheck.test.js`、Go 侧 `grade-svc/cmd/syncsvc/store_golden_test.go`）——改口径两实现同改后重跑 `scripts/gen-merge-golden.js` 刷新夹具，单侧漂移必红。
- 链路：同源相对 `api/auth/*` 与 `api/store[/<slot>]`；线上 portal.js 纯转发 sync-svc（并透传 Cookie/Set-Cookie/X-Forwarded-*），本机 server.js 代理 `AUTH_API`/`STORE_API`（默认线上对应前缀，置 `off` 禁用云同步）。**代理只透传、不解释登录态**；任何归属判断都在 Go。

## 部署（deploy.sh，每次本地提交后必跑）

- 服务器目标经 `SSH_HOST` 提供：deploy.sh 自动 source 仓库根未跟踪的 `.deploy.env`（已 gitignore，内含真实 host，勿提交、勿写进任何进仓文件），无则报错拒跑。
- 遍历 `subjects/*/subject.json` 全自动：build+stage → 交叉构建 amd64 镜像（portal + sync-svc 账号/云同步 + 每科目 grade）→ 管道上传 load → `gen-compose.js --remote` 生成的 compose rsync 起（门户绑 127.0.0.1:8799，postgres/sync-svc/科目服务不映射宿主端口；postgres 命名卷 `pgdata`；`POSTGRES_PASSWORD`/`INTERNAL_TOKEN` 由 deploy.sh 首次在远端 `.env` 生成）→ nginx Host=IP 逐科目前缀 location（超时 120s 统一口径）→ 逐科目探活（`/api/store` 未登录 401、`/api/auth/me` 401、非法码 400）。**新增科目零改脚本**；compose/门户清单/nginx 均为生成物勿手改。发布后必须 curl 线上验证已生效。
- 线上兼容基线：前缀 `/os/` `/net/`、各科 storageKey、云端 `user_slot=''` 旧槽与旧三仓主键一致，勿改；账号 slot 是纯增量。旧 SQLite 卷 `portal-store` 不再挂载（保留在宿主机供导出/回滚），其数据不会自动导入 PostgreSQL：升级后在旧浏览器登录一次，本机 localStorage 会自动并入账号并推送。

## 其他约定

- 注释、文案、commit message 一律中文；改动随手提交（git 已管控）。
- 行为细节（组卷权重、批量提交、背答案）以 README.md 为准；改前先读对应小节。
