// 简答题 AI 判分核心：构造出题人 prompt、经 OpenAI 兼容协议调千问、防御式解析归一。
// 分数口径与 grading.js 的 gradeEssay 对齐：score=各要点 cov 均值×100；hit≥0.5、part≥0.22。
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
	defaultBaseURL = "https://maas.qianwenaiapi.com/compatible-mode/v1"
	defaultModel   = "qwen3.8-flash"
	maxAnswerRunes = 8000
	maxCache       = 512
)

// GradeReq 是前端 POST /api/grade 的请求体（分点作答由前端拼成带编号的多行文本）。
// Task 为空走简判判分；"explain" 时复用同一端点做单选逐项解析（explain.go），Options 携带选项。
type GradeReq struct {
	Stem    string   `json:"stem"`
	Ref     string   `json:"ref"`
	Points  []string `json:"points"`
	Answer  string   `json:"answer"`
	Task    string   `json:"task,omitempty"`
	Options []Opt    `json:"options,omitempty"`
}

// PerPoint 与 grading.js gradeEssay 返回的 per 元素形状兼容（segs 置空，另附 comment 点评）。
type PerPoint struct {
	Text    string  `json:"text"`
	Cov     float64 `json:"cov"`
	State   string  `json:"state"`
	Comment string  `json:"comment"`
	Segs    []string `json:"segs"`
}

type GradeResp struct {
	Engine string     `json:"engine"`
	Score  int        `json:"score"`
	Per    []PerPoint `json:"per"`
	Cached bool       `json:"cached"`
}

// svcErr 携带对外 HTTP 状态与错误码，handler 据此应答；前端按 code 决定是否整会话降级。
type svcErr struct {
	Status int
	Code   string
	Detail string
}

func (e *svcErr) Error() string { return e.Code + ": " + e.Detail }

type grader struct {
	apiKey  string
	baseURL string
	model   string
	mu      sync.Mutex
	cache   map[string]GradeResp
	exCache map[string]ExplainResp // 单选逐项解析缓存（与 cache 同锁）
}

func newGrader(apiKey, baseURL, model string) *grader {
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	if model == "" {
		model = defaultModel
	}
	return &grader{apiKey: apiKey, baseURL: baseURL, model: model,
		cache: map[string]GradeResp{}, exCache: map[string]ExplainResp{}}
}

func (r GradeReq) validate() error {
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

const systemPromptFmt = `你是自考《操作系统》科目的阅卷老师。请对照参考答案要点，逐条评估学生作答的覆盖程度。
评分口径：
- cov 为该要点的覆盖度，0~1 的小数：语义一致即高分（0.8~1，允许措辞与顺序不同）；意思沾边但不完整给 0.3~0.7；只写到要点标题词而无实质解释约 0.5~0.6；完全没答到或答错给 0~0.2。
- comment 不超过 25 字，指出答到了什么、缺了什么。
只输出一个 JSON 对象，不要输出其它任何文字，格式：
{"per":[{"i":1,"cov":0.8,"comment":"答到并发含义"},{"i":2,"cov":0.4,"comment":"只提标题未解释"}]}
per 数组必须恰好包含 %[1]d 条，i 从 1 开始与要点编号对应。`

func buildMessages(r GradeReq) []openai.ChatCompletionMessageParamUnion {
	var sb strings.Builder
	fmt.Fprintf(&sb, "【题干】%s\n\n【参考答案要点】（共 %d 条）\n", r.Stem, len(r.Points))
	for i, p := range r.Points {
		fmt.Fprintf(&sb, "%d. %s\n", i+1, p)
	}
	fmt.Fprintf(&sb, "\n【参考答案全文】%s\n\n【学生作答】\n%s\n", r.Ref, r.Answer)
	return []openai.ChatCompletionMessageParamUnion{
		openai.SystemMessage(fmt.Sprintf(systemPromptFmt, len(r.Points))),
		openai.UserMessage(sb.String()),
	}
}

func (g *grader) callLLM(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion, jsonFmt bool) (string, error) {
	client := openai.NewClient(
		option.WithAPIKey(g.apiKey),
		option.WithBaseURL(g.baseURL),
		option.WithMaxRetries(1),
		option.WithRequestTimeout(20*time.Second),
	)
	params := openai.ChatCompletionNewParams{
		Messages:    msgs,
		Model:       shared.ChatModel(g.model),
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

// 上游若拒绝 response_format（部分模型/网关不支持），去掉该参数重试一次，靠提示词约束 JSON。
func (g *grader) call(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion) (string, error) {
	content, err := g.callLLM(ctx, msgs, true)
	if err != nil && strings.Contains(err.Error(), "response_format") {
		return g.callLLM(ctx, msgs, false)
	}
	return content, err
}

// extractJSON 容忍代码围栏与前后闲话，截取首个大括号平衡的 JSON 对象。
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

func clamp01(v float64) float64 {
	return math.Max(0, math.Min(1, v))
}

func clampRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// normalize 解析上游 content 并与 points 对齐：状态一律由 cov 推导（不信模型自报），
// score 按 cov 均值×100 重算；条数不符/编号越界重复/缺 cov 均判为失败。
func normalize(content string, r *GradeReq) (*GradeResp, error) {
	var out struct {
		Per []struct {
			I       *int     `json:"i"`
			Cov     *float64 `json:"cov"`
			Comment string   `json:"comment"`
		} `json:"per"`
	}
	if err := json.Unmarshal([]byte(extractJSON(content)), &out); err != nil {
		return nil, &svcErr{502, "parse", "上游输出不是合法 JSON：" + err.Error()}
	}
	if len(out.Per) != len(r.Points) {
		return nil, &svcErr{502, "parse", fmt.Sprintf("逐点结果 %d 条与要点 %d 条不符", len(out.Per), len(r.Points))}
	}
	per := make([]PerPoint, len(r.Points))
	seen := make([]bool, len(r.Points))
	sum := 0.0
	for j, it := range out.Per {
		idx := j // 模型省略编号时按顺序回填
		if it.I != nil {
			idx = *it.I - 1
		}
		if idx < 0 || idx >= len(r.Points) || seen[idx] {
			return nil, &svcErr{502, "parse", fmt.Sprintf("要点编号 %d 缺失、越界或重复", idx+1)}
		}
		if it.Cov == nil {
			return nil, &svcErr{502, "parse", fmt.Sprintf("第 %d 点缺 cov", idx+1)}
		}
		seen[idx] = true
		cov := clamp01(*it.Cov)
		per[idx] = PerPoint{Text: r.Points[idx], Cov: cov, State: stateOf(cov), Comment: clampRunes(strings.TrimSpace(it.Comment), 60), Segs: []string{}}
		sum += cov
	}
	return &GradeResp{Engine: "ai", Score: int(math.Round(sum / float64(len(per)) * 100)), Per: per}, nil
}

func cacheKey(r GradeReq) string {
	h := sha256.New()
	h.Write([]byte(r.Stem))
	h.Write([]byte("\x00"))
	h.Write([]byte(strings.Join(r.Points, "\x01")))
	h.Write([]byte("\x00"))
	h.Write([]byte(r.Answer))
	return hex.EncodeToString(h.Sum(nil))
}

// Grade 带进程内缓存：同一题干+要点+作答只调一次上游（换一批/反复提交不计费）。
func (g *grader) Grade(ctx context.Context, r GradeReq) (*GradeResp, error) {
	if err := r.validate(); err != nil {
		return nil, &svcErr{400, "bad_request", err.Error()}
	}
	key := cacheKey(r)
	g.mu.Lock()
	if v, ok := g.cache[key]; ok {
		v.Cached = true
		g.mu.Unlock()
		return &v, nil
	}
	g.mu.Unlock()

	content, err := g.call(ctx, buildMessages(r))
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, &svcErr{504, "timeout", "上游判分超时"}
		}
		es := err.Error()
		if strings.Contains(es, "401") || strings.Contains(es, "Invalid API key") || strings.Contains(es, "invalid_api_key") {
			return nil, &svcErr{501, "bad_key", "API Key 无效"}
		}
		return nil, &svcErr{502, "upstream", "上游调用失败：" + es}
	}
	res, err := normalize(content, &r)
	if err != nil {
		return nil, err
	}
	g.mu.Lock()
	if len(g.cache) >= maxCache {
		g.cache = map[string]GradeResp{}
	}
	g.cache[key] = *res
	g.mu.Unlock()
	return res, nil
}
