// 账号认证：邮箱 + 密码注册/登录/登出/当前用户，以及供判分服务内网校验的 /internal/session。
// 端点只做协议与安全边界，存储/会话细节分别在 db.go、session.go、password.go。
// 注册默认开放（REGISTRATION_OPEN=1）；可用 REGISTRATION_OPEN=0 关闭（users 为空时仍允许创建首个账号），
// MAX_USERS 可选总量上限；登录/注册均按 IP（+邮箱）固定窗口限流。
package main

import (
	"bufio"
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
	// 与前端 identity.js 的 ALPHA 一致：去掉 i/l/o/0/1，手抄不易错。
	slotAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"
)

type authUser struct {
	Email         string `json:"email"`
	Slot          string `json:"slot"`
	EmailVerified bool   `json:"email_verified"`
}

type authResponse struct {
	User authUser `json:"user"`
}

func decodeAuthJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBody)
	if ct := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))); ct != "" && !strings.HasPrefix(ct, "application/json") {
		writeJSON(w, 415, map[string]string{"error": "unsupported_media_type"})
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad_request"})
		return false
	}
	return true
}

// normalizeEmail：小写归一 + 基础格式校验；拒绝 display name（"Name <a@b>"）。
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

// clientIP：门户/本地代理会转发 X-Forwarded-For；直连时退回 RemoteAddr。
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

// sameOrigin：浏览器带 Origin 时必须与对外 Host 一致（含代理转发的 X-Forwarded-Host）。
// 非浏览器请求（curl/服务端调用）没有 Origin，不拦。
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
	if v == "" {
		return true
	}
	return v == "1" || v == "true" || v == "yes"
}

func maxUsers() int {
	if v := strings.TrimSpace(os.Getenv("MAX_USERS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

func (st *slotStore) newSlot(ctx context.Context) (string, error) {
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
		if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE slot = $1`, slot).Scan(&n); err != nil {
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

// POST /auth/register {email,password}
func (st *slotStore) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]string{"error": "bad_origin"})
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeAuthJSON(w, r, &req) {
		return
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "bad_email"})
		return
	}
	if !validatePassword(req.Password) {
		writeJSON(w, 400, map[string]string{"error": "bad_password"})
		return
	}
	if !st.registerLimiter.allow(clientIP(r), 5, time.Hour) {
		writeJSON(w, 429, map[string]string{"error": "too_many_attempts"})
		return
	}

	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	var count int64
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	// 关闭注册时仍允许创建首个账号，避免把自己锁死。
	if !registrationOpen() && count > 0 {
		writeJSON(w, 403, map[string]string{"error": "registration_closed"})
		return
	}
	if m := maxUsers(); m > 0 && count >= int64(m) {
		writeJSON(w, 403, map[string]string{"error": "registration_closed"})
		return
	}

	hash, err := hashPassword(req.Password)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal"})
		return
	}
	slot, err := st.newSlot(ctx)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	now := time.Now().UnixMilli()
	var id int64
	err = st.db.QueryRowContext(ctx,
		`INSERT INTO users (email, pass_hash, slot, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $4) RETURNING id`,
		email, hash, slot, now).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			writeJSON(w, 409, map[string]string{"error": "email_taken"})
			return
		}
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}

	tok, expires, err := st.createSession(r.Context(), id)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	setSessionCookie(w, tok, expires)
	// 邮件未启用时 no-op；发送失败只记日志，不影响注册。
	st.sendVerifyEmail(r.Context(), id, email, r)
	writeJSON(w, 201, authResponse{User: authUser{Email: email, Slot: slot}})
}

// POST /auth/login {email,password}
func (st *slotStore) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]string{"error": "bad_origin"})
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeAuthJSON(w, r, &req) {
		return
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "bad_email"})
		return
	}
	if req.Password == "" || len(req.Password) > 128 {
		writeJSON(w, 401, map[string]string{"error": "bad_credentials"})
		return
	}
	limitKey := clientIP(r) + "|" + email
	if !st.loginLimiter.allow(limitKey, 10, 10*time.Minute) {
		writeJSON(w, 429, map[string]string{"error": "too_many_attempts"})
		return
	}

	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	var id int64
	var hash, slot string
	var verifiedAt sql.NullInt64
	err := st.db.QueryRowContext(ctx,
		`SELECT id, pass_hash, slot, email_verified_at FROM users WHERE email = $1`, email).Scan(&id, &hash, &slot, &verifiedAt)
	if err != nil {
		writeJSON(w, 401, map[string]string{"error": "bad_credentials"})
		return
	}
	ok, needsRehash := verifyPassword(hash, req.Password)
	if !ok {
		writeJSON(w, 401, map[string]string{"error": "bad_credentials"})
		return
	}
	if requireEmailVerify() && !verifiedAt.Valid {
		writeJSON(w, 403, map[string]string{"error": "email_not_verified"})
		return
	}
	if needsRehash {
		if newHash, err := hashPassword(req.Password); err == nil {
			_, _ = st.db.ExecContext(ctx,
				`UPDATE users SET pass_hash = $1, updated_at = $2 WHERE id = $3`,
				newHash, time.Now().UnixMilli(), id)
		}
	}

	tok, expires, err := st.createSession(r.Context(), id)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	st.loginLimiter.reset(limitKey)
	setSessionCookie(w, tok, expires)
	writeJSON(w, 200, authResponse{User: authUser{Email: email, Slot: slot, EmailVerified: verifiedAt.Valid}})
}

// POST /auth/logout：幂等；无会话也返回 204 并清 Cookie。
func (st *slotStore) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]string{"error": "bad_origin"})
		return
	}
	_ = st.deleteSession(r.Context(), sessionTokenFromRequest(r))
	clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

// GET /auth/me
func (st *slotStore) handleMe(w http.ResponseWriter, r *http.Request) {
	u, err := st.lookupSession(r.Context(), sessionTokenFromRequest(r))
	if err != nil {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	writeJSON(w, 200, authResponse{User: authUser{Email: u.Email, Slot: u.Slot, EmailVerified: u.EmailVerified}})
}

// GET /internal/session：判分服务内网校验，门户不转发；可选 INTERNAL_TOKEN 头做防御纵深。
func (st *slotStore) handleInternalSession(w http.ResponseWriter, r *http.Request) {
	if want := strings.TrimSpace(os.Getenv("INTERNAL_TOKEN")); want != "" {
		got := r.Header.Get("X-Internal-Token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
	}
	u, err := st.lookupSession(r.Context(), sessionTokenFromRequest(r))
	if err != nil {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	writeJSON(w, 200, authResponse{User: authUser{Email: u.Email, Slot: u.Slot, EmailVerified: u.EmailVerified}})
}

// 管理员 CLI（无邮件服务期间的找回密码兜底）：
//
//	syncsvc -reset-password <email>   # 新密码从 stdin 读一行
func runResetPassword() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatalf("缺少 DATABASE_URL（PostgreSQL DSN）")
	}
	if len(os.Args) < 3 {
		log.Fatalf("用法：syncsvc -reset-password <email>（新密码从 stdin 读一行）")
	}
	email, ok := normalizeEmail(os.Args[2])
	if !ok {
		log.Fatalf("邮箱格式不合法：%s", os.Args[2])
	}
	sc := bufio.NewScanner(os.Stdin)
	if !sc.Scan() {
		log.Fatalf("未从 stdin 读到新密码")
	}
	pw := strings.TrimRight(sc.Text(), "\r\n")
	if !validatePassword(pw) {
		log.Fatalf("密码需 8~128 字符")
	}
	hash, err := hashPassword(pw)
	if err != nil {
		log.Fatalf("密码哈希失败：%v", err)
	}
	st, err := openStore(dsn)
	if err != nil {
		log.Fatalf("数据库初始化失败：%v", err)
	}
	defer st.db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := st.db.ExecContext(ctx,
		`UPDATE users SET pass_hash = $1, updated_at = $2 WHERE email = $3`,
		hash, time.Now().UnixMilli(), email)
	if err != nil {
		log.Fatalf("更新密码失败：%v", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		log.Fatalf("用户不存在：%s", email)
	}
	if _, err := st.db.ExecContext(ctx,
		`DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)`, email); err != nil {
		log.Fatalf("失效会话失败：%v", err)
	}
	fmt.Println("密码已重置，现有会话已全部失效")
}