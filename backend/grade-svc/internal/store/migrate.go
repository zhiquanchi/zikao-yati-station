// 一次性 v1→v2 数据迁移（无兼容层）：把旧 sync 整 blob 展开成 v2 逐题表，
// 单选/填空用新判分引擎重算分数，完成后删除 v1 表（sync/answers/history/explains）。
// 只迁移能对应到 users.slot 的槽位；旧版空槽 ” 与未登录时期的匿名码槽不再保留（其数据靠浏览器迁移）。
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"grade-svc/internal/grading"
	"grade-svc/internal/subject"
)

type MigrateReport struct {
	Slots     int
	Records   int
	Histories int
	Papers    int
	Dropped   bool
	DryRun    bool
}

type v1Blob struct {
	Store     map[string]json.RawMessage `json:"store"`
	Shuf      json.RawMessage            `json:"shuf"`
	ClearedAt float64                    `json:"clearedAt"`
	Hist      map[string]json.RawMessage `json:"hist"`
	Expl      map[string]json.RawMessage `json:"expl"`
}

// MigrateV1 执行迁移。dryRun=true 只统计不写库。
func MigrateV1(ctx context.Context, db *sql.DB, reg *subject.Registry, dryRun bool) (MigrateReport, error) {
	var rep MigrateReport
	rep.DryRun = dryRun
	var hasSync sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT to_regclass('sync')::text`).Scan(&hasSync); err != nil {
		return rep, fmt.Errorf("检测 v1 表：%w", err)
	}
	if !hasSync.Valid || hasSync.String == "" {
		return rep, nil // 全新库：没有可迁移数据
	}

	rows, err := db.QueryContext(ctx, `SELECT subject, user_slot, blob FROM sync ORDER BY subject, user_slot`)
	if err != nil {
		return rep, fmt.Errorf("读取 v1 sync：%w", err)
	}
	type row struct{ subject, slot, blob string }
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.subject, &r.slot, &r.blob); err != nil {
			rows.Close()
			return rep, err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return rep, err
	}
	rows.Close()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return rep, err
	}
	defer tx.Rollback()

	for _, r := range all {
		if r.slot == "" {
			continue // 旧版全局槽：无归属账号
		}
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE slot = $1)`, r.slot).Scan(&exists); err != nil {
			return rep, err
		}
		if !exists {
			continue // 旧匿名码槽：无账号可归属
		}
		var blob v1Blob
		if err := json.Unmarshal([]byte(r.blob), &blob); err != nil {
			continue // 坏行跳过（与旧 GET 容错一致）
		}
		cfg := reg.Get(r.subject)
		rep.Slots++

		for id, raw := range blob.Store {
			var qid int
			if _, err := fmt.Sscanf(id, "%d", &qid); err != nil || qid <= 0 {
				continue
			}
			if cfg == nil || cfg.Question(qid) == nil {
				continue // 题库已不存在的题号丢弃
			}
			var rec map[string]json.RawMessage
			if err := json.Unmarshal(raw, &rec); err != nil {
				continue
			}
			if u, ok := rec["u"]; !ok || isNull(u) {
				continue // 墓碑
			}
			if cfg != nil {
				if q := cfg.Question(qid); q != nil {
					if s, ok := rescore(q, rec["u"]); ok {
						rec["s"] = jsonNumber(s)
					}
				}
			}
			out, err := json.Marshal(rec)
			if err != nil {
				continue
			}
			ts := int64(numRaw(rec["ts"]))
			if !dryRun {
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO progress (subject, user_slot, qid, rec, seen_at, ts)
					VALUES ($1,$2,$3,$4,NULL,$5)
					ON CONFLICT (subject,user_slot,qid) DO UPDATE SET rec = excluded.rec, ts = excluded.ts`,
					r.subject, r.slot, qid, string(out), ts); err != nil {
					return rep, err
				}
			}
			rep.Records++
		}

		for id, raw := range blob.Hist {
			var qid int
			if _, err := fmt.Sscanf(id, "%d", &qid); err != nil {
				continue
			}
			var entries []json.RawMessage
			if json.Unmarshal(raw, &entries) != nil {
				continue
			}
			for _, e := range entries {
				var em map[string]json.RawMessage
				if json.Unmarshal(e, &em) != nil {
					continue
				}
				ts := int64(numRaw(em["ts"]))
				if ts <= int64(blob.ClearedAt) {
					continue
				}
				if !dryRun {
					if _, err := tx.ExecContext(ctx, `
						INSERT INTO histories (subject,user_slot,qid,ts,rec) VALUES ($1,$2,$3,$4,$5)
						ON CONFLICT (subject,user_slot,qid,ts) DO UPDATE SET rec = excluded.rec`,
						r.subject, r.slot, qid, ts, string(e)); err != nil {
						return rep, err
					}
				}
				rep.Histories++
			}
		}

		if len(blob.Shuf) > 0 && !isNull(blob.Shuf) && numRaw(blob.Shuf) == 0 {
			// 只接受带 picked 的真实卷；cleared 墓碑不入 v2
			var sm map[string]json.RawMessage
			if json.Unmarshal(blob.Shuf, &sm) == nil {
				if picked, ok := sm["picked"]; ok && !isNull(picked) {
					if !dryRun {
						if _, err := tx.ExecContext(ctx, `
							INSERT INTO papers (subject,user_slot,payload,ts) VALUES ($1,$2,$3,$4)
							ON CONFLICT (subject,user_slot) DO UPDATE SET payload = excluded.payload, ts = excluded.ts`,
							r.subject, r.slot, string(blob.Shuf), int64(numRaw(sm["ts"]))); err != nil {
							return rep, err
						}
					}
					rep.Papers++
				}
			}
		}
		if blob.ClearedAt > 0 && !dryRun {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO cleared (subject,user_slot,cleared_at) VALUES ($1,$2,$3)
				ON CONFLICT (subject,user_slot) DO UPDATE SET cleared_at = GREATEST(cleared.cleared_at, excluded.cleared_at)`,
				r.subject, r.slot, int64(blob.ClearedAt)); err != nil {
				return rep, err
			}
		}
		// 旧解析缓存不迁移：由服务端按当前 prompt 重新生成。
	}

	if !dryRun {
		// 无兼容层：迁移完成后直接删除 v1 表。
		if _, err := tx.ExecContext(ctx, `DROP TABLE IF EXISTS sync, answers, history, explains`); err != nil {
			return rep, err
		}
		rep.Dropped = true
	}
	if err := tx.Commit(); err != nil {
		return rep, err
	}
	return rep, nil
}

func rescore(q *subject.Question, u json.RawMessage) (int, bool) {
	switch q.Type {
	case "single":
		var s string
		if json.Unmarshal(u, &s) != nil {
			return 0, false
		}
		return grading.GradeSingle(s, q.Answer).Score, true
	case "blank":
		var in []string
		if json.Unmarshal(u, &in) != nil {
			return 0, false
		}
		return grading.GradeBlanks(in, q.Blanks, q.Unordered, q.Fallback).Score, true
	}
	return 0, false
}

func isNull(r json.RawMessage) bool { return len(r) == 0 || string(r) == "null" }

func numRaw(r json.RawMessage) float64 {
	var f float64
	if len(r) == 0 || json.Unmarshal(r, &f) != nil {
		return 0
	}
	return f
}

func jsonNumber(n int) json.RawMessage {
	b, _ := json.Marshal(n)
	return b
}
