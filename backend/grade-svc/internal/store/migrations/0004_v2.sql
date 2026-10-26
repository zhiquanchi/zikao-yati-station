-- +goose Up
-- v2 进度事实源：服务端是唯一写入方，逐题记录一行；不再保留整 blob 合并协议。
CREATE TABLE IF NOT EXISTS progress (
  subject   TEXT   NOT NULL,
  user_slot TEXT   NOT NULL,
  qid       BIGINT NOT NULL,
  rec       JSONB  NOT NULL,
  seen_at   BIGINT,
  ts        BIGINT NOT NULL,
  PRIMARY KEY (subject, user_slot, qid)
);
CREATE INDEX IF NOT EXISTS progress_slot_idx ON progress (subject, user_slot);

-- 历史归档：每次重做/组卷重置前留档，最多保留 10 条（服务端裁剪）。
CREATE TABLE IF NOT EXISTS histories (
  subject   TEXT   NOT NULL,
  user_slot TEXT   NOT NULL,
  qid       BIGINT NOT NULL,
  ts        BIGINT NOT NULL,
  rec       JSONB  NOT NULL,
  PRIMARY KEY (subject, user_slot, qid, ts)
);
CREATE INDEX IF NOT EXISTS histories_slot_idx ON histories (subject, user_slot);

-- 当前组卷（picked/order/total/seed），关闭组卷即删行。
CREATE TABLE IF NOT EXISTS papers (
  subject   TEXT   NOT NULL,
  user_slot TEXT   NOT NULL,
  payload   JSONB  NOT NULL,
  ts        BIGINT NOT NULL,
  PRIMARY KEY (subject, user_slot)
);

-- 出现标记：题卡进过视口/卷面即记（跨设备一致，参与组卷权重）。
CREATE TABLE IF NOT EXISTS seen (
  subject   TEXT   NOT NULL,
  user_slot TEXT   NOT NULL,
  qid       BIGINT NOT NULL,
  seen_at   BIGINT NOT NULL,
  PRIMARY KEY (subject, user_slot, qid)
);

-- 清空记录时间点：晚于它的旧数据一律无效（服务端已直接删行，保留该行用于统计/审计）。
CREATE TABLE IF NOT EXISTS cleared (
  subject    TEXT   NOT NULL,
  user_slot  TEXT   NOT NULL,
  cleared_at BIGINT NOT NULL,
  PRIMARY KEY (subject, user_slot)
);

-- AI 逐项解析缓存：按题面内容哈希缓存，与用户无关。
CREATE TABLE IF NOT EXISTS explain_cache (
  subject TEXT   NOT NULL,
  qid     BIGINT NOT NULL,
  hash    TEXT   NOT NULL,
  payload JSONB  NOT NULL,
  ts      BIGINT NOT NULL,
  PRIMARY KEY (subject, qid, hash)
);

-- 游客账号：email/pass_hash 可空，is_guest 标记；登录时 claim 并入正式账号。
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN pass_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT false;

-- +goose Down
DROP TABLE IF EXISTS explain_cache;
DROP TABLE IF EXISTS cleared;
DROP TABLE IF EXISTS seen;
DROP TABLE IF EXISTS papers;
DROP TABLE IF EXISTS histories;
DROP TABLE IF EXISTS progress;
ALTER TABLE users DROP COLUMN IF EXISTS is_guest;
ALTER TABLE users ALTER COLUMN pass_hash SET NOT NULL;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;