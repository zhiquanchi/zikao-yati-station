// 作答进度状态机（服务端唯一写入方）：首次评分落账、重新评分只返回练习分、
// 重做前归档历史、清空记录、出现标记、组卷重置。前端不再做任何合并或写盘裁决。
package progress

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"grade-svc/internal/gradeai"
	"grade-svc/internal/grading"
	"grade-svc/internal/subject"
)

const (
	MasterLine = 80 // 掌握线（与组卷/背题/考点同口径）
	LowLine    = 60 // <60 视为答错
	maxHist    = 10
)

var (
	ErrNotFound = errors.New("question_not_found")
	ErrBadInput = errors.New("bad_input")
	ErrNoAI     = errors.New("ai_unavailable")
	ErrAIFailed = errors.New("ai_failed")
)

type Service struct {
	DB  *sql.DB
	Reg *subject.Registry
	AI  map[string]*gradeai.Client // prefix → 已绑定科目 prompt/资料的判分客户端
}

type Record struct {
	U  json.RawMessage `json:"u"`
	S  *int            `json:"s"`
	G  json.RawMessage `json:"g,omitempty"`
	TS int64           `json:"ts"`
	V  int64           `json:"v,omitempty"`
}

type State struct {
	Records   map[int]json.RawMessage `json:"records"`
	Paper     json.RawMessage         `json:"paper"`
	ClearedAt int64                   `json:"clearedAt"`
	Seen      map[int]int64           `json:"seen"`
	Stats     Stats                   `json:"stats"`
}

type SubmitResult struct {
	Score    int             `json:"score"`
	Engine   string          `json:"engine"`
	Per      []any           `json:"per"`
	Practice bool            `json:"practice"`
	First    bool            `json:"first"`
	Record   json.RawMessage `json:"record,omitempty"`
	AIAvail  bool            `json:"ai_available"`
}

type SubmitReq struct {
	QID  int             `json:"qid"`
	U    json.RawMessage `json:"u"`
	Mode string          `json:"mode"` // submit（默认）| preview | ai
}

// Load 读取当前账号在本科目的权威进度。
func (s *Service) Load(ctx context.Context, prefix, slot string) (*State, error) {
	cfg := s.Reg.Get(prefix)
	if cfg == nil {
		return nil, ErrNotFound
	}
	st := &State{Records: map[int]json.RawMessage{}, Seen: map[int]int64{}}

	rows, err := s.DB.QueryContext(ctx, `SELECT qid, rec FROM progress WHERE subject = $1 AND user_slot = $2`, prefix, slot)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var qid int
		var rec []byte
		if err := rows.Scan(&qid, &rec); err != nil {
			rows.Close()
			return nil, err
		}
		st.Records[qid] = json.RawMessage(rec)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	rows, err = s.DB.QueryContext(ctx, `SELECT qid, seen_at FROM seen WHERE subject = $1 AND user_slot = $2`, prefix, slot)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var qid int
		var at int64
		if err := rows.Scan(&qid, &at); err != nil {
			rows.Close()
			return nil, err
		}
		st.Seen[qid] = at
	}
	rows.Close()

	var paper []byte
	err = s.DB.QueryRowContext(ctx, `SELECT payload FROM papers WHERE subject = $1 AND user_slot = $2`, prefix, slot).Scan(&paper)
	if err == nil {
		st.Paper = json.RawMessage(paper)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	_ = s.DB.QueryRowContext(ctx, `SELECT cleared_at FROM cleared WHERE subject = $1 AND user_slot = $2`, prefix, slot).Scan(&st.ClearedAt)
	st.Stats = buildStats(cfg, st.Records)
	return st, nil
}

// Submit 提交一次作答。first=true 才落账；否则只返回练习分（掌握状态按首次评分）。
func (s *Service) Submit(ctx context.Context, prefix, slot string, req SubmitReq) (*SubmitResult, error) {
	cfg := s.Reg.Get(prefix)
	if cfg == nil {
		return nil, ErrNotFound
	}
	q := cfg.Question(req.QID)
	if q == nil {
		return nil, ErrNotFound
	}
	mode := strings.TrimSpace(req.Mode)
	if mode == "" {
		mode = "submit"
	}
	if mode == "ai" {
		return s.submitAI(ctx, prefix, slot, cfg, q, req.U)
	}

	local := gradeLocal(q, req.U)
	if mode == "preview" {
		return &SubmitResult{Score: local.Score, Engine: local.Engine, Per: local.Per, Practice: true, AIAvail: s.aiEnabled(prefix) && q.Type == "essay"}, nil
	}
	if mode != "submit" {
		return nil, ErrBadInput
	}

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	prevRaw, hasPrev, err := lockRecord(ctx, tx, prefix, slot, q.ID)
	if err != nil {
		return nil, err
	}
	first := !hasPrev || recScore(prevRaw) == nil
	if first {
		var prevV int64
		if hasPrev {
			prevV = recViewed(prevRaw)
		}
		rec := buildRecord(req.U, local.Score, localDetail(local), prevV)
		if err := upsertRecord(ctx, tx, prefix, slot, q.ID, rec); err != nil {
			return nil, err
		}
		if err := markSeenTx(ctx, tx, prefix, slot, []int{q.ID}); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		out, _ := json.Marshal(rec)
		return &SubmitResult{Score: local.Score, Engine: local.Engine, Per: local.Per, First: true,
			Record: out, AIAvail: s.aiEnabled(prefix) && q.Type == "essay"}, nil
	}
	// 已判分：练习分不落账、不归档、不刷新分数胶囊
	return &SubmitResult{Score: local.Score, Engine: local.Engine, Per: local.Per, Practice: true,
		AIAvail: s.aiEnabled(prefix) && q.Type == "essay"}, nil
}

func (s *Service) submitAI(ctx context.Context, prefix, slot string, cfg *subject.Config, q *subject.Question, u json.RawMessage) (*SubmitResult, error) {
	client := s.AI[prefix]
	if client == nil || !client.Enabled() {
		return nil, ErrNoAI
	}
	if q.Type != "essay" {
		return nil, ErrBadInput
	}
	answer := essayText(u)
	if strings.TrimSpace(answer) == "" {
		return nil, ErrBadInput
	}
	ai, err := client.Grade(ctx, gradeai.Req{Stem: q.Stem, Ref: q.Ref, Points: q.Points, Answer: answer})
	if err != nil {
		return nil, &gradeai.Err{Status: 502, Code: "upstream", Detail: err.Error()}
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	prevRaw, hasPrev, err := lockRecord(ctx, tx, prefix, slot, q.ID)
	if err != nil {
		return nil, err
	}
	if hasPrev && aiEngine(prevRaw) == "ai" {
		// 首次分已是 AI：再调只做展示
		out, _ := json.Marshal(gradeai.Resp{Engine: ai.Engine, Score: ai.Score, Summary: ai.Summary, Per: ai.Per})
		return &SubmitResult{Score: ai.Score, Engine: "ai", Per: perAny(ai.Per), Practice: true, AIAvail: true, Record: out}, nil
	}
	prevV := int64(0)
	if hasPrev {
		prevV = recViewed(prevRaw)
	}
	g, _ := json.Marshal(gradeai.Resp{Engine: ai.Engine, Score: ai.Score, Summary: ai.Summary, Per: ai.Per, Cached: ai.Cached})
	rec := buildRecord(u, ai.Score, g, prevV)
	if err := upsertRecord(ctx, tx, prefix, slot, q.ID, rec); err != nil {
		return nil, err
	}
	if err := markSeenTx(ctx, tx, prefix, slot, []int{q.ID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	out, _ := json.Marshal(rec)
	return &SubmitResult{Score: ai.Score, Engine: "ai", Per: perAny(ai.Per), First: true, Record: out, AIAvail: true}, nil
}

// Redo 重做：先归档（有分才归档），再删记录；看过解析标记保留在 seen 上。
func (s *Service) Redo(ctx context.Context, prefix, slot string, qid int) error {
	if s.Reg.Get(prefix) == nil {
		return ErrNotFound
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rec, ok, err := lockRecord(ctx, tx, prefix, slot, qid)
	if err != nil {
		return err
	}
	if ok {
		if recScore(rec) != nil {
			if err := archiveTx(ctx, tx, prefix, slot, qid, rec); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM progress WHERE subject=$1 AND user_slot=$2 AND qid=$3`, prefix, slot, qid); err != nil {
			return err
		}
	}
	if err := markSeenTx(ctx, tx, prefix, slot, []int{qid}); err != nil {
		return err
	}
	return tx.Commit()
}

// Clear 清空记录、历史与出现标记（不可恢复）。
func (s *Service) Clear(ctx context.Context, prefix, slot string) error {
	if s.Reg.Get(prefix) == nil {
		return ErrNotFound
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DELETE FROM progress WHERE subject=$1 AND user_slot=$2`,
		`DELETE FROM histories WHERE subject=$1 AND user_slot=$2`,
		`DELETE FROM seen WHERE subject=$1 AND user_slot=$2`,
	} {
		if _, err := tx.ExecContext(ctx, q, prefix, slot); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO cleared (subject,user_slot,cleared_at) VALUES ($1,$2,$3)
		ON CONFLICT (subject,user_slot) DO UPDATE SET cleared_at = excluded.cleared_at`,
		prefix, slot, time.Now().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

// MarkViewed 记录「看过解析」标记：已有记录只补 v；无记录则建一条未作答记录。
func (s *Service) MarkViewed(ctx context.Context, prefix, slot string, qid int) error {
	cfg := s.Reg.Get(prefix)
	if cfg == nil || cfg.Question(qid) == nil {
		return ErrNotFound
	}
	now := time.Now().UnixMilli()
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO progress (subject,user_slot,qid,rec,ts)
		VALUES ($1,$2,$3,jsonb_build_object('u',NULL,'s',NULL,'ts',($4::bigint),'v',($4::bigint)),$4)
		ON CONFLICT (subject,user_slot,qid)
		DO UPDATE SET rec = progress.rec || jsonb_build_object('v',($4::bigint))`,
		prefix, slot, qid, now)
	return err
}

// MarkSeen 批量标记「出现过」（只记首次时间；背答案模式由前端不调用）。
func (s *Service) MarkSeen(ctx context.Context, prefix, slot string, qids []int) error {
	if s.Reg.Get(prefix) == nil {
		return ErrNotFound
	}
	cfg := s.Reg.Get(prefix)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	valid := make([]int, 0, len(qids))
	for _, id := range qids {
		if cfg.Question(id) != nil {
			valid = append(valid, id)
		}
	}
	if err := markSeenTx(ctx, tx, prefix, slot, valid); err != nil {
		return err
	}
	return tx.Commit()
}

// ——— 内部工具 ———

func (s *Service) aiEnabled(prefix string) bool {
	c := s.AI[prefix]
	return c != nil && c.Enabled()
}

func gradeLocal(q *subject.Question, u json.RawMessage) grading.Result {
	switch q.Type {
	case "single":
		var v string
		_ = json.Unmarshal(u, &v)
		return grading.GradeSingle(v, q.Answer)
	case "blank":
		var in []string
		_ = json.Unmarshal(u, &in)
		return grading.GradeBlanks(in, q.Blanks, q.Unordered, q.Fallback)
	case "essay":
		return grading.GradeEssay(essayText(u), q.Points)
	}
	return grading.Result{Score: 0, Engine: "local"}
}

// essayText 兼容整题文本与旧版分点作答。
func essayText(u json.RawMessage) string {
	var s string
	if json.Unmarshal(u, &s) == nil {
		return s
	}
	var obj struct {
		Mode   string   `json:"mode"`
		Whole  string   `json:"whole"`
		Points []string `json:"points"`
	}
	if json.Unmarshal(u, &obj) == nil {
		if obj.Mode == "points" {
			out := make([]string, 0, len(obj.Points))
			for _, p := range obj.Points {
				if strings.TrimSpace(p) != "" {
					out = append(out, strings.TrimSpace(p))
				}
			}
			return strings.Join(out, "\n")
		}
		return obj.Whole
	}
	return ""
}

func lockRecord(ctx context.Context, tx *sql.Tx, prefix, slot string, qid int) (json.RawMessage, bool, error) {
	var raw []byte
	err := tx.QueryRowContext(ctx,
		`SELECT rec FROM progress WHERE subject=$1 AND user_slot=$2 AND qid=$3 FOR UPDATE`,
		prefix, slot, qid).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(raw), true, nil
}

func upsertRecord(ctx context.Context, tx *sql.Tx, prefix, slot string, qid int, rec Record) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO progress (subject,user_slot,qid,rec,ts) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (subject,user_slot,qid) DO UPDATE SET rec = excluded.rec, ts = excluded.ts`,
		prefix, slot, qid, string(b), rec.TS)
	return err
}

func buildRecord(u json.RawMessage, score int, g json.RawMessage, v int64) Record {
	sc := score
	return Record{U: u, S: &sc, G: g, TS: time.Now().UnixMilli(), V: v}
}

// localDetail 把本机判分明细随记录落库：刷新/换设备时无需重算即可还原结果区。
func localDetail(r grading.Result) json.RawMessage {
	if r.Engine == "" {
		return nil
	}
	b, err := json.Marshal(map[string]any{"score": r.Score, "per": r.Per, "engine": r.Engine, "ts": time.Now().UnixMilli()})
	if err != nil {
		return nil
	}
	return b
}

func archiveTx(ctx context.Context, tx *sql.Tx, prefix, slot string, qid int, rec json.RawMessage) error {
	var m map[string]json.RawMessage
	if json.Unmarshal(rec, &m) != nil {
		return nil
	}
	ts := int64(num(m["ts"]))
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO histories (subject,user_slot,qid,ts,rec) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (subject,user_slot,qid,ts) DO UPDATE SET rec = excluded.rec`,
		prefix, slot, qid, ts, string(rec)); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		DELETE FROM histories WHERE subject=$1 AND user_slot=$2 AND qid=$3 AND ts NOT IN (
			SELECT ts FROM histories WHERE subject=$1 AND user_slot=$2 AND qid=$3 ORDER BY ts DESC LIMIT $4
		)`, prefix, slot, qid, maxHist)
	return err
}

func markSeenTx(ctx context.Context, tx *sql.Tx, prefix, slot string, qids []int) error {
	now := time.Now().UnixMilli()
	for _, id := range qids {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO seen (subject,user_slot,qid,seen_at) VALUES ($1,$2,$3,$4)
			ON CONFLICT (subject,user_slot,qid) DO NOTHING`,
			prefix, slot, id, now); err != nil {
			return err
		}
	}
	return nil
}

func recScore(rec json.RawMessage) *int {
	var m map[string]json.RawMessage
	if json.Unmarshal(rec, &m) != nil {
		return nil
	}
	raw, ok := m["s"]
	if !ok || len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil
	}
	var s int
	if json.Unmarshal(raw, &s) != nil {
		return nil
	}
	return &s
}

func recViewed(rec json.RawMessage) int64 {
	var m map[string]json.RawMessage
	if json.Unmarshal(rec, &m) != nil {
		return 0
	}
	return int64(num(m["v"]))
}

func aiEngine(rec json.RawMessage) string {
	var m map[string]json.RawMessage
	if json.Unmarshal(rec, &m) != nil {
		return ""
	}
	var g struct {
		Engine string `json:"engine"`
	}
	if json.Unmarshal(m["g"], &g) != nil {
		return ""
	}
	return g.Engine
}

func num(r json.RawMessage) float64 {
	var f float64
	if len(r) == 0 || json.Unmarshal(r, &f) != nil {
		return 0
	}
	return f
}

func scoreOf(rec json.RawMessage) *int { return recScore(rec) }

func perAny(in []gradeai.PerPoint) []any {
	out := make([]any, len(in))
	for i, p := range in {
		out[i] = p
	}
	return out
}
