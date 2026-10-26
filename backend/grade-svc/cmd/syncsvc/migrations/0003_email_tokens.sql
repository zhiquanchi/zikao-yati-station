-- +goose Up
-- 邮件令牌按 token_hash 精确查找；唯一索引避免重复行并让 consume 的 FOR UPDATE 走索引。
CREATE UNIQUE INDEX IF NOT EXISTS email_tokens_token_hash_idx ON email_tokens (token_hash);

-- +goose Down
DROP INDEX IF EXISTS email_tokens_token_hash_idx;