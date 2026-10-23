// 单选题「逐项解析」：LLM 先在科目参考资料（SUBJECT_DIR 注入的 grade/reference.md，与科目思维导图逐字一致）
// 中寻找各选项对错的依据；资料覆盖不足时，第二次调用带 enable_search 让模型联网搜索补充解释。
// 复用 POST /api/grade 路由（请求体 task:"explain" 分流），线上代理无需新增路径。
// 缓存与判分同套路：进程内 map，同题只调一次上游。
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	openai "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/shared"
)

const (
	explStage1Timeout = 30 * time.Second
	explStage2Timeout = 50 * time.Second
	explWhyMaxRunes   = 160
	// explRetryNote 是联网级「首轮输出无法解析为约定 JSON」时重出一次的追加提醒（只强调格式，不改题目口径）。
	explRetryNote = "\n注意：上一轮输出无法解析为约定 JSON。本轮务必只输出这一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。"
)

// Opt 是单选题的一个选项。
type Opt struct {
	Key  string `json:"key"`
	Text string `json:"text"`
}

// ExplainItem 为单个选项的解释；Src 标出处：ref=资料依据，search=联网/模型知识。
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

// materialTitle 是资料级 prompt 里的参考资料名：subject.json 的 grade.materialTitle 缺省时用通用措辞。
func (s *subjectConfig) materialTitle() string {
	if strings.TrimSpace(s.MaterialTitle) != "" {
		return s.MaterialTitle
	}
	return s.Name + "考点参考资料"
}

func (r *GradeReq) validateExplain() error {
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

func (g *grader) explSystemRef() string {
	return fmt.Sprintf(`你是自学考试《%[1]s》（%[2]s）科目的主讲教师。下面提供《%[3]s》参考资料。
给定一道单选题，为每个选项各写一条解释（每条不超过 40 字），讲清该选项为什么正确或为什么错误，句首点出关键概念，不要用 markdown 标记。
解释必须能在参考资料中找到依据：资料足以支撑全部选项时 found 为 true；任何一个选项在资料中找不到依据时 found 为 false。
只输出一个 JSON 对象，不要输出其它任何文字，格式：
{"found": true, "items": [{"key": "A", "why": "…"}, {"key": "B", "why": "…"}]}
items 必须恰好包含每个选项一次，key 与题目选项一致、不重不漏。`, g.subj.Name, g.subj.Code, g.subj.materialTitle())
}

func (g *grader) explSystemSearch() string {
	return fmt.Sprintf(`你是自学考试《%[1]s》（%[2]s）科目的主讲教师。
给定一道单选题，请依据联网搜索到的资料（无搜索结果时凭学科知识），为每个选项各写一条解释（每条不超过 40 字），讲清该选项为什么正确或为什么错误，句首点出关键概念，不要用 markdown 标记。
只输出一个 JSON 对象，不要输出其它任何文字，格式：
{"items": [{"key": "A", "why": "…"}, {"key": "B", "why": "…"}]}
items 必须恰好包含每个选项一次，key 与题目选项一致、不重不漏。`, g.subj.Name, g.subj.Code)
}

func buildExplainUser(r *GradeReq, ref string) string {
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

// callExplain 单次上游调用：jsonFmt 控制 response_format，search 控制 enable_search。
// 上游明确拒绝某参数时去参重试一次（同 grader.call 的容错策略）。
func (g *grader) callExplain(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion, timeout time.Duration, search bool) (string, error) {
	content, err := g.callExplainOnce(ctx, msgs, timeout, true, search)
	if err != nil && strings.Contains(err.Error(), "response_format") {
		content, err = g.callExplainOnce(ctx, msgs, timeout, false, search)
	}
	if err != nil && search && strings.Contains(err.Error(), "enable_search") {
		// 网关不认联网搜索参数：去掉参数凭模型知识作答（source 由调用侧标为 search，含义退化为「知识库」）
		content, err = g.callExplainOnce(ctx, msgs, timeout, true, false)
	}
	return content, err
}

func (g *grader) callExplainOnce(ctx context.Context, msgs []openai.ChatCompletionMessageParamUnion, timeout time.Duration, jsonFmt, search bool) (string, error) {
	opts := []option.RequestOption{
		option.WithAPIKey(g.apiKey),
		option.WithBaseURL(g.baseURL),
		option.WithMaxRetries(1),
		option.WithRequestTimeout(timeout),
	}
	if search {
		opts = append(opts, option.WithJSONSet("enable_search", true))
	}
	client := openai.NewClient(opts...)
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

// classifyUpstreamErr 与 Grade 的错误映射一致：401→bad_key、ctx 超时→timeout、其余 502 upstream。
func classifyUpstreamErr(ctx context.Context, err error) *svcErr {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return &svcErr{504, "timeout", "上游解析超时"}
	}
	es := err.Error()
	if strings.Contains(es, "401") || strings.Contains(es, "Invalid API key") || strings.Contains(es, "invalid_api_key") {
		return &svcErr{501, "bad_key", "API Key 无效"}
	}
	return &svcErr{502, "upstream", "上游调用失败：" + es}
}

// normalizeExplain 把模型 items 与题目选项对齐：key 不重不漏、why 截断清洗；
// correct 一律按题面 answer 推导（不信模型自报）。
func normalizeExplain(r *GradeReq, got []struct {
	Key string `json:"key"`
	Why string `json:"why"`
}, src string) ([]ExplainItem, error) {
	byKey := map[string]string{}
	for _, it := range got {
		k := strings.TrimSpace(it.Key)
		why := strings.TrimSpace(it.Why)
		if k == "" || why == "" {
			return nil, &svcErr{502, "parse", "选项解释缺 key 或 why"}
		}
		if _, dup := byKey[k]; dup {
			return nil, &svcErr{502, "parse", fmt.Sprintf("选项 %s 解释重复", k)}
		}
		byKey[k] = clampRunes(why, explWhyMaxRunes)
	}
	items := make([]ExplainItem, 0, len(r.Options))
	for _, o := range r.Options {
		why, ok := byKey[o.Key]
		if !ok {
			return nil, &svcErr{502, "parse", fmt.Sprintf("缺选项 %s 的解释", o.Key)}
		}
		items = append(items, ExplainItem{Key: o.Key, Correct: o.Key == r.Answer, Why: why, Src: src})
	}
	if len(byKey) != len(r.Options) {
		return nil, &svcErr{502, "parse", "解释条数与选项数不符（含未知 key）"}
	}
	return items, nil
}

func parseExplainItems(content string) ([]struct {
	Key string `json:"key"`
	Why string `json:"why"`
}, *bool, error) {
	var out struct {
		Found *bool `json:"found"`
		Items []struct {
			Key string `json:"key"`
			Why string `json:"why"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(extractJSON(content)), &out); err != nil {
		return nil, nil, fmt.Errorf("上游输出不是合法 JSON：%w", err)
	}
	return out.Items, out.Found, nil
}

func explainCacheKey(r GradeReq) string {
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

// Explain 两级链路：
//  1. 带参考资料调用：模型判 found——资料足以解释全部选项则直接采用（source=material）；
//  2. found=false 或第一级任何失败 → 带 enable_search 重新生成全选项解释（source=search）；
//     联网级输出不可解析（模型偶然吐闲话/半截 JSON）时，追加格式提醒重出一次，仍失败才报 parse。
//
// 科目无参考资料（SUBJECT_DIR 下无 reference.md）则直接走第二级。
func (g *grader) Explain(ctx context.Context, r GradeReq) (*ExplainResp, error) {
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
		content, err := g.callExplain(ctx, msgs, explStage1Timeout, false)
		if err == nil {
			got, found, perr := parseExplainItems(content)
			if perr == nil && found != nil && *found {
				if items, nerr := normalizeExplain(&r, got, "ref"); nerr == nil {
					resp.Source = "material"
					resp.Items = items
				}
			}
		}
		// 第一级任何失败/资料不足都落到第二级联网；401 等致命错误留给第二级统一分类
	}

	if resp.Source == "" {
		var items []ExplainItem
		var lastErr error
		for attempt := 0; attempt < 2; attempt++ { // 首轮输出不可解析：加格式提醒重出一次（网络/密钥类错误不重试）
			sys := g.explSystemSearch()
			if attempt > 0 {
				sys += explRetryNote
			}
			msgs := []openai.ChatCompletionMessageParamUnion{
				openai.SystemMessage(sys),
				openai.UserMessage(buildExplainUser(&r, "")),
			}
			content, err := g.callExplain(ctx, msgs, explStage2Timeout, true)
			if err != nil {
				lastErr = classifyUpstreamErr(ctx, err)
				break // 上游不可用/超时/密钥无效：重出无益，直接失败
			}
			got, _, perr := parseExplainItems(content)
			if perr != nil {
				lastErr = &svcErr{502, "parse", perr.Error()}
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

	g.mu.Lock()
	if len(g.exCache) >= maxCache {
		g.exCache = map[string]ExplainResp{}
	}
	g.exCache[key] = *resp
	g.mu.Unlock()
	return resp, nil
}
