package progress

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"grade-svc/internal/store"
	"grade-svc/internal/subject"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设置 TEST_DATABASE_URL，跳过数据库用例")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open admin: %v", err)
	}
	schema := fmt.Sprintf("t_prog_%d", time.Now().UnixNano())
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
	return db
}

func testService(t *testing.T) *Service {
	t.Helper()
	reg, err := subject.Load("../../../../subjects")
	if err != nil {
		t.Fatalf("load subjects: %v", err)
	}
	return &Service{DB: testDB(t), Reg: reg}
}

func TestSubmitFirstOnly(t *testing.T) {
	svc := testService(t)
	cfg := svc.Reg.Get("os")
	var q *subject.Question
	for i := range cfg.Questions {
		if cfg.Questions[i].Type == "single" {
			q = &cfg.Questions[i]
			break
		}
	}
	if q == nil {
		t.Fatal("没有单选题")
	}
	ctx := context.Background()
	correct, _ := json.Marshal(q.Answer)
	first, err := svc.Submit(ctx, "os", "testslot", SubmitReq{QID: q.ID, U: correct, Mode: "submit"})
	if err != nil {
		t.Fatal(err)
	}
	if !first.First || first.Score != 100 {
		t.Fatalf("首次提交 = first:%v score:%d", first.First, first.Score)
	}
	wrong, _ := json.Marshal("ZZ")
	second, err := svc.Submit(ctx, "os", "testslot", SubmitReq{QID: q.ID, U: wrong, Mode: "submit"})
	if err != nil {
		t.Fatal(err)
	}
	if !second.Practice || second.First || second.Score != 0 {
		t.Fatalf("重新评分应为练习分：%+v", second)
	}
	st, err := svc.Load(ctx, "os", "testslot")
	if err != nil {
		t.Fatal(err)
	}
	rec := st.Records[q.ID]
	var m map[string]json.RawMessage
	_ = json.Unmarshal(rec, &m)
	var score int
	_ = json.Unmarshal(m["s"], &score)
	if score != 100 {
		t.Fatalf("记录被练习分覆盖：%d", score)
	}
	// 重做后记录清空，再次提交重新计分
	if err := svc.Redo(ctx, "os", "testslot", q.ID); err != nil {
		t.Fatal(err)
	}
	st, _ = svc.Load(ctx, "os", "testslot")
	if _, ok := st.Records[q.ID]; ok {
		t.Fatal("重做后记录仍在")
	}
	third, err := svc.Submit(ctx, "os", "testslot", SubmitReq{QID: q.ID, U: wrong, Mode: "submit"})
	if err != nil {
		t.Fatal(err)
	}
	if !third.First {
		t.Fatal("重做后的提交应为首次")
	}
}

func TestBlankDetailAndClear(t *testing.T) {
	svc := testService(t)
	cfg := svc.Reg.Get("os")
	var q *subject.Question
	for i := range cfg.Questions {
		if cfg.Questions[i].Type == "blank" {
			q = &cfg.Questions[i]
			break
		}
	}
	if q == nil {
		t.Fatal("没有填空题")
	}
	ctx := context.Background()
	wrong := make([]string, len(q.Blanks))
	for i := range wrong {
		wrong[i] = "错答"
	}
	u, _ := json.Marshal(wrong)
	res, err := svc.Submit(ctx, "os", "blankuser", SubmitReq{QID: q.ID, U: u, Mode: "submit"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Score != 0 || len(res.Per) != len(q.Blanks) {
		t.Fatalf("填空判分异常：score=%d per=%d", res.Score, len(res.Per))
	}
	st, _ := svc.Load(ctx, "os", "blankuser")
	var m map[string]json.RawMessage
	_ = json.Unmarshal(st.Records[q.ID], &m)
	if len(m["g"]) == 0 {
		t.Fatal("判分明细未随记录落库")
	}
	if err := svc.Clear(ctx, "os", "blankuser"); err != nil {
		t.Fatal(err)
	}
	st, _ = svc.Load(ctx, "os", "blankuser")
	if len(st.Records) != 0 || len(st.Seen) != 0 {
		t.Fatalf("清空后仍有数据：records=%d seen=%d", len(st.Records), len(st.Seen))
	}
	if st.ClearedAt == 0 {
		t.Fatal("清空未记录 clearedAt")
	}
}

func TestPaperResetsRecords(t *testing.T) {
	svc := testService(t)
	cfg := svc.Reg.Get("os")
	ctx := context.Background()
	q := &cfg.Questions[0]
	u, _ := json.Marshal("A")
	if _, err := svc.Submit(ctx, "os", "paperuser", SubmitReq{QID: q.ID, U: u, Mode: "submit"}); err != nil {
		t.Fatal(err)
	}
	paper, err := svc.BuildPaper(ctx, "os", "paperuser", PaperReq{})
	if err != nil {
		t.Fatal(err)
	}
	if len(paper.Picked) == 0 || paper.Total <= 0 {
		t.Fatalf("组卷为空：%+v", paper)
	}
	st, _ := svc.Load(ctx, "os", "paperuser")
	if st.Paper == nil {
		t.Fatal("组卷未落库")
	}
	for _, id := range paper.Picked {
		raw, ok := st.Records[id]
		if !ok || len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		if v, ok := m["s"]; ok && string(v) != "null" && len(v) > 0 {
			t.Fatalf("卷内记录未重置：#%d s=%s", id, string(v))
		}
	}
	if err := svc.ClearPaper(ctx, "os", "paperuser"); err != nil {
		t.Fatal(err)
	}
	st, _ = svc.Load(ctx, "os", "paperuser")
	if st.Paper != nil {
		t.Fatal("关闭组卷后仍有卷面")
	}
}

func TestMarkViewed(t *testing.T) {
	svc := testService(t)
	cfg := svc.Reg.Get("os")
	q := &cfg.Questions[0]
	ctx := context.Background()
	if err := svc.MarkViewed(ctx, "os", "viewuser", q.ID); err != nil {
		t.Fatal(err)
	}
	st, err := svc.Load(ctx, "os", "viewuser")
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := st.Records[q.ID]
	if !ok {
		t.Fatal("看过标记未落库")
	}
	if recViewed(raw) == 0 {
		t.Fatal("v 字段为空")
	}
	// 再判分不应清掉 v，且「只看过解析」的记录不能阻止首次评分
	u, _ := json.Marshal("A")
	res, err := svc.Submit(ctx, "os", "viewuser", SubmitReq{QID: q.ID, U: u, Mode: "submit"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.First {
		t.Fatal("看过解析的未作答记录被误判为已评分")
	}
	st, _ = svc.Load(ctx, "os", "viewuser")
	if recViewed(st.Records[q.ID]) == 0 {
		t.Fatal("判分后看过标记丢失")
	}
}

func TestReciteAndMemo(t *testing.T) {
	svc := testService(t)
	cfg := svc.Reg.Get("os")
	ctx := context.Background()
	if _, err := svc.Load(ctx, "os", "viewuser"); err != nil {
		t.Fatal(err)
	}
	rec := BuildRecite(cfg, map[int]json.RawMessage{})
	if rec.Counts.Total != len(cfg.Questions) {
		t.Fatalf("未作答队列应含全部题目：%d/%d", rec.Counts.Total, len(cfg.Questions))
	}
	memo := BuildMemo(cfg, map[int]json.RawMessage{})
	if memo.Counts.Sections == 0 {
		t.Fatal("考点小节为空")
	}
	if memo.Counts.Pending != memo.Counts.Sections {
		t.Fatalf("未作答时全部考点应未掌握：pending=%d sections=%d", memo.Counts.Pending, memo.Counts.Sections)
	}
}

func TestClearThenSubmitUsesNewerTS(t *testing.T) {
	svc := testService(t)
	cfg := svc.Reg.Get("os")
	q := &cfg.Questions[0]
	ctx := context.Background()
	if err := svc.Clear(ctx, "os", "tsuser"); err != nil {
		t.Fatal(err)
	}
	st, _ := svc.Load(ctx, "os", "tsuser")
	cleared := st.ClearedAt
	u, _ := json.Marshal("A")
	if _, err := svc.Submit(ctx, "os", "tsuser", SubmitReq{QID: q.ID, U: u, Mode: "submit"}); err != nil {
		t.Fatal(err)
	}
	st, _ = svc.Load(ctx, "os", "tsuser")
	var m map[string]json.RawMessage
	_ = json.Unmarshal(st.Records[q.ID], &m)
	var ts int64
	_ = json.Unmarshal(m["ts"], &ts)
	if ts <= cleared {
		t.Fatalf("清空后提交的 ts=%d 应晚于 cleared_at=%d", ts, cleared)
	}
}

func TestConcurrentBuildPaper(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			_, err := svc.BuildPaper(ctx, "os", "concurrent", PaperReq{})
			errs <- err
		}()
	}
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("并发组卷失败：%v", err)
		}
	}
	st, err := svc.Load(ctx, "os", "concurrent")
	if err != nil {
		t.Fatal(err)
	}
	if st.Paper == nil {
		t.Fatal("并发组卷后应有卷面")
	}
}
