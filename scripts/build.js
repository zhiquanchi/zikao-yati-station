// 题库构建入口：bun run build [科目…]（缺省＝全部科目）。
// 依次执行各科目 data/build_data.js（科目专属解析器＋共享装配约定），再依据全部 subject.json
// 刷新两份派生清单：web/subjects.js（前端科目切换器数据源）与 portal/subjects.json（门户路由清单）。
import path from "node:path";
import { writeFileSync } from "node:fs";
import { loadSubjects, findSubject, WEB_DIR, ROOT } from "./config.js";

const names = process.argv.slice(2);
// --manifest：只刷新派生清单（web/subjects.js、portal/subjects.json），不重建题库——
// 供 new-subject 等“改了 subject.json 但尚无数据”的场景。
const manifestOnly = names[0] === "--manifest";
const subs = manifestOnly ? [] : (names.length ? names.map((n) => findSubject(n)) : loadSubjects());

for (const s of subs) {
  console.log(`\n—— 构建 ${s.slug}（${s.pageTitle}）——`);
  await import(path.join(s.dir, "data", "build_data.js"));
}

const all = loadSubjects().sort((a, b) => ((a.ports && a.ports.web) || 0) - ((b.ports && b.ports.web) || 0));
writeFileSync(
  path.join(WEB_DIR, "subjects.js"),
  "// 由 scripts/build.js 依据全部 subject.json 自动生成，请勿手改\nwindow.SUBJECTS = " +
    JSON.stringify(all.map((s) => ({ prefix: s.prefix, label: s.switchLabel }))) + ";\n",
  "utf8"
);
writeFileSync(
  path.join(ROOT, "portal", "subjects.json"),
  JSON.stringify(all.map((s) => ({ prefix: s.prefix, label: s.switchLabel, primary: !!s.primary })), null, 1) + "\n",
  "utf8"
);
console.log("\n科目清单已刷新：web/subjects.js · portal/subjects.json（共 " + all.length + " 科：" + all.map((s) => s.prefix).join(", ") + "）");
