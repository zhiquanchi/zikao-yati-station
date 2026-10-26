package auth

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"grade-svc/internal/store"
)

func testService(t *testing.T) *Service {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设置 TEST_DATABASE_URL，跳过数据库用例")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open admin: %v", err)
	}
	schema := fmt.Sprintf("t_auth_%d", time.Now().UnixNano())
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec("DROP SCHEMA " + schema + " CASCADE")
		admin.Close()
	})
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	db, err := store.Open(dsn + sep + "search_path=" + schema)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return New(db)
}

func doJSON(t *testing.T, h http.HandlerFunc, method, path string, body any, cookies []*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func TestGuestRegisterClaimsProgress(t *testing.T) {
	svc := testService(t)

	// 1) 游客会话
	rec := doJSON(t, svc.HandleGuest, "POST", "/api/v1/auth/guest", map[string]any{}, nil)
	if rec.Code != 200 {
		t.Fatalf("guest status=%d body=%s", rec.Code, rec.Body.String())
	}
	var g struct {
		User apiUser `json:"user"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	if g.User.Slot == "" || !g.User.Guest {
		t.Fatalf("游客返回异常：%+v", g.User)
	}
	cookies := rec.Result().Cookies()

	// 游客进度
	now := time.Now().UnixMilli()
	if _, err := svc.DB.Exec(`INSERT INTO progress (subject,user_slot,qid,rec,ts) VALUES ('os',$1,1,$2,$3)`,
		g.User.Slot, `{"u":"A","s":100,"ts":`+fmt.Sprint(now)+`}`, now); err != nil {
		t.Fatal(err)
	}

	// 2) 带游客 Cookie 注册 → 自动并入账号
	rec = doJSON(t, svc.HandleRegister, "POST", "/api/v1/auth/register",
		map[string]any{"email": "a@example.com", "password": "password123"}, cookies)
	if rec.Code != 201 {
		t.Fatalf("register status=%d body=%s", rec.Code, rec.Body.String())
	}
	var r struct {
		User apiUser `json:"user"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &r)
	if r.User.Slot == "" || r.User.Guest {
		t.Fatalf("注册返回异常：%+v", r.User)
	}
	var n int
	if err := svc.DB.QueryRow(`SELECT COUNT(*) FROM progress WHERE user_slot=$1 AND qid=1`, r.User.Slot).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("游客进度未并入账号：%d", n)
	}
	var left int
	_ = svc.DB.QueryRow(`SELECT COUNT(*) FROM progress WHERE user_slot=$1`, g.User.Slot).Scan(&left)
	if left != 0 {
		t.Fatalf("游客槽位残留 %d 条", left)
	}
	var guests int
	_ = svc.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE is_guest=true`).Scan(&guests)
	if guests != 0 {
		t.Fatalf("游客账号未删除：%d", guests)
	}

	// 3) 错误密码
	rec = doJSON(t, svc.HandleLogin, "POST", "/api/v1/auth/login",
		map[string]any{"email": "a@example.com", "password": "wrong-password"}, nil)
	if rec.Code != 401 {
		t.Fatalf("错误密码应 401，实得 %d", rec.Code)
	}
	// 4) 正确登录
	rec = doJSON(t, svc.HandleLogin, "POST", "/api/v1/auth/login",
		map[string]any{"email": "a@example.com", "password": "password123"}, nil)
	if rec.Code != 200 {
		t.Fatalf("登录失败：%d %s", rec.Code, rec.Body.String())
	}
}

func TestExplicitClaim(t *testing.T) {
	svc := testService(t)
	// 注册账号
	rec := doJSON(t, svc.HandleRegister, "POST", "/api/v1/auth/register",
		map[string]any{"email": "b@example.com", "password": "password123"}, nil)
	if rec.Code != 201 {
		t.Fatalf("register: %d", rec.Code)
	}
	var r struct {
		User apiUser `json:"user"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &r)
	acctCookies := rec.Result().Cookies()

	// 另造一个游客槽
	rec = doJSON(t, svc.HandleGuest, "POST", "/api/v1/auth/guest", map[string]any{}, nil)
	var g struct {
		User apiUser `json:"user"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	now := time.Now().UnixMilli()
	if _, err := svc.DB.Exec(`INSERT INTO progress (subject,user_slot,qid,rec,ts) VALUES ('os',$1,2,'{"u":"B","s":80,"ts":0}',$2)`,
		g.User.Slot, now); err != nil {
		t.Fatal(err)
	}

	rec = doJSON(t, svc.HandleClaim, "POST", "/api/v1/auth/claim",
		map[string]any{"guest_slot": g.User.Slot}, acctCookies)
	if rec.Code != 200 {
		t.Fatalf("claim status=%d body=%s", rec.Code, rec.Body.String())
	}
	var n int
	_ = svc.DB.QueryRow(`SELECT COUNT(*) FROM progress WHERE user_slot=$1 AND qid=2`, r.User.Slot).Scan(&n)
	if n != 1 {
		t.Fatalf("claim 未并入：%d", n)
	}
}
