// 同步鉴权回归：/store 必须登录；槽位以会话为准，路径 slot 只做一致性校验；
// 路径格式校验仍在鉴权前（非法码 400），未登录 401，拿别人槽位 403。
package main

import (
	"net/http"
	"strings"
	"testing"
)

func TestStoreRequiresLogin(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))

	resp, err := http.Get(srv.URL + "/store/os")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("未登录 GET /store/os 应 401，得 %d", resp.StatusCode)
	}
	status, body := putTo(t, srv.URL+"/store/os", `{"store":{"1":{"u":"a","ts":1}},"shuf":null,"clearedAt":0}`)
	if status != 401 {
		t.Fatalf("未登录 PUT 应 401，得 %d（%s）", status, body)
	}
	// 路径格式校验先于鉴权：非法码仍是 400
	resp, err = http.Get(srv.URL + "/store/os/ABC")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("非法码应 400（先于鉴权），得 %d", resp.StatusCode)
	}
}

func TestStoreSlotMustMatchSession(t *testing.T) {
	srv := newTestSvc(t, testDSN(t))
	c1 := newClient(t)
	c2 := newClient(t)
	_, b1, _ := postJSON(t, c1, srv.URL+"/auth/register", map[string]string{"email": "a@example.com", "password": "password123"})
	_, b2, _ := postJSON(t, c2, srv.URL+"/auth/register", map[string]string{"email": "b@example.com", "password": "password123"})
	slot1 := userOf(b1)["slot"].(string)
	slot2 := userOf(b2)["slot"].(string)

	// 无尾段：用会话槽位
	if pstatus := putWithClient(t, c1, srv.URL+"/store/os", `{"store":{"1":{"u":"a","s":100,"ts":1}},"shuf":null,"clearedAt":0}`); pstatus != 200 {
		t.Fatalf("登录后 PUT 应 200，得 %d", pstatus)
	}

	// 正确 slot 路径可读写
	gstatus := getWithClientStatus(t, c1, srv.URL+"/store/os/"+slot1)
	if gstatus != 200 {
		t.Fatalf("带正确 slot 应 200，得 %d", gstatus)
	}
	// 另一用户 slot 403
	gstatus = getWithClientStatus(t, c1, srv.URL+"/store/os/"+slot2)
	if gstatus != 403 {
		t.Fatalf("访问他人 slot 应 403，得 %d", gstatus)
	}
	// 用户 B 的槽位为空（数据隔离）
	got := getJSONWithClient(t, c2, srv.URL+"/store/os")
	if got["blob"] != nil {
		t.Fatalf("用户 B 槽位应为空，得 %v", got["blob"])
	}
}

func putWithClient(t *testing.T, c *http.Client, url, body string) int {
	t.Helper()
	req, err := http.NewRequest("PUT", url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func getWithClientStatus(t *testing.T, c *http.Client, url string) int {
	t.Helper()
	resp, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func getJSONWithClient(t *testing.T, c *http.Client, url string) map[string]any {
	t.Helper()
	status, m, _ := getWithClient(t, c, url)
	if status != 200 {
		t.Fatalf("GET %s 应 200，得 %d", url, status)
	}
	return m
}