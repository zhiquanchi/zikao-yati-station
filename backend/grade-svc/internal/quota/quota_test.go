package quota

import (
	"testing"
	"time"
)

func TestAllowWithinLimit(t *testing.T) {
	l := New(2)
	if !l.Allow("a") || !l.Allow("a") {
		t.Fatal("前两次应放行")
	}
	if l.Allow("a") {
		t.Fatal("第三次应拒绝")
	}
	if !l.Allow("b") {
		t.Fatal("不同 key 应独立计数")
	}
}

func TestWindowReset(t *testing.T) {
	l := New(1)
	now := time.Unix(0, 0)
	l.now = func() time.Time { return now }
	if !l.Allow("a") {
		t.Fatal("首次应放行")
	}
	if l.Allow("a") {
		t.Fatal("窗口内应拒绝")
	}
	now = now.Add(2 * time.Hour)
	if !l.Allow("a") {
		t.Fatal("窗口过后应放行")
	}
}

func TestUnlimited(t *testing.T) {
	l := New(0)
	for i := 0; i < 100; i++ {
		if !l.Allow("a") {
			t.Fatal("0 应为不限")
		}
	}
	if l.Enabled() {
		t.Fatal("0 不应显示为启用")
	}
}
