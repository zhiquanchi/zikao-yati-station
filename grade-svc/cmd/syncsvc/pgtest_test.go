// 测试库 helper：从 TEST_DATABASE_URL 派生独立 schema，避免用例之间互相污染。
// 未设置环境变量时整组 DB 测试跳过（提示先起 PostgreSQL）；见 scripts/test-pg.sh。
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// testDSN：创建一个随机 schema 并把 search_path 指过去，返回可直接交给 openStore 的 DSN。
func testDSN(t *testing.T) string {
	t.Helper()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		t.Skip("未设置 TEST_DATABASE_URL：先运行 scripts/test-pg.sh，或手动起 PostgreSQL 并导出该变量")
	}
	schema := fmt.Sprintf("test_%d_%d", time.Now().UnixNano(), os.Getpid())

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatalf("连接测试库：%v", err)
	}
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("创建测试 schema：%v", err)
	}
	admin.Close()

	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		db, err := sql.Open("pgx", base)
		if err != nil {
			return
		}
		defer db.Close()
		db.ExecContext(ctx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
	})
	return withSearchPath(base, schema)
}

func withSearchPath(dsn, schema string) string {
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	return dsn + sep + "search_path=" + schema
}