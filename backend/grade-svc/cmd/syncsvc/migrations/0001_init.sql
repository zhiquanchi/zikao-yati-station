-- +goose Up
-- 云同步事实源：整 blob 仍是合并协议的唯一事实，派生行表可从本表全量重建。
-- user_slot 沿用旧同步码规则（[a-z2-9]{4,10}）；'' 保留给旧版兼容槽，便于导入/回滚。
CREATE TABLE sync (
  subject    TEXT   NOT NULL,
  user_slot  TEXT   NOT NULL DEFAULT '',
  blob       TEXT   NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (subject, user_slot)
);

-- 派生读模型：每次 PUT 合并后同事务展开，供 /stats 直接 SQL 聚合。
CREATE TABLE answers (
  subject    TEXT   NOT NULL,
  user_slot  TEXT   NOT NULL DEFAULT '',
  qid        BIGINT NOT NULL,
  u_json     TEXT,
  s          DOUBLE PRECISION,
  v          DOUBLE PRECISION,
  g_score    DOUBLE PRECISION,
  ts         BIGINT NOT NULL,
  rec        TEXT   NOT NULL,
  PRIMARY KEY (subject, user_slot, qid)
);

CREATE TABLE history (
  subject    TEXT   NOT NULL,
  user_slot  TEXT   NOT NULL DEFAULT '',
  qid        BIGINT NOT NULL,
  ts         BIGINT NOT NULL,
  u_json     TEXT,
  s          DOUBLE PRECISION,
  PRIMARY KEY (subject, user_slot, qid, ts)
);

CREATE TABLE explains (
  subject    TEXT   NOT NULL,
  user_slot  TEXT   NOT NULL DEFAULT '',
  qid        BIGINT NOT NULL,
  ts         BIGINT NOT NULL,
  payload    TEXT   NOT NULL,
  PRIMARY KEY (subject, user_slot, qid)
);

-- +goose Down
DROP TABLE IF EXISTS explains;
DROP TABLE IF EXISTS history;
DROP TABLE IF EXISTS answers;
DROP TABLE IF EXISTS sync;