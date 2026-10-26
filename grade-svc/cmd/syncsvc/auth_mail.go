// 邮件令牌与邮件内容：验证邮箱（24h）与找回密码（30min），单次使用、库里只存 SHA-256。
// 链接优先用 PUBLIC_ORIGIN；未配置时按请求的 X-Forwarded-* 还原，前缀由门户/本地代理透传。
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	tokenPurposeVerify = "verify"
	tokenPurposeReset  = "reset"
	verifyTTL          = 24 * time.Hour
	resetTTL           = 30 * time.Minute
)

var errInvalidToken = errors.New("invalid token")

func (st *slotStore) mailEnabled() bool {
	return st.mailer != nil && st.mailer.Enabled()
}

// issueEmailToken：生成 32 字节随机令牌，删除同用户同用途的旧令牌后写入。
// 返回明文令牌（只出现在邮件链接里，不入库、不写日志）。
func (st *slotStore) issueEmailToken(ctx context.Context, userID int64, purpose string, ttl time.Duration) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))

	ctx, cancel := withTimeout(ctx)
	defer cancel()
	tx, err := st.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2`, userID, purpose); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
		userID, purpose, sum[:], time.Now().Add(ttl).UnixMilli()); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return token, nil
}

// consumeEmailToken：按 token_hash 找到未使用且未过期的令牌，标记 used_at 并返回 user_id。
func (st *slotStore) consumeEmailToken(ctx context.Context, purpose, token string) (int64, error) {
	if token == "" {
		return 0, errInvalidToken
	}
	sum := sha256.Sum256([]byte(token))
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	tx, err := st.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var id, userID, expiresAt int64
	err = tx.QueryRowContext(ctx,
		`SELECT id, user_id, expires_at FROM email_tokens
		  WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL
		  FOR UPDATE`, sum[:], purpose).Scan(&id, &userID, &expiresAt)
	if err != nil {
		return 0, errInvalidToken
	}
	if expiresAt <= time.Now().UnixMilli() {
		return 0, errInvalidToken
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE email_tokens SET used_at = $1 WHERE id = $2`, time.Now().UnixMilli(), id); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return userID, nil
}

func (st *slotStore) sendVerifyEmail(ctx context.Context, userID int64, to string, r *http.Request) {
	if !st.mailEnabled() {
		return
	}
	token, err := st.issueEmailToken(ctx, userID, tokenPurposeVerify, verifyTTL)
	if err != nil {
		log.Printf("签发邮箱验证令牌失败（%s）：%v", to, err)
		return
	}
	link := emailLink(r, "verify_token", token)
	subject := "验证邮箱 · 自考押题站"
	text := fmt.Sprintf("点击下面的链接验证你的邮箱（24 小时内有效）：\n\n%s\n\n如果这不是你的操作，请忽略此邮件。", link)
	htmlBody := fmt.Sprintf(
		`<p>点击下面的链接验证你的邮箱（24 小时内有效）：</p><p><a href="%s">%s</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
		html.EscapeString(link), html.EscapeString(link))
	if err := st.mailer.Send(ctx, to, subject, text, htmlBody); err != nil {
		log.Printf("发送验证邮件失败（%s）：%v", to, err)
	}
}

func (st *slotStore) sendResetEmail(ctx context.Context, userID int64, to string, r *http.Request) {
	if !st.mailEnabled() {
		return
	}
	token, err := st.issueEmailToken(ctx, userID, tokenPurposeReset, resetTTL)
	if err != nil {
		log.Printf("签发密码重置令牌失败（%s）：%v", to, err)
		return
	}
	link := emailLink(r, "reset_token", token)
	subject := "重置密码 · 自考押题站"
	text := fmt.Sprintf("点击下面的链接重置密码（30 分钟内有效）：\n\n%s\n\n如果这不是你的操作，请忽略此邮件。", link)
	htmlBody := fmt.Sprintf(
		`<p>点击下面的链接重置密码（30 分钟内有效）：</p><p><a href="%s">%s</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
		html.EscapeString(link), html.EscapeString(link))
	if err := st.mailer.Send(ctx, to, subject, text, htmlBody); err != nil {
		log.Printf("发送密码重置邮件失败（%s）：%v", to, err)
	}
}

// emailLink：PUBLIC_ORIGIN 优先；否则用 X-Forwarded-Proto/Host 还原对外地址。
// X-Forwarded-Prefix 由 portal.js/server.js 透传（如 /os/），保证链接落在当前科目页。
func emailLink(r *http.Request, key, token string) string {
	origin := strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_ORIGIN")), "/")
	if origin == "" {
		scheme := "http"
		if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
			scheme = "https"
		}
		host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
		if host == "" {
			host = r.Host
		}
		origin = scheme + "://" + host
	}
	prefix := strings.TrimSpace(r.Header.Get("X-Forwarded-Prefix"))
	if prefix == "" {
		prefix = "/"
	}
	if !strings.HasPrefix(prefix, "/") {
		prefix = "/" + prefix
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return origin + prefix + "?" + key + "=" + url.QueryEscape(token)
}