package auth

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
		Name: sessionCookieName, Value: tok, Path: "/",
		Domain:   strings.TrimSpace(os.Getenv("COOKIE_DOMAIN")),
		HttpOnly: true, Secure: cookieSecure(), SameSite: http.SameSiteLaxMode,
		Expires: expires, MaxAge: maxAge,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: "", Path: "/",
		Domain:   strings.TrimSpace(os.Getenv("COOKIE_DOMAIN")),
		HttpOnly: true, Secure: cookieSecure(), SameSite: http.SameSiteLaxMode,
		Expires: time.Unix(0, 0), MaxAge: -1,
	})
}

func sessionTokenFromRequest(r *http.Request) string {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

type User struct {
	ID       int64
	Email    string
	Slot     string
	Verified bool
	Guest    bool
}

func (s *Service) createSession(ctx context.Context, userID int64) (string, time.Time, error) {
	tok, sum, err := newSessionToken()
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now()
	expires := now.Add(sessionTTL())
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	if _, err := s.DB.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)`,
		sum, userID, now.UnixMilli(), expires.UnixMilli()); err != nil {
		return "", time.Time{}, err
	}
	return tok, expires, nil
}

// Lookup 解析会话 Cookie（httpapi 中间件使用）。
func (s *Service) Lookup(ctx context.Context, r *http.Request) (*User, error) {
	return s.lookupSession(ctx, sessionTokenFromRequest(r))
}

func (s *Service) lookupSession(ctx context.Context, tok string) (*User, error) {
	if tok == "" {
		return nil, errNoSession
	}
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	var u User
	var expiresAt int64
	var verifiedAt sql.NullInt64
	var email sql.NullString
	err := s.DB.QueryRowContext(ctx,
		`SELECT u.id, u.email, u.slot, u.email_verified_at, u.is_guest, s.expires_at
		   FROM sessions s JOIN users u ON u.id = s.user_id
		  WHERE s.token_hash = $1`, tokenHash(tok)).Scan(&u.ID, &email, &u.Slot, &verifiedAt, &u.Guest, &expiresAt)
	if err != nil {
		return nil, errNoSession
	}
	u.Email = email.String
	u.Verified = verifiedAt.Valid
	if expiresAt <= time.Now().UnixMilli() {
		_, _ = s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash(tok))
		return nil, errNoSession
	}
	return &u, nil
}

func (s *Service) deleteSession(ctx context.Context, tok string) error {
	if tok == "" {
		return nil
	}
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash(tok))
	return err
}

func (s *Service) CleanupExpiredSessions(ctx context.Context) error {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= $1`, time.Now().UnixMilli())
	return err
}

// CleanupGuests 删除长期无有效会话的游客账号（默认 7 天前创建）。
func (s *Service) CleanupGuests(ctx context.Context, olderThan time.Time) (int64, error) {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	res, err := s.DB.ExecContext(ctx, `
		DELETE FROM users u
		 WHERE u.is_guest = true
		   AND u.created_at < $1
		   AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > $2)`,
		olderThan.UnixMilli(), time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
