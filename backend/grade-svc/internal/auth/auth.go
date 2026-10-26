// 认证服务：注册/登录/登出/游客/找回密码/邮箱验证。所有校验与状态都在这里，
// 前端只发请求与展示错误码。游客会话由服务端签发，登录时自动并入正式账号。
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	maxAuthBody    = 16 << 10
	accountSlotLen = 10
	slotAlphabet   = "abcdefghjkmnpqrstuvwxyz23456789"
)

type Service struct {
	DB              *sql.DB
	Mailer          Mailer
	loginLimiter    *rateLimiter
	registerLimiter *rateLimiter
	mailLimiter     *rateLimiter
	guestLimiter    *rateLimiter
}

func New(db *sql.DB) *Service {
	return &Service{
		DB:              db,
		Mailer:          newMailerFromEnv(),
		loginLimiter:    newRateLimiter(),
		registerLimiter: newRateLimiter(),
		mailLimiter:     newRateLimiter(),
		guestLimiter:    newRateLimiter(),
	}
}

type apiUser struct {
	Email         string `json:"email"`
	Slot          string `json:"slot"`
	EmailVerified bool   `json:"email_verified"`
	Guest         bool   `json:"guest"`
}

type authResponse struct {
	User apiUser `json:"user"`
}

func toAPI(u *User) apiUser {
	return apiUser{Email: u.Email, Slot: u.Slot, EmailVerified: u.Verified, Guest: u.Guest}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func withTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 5*time.Second)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBody)
	if ct := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))); ct != "" && !strings.HasPrefix(ct, "application/json") {
		writeErr(w, 415, "unsupported_media_type")
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, 400, "bad_request")
		return false
	}
	return true
}

func normalizeEmail(raw string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" || len(s) > 254 {
		return "", false
	}
	addr, err := mail.ParseAddress(s)
	if err != nil || addr.Address != s {
		return "", false
	}
	at := strings.LastIndexByte(s, '@')
	if at <= 0 || at == len(s)-1 {
		return "", false
	}
	return s, true
}

func clientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			xff = xff[:i]
		}
		if ip := strings.TrimSpace(xff); ip != "" {
			return ip
		}
	}
	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
		return xr
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func sameOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	if origin == "null" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	return strings.EqualFold(u.Host, host)
}

func registrationOpen() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("REGISTRATION_OPEN")))
	return v == "" || v == "1" || v == "true" || v == "yes"
}

func maxUsers() int {
	if v := strings.TrimSpace(os.Getenv("MAX_USERS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

func requireEmailVerify() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("REQUIRE_EMAIL_VERIFY")))
	return v == "1" || v == "true" || v == "yes"
}

func (s *Service) newSlot(ctx context.Context) (string, error) {
	for i := 0; i < 20; i++ {
		b := make([]byte, accountSlotLen)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		var sb strings.Builder
		for _, v := range b {
			sb.WriteByte(slotAlphabet[int(v)%len(slotAlphabet)])
		}
		slot := sb.String()
		var n int
		if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE slot=$1`, slot).Scan(&n); err != nil {
			return "", err
		}
		if n == 0 {
			return slot, nil
		}
	}
	return "", errors.New("生成账号分区键冲突")
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// currentUser 读取请求现有会话（可能为空/游客）。
func (s *Service) currentUser(r *http.Request) *User {
	u, err := s.lookupSession(r.Context(), sessionTokenFromRequest(r))
	if err != nil {
		return nil
	}
	return u
}

// ——— 游客 ———

// POST /api/v1/auth/guest：无会话时签发游客；已有会话直接返回。
func (s *Service) HandleGuest(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, 403, "bad_origin")
		return
	}
	if u := s.currentUser(r); u != nil {
		writeJSON(w, 200, authResponse{User: toAPI(u)})
		return
	}
	if !s.guestLimiter.allow(clientIP(r), 20, time.Hour) {
		writeErr(w, 429, "too_many_attempts")
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	slot, err := s.newSlot(ctx)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	now := time.Now().UnixMilli()
	var id int64
	if err := s.DB.QueryRowContext(ctx,
		`INSERT INTO users (email,pass_hash,slot,is_guest,created_at,updated_at) VALUES (NULL,NULL,$1,true,$2,$2) RETURNING id`,
		slot, now).Scan(&id); err != nil {
		writeErr(w, 500, "internal")
		return
	}
	tok, expires, err := s.createSession(ctx, id)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	setSessionCookie(w, tok, expires)
	writeJSON(w, 200, authResponse{User: apiUser{Slot: slot, Guest: true}})
}

// ——— 注册 / 登录 ———

func (s *Service) HandleRegister(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, 403, "bad_origin")
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		writeErr(w, 400, "bad_email")
		return
	}
	if !validatePassword(req.Password) {
		writeErr(w, 400, "bad_password")
		return
	}
	if !s.registerLimiter.allow(clientIP(r), 5, time.Hour) {
		writeErr(w, 429, "too_many_attempts")
		return
	}
	prev := s.currentUser(r) // 可能是游客：注册成功后并入

	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	var count int64
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_guest = false`).Scan(&count); err != nil {
		writeErr(w, 500, "internal")
		return
	}
	if !registrationOpen() && count > 0 {
		writeErr(w, 403, "registration_closed")
		return
	}
	if m := maxUsers(); m > 0 && count >= int64(m) {
		writeErr(w, 403, "registration_closed")
		return
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	slot, err := s.newSlot(ctx)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	now := time.Now().UnixMilli()
	var id int64
	err = s.DB.QueryRowContext(ctx,
		`INSERT INTO users (email,pass_hash,slot,is_guest,created_at,updated_at) VALUES ($1,$2,$3,false,$4,$4) RETURNING id`,
		email, hash, slot, now).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			writeErr(w, 409, "email_taken")
			return
		}
		writeErr(w, 500, "internal")
		return
	}
	if prev != nil && prev.Guest {
		_ = s.claimSlot(ctx, prev.Slot, slot, prev.ID)
	}
	tok, expires, err := s.createSession(ctx, id)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	setSessionCookie(w, tok, expires)
	s.sendVerifyEmail(ctx, id, email, r)
	writeJSON(w, 201, authResponse{User: apiUser{Email: email, Slot: slot}})
}

func (s *Service) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, 403, "bad_origin")
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		writeErr(w, 400, "bad_email")
		return
	}
	if req.Password == "" || len(req.Password) > 128 {
		writeErr(w, 401, "bad_credentials")
		return
	}
	key := clientIP(r) + "|" + email
	if !s.loginLimiter.allow(key, 10, 10*time.Minute) {
		writeErr(w, 429, "too_many_attempts")
		return
	}
	prev := s.currentUser(r)

	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	var id int64
	var hash, slot string
	var verifiedAt sql.NullInt64
	err := s.DB.QueryRowContext(ctx,
		`SELECT id, pass_hash, slot, email_verified_at FROM users WHERE email=$1 AND is_guest=false`, email).
		Scan(&id, &hash, &slot, &verifiedAt)
	if err != nil {
		writeErr(w, 401, "bad_credentials")
		return
	}
	ok, needsRehash := verifyPassword(hash, req.Password)
	if !ok {
		writeErr(w, 401, "bad_credentials")
		return
	}
	if requireEmailVerify() && !verifiedAt.Valid {
		writeErr(w, 403, "email_not_verified")
		return
	}
	if needsRehash {
		if newHash, err := hashPassword(req.Password); err == nil {
			_, _ = s.DB.ExecContext(ctx, `UPDATE users SET pass_hash=$1, updated_at=$2 WHERE id=$3`, newHash, time.Now().UnixMilli(), id)
		}
	}
	if prev != nil && prev.Guest {
		_ = s.claimSlot(ctx, prev.Slot, slot, prev.ID)
	}
	tok, expires, err := s.createSession(ctx, id)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	s.loginLimiter.reset(key)
	setSessionCookie(w, tok, expires)
	writeJSON(w, 200, authResponse{User: apiUser{Email: email, Slot: slot, EmailVerified: verifiedAt.Valid}})
}

func (s *Service) HandleLogout(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, 403, "bad_origin")
		return
	}
	_ = s.deleteSession(r.Context(), sessionTokenFromRequest(r))
	clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) HandleMe(w http.ResponseWriter, r *http.Request) {
	u, err := s.lookupSession(r.Context(), sessionTokenFromRequest(r))
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	writeJSON(w, 200, authResponse{User: toAPI(u)})
}

// HandleClaim 显式并入游客进度（客户端在迁移旧本机数据后调用）。
func (s *Service) HandleClaim(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, 403, "bad_origin")
		return
	}
	u, err := s.lookupSession(r.Context(), sessionTokenFromRequest(r))
	if err != nil || u.Guest {
		writeErr(w, 401, "unauthorized")
		return
	}
	var req struct {
		GuestSlot string `json:"guest_slot"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	slot := strings.TrimSpace(req.GuestSlot)
	if slot == "" || slot == u.Slot {
		writeErr(w, 400, "bad_request")
		return
	}
	var guestID int64
	var isGuest bool
	err = s.DB.QueryRowContext(r.Context(), `SELECT id, is_guest FROM users WHERE slot=$1`, slot).Scan(&guestID, &isGuest)
	if err != nil || !isGuest {
		writeErr(w, 400, "not_guest")
		return
	}
	if err := s.claimSlot(r.Context(), slot, u.Slot, guestID); err != nil {
		writeErr(w, 500, "internal")
		return
	}
	writeJSON(w, 200, authResponse{User: toAPI(u)})
}

// claimSlot 把游客槽位的全部进度并入账号槽位，然后删除游客。
func (s *Service) claimSlot(ctx context.Context, from, to string, guestID int64) error {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmts := []string{
		`INSERT INTO progress (subject,user_slot,qid,rec,seen_at,ts)
		 SELECT subject,$2,qid,rec,seen_at,ts FROM progress WHERE user_slot=$1
		 ON CONFLICT (subject,user_slot,qid) DO UPDATE
		 SET rec = CASE WHEN excluded.ts > progress.ts THEN excluded.rec ELSE progress.rec END,
		     ts = GREATEST(progress.ts, excluded.ts),
		     seen_at = COALESCE(progress.seen_at, excluded.seen_at)`,
		`INSERT INTO histories (subject,user_slot,qid,ts,rec)
		 SELECT subject,$2,qid,ts,rec FROM histories WHERE user_slot=$1
		 ON CONFLICT DO NOTHING`,
		`INSERT INTO papers (subject,user_slot,payload,ts)
		 SELECT subject,$2,payload,ts FROM papers WHERE user_slot=$1
		 ON CONFLICT (subject,user_slot) DO UPDATE SET payload=excluded.payload, ts=excluded.ts WHERE excluded.ts > papers.ts`,
		`INSERT INTO seen (subject,user_slot,qid,seen_at)
		 SELECT subject,$2,qid,seen_at FROM seen WHERE user_slot=$1
		 ON CONFLICT DO NOTHING`,
		`INSERT INTO cleared (subject,user_slot,cleared_at)
		 SELECT subject,$2,cleared_at FROM cleared WHERE user_slot=$1
		 ON CONFLICT (subject,user_slot) DO UPDATE SET cleared_at=GREATEST(cleared.cleared_at, excluded.cleared_at)`,
	}
	for _, q := range stmts {
		if _, err := tx.ExecContext(ctx, q, from, to); err != nil {
			return err
		}
	}
	for _, t := range []string{"progress", "histories", "papers", "seen", "cleared"} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+t+` WHERE user_slot=$1`, from); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id=$1 AND is_guest=true`, guestID); err != nil {
		return err
	}
	return tx.Commit()
}

// ——— 邮件流程 ———

func (s *Service) HandleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, 403, "bad_origin")
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	userID, err := s.consumeEmailToken(r.Context(), tokenPurposeVerify, strings.TrimSpace(req.Token))
	if err != nil {
		writeErr(w, 400, "invalid_token")
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	now := time.Now().UnixMilli()
	if _, err := s.DB.ExecContext(ctx,
		`UPDATE users SET email_verified_at=COALESCE(email_verified_at,$1), updated_at=$1 WHERE id=$2`, now, userID); err != nil {
		writeErr(w, 500, "internal")
		return
	}
	var email sql.NullString
	var slot string
	var verifiedAt sql.NullInt64
	if err := s.DB.QueryRowContext(ctx, `SELECT email,slot,email_verified_at FROM users WHERE id=$1`, userID).
		Scan(&email, &slot, &verifiedAt); err != nil {
		writeErr(w, 500, "internal")
		return
	}
	writeJSON(w, 200, authResponse{User: apiUser{Email: email.String, Slot: slot, EmailVerified: verifiedAt.Valid}})
}

func (s *Service) HandleRequestReset(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, 403, "bad_origin")
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		writeErr(w, 400, "bad_email")
		return
	}
	if !s.mailEnabled() {
		writeErr(w, 503, "mail_unavailable")
		return
	}
	if !s.mailLimiter.allow("reset|"+clientIP(r)+"|"+email, 3, 15*time.Minute) {
		writeErr(w, 429, "too_many_attempts")
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	var userID int64
	if err := s.DB.QueryRowContext(ctx, `SELECT id FROM users WHERE email=$1 AND is_guest=false`, email).Scan(&userID); err == nil {
		s.sendResetEmail(r.Context(), userID, email, r)
	}
	writeJSON(w, 202, map[string]any{"ok": true})
}

func (s *Service) HandleResetPassword(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, 403, "bad_origin")
		return
	}
	var req struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validatePassword(req.Password) {
		writeErr(w, 400, "bad_password")
		return
	}
	userID, err := s.consumeEmailToken(r.Context(), tokenPurposeReset, strings.TrimSpace(req.Token))
	if err != nil {
		writeErr(w, 400, "invalid_token")
		return
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	defer tx.Rollback()
	now := time.Now().UnixMilli()
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET pass_hash=$1, email_verified_at=COALESCE(email_verified_at,$2), updated_at=$2 WHERE id=$3`,
		hash, now, userID); err != nil {
		writeErr(w, 500, "internal")
		return
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=$1`, userID); err != nil {
		writeErr(w, 500, "internal")
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, 500, "internal")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Service) HandleResendVerify(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, 403, "bad_origin")
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		writeErr(w, 400, "bad_email")
		return
	}
	if !s.mailEnabled() {
		writeErr(w, 503, "mail_unavailable")
		return
	}
	if !s.mailLimiter.allow("verify|"+clientIP(r)+"|"+email, 3, 15*time.Minute) {
		writeErr(w, 429, "too_many_attempts")
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	var userID int64
	var verifiedAt sql.NullInt64
	if err := s.DB.QueryRowContext(ctx, `SELECT id,email_verified_at FROM users WHERE email=$1`, email).
		Scan(&userID, &verifiedAt); err == nil && !verifiedAt.Valid {
		s.sendVerifyEmail(r.Context(), userID, email, r)
	}
	writeJSON(w, 202, map[string]any{"ok": true})
}

// ——— 管理员 CLI ———

// ResetPassword 供 apivc -reset-password <email> 使用。
func (s *Service) ResetPassword(email, password string) error {
	if !validatePassword(password) {
		return fmt.Errorf("密码需 8~128 字符")
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	ctx, cancel := withTimeout(context.Background())
	defer cancel()
	res, err := s.DB.ExecContext(ctx, `UPDATE users SET pass_hash=$1, updated_at=$2 WHERE email=$3`,
		hash, time.Now().UnixMilli(), email)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("用户不存在：%s", email)
	}
	_, err = s.DB.ExecContext(ctx,
		`DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=$1)`, email)
	return err
}

// InternalSession 供网关/后续内部调用校验会话（可选 INTERNAL_TOKEN）。
func (s *Service) InternalSession(w http.ResponseWriter, r *http.Request) {
	if want := strings.TrimSpace(os.Getenv("INTERNAL_TOKEN")); want != "" {
		got := r.Header.Get("X-Internal-Token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			writeErr(w, 401, "unauthorized")
			return
		}
	}
	u, err := s.lookupSession(r.Context(), sessionTokenFromRequest(r))
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	writeJSON(w, 200, authResponse{User: toAPI(u)})
}

var _ = log.Printf
