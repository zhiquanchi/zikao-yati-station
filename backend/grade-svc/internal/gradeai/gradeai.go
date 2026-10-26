// AI 判分与逐项解析（OpenAI 兼容 · 千问）。服务端从自持题库取题面/要点/答案，
// 前端只提交作答文本；上游输出一律整形后再返回，状态由 cov 推导、分数由 cov 均值重算。
package gradeai

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	openai "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/shared"
)

const (
	defaultBaseURL  = "https://maas.qianwenaiapi.com/compatible-mode/v1"
	defaultModel    = "qwen3.8-flash"
	maxAnswerRunes  = 8000
	maxSummaryRunes = 600
	maxCache        = 512
)

// Err 携带对外 HTTP 状态与错误码。
type Err struct {
	Status int
	Code   string
	Detail string
}

func (e *Err) Error() string { return e.Code + ": " + e.Detail }

// Subject 是科目口径（prompt 措辞与参考资料）。
type Subject struct {
	Name          string
	Code          string
	MaterialTitle string
	Reference     string
}

// Req 是简答判分入参（由服务端从题库组装）。
type Req struct {
	Stem   string
	Ref    string
	Points []string
	Answer string
}

// PerPoint 是逐要点结果。
type PerPoint struct {
	Text    string   `json:"text"`
	Cov     float64  `json:"cov"`
	State   string   `json:"state"`
	Comment string   `json:"comment"`
	Segs    []string `json:"segs"`
}

type Resp struct {
	Engine  string     `json:"engine"`
	Score   int        `json:"score"`
	Summary string     `json:"summary"`
	Per     []PerPoint `json:"per"`
	Cached  bool       `json:"cached"`
}

// Opt / ExplainItem / ExplainResp 与服务端逐项解析契约一致。
type Opt struct {
	Key  string `json:"key"`
	Text string `json:"text"`
}

type ExplainItem struct {
	Key     string `json:"key"`
	Correct bool   `json:"correct"`
	Why     string `json:"why"`
	Src     string `json:"src"`
}

type ExplainResp struct {
	Engine string        `json:"engine"`
	Task   string        `json:"task"`
	Source string        `json:"source"`
	Items  []ExplainItem `json:"items"`
	Cached bool          `json:"cached"`
}

type ExplainReq struct {
	Stem    string
	Ref     string
	Options []Opt
	Answer  string
}

type Client struct {
	apiKey  string
	baseURL string
	model   string
	subj    Subject
	mu      sync.Mutex
	cache   map[string]Resp
	exCache map[string]ExplainResp
}

func New(apiKey, baseURL, model string, subj Subject) *Client {
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	if model == "" {
		model = defaultModel
	}
	return &Client{apiKey: apiKey, baseURL: baseURL, model: model, subj: subj,
		cache: map[string]Resp{}, exCache: map[string]ExplainResp{}}
}

func (c *Client) Enabled() bool { return c.apiKey != "" }

func (r Req) validate() error {
	if strings.TrimSpace(r.Stem) == "" {
		return fmt.Errorf("缺少题干")
	}
	if len(r.Points) == 0 || len(r.Points) > 32 {
		return fmt.Errorf("要点数量 %d 超出 1~32", len(r.Points))
	}
	if strings.TrimSpace(r.Answer) == "" {
		return fmt.Errorf("作答为空")
	}
	if utf8.RuneCountInString(r.Answer) > maxAnswerRunes {
		return fmt.Errorf("作答超长（>%d 字）", maxAnswerRunes)
	}
	return nil
}

func (c *Client) systemPrompt(n int) string {
	return fmt.Sprintf(`你是自考《%[1]s》科目的阅卷老师。请对照参考答案要点，逐条评估学生作答的覆盖程度。
评分口径：
- cov 为该要点的覆盖度，0~1 的小数：语义一致即高分（0.8~1，允许措辞与顺序不同）；意思沾边但不完整给 0.3~0.7；只写到要点标题词而无实质解释约 0.5~0.6；完全没答到或答错给 0~0.2。
- per 里的 comment 不超过 25 字，指出答到了什么、缺了什么。
- summary 为整段总评（80~200 字，完整成句）：先点明总体掌握情况与得分原因，再指出答得好的地方、主要失分点与改进方向；不要分条、不要只写关键词、不要省略截断。
只输出一个 JSON 对象，不要输出其它任何文字，格式：
{"summary":"总体掌握……建议……","per":[{"i":1,"cov":0.8,"comment":"答到并发含义"},{"i":2,"cov":0.4,"comment":"只提标题未解释"}]}
per 数组必须恰好包含 %[2]d 条，i 从 1 开始与要点编号对应。`, c.subj.Name, n)
}

func (c *Client) buildMessages(r Req) []openai.ChatCompletionMessageParamUnion {
	var sb strings.Builder
	fmt.Fprintf(&sb, "【题干】%s\n\n【参考答案要点】（共 %d 条）\n", r.Stem, len(r.Points))
	for i, p := range r.Points {
		fmt.Fprintf(&sb, "%d. %s\n", i+1, p)
	}
	fmt.Fprintf(&sb, "\n【参考答案全文】%s\n\n【学生作答】\n%s\n", r.Ref, r.Answer)
	return []openai.ChatCompletionMessageParamUnion{
		openai.SystemMessage(c.systemPrompt(len(r.Points))),
		openai.UserMessage(sb.String()),
	}
}

func (c *Client) callLLM(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion, jsonFmt bool) (string, error) {
	client := openai.NewClient(
		option.WithAPIKey(c.apiKey),
		option.WithBaseURL(c.baseURL),
		option.WithMaxRetries(1),
		option.WithRequestTimeout(20*time.Second),
	)
	params := openai.ChatCompletionNewParams{
		Messages:    msgs,
		Model:       shared.ChatModel(c.model),
		Temperature: openai.Float(0),
		MaxTokens:   openai.Int(2048),
	}
	if jsonFmt {
		params.ResponseFormat = openai.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONObject: &shared.ResponseFormatJSONObjectParam{},
		}
	}
	res, err := client.Chat.Completions.New(ctx, params)
	if err != nil {
		return "", err
	}
	if len(res.Choices) == 0 {
		return "", fmt.Errorf("上游返回 choices 为空")
	}
	return res.Choices[0].Message.Content, nil
}

func (c *Client) call(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion) (string, error) {
	content, err := c.callLLM(ctx, msgs, true)
	if err != nil && strings.Contains(err.Error(), "response_format") {
		return c.callLLM(ctx, msgs, false)
	}
	return content, err
}

// extractJSON 容忍代码围栏与前后闲话，截取首个括号平衡的 JSON 对象。
func extractJSON(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "```json", "```")
	s = strings.ReplaceAll(s, "```", "")
	s = strings.TrimSpace(s)
	depth, start := 0, -1
	inStr, esc := false, false
	for i, ch := range s {
		switch {
		case esc:
			esc = false
		case inStr && ch == '\\':
			esc = true
		case inStr && ch == '"':
			inStr = false
		case !inStr && ch == '"':
			inStr = true
		case ch == '{':
			if depth == 0 {
				start = i
			}
			depth++
		case ch == '}':
			depth--
			if depth == 0 && start >= 0 {
				return s[start : i+1]
			}
		}
	}
	return s
}

func stateOf(cov float64) string {
	switch {
	case cov >= 0.5:
		return "hit"
	case cov >= 0.22:
		return "part"
	default:
		return "miss"
	}
}

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

func clampRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func normalize(content string, r *Req) (*Resp, error) {
	var out struct {
		Summary string `json:"summary"`
		Per     []struct {
			I       *int     `json:"i"`
			Cov     *float64 `json:"cov"`
			Comment string   `json:"comment"`
		} `json:"per"`
	}
	if err := json.Unmarshal([]byte(extractJSON(content)), &out); err != nil {
		return nil, &Err{502, "parse", "上游输出不是合法 JSON：" + err.Error()}
	}
	if len(out.Per) != len(r.Points) {
		return nil, &Err{502, "parse", fmt.Sprintf("逐点结果 %d 条与要点 %d 条不符", len(out.Per), len(r.Points))}
	}
	per := make([]PerPoint, len(r.Points))
	seen := make([]bool, len(r.Points))
	sum := 0.0
	for j, it := range out.Per {
		idx := j
		if it.I != nil {
			idx = *it.I - 1
		}
		if idx < 0 || idx >= len(r.Points) || seen[idx] {
			return nil, &Err{502, "parse", fmt.Sprintf("要点编号 %d 缺失、越界或重复", idx+1)}
		}
		if it.Cov == nil {
			return nil, &Err{502, "parse", fmt.Sprintf("第 %d 点缺 cov", idx+1)}
		}
		seen[idx] = true
		cov := clamp01(*it.Cov)
		per[idx] = PerPoint{Text: r.Points[idx], Cov: cov, State: stateOf(cov), Comment: clampRunes(strings.TrimSpace(it.Comment), 60), Segs: []string{}}
		sum += cov
	}
	return &Resp{Engine: "ai", Score: int(math.Round(sum / float64(len(per)) * 100)),
		Summary: clampRunes(strings.TrimSpace(out.Summary), maxSummaryRunes), Per: per}, nil
}

func cacheKey(r Req) string {
	h := sha256.New()
	h.Write([]byte(r.Stem))
	h.Write([]byte("\x00"))
	h.Write([]byte(strings.Join(r.Points, "\x01")))
	h.Write([]byte("\x00"))
	h.Write([]byte(r.Answer))
	return hex.EncodeToString(h.Sum(nil))
}

// Grade 带进程内缓存：同一题干+要点+作答只调一次上游。
func (c *Client) Grade(ctx context.Context, r Req) (*Resp, error) {
	if err := r.validate(); err != nil {
		return nil, &Err{400, "bad_request", err.Error()}
	}
	key := cacheKey(r)
	c.mu.Lock()
	if v, ok := c.cache[key]; ok {
		v.Cached = true
		c.mu.Unlock()
		return &v, nil
	}
	c.mu.Unlock()

	content, err := c.call(ctx, c.buildMessages(r))
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, &Err{504, "timeout", "上游判分超时"}
		}
		es := err.Error()
		if strings.Contains(es, "401") || strings.Contains(es, "Invalid API key") || strings.Contains(es, "invalid_api_key") {
			return nil, &Err{501, "bad_key", "API Key 无效"}
		}
		return nil, &Err{502, "upstream", "上游调用失败：" + es}
	}
	res, err := normalize(content, &r)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if len(c.cache) >= maxCache {
		c.cache = map[string]Resp{}
	}
	c.cache[key] = *res
	c.mu.Unlock()
	return res, nil
}

// ——— 单选逐项解析 ———

const (
	explStage1Timeout = 30 * time.Second
	explStage2Timeout = 50 * time.Second
	explWhyMaxRunes   = 160
	explRetryNote     = "\n注意：上一轮输出无法解析为约定 JSON。本轮务必只输出这一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。"
)

func (s Subject) materialTitle() string {
	if strings.TrimSpace(s.MaterialTitle) != "" {
		return s.MaterialTitle
	}
	return s.Name + "考点参考资料"
}

func (r ExplainReq) validate() error {
	if strings.TrimSpace(r.Stem) == "" {
		return fmt.Errorf("缺少题干")
	}
	if len(r.Options) < 2 || len(r.Options) > 12 {
		return fmt.Errorf("选项数 %d 超出 2~12", len(r.Options))
	}
	seen := map[string]bool{}
	for _, o := range r.Options {
		k := strings.TrimSpace(o.Key)
		if k == "" || seen[k] {
			return fmt.Errorf("选项 key 为空或重复：%q", o.Key)
		}
		seen[k] = true
		if strings.TrimSpace(o.Text) == "" {
			return fmt.Errorf("选项 %s 文本为空", k)
		}
	}
	if ans := strings.TrimSpace(r.Answer); !seen[ans] {
		return fmt.Errorf("正确答案 %q 不在选项中", ans)
	}
	return nil
}

func (c *Client) explSystemRef() string {
	return fmt.Sprintf(`你是自学考试《%[1]s》（%[2]s）科目的主讲教师。下面提供《%[3]s》参考资料。
给定一道单选题，为每个选项各写一条解释（每条不超过 40 字），句首点出关键概念，不要用 markdown 标记。
解释要回答「该选项为什么是本题答案 / 为什么不是本题答案」，而不是笼统说选项表述本身对错：题干若问「不正确的是 / 不属于 / 不包括」等否定式，答案项就是表述有误或不符合题干的那一项——答案项解释写清哪里不对、为什么正合题干所问，其余选项写清哪里符合教材/题干、为什么不是本题答案。
解释必须能在参考资料中找到依据：资料足以支撑全部选项时 found 为 true；任何一个选项在资料中找不到依据时 found 为 false。
只输出一个 JSON 对象，不要输出其它任何文字，格式：
{"found": true, "items": [{"key": "A", "why": "…"}, {"key": "B", "why": "…"}]}
items 必须恰好包含每个选项一次，key 与题目选项一致、不重不漏。`, c.subj.Name, c.subj.Code, c.subj.materialTitle())
}

func (c *Client) explSystemSearch() string {
	return fmt.Sprintf(`你是自学考试《%[1]s》（%[2]s）科目的主讲教师。
给定一道单选题，请依据联网搜索到的资料（无搜索结果时凭学科知识），为每个选项各写一条解释（每条不超过 40 字），句首点出关键概念，不要用 markdown 标记。
解释要回答「该选项为什么是本题答案 / 为什么不是本题答案」，而不是笼统说选项表述本身对错：题干若问「不正确的是 / 不属于 / 不包括」等否定式，答案项就是表述有误或不符合题干的那一项——答案项解释写清哪里不对、为什么正合题干所问，其余选项写清哪里符合教材/题干、为什么不是本题答案。
只输出一个 JSON 对象，不要输出其它任何文字，格式：
{"items": [{"key": "A", "why": "…"}, {"key": "B", "why": "…"}]}
items 必须恰好包含每个选项一次，key 与题目选项一致、不重不漏。`, c.subj.Name, c.subj.Code)
}

func buildExplainUser(r *ExplainReq, ref string) string {
	var sb strings.Builder
	if ref != "" {
		fmt.Fprintf(&sb, "【参考资料】\n%s\n\n", ref)
	}
	fmt.Fprintf(&sb, "【题干】%s\n【选项】\n", r.Stem)
	for _, o := range r.Options {
		fmt.Fprintf(&sb, "%s. %s\n", o.Key, o.Text)
	}
	fmt.Fprintf(&sb, "【正确答案】%s\n", r.Answer)
	if ex := strings.TrimSpace(r.Ref); ex != "" {
		fmt.Fprintf(&sb, "【原题简要解析（供对照）】%s\n", ex)
	}
	return sb.String()
}

func (c *Client) callExplain(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion, timeout time.Duration, search bool) (string, error) {
	content, err := c.callExplainOnce(ctx, msgs, timeout, true, search)
	if err != nil && strings.Contains(err.Error(), "response_format") {
		content, err = c.callExplainOnce(ctx, msgs, timeout, false, search)
	}
	if err != nil && search && strings.Contains(err.Error(), "enable_search") {
		content, err = c.callExplainOnce(ctx, msgs, timeout, true, false)
	}
	return content, err
}

func (c *Client) callExplainOnce(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion, timeout time.Duration, jsonFmt, search bool) (string, error) {
	opts := []option.RequestOption{
		option.WithAPIKey(c.apiKey),
		option.WithBaseURL(c.baseURL),
		option.WithMaxRetries(1),
		option.WithRequestTimeout(timeout),
	}
	if search {
		opts = append(opts, option.WithJSONSet("enable_search", true))
	}
	client := openai.NewClient(opts...)
	params := openai.ChatCompletionNewParams{
		Messages:    msgs,
		Model:       shared.ChatModel(c.model),
		Temperature: openai.Float(0),
	}
	if jsonFmt {
		params.ResponseFormat = openai.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONObject: &shared.ResponseFormatJSONObjectParam{},
		}
	}
	res, err := client.Chat.Completions.New(ctx, params)
	if err != nil {
		return "", err
	}
	if len(res.Choices) == 0 {
		return "", fmt.Errorf("上游返回 choices 为空")
	}
	return res.Choices[0].Message.Content, nil
}

func classifyUpstreamErr(ctx context.Context, err error) *Err {
	if ctx.Err() != nil {
		return &Err{504, "timeout", "上游解析超时"}
	}
	es := err.Error()
	if strings.Contains(es, "401") || strings.Contains(es, "Invalid API key") || strings.Contains(es, "invalid_api_key") {
		return &Err{501, "bad_key", "API Key 无效"}
	}
	return &Err{502, "upstream", "上游调用失败：" + es}
}

type rawExplainItem struct {
	Key string `json:"key"`
	Why string `json:"why"`
}

func normalizeExplain(r *ExplainReq, got []rawExplainItem, src string) ([]ExplainItem, error) {
	byKey := map[string]string{}
	for _, it := range got {
		k := strings.TrimSpace(it.Key)
		why := strings.TrimSpace(it.Why)
		if k == "" || why == "" {
			return nil, &Err{502, "parse", "选项解释缺 key 或 why"}
		}
		if _, dup := byKey[k]; dup {
			return nil, &Err{502, "parse", fmt.Sprintf("选项 %s 解释重复", k)}
		}
		byKey[k] = clampRunes(why, explWhyMaxRunes)
	}
	items := make([]ExplainItem, 0, len(r.Options))
	for _, o := range r.Options {
		why, ok := byKey[o.Key]
		if !ok {
			return nil, &Err{502, "parse", fmt.Sprintf("缺选项 %s 的解释", o.Key)}
		}
		items = append(items, ExplainItem{Key: o.Key, Correct: o.Key == r.Answer, Why: why, Src: src})
	}
	if len(byKey) != len(r.Options) {
		return nil, &Err{502, "parse", "解释条数与选项数不符（含未知 key）"}
	}
	return items, nil
}

func parseExplainItems(content string) ([]rawExplainItem, *bool, error) {
	var out struct {
		Found *bool            `json:"found"`
		Items []rawExplainItem `json:"items"`
	}
	if err := json.Unmarshal([]byte(extractJSON(content)), &out); err != nil {
		return nil, nil, fmt.Errorf("上游输出不是合法 JSON：%w", err)
	}
	return out.Items, out.Found, nil
}

func explainCacheKey(r ExplainReq) string {
	h := sha256.New()
	h.Write([]byte("expl\x00"))
	h.Write([]byte(r.Stem))
	for _, o := range r.Options {
		h.Write([]byte("\x01" + o.Key + "\x02" + o.Text))
	}
	h.Write([]byte("\x00" + r.Answer))
	h.Write([]byte("\x00" + r.Ref))
	return hex.EncodeToString(h.Sum(nil))
}

// Explain 两级链路：资料级（found=true 才采用）→ 联网级（不可解析时重出一轮）。
func (c *Client) Explain(ctx context.Context, r ExplainReq) (*ExplainResp, error) {
	if err := r.validate(); err != nil {
		return nil, &Err{400, "bad_request", err.Error()}
	}
	key := explainCacheKey(r)
	c.mu.Lock()
	if v, ok := c.exCache[key]; ok {
		v.Cached = true
		c.mu.Unlock()
		return &v, nil
	}
	c.mu.Unlock()

	ref := strings.TrimSpace(c.subj.Reference)
	resp := &ExplainResp{Engine: "ai", Task: "explain"}

	if ref != "" {
		msgs := []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(c.explSystemRef()),
			openai.UserMessage(buildExplainUser(&r, ref)),
		}
		content, err := c.callExplain(ctx, msgs, explStage1Timeout, false)
		if err == nil {
			got, found, perr := parseExplainItems(content)
			if perr == nil && found != nil && *found {
				if items, nerr := normalizeExplain(&r, got, "ref"); nerr == nil {
					resp.Source = "material"
					resp.Items = items
				}
			}
		}
	}

	if resp.Source == "" {
		var items []ExplainItem
		var lastErr error
		for attempt := 0; attempt < 2; attempt++ {
			sys := c.explSystemSearch()
			if attempt > 0 {
				sys += explRetryNote
			}
			msgs := []openai.ChatCompletionMessageParamUnion{
				openai.SystemMessage(sys),
				openai.UserMessage(buildExplainUser(&r, "")),
			}
			content, err := c.callExplain(ctx, msgs, explStage2Timeout, true)
			if err != nil {
				lastErr = classifyUpstreamErr(ctx, err)
				break
			}
			got, _, perr := parseExplainItems(content)
			if perr != nil {
				lastErr = &Err{502, "parse", perr.Error()}
			} else {
				items, lastErr = normalizeExplain(&r, got, "search")
			}
			if lastErr == nil {
				break
			}
			if attempt == 0 {
				log.Printf("explain: 联网级输出不可解析，重出一次：%v", lastErr)
			}
		}
		if lastErr != nil {
			return nil, lastErr
		}
		resp.Source = "search"
		resp.Items = items
	}

	c.mu.Lock()
	if len(c.exCache) >= maxCache {
		c.exCache = map[string]ExplainResp{}
	}
	c.exCache[key] = *resp
	c.mu.Unlock()
	return resp, nil
}

// 供 httpapi 判错用。
var ErrClientGone = errors.New("client gone")
