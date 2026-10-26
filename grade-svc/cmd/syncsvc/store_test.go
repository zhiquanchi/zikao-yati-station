// sync-svc 行为回归（包内 httptest 直测，零真实网络）：登录后槽位按 (科目, 账号) 隔离、
// 同步码/载荷格式拒收、体积与方法白名单、经 HTTP 的 LWW/压制收敛。
// 存储为 PostgreSQL：测试库由 TEST_DATABASE_URL 提供，每个用例独立 schema（见 pgtest_test.go）。
package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestSvcStore(t *testing.T, dsn string) (*httptest.Server, *slotStore) {
	t.Helper()
	st, err := openStore(dsn)
	if err != nil {
		t.Fatalf("openStore：%v", err)
	}
	srv := httptest.NewServer(newSyncMux(st))
	t.Cleanup(func() { srv.Close(); st.db.Close() })
	return srv, st
}

func newTestSvc(t *testing.T, dsn string) *httptest.Server {
	srv, _ := newTestSvcStore(t, dsn)
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
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT %s：%v", url, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// registerOn：在同一个服务上注册账号并返回带 Cookie 的客户端与账号 slot。
func registerOn(t *testing.T, srv *httptest.Server, email string) (*http.Client, string) {
	t.Helper()
	c := newClient(t)
	status, body, _ := postJSON(t, c, srv.URL+"/auth/register", map[string]string{
		"email": email, "password": "password123",
	})
	if status != 201 {
		t.Fatalf("注册 %s 应 201，得 %d（%v）", email, status, body)
	}
	slot, _ := userOf(body)["slot"].(string)
	if slot == "" {
		t.Fatalf("注册响应缺 slot：%v", body)
	}
	return c, slot
}

func putWithClientBody(t *testing.T, c *http.Client, url, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest("PUT", url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
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
	srv := newTestSvc(t, testDSN(t))
	c1, slot1 := registerOn(t, srv, "a@example.com")
	c2, slot2 := registerOn(t, srv, "b@example.com")
	rec := `{"store":{"7":{"u":"C","s":100,"ts":1000}},"shuf":null,"clearedAt":0}`

	if b := getJSONWithClient(t, c1, srv.URL+"/store/os")["blob"]; b != nil {
		t.Fatalf("空槽应返回 null，得 %v", b)
	}
	if status, resp := putWithClientBody(t, c1, srv.URL+"/store/os/"+slot1, rec); status != 200 {
		t.Fatalf("PUT 本人 slot 应 200，得 %d（%s）", status, resp)
	}
	var got slotResp
	raw, _ := json.Marshal(getJSONWithClient(t, c1, srv.URL+"/store/os"))
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Blob.Store["7"]["s"].(float64) != 100 {
		t.Fatalf("无尾段 GET 应命中本人槽位：%s", raw)
	}
	if b := getJSONWithClient(t, c2, srv.URL+"/store/os")["blob"]; b != nil {
		t.Fatalf("另一用户槽位应独立为空，得 %v", b)
	}
	if status, _ := putWithClientBody(t, c1, srv.URL+"/store/os/"+slot2, rec); status != 403 {
		t.Fatalf("访问他人 slot 应 403，得 %d", status)
	}
	if b := getJSONWithClient(t, c1, srv.URL+"/store/net/"+slot1)["blob"]; b != nil {
		t.Fatalf("另一科目槽位应独立，得 %v", b)
	}
	// 无尾段 PUT 同样落到会话槽位
	if status, resp := putWithClientBody(t, c1, srv.URL+"/store/os", rec); status != 200 {
		t.Fatalf("无尾段 PUT 应 200，得 %d（%s）", status, resp)
	}
}

func TestRejections(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))
	c, slot := registerOn(t, srv, "a@example.com")
	ok := `{"store":{"1":{"u":"a","s":null,"ts":1}},"shuf":null,"clearedAt":0}`
	// 路径格式校验先于鉴权：这些不需要 Cookie
	noAuth := []struct {
		name, url, body string
		want            int
	}{
		{"非法码（大写）", "/store/os/ABC23", ok, 400},
		{"非法码（过短）", "/store/os/abc", ok, 400},
		{"非法码（含禁用字符）", "/store/os/ab01io", ok, 400},
		{"非法科目名", "/store/%E4%BD%A0%E5%A5%BD/abc23d/", ok, 404},
	}
	for _, tc := range noAuth {
		if status, resp := putTo(t, srv.URL+tc.url, tc.body); status != tc.want {
			t.Errorf("%s：期望 %d 得 %d（%s）", tc.name, tc.want, status, resp)
		}
	}

	authURL := srv.URL + "/store/os/" + slot
	cases := []struct {
		name, body string
		want       int
	}{
		{"非数字题号", `{"store":{"a1":{"u":"x","ts":1}},"shuf":null,"clearedAt":0}`, 400},
		{"缺 ts", `{"store":{"1":{"u":"x"}},"shuf":null,"clearedAt":0}`, 400},
		{"缺 u", `{"store":{"1":{"ts":1}},"shuf":null,"clearedAt":0}`, 400},
		{"s 非数字", `{"store":{"1":{"u":"x","s":"100","ts":1}},"shuf":null,"clearedAt":0}`, 400},
		{"store 缺失", `{"shuf":null,"clearedAt":0}`, 400},
		{"坏 JSON", `not-json`, 400},
		{"超 4MB", `{"store":{"100":{"u":"` + strings.Repeat("x", 4<<20) + `","ts":1}},"shuf":null,"clearedAt":0}`, 413},
		{"hist 非对象", `{"store":{},"shuf":null,"clearedAt":0,"hist":[]}`, 400},
		{"hist 值非数组", `{"store":{},"shuf":null,"clearedAt":0,"hist":{"1":{"u":"a","ts":9}}}`, 400},
		{"hist 条目缺 ts", `{"store":{},"shuf":null,"clearedAt":0,"hist":{"1":[{"u":"a","s":1}]}}`, 400},
		{"hist 条目缺 u", `{"store":{},"shuf":null,"clearedAt":0,"hist":{"1":[{"s":1,"ts":9}]}}`, 400},
		{"hist 键非数字", `{"store":{},"shuf":null,"clearedAt":0,"hist":{"a1":[{"u":"a","ts":9}]}}`, 400},
		{"expl 缺 items", `{"store":{},"shuf":null,"clearedAt":0,"expl":{"1":{"source":"ref","ts":9}}}`, 400},
		{"expl 缺 ts", `{"store":{},"shuf":null,"clearedAt":0,"expl":{"1":{"items":[]}}}`, 400},
	}
	for _, tc := range cases {
		if status, resp := putWithClientBody(t, c, authURL, tc.body); status != tc.want {
			t.Errorf("%s：期望 %d 得 %d（%s）", tc.name, tc.want, status, resp)
		}
	}
	req, err := http.NewRequest("DELETE", authURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := c.Do(req)
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
	srv := newTestSvc(t, testDSN(t))
	c, slot := registerOn(t, srv, "a@example.com")
	url := srv.URL + "/store/net/" + slot
	if status, resp := putWithClientBody(t, c, url, `{"store":{"1":{"u":"a","s":100,"ts":1000},"2":{"u":"b","ts":1500}},"shuf":null,"clearedAt":0}`); status != 200 {
		t.Fatal(status, resp)
	}
	// 旧 ts 覆盖被拒、新题并入
	_, r := putWithClientBody(t, c, url, `{"store":{"1":{"u":"old","ts":500},"3":{"u":"c","ts":1600}},"shuf":null,"clearedAt":0}`)
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
	if _, r = putWithClientBody(t, c, url, `{"store":{},"shuf":null,"clearedAt":9999999999999}`); !strings.Contains(r, `"store":{}`) {
		t.Errorf("clearedAt 未压制存量：%s", r)
	}
}