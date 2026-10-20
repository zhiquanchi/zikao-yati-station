// 判分服务单测：全部走 httptest 假上游，零真实网络、零计费。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func sampleReq() GradeReq {
	return GradeReq{
		Stem:   "操作系统的特征有哪些？",
		Ref:    "1、并发 2、共享",
		Points: []string{"并发：宏观同时微观串行", "共享：资源供多程序共用"},
		Answer: "并发和共享",
	}
}

// fakeOpenAI 返回假 chat completion，content 即模型输出的文本；calls 统计上游被调次数。
func fakeOpenAI(t *testing.T, content string, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls != nil {
			calls.Add(1)
		}
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("Authorization") == "" {
			t.Errorf("请求未携带 Authorization")
		}
		var got map[string]any
		_ = json.Unmarshal(body, &got)
		if m, _ := got["model"].(string); m != defaultModel {
			t.Errorf("model=%v，期望 %s", got["model"], defaultModel)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":"x","object":"chat.completion","created":0,"model":"fake","choices":[{"index":0,"message":{"role":"assistant","content":%s},"finish_reason":"stop"}]}`, quote(content))
	}))
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// —— normalize ——

func TestNormalizeBasic(t *testing.T) {
	r := sampleReq()
	content := `{"per":[{"i":1,"cov":1.5,"comment":"完全答到"},{"i":2,"cov":0.5},{"i":3,"cov":0.22},{"i":4,"cov":0.21}]}`
	// 先扩 points 到 4 条以覆盖三档 state
	r.Points = append(r.Points, "虚拟：一次逻辑扩张", "异步：时间片轮转")
	res, err := normalize(content, &r)
	if err != nil {
		t.Fatal(err)
	}
	wantCov := []float64{1, 0.5, 0.22, 0.21}
	wantState := []string{"hit", "hit", "part", "miss"}
	for i, p := range res.Per {
		if p.Cov != wantCov[i] || p.State != wantState[i] {
			t.Errorf("per[%d] cov=%v state=%v，期望 %v %v", i, p.Cov, p.State, wantCov[i], wantState[i])
		}
		if p.Text != r.Points[i] {
			t.Errorf("per[%d].text 应回填要点原文", i)
		}
	}
	if res.Score != 48 { // (1+0.5+0.22+0.21)/4 = 0.4825 → 48
		t.Errorf("score=%d，期望 48", res.Score)
	}
}

func TestNormalizePositionalAndOrder(t *testing.T) {
	r := sampleReq()
	// 省略编号且乱序带编号混合：第 1 条带 i=2，第 2 条省略编号 → 落到 idx=1 冲突，应报错
	bad := `{"per":[{"i":2,"cov":0.8},{"cov":0.3}]}`
	if _, err := normalize(bad, &r); err == nil {
		t.Fatal("混合编号与省略应检出编号冲突")
	}
	// 全带编号但乱序 → 按编号归位
	good := `{"per":[{"i":2,"cov":0.4,"comment":"部分"},{"i":1,"cov":1.0,"comment":"答到"}]}`
	res, err := normalize(good, &r)
	if err != nil {
		t.Fatal(err)
	}
	if res.Per[0].Cov != 1.0 || res.Per[1].Cov != 0.4 {
		t.Errorf("应按 i 归位：%+v", res.Per)
	}
	// 全省略 → 按顺序
	seq := `{"per":[{"cov":0.9},{"cov":0.1}]}`
	res, err = normalize(seq, &r)
	if err != nil || res.Per[0].Cov != 0.9 || res.Score != 50 {
		t.Errorf("省略编号应顺序回填：%v %+v", err, res)
	}
}

func TestNormalizeRejects(t *testing.T) {
	r := sampleReq()
	cases := map[string]string{
		"条数不符":  `{"per":[{"i":1,"cov":0.5}]}`,
		"编号越界":  `{"per":[{"i":9,"cov":0.5},{"i":1,"cov":0.5}]}`,
		"编号重复":  `{"per":[{"i":1,"cov":0.5},{"i":1,"cov":0.5}]}`,
		"缺 cov":   `{"per":[{"i":1},{"i":2,"cov":0.5}]}`,
		"非 JSON":  `抱歉无法判分`,
		"cov 非数值": `{"per":[{"i":1,"cov":"高"},{"i":2,"cov":0.5}]}`,
	}
	for name, c := range cases {
		if _, err := normalize(c, &r); err == nil {
			t.Errorf("%s 应判失败", name)
		} else {
			var se *svcErr
			if !asSvcErr(err, &se) || se.Status != 502 || se.Code != "parse" {
				t.Errorf("%s 错误应为 502/parse，实际 %v", name, err)
			}
		}
	}
}

func asSvcErr(err error, out **svcErr) bool {
	se, ok := err.(*svcErr)
	if ok {
		*out = se
	}
	return ok
}

func TestExtractJSONFenced(t *testing.T) {
	raw := "好的，判分如下：\n```json\n{\"per\":[{\"i\":1,\"cov\":1}]}\n```\n以上。"
	got := extractJSON(raw)
	if got != `{"per":[{"i":1,"cov":1}]}` {
		t.Errorf("extractJSON=%s", got)
	}
}

// —— Grade：缓存、上游错误分类、response_format 回退 ——

func TestGradeEndToEndAndCache(t *testing.T) {
	var calls atomic.Int32
	content := `{"per":[{"i":1,"cov":1.0,"comment":"答到并发"},{"i":2,"cov":0.6,"comment":"沾边不完整"}]}`
	srv := fakeOpenAI(t, content, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "")
	res, err := g.Grade(context.Background(), sampleReq())
	if err != nil {
		t.Fatal(err)
	}
	if res.Engine != "ai" || res.Cached || res.Score != 80 {
		t.Errorf("res=%+v", res)
	}
	res2, err := g.Grade(context.Background(), sampleReq())
	if err != nil || !res2.Cached {
		t.Errorf("第二次应命中缓存：%+v %v", res2, err)
	}
	if calls.Load() != 1 {
		t.Errorf("上游应只调 1 次，实际 %d", calls.Load())
	}
	// 换作答 → 缓存 miss，上游再被调一次（假 content 要点数相同仍会解析成功）
	other := sampleReq()
	other.Answer = "完全无关的内容"
	if _, err := g.Grade(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Errorf("换作答应绕过缓存再调上游，总次数=%d", calls.Load())
	}
}

func TestGradeRejectsBadInput(t *testing.T) {
	g := newGrader("sk-test", "http://127.0.0.1:1", "") // 不应被调到
	empty := sampleReq()
	empty.Answer = "  "
	_, err := g.Grade(context.Background(), empty)
	var se *svcErr
	if err == nil || !asSvcErr(err, &se) || se.Status != 400 || se.Code != "bad_request" {
		t.Errorf("空作答应 400/bad_request，实际 %v", err)
	}
}

func TestUpstream401MapsBadKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		io.WriteString(w, `{"error":{"message":"Invalid API key"}}`)
	}))
	defer srv.Close()
	g := newGrader("sk-bad", srv.URL, "")
	_, err := g.Grade(context.Background(), sampleReq())
	var se *svcErr
	if err == nil || !asSvcErr(err, &se) || se.Code != "bad_key" {
		t.Errorf("401 应映射 bad_key，实际 %v", err)
	}
}

// 上游拒绝 response_format 参数 → 去参重试一次并成功。
func TestResponseFormatFallback(t *testing.T) {
	var calls atomic.Int32
	content := `{"per":[{"i":1,"cov":0.8},{"i":2,"cov":0.4}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		if n == 1 {
			if !bytes.Contains(body, []byte("response_format")) {
				t.Errorf("首次请求应带 response_format")
			}
			w.WriteHeader(400)
			io.WriteString(w, `{"error":{"message":"Unknown parameter: 'response_format'.","type":"invalid_request_error"}}`)
			return
		}
		if bytes.Contains(body, []byte("response_format")) {
			t.Errorf("重试不应再带 response_format")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"choices":[{"index":0,"message":{"role":"assistant","content":%s}}]}`, quote(content))
	}))
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "")
	res, err := g.Grade(context.Background(), sampleReq())
	if err != nil {
		t.Fatal(err)
	}
	if res.Score != 60 {
		t.Errorf("score=%d 期望 60", res.Score)
	}
	if calls.Load() != 2 {
		t.Errorf("应调 2 次，实际 %d", calls.Load())
	}
}

// —— HTTP 层 ——

func TestHandlerNoKey501(t *testing.T) {
	g := newGrader("", "http://127.0.0.1:1", "")
	mux := newMux(g)
	req := httptest.NewRequest("POST", "/api/grade", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 501 {
		t.Fatalf("status=%d", rec.Code)
	}
	var body map[string]string
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body["error"] != "no_key" {
		t.Errorf("body=%v", body)
	}
}

func TestHandlerPassThrough(t *testing.T) {
	content := `{"per":[{"i":1,"cov":1.0},{"i":2,"cov":1.0}]}`
	srv := fakeOpenAI(t, content, nil)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "")
	mux := newMux(g)
	b, _ := json.Marshal(sampleReq())
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/api/grade", bytes.NewReader(b)))
	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res GradeResp
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Score != 100 || len(res.Per) != 2 {
		t.Errorf("res=%+v", res)
	}
}
