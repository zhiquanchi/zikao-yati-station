// 判分服务会话校验回归：健康检查放行、/api/grade 无会话 401、有效会话放行、
// 校验服务不可用 503（失败关闭）、结果短缓存、按账号 slot 的小时配额。
package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func fakeAuth(t *testing.T, calls *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		if r.Header.Get("Cookie") != "exam_session=good" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"user":{"email":"a@example.com","slot":"abcd2345"}}`)
	}))
}

func newGuardForTest(url string) *sessionGuard {
	g := newSessionGuard()
	g.url = url
	return g
}

func TestGradeAuthGuard(t *testing.T) {
	calls := 0
	auth := fakeAuth(t, &calls)
	defer auth.Close()
	g := newGuardForTest(auth.URL)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		io.WriteString(w, `{"ok":true}`)
	})
	h := g.wrap(next)

	// 非判分路径（健康检查）不需要会话
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/health", nil))
	if rec.Code != 200 {
		t.Fatalf("health 应 200，得 %d", rec.Code)
	}

	// 无 Cookie → 401
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/grade", nil))
	if rec.Code != 401 {
		t.Fatalf("无会话应 401，得 %d", rec.Code)
	}

	// 有效 Cookie → 200
	req := httptest.NewRequest("POST", "/api/grade", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "good"})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("有效会话应 200，得 %d", rec.Code)
	}
	// 第二次命中缓存，不再打上游
	before := calls
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || calls != before {
		t.Fatalf("缓存未生效：status=%d calls=%d→%d", rec.Code, before, calls)
	}

	// 坏 Cookie → 401
	bad := httptest.NewRequest("POST", "/api/grade", nil)
	bad.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "bad"})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bad)
	if rec.Code != 401 {
		t.Fatalf("坏会话应 401，得 %d", rec.Code)
	}
}

func TestGradeAuthUnavailable(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := auth.URL
	auth.Close() // 立刻关掉，模拟校验服务不可达
	g := newGuardForTest(url)
	h := g.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	req := httptest.NewRequest("POST", "/api/grade", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "good"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 503 {
		t.Fatalf("校验不可用应 503（失败关闭），得 %d", rec.Code)
	}
}

func TestGradeQuota(t *testing.T) {
	calls := 0
	auth := fakeAuth(t, &calls)
	defer auth.Close()
	g := newGuardForTest(auth.URL)
	g.limit = 2
	h := g.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("POST", "/api/grade", nil)
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "good"})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("第 %d 次应 200，得 %d", i+1, rec.Code)
		}
	}
	req := httptest.NewRequest("POST", "/api/grade", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "good"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 429 {
		t.Fatalf("超过小时配额应 429，得 %d", rec.Code)
	}
}