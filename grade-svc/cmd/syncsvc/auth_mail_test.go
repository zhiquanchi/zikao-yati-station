// 邮件链路回归：注册验证邮件、验证令牌单次使用、找回密码、令牌过期、未知邮箱防枚举、
// 重发限流、REQUIRE_EMAIL_VERIFY、邮件链接的 X-Forwarded-* 还原。全程假 Mailer，零真实网络。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"
)

type sentMail struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

type fakeMailer struct {
	enabled bool
	sent    []sentMail
}

func (f *fakeMailer) Enabled() bool { return f.enabled }
func (f *fakeMailer) Send(_ context.Context, to, subject, text, html string) error {
	f.sent = append(f.sent, sentMail{To: to, Subject: subject, Text: text, HTML: html})
	return nil
}

func newMailSvc(t *testing.T) (*httptest.Server, *slotStore, *fakeMailer) {
	t.Helper()
	srv, st := newTestSvcStore(t, testDSN(t))
	fm := &fakeMailer{enabled: true}
	st.mailer = fm
	return srv, st, fm
}

var mailTokenRe = regexp.MustCompile(`(?:verify_token|reset_token)=([A-Za-z0-9_-]+)`)

func tokenFromMail(t *testing.T, m sentMail) string {
	t.Helper()
	mm := mailTokenRe.FindStringSubmatch(m.Text)
	if len(mm) != 2 {
		t.Fatalf("邮件正文里没有 token：%s", m.Text)
	}
	return mm[1]
}

func postJSONWithHeaders(t *testing.T, c *http.Client, url string, body any, headers map[string]string) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func TestRegisterVerifyEmail(t *testing.T) {
	srv, _, fm := newMailSvc(t)
	c := newClient(t)
	status, body, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{
		"email": "a@example.com", "password": "password123",
	})
	if status != 201 {
		t.Fatalf("注册应 201，得 %d（%v）", status, body)
	}
	if len(fm.sent) != 1 {
		t.Fatalf("应发送 1 封验证邮件，得 %d", len(fm.sent))
	}
	if fm.sent[0].To != "a@example.com" {
		t.Errorf("收件人不符：%s", fm.sent[0].To)
	}
	token := tokenFromMail(t, fm.sent[0])

	// 未验证：me 返回 false
	_, me, _ := getWithClient(t, c, srv.URL+"/auth/me")
	if userOf(me)["email_verified"] != false {
		t.Errorf("注册后 email_verified 应为 false：%v", me)
	}
	// 验证
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/verify-email", map[string]string{"token": token}); status != 200 {
		t.Fatalf("验证邮箱应 200，得 %d（%v）", status, body)
	}
	_, me, _ = getWithClient(t, c, srv.URL+"/auth/me")
	if userOf(me)["email_verified"] != true {
		t.Errorf("验证后 email_verified 应为 true：%v", me)
	}
	// 令牌单次使用
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/verify-email", map[string]string{"token": token}); status != 400 || body["error"] != "invalid_token" {
		t.Errorf("重复使用令牌应 400 invalid_token，得 %d（%v）", status, body)
	}
}

func TestRequestResetAndResetPassword(t *testing.T) {
	srv, _, fm := newMailSvc(t)
	c := newClient(t)
	postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"})
	fm.sent = nil // 忽略注册验证邮件

	status, body, _ := postJSON(t, c, srv.URL+"/auth/request-reset", map[string]string{"email": "A@Example.com"})
	if status != 202 {
		t.Fatalf("请求重置应 202，得 %d（%v）", status, body)
	}
	if len(fm.sent) != 1 {
		t.Fatalf("应发送 1 封重置邮件，得 %d", len(fm.sent))
	}
	token := tokenFromMail(t, fm.sent[0])

	if status, body, _ := postJSON(t, newClient(t), srv.URL+"/auth/reset-password", map[string]string{"token": token, "password": "newpassword123"}); status != 200 {
		t.Fatalf("重置密码应 200，得 %d（%v）", status, body)
	}
	// 旧会话立即失效
	if status, _, _ := getWithClient(t, c, srv.URL+"/auth/me"); status != 401 {
		t.Errorf("重置后旧会话应 401，得 %d", status)
	}
	// 旧密码失效、新密码可登录且邮箱已标记验证
	if status, _, _ := postJSON(t, newClient(t), srv.URL+"/auth/login", map[string]string{"email": "a@example.com", "password": "password123"}); status != 401 {
		t.Errorf("旧密码应 401，得 %d", status)
	}
	status, body, _ = postJSON(t, newClient(t), srv.URL+"/auth/login", map[string]string{"email": "a@example.com", "password": "newpassword123"})
	if status != 200 || userOf(body)["email_verified"] != true {
		t.Errorf("新密码应 200 且 email_verified=true，得 %d（%v）", status, body)
	}
	// 令牌单次使用
	if status, body, _ := postJSON(t, newClient(t), srv.URL+"/auth/reset-password", map[string]string{"token": token, "password": "another123"}); status != 400 || body["error"] != "invalid_token" {
		t.Errorf("重复使用重置令牌应 400，得 %d（%v）", status, body)
	}
}

func TestRequestResetUnknownEmailDoesNotLeak(t *testing.T) {
	srv, _, fm := newMailSvc(t)
	if status, body, _ := postJSON(t, newClient(t), srv.URL+"/auth/request-reset", map[string]string{"email": "nobody@example.com"}); status != 202 {
		t.Fatalf("未知邮箱也应 202，得 %d（%v）", status, body)
	}
	if len(fm.sent) != 0 {
		t.Errorf("未知邮箱不应发信，实际 %d 封", len(fm.sent))
	}
	if status, body, _ := postJSON(t, newClient(t), srv.URL+"/auth/resend-verify", map[string]string{"email": "nobody@example.com"}); status != 202 {
		t.Fatalf("未知邮箱重发验证也应 202，得 %d（%v）", status, body)
	}
	if len(fm.sent) != 0 {
		t.Errorf("未知邮箱重发验证不应发信，实际 %d 封", len(fm.sent))
	}
}

func TestMailDisabledReturns503(t *testing.T) {
	srv, st, _ := newMailSvc(t)
	st.mailer = noopMailer{}
	if status, body, _ := postJSON(t, newClient(t), srv.URL+"/auth/request-reset", map[string]string{"email": "a@example.com"}); status != 503 || body["error"] != "mail_unavailable" {
		t.Errorf("邮件未配置请求重置应 503，得 %d（%v）", status, body)
	}
	if status, body, _ := postJSON(t, newClient(t), srv.URL+"/auth/resend-verify", map[string]string{"email": "a@example.com"}); status != 503 || body["error"] != "mail_unavailable" {
		t.Errorf("邮件未配置重发验证应 503，得 %d（%v）", status, body)
	}
}

func TestExpiredResetToken(t *testing.T) {
	srv, st, _ := newMailSvc(t)
	c := newClient(t)
	postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"})
	var id int64
	if err := st.db.QueryRowContext(context.Background(), `SELECT id FROM users WHERE email = $1`, "a@example.com").Scan(&id); err != nil {
		t.Fatal(err)
	}
	token, err := st.issueEmailToken(context.Background(), id, tokenPurposeReset, -time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if status, body, _ := postJSON(t, newClient(t), srv.URL+"/auth/reset-password", map[string]string{"token": token, "password": "newpassword123"}); status != 400 || body["error"] != "invalid_token" {
		t.Errorf("过期令牌应 400 invalid_token，得 %d（%v）", status, body)
	}
}

func TestRequireEmailVerify(t *testing.T) {
	t.Setenv("REQUIRE_EMAIL_VERIFY", "1")
	srv, _, fm := newMailSvc(t)
	postJSON(t, newClient(t), srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"})
	if len(fm.sent) != 1 {
		t.Fatalf("应发送验证邮件，得 %d", len(fm.sent))
	}
	token := tokenFromMail(t, fm.sent[0])

	if status, body, _ := postJSON(t, newClient(t), srv.URL+"/auth/login", map[string]string{"email": "a@example.com", "password": "password123"}); status != 403 || body["error"] != "email_not_verified" {
		t.Fatalf("未验证登录应 403 email_not_verified，得 %d（%v）", status, body)
	}
	postJSON(t, newClient(t), srv.URL+"/auth/verify-email", map[string]string{"token": token})
	if status, _, _ := postJSON(t, newClient(t), srv.URL+"/auth/login", map[string]string{"email": "a@example.com", "password": "password123"}); status != 200 {
		t.Fatalf("验证后登录应 200，得 %d", status)
	}
}

func TestMailRateLimit(t *testing.T) {
	srv, _, fm := newMailSvc(t)
	c := newClient(t)
	postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"})
	fm.sent = nil
	for i := 0; i < 3; i++ {
		if status, _, _ := postJSON(t, c, srv.URL+"/auth/request-reset", map[string]string{"email": "a@example.com"}); status != 202 {
			t.Fatalf("第 %d 次请求重置应 202，得 %d", i+1, status)
		}
	}
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/request-reset", map[string]string{"email": "a@example.com"}); status != 429 || body["error"] != "too_many_attempts" {
		t.Errorf("第 4 次应 429，得 %d（%v）", status, body)
	}
	if len(fm.sent) != 3 {
		t.Errorf("应只发 3 封，实际 %d", len(fm.sent))
	}
}

func TestEmailLinkUsesForwardedPrefix(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "")
	srv, _, fm := newMailSvc(t)
	postJSONWithHeaders(t, newClient(t), srv.URL+"/auth/register", map[string]string{
		"email": "a@example.com", "password": "password123",
	}, map[string]string{
		"X-Forwarded-Proto":  "https",
		"X-Forwarded-Host":   "example.com",
		"X-Forwarded-Prefix": "/net/",
	})
	if len(fm.sent) != 1 {
		t.Fatalf("应发送验证邮件，得 %d", len(fm.sent))
	}
	if !regexp.MustCompile(`https://example\.com/net/\?verify_token=`).MatchString(fm.sent[0].Text) {
		t.Errorf("验证链接未按 X-Forwarded-* 还原：%s", fm.sent[0].Text)
	}
}