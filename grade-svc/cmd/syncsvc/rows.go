// 派生行模型（v2）：整 blob 仍是合并事实源，本文件把每次合并结果展开成逐题行——
// answers（当前记录，含墓碑列形）、history（逐次归档）、explains（AI 解析缓存），
// 供 /stats 直接 SQL 聚合；行表可随时从 sync 表全量重建（启动即重建，自愈），不做反向同步。
package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
)

const rowsSchema = `
CREATE TABLE IF NOT EXISTS answers (
  subject TEXT NOT NULL, "user" TEXT NOT NULL DEFAULT '', qid INTEGER NOT NULL,
  u_json TEXT, s REAL, v REAL, g_score REAL, ts INTEGER NOT NULL, rec TEXT NOT NULL,
  PRIMARY KEY (subject, "user", qid));
CREATE TABLE IF NOT EXISTS history (
  subject TEXT NOT NULL, "user" TEXT NOT NULL DEFAULT '', qid INTEGER NOT NULL, ts INTEGER NOT NULL,
  u_json TEXT, s REAL,
  PRIMARY KEY (subject, "user", qid, ts));
CREATE TABLE IF NOT EXISTS explains (
  subject TEXT NOT NULL, "user" TEXT NOT NULL DEFAULT '', qid INTEGER NOT NULL, ts INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (subject, "user", qid));`

// ensureRows 建表（幂等）。
func ensureRows(db *sql.DB) error {
	_, err := db.Exec(rowsSchema)
	return err
}

// numOrNull / rawOrNull：列提取的缺省语义——字段缺失或非数值按 NULL（统计端按 NULL 剔除）。
func numOrNull(m map[string]json.RawMessage, key string) any {
	r, ok := m[key]
	if !ok || isNullRaw(r) || !isNumberFinite(r) {
		return nil
	}
	return numRaw(r)
}

func rawOrNull(m map[string]json.RawMessage, key string) any {
	r, ok := m[key]
	if !ok || isNullRaw(r) {
		return nil
	}
	return string(r) // u 原文（字符串/数组/对象皆可），统计只判 NULL/非 NULL
}

// expandSlotRows：删旧行＋按合并结果重插（与 sync 表 upsert 同事务）。
// 行展开是派生视图：单条畸形（qid 非数字等）跳过该行、不阻断落库——blob 侧 normalize 已把关，
// 这里只防历史库里的意外。
func expandSlotRows(tx *sql.Tx, subject, user string, merged mergedDoc) error {
	for _, t := range []string{"answers", "history", "explains"} {
		if _, err := tx.Exec(`DELETE FROM `+t+` WHERE subject = ? AND "user" = ?`, subject, user); err != nil {
			return err
		}
	}
	for id, rec := range merged.Store {
		qid, err := strconv.ParseInt(id, 10, 64)
		if err != nil {
			continue
		}
		var m map[string]json.RawMessage
		if json.Unmarshal(rec, &m) != nil {
			continue
		}
		var gScore any
		if g, ok := m["g"]; ok && isObjectRaw(g) {
			var gm map[string]json.RawMessage
			if json.Unmarshal(g, &gm) == nil {
				gScore = numOrNull(gm, "score")
			}
		}
		if _, err := tx.Exec(
			`INSERT INTO answers (subject, "user", qid, u_json, s, v, g_score, ts, rec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			subject, user, qid, rawOrNull(m, "u"), numOrNull(m, "s"), numOrNull(m, "v"), gScore, int64(numRaw(m["ts"])), string(rec)); err != nil {
			return err
		}
	}
	if merged.Hist != nil {
		for id, arr := range *merged.Hist {
			qid, err := strconv.ParseInt(id, 10, 64)
			if err != nil {
				continue
			}
			var entries []json.RawMessage
			if json.Unmarshal(arr, &entries) != nil {
				continue
			}
			for _, e := range entries {
				var em map[string]json.RawMessage
				if json.Unmarshal(e, &em) != nil {
					continue
				}
				if _, err := tx.Exec(
					`INSERT OR REPLACE INTO history (subject, "user", qid, ts, u_json, s) VALUES (?, ?, ?, ?, ?, ?)`,
					subject, user, qid, int64(numRaw(em["ts"])), rawOrNull(em, "u"), numOrNull(em, "s")); err != nil {
					return err
				}
			}
		}
	}
	if merged.Expl != nil {
		for id, v := range *merged.Expl {
			qid, err := strconv.ParseInt(id, 10, 64)
			if err != nil {
				continue
			}
			if _, err := tx.Exec(
				`INSERT OR REPLACE INTO explains (subject, "user", qid, ts, payload) VALUES (?, ?, ?, ?, ?)`,
				subject, user, qid, int64(recTs(v)), string(v)); err != nil {
				return err
			}
		}
	}
	return nil
}

// rebuildRows：启动全量重建派生行（幂等）。存量库首次升级即在此完成 blob→行 的迁移。
func rebuildRows(db *sql.DB) error {
	if err := ensureRows(db); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, t := range []string{"answers", "history", "explains"} {
		if _, err := tx.Exec(`DELETE FROM ` + t); err != nil {
			return err
		}
	}
	rows, err := tx.Query(`SELECT subject, "user", blob FROM sync`)
	if err != nil {
		return err
	}
	type slotRow struct{ subject, user, blob string }
	var slots []slotRow
	for rows.Next() {
		var s slotRow
		if err := rows.Scan(&s.subject, &s.user, &s.blob); err != nil {
			rows.Close()
			return err
		}
		slots = append(slots, s)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, s := range slots {
		var merged mergedDoc
		if json.Unmarshal([]byte(s.blob), &merged) != nil {
			continue // 坏 blob 行跳过（GET 侧同语义按空槽容错）
		}
		if err := expandSlotRows(tx, s.subject, s.user, merged); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ——— /stats/<subject>：内网统计端点（读派生行，portal 不转发）———

type statQuestion struct {
	Qid      int64   `json:"qid"`
	Total    int     `json:"total"`    // 有记录数（含墓碑外的一切）
	Answered int     `json:"answered"` // 实际作答过（u 非空）
	Avg      *float64 `json:"avg"`     // 平均分（s 非空者）
	Pass     int     `json:"pass"`     // ≥60
	Mastered int     `json:"mastered"` // ≥80
}

type statUser struct {
	User     string   `json:"user"`
	Answered int      `json:"answered"`
	Avg      *float64 `json:"avg"`
	Mastered int      `json:"mastered"`
}

func (st *slotStore) handleStats(w http.ResponseWriter, subject string) {
	if subject == "" || !subjectRe.MatchString(subject) {
		writeJSON(w, 404, map[string]string{"error": "bad_subject"})
		return
	}
	qs := []statQuestion{}
	rows, err := st.db.Query(`SELECT qid, COUNT(*), SUM(CASE WHEN u_json IS NOT NULL THEN 1 ELSE 0 END),
		AVG(s), SUM(CASE WHEN s >= 60 THEN 1 ELSE 0 END), SUM(CASE WHEN s >= 80 THEN 1 ELSE 0 END)
		FROM answers WHERE subject = ? GROUP BY qid ORDER BY qid`, subject)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	for rows.Next() {
		var q statQuestion
		var avg sql.NullFloat64
		var pass, mastered int
		if err := rows.Scan(&q.Qid, &q.Total, &q.Answered, &avg, &pass, &mastered); err != nil {
			continue
		}
		q.Pass, q.Mastered = pass, mastered
		if avg.Valid {
			v := avg.Float64
			q.Avg = &v
		}
		qs = append(qs, q)
	}
	rows.Close()
	us := []statUser{}
	rows2, err := st.db.Query(`SELECT "user", SUM(CASE WHEN u_json IS NOT NULL THEN 1 ELSE 0 END),
		AVG(s), COUNT(DISTINCT CASE WHEN s >= 80 THEN qid END)
		FROM answers WHERE subject = ? GROUP BY "user" ORDER BY "user"`, subject)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	for rows2.Next() {
		var u statUser
		var avg sql.NullFloat64
		if err := rows2.Scan(&u.User, &u.Answered, &avg, &u.Mastered); err != nil {
			continue
		}
		if avg.Valid {
			v := avg.Float64
			u.Avg = &v
		}
		us = append(us, u)
	}
	rows2.Close()
	writeJSON(w, 200, map[string]any{"subject": subject, "questions": qs, "users": us})
}
