// 云同步合并口径 golden 断言（Go 侧守卫）：读仓库根 test/fixtures/merge_golden.json
// （scripts/gen-merge-golden.js 生成），断言本包 mergeBlobs/normalizeIncoming 逐字段命中期望——
// 与 JS 侧 test/merge_xcheck.test.js 断言同一文件，跨语言两份实现由夹具锁定（改口径两实现同改后刷新夹具）。
package main

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type golden struct {
	Now    int64 `json:"now"`
	Merges []struct {
		A   json.RawMessage `json:"a"`
		B   json.RawMessage `json:"b"`
		Out json.RawMessage `json:"out"`
	} `json:"merges"`
	Payloads []struct {
		Payload    json.RawMessage `json:"payload"`
		ShufOut    json.RawMessage `json:"shufOut"`
		HistOut    json.RawMessage `json:"histOut"` // v2：null/缺＝载荷不含该段
		ExplOut    json.RawMessage `json:"explOut"`
		Normalized json.RawMessage `json:"normalized"`
	} `json:"payloads"`
}

func loadGolden(t *testing.T) *golden {
	t.Helper()
	raw, err := os.ReadFile("../../../test/fixtures/merge_golden.json")
	if err != nil {
		t.Fatalf("读 golden 夹具失败：%v", err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("解析 golden 夹具失败：%v", err)
	}
	return &g
}

// parseUseNumber：以 json.Number 保真解析，数字文本格式参与严格比较（不许两边各自过 float 引入误差）。
func parseUseNumber(t *testing.T, raw []byte) any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("解析 JSON 失败：%v（原文 %s）", err, truncate(raw))
	}
	return v
}

func truncate(b []byte) []byte {
	if len(b) > 300 {
		return append(b[:300], "...(截断)"...)
	}
	return b
}

func TestGoldenMerges(t *testing.T) {
	g := loadGolden(t)
	for i, c := range g.Merges {
		merged := mergeBlobs(parseBlob(c.A), parseBlob(c.B), g.Now)
		out, err := json.Marshal(merged)
		if err != nil {
			t.Fatalf("第 %d 组合并结果序列化失败：%v", i, err)
		}
		want := parseUseNumber(t, c.Out)
		got := parseUseNumber(t, out)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("第 %d 组合并结果与夹具不符", i)
		}
	}
}

func TestGoldenPayloadContract(t *testing.T) {
	g := loadGolden(t)
	for i, c := range g.Payloads {
		body := append(json.RawMessage(`{"store":`), c.Payload...)
		body = append(body, `,"shuf":`...)
		body = append(body, c.ShufOut...)
		body = append(body, `,"clearedAt":0`...)
		if len(c.HistOut) > 0 && !isNullRaw(c.HistOut) {
			body = append(body, `,"hist":`...)
			body = append(body, c.HistOut...)
		}
		if len(c.ExplOut) > 0 && !isNullRaw(c.ExplOut) {
			body = append(body, `,"expl":`...)
			body = append(body, c.ExplOut...)
		}
		body = append(body, '}')
		inc := normalizeIncoming(body)
		if inc == nil {
			t.Fatalf("第 %d 组前端载荷被 normalizeIncoming 拒收（契约破坏）", i)
		}
		out, err := json.Marshal(normalizeOut{Store: inc.store, Shuf: inc.shuf, ClearedAt: inc.clearedAt, Hist: inc.hist, Expl: inc.expl})
		if err != nil {
			t.Fatalf("第 %d 组整形结果序列化失败：%v", i, err)
		}
		got := parseUseNumber(t, out)
		want := parseUseNumber(t, c.Normalized)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("第 %d 组 normalizeIncoming 输出与夹具不符", i)
		}
	}
}
