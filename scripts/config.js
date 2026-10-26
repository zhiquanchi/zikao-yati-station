// 科目清单统一装载器（Bun 运行时）：server/deploy/build/test 都以 subjects/<科目>/subject.json 为唯一身份源。
// 约定：_ 前缀目录（_template 等）与缺 subject.json 的目录不算科目。
import path from "node:path";
import { readdirSync, existsSync, readFileSync } from "node:fs";

export const ROOT = path.join(import.meta.dir, "..");
export const SUBJECTS_DIR = path.join(ROOT, "subjects");
export const WEB_DIR = path.join(ROOT, "frontend");

export function subjectDir(name) { return path.join(SUBJECTS_DIR, name); }

// 返回 [{ slug(目录名), dir(绝对路径), ...subject.json 字段（name 为中文科目名） }]，按目录名排序保证稳定
export function loadSubjects() {
  const out = [];
  for (const name of readdirSync(SUBJECTS_DIR).sort()) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const dir = subjectDir(name);
    const cfgPath = path.join(dir, "subject.json");
    if (!existsSync(cfgPath)) continue;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (!cfg.prefix || !cfg.code || !cfg.storageKey) throw new Error(`${name}/subject.json 缺 prefix/code/storageKey`);
    out.push({ slug: name, dir, ...cfg });
  }
  return out;
}

// 按目录名（slug）或 prefix 找单个科目，找不到抛错并列出可选值
export function findSubject(arg) {
  const subs = loadSubjects();
  const hit = subs.find((s) => s.slug === arg || s.prefix === arg);
  if (!hit) throw new Error(`未知科目「${arg}」，可选：${subs.map((s) => s.slug).join(" / ")}`);
  return hit;
}

// 前端注入 QUIZ_DATA.meta 的字段集（科目身份的浏览器侧镜像）
export function metaOf(s) {
  return {
    prefix: s.prefix, code: s.code, name: s.name, examMonth: s.examMonth,
    title: s.title, pageTitle: s.pageTitle, storageKey: s.storageKey,
    flags: s.flags || {}, paper: s.paper || {}, mindmap: s.mindmap || {}, memo: s.memo || {},
  };
}
