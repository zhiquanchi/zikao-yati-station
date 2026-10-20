// v2 派生行模型与统计端点回归：hist/expl 经 HTTP 的合并语义（并集去重留 10、ts LWW、clearedAt 压制范围）、
// PUT 后逐题行与 blob 一致、启动全量重建自愈、/stats 聚合口径、旧版载荷（无 extras 段）零破坏。
package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// openDBForQuery：测试侧裸连（不走 openStore，避免触发重建干扰断言；WAL 下读已提交数据无碍）。
func openDBForQuery(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

func queryRows(t *testing.T, dbPath, q string, args ...any) []map[string]any {
	t.Helper()
	db, err := openDBForQuery(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(q, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []map[string]any
	cols, _ := rows.Columns()
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		m := map[string]any{}
		for i, c := range cols {
			m[c] = vals[i]
		}
		out = append(out, m)
	}
	return out
}

func TestHistExplThroughHTTP(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "sync.db")
	srv := newTestSvc(t, dbPath)
	url := srv.URL + "/store/os/abc23d"
	// 第一包：带 hist（1 题 3 条）与 expl（1 题）
	if status, resp := putTo(t, url, `{"store":{"1":{"u":"a","s":100,"ts":10}},"shuf":null,"clearedAt":0,
		"hist":{"1":[{"u":"a0","s":0,"ts":5},{"u":"a1","s":50,"ts":6},{"u":"a2","s":100,"ts":7}]},
		"expl":{"1":{"source":"material","items":[{"key":"A","correct":true,"why":"对"}],"ts":8}}}`); status != 200 {
		t.Fatal(status, resp)
	}
	// 第二包：hist 同 ts 重复（先到先得，已存端优先）+ 新 ts 并入 + 超 10 条触发裁剪；expl 新 ts 覆盖
	many := `{"u":"b","s":1,"ts":100},{"u":"b","s":2,"ts":101},{"u":"b","s":3,"ts":102},{"u":"b","s":4,"ts":103},{"u":"b","s":5,"ts":104},{"u":"b","s":6,"ts":105},{"u":"b","s":7,"ts":106},{"u":"b","s":8,"ts":107},{"u":"b","s":9,"ts":108}`
	_, r := putTo(t, url, `{"store":{},"shuf":null,"clearedAt":0,"hist":{"1":[{"u":"a2","s":999,"ts":7},`+many+`]},"expl":{"1":{"source":"search","items":[],"ts":9}}}`)
	if !strings.Contains(r, `"hist"`) || !strings.Contains(r, `"expl"`) {
		t.Fatalf("响应应含 hist/expl 段：%s", r)
	}
	var got struct {
		Blob struct {
			Hist map[string][]map[string]any `json:"hist"`
			Expl map[string]map[string]any   `json:"expl"`
		} `json:"blob"`
	}
	if err := json.Unmarshal([]byte(r), &got); err != nil {
		t.Fatal(err)
	}
	h := got.Blob.Hist["1"]
	if len(h) != 10 {
		t.Fatalf("hist 应裁剪到最近 10 条，得 %d：%v", len(h), h)
	}
	for _, e := range h {
		// ts=7 的条目：先到先得保留第一包的 s=100（而非第二包伪装的 s=999）；ts≤6 被裁剪出局
		if e["ts"].(float64) == 7 && e["s"].(float64) != 100 {
			t.Errorf("同 ts 应先到先得（已存端优先）：%v", e)
		}
	}
	if e := got.Blob.Expl["1"]; e["source"] != "search" || e["ts"].(float64) != 9 {
		t.Errorf("expl 应 ts-LWW 新者胜：%v", e)
	}
	// 行表与 blob 一致（清空前）：answers 1 行、history 10 行、explains 1 行
	if ans := queryRows(t, dbPath, `SELECT qid, s FROM answers WHERE subject='os' AND "user"='abc23d'`); len(ans) != 1 || ans[0]["s"].(float64) != 100 {
		t.Fatalf("answers 行不符：%v", ans)
	}
	if hh := queryRows(t, dbPath, `SELECT ts FROM history WHERE subject='os' AND "user"='abc23d'`); len(hh) != 10 {
		t.Fatalf("history 行数应为 10，得 %d", len(hh))
	}
	if ex := queryRows(t, dbPath, `SELECT ts FROM explains WHERE subject='os'`); len(ex) != 1 || ex[0]["ts"].(int64) != 9 {
		t.Fatalf("explains 行不符：%v", ex)
	}
	// clearedAt 压制 hist（ts≤）但不压 expl；store 记录一并压制 → answers 行清空
	_, r = putTo(t, url, `{"store":{},"shuf":null,"clearedAt":106}`)
	if err := json.Unmarshal([]byte(r), &got); err != nil {
		t.Fatal(err)
	}
	for _, e := range got.Blob.Hist["1"] {
		if e["ts"].(float64) <= 106 {
			t.Fatalf("clearedAt 未压制 hist：%v", got.Blob.Hist["1"])
		}
	}
	if len(got.Blob.Hist["1"]) != 2 {
		t.Errorf("clearedAt=106 后 hist 应剩 ts 107/108 两条：%v", got.Blob.Hist["1"])
	}
	if got.Blob.Expl["1"] == nil {
		t.Fatal("expl 不应受 clearedAt 影响")
	}
	if ans := queryRows(t, dbPath, `SELECT qid FROM answers WHERE subject='os'`); len(ans) != 0 {
		t.Fatalf("clearedAt 压制后 answers 行应清空：%v", ans)
	}
	if hh := queryRows(t, dbPath, `SELECT ts FROM history WHERE subject='os'`); len(hh) != 2 {
		t.Fatalf("history 行应随 blob 收敛为 2：%v", hh)
	}
}

func TestLegacyPayloadUnaffected(t *testing.T) {
	srv := newTestSvc(t, filepath.Join(t.TempDir(), "sync.db"))
	url := srv.URL + "/store/os"
	if status, resp := putTo(t, url, `{"store":{"1":{"u":"a","ts":1}},"shuf":null,"clearedAt":0}`); status != 200 {
		t.Fatal(status, resp)
	} else if strings.Contains(resp, `"hist"`) || strings.Contains(resp, `"expl"`) {
		t.Fatalf("旧版载荷响应不应出现 extras 键：%s", resp)
	}
}

func TestStatsEndpoint(t *testing.T) {
	srv := newTestSvc(t, filepath.Join(t.TempDir(), "sync.db"))
	putTo(t, srv.URL+"/store/os/abc23d", `{"store":{"1":{"u":"a","s":100,"ts":1},"2":{"u":null,"s":null,"ts":2},"3":{"u":"c","s":40,"ts":3}},"shuf":null,"clearedAt":0}`)
	putTo(t, srv.URL+"/store/os/z9k2mm", `{"store":{"1":{"u":"x","s":80,"ts":4}},"shuf":null,"clearedAt":0}`)
	stats := getJSON(t, srv.URL+"/stats/os")
	if stats["subject"] != "os" {
		t.Errorf("subject 回显不符：%v", stats["subject"])
	}
	qs, _ := stats["questions"].([]any)
	if len(qs) != 3 {
		t.Fatalf("逐题统计应为 3 题（含墓碑行），得 %v", qs)
	}
	q1 := qs[0].(map[string]any)
	if q1["qid"].(float64) != 1 || q1["answered"].(float64) != 2 || q1["mastered"].(float64) != 2 {
		t.Errorf("题 1 统计不符：%v", q1)
	}
	q2 := qs[1].(map[string]any) // 墓碑：total 计、answered 0、avg null
	if q2["answered"].(float64) != 0 || q2["avg"] != nil {
		t.Errorf("题 2（墓碑）统计不符：%v", q2)
	}
	us, _ := stats["users"].([]any)
	if len(us) != 2 {
		t.Fatalf("用户统计应为 2 个码槽：%v", us)
	}
	r := getJSON(t, srv.URL+"/stats/net")
	if rl, _ := r["questions"].([]any); len(rl) != 0 {
		t.Errorf("net 无数据应空数组：%v", r)
	}
	resp404, _ := http.Get(srv.URL + "/stats/%E4%BD%A0%E5%A5%BD")
	if resp404.StatusCode != 404 {
		t.Errorf("非法科目名应 404，得 %d", resp404.StatusCode)
	}
	resp404.Body.Close()
}

func TestRebuildRowsSelfHeal(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "sync.db")
	srv := newTestSvc(t, dbPath)
	putTo(t, srv.URL+"/store/os/abc23d", `{"store":{"1":{"u":"a","s":100,"ts":1}},"shuf":null,"clearedAt":0,"hist":{"1":[{"u":"z","s":0,"ts":2}]},"expl":{"1":{"items":[],"ts":3}}}`)
	// 人为破坏行表（模拟派生视图与事实源漂移）
	db, err := openDBForQuery(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM answers`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM explains`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	srv.Close()
	// 重开服务＝启动重建：行表恢复与 blob 一致
	srv2 := newTestSvc(t, dbPath)
	defer srv2.Close()
	if ans := queryRows(t, dbPath, `SELECT qid FROM answers`); len(ans) != 1 {
		t.Fatalf("重建后 answers 应恢复：%v", ans)
	}
	if ex := queryRows(t, dbPath, `SELECT qid FROM explains`); len(ex) != 1 {
		t.Fatalf("重建后 explains 应恢复：%v", ex)
	}
	if h := queryRows(t, dbPath, `SELECT qid FROM history`); len(h) != 1 {
		t.Fatalf("重建后 history 应恢复：%v", h)
	}
}
