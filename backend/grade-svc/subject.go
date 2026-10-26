// 科目身份注入：判分服务的科目名、逐项解析参考资料均来自 SUBJECT_DIR 指向的科目目录。
//   · 生产：容器内 /app/subject/（backend/grade-svc/Dockerfile 按 --build-arg SUBJECT 从仓库 subjects/<科目>/ 暂存：
//     subject.json + 可选 reference.md）
//   · 本地：./start-ai.sh <科目> 把 SUBJECT_DIR 指到仓库 subjects/<科目>/（参考资料取 grade/reference.md）
// 无 SUBJECT_DIR 或目录缺 subject.json 直接拒启——宁可不服务，也不拿错科目的口径判分。
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type subjectConfig struct {
	Prefix        string `json:"prefix"`
	Code          string `json:"code"`
	Name          string `json:"name"`
	MaterialTitle string // 逐项解析资料级 prompt 里的资料名（subject.json grade.materialTitle，可空）
	reference     string // 参考资料全文（空＝无资料，explain 直接走联网级）
}

// loadSubjectConfig 读 dir/subject.json 并探测参考资料（dir/reference.md 优先，其次 dir/grade/reference.md）。
func loadSubjectConfig(dir string) (*subjectConfig, error) {
	if dir == "" {
		return nil, fmt.Errorf("未设置 SUBJECT_DIR（本地由 ./start-ai.sh <科目> 传入，容器内为 /app/subject）")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "subject.json"))
	if err != nil {
		return nil, fmt.Errorf("读 %s/subject.json 失败：%w", dir, err)
	}
	var s subjectConfig
	var doc struct {
		Prefix string `json:"prefix"`
		Code   string `json:"code"`
		Name   string `json:"name"`
		Grade  struct {
			MaterialTitle string `json:"materialTitle"`
		} `json:"grade"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("解析 %s/subject.json 失败：%w", dir, err)
	}
	s.Prefix, s.Code, s.Name, s.MaterialTitle = doc.Prefix, doc.Code, doc.Name, doc.Grade.MaterialTitle
	if strings.TrimSpace(s.Name) == "" {
		return nil, fmt.Errorf("%s/subject.json 缺 name（科目中文名，用于阅卷 prompt）", dir)
	}
	for _, rel := range []string{"reference.md", filepath.Join("grade", "reference.md")} {
		if b, err := os.ReadFile(filepath.Join(dir, rel)); err == nil && strings.TrimSpace(string(b)) != "" {
			s.reference = string(b)
			break
		}
	}
	return &s, nil
}
