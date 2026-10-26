// 认证回归：注册/登录/登出/me、Cookie 属性、重复邮箱、弱密码、注册开关、会话过期、限流、内网校验。
// 数据库用 testDSN 提供的独立 schema；PBKDF2 迭代次数在测试期调低，避免每个用例多花几百毫秒。
package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	old := pbkdf2Iterations
	pbkdf2Iterations = 1000 // 仅测试：真实运行保持 600,000
	code := m.Run()
	pbkdf2Iterations = old
	os.Exit(code)
}

func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar, Timeout: 20 * time.Second}
}

func postJSON(t *testing.T, c *http.Client, url string, body any) (int, map[string]any, *http.Response) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("POST %s：%v", url, err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m, resp
}

func getWithClient(t *testing.T, c *http.Client, url string) (int, map[string]any, *http.Response) {
	t.Helper()
	resp, err := c.Get(url)
	if err != nil {
		t.Fatalf("GET %s：%v", url, err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m, resp
}

func userOf(m map[string]any) map[string]any {
	u, _ := m["user"].(map[string]any)
	return u
}

func TestRegisterLoginMeLogout(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))
	c := newClient(t)

	status, body, resp := postJSON(t, c, srv.URL+"/auth/register", map[string]string{
		"email": "A@Example.com", "password": "password123",
	})
	if status != 201 {
		t.Fatalf("注册应 201，得 %d（%v）", status, body)
	}
	u := userOf(body)
	if u["email"] != "a@example.com" {
		t.Errorf("邮箱应小写归一，得 %v", u["email"])
	}
	if slot, _ := u["slot"].(string); !userRe.MatchString(slot) || len(slot) != accountSlotLen {
		t.Errorf("slot 格式不符：%q", slot)
	}
	var sess *http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck
		}
	}
	if sess == nil {
		t.Fatal("注册响应缺会话 Cookie")
	}
	if !sess.HttpOnly || sess.SameSite != http.SameSiteLaxMode || sess.Path != "/" || sess.Value == "" {
		t.Errorf("Cookie 属性不符：%+v", sess)
	}

	if status, body, _ = getWithClient(t, c, srv.URL+"/auth/me"); status != 200 {
		t.Fatalf("me 应 200，得 %d（%v）", status, body)
	}
	if userOf(body)["email"] != "a@example.com" {
		t.Errorf("me 邮箱不符：%v", body)
	}

	// 登出：204 + 清 Cookie；之后 me 401
	req, _ := http.NewRequest("POST", srv.URL+"/auth/logout", nil)
	resp2, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 204 {
		t.Fatalf("登出应 204，得 %d", resp2.StatusCode)
	}
	if status, _, _ = getWithClient(t, c, srv.URL+"/auth/me"); status != 401 {
		t.Fatalf("登出后 me 应 401，得 %d", status)
	}

	// 重新登录
	if status, body, _ = postJSON(t, c, srv.URL+"/auth/login", map[string]string{
		"email": "a@example.com", "password": "password123",
	}); status != 200 {
		t.Fatalf("登录应 200，得 %d（%v）", status, body)
	}
}

func TestRegisterValidation(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))
	c := newClient(t)

	if status, body, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "nope", "password": "password123"}); status != 400 || body["error"] != "bad_email" {
		t.Errorf("坏邮箱应 400 bad_email，得 %d（%v）", status, body)
	}
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "short"}); status != 400 || body["error"] != "bad_password" {
		t.Errorf("短密码应 400 bad_password，得 %d（%v）", status, body)
	}
	if status, _, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"}); status != 201 {
		t.Fatalf("首次注册应 201，得 %d", status)
	}
	// 大小写/空格归一后视为同一邮箱
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": " A@EXAMPLE.COM ", "password": "password123"}); status != 409 || body["error"] != "email_taken" {
		t.Errorf("重复邮箱应 409 email_taken，得 %d（%v）", status, body)
	}
}

func TestLoginWrongPasswordAndUnknownEmail(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))
	c := newClient(t)
	postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"})

	if status, body, _ := postJSON(t, c, srv.URL+"/auth/login", map[string]string{"email": "a@example.com", "password": "wrongpass"}); status != 401 || body["error"] != "bad_credentials" {
		t.Errorf("错密码应 401 bad_credentials，得 %d（%v）", status, body)
	}
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/login", map[string]string{"email": "b@example.com", "password": "password123"}); status != 401 || body["error"] != "bad_credentials" {
		t.Errorf("未知邮箱应 401 bad_credentials，得 %d（%v）", status, body)
	}
}

func TestRegistrationCanBeClosed(t *testing.T) {
	t.Setenv("REGISTRATION_OPEN", "0")
	srv := newTestSvc(t, testDSN(t))
	c := newClient(t)

	// users 为空时仍允许创建首个账号，避免锁死
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"}); status != 201 {
		t.Fatalf("首个账号应允许注册，得 %d（%v）", status, body)
	}
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "b@example.com", "password": "password123"}); status != 403 || body["error"] != "registration_closed" {
		t.Errorf("关闭注册后应 403 registration_closed，得 %d（%v）", status, body)
	}
}

func TestMaxUsers(t *testing.T) {
	t.Setenv("MAX_USERS", "1")
	srv := newTestSvc(t, testDSN(t))
	c := newClient(t)
	if status, _, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"}); status != 201 {
		t.Fatalf("首个账号应 201，得 %d", status)
	}
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "b@example.com", "password": "password123"}); status != 403 || body["error"] != "registration_closed" {
		t.Errorf("超过 MAX_USERS 应 403，得 %d（%v）", status, body)
	}
}

func TestSessionExpiry(t *testing.T) {
	dsn := testDSN(t)
	srv := newTestSvc(t, dsn)
	c := newClient(t)
	postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"})

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`UPDATE sessions SET expires_at = $1`, time.Now().Add(-time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := getWithClient(t, c, srv.URL+"/auth/me"); status != 401 {
		t.Fatalf("过期会话应 401，得 %d", status)
	}
}

func TestLoginRateLimit(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))
	c := newClient(t)
	postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"})

	for i := 0; i < 10; i++ {
		if status, _, _ := postJSON(t, c, srv.URL+"/auth/login", map[string]string{"email": "a@example.com", "password": "wrongpass"}); status != 401 {
			t.Fatalf("第 %d 次错密码应 401，得 %d", i+1, status)
		}
	}
	if status, body, _ := postJSON(t, c, srv.URL+"/auth/login", map[string]string{"email": "a@example.com", "password": "password123"}); status != 429 || body["error"] != "too_many_attempts" {
		t.Errorf("第 11 次应 429 too_many_attempts，得 %d（%v）", status, body)
	}
}

func TestInternalSession(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))
	c := newClient(t)
	postJSON(t, c, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"})

	if status, body, _ := getWithClient(t, c, srv.URL+"/internal/session"); status != 200 || userOf(body)["email"] != "a@example.com" {
		t.Fatalf("带会话的内部校验应 200，得 %d（%v）", status, body)
	}
	if status, _, _ := getWithClient(t, newClient(t), srv.URL+"/internal/session"); status != 401 {
		t.Fatalf("无会话的内部校验应 401，得 %d", status)
	}

	// INTERNAL_TOKEN 设置后必须带匹配头
	t.Setenv("INTERNAL_TOKEN", "secret-token")
	if status, _, _ := getWithClient(t, c, srv.URL+"/internal/session"); status != 401 {
		t.Fatalf("缺 X-Internal-Token 应 401，得 %d", status)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/internal/session", nil)
	for _, ck := range c.Jar.Cookies(mustURL(t, srv.URL)) {
		if ck.Name == sessionCookieName {
			req.AddCookie(ck)
		}
	}
	req.Header.Set("X-Internal-Token", "secret-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("带 X-Internal-Token 应 200，得 %d", resp.StatusCode)
	}
}

func TestSameOriginGuard(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))
	b := strings.NewReader(`{"email":"a@example.com","password":"password123"}`)
	req, _ := http.NewRequest("POST", srv.URL+"/auth/register", b)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("跨源注册应 403，得 %d", resp.StatusCode)
	}
}

func TestPasswordHash(t *testing.T) {
	h, err := hashPassword("password123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "pbkdf2-sha256$1000$") {
		t.Errorf("哈希格式不符：%s", h)
	}
	if ok, _ := verifyPassword(h, "password123"); !ok {
		t.Error("正确密码应校验通过")
	}
	if ok, _ := verifyPassword(h, "wrongpass"); ok {
		t.Error("错误密码不应通过")
	}
	if ok, _ := verifyPassword("not-a-hash", "password123"); ok {
		t.Error("坏哈希不应通过")
	}
}

// mustURL 供 http.Request 与 cookie jar 使用。
func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestHealthRequiresDB(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))
	if h := getJSON(t, srv.URL+"/api/health"); h["ok"] != true {
		t.Fatalf("health 应 ok，得 %v", h)
	}
}