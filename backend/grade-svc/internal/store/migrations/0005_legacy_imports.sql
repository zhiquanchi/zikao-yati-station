-- +goose Up
-- 旧 localStorage 一次性导入标记：每个账号只允许一次（端点下一次发布删除）。
CREATE TABLE IF NOT EXISTS legacy_imports (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  imported_at BIGINT NOT NULL
);

-- +goose Down
DROP TABLE IF EXISTS legacy_imports;