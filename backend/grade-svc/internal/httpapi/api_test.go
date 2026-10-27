package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"grade-svc/internal/auth"
	"grade-svc/internal/gradeai"
	"grade-svc/internal/progress"
	"grade-svc/internal/quota"
	"grade-svc/internal/store"
	"grade-svc/internal/subject"
)

type fakeAI struct {
	calls   int32
	grade   *gradeai.Resp
	explain *gradeai.ExplainResp
}

func (f *fakeAI) Enabled() bool { return true }
func (f *fakeAI) Grade(context.Context, gradeai.Req) (*gradeai.Resp, error) {
	atomic.AddInt32(&f.calls, 1)
	return f.grade, nil
}
func (f *fakeAI) Explain(context.Context, gradeai.ExplainReq) (*gradeai.ExplainResp, error) {
	atomic.AddInt32(&f.calls, 1)
	return f.explain, nil
}
func (f *fakeAI) Calls() int32 { return atomic.LoadInt32(&f.calls) }

func testServer(t *testing.T, limit int, allowImport bool) (*Server, *sql.DB, *subject.Registry, map[string]*fakeAI, http.Handler) {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设置 TEST_DATABASE_URL，跳过数据库用例")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open admin: %v", err)
	}
	schema := fmt.Sprintf("t_api_%d", time.Now().UnixNano())
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

	reg, err := subject.Load("../../../../subjects")
	if err != nil {
		t.Fatalf("load subjects: %v", err)
	}
	fakes := map[string]*fakeAI{}
	ai := map[string]progress.AIClient{}
	for _, c := range reg.List() {
		f := &fakeAI{
			grade:   &gradeai.Resp{Engine: "ai", Score: 80, Summary: "ok", Per: []gradeai.PerPoint{{Text: "p", Cov: 0.8, State: "hit", Segs: []string{}}}},
			explain: &gradeai.ExplainResp{Engine: "ai", Task: "explain", Source: "material", Items: []gradeai.ExplainItem{{Key: "A", Correct: true, Why: "因为 A"}}},
		}
		fakes[c.Prefix] = f
		ai[c.Prefix] = f
	}
	authSvc := auth.New(db)
	progSvc := &progress.Service{DB: db, Reg: reg, AI: ai, Quota: quota.New(limit)}
	srv := New(db, authSvc, progSvc, reg, ai)
	srv.AllowLegacyImport = allowImport
	return srv, db, reg, fakes, srv.Mux()
}

func guestCookie(t *testing.T, h http.Handler) []*http.Cookie {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/v1/auth/guest", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("guest status=%d body=%s", rec.Code, rec.Body.String())
	}
	return rec.Result().Cookies()
}

func do(t *testing.T, h http.Handler, method, path string, body any, cookies []*http.Cookie) *httptest.ResponseRecorder {
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
	h.ServeHTTP(rec, req)
	return rec
}

func essayQID(t *testing.T, reg *subject.Registry) int {
	t.Helper()
	for _, q := range reg.Get("os").Questions {
		if q.Type == "essay" {
			return q.ID
		}
	}
	t.Fatal("没有简答题")
	return 0
}

func TestUnauthorized(t *testing.T) {
	_, _, _, _, h := testServer(t, 0, false)
	rec := do(t, h, "GET", "/api/v1/subjects/os/progress", nil, nil)
	if rec.Code != 401 {
		t.Fatalf("未登录应 401，实得 %d", rec.Code)
	}
}

func TestSameOriginRejected(t *testing.T) {
	_, _, reg, _, h := testServer(t, 0, false)
	cookies := guestCookie(t, h)
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(map[string]any{"qid": 1, "u": "A", "mode": "submit"})
	req := httptest.NewRequest("POST", "/api/v1/subjects/os/answers", &buf)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://evil.example")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("跨源写请求应 403，实得 %d", rec.Code)
	}
	_ = reg
}

func TestQuotaAndDedup(t *testing.T) {
	_, _, reg, fakes, h := testServer(t, 1, false)
	cookies := guestCookie(t, h)
	qid := essayQID(t, reg)
	f := fakes["os"]

	first := do(t, h, "POST", "/api/v1/subjects/os/answers", map[string]any{
		"qid": qid, "u": map[string]string{"mode": "whole", "whole": "第一次作答"}, "mode": "ai",
	}, cookies)
	if first.Code != 200 {
		t.Fatalf("首次 AI 判分 status=%d body=%s", first.Code, first.Body.String())
	}
	if f.Calls() != 1 {
		t.Fatalf("首次应调用上游 1 次，实际 %d", f.Calls())
	}
	// 同一作答再次请求：判重命中，不调上游、不耗配额
	second := do(t, h, "POST", "/api/v1/subjects/os/answers", map[string]any{
		"qid": qid, "u": map[string]string{"mode": "whole", "whole": "第一次作答"}, "mode": "ai",
	}, cookies)
	if second.Code != 200 {
		t.Fatalf("判重请求 status=%d", second.Code)
	}
	if f.Calls() != 1 {
		t.Fatalf("判重请求不应再调上游，实际 %d", f.Calls())
	}
	// 换一个作答：配额已用尽 → 429
	third := do(t, h, "POST", "/api/v1/subjects/os/answers", map[string]any{
		"qid": qid, "u": map[string]string{"mode": "whole", "whole": "第二次作答"}, "mode": "ai",
	}, cookies)
	if third.Code != 429 {
		t.Fatalf("超配额应 429，实得 %d body=%s", third.Code, third.Body.String())
	}
	if f.Calls() != 1 {
		t.Fatalf("超配额不应调上游，实际 %d", f.Calls())
	}
}

func TestSeenLimit(t *testing.T) {
	_, _, _, _, h := testServer(t, 0, false)
	cookies := guestCookie(t, h)
	qids := make([]int, 501)
	rec := do(t, h, "POST", "/api/v1/subjects/os/seen", map[string]any{"qids": qids}, cookies)
	if rec.Code != 400 {
		t.Fatalf("超量 seen 应 400，实得 %d", rec.Code)
	}
}

func TestBodyTooLarge(t *testing.T) {
	_, _, _, _, h := testServer(t, 0, false)
	cookies := guestCookie(t, h)
	big := strings.Repeat("x", 300<<10)
	rec := do(t, h, "POST", "/api/v1/subjects/os/answers", map[string]any{"qid": 1, "u": big, "mode": "submit"}, cookies)
	if rec.Code != 413 {
		t.Fatalf("超大请求体应 413，实得 %d", rec.Code)
	}
}

func TestRecoverMiddleware(t *testing.T) {
	srv, _, _, _, _ := testServer(t, 0, false)
	h := srv.middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/panic", nil))
	if rec.Code != 500 {
		t.Fatalf("panic 应 500，实得 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"internal"`) {
		t.Fatalf("panic 响应体应含 internal，实得 %s", rec.Body.String())
	}
}

func TestMigrateDisabledByDefault(t *testing.T) {
	_, _, _, _, h := testServer(t, 0, false)
	cookies := guestCookie(t, h)
	rec := do(t, h, "POST", "/api/v1/migrate", map[string]any{"subject": "os", "blob": map[string]any{}}, cookies)
	if rec.Code != 404 {
		t.Fatalf("默认应关闭迁移端点（404），实得 %d", rec.Code)
	}
}

func TestMigrateOnceAndNoExplainCache(t *testing.T) {
	_, db, reg, _, h := testServer(t, 0, true)
	cookies := guestCookie(t, h)
	var qid int
	var ans string
	for _, q := range reg.Get("os").Questions {
		if q.Type == "single" {
			qid, ans = q.ID, q.Answer
			break
		}
	}
	now := time.Now().UnixMilli()
	blob := map[string]any{
		"store": map[string]any{
			fmt.Sprint(qid): map[string]any{"u": ans, "s": 0, "ts": now},
			"999999":        map[string]any{"u": "A", "s": 0, "ts": now}, // 未知题号应丢弃
		},
		"expl": map[string]any{
			fmt.Sprint(qid): map[string]any{"items": []any{map[string]any{"key": "A", "why": "注入"}}, "ts": now, "source": "material"},
		},
	}
	rec := do(t, h, "POST", "/api/v1/migrate", map[string]any{"subject": "os", "blob": blob}, cookies)
	if rec.Code != 200 {
		t.Fatalf("首次迁移 status=%d body=%s", rec.Code, rec.Body.String())
	}
	var n int
	_ = db.QueryRow(`SELECT COUNT(*) FROM progress WHERE qid=$1`, qid).Scan(&n)
	if n != 1 {
		t.Fatalf("有效题应导入 1 条，实际 %d", n)
	}
	_ = db.QueryRow(`SELECT COUNT(*) FROM progress WHERE qid=999999`).Scan(&n)
	if n != 0 {
		t.Fatal("未知题号不应写入")
	}
	_ = db.QueryRow(`SELECT COUNT(*) FROM explain_cache`).Scan(&n)
	if n != 0 {
		t.Fatal("迁移不得写全局解析缓存")
	}
	second := do(t, h, "POST", "/api/v1/migrate", map[string]any{"subject": "os", "blob": blob}, cookies)
	if second.Code != 409 {
		t.Fatalf("重复迁移应 409，实得 %d", second.Code)
	}
}

func TestRedoQIDValidation(t *testing.T) {
	_, _, _, _, h := testServer(t, 0, false)
	cookies := guestCookie(t, h)
	if rec := do(t, h, "POST", "/api/v1/subjects/os/answers/0/redo", map[string]any{}, cookies); rec.Code != 400 {
		t.Fatalf("qid=0 应 400，实得 %d", rec.Code)
	}
	if rec := do(t, h, "POST", "/api/v1/subjects/os/answers/999999/redo", map[string]any{}, cookies); rec.Code != 404 {
		t.Fatalf("不存在题号应 404，实得 %d", rec.Code)
	}
}

func TestHealth(t *testing.T) {
	_, _, _, _, h := testServer(t, 0, false)
	rec := do(t, h, "GET", "/api/v1/health", nil, nil)
	if rec.Code != 200 {
		t.Fatalf("health status=%d", rec.Code)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["ai"] != true {
		t.Fatalf("health 应报告 ai=true：%v", out)
	}
}
