// HTTP API v1：同源单域下的唯一边界。路由只做协议与身份解析，
// 业务判断全部在 grading/progress/auth；前端只拿到整形后的结果。
package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"grade-svc/internal/auth"
	"grade-svc/internal/gradeai"
	"grade-svc/internal/progress"
	"grade-svc/internal/store"
	"grade-svc/internal/subject"
)

type Server struct {
	DB                *sql.DB
	Auth              *auth.Service
	Prog              *progress.Service
	Reg               *subject.Registry
	AI                map[string]progress.AIClient
	AllowLegacyImport bool // ALLOW_LEGACY_IMPORT；默认关闭，端点下一次发布删除
}

func New(db *sql.DB, a *auth.Service, p *progress.Service, reg *subject.Registry, ai map[string]progress.AIClient) *Server {
	allow := false
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ALLOW_LEGACY_IMPORT"))) {
	case "1", "true", "yes":
		allow = true
	}
	return &Server{DB: db, Auth: a, Prog: p, Reg: reg, AI: ai, AllowLegacyImport: allow}
}

func (s *Server) Mux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.health)
	mux.HandleFunc("POST /api/v1/auth/guest", s.Auth.HandleGuest)
	mux.HandleFunc("POST /api/v1/auth/register", s.Auth.HandleRegister)
	mux.HandleFunc("POST /api/v1/auth/login", s.Auth.HandleLogin)
	mux.HandleFunc("POST /api/v1/auth/logout", s.Auth.HandleLogout)
	mux.HandleFunc("GET /api/v1/auth/me", s.Auth.HandleMe)
	mux.HandleFunc("POST /api/v1/auth/claim", s.Auth.HandleClaim)
	mux.HandleFunc("POST /api/v1/auth/verify-email", s.Auth.HandleVerifyEmail)
	mux.HandleFunc("POST /api/v1/auth/request-reset", s.Auth.HandleRequestReset)
	mux.HandleFunc("POST /api/v1/auth/reset-password", s.Auth.HandleResetPassword)
	mux.HandleFunc("POST /api/v1/auth/resend-verify", s.Auth.HandleResendVerify)
	mux.HandleFunc("GET /internal/session", s.Auth.InternalSession)

	mux.HandleFunc("GET /api/v1/subjects", s.listSubjects)
	mux.HandleFunc("GET /api/v1/subjects/{prefix}/catalog", s.requireUser(s.catalog))
	mux.HandleFunc("GET /api/v1/subjects/{prefix}/mindmap", s.mindmap)
	mux.HandleFunc("GET /api/v1/subjects/{prefix}/progress", s.requireUser(s.getProgress))
	mux.HandleFunc("POST /api/v1/subjects/{prefix}/answers", s.requireUser(s.submitAnswer))
	mux.HandleFunc("POST /api/v1/subjects/{prefix}/answers/{qid}/redo", s.requireUser(s.redo))
	mux.HandleFunc("POST /api/v1/subjects/{prefix}/seen", s.requireUser(s.markSeen))
	mux.HandleFunc("POST /api/v1/subjects/{prefix}/viewed", s.requireUser(s.markViewed))
	mux.HandleFunc("POST /api/v1/subjects/{prefix}/explain", s.requireUser(s.explain))
	mux.HandleFunc("POST /api/v1/subjects/{prefix}/papers", s.requireUser(s.buildPaper))
	mux.HandleFunc("DELETE /api/v1/subjects/{prefix}/papers", s.requireUser(s.clearPaper))
	mux.HandleFunc("POST /api/v1/subjects/{prefix}/progress/clear", s.requireUser(s.clearProgress))
	mux.HandleFunc("GET /api/v1/subjects/{prefix}/stats", s.requireUser(s.getStats))
	mux.HandleFunc("GET /api/v1/subjects/{prefix}/recite", s.requireUser(s.getRecite))
	mux.HandleFunc("GET /api/v1/subjects/{prefix}/memo", s.requireUser(s.getMemo))
	if s.AllowLegacyImport {
		mux.HandleFunc("POST /api/v1/migrate", s.requireUser(s.migrate))
	}
	return s.middleware(mux)
}

// ——— 顶层中间件：panic 兜底 + 访问日志 ———

var reqSeq uint64

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rid := fmt.Sprintf("%d-%d", start.UnixNano(), atomic.AddUint64(&reqSeq, 1))
		sw := &statusWriter{ResponseWriter: w}
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic req=%s path=%s err=%v", rid, r.URL.Path, rec)
				if sw.status == 0 {
					writeErr(sw, 500, "internal")
				}
			}
			if sw.status == 0 {
				sw.status = 200
			}
			log.Printf("%s %s %d %dB %s req=%s", r.Method, r.URL.Path, sw.status, sw.bytes,
				time.Since(start).Round(time.Millisecond), rid)
		}()
		next.ServeHTTP(sw, r.WithContext(context.WithValue(r.Context(), reqIDKey, rid)))
	})
}

type ctxKey int

const (
	userKey ctxKey = iota + 1
	reqIDKey
)

// ——— 身份中间件 ———

func (s *Server) requireUser(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && !auth.SameOrigin(r) {
			writeErr(w, 403, "bad_origin")
			return
		}
		u, err := s.Auth.Lookup(r.Context(), r)
		if err != nil {
			writeErr(w, 401, "unauthorized")
			return
		}
		ctx := context.WithValue(r.Context(), userKey, u)
		next(w, r.WithContext(ctx))
	}
}

func userOf(r *http.Request) *auth.User {
	u, _ := r.Context().Value(userKey).(*auth.User)
	return u
}

func (s *Server) cfg(w http.ResponseWriter, r *http.Request) *subject.Config {
	prefix := r.PathValue("prefix")
	cfg := s.Reg.Get(prefix)
	if cfg == nil {
		writeErr(w, 404, "unknown_subject")
		return nil
	}
	return cfg
}

// ——— 基础 ———

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	subs := make([]map[string]any, 0, len(s.Reg.List()))
	for _, c := range s.Reg.List() {
		subs = append(subs, map[string]any{"prefix": c.Prefix, "questions": len(c.Questions)})
	}
	aiOn := false
	for _, c := range s.AI {
		if c != nil && c.Enabled() {
			aiOn = true
			break
		}
	}
	out := map[string]any{"ok": true, "service": "apivc", "subjects": len(s.Reg.List()), "subject_list": subs, "ai": aiOn}
	if err := s.DB.PingContext(ctx); err != nil {
		out["ok"] = false
		out["error"] = "db_unavailable"
		writeJSON(w, 503, out)
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) listSubjects(w http.ResponseWriter, r *http.Request) {
	out := make([]map[string]any, 0, len(s.Reg.List()))
	for _, c := range s.Reg.List() {
		out = append(out, map[string]any{
			"prefix": c.Prefix, "label": c.SwitchLabel, "name": c.Name,
			"code": c.Code, "examMonth": c.ExamMonth, "title": c.Title, "pageTitle": c.PageTitle,
			"legacyStorageKey": c.StorageKey,
		})
	}
	writeJSON(w, 200, map[string]any{"subjects": out})
}

// mindmap 下发科目思维导图页（静态 HTML，无需登录，便于直接收藏）。
func (s *Server) mindmap(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	if len(cfg.MindmapHTML) == 0 {
		writeErr(w, 404, "not_found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(cfg.MindmapHTML)
}

func (s *Server) catalog(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	writeJSON(w, 200, map[string]any{
		"title": cfg.Title, "meta": cfg.Meta(), "chapters": cfg.Chapters,
		"questions": cfg.Questions, "memo": json.RawMessage(cfg.Memo),
	})
}

// ——— 进度 ———

func (s *Server) getProgress(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	st, err := s.Prog.Load(r.Context(), cfg.Prefix, userOf(r).Slot)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	writeJSON(w, 200, st)
}

func (s *Server) submitAnswer(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	var req progress.SubmitReq
	if !decodeJSON(w, r, &req, 256<<10) {
		return
	}
	out, err := s.Prog.Submit(r.Context(), cfg.Prefix, userOf(r).Slot, req)
	if err != nil {
		writeProgressErr(w, err)
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) redo(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	qid, err := strconv.Atoi(r.PathValue("qid"))
	if err != nil || qid <= 0 {
		writeErr(w, 400, "bad_qid")
		return
	}
	if err := s.Prog.Redo(r.Context(), cfg.Prefix, userOf(r).Slot, qid); err != nil {
		writeProgressErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) markSeen(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	var req struct {
		QIDs []int `json:"qids"`
	}
	if !decodeJSON(w, r, &req, 32<<10) {
		return
	}
	if len(req.QIDs) > 500 {
		writeErr(w, 400, "too_many_qids")
		return
	}
	if err := s.Prog.MarkSeen(r.Context(), cfg.Prefix, userOf(r).Slot, req.QIDs); err != nil {
		writeProgressErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) markViewed(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	var req struct {
		QID int `json:"qid"`
	}
	if !decodeJSON(w, r, &req, 8<<10) {
		return
	}
	if err := s.Prog.MarkViewed(r.Context(), cfg.Prefix, userOf(r).Slot, req.QID); err != nil {
		writeProgressErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) clearProgress(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	if err := s.Prog.Clear(r.Context(), cfg.Prefix, userOf(r).Slot); err != nil {
		writeProgressErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) buildPaper(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	var req progress.PaperReq
	if !decodeJSON(w, r, &req, 64<<10) {
		return
	}
	paper, err := s.Prog.BuildPaper(r.Context(), cfg.Prefix, userOf(r).Slot, req)
	if err != nil {
		writeProgressErr(w, err)
		return
	}
	writeJSON(w, 200, paper)
}

func (s *Server) clearPaper(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	if err := s.Prog.ClearPaper(r.Context(), cfg.Prefix, userOf(r).Slot); err != nil {
		writeProgressErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) getStats(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	st, err := s.Prog.Load(r.Context(), cfg.Prefix, userOf(r).Slot)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	writeJSON(w, 200, st.Stats)
}

func (s *Server) getRecite(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	st, err := s.Prog.Load(r.Context(), cfg.Prefix, userOf(r).Slot)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	writeJSON(w, 200, progress.BuildRecite(cfg, st.Records))
}

func (s *Server) getMemo(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	st, err := s.Prog.Load(r.Context(), cfg.Prefix, userOf(r).Slot)
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	writeJSON(w, 200, progress.BuildMemo(cfg, st.Records))
}

// ——— 逐项解析 ———

func (s *Server) explain(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg(w, r)
	if cfg == nil {
		return
	}
	var req struct {
		QID    int  `json:"qid"`
		Stream bool `json:"stream"`
	}
	if !decodeJSON(w, r, &req, 32<<10) {
		return
	}
	q := cfg.Question(req.QID)
	if q == nil || q.Type != "single" {
		writeErr(w, 404, "question_not_found")
		return
	}
	client := s.AI[cfg.Prefix]
	if client == nil || !client.Enabled() {
		writeErr(w, 501, "no_key")
		return
	}
	// 持久化缓存：题目内容 + prompt/模型版本一致才复用
	hash := explainHash(cfg.Prefix, q)
	var cached []byte
	err := s.DB.QueryRowContext(r.Context(),
		`SELECT payload FROM explain_cache WHERE subject=$1 AND qid=$2 AND hash=$3`,
		cfg.Prefix, req.QID, hash).Scan(&cached)
	if err == nil && len(cached) > 0 {
		if req.Stream {
			streamExplain(w, json.RawMessage(cached), true)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.Write(cached)
		return
	}

	if !s.Prog.Quota.Allow(userOf(r).Slot) {
		writeErr(w, 429, "too_many_requests")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 85*time.Second)
	defer cancel()
	start := time.Now()
	resp, err := client.Explain(ctx, gradeai.ExplainReq{
		Stem: q.Stem, Ref: q.Ref, Options: optionsOf(q), Answer: q.Answer,
	})
	if err != nil {
		log.Printf("explain 失败 subject=%s qid=%d took=%s err=%v", cfg.Prefix, q.ID, time.Since(start).Round(time.Millisecond), err)
		var se *gradeai.Err
		if errors.As(err, &se) {
			writeErr(w, se.Status, se.Code)
			return
		}
		writeErr(w, 502, "upstream")
		return
	}
	log.Printf("explain 完成 subject=%s qid=%d took=%s source=%s items=%d", cfg.Prefix, q.ID, time.Since(start).Round(time.Millisecond), resp.Source, len(resp.Items))
	if b, err := json.Marshal(resp); err == nil {
		wctx, wcancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, _ = s.DB.ExecContext(wctx,
			`INSERT INTO explain_cache (subject,qid,hash,payload,ts) VALUES ($1,$2,$3,$4,$5)
			 ON CONFLICT (subject,qid,hash) DO UPDATE SET payload=excluded.payload, ts=excluded.ts`,
			cfg.Prefix, q.ID, hash, string(b), time.Now().UnixMilli())
		wcancel()
	}
	if req.Stream {
		b, _ := json.Marshal(resp)
		streamExplain(w, b, false)
		return
	}
	writeJSON(w, 200, resp)
}

// streamExplain 把整包结果按事件协议发出：逐项 delta → done。前端契约与旧 SSE 一致。
func streamExplain(w http.ResponseWriter, payload []byte, cached bool) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	fl, _ := w.(http.Flusher)
	emit := func(event string, data any) bool {
		b, err := json.Marshal(data)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b); err != nil {
			return false
		}
		if fl != nil {
			fl.Flush()
		}
		return true
	}
	var resp gradeai.ExplainResp
	if json.Unmarshal(payload, &resp) != nil {
		emit("error", map[string]string{"error": "parse"})
		return
	}
	if cached {
		resp.Cached = true
	} else {
		for _, it := range resp.Items {
			if !emit("delta", map[string]string{"key": it.Key, "text": it.Why}) {
				return
			}
		}
	}
	emit("done", resp)
}

func optionsOf(q *subject.Question) []gradeai.Opt {
	out := make([]gradeai.Opt, 0, len(q.Options))
	for _, o := range q.Options {
		out = append(out, gradeai.Opt{Key: o.Key, Text: o.Text})
	}
	return out
}

// ——— 旧数据迁移 ———

func (s *Server) migrate(w http.ResponseWriter, r *http.Request) {
	if !s.AllowLegacyImport {
		writeErr(w, 404, "not_found")
		return
	}
	var req struct {
		Subject string          `json:"subject"`
		Blob    json.RawMessage `json:"blob"`
	}
	if !decodeJSON(w, r, &req, 1<<20) {
		return
	}
	if s.Reg.Get(req.Subject) == nil {
		writeErr(w, 404, "unknown_subject")
		return
	}
	// 每个账号只允许导入一次（临时端点，下一次发布删除）
	res, err := s.DB.ExecContext(r.Context(),
		`INSERT INTO legacy_imports (user_id, imported_at) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
		userOf(r).ID, time.Now().UnixMilli())
	if err != nil {
		writeErr(w, 500, "internal")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, 409, "already_imported")
		return
	}
	n, err := store.ImportBlob(r.Context(), s.DB, s.Reg, req.Subject, userOf(r).Slot, req.Blob)
	if err != nil {
		_, _ = s.DB.ExecContext(context.Background(), `DELETE FROM legacy_imports WHERE user_id=$1`, userOf(r).ID)
		writeErr(w, 400, "bad_payload")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "records": n})
}

// ——— 工具 ———

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any, max int64) bool {
	if max <= 0 {
		max = 1 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, max)
	if ct := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))); ct != "" && !strings.HasPrefix(ct, "application/json") {
		writeErr(w, 415, "unsupported_media_type")
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeErr(w, 413, "too_large")
			return false
		}
		writeErr(w, 400, "bad_request")
		return false
	}
	return true
}

// explainPromptVersion：prompt/模型口径变更时递增，使旧解析缓存自然失效。
const explainPromptVersion = "v2"

func explainHash(prefix string, q *subject.Question) string {
	h := sha256.New()
	h.Write([]byte(prefix))
	h.Write([]byte{0})
	h.Write([]byte(q.Stem))
	h.Write([]byte{0})
	for _, o := range q.Options {
		h.Write([]byte(o.Key))
		h.Write([]byte{1})
		h.Write([]byte(o.Text))
		h.Write([]byte{2})
	}
	h.Write([]byte(q.Answer))
	h.Write([]byte{0})
	h.Write([]byte(q.Ref))
	h.Write([]byte{0})
	h.Write([]byte(explainPromptVersion))
	h.Write([]byte{0})
	h.Write([]byte(os.Getenv("QWEN_MODEL")))
	return hex.EncodeToString(h.Sum(nil))
}

func writeProgressErr(w http.ResponseWriter, err error) {
	var se *gradeai.Err
	switch {
	case errors.As(err, &se):
		writeErr(w, se.Status, se.Code)
	case errors.Is(err, progress.ErrNotFound):
		writeErr(w, 404, "question_not_found")
	case errors.Is(err, progress.ErrBadInput):
		writeErr(w, 400, "bad_input")
	case errors.Is(err, progress.ErrNoAI):
		writeErr(w, 501, "no_key")
	case errors.Is(err, progress.ErrEmptyPool):
		writeErr(w, 409, "empty_pool")
	case errors.Is(err, progress.ErrQuota):
		writeErr(w, 429, "too_many_requests")
	default:
		writeErr(w, 500, "internal")
	}
}
