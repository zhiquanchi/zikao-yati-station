// 云同步槽位存储（多用户改造 · Go 端实现）：
// 合并口径与前端 web/sync.js 跨语言两份实现，由 test/fixtures/merge_golden.json 单一夹具逐字段锁定
// （JS 侧 test/merge_xcheck.test.js、Go 侧 store_golden_test.go）——改口径两实现同改后重跑
// scripts/gen-merge-golden.js 刷新夹具，任何单侧漂移必红。
// 槽位 = (subject, user)：user='' 为旧版兼容全局槽（线上存量进度原地续用），其余为同步码私有槽。
// JSON 一律以 json.RawMessage 原文流转：合并不改数格式与键序，返回契约与旧 portal/store.js 逐字段一致。
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
	"time"

	_ "modernc.org/sqlite"
)

const maxBody = 1 << 20 // 1MB 上限（与旧 portal/store.js 同口径）

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
	return d
}

type mergedDoc struct {
	Store     map[string]json.RawMessage `json:"store"`
	Shuf      json.RawMessage            `json:"shuf"`
	ClearedAt float64                    `json:"clearedAt"`
	UpdatedAt int64                      `json:"updatedAt"`
}

// mergeBlobs：store 逐题比 rec.ts 新者胜；ts ≤ clearedAt（两端取大）一律作废；
// shuf 按 ts 新者胜（假值端取对端，双双假值归 null）。
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
	return mergedDoc{Store: store, Shuf: shuf, ClearedAt: cleared, UpdatedAt: now}
}

// ——— 上传载荷整形校验（normalizeIncoming 的 Go 移植，宁拒不收畸形数据）———

type incomingDoc struct {
	store     map[string]json.RawMessage
	shuf      json.RawMessage
	clearedAt float64
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
	return &incomingDoc{store: store, shuf: shuf, clearedAt: numRaw(m["clearedAt"])}
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
	merged := mergeBlobs(cur, &blobDoc{store: inc.store, shuf: inc.shuf, clearedAt: inc.clearedAt}, time.Now().UnixMilli())
	blob, err := json.Marshal(merged)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal"})
		return
	}
	if _, err := st.db.Exec(
		`INSERT INTO sync (subject, "user", blob, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(subject, "user") DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
		subject, user, string(blob), merged.UpdatedAt); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal", "detail": err.Error()})
		return
	}
	writeJSON(w, 200, struct {
		Blob json.RawMessage `json:"blob"`
	}{json.RawMessage(blob)})
}
