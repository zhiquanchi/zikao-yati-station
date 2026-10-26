// 会话：32 字节随机 token（Base64URL）放 Cookie，数据库只存 SHA-256；
// 默认 30 天有效，登出/改密删行即撤销。Cookie 统一 Path=/，让全部科目与 api 路径共享一次登录。
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	sessionCookieName = "exam_session"
	defaultSessionTTL = 30 * 24 * time.Hour
)

var errNoSession = errors.New("no session")

func sessionTTL() time.Duration {
	if v := strings.TrimSpace(os.Getenv("SESSION_TTL")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return defaultSessionTTL
}

// cookieSecure：COOKIE_SECURE 显式取值优先；auto（缺省）时看 PUBLIC_ORIGIN 是否 https。
func cookieSecure() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("COOKIE_SECURE"))) {
	case "1", "true", "yes":
		return true
	case "0", "false", "no":
		return false
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(os.Getenv("PUBLIC_ORIGIN"))), "https://")
}

func tokenHash(tok string) []byte {
	sum := sha256.Sum256([]byte(tok))
	return sum[:]
}

func newSessionToken() (string, []byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	tok := base64.RawURLEncoding.EncodeToString(b)
	return tok, tokenHash(tok), nil
}

func setSessionCookie(w http.ResponseWriter, tok string, expires time.Time) {
	maxAge := int(time.Until(expires) / time.Second)
	if maxAge < 0 {
		maxAge = 0
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    tok,
		Path:     "/",
		Domain:   strings.TrimSpace(os.Getenv("COOKIE_DOMAIN")),
		HttpOnly: true,
		Secure:   cookieSecure(),
		SameSite: http.SameSiteLaxMode,
		Expires:  expires,
		MaxAge:   maxAge,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		Domain:   strings.TrimSpace(os.Getenv("COOKIE_DOMAIN")),
		HttpOnly: true,
		Secure:   cookieSecure(),
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

func sessionTokenFromRequest(r *http.Request) string {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

type sessionUser struct {
	ID            int64
	Email         string
	Slot          string
	EmailVerified bool
}

func (st *slotStore) createSession(ctx context.Context, userID int64) (string, time.Time, error) {
	tok, sum, err := newSessionToken()
	if err != nil {
		return "", time.Time{}, err
	}
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	now := time.Now()
	expires := now.Add(sessionTTL())
	if _, err := st.db.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
		sum, userID, now.UnixMilli(), expires.UnixMilli()); err != nil {
		return "", time.Time{}, err
	}
	return tok, expires, nil
}

func (st *slotStore) lookupSession(ctx context.Context, tok string) (*sessionUser, error) {
	if tok == "" {
		return nil, errNoSession
	}
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	var u sessionUser
	var expiresAt int64
	var verifiedAt sql.NullInt64
	err := st.db.QueryRowContext(ctx,
		`SELECT u.id, u.email, u.slot, u.email_verified_at, s.expires_at
		   FROM sessions s JOIN users u ON u.id = s.user_id
		  WHERE s.token_hash = $1`, tokenHash(tok)).Scan(&u.ID, &u.Email, &u.Slot, &verifiedAt, &expiresAt)
	if err != nil {
		return nil, errNoSession
	}
	u.EmailVerified = verifiedAt.Valid
	if expiresAt <= time.Now().UnixMilli() {
		_, _ = st.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash(tok))
		return nil, errNoSession
	}
	return &u, nil
}

func (st *slotStore) deleteSession(ctx context.Context, tok string) error {
	if tok == "" {
		return nil
	}
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	_, err := st.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash(tok))
	return err
}

func (st *slotStore) deleteUserSessions(ctx context.Context, userID int64) error {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	_, err := st.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
	return err
}

func (st *slotStore) cleanupExpiredSessions(ctx context.Context) error {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	_, err := st.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= $1`, time.Now().UnixMilli())
	return err
}