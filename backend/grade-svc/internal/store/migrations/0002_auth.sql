-- +goose Up
-- 账号体系：邮箱 + 密码；slot 是存储分区键（[a-z2-9]{4,10}），服务端签发。
CREATE TABLE IF NOT EXISTS users (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email             TEXT   UNIQUE,
  pass_hash         TEXT,
  slot              TEXT   NOT NULL UNIQUE,
  email_verified_at BIGINT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  CONSTRAINT users_slot_fmt CHECK (slot ~ '^[a-z2-9]{4,10}$'),
  CONSTRAINT users_email_lower CHECK (email IS NULL OR email = lower(email))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash BYTEA  PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS email_tokens (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT   NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash BYTEA  NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT
);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id, purpose);
CREATE UNIQUE INDEX IF NOT EXISTS email_tokens_token_hash_idx ON email_tokens (token_hash);

-- +goose Down
DROP TABLE IF EXISTS email_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;