// 科目装载：启动时扫描 SUBJECTS_DIR，把每个科目目录的 subject.json、data/questions.json
// 与参考资料读进内存。Go 服务此后按 qid 取题面/要点/答案，前端不再上传题目内容。
// 目录不是科目（_ 前缀、无 subject.json、prefix/code 重复）时跳过或拒启，避免拿错科目口径。
package subject

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Question 是题库规范题目的服务端视图（字段与 data/questions.json 一致）。
type Question struct {
	ID          int        `json:"id"`
	Chapter     string     `json:"chapter"`
	Type        string     `json:"type"` // single | blank | essay
	Stem        string     `json:"stem"`
	Ref         string     `json:"ref"`
	Explanation string     `json:"explanation,omitempty"`
	Options     []Option   `json:"options,omitempty"`
	Answer      string     `json:"answer,omitempty"`
	BlankCount  int        `json:"blankCount,omitempty"`
	Blanks      [][]string `json:"blanks,omitempty"`
	Fallback    bool       `json:"fallback,omitempty"`
	Unordered   bool       `json:"unordered,omitempty"`
	Points      []string   `json:"points,omitempty"`
	PointsMd    []string   `json:"pointsMd,omitempty"`
	Explain     string     `json:"explain,omitempty"`
}

type Option struct {
	Key  string `json:"key"`
	Text string `json:"text"`
}

type Paper struct {
	Target int            `json:"target"`
	Scores map[string]int `json:"scores"`
}

type Config struct {
	Prefix      string
	Code        string
	Name        string
	ExamMonth   string
	Title       string
	PageTitle   string
	SwitchLabel string
	StorageKey  string // 仅用于前端一次性迁移旧 localStorage，新前端不再按它分区
	Flags       map[string]any
	Paper       Paper
	Mindmap     map[string]any
	MemoCfg     map[string]any
	Material    string // grade.materialTitle
	Reference   string // 参考资料全文（空＝无）
	Chapters    []string
	Questions   []Question
	Memo        json.RawMessage // 原样透传给前端
	MindmapHTML []byte          // 科目思维导图页（可选，由 API 下发）

	byID map[int]*Question
}

// Question 按题号取题；不存在返回 nil。
func (c *Config) Question(id int) *Question { return c.byID[id] }

// Meta 返回前端渲染所需的科目身份（不含题库）。
func (c *Config) Meta() map[string]any {
	return map[string]any{
		"prefix": c.Prefix, "code": c.Code, "name": c.Name, "examMonth": c.ExamMonth,
		"title": c.Title, "pageTitle": c.PageTitle,
		"flags": c.Flags, "paper": c.Paper, "mindmap": c.Mindmap, "memo": c.MemoCfg,
		"legacyStorageKey": c.StorageKey,
	}
}

type Registry struct {
	byPrefix map[string]*Config
	order    []*Config
}

func (r *Registry) Get(prefix string) *Config { return r.byPrefix[prefix] }

// List 返回按目录名排序的科目清单（门户/切换器顺序）。
func (r *Registry) List() []*Config { return r.order }

// Load 扫描 dir 下所有科目目录。任何已声明科目缺关键字段都拒启（宁可少服务也不拿错口径）。
func Load(dir string) (*Registry, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, fmt.Errorf("缺少 SUBJECTS_DIR（科目目录根）")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("读取 SUBJECTS_DIR %s：%w", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), "_") || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, e.Name(), "subject.json")); err == nil {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return nil, fmt.Errorf("SUBJECTS_DIR %s 下没有可用科目", dir)
	}
	reg := &Registry{byPrefix: map[string]*Config{}}
	for _, name := range names {
		cfg, err := loadOne(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		if _, dup := reg.byPrefix[cfg.Prefix]; dup {
			return nil, fmt.Errorf("科目前缀重复：%s", cfg.Prefix)
		}
		reg.byPrefix[cfg.Prefix] = cfg
		reg.order = append(reg.order, cfg)
	}
	return reg, nil
}

type rawSubject struct {
	Prefix      string         `json:"prefix"`
	Code        string         `json:"code"`
	Name        string         `json:"name"`
	ExamMonth   string         `json:"examMonth"`
	Title       string         `json:"title"`
	PageTitle   string         `json:"pageTitle"`
	SwitchLabel string         `json:"switchLabel"`
	StorageKey  string         `json:"storageKey"`
	Flags       map[string]any `json:"flags"`
	Paper       Paper          `json:"paper"`
	Mindmap     map[string]any `json:"mindmap"`
	Memo        map[string]any `json:"memo"`
	Grade       struct {
		MaterialTitle string `json:"materialTitle"`
	} `json:"grade"`
}

type payload struct {
	Title     string          `json:"title"`
	Meta      json.RawMessage `json:"meta"`
	Chapters  []string        `json:"chapters"`
	Questions []Question      `json:"questions"`
	Memo      json.RawMessage `json:"memo"`
}

func loadOne(dir string) (*Config, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "subject.json"))
	if err != nil {
		return nil, fmt.Errorf("读 %s/subject.json：%w", dir, err)
	}
	var s rawSubject
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("解析 %s/subject.json：%w", dir, err)
	}
	if strings.TrimSpace(s.Prefix) == "" || strings.TrimSpace(s.Code) == "" || strings.TrimSpace(s.Name) == "" {
		return nil, fmt.Errorf("%s/subject.json 缺 prefix/code/name", dir)
	}
	body, err := os.ReadFile(filepath.Join(dir, "data", "questions.json"))
	if err != nil {
		return nil, fmt.Errorf("读 %s/data/questions.json（先跑 bun run build）：%w", dir, err)
	}
	var p payload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("解析 %s/data/questions.json：%w", dir, err)
	}
	cfg := &Config{
		Prefix: s.Prefix, Code: s.Code, Name: s.Name, ExamMonth: s.ExamMonth,
		Title: s.Title, PageTitle: s.PageTitle, SwitchLabel: s.SwitchLabel, StorageKey: s.StorageKey,
		Flags: s.Flags, Paper: s.Paper, Mindmap: s.Mindmap, MemoCfg: s.Memo,
		Material: s.Grade.MaterialTitle, Chapters: p.Chapters, Questions: p.Questions, Memo: p.Memo,
		byID: make(map[int]*Question, len(p.Questions)),
	}
	if cfg.Flags == nil {
		cfg.Flags = map[string]any{}
	}
	if cfg.Paper.Target <= 0 {
		cfg.Paper.Target = 100
	}
	if cfg.Paper.Scores == nil {
		cfg.Paper.Scores = map[string]int{"single": 1, "blank": 2, "essay": 5}
	}
	for i := range cfg.Questions {
		q := &cfg.Questions[i]
		if q.ID <= 0 {
			return nil, fmt.Errorf("%s 题库存在非法题号", s.Prefix)
		}
		if _, dup := cfg.byID[q.ID]; dup {
			return nil, fmt.Errorf("%s 题库题号重复：%d", s.Prefix, q.ID)
		}
		cfg.byID[q.ID] = q
	}
	for _, rel := range []string{"reference.md", filepath.Join("grade", "reference.md")} {
		if b, err := os.ReadFile(filepath.Join(dir, rel)); err == nil && strings.TrimSpace(string(b)) != "" {
			cfg.Reference = string(b)
			break
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, "mindmap.html")); err == nil {
		cfg.MindmapHTML = b
	}
	return cfg, nil
}
