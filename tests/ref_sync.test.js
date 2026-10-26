// 单选逐项解析的参考资料守卫（bun test）：凡科目带 grade/reference.md，必须与科目根目录的
// 思维导图（subject.json mindmap.file）逐字一致。更新导图后必须同步：
//   cp subjects/<科目>/<mindmap.file> subjects/<科目>/grade/reference.md
import { expect, test } from "bun:test";
import path from "node:path";
import { loadSubjects } from "../scripts/config.js";

for (const s of loadSubjects()) {
  const refPath = path.join(s.dir, "grade", "reference.md");
  const srcFile = s.mindmap && s.mindmap.file;
  if (!srcFile) continue; // 无根导图的科目不设守卫
  test(`${s.slug}：grade/reference.md 与科目思维导图逐字一致`, async () => {
    const src = await Bun.file(path.join(s.dir, srcFile)).text();
    const ref = await Bun.file(refPath).text();
    expect(ref.length).toBeGreaterThan(1000);
    expect(ref).toBe(src);
  });
}
