// 逐项解析流式链路单测：增量 JSON 扫描器（任意切块/转义/key 迟到）、两级链路事件序（delta/reset/done）、
// 错误映射与 HTTP 层 SSE 应答。假上游按 stream 协议吐 chunk，零真实网络。
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
	"testing"
)

// splitRunes 按 rune 数把模型输出切成流式 chunk（模拟逐 token 吐字）。
func splitRunes(s string, n int) []string {
	var out []string
	var cur []rune
	for _, r := range s {
		cur = append(cur, r)
		if len(cur) >= n {
			out = append(out, string(cur))
			cur = nil
		}
	}
	if len(cur) > 0 {
		out = append(out, string(cur))
	}
	return out
}

// fakeExplStream 假流式上游：第 i 次调用回放 stages[i]（字符串数组＝content 分块）；
// 单元素且以 "!" 开头回 400（正文为其余文本）、"@401" 回 401，语义同 fakeExpl。
func fakeExplStream(t *testing.T, stages [][]string, calls *[]explCall) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(body, &got)
		*calls = append(*calls, explCall{got, string(body)})
		i := len(*calls) - 1
		if i >= len(stages) {
			t.Errorf("上游被调用 %d 次，超出脚本 %d 次", len(*calls), len(stages))
			w.WriteHeader(500)
			return
		}
		st := stages[i]
		if len(st) == 1 && strings.HasPrefix(st[0], "@401") {
			w.WriteHeader(401)
			io.WriteString(w, `{"error":{"message":"Invalid API key"}}`)
			return
		}
		if len(st) == 1 && strings.HasPrefix(st[0], "!") {
			w.WriteHeader(400)
			fmt.Fprintf(w, `{"error":{"message":%s}}`, quote(strings.TrimPrefix(st[0], "!")))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", `{"choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}`)
		for _, c := range st {
			fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":%s},\"finish_reason\":null}]}\n\n", quote(c))
		}
		io.WriteString(w, "data: [DONE]\n\n")
	}))
}

// evLog 收集事件流供断言。
type evLog struct {
	deltas []explDelta
	resets int
}

func (l *evLog) emit(event string, data any) error {
	switch event {
	case "delta":
		l.deltas = append(l.deltas, data.(explDelta))
	case "reset":
		l.resets++
	}
	return nil
}

// ——— 扫描器纯单元 ———

func runScan(t *testing.T, out string, chunkN int) (*evLog, bool) {
	t.Helper()
	l := &evLog{}
	sc := &explScanner{emit: func(key, text string) error {
		l.deltas = append(l.deltas, explDelta{Key: key, Text: text})
		return nil
	}}
	for _, c := range splitRunes(out, chunkN) {
		if err := sc.Feed(c); err != nil {
			t.Fatal(err)
		}
	}
	return l, sc.sawDelta
}

func joined(l *evLog, key string) string {
	var sb strings.Builder
	for _, d := range l.deltas {
		if d.Key == key {
			sb.WriteString(d.Text)
		}
	}
	return sb.String()
}

func TestExplScannerAllSplits(t *testing.T) {
	for _, n := range []int{1, 2, 3, 7, 64, 9999} {
		l, saw := runScan(t, explFoundTrue, n)
		if !saw {
			t.Fatalf("切块 %d：应产生增量", n)
		}
		want := map[string]string{
			"A": "并发是四大特征之一，宏观同时推进",
			"B": "无此特征，程序执行是异步的",
			"C": "资源是共享的，非独占",
			"D": "执行顺序不确定，非顺序性",
		}
		for k, w := range want {
			if got := joined(l, k); got != w {
				t.Errorf("切块 %d：选项 %s 增量拼接不符：%q != %q", n, k, got, w)
			}
		}
		if len(l.deltas) != 0 {
			for _, d := range l.deltas {
				if d.Text == "" {
					t.Errorf("切块 %d：不应有空文本事件", n)
				}
			}
		}
	}
}

// 转义字符在 why 中：解码后按原样推送（\" \\ \n \uXXXX 与代理对）。
func TestExplScannerEscapes(t *testing.T) {
	out := `{"items":[{"key":"A","why":"含\"引号\"、反斜杠\\、` + "\n" + `与 emoji😀"},{"key":"B","why":"b"},{"key":"C","why":"c"},{"key":"D","why":"d"}]}`
	l, _ := runScan(t, out, 1)
	got := joined(l, "A")
	if !strings.Contains(got, `含"引号"、反斜杠\`) || !strings.Contains(got, "与 emoji😀") {
		t.Errorf("转义解码不符：%q", got)
	}
	// \u 形式等价输出
	l2, _ := runScan(t, `{"items":[{"key":"A","why":"\u5e76\u53d1\"x\"\ud83d\ude00"}]}`, 1)
	if g2 := joined(l2, "A"); g2 != `并发"x"`+"😀" {
		t.Errorf("\\u 解码不符：%q", g2)
	}
}

// 模型先吐 why 后吐 key（不合示例顺序）：增量暂存，key 出现后合并补发，不产生空 key 事件。
func TestExplScannerKeyLate(t *testing.T) {
	out := `{"items":[{"why":"先讲并发性","key":"A"},{"key":"B","why":"错"}]}`
	l, saw := runScan(t, out, 2)
	if !saw {
		t.Fatal("应产生增量")
	}
	for _, d := range l.deltas {
		if d.Key == "" {
			t.Fatal("key 迟到时不应吐空 key 增量")
		}
	}
	if joined(l, "A") != "先讲并发性" || joined(l, "B") != "错" {
		t.Errorf("暂存合并后不符：%+v", l.deltas)
	}
}

// 非 JSON 闲话输出：扫描器不发任何增量（宁可不流，不能错流）。
func TestExplScannerGarbage(t *testing.T) {
	_, saw := runScan(t, "抱歉，这道题我讲不好。", 3)
	if saw {
		t.Error("闲话输出不应产生增量")
	}
}

// ——— ExplainStream 两级链路 ———

func TestExplainStreamMaterialFirst(t *testing.T) {
	var calls []explCall
	srv := fakeExplStream(t, [][]string{splitRunes(explFoundTrue, 5)}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	l := &evLog{}
	res, err := g.ExplainStream(context.Background(), sampleExplainReq(), l.emit)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("资料充分应只调 1 次，实际 %d", len(calls))
	}
	if res.Source != "material" || len(res.Items) != 4 || !res.Items[0].Correct {
		t.Errorf("res=%+v", res)
	}
	if l.resets != 0 || len(l.deltas) == 0 {
		t.Errorf("资料级成功不应 reset，且应有 delta：%+v", l)
	}
	if joined(l, "A") != "并发是四大特征之一，宏观同时推进" {
		t.Errorf("delta 文本不符：%+v", l.deltas)
	}
	// 缓存：第二次调用零 delta、直接命中（不走上游）
	l2 := &evLog{}
	res2, err := g.ExplainStream(context.Background(), sampleExplainReq(), l2.emit)
	if err != nil || !res2.Cached || len(l2.deltas) != 0 || len(calls) != 1 {
		t.Errorf("应命中缓存且不流式：%+v %v calls=%d", res2, err, len(calls))
	}
}

// 资料级 found=false：其 delta 已推给前端 → 恰好一次 reset 清屏 → 联网级 delta 必须晚于 reset
// （delta 文本逐 chunk 切块，断言按「reset 前段/后段」聚合，不依赖具体切块边界）。
func TestExplainStreamFallbackResets(t *testing.T) {
	var calls []explCall
	srv := fakeExplStream(t, [][]string{splitRunes(explFoundFalse, 4), splitRunes(explSearchItems, 4)}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	var pre, post strings.Builder
	resets := 0
	res, err := g.ExplainStream(context.Background(), sampleExplainReq(), func(event string, data any) error {
		// 事件序状态机：reset 之前归 pre、之后归 post（reset 事件本身只计数）
		if event == "reset" {
			resets++
			return nil
		}
		d, ok := data.(explDelta)
		if !ok {
			return nil
		}
		if resets == 0 {
			pre.WriteString(d.Text)
		} else {
			post.WriteString(d.Text)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || res.Source != "search" {
		t.Fatalf("应两级：calls=%d res=%+v", len(calls), res)
	}
	if resets != 1 {
		t.Fatalf("应恰好 1 次 reset：%d", resets)
	}
	if !strings.Contains(pre.String(), "并发是特征") || strings.Contains(pre.String(), "连续性") {
		t.Errorf("reset 前应只有资料级文案：%s", pre.String())
	}
	if !strings.Contains(post.String(), "搜到资料佐证") {
		t.Errorf("reset 后应含联网级文案：%s", post.String())
	}
}

// 资料级输出不可解析（闲话）：无 delta 也无需 reset，直接联网级。
func TestExplainStreamStage1Garbage(t *testing.T) {
	var calls []explCall
	srv := fakeExplStream(t, [][]string{{"抱歉我讲不好"}, splitRunes(explSearchItems, 6)}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	l := &evLog{}
	res, err := g.ExplainStream(context.Background(), sampleExplainReq(), l.emit)
	if err != nil || res.Source != "search" || len(calls) != 2 {
		t.Fatalf("err=%v res=%+v calls=%d", err, res, len(calls))
	}
	if l.resets != 0 {
		t.Errorf("资料级没吐过增量就不应 reset：%+v", l)
	}
}

// 上游拒绝 enable_search → 去参重试一次成功（与非流式同策略）。
func TestExplainStreamSearchParamRejected(t *testing.T) {
	var calls []explCall
	srv := fakeExplStream(t, [][]string{
		splitRunes(explFoundFalse, 3),
		{"!Unknown parameter: 'enable_search'."},
		splitRunes(explSearchItems, 3),
	}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	res, err := g.ExplainStream(context.Background(), sampleExplainReq(), (&evLog{}).emit)
	if err != nil || res.Source != "search" || len(calls) != 3 {
		t.Fatalf("应去参重试成功：err=%v res=%+v calls=%d", err, res, len(calls))
	}
	if _, ok := calls[2].body["enable_search"]; ok {
		t.Errorf("去参重试不应再带 enable_search")
	}
}

// 无参考资料：跳过资料级直接联网一级。
func TestExplainStreamNoReference(t *testing.T) {
	var calls []explCall
	srv := fakeExplStream(t, [][]string{splitRunes(explSearchItems, 5)}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", testSubject())
	res, err := g.ExplainStream(context.Background(), sampleExplainReq(), (&evLog{}).emit)
	if err != nil || len(calls) != 1 || res.Source != "search" {
		t.Errorf("无资料应直接联网一级：calls=%d res=%+v err=%v", len(calls), res, err)
	}
}

// 401 → bad_key svcErr（留给联网级统一分类，与非流式一致）。
func TestExplainStreamBadKey(t *testing.T) {
	var calls []explCall
	srv := fakeExplStream(t, [][]string{{"@401"}}, &calls)
	defer srv.Close()
	g := newGrader("sk-bad", srv.URL, "", testSubject())
	_, err := g.ExplainStream(context.Background(), sampleExplainReq(), (&evLog{}).emit)
	var se *svcErr
	if err == nil || !asSvcErr(err, &se) || se.Code != "bad_key" {
		t.Errorf("401 应映射 bad_key：%v", err)
	}
}

// ——— HTTP 层 ———

// parseSSE 把 SSE 文本切成事件帧（仅测试用途：单行 data）。
func parseSSE(t *testing.T, body string) map[string][]string {
	t.Helper()
	out := map[string][]string{}
	for _, frame := range strings.Split(body, "\n\n") {
		if strings.TrimSpace(frame) == "" {
			continue
		}
		var ev, data string
		for _, line := range strings.Split(frame, "\n") {
			if strings.HasPrefix(line, "event: ") {
				ev = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				data += strings.TrimPrefix(line, "data: ")
			}
		}
		if ev == "" {
			ev = "message"
		}
		out[ev] = append(out[ev], data)
	}
	return out
}

func TestHandlerExplainStream(t *testing.T) {
	var calls []explCall
	srv := fakeExplStream(t, [][]string{splitRunes(explFoundTrue, 6)}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	mux := newMux(g)
	reqBody := sampleExplainReq()
	reqBody.Stream = true
	b, _ := json.Marshal(reqBody)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/api/grade", bytes.NewReader(b)))
	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	ct := rec.Header().Get("Content-Type")
	if !strings.Contains(ct, "text/event-stream") {
		t.Errorf("content-type=%s", ct)
	}
	if rec.Header().Get("X-Accel-Buffering") != "no" {
		t.Error("应带 X-Accel-Buffering: no（nginx 关缓冲）")
	}
	evs := parseSSE(t, rec.Body.String())
	if len(evs["delta"]) == 0 {
		t.Fatalf("应有 delta 事件：%s", rec.Body.String())
	}
	if len(evs["done"]) != 1 {
		t.Fatalf("done 应恰好 1 条：%v", evs["done"])
	}
	var res ExplainResp
	if err := json.Unmarshal([]byte(evs["done"][0]), &res); err != nil {
		t.Fatal(err)
	}
	if res.Source != "material" || len(res.Items) != 4 {
		t.Errorf("done=%+v", res)
	}
}

// 流式请求遇到校验失败：仍以 error 事件表达（流头已发出）。
func TestHandlerExplainStreamError(t *testing.T) {
	g := newGrader("sk-test", "http://127.0.0.1:1", "", testSubject())
	mux := newMux(g)
	bad := sampleExplainReq()
	bad.Stream = true
	bad.Answer = "Z"
	b, _ := json.Marshal(bad)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/api/grade", bytes.NewReader(b)))
	evs := parseSSE(t, rec.Body.String())
	if len(evs["error"]) != 1 {
		t.Fatalf("应有 error 事件：%s", rec.Body.String())
	}
	var e map[string]string
	if err := json.Unmarshal([]byte(evs["error"][0]), &e); err != nil || e["error"] != "bad_request" {
		t.Errorf("error=%s", evs["error"][0])
	}
}
