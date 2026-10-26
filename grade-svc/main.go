// 自考简答 AI 判分服务（Go + OpenAI Go SDK · 千问兼容模式 · qwen3.8-flash），多科目共用同一份源码：
// 科目身份与参考资料经 SUBJECT_DIR 注入（见 subject.go），每科目一个进程/容器，镜像由 grade-svc/Dockerfile 按 --build-arg SUBJECT 组装。
// 默认只绑 127.0.0.1（GRADE_HOST 可改，供容器内使用）；密钥仅存在于本进程环境，前端经 server.js 的 /api/grade 同源代理访问。
// 本地启动：export QWEN_API_KEY=sk-xxx && ./start-ai.sh <科目>（可选 QWEN_MODEL / QWEN_BASE_URL / GRADE_PORT / GRADE_HOST）
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

// explainBudget 按任务类型给整体超时：逐项解析最多两级上游调用，预算更长。
func explainBudget(task string) time.Duration {
	if task == "explain" {
		return 85 * time.Second
	}
	return 70 * time.Second
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, detail string) {
	writeJSON(w, status, map[string]string{"error": code, "detail": detail})
}

// newMux 独立出来以便单测用 httptest 挂载同一套路由。
func newMux(g *grader) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "model": g.model, "has_key": g.apiKey != "",
			"subject": g.subj.Name, "code": g.subj.Code, "has_material": g.subj.reference != ""})
	})
	mux.HandleFunc("POST /api/grade", func(w http.ResponseWriter, r *http.Request) {
		if g.apiKey == "" {
			writeErr(w, 501, "no_key", "未设置 QWEN_API_KEY 环境变量")
			return
		}
		var req GradeReq
		body := io.LimitReader(r.Body, 64<<10)
		if err := json.NewDecoder(body).Decode(&req); err != nil {
			writeErr(w, 400, "bad_request", "请求体不是合法 JSON")
			return
		}
		// 单选逐项解析最多两级上游调用（资料级 + 联网级），整体预算放宽到 85s
		ctx, cancel := context.WithTimeout(r.Context(), explainBudget(req.Task))
		defer cancel()
		if req.Task == "explain" && req.Stream {
			streamExplain(w, g, ctx, req)
			return
		}
		var res any
		var err error
		if req.Task == "explain" {
			start := time.Now() // 失败原因只进容器日志（前端只拿错误码），便于事后定位「点了解析没结果」
			res, err = g.Explain(ctx, req)
			if err != nil {
				log.Printf("explain 失败（%s）：%v", time.Since(start).Round(time.Millisecond), err)
			} else if r, ok := res.(*ExplainResp); ok {
				log.Printf("explain 完成（%s）：source=%s items=%d cached=%v", time.Since(start).Round(time.Millisecond), r.Source, len(r.Items), r.Cached)
			}
		} else {
			res, err = g.Grade(ctx, req)
		}
		if err != nil {
			var se *svcErr
			if errors.As(err, &se) {
				writeErr(w, se.Status, se.Code, se.Detail)
				return
			}
			writeErr(w, 500, "internal", err.Error())
			return
		}
		writeJSON(w, 200, res)
	})
	return mux
}

// streamExplain 以 SSE 应答逐项解析：事件 reason/delta/reset/done/error（见 explain_stream.go）。
// X-Accel-Buffering: no 让线上 nginx 对本响应关缓冲（默认尊重该头，无需改 location 配置）。
// 流头一旦发出状态即 200，此后错误只能走 error 事件；校验类错误（400）也统一以事件表达，
// 前端对 text/event-stream 与非流式 JSON 两种应答同码解析。
func streamExplain(w http.ResponseWriter, g *grader, ctx context.Context, req GradeReq) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	fl, _ := w.(http.Flusher)
	emit := func(event string, data any) error {
		b, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b); err != nil {
			return explErrClient
		}
		if fl != nil {
			fl.Flush()
		}
		return nil
	}
	start := time.Now()
	resp, err := g.ExplainStream(ctx, req, emit)
	if err != nil {
		if errors.Is(err, explErrClient) {
			return // 客户端已断开，无从再写
		}
		log.Printf("explain[stream] 失败（%s）：%v", time.Since(start).Round(time.Millisecond), err)
		var se *svcErr
		if errors.As(err, &se) {
			_ = emit("error", map[string]string{"error": se.Code, "detail": se.Detail})
		} else {
			_ = emit("error", map[string]string{"error": "internal", "detail": err.Error()})
		}
		return
	}
	log.Printf("explain[stream] 完成（%s）：source=%s items=%d cached=%v", time.Since(start).Round(time.Millisecond), resp.Source, len(resp.Items), resp.Cached)
	_ = emit("done", resp)
}

func main() {
	subj, err := loadSubjectConfig(os.Getenv("SUBJECT_DIR"))
	if err != nil {
		log.Fatalf("科目配置加载失败：%v", err)
	}
	g := newGrader(os.Getenv("QWEN_API_KEY"), os.Getenv("QWEN_BASE_URL"), os.Getenv("QWEN_MODEL"), subj)
	port := os.Getenv("GRADE_PORT")
	if port == "" {
		port = "8792" // 容器内统一 8792（compose 不映射宿主端口）；本机各科目端口由 start-ai.sh 按 subject.json 传入
	}
	host := os.Getenv("GRADE_HOST")
	if host == "" {
		host = "127.0.0.1" // 主机直跑仅本机可达；容器内设 0.0.0.0，由编排网络隔离、不映射到宿主机
	}
	addr := host + ":" + port
	guard := newSessionGuard()
	handler := guard.wrap(newMux(g))
	if guard.enabled() {
		log.Printf("🔐 判分鉴权已启用（会话校验：%s）", guard.url)
	} else {
		log.Printf("⚠️ 未配置 AUTH_VERIFY_URL：判分接口不鉴权（仅限本地开发）")
	}
	srv := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	log.Printf("🤖 %s（%s）简答 AI 判分服务已启动 http://%s/api/grade（model=%s, key=%v, 参考资料=%d 字）",
		subj.Name, subj.Code, addr, g.model, g.apiKey != "", len([]rune(subj.reference)))
	log.Fatal(srv.ListenAndServe())
}
