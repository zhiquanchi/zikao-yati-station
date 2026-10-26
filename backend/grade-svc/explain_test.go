// 单选「逐项解析」单测：httptest 假上游，覆盖两级链路（资料级→联网级）、参数与降级容错、缓存与校验。
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

func sampleExplainReq() GradeReq {
	return GradeReq{
		Task: "explain",
		Stem: "以下属于操作系统基本特征的是（ ）",
		Options: []Opt{
			{Key: "A", Text: "并发性"},
			{Key: "B", Text: "连续性"},
			{Key: "C", Text: "独占性"},
			{Key: "D", Text: "顺序性"},
		},
		Answer: "A",
		Ref:    "操作系统四大特征：并发、共享、虚拟、异步",
	}
}

const (
	explFoundTrue = `{"found":true,"items":[
		{"key":"A","why":"并发是四大特征之一，宏观同时推进"},
		{"key":"B","why":"无此特征，程序执行是异步的"},
		{"key":"C","why":"资源是共享的，非独占"},
		{"key":"D","why":"执行顺序不确定，非顺序性"}]}`
	explFoundFalse = `{"found":false,"items":[
		{"key":"A","why":"并发是特征"},{"key":"B","why":"不是特征"},
		{"key":"C","why":"不是特征"},{"key":"D","why":"不是特征"}]}`
	explSearchItems = `{"items":[
		{"key":"A","why":"并发性：OS 重要特征，搜到资料佐证"},
		{"key":"B","why":"连续性并非 OS 特征"},
		{"key":"C","why":"独占性与共享性相悖"},
		{"key":"D","why":"顺序性说法错误"}]}`
)

type explCall struct {
	body map[string]any
	raw  string
}

// fakeExpl 按次序返回 replies 中的模型输出；reply 以 "!" 开头表示返回 400（内容为其余文本）。
// 401 用 "@401" 表示。记录每次请求体供断言。
func fakeExpl(t *testing.T, replies []string, calls *[]explCall) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(body, &got)
		*calls = append(*calls, explCall{got, string(body)})
		i := len(*calls) - 1
		if i >= len(replies) {
			t.Errorf("上游被调用 %d 次，超出脚本 %d 次", len(*calls), len(replies))
			w.WriteHeader(500)
			return
		}
		rep := replies[i]
		switch {
		case strings.HasPrefix(rep, "@401"):
			w.WriteHeader(401)
			io.WriteString(w, `{"error":{"message":"Invalid API key"}}`)
			return
		case strings.HasPrefix(rep, "!"):
			w.WriteHeader(400)
			fmt.Fprintf(w, `{"error":{"message":%s}}`, quote(strings.TrimPrefix(rep, "!")))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"choices":[{"index":0,"message":{"role":"assistant","content":%s},"finish_reason":"stop"}]}`, quote(rep))
	}))
}

func TestExplainMaterialFirst(t *testing.T) {
	var calls []explCall
	srv := fakeExpl(t, []string{explFoundTrue, explSearchItems}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	res, err := g.Explain(context.Background(), sampleExplainReq())
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("资料充分时只应调 1 次上游，实际 %d", len(calls))
	}
	if res.Source != "material" || res.Task != "explain" || res.Engine != "ai" {
		t.Errorf("res=%+v", res)
	}
	if len(res.Items) != 4 || res.Items[0].Key != "A" || !res.Items[0].Correct || res.Items[1].Correct {
		t.Errorf("items=%+v", res.Items)
	}
	for _, it := range res.Items {
		if it.Src != "ref" || it.Why == "" {
			t.Errorf("第一级结果 src/why 不对：%+v", it)
		}
	}
	// 请求体：system 声明依据参考资料，user 嵌入资料全文与题目，不带 enable_search
	msgs, _ := calls[0].body["messages"].([]any)
	sys, _ := msgs[0].(map[string]any)
	usr, _ := msgs[1].(map[string]any)
	sc, _ := sys["content"].(string)
	uc, _ := usr["content"].(string)
	if !strings.Contains(sc, "操作系统考点串讲") {
		t.Errorf("system 应要求依据参考资料")
	}
	if !strings.Contains(uc, "【参考资料】") || !strings.Contains(uc, "【题干】") || !strings.Contains(uc, "并发性") || !strings.Contains(uc, "原题简要解析") {
		t.Errorf("user 应嵌入资料、题目与原题解析")
	}
	if _, ok := calls[0].body["enable_search"]; ok {
		t.Errorf("第一级不应带 enable_search")
	}
}

func TestExplainFallsToSearch(t *testing.T) {
	var calls []explCall
	srv := fakeExpl(t, []string{explFoundFalse, explSearchItems}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	res, err := g.Explain(context.Background(), sampleExplainReq())
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 {
		t.Fatalf("资料不足应二次联网调用，实际 %d", len(calls))
	}
	if res.Source != "search" {
		t.Errorf("source=%s", res.Source)
	}
	for _, it := range res.Items {
		if it.Src != "search" {
			t.Errorf("src 应为 search：%+v", it)
		}
	}
	if v, _ := calls[1].body["enable_search"].(bool); !v {
		t.Errorf("第二级请求体应带 enable_search=true：%s", calls[1].raw)
	}
	if strings.Contains(calls[1].raw, "【参考资料】") {
		t.Errorf("第二级不应再塞参考资料")
	}
	// 缓存：同题再请求不走上游
	res2, err := g.Explain(context.Background(), sampleExplainReq())
	if err != nil || !res2.Cached || len(res2.Items) != 4 {
		t.Errorf("应命中缓存：%+v %v", res2, err)
	}
	if len(calls) != 2 {
		t.Errorf("缓存命中不应再调上游")
	}
}

// 第一级输出不可解析也须落到第二级联网。
func TestExplainStage1Garbage(t *testing.T) {
	var calls []explCall
	srv := fakeExpl(t, []string{"抱歉我讲不好", explSearchItems}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	res, err := g.Explain(context.Background(), sampleExplainReq())
	if err != nil || res.Source != "search" || len(calls) != 2 {
		t.Fatalf("第一级失败应降级联网：err=%v res=%+v calls=%d", err, res, len(calls))
	}
}

// 联网级首轮输出不可解析：追加格式提醒重出一次，成功即正常返回（不再直接把 parse 错误抛给前端）。
func TestExplainSearchParseRetry(t *testing.T) {
	var calls []explCall
	srv := fakeExpl(t, []string{explFoundFalse, "抱歉我讲不好", explSearchItems}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	res, err := g.Explain(context.Background(), sampleExplainReq())
	if err != nil || res.Source != "search" || len(calls) != 3 {
		t.Fatalf("应重出一次成功：err=%v res=%+v calls=%d", err, res, len(calls))
	}
	msgs, _ := calls[2].body["messages"].([]any)
	sys, _ := msgs[0].(map[string]any)
	if sc, _ := sys["content"].(string); !strings.Contains(sc, "上一轮输出无法解析") {
		t.Errorf("重出请求的 system 应带格式提醒：%s", calls[2].raw)
	}
}

// 联网级连续两轮都不可解析：只重出一次，随后按 502/parse 失败（不做无限重试）。
func TestExplainSearchParseFailTwice(t *testing.T) {
	var calls []explCall
	srv := fakeExpl(t, []string{explFoundFalse, "坏输出一", "坏输出二"}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	_, err := g.Explain(context.Background(), sampleExplainReq())
	var se *svcErr
	if err == nil || !asSvcErr(err, &se) || se.Status != 502 || se.Code != "parse" {
		t.Fatalf("两轮都坏应 502/parse：%v", err)
	}
	if len(calls) != 3 {
		t.Errorf("应恰好重出一次（共 3 次上游调用），实际 %d", len(calls))
	}
}

// 上游拒绝 enable_search 参数 → 去参重试一次成功（source 仍标 search，含义退化为模型知识）。
func TestExplainSearchParamRejected(t *testing.T) {
	var calls []explCall
	srv := fakeExpl(t, []string{explFoundFalse, "!Unknown parameter: 'enable_search'.", explSearchItems}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	res, err := g.Explain(context.Background(), sampleExplainReq())
	if err != nil || res.Source != "search" || len(calls) != 3 {
		t.Fatalf("应去参重试成功：err=%v res=%+v calls=%d", err, res, len(calls))
	}
	if _, ok := calls[1].body["enable_search"]; !ok {
		t.Errorf("第 2 次调用应带 enable_search")
	}
	if _, ok := calls[2].body["enable_search"]; ok {
		t.Errorf("去参重试不应再带 enable_search")
	}
}

// 科目无参考资料（subjectConfig.reference 为空）：跳过资料级，直接联网一级。
func TestExplainNoReferenceSkipsStage1(t *testing.T) {
	var calls []explCall
	srv := fakeExpl(t, []string{explSearchItems}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", testSubject())
	res, err := g.Explain(context.Background(), sampleExplainReq())
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || res.Source != "search" {
		t.Errorf("无资料应直接联网一级：calls=%d res=%+v", len(calls), res)
	}
}

// normalizeExplain 纯函数：key 不重不漏、why 非空、超长截断；correct 按题面 answer 推导。
func TestExplainNormalize(t *testing.T) {
	r := sampleExplainReq()
	cases := map[string]string{
		"缺选项": `{"items":[{"key":"A","why":"对"},{"key":"B","why":"错"},{"key":"C","why":"错"}]}`,
		"重复键": `{"items":[{"key":"A","why":"对"},{"key":"A","why":"对2"},{"key":"B","why":"错"},{"key":"C","why":"错"},{"key":"D","why":"错"}]}`,
		"未知键": `{"items":[{"key":"A","why":"对"},{"key":"B","why":"错"},{"key":"C","why":"错"},{"key":"E","why":"?"}]}`,
		"空文本": `{"items":[{"key":"A","why":""},{"key":"B","why":"错"},{"key":"C","why":"错"},{"key":"D","why":"错"}]}`,
		"小写键": `{"items":[{"key":"a","why":"对"},{"key":"B","why":"错"},{"key":"C","why":"错"},{"key":"D","why":"错"}]}`,
	}
	for name, rep := range cases {
		got, _, perr := parseExplainItems(rep)
		if perr != nil {
			t.Fatalf("%s 预解析失败：%v", name, perr)
		}
		_, nerr := normalizeExplain(&r, got, "search")
		var se *svcErr
		if nerr == nil || !asSvcErr(nerr, &se) || se.Status != 502 || se.Code != "parse" {
			t.Errorf("%s 应 502/parse，实际 %v", name, nerr)
		}
	}
	// 正例：乱序返回按选项顺序归位；超长 why 截断；correct 由 answer 推导
	got, _, err := parseExplainItems(`{"items":[{"key":"D","why":"错"},{"key":"A","why":"对，` + strings.Repeat("长", 200) + `"},{"key":"B","why":"错"},{"key":"C","why":"错"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	items, err := normalizeExplain(&r, got, "ref")
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"A", "B", "C", "D"} {
		if items[i].Key != want {
			t.Errorf("应按选项顺序归位：%+v", items)
		}
		if items[i].Correct != (want == "A") {
			t.Errorf("correct 应按 answer 推导：%+v", items[i])
		}
	}
	if n := len([]rune(items[0].Why)); n > explWhyMaxRunes {
		t.Errorf("why 应截断到 %d 字，实际 %d", explWhyMaxRunes, n)
	}
}

// 逐项解析 prompt 口径：解释围绕「是不是本题答案」而非「选项表述对错」，且明确覆盖否定式题干，
// 与前端标签「✓ 本题答案 / ✗ 非本题答案」同义（「不正确的是/不属于」类题不再出现读反的讲解）。
func TestExplainPromptWording(t *testing.T) {
	g := newGrader("sk-test", "http://127.0.0.1:1", "", subjWithRef())
	for name, sys := range map[string]string{"ref": g.explSystemRef(), "search": g.explSystemSearch()} {
		for _, want := range []string{"为什么是本题答案", "为什么不是本题答案", "不正确的是", "不属于"} {
			if !strings.Contains(sys, want) {
				t.Errorf("%s prompt 缺少口径关键词 %q", name, want)
			}
		}
	}
}

func TestExplainValidatesRequest(t *testing.T) {
	g := newGrader("sk-test", "http://127.0.0.1:1", "", testSubject())
	bad := sampleExplainReq()
	bad.Answer = "Z" // 不在选项
	var se *svcErr
	if _, err := g.Explain(context.Background(), bad); err == nil || !asSvcErr(err, &se) || se.Status != 400 || se.Code != "bad_request" {
		t.Errorf("答案不在选项应 400/bad_request：%v", se)
	}
	bad2 := sampleExplainReq()
	bad2.Options = nil
	if _, err := g.Explain(context.Background(), bad2); err == nil {
		t.Error("无选项应校验失败")
	}
}

func TestExplainBadKeyMaps(t *testing.T) {
	var calls []explCall
	srv := fakeExpl(t, []string{"@401"}, &calls)
	defer srv.Close()
	g := newGrader("sk-bad", srv.URL, "", testSubject())
	_, err := g.Explain(context.Background(), sampleExplainReq())
	var se *svcErr
	if err == nil || !asSvcErr(err, &se) || se.Code != "bad_key" {
		t.Errorf("401 应映射 bad_key：%v", err)
	}
}

// HTTP 层：task:"explain" 在同一 /api/grade 路由分流，响应形状为 items 而非 per。
func TestHandlerExplain(t *testing.T) {
	var calls []explCall
	srv := fakeExpl(t, []string{explFoundTrue}, &calls)
	defer srv.Close()
	g := newGrader("sk-test", srv.URL, "", subjWithRef())
	mux := newMux(g)
	b, _ := json.Marshal(sampleExplainReq())
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/api/grade", bytes.NewReader(b)))
	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res ExplainResp
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Task != "explain" || len(res.Items) != 4 || res.Source != "material" {
		t.Errorf("res=%+v", res)
	}
}
