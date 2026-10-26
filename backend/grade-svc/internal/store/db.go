// 数据库装配：PostgreSQL 连接池 + goose 迁移（embed）。v2 只有一套 schema，
// 不再有 blob/派生行双形态；v1 表仅为一次性迁移保留，迁移后删除。
package store

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
	QueryTimeout   = 5 * time.Second
	StartupTimeout = 60 * time.Second
)

func Open(dsn string) (*sql.DB, error) {
	if dsn == "" {
		return nil, fmt.Errorf("缺少 DATABASE_URL（PostgreSQL DSN）")
	}
	ctx, cancel := context.WithTimeout(context.Background(), StartupTimeout)
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
	return db, nil
}

// WithTimeout 单次数据库操作超时（请求上下文优先）。
func WithTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, QueryTimeout)
}
