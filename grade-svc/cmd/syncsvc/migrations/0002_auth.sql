-- +goose Up
-- 账号体系：邮箱 + 密码；slot 是账号的存储分区键（沿用同步码字符集 [a-z2-9]{4,10}），
-- 前端 localStorage 分区与 /api/store 槽位都复用它，避免改动已验证的同步协议。
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

-- 会话：浏览器只拿随机 token，库里只存 SHA-256，登出/改密可直接删行撤销。
CREATE TABLE sessions (
  token_hash BYTEA  PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

-- 预留：邮箱验证 / 找回密码（本轮只建表；接邮件服务后启用）。
CREATE TABLE email_tokens (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT   NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash BYTEA  NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT
);
CREATE INDEX email_tokens_user_idx ON email_tokens(user_id, purpose);

-- +goose Down
DROP TABLE IF EXISTS email_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;