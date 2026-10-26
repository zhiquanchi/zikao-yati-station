// 云同步服务 sync-svc（多用户改造）：作答进度槽位存储，科目无关——subject 由门户路由层从 URL 前缀传入，仅作分区键。
// 路由：GET/PUT /store/<subject>/<user>；/store/<subject>（或 /store/<subject>/）即 user=” 旧版兼容全局槽，
// /store/<subject>/<同步码> 为私有槽；GET /stats/<subject> 内网统计（读派生行表，见 rows.go）。
// 合并/校验/落库见 store.go，跨语言口径由 merge_golden.json 锁定。
// 与判分服务同 module 不同命令：本服务不持 QWEN 密钥、不吃 SUBJECT_DIR；compose 内网 8793、不映射宿主端口。
// 存储为 PostgreSQL（DATABASE_URL），迁移与连接池见 db.go。
// 本地启动：DATABASE_URL='postgres://exam:exam@127.0.0.1:5432/exam?sslmode=disable' go run ./cmd/syncsvc
package main

import (
	"bufio"
	"bytes"
	"context"
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
		ctx, cancel := withTimeout(r.Context())
		defer cancel()
		if err := st.db.PingContext(ctx); err != nil {
			writeJSON(w, 503, map[string]any{"ok": false, "service": "sync-svc", "error": "db_unavailable"})
			return
		}
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
		// 同步必须登录：以会话身份为准，路径 slot 只做一致性校验（防止拿别人的槽位读写）。
		u, err := st.lookupSession(r.Context(), sessionTokenFromRequest(r))
		if err != nil {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		if user != "" && user != u.Slot {
			writeJSON(w, 403, map[string]string{"error": "forbidden_slot"})
			return
		}
		st.handleStore(w, r, subject, u.Slot)
	})
	// 认证端点：门户把 /<prefix>/api/auth/* 纯转发到 /auth/*。
	mux.HandleFunc("POST /auth/register", st.handleRegister)
	mux.HandleFunc("POST /auth/login", st.handleLogin)
	mux.HandleFunc("POST /auth/logout", st.handleLogout)
	mux.HandleFunc("GET /auth/me", st.handleMe)
	mux.HandleFunc("POST /auth/verify-email", st.handleVerifyEmail)
	mux.HandleFunc("POST /auth/request-reset", st.handleRequestReset)
	mux.HandleFunc("POST /auth/reset-password", st.handleResetPassword)
	mux.HandleFunc("POST /auth/resend-verify", st.handleResendVerify)
	// 判分服务内网校验：门户不转发，compose 不映射宿主端口。
	mux.HandleFunc("GET /internal/session", st.handleInternalSession)
	// 统计端点：读派生行表聚合（逐题作答量/平均分/通过率 + 逐用户汇总）。
	// 仅容器内网可达（compose 不映射宿主端口、portal 不转发），站长 ssh 上机 curl 使用。
	mux.HandleFunc("GET /stats/{subject}", func(w http.ResponseWriter, r *http.Request) {
		st.handleStats(w, r, r.PathValue("subject"))
	})
	return mux
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-reset-password" {
		runResetPassword()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "-normalize" {
		runNormalizeStdin()
		return
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatalf("缺少 DATABASE_URL（PostgreSQL DSN），拒绝启动")
	}
	st, err := openStore(dsn)
	if err != nil {
		log.Fatalf("云同步存储初始化失败（拒启）：%v", err)
	}
	if st.mailEnabled() {
		log.Printf("📧 邮件服务已启用（阿里云 DirectMail）")
	} else {
		log.Printf("ℹ 邮件服务未启用（MAIL_DRIVER=none）：验证/找回密码接口返回 503")
	}
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := st.cleanupExpiredSessions(ctx); err != nil {
				log.Printf("清理过期会话失败：%v", err)
			}
			cancel()
		}
	}()
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
	log.Printf("☁️ 云同步服务已启动 http://%s/store/<subject>/<user>（postgres）", addr)
	log.Fatal(srv.ListenAndServe())
}
