// subject.go 科目配置装载单测：fixture 目录验证 subject.json 解析与参考资料探测；
// 并加载真实 subjects/os13180/，锁定「仓库参考资料已就位」这条生产依赖。
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadSubjectConfigFixture(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "subject.json"),
		`{"prefix":"tst","code":"99999","name":"测试科目","grade":{"materialTitle":"测试考点串讲"}}`)
	writeFile(t, filepath.Join(dir, "grade", "reference.md"), "测试参考资料全文")
	s, err := loadSubjectConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "测试科目" || s.Code != "99999" || s.MaterialTitle != "测试考点串讲" {
		t.Errorf("字段解析不符：%+v", s)
	}
	if s.reference != "测试参考资料全文" {
		t.Errorf("应读到 grade/reference.md，实际 %q", s.reference)
	}
}

func TestLoadSubjectConfigNoDirAndMissingName(t *testing.T) {
	if _, err := loadSubjectConfig(""); err == nil {
		t.Error("无 SUBJECT_DIR 应拒启")
	}
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "subject.json"), `{"prefix":"x","code":"1"}`)
	if _, err := loadSubjectConfig(dir); err == nil {
		t.Error("subject.json 缺 name 应报错")
	}
	// 无参考资料：reference 为空，explain 将直接走联网级
	writeFile(t, filepath.Join(dir, "subject.json"), `{"name":"空资料科目"}`)
	s, err := loadSubjectConfig(dir)
	if err != nil || s.reference != "" {
		t.Errorf("无 reference.md 应装载成功且资料为空：%v %+v", err, s)
	}
	// 直挂 reference.md（容器暂存形态）同样可被探测
	writeFile(t, filepath.Join(dir, "reference.md"), "  \n") // 纯空白视为无资料
	if s, err := loadSubjectConfig(dir); err != nil || s.reference != "" {
		t.Errorf("空白 reference.md 应视为无资料：%v", err)
	}
}

// 真实仓库科目：os13180 的参考资料必须就位且够分量（原 go:embed 校验的替代）。
func TestRealSubjectOs(t *testing.T) {
	s, err := loadSubjectConfig(filepath.Join("..", "subjects", "os13180"))
	if err != nil {
		t.Fatal(err)
	}
	if s.Prefix != "os" || s.Code != "13180" || s.Name != "操作系统" {
		t.Errorf("os13180 身份不符：%+v", s)
	}
	if len([]rune(s.reference)) < 1000 || !strings.Contains(s.reference, "操作系统") {
		t.Errorf("os13180 参考资料缺失或过短，长度=%d", len([]rune(s.reference)))
	}
}
