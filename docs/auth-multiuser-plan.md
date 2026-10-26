> **已被 v2 架构取代（2026-10-26）**：本文档记录的是多用户改造当时的设计，文中 `sync-svc`、`backend/portal`、`/api/store`、`frontend/grading.js` 等均已删除。当前架构以根目录 `AGENTS.md` 为准：前端纯视图 + 单一 Go API（`backend/grade-svc/cmd/apivc`）+ PostgreSQL。本文仅作历史存档。

# 多用户登录改造方案（含 PostgreSQL 迁移）

> 状态：**阶段 0~3 与邮件服务已实施并上线**（2026-10-26）；域名 + TLS 待做。邮件默认 `MAIL_DRIVER=none`（相关接口 503），填入阿里云 DirectMail 凭据后启用。实施差异与验证结果见文末「附录 B」。
> 目录重组说明（2026-10-26）：`web/` → `frontend/`，`portal/` → `backend/portal/`，`grade-svc/` → `backend/grade-svc/`，`test/` → `tests/`；下文路径已同步，早期「文件:行号」锚点可能随文件变动漂移。
> 日期：2026-10-26
> 决策来源：站长需求确认（邮箱+密码、匿名可浏览、同步/判分需登录、单人使用可手动迁移、数据库改 PostgreSQL、后期接域名/TLS/邮件服务）。

---

## 0. 结论摘要

1. **不引入第三方身份平台**。用 Go 标准库 + 现有 Go module 自研认证，认证逻辑放进 `cmd/syncsvc`（或同 module 的 `internal/auth`），判分服务复用同一份会话校验逻辑。
2. **数据库从 SQLite 换成 PostgreSQL 17**，驱动用 `jackc/pgx/v5`（MIT），迁移用 `pressly/goose/v3`（MIT，支持 embed SQL）或等价的自写 runner。
3. **账号标识用邮箱**，密码用 **PBKDF2-HMAC-SHA256、600,000 次迭代、每用户 16 字节随机盐**（Go 1.24+ 标准库 `crypto/pbkdf2` 可用，仓库 `go.mod` 是 Go 1.26.4）。
4. **会话用服务端会话表**：浏览器只拿到 32 字节随机 token，数据库只存 `SHA-256(token)`；Cookie 为 `HttpOnly; SameSite=Lax; Path=/`，后期加 `Secure`。
5. **匿名可浏览题库**；云同步与 AI 判分在未登录时返回 `401`。本地判分（`grading.js`）继续可用。
6. **账号 slot 复用现有 `[a-z2-9]{4,10}` 规则**，因此 localStorage 分区键、同步 URL 形状、合并协议都尽量不动，减少对已验证代码的冲击。
7. **单人使用，迁移从简**：不实现复杂的「旧同步码云端认领」，只保留一次性的本机匿名分区搬移；云端旧数据可手动导出或由浏览器重新推送。
8. **后期扩展口子现在就留**：`email_verified_at`、`email_tokens`、`Mailer` 接口、`PUBLIC_ORIGIN` / `COOKIE_SECURE` / `COOKIE_DOMAIN` 等配置项、TLS 上线步骤。

一句话：**自研 Go 认证 + PostgreSQL + 服务端会话 + 邮箱密码**，不引入 IdP、不引入前端框架、不新增运行时。

---

## 1. 现状结论（改造前）

### 1.1 身份与本地存储

| 事实 | 位置 |
|---|---|
| 同步码是全局身份，存在 `quizsync.code`，格式 `[a-z2-9]{4,10}` | `frontend/identity.js:9-13` |
| 同步码同时是本地分区后缀：`storageKey + "." + 码`；无码则裸键（旧版兼容） | `frontend/identity.js:34` |
| 新访客静默签发 6 位码；有旧版本地数据的设备不签发 | `frontend/identity.js:37-43` |
| 切换用户只改 `quizsync.code`，不搬数据；迁移是「搬」7 个键 | `frontend/identity.js:45-62` |
| 7 个分区键：`""`, `.shuffle`, `.syncsnap`, `.synccleared`, `.hist`, `.expl`, `.seen` | `frontend/identity.js:13` |
| 启动顺序：`ID.ensure()` → `ID.keyFor()` → `await SYNC.prefetch(KEY, ID.user())` | `frontend/app.js:8-16` |
| 派生键：`.shuffle` / `.seen` / `.hist` / `.expl` | `frontend/app.js:42,59,198,1110` |
| 身份弹层：看码/复制/输码切换/一键迁移/退回旧版 | `frontend/app.js:1566-1604`，`frontend/index.html:111-124` |

**结论：同步码既是身份、又是凭据、又是本地分区键、又是云端槽位键。** 服务端只校验格式，不校验归属，知道码就能读写对应进度。

### 1.2 云同步与代理

| 事实 | 位置 |
|---|---|
| 同步 URL 为 `api/store[/<码>]`；`USER` 为空即旧版全局槽 | `frontend/sync.js:118-122` |
| `prefetch` 拉云、按 `ts` LWW 合并、写回本地、再补推 | `frontend/sync.js:161-183` |
| PUT 载荷含 `store/shuf/clearedAt`，v2 追加 `hist/expl` | `frontend/sync.js:193-206` |
| 4xx 被视为永久失败（本会话不再同步） | `frontend/sync.js:207,217` |
| 线上门户只透传 `content-type`，不转发 Cookie、不回传 Set-Cookie | `backend/portal/portal.js:70-88` |
| 本地服务器同样只透传 `content-type` | `server.js:21-56,64-68` |
| 门户路由只有 `api/grade` 与 `api/store`，`api/auth/*` 会落到静态 404 | `backend/portal/portal.js:39-88` |

**结论：即使后端加了登录，只要代理不转发 Cookie，浏览器也永远登录不上。** 两个代理必须改。

### 1.3 后端与数据库

| 事实 | 位置 |
|---|---|
| 云同步服务 `cmd/syncsvc`：`/api/health`、`/store/...`、`/stats/<subject>` | `backend/grade-svc/cmd/syncsvc/main.go:62-89` |
| `user` 只校验格式 `^[a-z2-9]{4,10}$`，不做认证 | `backend/grade-svc/cmd/syncsvc/store.go:31-35` |
| SQLite 表：`sync(subject, "user", blob, updated_at)`，主键 `(subject,"user")` | `backend/grade-svc/cmd/syncsvc/store.go:458-460` |
| 旧单槽表迁移在启动时自动完成，失败拒启 | `backend/grade-svc/cmd/syncsvc/store.go:490-543` |
| PUT 先读后合并再写，读与写不在同一事务；并发 PUT 有覆盖窗口 | `backend/grade-svc/cmd/syncsvc/store.go:609-640` |
| 派生行表 `answers/history/explains`，启动全量重建 | `backend/grade-svc/cmd/syncsvc/rows.go:13-25,120-164` |
| `/stats` 逐用户聚合，`"user"` 直接输出同步码 | `backend/grade-svc/cmd/syncsvc/rows.go:184-234` |
| 判分服务无任何认证中间件 | `backend/grade-svc/main.go:38-87,146` |
| 线上 HTTP 80，无 TLS | `deploy.sh:79-88` |

### 1.4 部署与测试

| 事实 | 位置 |
|---|---|
| compose 只有 `portal`、`sync-svc`、每科目 `grade-svc-<prefix>` | `scripts/gen-compose.js:19-47` |
| `sync-svc` 用命名卷 `portal-store` 挂 `/data` | `scripts/gen-compose.js:32-38` |
| 发布探活：`/api/store` 必须含 `"blob"`；非法码必须 400 | `deploy.sh:101-118` |
| 前端产物清单 `ENGINE_FILES` 固定 10 个文件 | `scripts/stage.js:8` |
| 测试会构建并启动 `sync-svc`，直连临时 SQLite | `backend/portal/test/store.test.js:1-52` |
| 同步 URL 契约测试断言 `api/store/<码>` 与 `api/store` | `tests/sync.test.js:148-208` |
| 身份测试锁定 6 位码、7 键迁移、ensure 三分支 | `tests/identity.test.js:24-103` |
| 代理测试断言同步码尾段原样透传 | `tests/server_proxy.test.js:175-197` |
| 跨语言 golden 夹具锁定合并与载荷整形 | `tests/fixtures/merge_golden.json`、`tests/merge_xcheck.test.js`、`backend/grade-svc/cmd/syncsvc/store_golden_test.go` |

### 1.5 改造影响面（先看清再动手）

- **必须改**：`identity.js`（账号优先）、`sync.js`（未登录不发请求 / 401 处理）、`app.js`（启动改异步）、`index.html`（登录 UI）、`stage.js`（新脚本入清单）。
- **必须改**：`portal.js`、`server.js`（Cookie 透传 + `api/auth/*` 路由）。
- **必须改**：`cmd/syncsvc`（Postgres + 用户/会话表 + 认证路由 + 同步鉴权）。
- **必须改**：`grade-svc`（会话校验中间件）。
- **必须改**：`gen-compose.js`、`deploy.sh`（Postgres 服务、env、探活）。
- **需要改测试**：`backend/portal/test/store.test.js`、`syncsvc/store_test.go`、`rows_test.go`、`tests/sync.test.js`、`tests/server_proxy.test.js`、`tests/identity.test.js`、`tests/server_proxy.test.js:218` 的引擎清单。
- **不用改**：`frontend/grading.js`、`grading.test.js`、各科 `data.js`、`merge_golden.json`（合并口径与数据库无关）。

---

## 2. 需求与决策

### 2.1 已确认口径

| 项 | 决定 |
|---|---|
| 登录标识 | 邮箱 + 密码 |
| 未登录 | 可浏览题库、可本地判分；**云同步与 AI 判分需登录** |
| 当前用户量 | 仅站长一人；迁移可以手动完成 |
| 数据库 | 改为 PostgreSQL |
| 传输 | 先跑 HTTP，明示风险；后期接域名 + TLS |
| 邮件 | 后期接邮件发送服务（邮箱验证、找回密码） |
| 前端约束 | 原生 JS、零第三方依赖、经典脚本按序加载 |
| 后端约束 | 后端逻辑只用 Go（AGENTS.md 硬约束） |

### 2.2 非目标

- 不做 OAuth / 微信 / GitHub 登录。
- 不做多租户组织、角色权限、管理后台。
- 不做手机号、短信、MFA（可作为远期）。
- 不在本轮实现邮箱验证与找回密码（只留表结构与接口）。
- 不保留匿名云同步（旧同步码云端槽位不再对外服务）。

### 2.3 设计原则

1. **服务端是唯一事实源**：身份、会话、归属全部由 Go 判定；前端只做展示与本地状态。
2. **最小冲击**：账号 slot 继续用 `[a-z2-9]{4,10}`，同步 URL 与本地键形尽量不变。
3. **失败关闭**：会话校验不可用时，同步/判分返回 401/503，不降级为匿名访问。
4. **配置先留口**：TLS、域名、邮件相关环境变量现在就定义，后期只改部署不改代码。
5. **单人优先**：迁移、找回密码等流程允许人工介入，不为此增加复杂自动机制。

---

## 3. 开源方案调研

### 3.1 对比表

| 方案 | License | 形态 | 额外基础设施 | 与现有架构契合度 | 结论 |
|---|---|---|---|---|---|
| 标准库自研 | Go 标准库 | 代码内实现 | 无（复用现有 Postgres） | 最高：同进程、同 DB、同部署形态 | **推荐** |
| `alexedwards/scs` | MIT | Go 会话库 | 需自定义/第三方 Store | 中：只解决会话，不解决注册/密码；其 SQLite store 用 CGO，与 `CGO_ENABLED=0` 冲突 | 不采用 |
| `PocketBase` | MIT | 单文件 BaaS（Go+SQLite） | 自带 SQLite、整套后台 | 低：整套 BaaS 与现有路由/存储模型冲突；当前 README 要求 Go 1.27，仓库是 1.26.4 | 不采用 |
| `Ory Kratos` | Apache-2.0 | 独立身份服务（headless API） | 需 PostgreSQL/MySQL/CockroachDB + 独立服务 + identity schema | 中低：换 PG 后可部署，但多一个服务与整套 flow，单人站过重 | 不采用 |
| `SuperTokens` | Apache-2.0（`ee/` 除外） | Java Core + 前后端 SDK | 需 Core 服务 + 数据库 + 前端 SDK | 低：Java 运行时、前端 SDK 与「原生 JS 零依赖」冲突 | 不采用 |
| `Authelia` | Apache-2.0 | 反向代理 forward-auth / SSO 门户 | 需反代集成；Lite 模式文件+SQLite，正式模式需 DB/Redis | 低：它是网关级 SSO，不是应用内注册/密码体系 | 不采用 |
| Keycloak / Casdoor / Zitadel | 各自开源许可 | 重型 IdP | 独立服务 + 数据库 + 管理界面 | 很低：对单人站是数量级过度设计 | 不采用 |
| `golang-jwt/jwt` | MIT | JWT 库 | 无 | 中：但本项目用不透明会话 token 更简单，无需 JWT | 不采用 |

### 3.2 关键事实

- **SCS** 只做 HTTP 会话管理（服务端存储 + 随机 token cookie），不做注册、密码哈希、授权；其 SQLite store 依赖 `mattn/go-sqlite3`（CGO），与本仓库 `CGO_ENABLED=0` 的纯 Go 交叉构建冲突。要用就得自己写 Store，收益很小。
- **PocketBase** 是「SQLite + 后台 + 认证 + 实时订阅」的一体化 BaaS，作为库嵌入会与现有门户/判分/同步三进程模型和路由体系冲突；且当前 README 标注需要 Go 1.27，仓库是 1.26.4。
- **Kratos** 是 headless 身份服务，需要独立进程和 PostgreSQL/MySQL；换 PG 后技术上可行，但为单人站引入 identity schema、flow API、邮件/验证流程，维护成本明显高于自研。
- **SuperTokens** 的 Core 是 Java 服务，前端需要其 SDK；与「原生 JS、零第三方依赖」硬约束冲突。
- **Authelia** 解决的是「反代前面的 SSO」，用户来源是文件/LDAP，不是应用内自助注册。
- **OWASP 密码存储建议**：首选 Argon2id（m=19456, t=2, p=1）；若用 PBKDF2，HMAC-SHA-256 推荐 **600,000 次迭代**；每个密码必须有唯一随机盐。
- Go 标准库自 1.24 起提供 `crypto/pbkdf2`，仓库 Go 1.26.4 可直接使用，零新增依赖。

### 3.3 推荐

**自研，理由：**

1. 只需要 4 个端点（注册、登录、登出、me）+ 一个会话校验，代码量约 400~600 行，远小于引入 IdP 的集成与运维成本。
2. 现有 Go module 已有纯 Go SQLite/HTTP 基础设施；换 Postgres 后 `pgx` 是唯一新增核心依赖。
3. 前端零依赖约束下，任何 IdP 的前端 SDK 都要额外适配。
4. 单人使用，不需要组织、角色、MFA、审计等 IdP 能力。
5. 后期要邮件验证/找回密码，自研只需加 `Mailer` 接口和两张表，不需要迁移身份体系。

**可选的折中**：如果未来确实要多用户运营、需要 MFA/OAuth/管理后台，再评估 Kratos 或 Casdoor；届时账号数据可通过 `users` 表导出迁移。

---

## 4. 目标架构

```
浏览器（原生 JS）
  │  Cookie: exam_session=...（HttpOnly, SameSite=Lax, Path=/）
  ▼
nginx :80 / :443（后期 TLS）
  │  按 /<prefix>/ 前缀转发
  ▼
portal（Bun，纯转发，零业务逻辑）
  ├── /<prefix>/api/auth/*   → sync-svc  /auth/*
  ├── /<prefix>/api/store/*  → sync-svc  /store/<subject>
  └── /<prefix>/api/grade    → grade-svc-<prefix> /api/grade
                                   │
                                   │ 内网 GET /internal/session（带 Cookie）
                                   ▼
                              sync-svc（Go：认证 + 会话 + 同步 + 统计）
                                   │
                                   ▼
                              PostgreSQL（users / sessions / sync / answers / history / explains）
```

职责边界：

- **backend/portal/server.js**：只做静态文件、前缀路由、Cookie/Set-Cookie 与 `X-Forwarded-For` 透传、超时/错误码映射。**不判断登录状态、不解析 token、不碰数据库。**
- **sync-svc**：用户注册/登录/登出、密码哈希、会话签发与校验、同步槽位读写、统计。唯一持有数据库凭据与密码材料的服务。
- **grade-svc**：只做会话校验（调用 sync-svc 内网接口或读只读会话表），不持有用户密码材料。
- **前端**：渲染登录 UI、保存账号显示信息、按登录状态决定是否发起同步/判分；不保存密码、不解析会话 token。

---

## 5. 登录与多用户设计

### 5.1 账号与 slot

- 账号主键：`users.id`（自增）。
- 账号对外标识：`users.email`（小写、唯一）。
- 账号存储分区键：`users.slot`，服务端生成 10 位 `[a-z2-9]` 字符串，唯一。
- 为什么继续用 slot 而不是直接用 email 或 user id：
  - 现有 localStorage 分区键、同步 URL、`userRe` 都基于这个格式，改动最小。
  - 避免 email 中的 `@`、`.` 进入存储键与 URL。
  - 未来改账号标识（例如换邮箱）不影响存储分区。
- 账号 slot 不再对用户展示为「同步码」；它只是内部存储键。用户看到的是邮箱。

### 5.2 表结构（PostgreSQL）

```sql
-- 0001_init.sql
CREATE TABLE users (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email             TEXT   NOT NULL UNIQUE,
  pass_hash         TEXT   NOT NULL,
  slot              TEXT   NOT NULL UNIQUE,
  email_verified_at BIGINT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  CONSTRAINT users_slot_fmt CHECK (slot ~ '^[a-z2-9]{4,10}$'),
  CONSTRAINT users_email_lower CHECK (email = lower(email))
);

CREATE TABLE sessions (
  token_hash BYTEA  PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

-- 同步事实源：整 blob 仍是合并协议的唯一事实
CREATE TABLE sync (
  subject   TEXT   NOT NULL,
  user_slot TEXT   NOT NULL,
  blob      TEXT   NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (subject, user_slot)
);

-- 派生读模型（可从 sync.blob 全量重建）
CREATE TABLE answers (
  subject   TEXT   NOT NULL,
  user_slot TEXT   NOT NULL,
  qid       BIGINT NOT NULL,
  u_json    TEXT,
  s         DOUBLE PRECISION,
  v         DOUBLE PRECISION,
  g_score   DOUBLE PRECISION,
  ts        BIGINT NOT NULL,
  rec       TEXT   NOT NULL,
  PRIMARY KEY (subject, user_slot, qid)
);
CREATE TABLE history (
  subject   TEXT   NOT NULL,
  user_slot TEXT   NOT NULL,
  qid       BIGINT NOT NULL,
  ts        BIGINT NOT NULL,
  u_json    TEXT,
  s         DOUBLE PRECISION,
  PRIMARY KEY (subject, user_slot, qid, ts)
);
CREATE TABLE explains (
  subject   TEXT   NOT NULL,
  user_slot TEXT   NOT NULL,
  qid       BIGINT NOT NULL,
  ts        BIGINT NOT NULL,
  payload   TEXT   NOT NULL,
  PRIMARY KEY (subject, user_slot, qid)
);

-- 预留：邮箱验证 / 找回密码（本轮只建表，不启用）
CREATE TABLE email_tokens (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT   NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash BYTEA  NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT
);
CREATE INDEX email_tokens_user_idx ON email_tokens(user_id, purpose);
```

说明：

- 时间统一用毫秒 `BIGINT`，与现有 blob 的 `ts/clearedAt` 语义一致，避免时区/精度问题。
- `user` 是 PostgreSQL 保留字，统一改名 `user_slot`；同步协议对外仍是「用户槽位」，只是列名变了。
- `sync` 保留整 blob，`answers/history/explains` 仍是派生视图，合并口径不变，**golden 夹具不受影响**。
- `email_verified_at`、`email_tokens` 现在建好，后期接邮件服务时不用再做结构迁移。

### 5.3 密码

- 算法：**PBKDF2-HMAC-SHA256**，600,000 次迭代，16 字节随机盐，32 字节输出。
- 存储格式：`pbkdf2-sha256$600000$<base64url(salt)>$<base64url(hash)>`。
- 校验：解析出参数 → 用同样参数重算 → `crypto/subtle.ConstantTimeCompare`。
- 密码长度：8~128 字符；拒绝空密码与超长输入。
- 未来升级：登录成功时若发现迭代次数低于当前配置，用新参数重算并更新（rehash on login）。
- 可选升级：若愿意引入 `golang.org/x/crypto/argon2`，改为 Argon2id（m=19456, t=2, p=1）更符合 OWASP 首选；但会增加一个依赖，当前单人站 PBKDF2 已够用。
- 盐与哈希只存数据库；日志中绝不输出密码、哈希、token。

### 5.4 会话

- 登录成功生成 32 字节随机 token（`crypto/rand`），Base64URL 编码后放 Cookie。
- 数据库只存 `SHA-256(token)`（`BYTEA`），不存明文；查询按 hash。
- 有效期：30 天（`SESSION_TTL` 可配）；过期行登录时顺带清理，另可每小时清理一次。
- Cookie：
  - 名称：`exam_session`
  - `HttpOnly`
  - `SameSite=Lax`
  - `Path=/`（必须；否则默认路径是 `/os/api/auth`，`/os/api/store` 收不到）
  - `Max-Age=2592000`
  - `Secure`：由 `COOKIE_SECURE=1` 开启；后期 TLS 上线后打开
  - `Domain`：单域名留空；未来多子域再配 `COOKIE_DOMAIN`
- 登录时新建会话；若请求已带旧会话，先删除旧会话（防会话固定）。
- 登出：删除当前会话行 + 下发过期 Cookie。
- 「退出所有设备」/ 改密 / 重置密码：删除该用户全部会话。
- 为什么不用 JWT：会话需要可撤销（登出、改密），服务端表更直接；也避免手写 JWT 解析和密钥轮换。

### 5.5 HTTP 契约

经门户访问（`<prefix>` 为 `os` / `net` 等）：

| 方法 | 路径 | 说明 | 成功 | 失败 |
|---|---|---|---|---|
| POST | `/<prefix>/api/auth/register` | 邮箱+密码注册 | 201 + Set-Cookie + `{user:{email,slot}}` | 400 `bad_email`/`bad_password`；403 `registration_closed`；409 `email_taken`；429 `too_many_attempts` |
| POST | `/<prefix>/api/auth/login` | 登录 | 200 + Set-Cookie + `{user}` | 401 `bad_credentials`；429 `too_many_attempts` |
| POST | `/<prefix>/api/auth/logout` | 登出 | 204 + 过期 Cookie | 401（可选：幂等返回 204） |
| GET | `/<prefix>/api/auth/me` | 当前用户 | 200 `{user:{email,slot}}` | 401 `unauthorized` |
| GET/PUT | `/<prefix>/api/store` | 同步（会话槽位） | 200 `{blob}` | 401 `unauthorized`；400 `bad_user`（路径带非法码时）；413/400 同现状 |
| GET/PUT | `/<prefix>/api/store/<slot>` | 兼容路径；登录后必须与账号 slot 一致 | 200 | 401；403 `forbidden_slot` |
| POST | `/<prefix>/api/grade` | AI 判分 | 200（同现状） | 401 `unauthorized`；501/502/504 同现状 |
| GET | `/internal/session`（仅内网） | grade-svc 校验会话 | 200 `{user}` | 401 |

说明：

- 门户对 `api/auth/*` 纯转发到 `SYNC_UP + "/auth/*"`。
- `api/store` 的尾段 slot **可以保留**以减小前端改动；服务端以会话为准，路径 slot 只做一致性校验。这样 `tests/sync.test.js` 的 URL 契约基本不变。
- `/internal/session` 不被门户转发；compose 不映射宿主端口。可再加 `X-Internal-Token` 共享密钥做防御纵深（可选）。
- 路径校验顺序：先校验 `subject`/slot 格式（保留 400 `bad_user` 探针），再校验会话（401）。这样 `deploy.sh` 的非法码探针仍然有效。

### 5.6 鉴权边界

- `/api/store`：必须有有效会话；槽位 = 会话用户的 slot。未登录 401。
- `/api/grade`：必须有有效会话；未登录 401。判分服务通过 `GET http://sync-svc:8793/internal/session` 校验，结果缓存 30~60 秒（按 token hash）。
- `/api/auth/me`：无会话返回 401（前端据此判断未登录）。
- `/stats`：仍是内网端点，不对外；建议后续加管理员 token。
- 静态资源：完全公开（匿名可浏览）。
- 旧匿名槽（`user_slot=''` 与旧同步码槽）不再对外服务；数据保留在库中，供手动导出。

### 5.7 前端启动与本地分区

当前启动是同步的：

```js
ID.ensure(...);
const KEY = ID.keyFor(...);
if (window.SYNC) await SYNC.prefetch(KEY, ID.user());
```

改为：

```js
// 1) 先问服务端当前用户（2.5s 超时；失败按未登录处理）
const me = await AUTH.me();          // null 或 {email, slot}

// 2) 账号优先：登录后 user() 返回账号 slot；否则回退匿名码
ID.setAccount(me);                   // 写/清 quizsync.account 与 quizsync.accountEmail
ID.ensure(D.meta.storageKey, isHttp);
const KEY = ID.keyFor(D.meta.storageKey);

// 3) 只有登录后才发起云同步
if (window.SYNC) {
  if (me) await SYNC.prefetch(KEY, ID.user());
  else SYNC.disable();               // 未登录：不发 GET/PUT
}
```

`identity.js` 新增：

- `ACCOUNT_KEY = "quizsync.account"`（账号 slot）
- `ACCOUNT_EMAIL_KEY = "quizsync.accountEmail"`（仅显示用）
- `user()`：有效 `account` 优先，其次匿名 `quizsync.code`
- `setAccount({slot,email})` / `clearAccount()`
- `adoptAnonymous(rawKey)`：把当前匿名分区的 7 个键搬到账号分区（复用现有 `migrateTo` 的搬移逻辑）
- `SUFFIXES` 保持不变

登录成功后的一次性动作：

1. 调用 `ID.adoptAnonymous(rawKey)`（如果存在匿名分区）。
2. 清除 `quizsync.code`（匿名码不再需要；也可保留作离线标记，但不再上云）。
3. `location.reload()`，让启动流程重新走 `me → KEY → prefetch`。

登出：

- 调 `POST /api/auth/logout` → `ID.clearAccount()` → `reload()`。
- 提供「退出并清除本机账号数据」：删除账号分区 7 个键，适合共享设备。
- 上一账号的本地分区默认保留（同浏览器多账号各自隔离）。

### 5.8 未登录 / 401 行为

- 顶栏芯片：未登录显示「未登录 · 点此登录」，已登录显示邮箱。
- 云同步：未登录不发请求，芯片显示「登录后同步」。
- AI 判分：未登录时按钮可点，但请求返回 401 后提示「登录后使用 AI 判分」，并保留本地判分结果。
- `sync.js` 的 401 处理：**不能**像现在这样把 4xx 当作「永久失败」静默关掉；应回调 `onUnauthorized`，由 `app.js` 弹出登录框并停止本会话同步。
- 会话过期：任意请求 401 → 清账号态 → 弹登录框 → 登录后 reload。

### 5.9 注册开关与管理员重置密码

- `REGISTRATION_OPEN=1`：开放注册（首次部署用）。
- 注册成功第一个账号后，建议在服务器 `.env` 设为 `0`；之后 `register` 返回 403，只允许已有账号登录。
- 单人使用期间，忘记密码没有邮件找回，提供管理员 CLI：
  - `docker compose exec sync-svc ./sync-svc -reset-password you@example.com`（从 stdin 读新密码，只输出成功/失败）。
  - 该命令同样走 PBKDF2，并删除该用户全部会话。
- 后期邮件服务上线后，改为 `request-reset` + `reset-password` 两个端点，CLI 保留作兜底。

---

## 6. PostgreSQL 迁移

### 6.1 编排变更（`scripts/gen-compose.js`）

新增服务：

```yaml
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-exam}
      POSTGRES_USER: ${POSTGRES_USER:-exam}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?missing}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 3s
      retries: 10
    # 有意不做端口映射：数据库只在编排内部网络可达
    restart: unless-stopped
```

- `sync-svc` 增加：
  - `DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?sslmode=disable`
  - `depends_on: postgres: { condition: service_healthy }`
- `grade-svc-<prefix>` 增加：
  - `AUTH_VERIFY_URL: http://sync-svc:8793/internal/session`
  - 可选 `INTERNAL_TOKEN`
- 卷声明新增 `pgdata:`。
- 旧的 `portal-store` 卷暂时保留，用于回滚/导出。

注意：`sslmode=disable` 仅用于 Docker 内部网络；如果安全策略要求，可给 Postgres 配 TLS 并改 DSN。

### 6.2 驱动与 SQL 改写

- 驱动：`github.com/jackc/pgx/v5`（MIT，活跃维护，支持 `database/sql` 适配与 `pgxpool`）。
  - 最小改动：`sql.Open("pgx", dsn)` + `_ "github.com/jackc/pgx/v5/stdlib"`。
  - 若想用原生接口与连接池：`pgxpool.New(ctx, dsn)`，但 `store.go` 现有代码大量用 `database/sql`，建议先用 stdlib 适配。
- SQL 改写清单：
  - 占位符 `?` → `$1..$n`。
  - `AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY`。
  - `BLOB` → `BYTEA`。
  - `INTEGER` 时间戳/ID → `BIGINT`；`REAL` → `DOUBLE PRECISION`。
  - 去掉 `PRAGMA`、`sqlite_master`、`table_info`；建表与迁移交给 goose。
  - `INSERT ... ON CONFLICT(subject, user_slot) DO UPDATE SET ... = excluded....` 在 PG 可直接用。
  - `SUM(CASE ...)` / `COUNT(*)` 返回 `NUMERIC`/`BIGINT`；`Scan` 目标用 `int64`，避免 `int` 转换问题。
  - `DELETE FROM t` 可保留；`rebuildRows` 建议在一个事务内完成（与现状一致）。
- 连接池：
  - `db.SetMaxOpenConns(10)`（按实际调）；不再需要 `SetMaxOpenConns(1)`。
  - 所有查询带 `context.WithTimeout`（例如 5 秒），避免请求悬挂。

### 6.3 迁移工具

推荐 **`pressly/goose/v3`**（MIT）：

- 支持 `embed` SQL 与 PostgreSQL。
- 用法：

```go
//go:embed migrations/*.sql
var migrations embed.FS

goose.SetBaseFS(migrations)
if err := goose.SetDialect("postgres"); err != nil { ... }
if err := goose.Up(db, "migrations"); err != nil { ... } // 启动时执行
```

- 迁移文件：`migrations/0001_init.sql`，带 `-- +goose Up` / `-- +goose Down`。
- 并发迁移：多实例同时启动时，建议启动前加 `pg_advisory_lock`，或让 `sync-svc` 单实例先跑迁移。
- 备选：自写 `schema_migrations(version, applied_at)` + 顺序执行，约 60~80 行，零新增依赖；缺点是回滚/校验要自己维护。二选一，建议 goose。

### 6.4 并发写修正（顺手修掉现有竞态）

现状 `putSlot` 是先 `SELECT` 再 `Begin/INSERT`，两个并发 PUT 可能都基于旧值合并。换 PG 后改为：

```sql
BEGIN;
-- 确保槽位行存在（首次写入）
INSERT INTO sync (subject, user_slot, blob, updated_at)
VALUES ($1, $2, '{"store":{},"shuf":null,"clearedAt":0}', 0)
ON CONFLICT (subject, user_slot) DO NOTHING;

-- 行锁：同一槽位的并发合并串行化
SELECT blob FROM sync WHERE subject = $1 AND user_slot = $2 FOR UPDATE;

-- 合并、upsert、展开派生行
...
COMMIT;
```

- 这样同一 `(subject, slot)` 的读-合并-写是原子的；不同槽位互不阻塞。
- 仍然保留逐题 `ts` LWW 语义，合并协议不变。

### 6.5 数据搬迁（单人、可手动）

推荐顺序：

1. **先备份旧 SQLite 卷**：`docker run --rm -v portal-store:/data alpine tar czf - -C /data . > sync-sqlite-backup.tgz`。
2. 部署 Postgres 与新版服务（新库为空）。
3. 在旧浏览器（`http://IP/os/`）先登录，等「已同步」出现，确认本地数据已推到新库（账号 slot）。
4. 若旧浏览器本地数据已丢，可从旧 SQLite 导出：新增一次性命令 `syncsvc -export-sqlite /data/sync.db > dump.json`，再手工导入账号 slot（或写一个 `-import-slot` 小工具）。
5. 验证：新库 `users` 1 行、`sync` 至少 1 个科目槽位、`answers` 行数与浏览器统计一致。

因为单人使用，**不实现自动「旧同步码 → 账号」认领**；上面步骤足够，且不会误并他人数据。

### 6.6 测试影响

- Go 测试需要真实 Postgres：
  - 环境变量 `TEST_DATABASE_URL`（例如 `postgres://exam:exam@127.0.0.1:5432/exam_test?sslmode=disable`）。
  - 每个测试创建独立 schema：`CREATE SCHEMA test_<rand>` + `SET search_path`，`t.Cleanup` 时 `DROP SCHEMA ... CASCADE`。
  - 未设置 `TEST_DATABASE_URL` 时，DB 相关测试 `t.Skip` 并打印准备命令；这会降低默认测试覆盖率，是换 PG 的明确代价。
- `backend/portal/test/store.test.js`：
  - `beforeAll` 不再建临时 SQLite；改为读取 `TEST_DATABASE_URL`，建独立 schema，spawn `sync-svc` 时注入 `DATABASE_URL`。
  - 所有请求需要先注册/登录拿 Cookie，`api()` helper 自动带 `Cookie`。
  - 未提供 `TEST_DATABASE_URL` 时跳过整组，并输出提示。
- 不受影响：
  - `tests/fixtures/merge_golden.json`、`tests/merge_xcheck.test.js`、`backend/grade-svc/cmd/syncsvc/store_golden_test.go`（合并与整形是纯函数）。
  - `tests/grading.test.js`、各科数据测试。
  - `tests/identity.test.js` 的匿名码部分（新增账号用例）。
- 新增：
  - `backend/grade-svc/cmd/syncsvc/auth_test.go`（注册/登录/登出/me/重复邮箱/坏密码/限流/Cookie 属性/会话过期）。
  - `backend/grade-svc/cmd/syncsvc/authz_test.go`（无会话 401、slot 不匹配 403、`/internal/session`）。
  - `backend/grade-svc/auth_test.go`（判分中间件：有效/无效/过期/服务不可达）。
  - `tests/auth.test.js`（前端 `frontend/auth.js` 的请求形状/错误映射，纯 fetch stub）。
  - 代理测试新增 Cookie/Set-Cookie 透传断言。

本地准备测试库：

```bash
docker run --rm -d --name exam-pg-test \
  -e POSTGRES_PASSWORD=exam -e POSTGRES_USER=exam -e POSTGRES_DB=exam_test \
  -p 127.0.0.1:5432:5432 postgres:17-alpine

export TEST_DATABASE_URL='postgres://exam:exam@127.0.0.1:5432/exam_test?sslmode=disable'
cd backend/grade-svc && go test ./...
cd .. && bun test
```

### 6.7 运维

- 备份：每日 `pg_dump -Fc`，保留 7~30 天；定期做恢复演练。
- 监控：`pg_isready`、连接数、慢查询；单人负载很低，先保持简单。
- 资源：Postgres 容器约 100~200MB 内存；服务器需确认余量。
- 升级：Postgres 主版本升级需 `pg_dump`/`pg_upgrade`，不要直接换镜像标签。
- 回滚：保留旧 `portal-store` 卷与旧镜像标签；新库出问题时切回旧 compose（旧数据仍在）。

### 6.8 成本与风险（如实记录）

- 从「一个容器 + 一个卷」变成「两个容器 + 两个卷」，部署与备份复杂度上升。
- 本地 `bun test` 不再完全自包含：DB 测试依赖外部 Postgres；不设环境变量会跳过。
- `gen-compose.js` / `deploy.sh` / `.env` 管理都要改，首次上线需要生成并保存数据库密码。
- 对单人站而言，SQLite + WAL 原本足够；换 PG 是为后续多用户与运维习惯做准备，属于主动增加基础设施。

---

## 7. TLS / 域名 / 邮件路线（后期）

### 7.1 配置矩阵

| 变量 | 示例 | 说明 |
|---|---|---|
| `PUBLIC_ORIGIN` | `https://exam.example.com` | 对外 origin；用于 Cookie `Secure` 自动判断、日志、绝对链接 |
| `COOKIE_DOMAIN` | 空 / `.example.com` | 单域名留空；多子域共享登录时再配 |
| `COOKIE_SECURE` | `auto` / `1` / `0` | `auto`：`PUBLIC_ORIGIN` 是 https 则开 |
| `SESSION_TTL` | `720h` | 会话有效期 |
| `REGISTRATION_OPEN` | `1` / `0` | 首次注册后建议设 0 |
| `DATABASE_URL` | `postgres://...` | sync-svc 唯一持有 |
| `INTERNAL_TOKEN` | 随机串 | grade-svc → sync-svc 内网校验头（可选） |
| `MAIL_DRIVER` | `none` / `aliyun` | 阿里云 DirectMail；`none` 时验证/重置接口 503 |
| `SMTP_HOST/PORT/USER/PASS/FROM` | — | 后期邮件服务 |
| `MAIL_FROM_NAME` | `自考押题站` | 发件人显示名 |

本地开发（`bun run start`）默认仍代理线上；`server.js` 里硬编码的线上地址应改为 `ONLINE_ORIGIN` 环境变量（默认保持现值），换域名时不改代码。

### 7.2 TLS + 域名上线步骤

1. 域名 A 记录指向服务器 IP。
2. 安装 certbot：`certbot --nginx -d exam.example.com`（或手动配证书）。
3. nginx 增加 `listen 443 ssl` server 块，保留现有 `/<prefix>/` location；80 端口加 `return 301 https://$host$request_uri;`。
4. 设置 `PUBLIC_ORIGIN=https://exam.example.com`、`COOKIE_SECURE=1`。
5. 先观察，再加 HSTS（`Strict-Transport-Security: max-age=31536000`）；确认 HTTPS 稳定后再提交预加载。
6. 验证：登录后 Cookie 带 `Secure`；`http://` 自动跳 `https://`；各科目前缀与 Cookie 共享正常。

### 7.3 邮件服务（已实现：阿里云 DirectMail）

- 接口：`Mailer{Enabled(); Send(ctx,to,subject,text,html)}`；`MAIL_DRIVER=none` 为 no-op，相关端点返回 `503 mail_unavailable`；`MAIL_DRIVER=aliyun` 用官方 `github.com/alibabacloud-go/dm-20151123/v2` Go SDK 调 `SingleSendMail`。
- 配置：`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_DM_ACCOUNT_NAME`（控制台已认证发件地址）、`ALIYUN_DM_FROM_ALIAS`、`ALIYUN_DM_ENDPOINT`（默认 `dm.aliyuncs.com`）、`ALIYUN_DM_REGION`、`PUBLIC_ORIGIN`、`REQUIRE_EMAIL_VERIFY`。
- 令牌：`email_tokens` 存 `SHA-256(token)`，单次使用；verify 24 小时、reset 30 分钟；同一用户同 purpose 只保留最新一条；`0003_email_tokens.sql` 给 `token_hash` 加唯一索引。
- 端点：
  - `POST /auth/verify-email {token}`
  - `POST /auth/request-reset {email}` → 无论邮箱是否存在都 202（防枚举）
  - `POST /auth/reset-password {token,password}` → 成功删除该用户全部会话，并把邮箱标记为已验证（能收到邮件即归属证明）
  - `POST /auth/resend-verify {email}` → 未知/已验证邮箱也 202
- 注册成功即发验证邮件（发送失败只记日志，不影响注册）；`/auth/me` 返回 `email_verified`；`REQUIRE_EMAIL_VERIFY=1` 时未验证登录返回 403 `email_not_verified`（注册仍自动登录，限制在下一次登录生效）。
- 反滥用：request-reset / resend-verify 每 IP+邮箱 3 次/15 分钟；邮件正文只含一次性链接，令牌不写日志。
- 链接：优先 `PUBLIC_ORIGIN`，否则按 `X-Forwarded-Proto/Host/Prefix` 还原；nginx 已加 `X-Forwarded-Proto` 与 `X-Forwarded-Prefix`，门户/本地代理同步透传。
- 阿里云控制台要求：开通邮件推送、认证发件域名/地址、创建发件地址；RAM 用户最小权限 `dm:SingleSendMail`；新账号可能处于沙箱模式，需要先把收件人加入白名单。

### 7.4 origin 切换的关键风险

从 `http://IP/os/` 切到 `https://域名/os/`，**origin 变了**：

- localStorage 是按 origin 隔离的，旧 origin 的进度不会自动出现。
- Cookie 也是按 host 隔离的，需要在域名上重新登录。
- 迁移步骤（手动）：
  1. 旧 origin 先登录，等同步状态显示「已同步」。
  2. 打开新 origin，登录同一账号。
  3. 首屏 `prefetch` 会从云端拉回进度；确认统计数字一致。
  4. 旧 origin 的本地分区可以保留一段时间再清理。
- 若旧 origin 还没登录过（数据只在本机），**先不要切换域名**；先在旧 origin 登录把数据推上去，或手动导出 localStorage。

### 7.5 注册策略

- 首次部署 `REGISTRATION_OPEN=1`，注册站长账号。
- 注册成功后立即改 `.env` 为 `0` 并重启 sync-svc（或热读配置）。
- `REGISTRATION_OPEN=0` 时：
  - `POST /auth/register` 返回 403 `registration_closed`。
  - 若 `users` 表为空，仍允许注册第一个账号（防止把自己锁死）。
- 后期若要开放给他人，再打开开关或改为邀请码。

---

## 8. 部署脚本变更

### 8.1 `scripts/gen-compose.js`

- 新增 `postgres` 服务与 `pgdata` 卷（见 6.1）。
- `sync-svc` 注入 `DATABASE_URL`、`SESSION_TTL`、`REGISTRATION_OPEN`、`COOKIE_SECURE`、`COOKIE_DOMAIN`、`PUBLIC_ORIGIN`、`INTERNAL_TOKEN`。
- `grade-svc-<prefix>` 注入 `AUTH_VERIFY_URL`、`INTERNAL_TOKEN`。
- `portal` 增加 `AUTH_API`（可选；若认证路由统一走 `SYNC_API`，则不需要）。
- `depends_on` 增加健康依赖。

### 8.2 `deploy.sh`

- 构建镜像列表不变（Postgres 用官方镜像，服务器直接拉取）。
- `.env` 管理：
  - 现状只在远端 `.env` 不存在时复制（`deploy.sh:66`）；需要改为「缺失键追加」。
  - 首次生成 `POSTGRES_PASSWORD`、`INTERNAL_TOKEN`（`openssl rand -hex 24`），写入远端 `.env`，**不要回传/提交**。
- 启动前等待 Postgres 健康（`docker compose up -d --wait` 或轮询 `pg_isready`）。
- 探活改造：
  - 静态页不变。
  - `/api/store` 未登录返回 401 是**预期**，不再要求 `{"blob"}`。
  - 新增 `GET /<pre>/api/auth/me` 期望 401（认证链路通）。
  - 非法码探针：路径校验先于会话校验，仍期望 400；若实现顺序调整，则改为期望 401 并同步更新文档。
  - 可选：登录后探针（用测试账号）验证 200 + `{"blob"}`，但不要把测试账号密码写进脚本；建议只在发布后手动验证。
- 数据库备份：发布前在服务器执行一次 `pg_dump`；保留旧 SQLite 卷。

### 8.3 服务器目录/卷

- `/opt/exam-sites/docker-compose.yml` 由生成器产出。
- 卷：`exam-sites_pgdata`（新）、`exam-sites_portal-store`（旧，保留）。
- 备份目录：`/opt/exam-sites/backups/`。

---

## 9. 分阶段 TODO

> 建议按阶段提交，每阶段都可独立回滚。**P0~P3 已完成（见附录 B）；P4 待执行；P5 未开始。**

### P0：PostgreSQL 落地

- [ ] `backend/grade-svc/go.mod` 增加 `github.com/jackc/pgx/v5`、`github.com/pressly/goose/v3`。
- [ ] 新增 `backend/grade-svc/cmd/syncsvc/db.go`：打开连接池、设置超时、执行迁移、健康检查。
- [ ] 新增 `backend/grade-svc/cmd/syncsvc/migrations/0001_init.sql`（第 5.2 节 DDL）。
- [ ] 重写 `store.go` / `rows.go` 的 SQL（占位符、类型、`user_slot`）。
- [ ] `putSlot` 改为事务 + `FOR UPDATE`。
- [ ] `scripts/gen-compose.js` 增加 `postgres` 服务与 `pgdata` 卷。
- [ ] `deploy.sh` 增加 `.env` 键生成、健康等待、探活调整。
- [ ] 测试：`TEST_DATABASE_URL`、随机 schema、跳过逻辑。
- [ ] 验收：`go test ./...` 与 `bun test` 在测试库上全绿；本机 compose 起全栈后注册前手动 GET `/api/store` 仍返回空槽（临时匿名开关）或 401（按 P2 进度）。

### P1：Go 认证核心

- [ ] `backend/grade-svc/cmd/syncsvc/password.go`：PBKDF2 哈希/校验/参数解析。
- [ ] `backend/grade-svc/cmd/syncsvc/session.go`：token 生成/哈希/Cookie 读写/过期清理。
- [ ] `backend/grade-svc/cmd/syncsvc/auth.go`：register/login/logout/me、邮箱校验、限流、`REGISTRATION_OPEN`。
- [ ] `main.go` 挂载 `/auth/*` 与 `/internal/session`。
- [ ] `-reset-password` 管理员 CLI。
- [ ] 单测：`auth_test.go`、`authz_test.go`。
- [ ] 验收：curl 注册→登录→me→登出；Cookie 属性正确；重复邮箱/错密码/限流符合预期。

### P2：同步与判分鉴权 + 代理

- [ ] `/store/*` 要求会话；登录后 slot 只能等于账号 slot；路径格式校验先于会话。
- [ ] 关闭匿名云同步（无会话一律 401）。
- [ ] `grade-svc` 增加会话校验中间件：调用 `/internal/session`，30~60s 缓存，失败关闭。
- [ ] `backend/portal/portal.js`：
  - [ ] 新增 `api/auth/*` 转发。
  - [ ] `api/store`、`api/grade` 转发 `cookie` 与 `x-forwarded-for`。
  - [ ] 认证响应回传 `set-cookie`。
- [ ] `server.js`：
  - [ ] 新增 `/api/auth/*` 转发到线上。
  - [ ] 所有代理转发 `cookie`、回传 `set-cookie`。
  - [ ] `ONLINE` 改为 `ONLINE_ORIGIN` 环境变量。
- [ ] 测试：代理 Cookie 透传、401 透传、auth 路由。
- [ ] 验收：浏览器登录后两设备同步；未登录 `/api/store` 与 `/api/grade` 均 401；登出后立即失效。

### P3：前端登录 UI 与启动流程

- [ ] 新增 `frontend/auth.js`（`window.AUTH`）：`me/register/login/logout`、错误码中文映射。
- [ ] `frontend/identity.js`：账号优先、`setAccount/clearAccount/adoptAnonymous`。
- [ ] `frontend/app.js`：启动改异步；登录态决定是否 `prefetch`；`onUnauthorized` 弹登录。
- [ ] `frontend/sync.js`：`disable()`、401 回调、未登录不排期。
- [ ] `frontend/index.html`：身份弹层改为登录/注册/账号面板；增加 `<script src="auth.js">`。
- [ ] `frontend/styles.css`：表单与账号面板样式。
- [ ] `scripts/stage.js:8`：`ENGINE_FILES` 加 `auth.js`。
- [ ] `tests/server_proxy.test.js:218` 引擎清单加 `auth.js`。
- [ ] 测试：`tests/auth.test.js`、`tests/identity.test.js` 账号用例。
- [ ] 验收：匿名可浏览/本地判分；登录后可同步；手机窄屏表单可用；登出/清除本机数据正常。

### P4：文档、部署、线上验证

- [ ] 更新 `README.md`：身份、云同步、测试、部署、兼容基线。
- [ ] 更新 `AGENTS.md`：技术栈边界、脚本清单、存储约定、测试命令。
- [ ] `./deploy.sh` 发布；线上手动验证：
  - [ ] 注册 → 登录 → 两浏览器同步。
  - [ ] 未登录 GET `/api/store`、POST `/api/grade` 返回 401。
  - [ ] 登出后 Cookie 清除、同步停止。
  - [ ] `/stats` 仅内网可达。
- [ ] 设置 `REGISTRATION_OPEN=0`，重启 sync-svc。

### P5：TLS + 域名 + 邮件（后期）

- [ ] 域名解析、certbot、nginx 443、HSTS、`COOKIE_SECURE=1`。
- [ ] `PUBLIC_ORIGIN` 切换；旧 origin 数据推云后再切。
- [ ] `Mailer` 接口 + SMTP 实现。
- [ ] `verify-email` / `request-reset` / `reset-password` 端点。
- [ ] 邮件限流与防枚举。
- [ ] 评估是否开启 `REQUIRE_EMAIL_VERIFY`。

---

## 10. 测试计划（汇总）

| 测试文件 | 新增/修改 | 覆盖点 |
|---|---|---|
| `backend/grade-svc/cmd/syncsvc/auth_test.go` | 新增 | 注册/登录/登出/me、重复邮箱、弱密码、限流、Cookie 属性 |
| `backend/grade-svc/cmd/syncsvc/authz_test.go` | 新增 | 无会话 401、slot 不匹配 403、`/internal/session` |
| `backend/grade-svc/cmd/syncsvc/store_test.go` | 改写 | Postgres 槽位隔离、合并、清空、非法码 400 |
| `backend/grade-svc/cmd/syncsvc/rows_test.go` | 改写 | 派生行重建、`/stats` 聚合 |
| `backend/grade-svc/auth_test.go` | 新增 | 判分中间件有效/无效/过期/服务不可达 |
| `tests/auth.test.js` | 新增 | `frontend/auth.js` 请求形状、错误码映射 |
| `tests/identity.test.js` | 扩展 | 账号优先、`setAccount/clearAccount/adoptAnonymous`；原匿名码用例保留 |
| `tests/sync.test.js` | 修改 | `prefetch` 登录门控、401 回调、URL 契约 |
| `tests/server_proxy.test.js` | 扩展 | Cookie/Set-Cookie 透传、`/api/auth/*`、引擎清单 |
| `backend/portal/test/portal.test.js` | 扩展 | `api/auth/*` 前缀转发、降级 |
| `backend/portal/test/store.test.js` | 改写 | 登录 Cookie、Postgres 测试库、跳过逻辑 |
| `tests/merge_xcheck.test.js` / `store_golden_test.go` | 不变 | 合并与载荷整形（与 DB 无关） |

验收命令：

```bash
# 1. 启动测试库（一次性）
docker run --rm -d --name exam-pg-test \
  -e POSTGRES_PASSWORD=exam -e POSTGRES_USER=exam -e POSTGRES_DB=exam_test \
  -p 127.0.0.1:5432:5432 postgres:17-alpine

export TEST_DATABASE_URL='postgres://exam:exam@127.0.0.1:5432/exam_test?sslmode=disable'

# 2. Go 单测
cd backend/grade-svc && go test ./...

# 3. 前端/集成测试
cd .. && bun test

# 4. 本地全栈（可选）
bun run build && bun run stage
bun scripts/gen-compose.js --build > build/docker-compose.yml
docker compose -f build/docker-compose.yml up -d
```

---

## 11. 风险与开放问题

### 11.1 风险

1. **HTTP 明文**：密码与会话在公网明文传输；在域名/TLS 上线前，只能接受或限制访问范围。Cookie 暂不能加 `Secure`。
2. **无邮件找回**：忘记密码只能用管理员 CLI；需要把命令写进运维笔记。
3. **Postgres 运维成本**：多容器、卷、备份、升级；服务器资源和备份策略要确认。
4. **测试依赖外部 PG**：默认 `bun test` 会跳过 DB 测试，守卫强度下降；建议把 `TEST_DATABASE_URL` 写进本地开发说明。
5. **origin 切换**：换域名后 localStorage 不迁移；必须先在旧 origin 推云。
6. **注册开放**：若忘记设 `REGISTRATION_OPEN=0`，陌生人可注册；建议首次注册后立即关闭。
7. **会话无感过期**：30 天后需重新登录；可在后期改为滑动续期。
8. **并发写**：现有 `putSlot` 有竞态；换 PG 时用 `FOR UPDATE` 一并修掉，否则多设备同时写可能丢更新。
9. **账号枚举**：登录错误统一 `bad_credentials`；注册重复邮箱会暴露邮箱存在（单人站可接受，多用户时再改）。

### 11.2 待定问题

- PostgreSQL 版本用 17 还是 18（建议 17-alpine，保守）。
- 迁移工具用 goose 还是自写 runner（建议 goose）。
- 会话有效期 30 天还是 90 天（建议 30 天，后期可调）。
- 是否保留 `/api/store/<slot>` 兼容路径（建议保留，减少前端改动；服务端强制一致性校验）。
- 是否保留匿名本地分区（建议保留，登录时搬入账号分区；也可改为直接用裸键）。
- 是否需要「退出所有设备」按钮（建议有，删除全部会话）。
- 是否需要邀请码/注册关闭后的白名单（单人阶段不需要）。

---

## 12. 参考资料

- Go `crypto/pbkdf2`：https://pkg.go.dev/crypto/pbkdf2
- OWASP Password Storage Cheat Sheet：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- `alexedwards/scs`：https://github.com/alexedwards/scs
- PocketBase：https://github.com/pocketbase/pocketbase
- Ory Kratos：https://github.com/ory/kratos
- SuperTokens Core：https://github.com/supertokens/supertokens-core
- Authelia：https://github.com/authelia/authelia
- `jackc/pgx`：https://github.com/jackc/pgx
- `pressly/goose`：https://github.com/pressly/goose
- PostgreSQL 官方文档：https://www.postgresql.org/docs/

---

## 附录 B：实施记录（2026-10-25）

### B.1 已完成

| 阶段 | 内容 | 关键文件 |
|---|---|---|
| P0 | SQLite → PostgreSQL；pgx + goose；`user_slot` 列；PUT 事务 + `FOR UPDATE`；compose 增加 postgres/pgdata；deploy 生成 `POSTGRES_PASSWORD` + 旧卷备份；测试改 `TEST_DATABASE_URL` | `backend/grade-svc/cmd/syncsvc/db.go`、`migrations/0001_init.sql`、`store.go`、`rows.go`、`scripts/gen-compose.js`、`deploy.sh`、`scripts/test-pg.sh`、`backend/portal/test/store.test.js` |
| P1 | 邮箱+密码注册/登录/登出/me；PBKDF2-SHA256 600k；会话表 + HttpOnly Cookie；注册开关/总量上限/限流；管理员重置密码 CLI | `migrations/0002_auth.sql`、`password.go`、`session.go`、`ratelimit.go`、`auth.go`、`main.go` |
| P2 | `/store` 与 `/api/grade` 强制登录；账号 slot 一致性校验；判分服务内网会话校验 + 缓存 + 可选小时配额；门户/本地代理透传 Cookie 与 Set-Cookie；部署探活改为 401 | `cmd/syncsvc/main.go`、`backend/grade-svc/auth.go`、`backend/grade-svc/main.go`、`backend/portal/portal.js`、`server.js`、`deploy.sh` |
| P3 | 前端登录/注册弹层；启动先 `AUTH.me()`；未登录不同步；401 会话失效处理；登录时本机匿名/旧版分区并入账号；新脚本入 stage/测试清单 | `frontend/auth.js`、`frontend/identity.js`、`frontend/app.js`、`frontend/sync.js`、`frontend/index.html`、`frontend/styles.css`、`scripts/stage.js` |
| P5（邮件） | 阿里云 DirectMail：注册验证邮件、验证邮箱、找回密码、重发验证；令牌单次使用（verify 24h / reset 30min）；`0003` 唯一索引；前端「忘记密码」与「设置新密码」视图、`?verify_token=` 自动验证 | `mailer.go`、`auth_mail.go`、`auth_mail_handlers.go`、`migrations/0003_email_tokens.sql`、`frontend/auth.js`、`frontend/app.js`、`frontend/index.html` |

### B.2 与设计稿的差异

- 认证直接并入 `cmd/syncsvc`（未新建 auth-svc 容器）：会话校验由判分服务内网调用，避免多一个镜像/容器与额外数据库隔离成本。
- 会话使用服务端 `sessions` 表 + 不透明 token（非 HMAC 签名 Cookie）：可即时撤销（登出/重置密码删行），判分侧只做内网校验与 45s 缓存。
- 账号 slot 为 10 位（原同步码 6 位）；仍满足 `[a-z2-9]{4,10}`，同步 URL/本地分区键形状不变。
- 开放注册（`REGISTRATION_OPEN` 默认 1），`MAX_USERS` 默认 0（不限）；`GRADE_HOURLY_LIMIT` 默认 0（不限），需要时在 `.env` 开启。
- 旧同步码云端槽位不再对外服务；账号 slot 是纯增量。旧 SQLite 数据不自动导入 PostgreSQL，按 6.5 的手动流程处理。

### B.3 验证结果

```bash
# Go（测试 PostgreSQL 已起）
cd backend/grade-svc && TEST_DATABASE_URL='postgres://exam:exam@127.0.0.1:55432/exam_test?sslmode=disable' go test ./...
#   ok grade-svc
#   ok backend/grade-svc/cmd/syncsvc

# 前端/集成
TEST_DATABASE_URL='postgres://exam:exam@127.0.0.1:55432/exam_test?sslmode=disable' bun test
#   152 pass / 0 fail（13 个文件；含邮件令牌/找回密码假 Mailer 用例）

# 部署物
bash -n deploy.sh
POSTGRES_PASSWORD=testpw docker compose -f <(bun scripts/gen-compose.js --remote) config
```

线上验证（2026-10-26）：
- 容器全部 healthy，迁移到 version 3；`MAIL_DRIVER=none` 日志「邮件服务未启用」。
- `/auth/request-reset` 与 `/auth/resend-verify` 返回 503 `mail_unavailable`；`/auth/verify-email` 坏令牌返回 400 `invalid_token`。
- `MAIL_DRIVER=none` 期间注册/登录不受影响；填入阿里云 AccessKey 与发件地址后重启即可启用。

未执行：域名 + TLS、真实阿里云邮件发送（待站长的 RAM AccessKey 与已认证发件地址）。

## 附录 A：文档初版声明

- 本文件初版是设计文档；阶段 0~3 的代码改动与验证见附录 B，阶段 4/5 仍未执行。
- 后续阶段按第 9 节推进，每阶段单独提交，并在每阶段结束后运行第 10 节的验收命令。