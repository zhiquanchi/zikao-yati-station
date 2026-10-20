// 云同步槽位存储（多用户改造 · Go 端实现）：
// 合并口径与前端 web/sync.js 跨语言两份实现，由 test/fixtures/merge_golden.json 单一夹具逐字段锁定
// （JS 侧 test/merge_xcheck.test.js、Go 侧 store_golden_test.go）——改口径两实现同改后重跑
// scripts/gen-merge-golden.js 刷新夹具，任何单侧漂移必红。
// 槽位 = (subject, user)：user='' 为旧版兼容全局槽（线上存量进度原地续用），其余为同步码私有槽。
// JSON 一律以 json.RawMessage 原文流转：合并不改数格式与键序，返回契约与旧 portal/store.js 逐字段一致。
// 存储双形态：sync 表整 blob 仍是线上协议与合并事实源（旧客户端零破坏）；每次 PUT 合并后
// 同事务把结果展开成逐题行（answers/history/explains，见 rows.go）——派生读模型供统计查询，
// 可随时从 blob 全量重建（启动即重建，自愈）。hist/expl 为 v2 新增上云数据（历史作答/AI 解析缓存）。
package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	_ "modernc.org/sqlite"
)

// maxBody：v2 载荷含 hist（每题≤10 次归档）与 expl（逐题解析缓存）全量，上限放宽到 4MB。
const maxBody = 4 << 20

var (
	userRe    = regexp.MustCompile(`^[a-z2-9]{4,10}$`) // 同步码：去混淆小写字母表由前端签发，服务端只认格式
	subjectRe = regexp.MustCompile(`^[a-z0-9]{1,32}$`)
	idRe      = regexp.MustCompile(`^\d+$`)
)

// ——— JSON 原文判定小工具（模拟 JS 真值/数值语义）———

func isNullRaw(r json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(r), []byte("null"))
}

func isObjectRaw(r json.RawMessage) bool {
	t := bytes.TrimSpace(r)
	return len(t) > 0 && t[0] == '{'
}

func isArrayRaw(r json.RawMessage) bool {
	t := bytes.TrimSpace(r)
	return len(t) > 0 && t[0] == '['
}

// truthyRaw：JS 的 !fa 判据——null/缺字段/false/0/空串为假，对象数组与非空字符串恒真。
func truthyRaw(r json.RawMessage) bool {
	if len(r) == 0 || isNullRaw(r) {
		return false
	}
	t := bytes.TrimSpace(r)
	switch {
	case t[0] == '{' || t[0] == '[':
		return true
	case t[0] == '"':
		return len(t) > 2 // 空串为假，其余字符串为真
	case string(t) == "false":
		return false
	default:
		return numRaw(r) != 0
	}
}

// numRaw：typeof number && Number.isFinite ? v : 0 —— 非数字文本、null、±Inf 一律归 0。
func numRaw(r json.RawMessage) float64 {
	if len(r) == 0 || isNullRaw(r) {
		return 0
	}
	var f float64
	if err := json.Unmarshal(r, &f); err != nil {
		return 0
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return f
}

func isNumberFinite(r json.RawMessage) bool {
	if len(r) == 0 || isNullRaw(r) || r[0] == '"' || r[0] == '{' || r[0] == '[' {
		return false
	}
	var f float64
	if err := json.Unmarshal(r, &f); err != nil {
		return false
	}
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}

// recTs：取记录（或 shuf）的 ts 数值（取不到按 0，与 JS num(rec.ts) 同）。
func recTs(r json.RawMessage) float64 {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(r, &m); err != nil {
		return 0
	}
	return numRaw(m["ts"])
}

// ——— 两端共用的 blob 合并（mergeBlobs 的 Go 移植，逐字段同语义）———

type blobDoc struct {
	store     map[string]json.RawMessage
	shuf      json.RawMessage // 假值（缺/null）归 nil
	clearedAt float64
	hist      map[string]json.RawMessage // v2：qid → 归档数组原文（[{u,s,ts}…]）
	expl      map[string]json.RawMessage // v2：qid → 解析缓存对象原文（{source,items,ts}）
}

func parseBlob(raw []byte) *blobDoc {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil // 数组/标量按无 blob 容错（旧 JS 端 try-catch 同款降级）
	}
	d := &blobDoc{}
	if s, ok := m["store"]; ok && isObjectRaw(s) {
		_ = json.Unmarshal(s, &d.store)
	}
	if sh, ok := m["shuf"]; ok && truthyRaw(sh) {
		d.shuf = sh
	}
	d.clearedAt = numRaw(m["clearedAt"])
	if h, ok := m["hist"]; ok && isObjectRaw(h) {
		_ = json.Unmarshal(h, &d.hist)
	}
	if e, ok := m["expl"]; ok && isObjectRaw(e) {
		_ = json.Unmarshal(e, &d.expl)
	}
	return d
}

type mergedDoc struct {
	Store     map[string]json.RawMessage `json:"store"`
	Shuf      json.RawMessage            `json:"shuf"`
	ClearedAt float64                    `json:"clearedAt"`
	// hist/expl 用指针区分「本就没有该段（旧版载荷，输出整体省略，兼容基线不动）」与「有但合并后为空」
	Hist      *map[string]json.RawMessage `json:"hist,omitempty"`
	Expl      *map[string]json.RawMessage `json:"expl,omitempty"`
	UpdatedAt int64                     `json:"updatedAt"`
}

// histEntry：归档条目取 ts（模拟 JS num(e && e.ts)）。
func histEntryTs(e json.RawMessage) float64 {
	if !isObjectRaw(e) {
		return 0
	}
	return recTs(e)
}

// mergeHist：逐题并集去重（同 ts 先到先得，a 端优先）→ 剔除 ts ≤ clearedAt → 按 ts 升序留最近 10。
// 全被剔除的题不出键（与 JS 端逐字一致）。
func mergeHist(ha, hb map[string]json.RawMessage, cleared float64) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	keys := map[string]bool{}
	for k := range ha {
		keys[k] = true
	}
	for k := range hb {
		keys[k] = true
	}
	for id := range keys {
		seen := map[float64]bool{}
		var list []json.RawMessage
		for _, src := range [2]map[string]json.RawMessage{ha, hb} {
			raw, ok := src[id]
			if !ok || !isArrayRaw(raw) {
				continue
			}
			var entries []json.RawMessage
			if err := json.Unmarshal(raw, &entries); err != nil {
				continue
			}
			for _, e := range entries {
				t := histEntryTs(e)
				if t <= cleared || seen[t] {
					continue
				}
				seen[t] = true
				list = append(list, e)
			}
		}
		if len(list) == 0 {
			continue
		}
		sort.SliceStable(list, func(i, j int) bool { return histEntryTs(list[i]) < histEntryTs(list[j]) })
		if len(list) > 10 {
			list = list[len(list)-10:]
		}
		b, err := json.Marshal(list)
		if err != nil {
			continue
		}
		out[id] = b
	}
	return out
}

// mergeExpl：逐题 ts LWW（rb 严格更新者胜，平手取 a 端——与 store 记录同规则）；不受 clearedAt 压制
// （解析缓存是 AI 输出而非作答，「清空记录」不洗它，与本机行为一致）。
func mergeExpl(ea, eb map[string]json.RawMessage) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for id, ra := range ea {
		out[id] = ra
	}
	for id, rb := range eb {
		ra, dup := out[id]
		if !dup || recTs(rb) > recTs(ra) {
			out[id] = rb
		}
	}
	return out
}

// mergeBlobs：store 逐题比 rec.ts 新者胜；ts ≤ clearedAt（两端取大）一律作废；
// shuf 按 ts 新者胜（假值端取对端，双双假值归 null）；
// hist 逐题并集去重留最近 10（受 clearedAt 压制）；expl 逐题 ts LWW（不受压制）；
// 两端皆无 hist/expl 时输出不含该键（旧版形状逐字节不变）。
func mergeBlobs(a, b *blobDoc, now int64) mergedDoc {
	cleared := 0.0
	if a != nil && a.clearedAt > cleared {
		cleared = a.clearedAt
	}
	if b != nil && b.clearedAt > cleared {
		cleared = b.clearedAt
	}
	var sa, sb map[string]json.RawMessage
	if a != nil {
		sa = a.store
	}
	if b != nil {
		sb = b.store
	}
	store := map[string]json.RawMessage{}
	consider := func(id string, ra, rb json.RawMessage) {
		// 与 JS 逐字对齐：缺端取有端；两端皆有比 ts 新者胜；所选记录一律受 clearedAt 压制
		var rec json.RawMessage
		switch {
		case !truthyRaw(ra):
			rec = rb
		case !truthyRaw(rb):
			rec = ra
		case recTs(rb) > recTs(ra):
			rec = rb
		default:
			rec = ra
		}
		if !truthyRaw(rec) || recTs(rec) <= cleared {
			return
		}
		store[id] = rec
	}
	for id, ra := range sa {
		consider(id, ra, sb[id])
	}
	for id, rb := range sb {
		if _, dup := sa[id]; !dup {
			consider(id, nil, rb)
		}
	}
	var fa, fb json.RawMessage
	if a != nil && truthyRaw(a.shuf) {
		fa = a.shuf
	}
	if b != nil && truthyRaw(b.shuf) {
		fb = b.shuf
	}
	var shuf json.RawMessage
	switch {
	case fa == nil:
		shuf = fb
	case fb == nil:
		shuf = fa
	case recTs(fb) > recTs(fa):
		shuf = fb
	default:
		shuf = fa
	}
	out := mergedDoc{Store: store, Shuf: shuf, ClearedAt: cleared, UpdatedAt: now}
	var ha, hb map[string]json.RawMessage
	if a != nil {
		ha = a.hist
	}
	if b != nil {
		hb = b.hist
	}
	if ha != nil || hb != nil {
		m := mergeHist(ha, hb, cleared)
		out.Hist = &m
	}
	var ea, eb map[string]json.RawMessage
	if a != nil {
		ea = a.expl
	}
	if b != nil {
		eb = b.expl
	}
	if ea != nil || eb != nil {
		m := mergeExpl(ea, eb)
		out.Expl = &m
	}
	return out
}

// ——— 上传载荷整形校验（normalizeIncoming 的 Go 移植，宁拒不收畸形数据）———

type incomingDoc struct {
	store     map[string]json.RawMessage
	shuf      json.RawMessage
	clearedAt float64
	hist      map[string]json.RawMessage
	expl      map[string]json.RawMessage
}

func normalizeIncoming(raw []byte) *incomingDoc {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil // 非对象（数组/标量/坏 JSON 上游已拦）拒收
	}
	sraw, ok := m["store"]
	if !ok || !isObjectRaw(sraw) {
		return nil
	}
	var in map[string]json.RawMessage
	if err := json.Unmarshal(sraw, &in); err != nil {
		return nil
	}
	if len(in) > 5000 {
		return nil
	}
	store := map[string]json.RawMessage{}
	for id, r := range in {
		if !idRe.MatchString(id) || !isObjectRaw(r) {
			return nil
		}
		var rec map[string]json.RawMessage
		if err := json.Unmarshal(r, &rec); err != nil {
			return nil
		}
		if t, ok := rec["ts"]; !ok || !isNumberFinite(t) {
			return nil
		}
		if _, ok := rec["u"]; !ok {
			return nil
		}
		if s, ok := rec["s"]; ok && !isNullRaw(s) && !isNumberFinite(s) {
			return nil
		}
		store[id] = r // v/g 等额外字段原样放行入库
	}
	var shuf json.RawMessage
	if sh, ok := m["shuf"]; ok && isObjectRaw(sh) {
		var s map[string]json.RawMessage
		_ = json.Unmarshal(sh, &s)
		_, hasPicked := s["picked"]
		if hasPicked && isArrayRaw(s["picked"]) {
			shuf = sh // 真实卷
		} else if string(bytes.TrimSpace(s["cleared"])) == "true" && isNumberFinite(s["ts"]) {
			shuf = sh // 「清空组卷」墓碑
		}
	}
	inc := &incomingDoc{store: store, shuf: shuf, clearedAt: numRaw(m["clearedAt"])}
	// hist（v2）：缺省合法（旧客户端）；给出就必须是 {数字键: [{u…,ts 有限数, s 可 null/数}…]}，
	// 逐题超 10 条截新留 10（与合并端一致），规模上限防灌库。
	if h, ok := m["hist"]; ok && !isNullRaw(h) {
		if !isObjectRaw(h) {
			return nil
		}
		var hm map[string]json.RawMessage
		if err := json.Unmarshal(h, &hm); err != nil || len(hm) > 500 {
			return nil
		}
		total := 0
		hist := map[string]json.RawMessage{}
		for id, arr := range hm {
			if !idRe.MatchString(id) || !isArrayRaw(arr) {
				return nil
			}
			var entries []json.RawMessage
			if err := json.Unmarshal(arr, &entries); err != nil {
				return nil
			}
			var kept []json.RawMessage
			for _, e := range entries {
				if !isObjectRaw(e) {
					return nil
				}
				var em map[string]json.RawMessage
				if err := json.Unmarshal(e, &em); err != nil {
					return nil
				}
				if t, ok := em["ts"]; !ok || !isNumberFinite(t) {
					return nil
				}
				if _, ok := em["u"]; !ok {
					return nil
				}
				if s, ok := em["s"]; ok && !isNullRaw(s) && !isNumberFinite(s) {
					return nil
				}
				kept = append(kept, e)
			}
			total += len(kept)
			if total > 5000 {
				return nil
			}
			sort.SliceStable(kept, func(i, j int) bool { return histEntryTs(kept[i]) < histEntryTs(kept[j]) })
			if len(kept) > 10 {
				kept = kept[len(kept)-10:]
			}
			b, err := json.Marshal(kept)
			if err != nil {
				return nil
			}
			hist[id] = b
		}
		inc.hist = hist
	}
	// expl（v2）：{数字键: {items 数组, ts 有限数}}；items 内容是 AI 输出不再深校验，形状过即可。
	if e, ok := m["expl"]; ok && !isNullRaw(e) {
		if !isObjectRaw(e) {
			return nil
		}
		var em map[string]json.RawMessage
		if err := json.Unmarshal(e, &em); err != nil || len(em) > 600 {
			return nil
		}
		expl := map[string]json.RawMessage{}
		for id, v := range em {
			if !idRe.MatchString(id) || !isObjectRaw(v) {
				return nil
			}
			var vm map[string]json.RawMessage
			if err := json.Unmarshal(v, &vm); err != nil {
				return nil
			}
			if !isArrayRaw(vm["items"]) {
				return nil
			}
			if t, ok := vm["ts"]; !ok || !isNumberFinite(t) {
				return nil
			}
			expl[id] = v
		}
		inc.expl = expl
	}
	return inc
}

// ——— SQLite 槽位表（(subject, user) 复合主键；user='' 旧版兼容槽）———

const schemaSQL = `CREATE TABLE sync (subject TEXT NOT NULL, "user" TEXT NOT NULL DEFAULT '', blob TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (subject, "user"));`

type slotStore struct{ db *sql.DB }

func openStore(path string) (*slotStore, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // 单写者收敛：与旧版 bun:sqlite 进程内串行等价，杜绝 SQLITE_BUSY
	if _, err := db.Exec(`PRAGMA journal_mode = WAL;`); err != nil {
		return nil, err
	}
	if err := migrateSlots(db); err != nil {
		db.Close()
		return nil, err
	}
	// 派生行表启动全量重建（幂等自愈：行是 blob 的视图，坏了重展开即可）；失败同样拒启
	if err := rebuildRows(db); err != nil {
		db.Close()
		return nil, err
	}
	return &slotStore{db}, nil
}

// migrateSlots：幂等。缺表建新版；检出旧单槽表（无 user 列）则事务内重建并回填 user=''，
// 迁移失败必须拒启——宁可不服务，也不丢存量进度。
func migrateSlots(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sync'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		_, err := db.Exec(schemaSQL)
		return err
	}
	rows, err := db.Query(`PRAGMA table_info(sync)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	hasUser := false
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == "user" {
			hasUser = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if hasUser {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmts := []string{
		`ALTER TABLE sync RENAME TO sync_legacy_single_slot`,
		schemaSQL,
		`INSERT INTO sync (subject, "user", blob, updated_at) SELECT subject, '', blob, updated_at FROM sync_legacy_single_slot`,
		`DROP TABLE sync_legacy_single_slot`,
	}
	for _, s := range stmts {
		if _, err := tx.Exec(s); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte(`{"error":"internal"}`)
		status = 500
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(b)
}

// handleStore：GET 拉取槽位 blob；PUT 载荷经校验后与库中现值合并落库（服务端为收敛点）并返回合并结果。
// subject/user 已由路由层校验格式。
func (st *slotStore) handleStore(w http.ResponseWriter, r *http.Request, subject, user string) {
	switch r.Method {
	case http.MethodGet:
		st.getSlot(w, subject, user)
		return
	case http.MethodPut:
		st.putSlot(w, r, subject, user)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusMethodNotAllowed)
	io.WriteString(w, "Method Not Allowed")
}

func (st *slotStore) queryBlob(subject, user string) (json.RawMessage, bool) {
	var blob string
	err := st.db.QueryRow(`SELECT blob FROM sync WHERE subject = ? AND "user" = ?`, subject, user).Scan(&blob)
	if err != nil {
		return nil, false
	}
	if !json.Valid([]byte(blob)) {
		return nil, false // 库中坏行按空槽容错（旧 JS 端 try-catch 同语义）
	}
	return json.RawMessage(blob), true
}

func (st *slotStore) getSlot(w http.ResponseWriter, subject, user string) {
	blob, ok := st.queryBlob(subject, user)
	if !ok {
		blob = json.RawMessage("null")
	}
	writeJSON(w, 200, struct {
		Blob json.RawMessage `json:"blob"`
	}{blob})
}

func (st *slotStore) putSlot(w http.ResponseWriter, r *http.Request, subject, user string) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		writeJSON(w, 413, map[string]string{"error": "too_large"})
		return
	}
	if !json.Valid(body) {
		writeJSON(w, 400, map[string]string{"error": "bad_json"})
		return
	}
	inc := normalizeIncoming(body)
	if inc == nil {
		writeJSON(w, 400, map[string]string{"error": "bad_payload"})
		return
	}
	current, ok := st.queryBlob(subject, user)
	var cur *blobDoc
	if ok {
		cur = parseBlob(current)
	}
	merged := mergeBlobs(cur, &blobDoc{store: inc.store, shuf: inc.shuf, clearedAt: inc.clearedAt, hist: inc.hist, expl: inc.expl}, time.Now().UnixMilli())
	blob, err := json.Marshal(merged)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal"})
		return
	}
	// 整 blob（事实源）与逐题行（派生读模型）同事务落库：行永远与 blob 一致
	tx, err := st.db.Begin()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT INTO sync (subject, "user", blob, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(subject, "user") DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
		subject, user, string(blob), merged.UpdatedAt); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	if err := expandSlotRows(tx, subject, user, merged); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	writeJSON(w, 200, struct {
		Blob json.RawMessage `json:"blob"`
	}{json.RawMessage(blob)})
}
