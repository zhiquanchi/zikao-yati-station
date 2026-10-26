// apivc：单进程 API 服务（判分 / 逐项解析 / 账号 / 进度 / 组卷 / 统计），所有科目共用。
// 科目配置与题库经 SUBJECTS_DIR 运行时装载，不再按科目构建镜像。
//
// 用法：
//
//	apivc                          # 启动 HTTP 服务
//	apivc -migrate-v1 [-dry-run]   # 一次性迁移旧 sync 整 blob 到 v2 表（完成后删旧表）
//	apivc -reset-password <email>  # 管理员重置密码（新密码从 stdin 读一行）
package main

import (
	"bufio"
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"grade-svc/internal/auth"
	"grade-svc/internal/gradeai"
	"grade-svc/internal/httpapi"
	"grade-svc/internal/progress"
	"grade-svc/internal/store"
	"grade-svc/internal/subject"
)

func main() {
	subjectsDir := os.Getenv("SUBJECTS_DIR")
	if subjectsDir == "" {
		subjectsDir = "subjects"
	}
	reg, err := subject.Load(subjectsDir)
	if err != nil {
		log.Fatalf("科目装载失败（拒启）：%v", err)
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatalf("缺少 DATABASE_URL（PostgreSQL DSN），拒绝启动")
	}
	db, err := store.Open(dsn)
	if err != nil {
		log.Fatalf("数据库初始化失败（拒启）：%v", err)
	}
	defer db.Close()

	switch {
	case len(os.Args) > 1 && os.Args[1] == "-migrate-v1":
		dry := len(os.Args) > 2 && os.Args[2] == "-dry-run"
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		rep, err := store.MigrateV1(ctx, db, reg, dry)
		if err != nil {
			log.Fatalf("v1 迁移失败：%v", err)
		}
		log.Printf("✅ v1 迁移完成：槽位 %d、记录 %d、历史 %d、卷面 %d、drop旧表=%v、dry-run=%v",
			rep.Slots, rep.Records, rep.Histories, rep.Papers, rep.Dropped, rep.DryRun)
		return
	case len(os.Args) > 1 && os.Args[1] == "-reset-password":
		if len(os.Args) < 3 {
			log.Fatalf("用法：apivc -reset-password <email>（新密码从 stdin 读一行）")
		}
		sc := bufio.NewScanner(os.Stdin)
		if !sc.Scan() {
			log.Fatalf("未从 stdin 读到新密码")
		}
		svc := auth.New(db)
		if err := svc.ResetPassword(strings.ToLower(strings.TrimSpace(os.Args[2])), strings.TrimRight(sc.Text(), "\r\n")); err != nil {
			log.Fatalf("重置密码失败：%v", err)
		}
		log.Print("密码已重置，现有会话已全部失效")
		return
	}

	apiKey := os.Getenv("QWEN_API_KEY")
	baseURL := os.Getenv("QWEN_BASE_URL")
	model := os.Getenv("QWEN_MODEL")
	ai := make(map[string]*gradeai.Client, len(reg.List()))
	for _, c := range reg.List() {
		ai[c.Prefix] = gradeai.New(apiKey, baseURL, model, gradeai.Subject{
			Name: c.Name, Code: c.Code, MaterialTitle: c.Material, Reference: c.Reference,
		})
	}

	authSvc := auth.New(db)
	progSvc := &progress.Service{DB: db, Reg: reg, AI: ai}
	srv := httpapi.New(db, authSvc, progSvc, reg, ai)

	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for range t.C {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := authSvc.CleanupExpiredSessions(ctx); err != nil {
				log.Printf("清理过期会话失败：%v", err)
			}
			cancel()
		}
	}()

	host := os.Getenv("API_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("API_PORT")
	if port == "" {
		port = "8793"
	}
	addr := host + ":" + port
	s := &http.Server{Addr: addr, Handler: srv.Mux(), ReadHeaderTimeout: 5 * time.Second}
	log.Printf("🚀 API 服务已启动 http://%s/api/v1（科目 %d 个，AI=%v）", addr, len(reg.List()), apiKey != "")
	log.Fatal(s.ListenAndServe())
}
