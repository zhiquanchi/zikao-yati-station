package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

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
	schema := fmt.Sprintf("t_store_%d", time.Now().UnixNano())
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
	db, err := Open(dsn + sep + "search_path=" + schema)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestMigrateV1(t *testing.T) {
	db := testDB(t)
	reg, err := subject.Load("../../../../subjects")
	if err != nil {
		t.Fatalf("load subjects: %v", err)
	}
	cfg := reg.Get("os")
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
	now := time.Now().UnixMilli()
	// 建账号 + v1 blob（store 里的 s 故意写错，迁移应重算）
	if _, err := db.Exec(`INSERT INTO users (email,pass_hash,slot,is_guest,created_at,updated_at) VALUES ('m@example.com','x','migslot',false,$1,$1)`, now); err != nil {
		t.Fatal(err)
	}
	blob := map[string]any{
		"store": map[string]any{
			fmt.Sprint(q.ID): map[string]any{"u": []string{q.Blanks[0][0]}, "s": 0, "ts": now},
		},
		"shuf":      nil,
		"clearedAt": 0,
		"hist": map[string]any{
			fmt.Sprint(q.ID): []any{map[string]any{"u": q.Blanks[0][0], "s": 0, "ts": now - 1000}},
		},
	}
	raw, _ := json.Marshal(blob)
	if _, err := db.Exec(`INSERT INTO sync (subject,user_slot,blob,updated_at) VALUES ('os','migslot',$1,$2)`, string(raw), now); err != nil {
		t.Fatal(err)
	}

	rep, err := MigrateV1(context.Background(), db, reg, false)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Records == 0 || !rep.Dropped {
		t.Fatalf("迁移统计异常：%+v", rep)
	}
	var score int
	if err := db.QueryRow(`SELECT (rec->>'s')::int FROM progress WHERE subject='os' AND user_slot='migslot' AND qid=$1`, q.ID).Scan(&score); err != nil {
		t.Fatal(err)
	}
	if score != 100 {
		t.Fatalf("填空分数未重算：%d", score)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM histories WHERE user_slot='migslot' AND qid=$1`, q.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("历史未迁移：%d", n)
	}
	var old sql.NullString
	_ = db.QueryRow(`SELECT to_regclass('sync')::text`).Scan(&old)
	if old.Valid && old.String != "" {
		t.Fatal("v1 表未删除")
	}
}

func TestImportBlob(t *testing.T) {
	db := testDB(t)
	reg, err := subject.Load("../../../../subjects")
	if err != nil {
		t.Fatal(err)
	}
	cfg := reg.Get("os")
	var q *subject.Question
	for i := range cfg.Questions {
		if cfg.Questions[i].Type == "single" {
			q = &cfg.Questions[i]
			break
		}
	}
	now := time.Now().UnixMilli()
	blob, _ := json.Marshal(map[string]any{
		"store": map[string]any{fmt.Sprint(q.ID): map[string]any{"u": q.Answer, "s": 0, "ts": now}},
	})
	n, err := ImportBlob(context.Background(), db, reg, "os", "importer", blob)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("导入条数 = %d", n)
	}
	var score int
	if err := db.QueryRow(`SELECT (rec->>'s')::int FROM progress WHERE user_slot='importer' AND qid=$1`, q.ID).Scan(&score); err != nil {
		t.Fatal(err)
	}
	if score != 100 {
		t.Fatalf("导入未重算分数：%d", score)
	}
}
