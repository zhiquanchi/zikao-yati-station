-- +goose Up
-- v1 云同步表（整 blob 协议）。v2 只用于一次性迁移，迁移完成后由 apivc -migrate-v1 删除。
CREATE TABLE IF NOT EXISTS sync (
  subject    TEXT   NOT NULL,
  user_slot  TEXT   NOT NULL DEFAULT '',
  blob       TEXT   NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (subject, user_slot)
);

CREATE TABLE IF NOT EXISTS answers (
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

CREATE TABLE IF NOT EXISTS history (
  subject    TEXT   NOT NULL,
  user_slot  TEXT   NOT NULL DEFAULT '',
  qid        BIGINT NOT NULL,
  ts         BIGINT NOT NULL,
  u_json     TEXT,
  s          DOUBLE PRECISION,
  PRIMARY KEY (subject, user_slot, qid, ts)
);

CREATE TABLE IF NOT EXISTS explains (
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