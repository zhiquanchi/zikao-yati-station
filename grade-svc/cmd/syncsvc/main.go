// 云同步服务 sync-svc（多用户改造）：作答进度槽位存储，科目无关——subject 由门户路由层从 URL 前缀传入，仅作分区键。
// 路由：GET/PUT /store/<subject>/<user>；/store/<subject>（或 /store/<subject>/）即 user=” 旧版兼容全局槽，
// /store/<subject>/<同步码> 为私有槽；GET /stats/<subject> 内网统计（读派生行表，见 rows.go）。
// 合并/校验/落库见 store.go，跨语言口径由 merge_golden.json 锁定。
// 与判分服务同 module 不同命令：本服务不持密钥、不吃 SUBJECT_DIR；compose 内网 8793、不映射宿主端口。
// 本地启动：STORE_DB=/tmp/sync.db go run ./cmd/syncsvc（默认 STORE_DB=/data/sync.db 为容器路径）。
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// normalizeOut：incomingDoc 的对外序列化形状（与旧 portal/store.js 的 normalizeIncoming 返回值同构）。
// hist/expl 为 v2 新增段：载荷没给就不出键（旧版形状逐字节不变），给了给合并端处理。
type normalizeOut struct {
	Store     map[string]json.RawMessage  `json:"store"`
	Shuf      json.RawMessage             `json:"shuf"`
	ClearedAt float64                     `json:"clearedAt"`
	Hist      map[string]json.RawMessage  `json:"hist,omitempty"`
	Expl      map[string]json.RawMessage  `json:"expl,omitempty"`
}

// runNormalizeStdin 批量整形模式（syncsvc -normalize）：每行一个 PUT 载荷 JSON，
// 每行输出 normalizeIncoming 结果（拒收输出 null）。供 scripts/gen-merge-golden.js 刷新
// golden 夹具的载荷契约段——normalize 的权威实现自此只存 Go 一份。
func runNormalizeStdin() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for in.Scan() {
		line := in.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		res := normalizeIncoming(line)
		if res == nil {
			fmt.Fprintln(out, "null")
			continue
		}
		b, err := json.Marshal(normalizeOut{Store: res.store, Shuf: res.shuf, ClearedAt: res.clearedAt, Hist: res.hist, Expl: res.expl})
		if err != nil || !json.Valid(b) {
			fmt.Fprintln(out, "null")
			continue
		}
		out.Write(b)
		out.WriteByte('\n')
	}
	if err := in.Err(); err != nil {
		log.Fatalf("stdin 读取失败：%v", err)
	}
}

func newSyncMux(st *slotStore) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": "sync-svc"})
	})
	mux.HandleFunc("/store/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/store/")
		subject, user := rest, ""
		if i := strings.IndexByte(rest, '/'); i >= 0 {
			subject, user = rest[:i], rest[i+1:]
		}
		if subject == "" || !subjectRe.MatchString(subject) {
			writeJSON(w, 404, map[string]string{"error": "bad_subject"})
			return
		}
		if user != "" && !userRe.MatchString(user) {
			writeJSON(w, 400, map[string]string{"error": "bad_user"})
			return
		}
		st.handleStore(w, r, subject, user)
	})
	// 统计端点：读派生行表聚合（逐题作答量/平均分/通过率 + 逐用户汇总）。
	// 仅容器内网可达（compose 不映射宿主端口、portal 不转发），站长 ssh 上机 curl 使用。
	mux.HandleFunc("GET /stats/{subject}", func(w http.ResponseWriter, r *http.Request) {
		st.handleStats(w, r.PathValue("subject"))
	})
	return mux
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-normalize" {
		runNormalizeStdin()
		return
	}
	dbPath := os.Getenv("STORE_DB")
	if dbPath == "" {
		dbPath = "/data/sync.db" // 线上命名卷 portal-store 原地复用（旧版数据零搬迁）
	}
	st, err := openStore(dbPath)
	if err != nil {
		log.Fatalf("云同步存储初始化失败（拒启）：%v", err)
	}
	host := os.Getenv("SYNC_HOST")
	if host == "" {
		host = "127.0.0.1" // 主机直跑仅本机可达；容器内由 Dockerfile 设 0.0.0.0，编排网络隔离
	}
	port := os.Getenv("SYNC_PORT")
	if port == "" {
		port = "8793"
	}
	addr := host + ":" + port
	srv := &http.Server{Addr: addr, Handler: newSyncMux(st), ReadHeaderTimeout: 5 * time.Second}
	log.Printf("☁️ 云同步服务已启动 http://%s/store/<subject>/<user>（db=%s）", addr, dbPath)
	log.Fatal(srv.ListenAndServe())
}
