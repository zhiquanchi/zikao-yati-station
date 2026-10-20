// sync-svc 行为回归（包内 httptest 直测，零真实网络）：槽位按 (科目, 用户) 隔离、
// 旧版单槽表启动迁移（存量回填 user=''）、同步码/载荷格式拒收、体积与方法白名单、经 HTTP 的 LWW/压制收敛。
package main

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func newTestSvc(t *testing.T, dbPath string) *httptest.Server {
	t.Helper()
	st, err := openStore(dbPath)
	if err != nil {
		t.Fatalf("openStore：%v", err)
	}
	srv := httptest.NewServer(newSyncMux(st))
	t.Cleanup(func() { srv.Close(); st.db.Close() })
	return srv
}

func getJSON(t *testing.T, url string) map[string]any {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s：%v", url, err)
	}
	defer resp.Body.Close()
	var v map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatalf("解码响应：%v", err)
	}
	return v
}

func putTo(t *testing.T, url, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest("PUT", url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT %s：%v", url, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

type slotResp struct {
	Blob struct {
		Store map[string]map[string]any `json:"store"`
		Shuf  map[string]any            `json:"shuf"`
	} `json:"blob"`
}

func TestSlotIsolation(t *testing.T) {
	srv := newTestSvc(t, filepath.Join(t.TempDir(), "sync.db"))
	base := srv.URL + "/store/os" // 无尾段＝旧版兼容槽（user=''）

	if b := getJSON(t, base)["blob"]; b != nil {
		t.Fatalf("空槽应返回 null，得 %v", b)
	}
	codeURL := base + "/abc23d"
	rec := `{"store":{"7":{"u":"C","s":100,"ts":1000}},"shuf":null,"clearedAt":0}`
	if status, resp := putTo(t, codeURL, rec); status != 200 {
		t.Fatalf("PUT 码槽应 200，得 %d（%s）", status, resp)
	}
	if b := getJSON(t, base)["blob"]; b != nil {
		t.Fatalf("码槽写入不应污染旧版槽，得 %v", b)
	}
	var got slotResp
	raw, _ := json.Marshal(getJSON(t, codeURL))
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Blob.Store["7"]["s"].(float64) != 100 {
		t.Fatalf("码槽取回内容不符：%s", raw)
	}
	if b := getJSON(t, base+"/z9k2mm")["blob"]; b != nil {
		t.Fatalf("另一码槽应独立为空，得 %v", b)
	}
	if b := getJSON(t, srv.URL+"/store/net/abc23d")["blob"]; b != nil {
		t.Fatalf("另一科目码槽应独立，得 %v", b)
	}
	// 旧版兼容槽可独立读写（站长路径）
	if status, resp := putTo(t, base, rec); status != 200 {
		t.Fatalf("PUT 旧版槽应 200，得 %d（%s）", status, resp)
	}
	raw, _ = json.Marshal(getJSON(t, base))
	var legacy slotResp
	if err := json.Unmarshal(raw, &legacy); err != nil || legacy.Blob.Store["7"] == nil {
		t.Fatalf("旧版槽写入未生效：%s", raw)
	}
}

func TestLegacySchemaMigration(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "sync.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE sync (subject TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at INTEGER NOT NULL);`); err != nil {
		t.Fatal(err)
	}
	legacy := `{"store":{"3":{"u":"A","s":100,"ts":555}},"shuf":null,"clearedAt":0,"updatedAt":555}`
	if _, err := db.Exec(`INSERT INTO sync (subject, blob, updated_at) VALUES (?, ?, ?)`, "os", legacy, 555); err != nil {
		t.Fatal(err)
	}
	db.Close()

	srv := newTestSvc(t, dbPath) // openStore 检出旧单槽表 → 事务内重建迁移
	resp := getJSON(t, srv.URL+"/store/os")
	if resp["blob"] == nil {
		t.Fatal("迁移后旧版槽存量应原样可读")
	}
	raw, _ := json.Marshal(resp)
	var slot slotResp
	if err := json.Unmarshal(raw, &slot); err != nil {
		t.Fatal(err)
	}
	if slot.Blob.Store["3"]["u"] != "A" || slot.Blob.Store["3"]["ts"].(float64) != 555 {
		t.Fatalf("迁移后存量变形：%s", raw)
	}
	if status, resp := putTo(t, srv.URL+"/store/os/abcd23", `{"store":{"9":{"u":"x","ts":600}},"shuf":null,"clearedAt":0}`); status != 200 {
		t.Fatalf("迁移后码槽写入失败：%d（%s）", status, resp)
	}
	raw, _ = json.Marshal(getJSON(t, srv.URL+"/store/os"))
	var old slotResp
	if err := json.Unmarshal(raw, &old); err != nil || old.Blob.Store["9"] != nil {
		t.Fatalf("码槽写入串进了旧版槽：%s", raw)
	}
	if old.Blob.Store["3"] == nil {
		t.Fatalf("旧版槽存量被码槽写入误伤：%s", raw)
	}
}

func TestRejections(t *testing.T) {
	srv := newTestSvc(t, filepath.Join(t.TempDir(), "sync.db"))
	ok := `{"store":{"1":{"u":"a","s":null,"ts":1}},"shuf":null,"clearedAt":0}`
	cases := []struct {
		name, url, body string
		want            int
	}{
		{"非法码（大写）", "/store/os/ABC23", ok, 400},
		{"非法码（过短）", "/store/os/abc", ok, 400},
		{"非法码（含禁用字符）", "/store/os/ab01io", ok, 400},
		{"非数字题号", "/store/os/abc23d", `{"store":{"a1":{"u":"x","ts":1}},"shuf":null,"clearedAt":0}`, 400},
		{"缺 ts", "/store/os/abc23d", `{"store":{"1":{"u":"x"}},"shuf":null,"clearedAt":0}`, 400},
		{"缺 u", "/store/os/abc23d", `{"store":{"1":{"ts":1}},"shuf":null,"clearedAt":0}`, 400},
		{"s 非数字", "/store/os/abc23d", `{"store":{"1":{"u":"x","s":"100","ts":1}},"shuf":null,"clearedAt":0}`, 400},
		{"store 缺失", "/store/os/abc23d", `{"shuf":null,"clearedAt":0}`, 400},
		{"坏 JSON", "/store/os/abc23d", `not-json`, 400},
		{"超 1MB", "/store/os/abc23d", `{"store":{"100":{"u":"` + strings.Repeat("x", 1<<20) + `","ts":1}},"shuf":null,"clearedAt":0}`, 413},
		{"非法科目名", "/store/%E4%BD%A0%E5%A5%BD/abc23d/", ok, 404},
	}
	for _, c := range cases {
		status, resp := putTo(t, srv.URL+c.url, c.body)
		if status != c.want {
			t.Errorf("%s：期望 %d 得 %d（%s）", c.name, c.want, status, resp)
		}
	}
	req, err := http.NewRequest("DELETE", srv.URL+"/store/os/abc23d", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 405 || string(b) != "Method Not Allowed" {
		t.Fatalf("DELETE 期望 405 文本，得 %d（%s）", resp.StatusCode, b)
	}
	if h := getJSON(t, srv.URL+"/api/health"); h["ok"] != true {
		t.Fatalf("health：%v", h)
	}
}

func TestMergeThroughHTTP(t *testing.T) {
	srv := newTestSvc(t, filepath.Join(t.TempDir(), "sync.db"))
	url := srv.URL + "/store/net/abc23d"
	if status, resp := putTo(t, url, `{"store":{"1":{"u":"a","s":100,"ts":1000},"2":{"u":"b","ts":1500}},"shuf":null,"clearedAt":0}`); status != 200 {
		t.Fatal(status, resp)
	}
	// 旧 ts 覆盖被拒、新题并入
	_, r := putTo(t, url, `{"store":{"1":{"u":"old","ts":500},"3":{"u":"c","ts":1600}},"shuf":null,"clearedAt":0}`)
	var got slotResp
	if err := json.Unmarshal([]byte(r), &got); err != nil {
		t.Fatal(err)
	}
	if got.Blob.Store["1"]["u"] != "a" {
		t.Errorf("ts-LWW 失效：%s", r)
	}
	if got.Blob.Store["3"]["u"] != "c" {
		t.Errorf("新题未并入：%s", r)
	}
	// clearedAt 压制本槽全部存量
	if _, r = putTo(t, url, `{"store":{},"shuf":null,"clearedAt":9999999999999}`); !strings.Contains(r, `"store":{}`) {
		t.Errorf("clearedAt 未压制存量：%s", r)
	}
}
