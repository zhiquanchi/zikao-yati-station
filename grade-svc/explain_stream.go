// 单选逐项解析的流式输出：上游以 SSE（stream:true）逐 token 吐 JSON，本文件把「还不完整的 JSON」
// 增量扫描成逐选项的 delta 事件推给前端（done 事件仍是与非流式完全一致的 ExplainResp——
// 权威整形/校验只在末尾对全量 content 做一次，扫描器只负责「提前显示」，其瑕疵会被 done 覆盖）。
// 两级链路语义不变：资料级输出被弃用（found=false/解析失败/上游出错）时先发 reset 清屏，再流式联网级。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	openai "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/shared"
)

// explErrClient 标记「前端断开/写事件失败」：handler 据此静默收尾，不再尝试发 error 事件。
var explErrClient = errors.New("client gone")

// explDelta 是 delta 事件载荷：某选项 why 的一段增量文本。
// Key 可能为空——模型先吐 why 后吐 key 时增量暂存于扫描器，等 key 出现合并补发。
type explDelta struct {
	Key  string `json:"key"`
	Text string `json:"text"`
}

// explReason 是 reason 事件载荷：模型思考过程（reasoning_content）的一段增量文本。
// 仅用于前端实时展示，不参与 done 整形（done 契约与非流式完全同形，思考不入 ExplainResp）。
type explReason struct {
	Text string `json:"text"`
}

// explTry 是一次流式上游调用的参数组合：被网关拒绝的参数逐个降级重试。
type explTry struct {
	jsonFmt bool // response_format: json_object
	search  bool // enable_search
	effort  bool // reasoning_effort: medium（思考等级中等；qwen 系思考默认偏长，降到中等既提速又留出流式余量）
}

// explScanner 是面向解析输出格式（{"found":…,"items":[{"key":"A","why":"…"},…]}）的增量 JSON 扫描器。
// 深度计数：root{ ＝1，items[ ＝2，元素对象{ ＝3；只在深度 3 的对象内识别 key/why。
// 容错取向：结构不符预期就不发 delta（宁可不流，不能错流），正确性由末尾 done 兜底。
type explScanner struct {
	emit     func(key, text string) error
	sawDelta bool // 是否已推过增量（决定弃用本段输出时要不要先发 reset）

	depth      int
	afterColon bool // 刚见过 ':'，则下一个字符串是值而非字段名
	inStr      bool
	isValue    bool
	buf        strings.Builder // 当前字符串的解码文本（字段名与 key 值用）
	// items 元素上下文
	inItem    bool
	itemField string // 当前字段名（"key"/"why"）
	itemKey   string
	pendWhy   strings.Builder // itemKey 未定时暂存的 why 增量
	out       strings.Builder // 攒待发的 delta 文本（每个上游 chunk 合并成一条事件）
	// 字符串内转义解码状态
	esc     int // 0 无 1 刚见反斜杠 2 收集 \u 的 4 位 hex
	uHex    string
	hiSurro rune // 待配对的高位代理
}

// Feed 吃进一段 content 增量并把攒下的文本作为 delta 发出；emit 出错立即上抛。
func (s *explScanner) Feed(chunk string) error {
	for _, r := range chunk {
		var err error
		if s.inStr {
			err = s.feedInString(r)
		} else {
			err = s.feedStruct(r)
		}
		if err != nil {
			return err
		}
	}
	return s.flush()
}

func (s *explScanner) feedStruct(r rune) error {
	switch r {
	case '"':
		s.inStr = true
		s.buf.Reset()
		s.esc, s.uHex, s.hiSurro = 0, "", 0
		s.isValue = s.afterColon
	case '{':
		s.depth++
		if s.depth == 3 {
			s.inItem = true
			s.itemField, s.itemKey = "", ""
			s.pendWhy.Reset()
		}
		s.afterColon = false
	case '}':
		if err := s.flush(); err != nil {
			return err
		}
		s.depth--
		if s.depth < 3 {
			s.inItem = false
		}
		s.afterColon = false
	case '[':
		s.depth++
		s.afterColon = false
	case ']':
		s.depth--
	case ':':
		s.afterColon = true
	case ',':
		s.afterColon = false
	}
	return nil
}

func (s *explScanner) feedInString(r rune) error {
	if s.esc == 1 { // 反斜杠后的转义字符
		s.esc = 0
		switch r {
		case 'n':
			return s.strRune('\n')
		case 't':
			return s.strRune('\t')
		case 'r':
			return s.strRune('\r')
		case 'b':
			return s.strRune('\b')
		case 'f':
			return s.strRune('\f')
		case 'u':
			s.esc = 2
			s.uHex = ""
			return nil
		default: // \" \\ \/ 及未知转义按字面
			return s.strRune(r)
		}
	}
	if s.esc == 2 { // \uXXXX：收集 4 位 hex 后解码（含代理对拼接）
		s.uHex += string(r)
		if len(s.uHex) < 4 {
			return nil
		}
		s.esc = 0
		v, err := strconv.ParseInt(s.uHex, 16, 32)
		if err != nil {
			return s.strRune(utf8.RuneError)
		}
		rn := rune(v)
		if s.hiSurro != 0 {
			if rn >= 0xDC00 && rn <= 0xDFFF {
				comb := utf16.DecodeRune(s.hiSurro, rn)
				s.hiSurro = 0
				return s.strRune(comb)
			}
			_ = s.strRune(utf8.RuneError) // 前一枚高位代理落单
			s.hiSurro = 0
		}
		if rn >= 0xD800 && rn <= 0xDBFF {
			s.hiSurro = rn // 等低位代理
			return nil
		}
		if utf16.IsSurrogate(rn) {
			return s.strRune(utf8.RuneError)
		}
		return s.strRune(rn)
	}
	switch r {
	case '\\':
		s.esc = 1
		return nil
	case '"':
		return s.closeString()
	}
	return s.strRune(r)
}

// strRune 记录当前字符串的一个解码字符；位于 why 值位置时同时计入 delta 输出。
func (s *explScanner) strRune(r rune) error {
	s.buf.WriteRune(r)
	if s.isValue && s.inItem && s.depth == 3 && s.itemField == "why" {
		if s.itemKey == "" {
			s.pendWhy.WriteRune(r)
		} else {
			s.out.WriteRune(r)
		}
	}
	return nil
}

func (s *explScanner) closeString() error {
	s.inStr = false
	s.afterColon = false
	v := strings.TrimSpace(s.buf.String())
	s.buf.Reset()
	if s.isValue {
		if s.inItem && s.depth == 3 && s.itemField == "key" {
			s.itemKey = v
			if s.pendWhy.Len() > 0 { // key 迟到：把暂存增量并入输出
				s.out.WriteString(s.pendWhy.String())
				s.pendWhy.Reset()
			}
		}
	} else if s.inItem && s.depth == 3 {
		s.itemField = v
	}
	return s.flush()
}

// flush 把攒下的一段文本作为一条 delta 事件发出。
func (s *explScanner) flush() error {
	if s.out.Len() == 0 {
		return nil
	}
	txt := s.out.String()
	s.out.Reset()
	s.sawDelta = true
	return s.emit(s.itemKey, txt)
}

// deltaReason 从 chunk 的 delta 里取 reasoning_content（DashScope 非标字段，SDK 落入 ExtraFields
// 时键名保留原始 JSON 名），解码失败或空串返回 ""。
func deltaReason(d openai.ChatCompletionChunkChoiceDelta) string {
	f, ok := d.JSON.ExtraFields["reasoning_content"]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal([]byte(f.Raw()), &s); err != nil {
		return ""
	}
	return s
}

// streamExplOnce 单次流式上游调用：逐 chunk Feed 给扫描器，同时累积全量 content 供末尾整形；
// 思考增量（reasoning_content）经 onReason 实时转发。
// 参数被上游拒绝发生在建流前的 400，错误文案里带参数名，由 streamExplCall 去参重试。
func (g *grader) streamExplOnce(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion, timeout time.Duration, try explTry, sc *explScanner, onReason func(string) error) (string, error) {
	opts := []option.RequestOption{
		option.WithAPIKey(g.apiKey),
		option.WithBaseURL(g.baseURL),
		option.WithMaxRetries(1),
		option.WithRequestTimeout(timeout),
	}
	if try.search {
		opts = append(opts, option.WithJSONSet("enable_search", true))
	}
	client := openai.NewClient(opts...)
	params := openai.ChatCompletionNewParams{
		Messages:    msgs,
		Model:       shared.ChatModel(g.model),
		Temperature: openai.Float(0),
	}
	if try.jsonFmt {
		params.ResponseFormat = openai.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONObject: &shared.ResponseFormatJSONObjectParam{},
		}
	}
	if try.effort {
		params.ReasoningEffort = shared.ReasoningEffortMedium
	}
	stream := client.Chat.Completions.NewStreaming(ctx, params)
	defer stream.Close()
	var full strings.Builder
	for stream.Next() {
		chunk := stream.Current()
		if len(chunk.Choices) == 0 {
			continue
		}
		if rt := deltaReason(chunk.Choices[0].Delta); rt != "" && onReason != nil {
			if err := onReason(rt); err != nil {
				return full.String(), err
			}
		}
		d := chunk.Choices[0].Delta.Content
		if d == "" {
			continue
		}
		full.WriteString(d)
		if err := sc.Feed(d); err != nil {
			return full.String(), err
		}
	}
	if err := stream.Err(); err != nil {
		return full.String(), err
	}
	return full.String(), nil
}

// streamExplCall 带容错的流式调用：response_format / enable_search / reasoning_effort 被拒时
// 去参重试（与非流式 callExplain 同策略，被拒哪个降哪个）；重试重建扫描器，
// 且若旧段已推过内容或思考增量则先发 reset（前端两类面板一起清）。
// 返回的 bool＝本段是否推过任何可见增量（内容或思考），决定弃用时要不要清屏。
func (g *grader) streamExplCall(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion, timeout time.Duration, search bool, emit func(string, any) error) (string, bool, error) {
	newSc := func() *explScanner {
		return &explScanner{emit: func(key, txt string) error {
			return emit("delta", explDelta{Key: key, Text: txt})
		}}
	}
	sawReason := false
	onReason := func(txt string) error {
		sawReason = true
		return emit("reason", explReason{Text: txt})
	}
	try := explTry{jsonFmt: true, search: search, effort: true}
	sc := newSc()
	content, err := g.streamExplOnce(ctx, msgs, timeout, try, sc, onReason)
	for err != nil && !errors.Is(err, explErrClient) {
		es := err.Error()
		dropped := false
		switch {
		case try.jsonFmt && strings.Contains(es, "response_format"):
			try.jsonFmt = false
			dropped = true
		case try.search && strings.Contains(es, "enable_search"):
			try.search = false
			dropped = true
		case try.effort && strings.Contains(es, "reasoning_effort"):
			try.effort = false
			dropped = true
		}
		if !dropped {
			break
		}
		if sc.sawDelta || sawReason {
			if e := emit("reset", map[string]bool{"reset": true}); e != nil {
				return content, sc.sawDelta || sawReason, explErrClient
			}
		}
		sc = newSc()
		sawReason = false
		content, err = g.streamExplOnce(ctx, msgs, timeout, try, sc, onReason)
	}
	return content, sc.sawDelta || sawReason, err
}

// ExplainStream ＝ Explain 的流式版：事件序列 reason*/delta* [reset reason*/delta*] done；
// reason＝思考过程增量（思考等级中等，reasoning_effort=medium），仅供展示、不入 done；
// 失败以 error 事件表达（payload 与 REST 错误体同形 {error, detail}）；请求体校验失败仍走
// JSON 错误（发生在流头之前）。缓存语义不变：命中不产生 delta，调用方直接把 cached=true 的
// ExplainResp 发成 done。
func (g *grader) ExplainStream(ctx context.Context, r GradeReq, emit func(string, any) error) (*ExplainResp, error) {
	if err := r.validateExplain(); err != nil {
		return nil, &svcErr{400, "bad_request", err.Error()}
	}
	key := explainCacheKey(r)
	g.mu.Lock()
	if v, ok := g.exCache[key]; ok {
		v.Cached = true
		g.mu.Unlock()
		return &v, nil
	}
	g.mu.Unlock()

	ref := strings.TrimSpace(g.subj.reference)
	resp := &ExplainResp{Engine: "ai", Task: "explain"}

	if ref != "" {
		msgs := []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(g.explSystemRef()),
			openai.UserMessage(buildExplainUser(&r, ref)),
		}
		content, saw, err := g.streamExplCall(ctx, msgs, explStage1Timeout, false, emit)
		if errors.Is(err, explErrClient) {
			return nil, err
		}
		if err == nil { // 第一级任何失败/资料不足都落到第二级联网（与非流式 Explain 同构）
			got, found, perr := parseExplainItems(content)
			if perr == nil && found != nil && *found {
				items, nerr := normalizeExplain(&r, got, "ref")
				if nerr == nil {
					resp.Source = "material"
					resp.Items = items
					g.cacheExpl(key, resp)
					return resp, nil
				}
			}
		}
		if saw { // 资料级输出被弃用：清掉前端已渲染的半截
			if e := emit("reset", map[string]bool{"reset": true}); e != nil {
				return nil, explErrClient
			}
		}
	}

	msgs := []openai.ChatCompletionMessageParamUnion{
		openai.SystemMessage(g.explSystemSearch()),
		openai.UserMessage(buildExplainUser(&r, "")),
	}
	content, _, err := g.streamExplCall(ctx, msgs, explStage2Timeout, true, emit)
	if err != nil {
		if errors.Is(err, explErrClient) {
			return nil, err
		}
		return nil, classifyUpstreamErr(ctx, err)
	}
	got, _, perr := parseExplainItems(content)
	if perr != nil {
		return nil, &svcErr{502, "parse", perr.Error()}
	}
	items, nerr := normalizeExplain(&r, got, "search")
	if nerr != nil {
		return nil, nerr
	}
	resp.Source = "search"
	resp.Items = items
	g.cacheExpl(key, resp)
	return resp, nil
}

func (g *grader) cacheExpl(key string, resp *ExplainResp) {
	g.mu.Lock()
	if len(g.exCache) >= maxCache {
		g.exCache = map[string]ExplainResp{}
	}
	g.exCache[key] = *resp
	g.mu.Unlock()
}
