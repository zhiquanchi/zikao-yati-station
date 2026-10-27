// 进程内小时配额：按账号 slot（游客同样计入）限制 AI 判分与逐项解析次数。
// 只约束「会烧上游 token」的入口，普通作答/组卷不受影响。重启清零可接受（单实例小站）。
package quota

import (
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type bucket struct {
	count int
	reset time.Time
}

type Limiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex
	buckets map[string]*bucket
}

// New 指定每小时上限；limit<=0 表示不限制（仍可调用，Allow 恒真）。
func New(limit int) *Limiter {
	return &Limiter{limit: limit, window: time.Hour, now: time.Now, buckets: map[string]*bucket{}}
}

// NewFromEnv 读取 GRADE_HOURLY_LIMIT（0/缺省＝不限）。
func NewFromEnv() *Limiter {
	limit := 0
	if v := strings.TrimSpace(os.Getenv("GRADE_HOURLY_LIMIT")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	return New(limit)
}

func (l *Limiter) Limit() int    { return l.limit }
func (l *Limiter) Enabled() bool { return l.limit > 0 }

// Allow 记账一次；超限返回 false。limit<=0 时直接放行。
func (l *Limiter) Allow(key string) bool {
	if l == nil || l.limit <= 0 {
		return true
	}
	if strings.TrimSpace(key) == "" {
		key = "anonymous"
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) > 8192 {
		for k, b := range l.buckets {
			if now.After(b.reset) {
				delete(l.buckets, k)
			}
		}
	}
	b := l.buckets[key]
	if b == nil || now.After(b.reset) {
		l.buckets[key] = &bucket{count: 1, reset: now.Add(l.window)}
		return true
	}
	if b.count >= l.limit {
		return false
	}
	b.count++
	return true
}
