# 新科目骨架

用 `bun run new-subject <prefix> <题号> <中文名>` 复制本目录（自动填 subject.json 与端口），然后：

1. `textutil -convert txt -stdout "<押题 docx>" > subjects/<新科目>/data/raw.txt`
2. 改 `data/build_data.js` 的 `parse()`/`clean()` 适配你的 docx 版式（骨架自带 13180 版式；双编号扫描版参照 `subjects/net04751`）
3. `bun run build <新科目> && bun test`
4. `bun run start <新科目>` 浏览器验证
5. `./deploy.sh` 发布（门户/切换器/nginx 自动纳入）

科目目录里的可选项：

- `data/explanations.json`：主观题手写解析（按题目 id 为键；文案参考该科串讲/考点资料）
- `data/essay_points.json`：简答精简考点（大模型逐题提炼，保持参考答案词序；`**关键词**` 加粗）
- `data/unordered.json`：并列可互换题清单（ids=多空互换、single=单空两项枚举；有先后语义的严禁入内）
- `grade/reference.md`：单选逐项解析参考资料（须与科目导图 md 逐字一致），并在 subject.json 置 `flags.explain: true` + `grade.materialTitle`
- 思维导图：科目根放导图 md，subject.json 填 `mindmap.file/enabled/label`，另生成 `mindmap.html`（参照两现有科目）
