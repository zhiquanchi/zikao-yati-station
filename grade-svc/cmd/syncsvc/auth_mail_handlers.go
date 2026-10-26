// 邮件相关认证端点：验证邮箱、请求重置、重置密码、重发验证邮件。
// 所有「发送类」接口对未知邮箱也返回 202，避免账号枚举；邮件未配置时统一 503 mail_unavailable。
package main

import (
	"database/sql"
	"net/http"
	"os"
	"strings"
	"time"
)

func requireEmailVerify() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("REQUIRE_EMAIL_VERIFY")))
	return v == "1" || v == "true" || v == "yes"
}

// POST /auth/verify-email {token}
func (st *slotStore) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]string{"error": "bad_origin"})
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if !decodeAuthJSON(w, r, &req) {
		return
	}
	userID, err := st.consumeEmailToken(r.Context(), tokenPurposeVerify, strings.TrimSpace(req.Token))
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid_token"})
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	now := time.Now().UnixMilli()
	if _, err := st.db.ExecContext(ctx,
		`UPDATE users SET email_verified_at = COALESCE(email_verified_at, $1), updated_at = $1 WHERE id = $2`,
		now, userID); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	var email, slot string
	var verifiedAt sql.NullInt64
	if err := st.db.QueryRowContext(ctx,
		`SELECT email, slot, email_verified_at FROM users WHERE id = $1`, userID).Scan(&email, &slot, &verifiedAt); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	writeJSON(w, 200, authResponse{User: authUser{Email: email, Slot: slot, EmailVerified: verifiedAt.Valid}})
}

// POST /auth/request-reset {email}：无论邮箱是否存在都返回 202。
func (st *slotStore) handleRequestReset(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]string{"error": "bad_origin"})
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if !decodeAuthJSON(w, r, &req) {
		return
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "bad_email"})
		return
	}
	if !st.mailEnabled() {
		writeJSON(w, 503, map[string]string{"error": "mail_unavailable"})
		return
	}
	if !st.mailLimiter.allow("reset|"+clientIP(r)+"|"+email, 3, 15*time.Minute) {
		writeJSON(w, 429, map[string]string{"error": "too_many_attempts"})
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	var userID int64
	if err := st.db.QueryRowContext(ctx, `SELECT id FROM users WHERE email = $1`, email).Scan(&userID); err == nil {
		st.sendResetEmail(r.Context(), userID, email, r)
	}
	writeJSON(w, 202, map[string]any{"ok": true})
}

// POST /auth/reset-password {token,password}：成功后删除该用户全部会话（旧登录立即失效），
// 同时把邮箱标记为已验证（能收到重置邮件本身就是邮箱归属证明）。
func (st *slotStore) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]string{"error": "bad_origin"})
		return
	}
	var req struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !decodeAuthJSON(w, r, &req) {
		return
	}
	if !validatePassword(req.Password) {
		writeJSON(w, 400, map[string]string{"error": "bad_password"})
		return
	}
	userID, err := st.consumeEmailToken(r.Context(), tokenPurposeReset, strings.TrimSpace(req.Token))
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid_token"})
		return
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal"})
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	tx, err := st.db.BeginTx(ctx, nil)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	defer tx.Rollback()
	now := time.Now().UnixMilli()
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET pass_hash = $1, email_verified_at = COALESCE(email_verified_at, $2), updated_at = $2 WHERE id = $3`,
		hash, now, userID); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// POST /auth/resend-verify {email}：无论邮箱是否存在/已验证都返回 202。
func (st *slotStore) handleResendVerify(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]string{"error": "bad_origin"})
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if !decodeAuthJSON(w, r, &req) {
		return
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "bad_email"})
		return
	}
	if !st.mailEnabled() {
		writeJSON(w, 503, map[string]string{"error": "mail_unavailable"})
		return
	}
	if !st.mailLimiter.allow("verify|"+clientIP(r)+"|"+email, 3, 15*time.Minute) {
		writeJSON(w, 429, map[string]string{"error": "too_many_attempts"})
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	var userID int64
	var verifiedAt sql.NullInt64
	if err := st.db.QueryRowContext(ctx,
		`SELECT id, email_verified_at FROM users WHERE email = $1`, email).Scan(&userID, &verifiedAt); err == nil && !verifiedAt.Valid {
		st.sendVerifyEmail(r.Context(), userID, email, r)
	}
	writeJSON(w, 202, map[string]any{"ok": true})
}