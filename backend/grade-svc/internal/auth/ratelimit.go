package auth

import (
	"sync"
	"time"
)

type rateBucket struct {
	count int
	reset time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*rateBucket
}

func newRateLimiter() *rateLimiter { return &rateLimiter{buckets: map[string]*rateBucket{}} }

func (l *rateLimiter) allow(key string, limit int, window time.Duration) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) > 4096 {
		for k, b := range l.buckets {
			if now.After(b.reset) {
				delete(l.buckets, k)
			}
		}
	}
	b := l.buckets[key]
	if b == nil || now.After(b.reset) {
		l.buckets[key] = &rateBucket{count: 1, reset: now.Add(window)}
		return true
	}
	if b.count >= limit {
		return false
	}
	b.count++
	return true
}

func (l *rateLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.buckets, key)
}
