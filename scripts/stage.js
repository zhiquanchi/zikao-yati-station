// 前端产物暂存：bun run stage [科目…]（缺省＝全部）。
// 把共享引擎 web/ 与科目产物合成为 build/stage/<prefix>/ —— 部署目录的唯一事实源是共享引擎，
// 这里只是按门户静态根的形态拼一次（deploy.sh 与本地 file:// 预览都吃这份暂存）。
import path from "node:path";
import { mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { loadSubjects, findSubject, WEB_DIR, ROOT } from "./config.js";

const ENGINE_FILES = ["index.html", "styles.css", "app.js", "grading.js", "sync.js", "identity.js", "recite.js", "memo.js", "subject-switch.js", "subjects.js"];
const SUBJECT_FILES = ["data.js", "mindmap.html"];

const ROOT_ = path.join(ROOT, "build", "stage");
const names = process.argv.slice(2);
const subs = names.length ? names.map((n) => findSubject(n)) : loadSubjects();

if (!existsSync(path.join(WEB_DIR, "subjects.js"))) throw new Error("缺 web/subjects.js，请先 bun run build");

for (const s of subs) {
  const dest = path.join(ROOT_, s.prefix);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const f of ENGINE_FILES) cpSync(path.join(WEB_DIR, f), path.join(dest, f));
  for (const f of SUBJECT_FILES) {
    const src = path.join(s.dir, f);
    if (existsSync(src)) cpSync(src, path.join(dest, f));
  }
  if (!existsSync(path.join(dest, "data.js"))) throw new Error(`${s.slug} 缺 data.js，请先 bun run build ${s.slug}`);
  console.log(`已暂存 build/stage/${s.prefix}/（${s.pageTitle}）`);
}
