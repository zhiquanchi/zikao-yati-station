// 组卷：服务端按题型权重与掌握状态加权无放回抽样，抽到目标总分即止。
// 「组卷即全新」的语义也在服务端完成：卷内旧作答先归档，再清成未作答（保留看过解析标记）。
package progress

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"math/rand"
	"strings"
	"time"

	"grade-svc/internal/subject"
)

var ErrEmptyPool = errString("empty_pool")

type errString string

func (e errString) Error() string { return string(e) }

type PaperReq struct {
	Chapter string `json:"chapter"`
	Type    string `json:"type"`
	Status  string `json:"status"`
	Search  string `json:"search"`
}

type Paper struct {
	Seed   uint32 `json:"seed"`
	Order  []int  `json:"order"`
	Picked []int  `json:"picked"`
	Total  int    `json:"total"`
	TS     int64  `json:"ts"`
}

// BuildPaper 生成并保存一张卷；池为空返回 ErrEmptyPool（调用方保留原卷）。
func (s *Service) BuildPaper(ctx context.Context, prefix, slot string, req PaperReq) (*Paper, error) {
	cfg := s.Reg.Get(prefix)
	if cfg == nil {
		return nil, ErrNotFound
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// 同一槽位的组卷/提交/清空串行：避免并发组卷互相清记录或死锁
	if err := lockSlotTx(ctx, tx, prefix, slot); err != nil {
		return nil, err
	}
	records, err := loadRecs(ctx, tx, prefix, slot)
	if err != nil {
		return nil, err
	}
	seen, err := loadSeen(ctx, tx, prefix, slot)
	if err != nil {
		return nil, err
	}
	pool := filterPool(cfg, records, req)
	if len(pool) == 0 {
		return nil, ErrEmptyPool
	}
	seed := uint32(time.Now().UnixNano() ^ rand.Int63())
	rnd := rand.New(rand.NewSource(int64(seed)))
	type entry struct {
		id int
		k  float64
	}
	order := make([]entry, 0, len(pool))
	for _, q := range pool {
		w := typeWeight(q.Type) * statusWeight(q.ID, records, seen)
		u := rnd.Float64()
		if u < 1e-9 {
			u = 1e-9
		}
		order = append(order, entry{id: q.ID, k: -math.Log(u) / w})
	}
	// 插入排序即可（题库规模数百）
	for i := 1; i < len(order); i++ {
		for j := i; j > 0 && order[j].k < order[j-1].k; j-- {
			order[j], order[j-1] = order[j-1], order[j]
		}
	}
	sortedIDs := make([]int, len(order))
	for i, e := range order {
		sortedIDs[i] = e.id
	}
	total := 0
	picked := make([]int, 0, 40)
	for _, id := range sortedIDs {
		q := cfg.Question(id)
		if q == nil {
			continue
		}
		picked = append(picked, id)
		total += cfg.Paper.Scores[q.Type]
		if total >= cfg.Paper.Target {
			break
		}
	}
	paper := &Paper{Seed: seed, Order: sortedIDs, Picked: picked, Total: total, TS: time.Now().UnixMilli()}

	// 卷内旧记录：判过分的先归档，再看是否保留「看过解析」标记
	for _, id := range picked {
		raw, ok, err := lockRecord(ctx, tx, prefix, slot, id)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		hasScore := recScore(raw) != nil
		if !hasScore && !hasU(raw) && len(gRaw(raw)) == 0 {
			continue
		}
		if hasScore {
			if err := archiveTx(ctx, tx, prefix, slot, id, raw); err != nil {
				return nil, err
			}
		}
		if v := recViewed(raw); v != 0 {
			rec := Record{U: json.RawMessage("null"), TS: time.Now().UnixMilli(), V: v}
			if err := upsertRecord(ctx, tx, prefix, slot, id, rec); err != nil {
				return nil, err
			}
		} else if _, err := tx.ExecContext(ctx, `DELETE FROM progress WHERE subject=$1 AND user_slot=$2 AND qid=$3`, prefix, slot, id); err != nil {
			return nil, err
		}
	}
	if err := markSeenTx(ctx, tx, prefix, slot, picked); err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(paper)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO papers (subject,user_slot,payload,ts) VALUES ($1,$2,$3,$4)
		ON CONFLICT (subject,user_slot) DO UPDATE SET payload = excluded.payload, ts = excluded.ts`,
		prefix, slot, string(payload), paper.TS); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return paper, nil
}

// ClearPaper 关闭组卷（删除当前卷）。
func (s *Service) ClearPaper(ctx context.Context, prefix, slot string) error {
	if s.Reg.Get(prefix) == nil {
		return ErrNotFound
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := lockSlotTx(ctx, tx, prefix, slot); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM papers WHERE subject=$1 AND user_slot=$2`, prefix, slot); err != nil {
		return err
	}
	return tx.Commit()
}

func filterPool(cfg *subject.Config, records map[int]json.RawMessage, req PaperReq) []*subject.Question {
	chapter := orAll(req.Chapter)
	typ := orAll(req.Type)
	status := orAll(req.Status)
	search := strings.TrimSpace(req.Search)
	out := make([]*subject.Question, 0, len(cfg.Questions))
	for i := range cfg.Questions {
		q := &cfg.Questions[i]
		if chapter != "all" && q.Chapter != chapter {
			continue
		}
		if typ != "all" && q.Type != typ {
			continue
		}
		if search != "" && !strings.Contains(q.Stem, search) && !strings.Contains(q.Ref, search) {
			continue
		}
		if status != "all" {
			s := scoreOf(records[q.ID])
			switch status {
			case "todo":
				if s != nil {
					continue
				}
			case "low":
				if !(s != nil && *s < LowLine) {
					continue
				}
			case "master":
				if !(s != nil && *s >= MasterLine) {
					continue
				}
			}
		}
		out = append(out, q)
	}
	return out
}

func orAll(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return "all"
	}
	return v
}

func typeWeight(t string) float64 {
	switch t {
	case "essay":
		return 3
	case "blank":
		return 2
	default:
		return 1
	}
}

func statusWeight(id int, records map[int]json.RawMessage, seen map[int]int64) float64 {
	rec, hasRec := records[id]
	_, hasSeen := seen[id]
	if !hasRec && !hasSeen {
		return 8 // 从未出现
	}
	if hasRec && recViewed(rec) != 0 {
		return 4
	}
	s := scoreOf(rec)
	if s == nil {
		return 4
	}
	if *s < LowLine {
		return 4
	}
	if *s >= MasterLine {
		return 0.3
	}
	return 1
}

type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func loadRecs(ctx context.Context, db querier, prefix, slot string) (map[int]json.RawMessage, error) {
	out := map[int]json.RawMessage{}
	rows, err := db.QueryContext(ctx, `SELECT qid, rec FROM progress WHERE subject=$1 AND user_slot=$2`, prefix, slot)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		out[id] = json.RawMessage(raw)
	}
	return out, rows.Err()
}

func loadSeen(ctx context.Context, db querier, prefix, slot string) (map[int]int64, error) {
	out := map[int]int64{}
	rows, err := db.QueryContext(ctx, `SELECT qid, seen_at FROM seen WHERE subject=$1 AND user_slot=$2`, prefix, slot)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var at int64
		if err := rows.Scan(&id, &at); err != nil {
			return nil, err
		}
		out[id] = at
	}
	return out, rows.Err()
}

func hasU(rec json.RawMessage) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(rec, &m) != nil {
		return false
	}
	u, ok := m["u"]
	return ok && string(u) != "null"
}

func gRaw(rec json.RawMessage) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(rec, &m) != nil {
		return nil
	}
	return m["g"]
}
