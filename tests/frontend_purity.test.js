// 前端纯净度守卫：浏览器侧不得再出现判分/合并/身份/组卷业务规则，
// 也不得 import 构建脚本或后端目录。
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const FRONTEND = path.join(ROOT, "frontend");
const files = readdirSync(FRONTEND).filter((f) => f.endsWith(".js"));
// 旧键名只允许出现在一次性迁移模块（model.js）里，其它业务规则一律不得出现。
const FORBIDDEN = /\b(gradeEssay|gradeBlanks|gradeSingle|mergeBlobs|stateOf|statusWeight)\b|api\/store|api\/grade/;

test("frontend 不含判分/合并/槽位等业务实现", () => {
  for (const f of files) {
    const src = readFileSync(path.join(FRONTEND, f), "utf8");
    const m = src.match(FORBIDDEN);
    expect(m, `${f} 命中禁用模式 ${m && m[0]}`).toBeNull();
  }
});

test("frontend 不 import scripts/ 或 backend/", () => {
  for (const f of files) {
    const src = readFileSync(path.join(FRONTEND, f), "utf8");
    expect(src.includes("../scripts/"), `${f} 引用了构建脚本`).toBe(false);
    expect(src.includes("../backend/"), `${f} 引用了后端目录`).toBe(false);
  }
});

test("index.html 只加载 api/model/app 三个脚本", () => {
  const html = readFileSync(path.join(FRONTEND, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  expect(scripts).toEqual(["api.js", "model.js", "app.js"]);
});