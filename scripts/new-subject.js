// 新科目骨架生成：bun run new-subject <prefix> <题号> <中文名>
// 例：bun run new-subject db 06414 数据库系统 → subjects/db06414/
// 做三件事：复制 _template；按规则生成 subject.json（存储键 <prefix><code>.v1、端口取现有科目之外的下一空闲对）；
// 打印后续五步工作流。清单与题库不在此时刷新（新科目尚无 data.js，刷了会得到死链），完成 build 后自然纳入。
import path from "node:path";
import { existsSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { loadSubjects, SUBJECTS_DIR, ROOT } from "./config.js";

const [prefix, code, ...rest] = process.argv.slice(2);
const name = rest.join(" ");
if (!prefix || !code || !name) {
  console.error("用法：bun run new-subject <prefix 小写字母> <题号 5 位数字> <中文名>");
  console.error("例：bun run new-subject db 06414 数据库系统");
  process.exit(1);
}
if (!/^[a-z][a-z0-9]*$/.test(prefix)) { console.error("prefix 需为小写字母开头的字母数字串（如 os / net / db）"); process.exit(1); }
if (!/^\d{4,6}$/.test(code)) { console.error("题号需为 4~6 位数字（如 06414）"); process.exit(1); }

const slug = prefix + code;
const dir = path.join(SUBJECTS_DIR, slug);
if (existsSync(dir)) { console.error(`❌ subjects/${slug} 已存在`); process.exit(1); }

// 端口：现有科目 web 端口的最大者 +2（8791/8793 → 8795），判分紧随其后
const subs = loadSubjects();
const nextWeb = Math.max(8789, ...subs.map((s) => (s.ports && s.ports.web) || 0)) + 2;
const cfg = {
  prefix, code, name,
  examMonth: "2026年10月",
  title: `${code} ${name} · 押题练习`,
  pageTitle: `2026年10月自考 ${code} ${name} · 押题练习`,
  switchLabel: `${name} ${code}`,
  storageKey: `${prefix}${code}.v1`,
  ports: { web: nextWeb, grade: nextWeb + 1 },
  flags: { explain: false },
  paper: { target: 100, scores: { single: 1, blank: 2, essay: 5 } },
  mindmap: { enabled: false, file: "", label: "" },
  grade: { materialTitle: "" },
};

cpSync(path.join(SUBJECTS_DIR, "_template"), dir, { recursive: true });
writeFileSync(path.join(dir, "subject.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
rmSync(path.join(dir, "README.md"));

console.log(`✅ 已创建 subjects/${slug}/（科目名 ${name}，本地端口 ${nextWeb}/${nextWeb + 1}，存储键 ${cfg.storageKey}）`);
console.log(`
下一步（README「新增一个科目」节）：
  1) textutil -convert txt -stdout "<押题 docx>" > subjects/${slug}/data/raw.txt
  2) 改 subjects/${slug}/data/build_data.js 的 parse() 适配源版式（必改段有注释）
  3) bun run build ${slug} && bun test
  4) bun run start ${slug}   # 浏览器验证（默认 http://127.0.0.1:${nextWeb}/）
  5) ./deploy.sh             # 线上一键纳入（前缀 /${prefix}/，门户切换器自动出现）`)
