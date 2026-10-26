// 题库构建入口：bun run build [科目…]（缺省＝全部科目）。
// 只产出 subjects/<科目>/data/questions.json（服务端装载的唯一题库事实源）；
// 前端不再接收 data.js / subjects.js 注入——题库与科目清单都由 API 下发。
import path from "node:path";
import { loadSubjects, findSubject } from "./config.js";

const names = process.argv.slice(2);
const subs = names.length ? names.map((n) => findSubject(n)) : loadSubjects();

for (const s of subs) {
  console.log(`\n—— 构建 ${s.slug}（${s.pageTitle}）——`);
  await import(path.join(s.dir, "data", "build_data.js"));
}
console.log(`\n题库已刷新：${subs.map((s) => s.prefix).join(", ")}（共 ${subs.length} 科）`);