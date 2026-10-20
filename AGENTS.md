# AGENTS.md — 自考押题多科目刷题站（单仓）

本地纯前端多科目练习站 + 可选 Go AI 判分。**主站运行时为 Bun**（前端零第三方依赖）；判分服务 `grade-svc/` 为独立 Go module（OpenAI Go SDK · 千问兼容模式）。共享引擎唯一份（`web/` `grade-svc/` `portal/`），**科目 = `subjects/<科目>/` 目录**——严禁把引擎文件复制进科目目录，严禁新增「按科目 fork 代码」的做法；旧三仓（~/自考操作系统 ~/自考网络安全 ~/自考押题门户）为存档，不再改动。

## 常用命令

- `bun run start <科目>` — 本地静态服务器（默认 http://127.0.0.1:8791/ os、8793/ net，端口读 subject.json；`PORT=` 覆盖）；`/api/grade` `/api/store` 默认代理线上（本机不常驻服务，本机与线上同源互通）。双击 `build/stage/<prefix>/index.html` 本机直开（file:// 无 AI 判分、无云同步）
- `bun run build [科目…]` — 重新生成各科 data.js/questions.json + 刷新派生清单（web/subjects.js、portal/subjects.json）；`--manifest` 只刷清单
- `bun run stage [科目…]` — 合成部署形态 `build/stage/<prefix>/`（web/ 引擎 + 科目产物）
- `./start-ai.sh <科目>` — 本地 AI 判分联调（后台 Go + 前台站点，需 `export QWEN_API_KEY=sk-xxx`；自动 GRADE_API 指向本地）
- `bun test` — 引擎回归 + 逐科目数据不变量 + sync↔store 交叉 + 代理/清单守卫（改判分/合并/部署逻辑后必跑）
- `cd grade-svc && go test ./...` — Go 判分服务单测（httptest 假上游，零真实网络）
- `bun run new-subject <prefix> <code> <中文名>` — 生成新科目骨架（端口自动分配）
- `./deploy.sh` — 线上一键发布（**每次本地更新提交后必须跑**，遍历科目，幂等）

## 结构

- 前端经典脚本按序加载（web/index.html）：`data.js`（window.QUIZ_DATA，科目产物）→ `grading.js`（window.GRADER）→ `sync.js`（window.SYNC）→ `subjects.js`（window.SUBJECTS，切换器清单，生成物）→ `app.js` → `subject-switch.js`。**科目身份全部来自 `QUIZ_DATA.meta`**（build 时由 subject.json 注入）：存储键、标题文案、题型分值/组卷目标、特性开关——新增「这科和那科不一样」的东西，加 subject.json 字段 + meta，不在引擎里写死。
- `subjects/<科目>/`：`subject.json`（身份唯一源：prefix/code/name/标题/storageKey/ports/flags/paper/mindmap/grade）、`data/`（raw.txt、**build_data.js＝该科 docx 专属解析器**、questions.json、可选 explanations/essay_points/unordered）、`data.js`（生成物，有意提交）、`mindmap.html`（导图页，数据内联）、科目根导图 md、`grade/reference.md`（可选：单选逐项解析参考资料，须与导图逐字一致）。`_template/` 为新科目骨架。
- `scripts/`：`config.js`（loadSubjects/findSubject/metaOf——server/build/deploy/测试共用）、`build-lib.js`（装配共享层：fullRef/variantsOf/orderVariants/splitBlanks/applyUnordered/applyEssayPoints/applyExplains/writeArtifacts）、`build.js`、`stage.js`、`gen-compose.js`、`new-subject.js`。
- `grade-svc/` 为独立 Go module：main.go 路由、grader.go prompt/上游/normalize/缓存、explain.go 单选逐项解析、subject.go 科目配置装载。
- `portal/`：portal.js（科目清单读生成的 portal/subjects.json，前缀路由/判分上游/裸根重定向全循环）、store.js（bun:sqlite 云同步，科目无关，主键=前缀）。

## 数据管线（勿手改生成物）

- 各科 `data.js` 与 `data/questions.json` 由 build 生成，**严禁手改**（文件头有声明）；data.js 有意提交进 git。更新流程：`textutil -convert txt -stdout "<docx>" > subjects/<科目>/data/raw.txt && bun run build <科目> && bun test`。
- **科目 build_data.js 只写「解析」**（源文本 → 规范题目数组 {id,chapter,type,stem,ref,options/answer/blanks/points/explanation…}），装配（unordered 标记、essay_points 精简考点与 `**关键词**` 剥标、explanations 合并、变体、meta 注入、落盘）一律走 `scripts/build-lib.js`；缺省行为用其选项参数（os=allTypes 解析+缺考点/缺解析告警；net=单选回落、可选文件不告警）。
- 主观题解析文案写在科目 `data/explanations.json`，撰写必须逐题参考该科串讲/考点资料并标注考点；简答精简考点写 `data/essay_points.json`（保持参考答案词序，否则「原文≈满分 ≥95」锚点掉分）。加粗标记 `**…**` 内不得含 `；;。`。
- 并列可互换多空题列科目 `data/unordered.json`（ids=跨空互换题、single=单空两项枚举题），判分引擎按标记做跨空最大匹配——有先后语义的空题严禁入清单，新增 id 逐题复核；官方认可的其他写法改数据/源文本（variantsOf/变体），不改判分引擎。

## 判分与前端约定

- `grading.js` 纯函数、无 DOM、零网络，浏览器挂 `window.GRADER`、bun 测试经 import 副作用挂 `globalThis.GRADER`，保持 UMD IIFE 结构。
- 文案与 UI 忌大段文字：解析结构化「考点标签→答案行→逐条短句（关键词加粗）→简答得分点编号列表」；按真实考卷分值思考（默认单选 1/填空 2/简答 5，组卷约 100 分——均在 subject.json `paper` 可配）。单选题无独立结果区与底部面板：判分结果内联选项区（正确项 `.opt.right`+「✓ 正确答案」、错选 `.opt.wrong`+「你的选择 ✗」、其余 `.dim`），解析面板 `.explain` 在 `.opts` 末尾；未判分开解析同样标 ✓；背答案同理；选项锁定判据＝卡上有 `.redo-btn`。填空/简答走「结果区+底部面板」。
- 填空题答案**完全一致才给分**（仅容忍全半角/大小写/空格，fallback 整句兜底除外）。
- 用户数据 localStorage，键=subject.json `storageKey`（派生键 `.shuffle` `.syncsnap` `.synccleared` `.hist` `.expl`）：改存储结构评估升版本；云同步只增删记录键不改单条形状。app.js 启动对已判分填空记录按当前引擎重算（只改 s/ts，不动形状）。`.expl`/`.hist` 本机专属不入云；历史归档 `.hist` 每题最近 10 次，界面不显示。「清空记录」三道闸门连 `.hist` 清除。
- 随机组卷即全新：勾选或换一批都 `newShuffle`——先 `archiveHist` 再清卷内作答（保留 v 看过标记供加权），删除经墓碑同步云端；刷新不触发清理。组卷抽题池跟随当前筛选（`passFilters(q, true)`）；卷激活后状态筛选不再影响卷面，章节/题型/搜索卷内收窄；池空不组卷（勾选回退/换一批保留原卷）；卷面恢复只验 picked 题号。
- AI 判分链路保持：`grade()` 纯同步，AI 只出现在 upgradeEssay 异步链；`svc_down/no_key/bad_key` 会话熔断 `aiOff`；restore 有 `g` 不再打网络。单选逐项解析按钮仅当 `meta.flags.explain` 为真时渲染。

## 判分 AI 服务（grade-svc · /api/grade）

- 链路：前端同源 POST → server.js（本地）或 portal.js（线上）代理 → 每科目一个 Go 容器（镜像 `exam-grade-<prefix>`，同一份源码 `--build-arg SUBJECT` 注入科目目录到镜像 `/app/subject/`）→ 千问兼容模式（默认 `qwen3.8-flash`）。密钥只走 `QWEN_API_KEY` 环境变量、只存在于 Go 进程；**严禁写进前端源码或 data 文件**。
- **科目身份经 `SUBJECT_DIR` 注入**（subject.go：科目名/资料名 prompt、`reference.md`/`grade/reference.md` 可选参考资料）：未设或解析失败**拒启**，绝不拿错科目判分。判分口径三处同步约束：normalize 按 cov 推 state（hit≥0.5/part≥0.22，与 grading.js 同阈值）、score=cov 均值×100——改口径 grading.js 与 grader.go 两处同改（有测试锁）。
- 响应契约与 gradeEssay 兼容：`{engine,score,per:[{text,cov,state,comment,segs}]}`；explain 任务 `{task:"explain",source,items:[{key,correct,why,src}]}`，correct 一律按题面答案推导。两级链路（资料级 found=false 或失败→enable_search 联网级；网关拒参自动去参重出）。超时预算：Go 85s、代理 95s、线上 nginx 120s。
- `subjects/<科目>/grade/reference.md` 更新后须与科目导图 md 逐字一致（`test/ref_sync.test.js` 值守卫）。

## 云同步（sync.js ↔ portal/store.js）

- 合并语义：逐题 rec.ts LWW；本地删除发墓碑 `{u:null,s:null,ts}`；已同步墓碑按原 ts 幂等重放；「清空记录」clearedAt 全局压制（`.synccleared`）。
- **两处实现、一处守卫**：`web/sync.js` mergeBlobs ↔ `portal/store.js` mergeBlobs/normalizeIncoming，由 `test/merge_xcheck.test.js` 随机夹具等价校验 + 载荷契约校验——改任一实现，同改另一处并跑测试。
- 链路：同源相对 `api/store`；线上 portal.js 直连 store.js（bun:sqlite 每科目全局单槽，命名卷 portal-store）；本机 server.js 代理 STORE_API（默认线上对应前缀，置 `off` 禁用）。公开无鉴权，勿存敏感数据。

## 部署（deploy.sh，每次本地提交后必跑）

- 遍历 `subjects/*/subject.json` 全自动：build+stage → 交叉构建 amd64 镜像（portal + 每科目 grade）→ 管道上传 load → `gen-compose.js --remote` 生成的 compose rsync 起（门户绑 127.0.0.1:8799，科目服务不映射端口）→ nginx Host=IP 逐科目前缀 location（超时 120s 统一口径）→ 逐科目探活。**新增科目零改脚本**；compose/门户清单/nginx 均为生成物勿手改。发布后必须 curl 线上验证已生效。
- 线上兼容基线：前缀 `/os/` `/net/`、各科 storageKey、云端主键与旧三仓一致，已存进度无缝续用，勿改。

## 其他约定

- 注释、文案、commit message 一律中文；改动随手提交（git 已管控）。
- 行为细节（组卷权重、批量提交、背答案）以 README.md 为准；改前先读对应小节。
