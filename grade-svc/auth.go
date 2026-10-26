// 判分服务鉴权：校验请求携带的会话 Cookie。
// 会话事实源在 sync-svc（/internal/session）；本服务不持有数据库凭据，只做内网校验 + 短缓存。
// 未配置 AUTH_VERIFY_URL 时视为本地开发，直接放行（main 会打印告警）。
// 可选 GRADE_HOURLY_LIMIT：按账号 slot 做每小时判分次数上限（开放注册时防 AI 成本被刷）。
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const sessionCookieName = "exam_session"

type sessionCacheEntry struct {
	ok    bool
	slot  string
	until time.Time
}

type quotaEntry struct {
	count int
	reset time.Time
}

type sessionGuard struct {
	url    string
	token  string
	ttl    time.Duration
	negTTL time.Duration
	client *http.Client
	mu     sync.Mutex
	cache  map[string]sessionCacheEntry

	limit  int
	quota  map[string]*quotaEntry
}

func newSessionGuard() *sessionGuard {
	limit := 0
	if v := strings.TrimSpace(os.Getenv("GRADE_HOURLY_LIMIT")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	return &sessionGuard{
		url:    strings.TrimSpace(os.Getenv("AUTH_VERIFY_URL")),
		token:  strings.TrimSpace(os.Getenv("INTERNAL_TOKEN")),
		ttl:    45 * time.Second,
		negTTL: 5 * time.Second,
		client: &http.Client{Timeout: 2 * time.Second},
		cache:  make(map[string]sessionCacheEntry),
		limit:  limit,
		quota:  make(map[string]*quotaEntry),
	}
}

func (g *sessionGuard) enabled() bool { return g.url != "" }

// wrap：健康检查等非判分路径放行，/api/grade 必须带有效会话。
func (g *sessionGuard) wrap(next http.Handler) http.Handler {
	if !g.enabled() {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/grade") {
			next.ServeHTTP(w, r)
			return
		}
		status, code, slot := g.verify(r)
		if status != 0 {
			writeErr(w, status, code, "")
			return
		}
		if !g.allow(slot) {
			writeErr(w, 429, "too_many_requests", "本小时判分次数已达上限，请稍后再试")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (g *sessionGuard) verify(r *http.Request) (int, string, string) {
	c, err := r.Cookie(sessionCookieName)
	if err != nil || c.Value == "" {
		return 401, "unauthorized", ""
	}
	key := sessionCacheKey(c.Value)
	now := time.Now()
	g.mu.Lock()
	if e, ok := g.cache[key]; ok && now.Before(e.until) {
		g.mu.Unlock()
		if e.ok {
			return 0, "", e.slot
		}
		return 401, "unauthorized", ""
	}
	g.mu.Unlock()

	req, err := http.NewRequestWithContext(r.Context(), "GET", g.url, nil)
	if err != nil {
		return 503, "auth_unavailable", ""
	}
	req.Header.Set("Cookie", sessionCookieName+"="+c.Value)
	if g.token != "" {
		req.Header.Set("X-Internal-Token", g.token)
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return 503, "auth_unavailable", "" // 失败关闭：校验不可用时不降级为匿名判分
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case 200:
		var body struct {
			User struct {
				Slot string `json:"slot"`
			} `json:"user"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		g.store(key, true, body.User.Slot, g.ttl)
		return 0, "", body.User.Slot
	case 401, 403:
		g.store(key, false, "", g.negTTL)
		return 401, "unauthorized", ""
	default:
		return 503, "auth_unavailable", ""
	}
}

func sessionCacheKey(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

func (g *sessionGuard) store(key string, ok bool, slot string, ttl time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.cache) > 4096 {
		now := time.Now()
		for k, e := range g.cache {
			if now.After(e.until) {
				delete(g.cache, k)
			}
		}
	}
	g.cache[key] = sessionCacheEntry{ok: ok, slot: slot, until: time.Now().Add(ttl)}
}

// allow：按账号 slot 固定窗口限流；limit=0 表示不限制。
func (g *sessionGuard) allow(slot string) bool {
	if g.limit <= 0 || slot == "" {
		return true
	}
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.quota) > 4096 {
		for k, e := range g.quota {
			if now.After(e.reset) {
				delete(g.quota, k)
			}
		}
	}
	e := g.quota[slot]
	if e == nil || now.After(e.reset) {
		g.quota[slot] = &quotaEntry{count: 1, reset: now.Add(time.Hour)}
		return true
	}
	if e.count >= g.limit {
		return false
	}
	e.count++
	return true
}