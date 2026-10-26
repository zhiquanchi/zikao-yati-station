// PostgreSQL 存储装配：连接池、goose 迁移、派生行重建。
// 与旧 SQLite 版本的差异：
//   - DSN 走 DATABASE_URL（compose 注入），不再读写本地文件；
//   - 迁移由 embed 的 migrations/*.sql 完成，启动即执行（幂等）；
//   - 连接池可并发，同槽位的「读-合并-写」由 store.go 的事务 + FOR UPDATE 串行化。
package main

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

const (
	dbQueryTimeout   = 5 * time.Second
	dbStartupTimeout = 60 * time.Second
)

type slotStore struct {
	db              *sql.DB
	loginLimiter    *rateLimiter
	registerLimiter *rateLimiter
	mailLimiter     *rateLimiter
	mailer          Mailer
}

func openStore(dsn string) (*slotStore, error) {
	if dsn == "" {
		return nil, fmt.Errorf("缺少 DATABASE_URL（PostgreSQL DSN）")
	}
	ctx, cancel := context.WithTimeout(context.Background(), dbStartupTimeout)
	defer cancel()

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 PostgreSQL：%w", err)
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("连接 PostgreSQL：%w", err)
	}

	goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		db.Close()
		return nil, fmt.Errorf("goose 方言设置：%w", err)
	}
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		db.Close()
		return nil, fmt.Errorf("数据库迁移：%w", err)
	}

	// 派生行表启动全量重建（幂等自愈：行是 blob 的视图，坏了重展开即可）
	if err := rebuildRows(ctx, db); err != nil {
		db.Close()
		return nil, fmt.Errorf("派生行重建：%w", err)
	}
	return &slotStore{
		db:              db,
		loginLimiter:    newRateLimiter(),
		registerLimiter: newRateLimiter(),
		mailLimiter:     newRateLimiter(),
		mailer:          newMailerFromEnv(),
	}, nil
}

// withTimeout：单次数据库操作的超时（请求上下文优先）。
func withTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, dbQueryTimeout)
}