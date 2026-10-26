package auth

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

func (s *Service) mailEnabled() bool { return s.Mailer != nil && s.Mailer.Enabled() }

func (s *Service) issueEmailToken(ctx context.Context, userID int64, purpose string, ttl time.Duration) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM email_tokens WHERE user_id=$1 AND purpose=$2`, userID, purpose); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO email_tokens (user_id,purpose,token_hash,expires_at) VALUES ($1,$2,$3,$4)`,
		userID, purpose, sum[:], time.Now().Add(ttl).UnixMilli()); err != nil {
		return "", err
	}
	return token, tx.Commit()
}

func (s *Service) consumeEmailToken(ctx context.Context, purpose, token string) (int64, error) {
	if token == "" {
		return 0, errInvalidToken
	}
	sum := sha256.Sum256([]byte(token))
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var id, userID, expiresAt int64
	err = tx.QueryRowContext(ctx,
		`SELECT id, user_id, expires_at FROM email_tokens
		  WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL FOR UPDATE`,
		sum[:], purpose).Scan(&id, &userID, &expiresAt)
	if err != nil || expiresAt <= time.Now().UnixMilli() {
		return 0, errInvalidToken
	}
	if _, err := tx.ExecContext(ctx, `UPDATE email_tokens SET used_at=$1 WHERE id=$2`, time.Now().UnixMilli(), id); err != nil {
		return 0, err
	}
	return userID, tx.Commit()
}

func (s *Service) sendVerifyEmail(ctx context.Context, userID int64, to string, r *http.Request) {
	if !s.mailEnabled() {
		return
	}
	token, err := s.issueEmailToken(ctx, userID, tokenPurposeVerify, verifyTTL)
	if err != nil {
		log.Printf("签发验证令牌失败：%v", err)
		return
	}
	link := emailLink(r, "verify_token", token)
	text := fmt.Sprintf("点击下面的链接验证你的邮箱（24 小时内有效）：\n\n%s\n\n如果这不是你的操作，请忽略此邮件。", link)
	body := fmt.Sprintf(`<p>点击下面的链接验证你的邮箱（24 小时内有效）：</p><p><a href="%s">%s</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
		html.EscapeString(link), html.EscapeString(link))
	if err := s.Mailer.Send(ctx, to, "验证邮箱 · 自考押题站", text, body); err != nil {
		log.Printf("发送验证邮件失败（%s）：%v", to, err)
	}
}

func (s *Service) sendResetEmail(ctx context.Context, userID int64, to string, r *http.Request) {
	if !s.mailEnabled() {
		return
	}
	token, err := s.issueEmailToken(ctx, userID, tokenPurposeReset, resetTTL)
	if err != nil {
		log.Printf("签发重置令牌失败：%v", err)
		return
	}
	link := emailLink(r, "reset_token", token)
	text := fmt.Sprintf("点击下面的链接重置密码（30 分钟内有效）：\n\n%s\n\n如果这不是你的操作，请忽略此邮件。", link)
	body := fmt.Sprintf(`<p>点击下面的链接重置密码（30 分钟内有效）：</p><p><a href="%s">%s</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
		html.EscapeString(link), html.EscapeString(link))
	if err := s.Mailer.Send(ctx, to, "重置密码 · 自考押题站", text, body); err != nil {
		log.Printf("发送重置邮件失败（%s）：%v", to, err)
	}
}

// emailLink 优先 PUBLIC_ORIGIN，否则按 X-Forwarded-* 还原；页面地址固定为首页（科目由前端按路径识别）。
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
	if prefix == "" || prefix == "/" {
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
