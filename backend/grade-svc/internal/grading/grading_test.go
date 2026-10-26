package grading

import (
	"testing"

	"grade-svc/internal/subject"
)

func TestSingle(t *testing.T) {
	if got := GradeSingle("A", "A").Score; got != 100 {
		t.Fatalf("选对 = %d, want 100", got)
	}
	if got := GradeSingle("A", "B").Score; got != 0 {
		t.Fatalf("选错 = %d, want 0", got)
	}
}

func TestBlanksStrict(t *testing.T) {
	blanks := [][]string{{"硬件资源"}, {"软件资源"}}
	cases := []struct {
		in   []string
		want int
	}{
		{[]string{"硬件资源", "软件资源"}, 100},
		{[]string{"硬件", "软件"}, 0},
		{[]string{"硬件资源 ", "软件资源"}, 100}, // 尾空格容忍
	}
	for _, c := range cases {
		if got := GradeBlanks(c.in, blanks, false, false).Score; got != c.want {
			t.Fatalf("blanks %v = %d, want %d", c.in, got, c.want)
		}
	}
	en := [][]string{{"batch processing"}}
	if got := GradeBlanks([]string{"BatchProcessing"}, en, false, false).Score; got != 100 {
		t.Fatalf("全半角/大小写/空格容错失败：%d", got)
	}
	if got := GradeBlanks([]string{"批处理"}, en, false, false).Score; got != 0 {
		t.Fatalf("非包含匹配口径失败：%d", got)
	}
}

func TestBlanksFallback(t *testing.T) {
	blanks := [][]string{{"时间片轮转法调度算法"}}
	if got := GradeBlanks([]string{"采用时间片轮转法调度算法"}, blanks, false, true).Score; got != 100 {
		t.Fatalf("fallback 包含兜底 = %d, want 100", got)
	}
	if got := GradeBlanks([]string{"先来先服务调度算法"}, blanks, false, true).Score; got != 0 {
		t.Fatalf("fallback 错误答案 = %d, want 0", got)
	}
}

func TestBlanksUnordered(t *testing.T) {
	un := [][]string{{"硬件资源"}, {"软件资源"}}
	if got := GradeBlanks([]string{"软件资源", "硬件资源"}, un, true, false).Score; got != 100 {
		t.Fatalf("跨空互换 = %d, want 100", got)
	}
	if got := GradeBlanks([]string{"软件资源", "软件资源"}, un, true, false).Score; got != 50 {
		t.Fatalf("部分命中 = %d, want 50", got)
	}
	strict := [][]string{{"进程"}, {"线程"}}
	if got := GradeBlanks([]string{"线程", "进程"}, strict, false, false).Score; got != 0 {
		t.Fatalf("未标记不可互换 = %d, want 0", got)
	}
}

func TestEssay(t *testing.T) {
	points := []string{"并发：宏观同时微观串行", "共享：资源供多程序共用"}
	if got := GradeEssay("", points).Score; got != 0 {
		t.Fatalf("空答 = %d, want 0", got)
	}
	if got := GradeEssay("今天天气不错我们出去玩", points).Score; got > 10 {
		t.Fatalf("乱答 = %d, want <=10", got)
	}
	s := GradeEssay("并发", points).Score
	if !(s > 0 && s < 100) {
		t.Fatalf("部分覆盖 = %d, want 0<s<100", s)
	}
}

func TestStateThresholds(t *testing.T) {
	cases := map[float64]string{0.5: "hit", 0.49: "part", 0.22: "part", 0.21: "miss"}
	for cov, want := range cases {
		if got := StateOf(cov); got != want {
			t.Fatalf("StateOf(%v) = %s, want %s", cov, got, want)
		}
	}
}

// TestFullCatalogInvariants 对真实题库跑口径不变量：标准答案满分、简答原文≥95、并列题任意轮换满分。
func TestFullCatalogInvariants(t *testing.T) {
	reg, err := subject.Load("../../../../subjects")
	if err != nil {
		t.Skipf("跳过（无题库）：%v", err)
	}
	for _, cfg := range reg.List() {
		for i := range cfg.Questions {
			q := &cfg.Questions[i]
			switch q.Type {
			case "single":
				if len(q.Options) != 4 {
					t.Errorf("%s #%d 选项数 = %d", cfg.Prefix, q.ID, len(q.Options))
				}
				if got := GradeSingle(q.Answer, q.Answer).Score; got != 100 {
					t.Errorf("%s #%d 标准答案未满分", cfg.Prefix, q.ID)
				}
			case "blank":
				ans := make([]string, len(q.Blanks))
				for j, v := range q.Blanks {
					if len(v) == 0 {
						t.Fatalf("%s #%d 空 %d 无候选", cfg.Prefix, q.ID, j)
					}
					ans[j] = v[0]
				}
				if got := GradeBlanks(ans, q.Blanks, q.Unordered, q.Fallback).Score; got != 100 {
					t.Errorf("%s #%d 标准填空答案 = %d", cfg.Prefix, q.ID, got)
				}
				if q.Unordered {
					for k := range ans {
						rot := append(append([]string{}, ans[k:]...), ans[:k]...)
						if got := GradeBlanks(rot, q.Blanks, true, false).Score; got != 100 {
							t.Errorf("%s #%d 轮换 %d 得分 %d", cfg.Prefix, q.ID, k, got)
						}
					}
				}
			case "essay":
				if got := GradeEssay(q.Ref, q.Points).Score; got < 95 {
					t.Errorf("%s #%d 原文作答 = %d, want >=95", cfg.Prefix, q.ID, got)
				}
			}
		}
	}
}
