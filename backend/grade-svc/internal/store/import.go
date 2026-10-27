// 浏览器旧 localStorage（v1 blob 形状）一次性导入：前端在首次加载时把旧键整包 POST 上来，
// 服务端重算单选/填空分数后写入当前账号（或游客）槽位，前端随后删除旧键。
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"grade-svc/internal/subject"
)

// ImportBlob 把单个科目的 v1 blob 导入指定槽位；返回写入的记录数。
func ImportBlob(ctx context.Context, db *sql.DB, reg *subject.Registry, prefix, slot string, raw []byte) (int, error) {
	cfg := reg.Get(prefix)
	if cfg == nil {
		return 0, fmt.Errorf("未知科目：%s", prefix)
	}
	var blob v1Blob
	if err := json.Unmarshal(raw, &blob); err != nil {
		return 0, fmt.Errorf("旧数据不是合法 JSON")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	n := 0
	for id, recRaw := range blob.Store {
		var qid int
		if _, err := fmt.Sscanf(id, "%d", &qid); err != nil || qid <= 0 {
			continue
		}
		q := cfg.Question(qid)
		if q == nil {
			continue // 未知题号一律丢弃，避免写入任意行
		}
		var rec map[string]json.RawMessage
		if err := json.Unmarshal(recRaw, &rec); err != nil {
			continue
		}
		if u, ok := rec["u"]; !ok || isNull(u) {
			continue
		}
		if s, ok := rescore(q, rec["u"]); ok {
			rec["s"] = jsonNumber(s)
		}
		out, err := json.Marshal(rec)
		if err != nil {
			continue
		}
		ts := int64(numRaw(rec["ts"]))
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO progress (subject,user_slot,qid,rec,ts) VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (subject,user_slot,qid) DO UPDATE
			SET rec = CASE WHEN excluded.ts > progress.ts THEN excluded.rec ELSE progress.rec END,
			    ts = GREATEST(progress.ts, excluded.ts)`,
			prefix, slot, qid, string(out), ts); err != nil {
			return n, err
		}
		n++
	}
	for id, arrRaw := range blob.Hist {
		var qid int
		if _, err := fmt.Sscanf(id, "%d", &qid); err != nil {
			continue
		}
		var entries []json.RawMessage
		if json.Unmarshal(arrRaw, &entries) != nil {
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
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO histories (subject,user_slot,qid,ts,rec) VALUES ($1,$2,$3,$4,$5)
				ON CONFLICT DO NOTHING`, prefix, slot, qid, ts, string(e)); err != nil {
				return n, err
			}
		}
	}
	if len(blob.Shuf) > 0 {
		var sm map[string]json.RawMessage
		if json.Unmarshal(blob.Shuf, &sm) == nil && !isNull(sm["picked"]) {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO papers (subject,user_slot,payload,ts) VALUES ($1,$2,$3,$4)
				ON CONFLICT (subject,user_slot) DO UPDATE SET payload=excluded.payload, ts=excluded.ts`,
				prefix, slot, string(blob.Shuf), int64(numRaw(sm["ts"]))); err != nil {
				return n, err
			}
		}
	}
	if blob.ClearedAt > 0 {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO cleared (subject,user_slot,cleared_at) VALUES ($1,$2,$3)
			ON CONFLICT (subject,user_slot) DO UPDATE SET cleared_at=GREATEST(cleared.cleared_at, excluded.cleared_at)`,
			prefix, slot, int64(blob.ClearedAt)); err != nil {
			return n, err
		}
	}
	// 注意：旧 blob 的 expl 段不再导入——解析缓存由服务端重新生成，避免旧形状污染全局缓存。
	return n, tx.Commit()
}
