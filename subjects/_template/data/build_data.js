// 【新科目骨架·必改】把该科押题 docx（textutil 转出的文本）解析成结构化题库 data.js（Bun 运行时）。
// 用法: textutil -convert txt -stdout <docx> > subjects/<科目>/data/raw.txt && bun run build <科目>
//
// 本文件只写「解析」：把源文本变成规范题目数组喂给共享装配层 scripts/build-lib.js，
// 装配段（并列互换/精简考点/解析合并/变体/落盘/meta 注入）勿在此重复实现。
// 骨架自带 13180 版式（逐行「[单选]/[填空题]/[简答题] + 选项/正确答案/解析」），
// 不同 docx 版式请改 parse() 与 clean()（04751 的双编号扫描版可参照 subjects/net04751/data/build_data.js）。
//
// 规范题目对象（build-lib 与判分引擎依赖的字段形状）：
//   { id, chapter, type: "single"|"blank"|"essay", stem, ref, explanation? }
//   单选加 { options:[{key,text}], answer:"A" }；填空加 { blankCount, blanks:[[候选...],...], fallback? }
//   简答加 { points:[得分点...] }（essay_points.json 可按 id 覆盖，**关键词** 标记供展示加粗）
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { metaOf } from "../../../scripts/config.js";
import { fullRef, variantsOf, splitBlanks, applyUnordered, applyEssayPoints, applyExplains, writeArtifacts } from "../../../scripts/build-lib.js";

const HERE = import.meta.dir;
const SUBJECT = JSON.parse(readFileSync(path.join(HERE, "..", "subject.json"), "utf8"));
const RAW = path.join(HERE, "raw.txt");
const EXPL_PATH = path.join(HERE, "explanations.json");
const ESSP_PATH = path.join(HERE, "essay_points.json");
const UNORD_PATH = path.join(HERE, "unordered.json");

const TYPE_MAP = { 单选: "single", 填空题: "blank", 简答题: "essay" };

// 去掉 OCR 造成的中文间空格、重复标点、行尾噪声数字（按你的源文本实况增删）
function clean(s) {
  s = String(s).trim();
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(/(?<=[一-鿿）】])\s+(?=[一-鿿（(])/g, "");
    s = s.replace(/(?<=[一-鿿])\s+(?=[一-鿿(（])/g, "");
  }
  s = s.replace(/[。．]{2,}/g, "。");
  s = s.replace(/\s*\d{3,}\s*$/g, "");
  return s.trim();
}

const stripPunct = (s) => String(s).trim().replace(/^[ ；;，,。]+/, "").replace(/[ ；;，,。]+$/, "");

// 把简答参考答案拆成得分点。优先按序号标记切，其次按句读切
function splitPoints(ref) {
  ref = fullRef(ref).replace(/^答[：:]\s*/, "");
  if ((ref.match(/（\d+分）/g) || []).length >= 2) {
    let parts = ref.split(/（\d+分）\s*/).map((p) => p.trim().replace(/[。；;，,、\s]+$/g, ""));
    parts = parts.filter((p) => p.length >= 4);
    if (parts.length >= 2) return parts.slice(0, 12);
  }
  const marks = "（\\d{1,2}）|\\(\\d{1,2}\\)|\\d{1,2}、|(?<=[：:；;。\\s])\\d{1,2}）|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]";
  let parts = ref.split(new RegExp("(?=" + marks + ")"));
  parts = parts.map(stripPunct).filter(Boolean);
  const points = [];
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i];
    if (i === 0 && parts.length > 1) {
      const chunks = p.split("。");
      while (chunks.length > 1 && /[：:]\s*$/.test(chunks[chunks.length - 1])) chunks.pop();
      const keep = chunks.join("。");
      if (keep.length >= 6) p = keep;
      else if (p.length < 16) continue;
    }
    p = p.replace(/^(（?\d{1,2}[）)、]|[①-⑳])\s*/, "").replace(/^[ ；;，,。]+/, "").replace(/[ ；;，,。]+$/, "");
    if (p.length >= 4) points.push(p);
  }
  if (points.length >= 2) return points.slice(0, 12);
  let sents = ref.split(/[。；;]/).map(stripPunct).filter((s) => s.length >= 5);
  if (sents.length >= 2) return sents.slice(0, 12);
  sents = ref.split(/[，,、]/).map((s) => s.trim().replace(/^[ ；;，,、]+/, "").replace(/[ ；;，,、]+$/, "")).filter((s) => s.length >= 5);
  if (sents.length >= 2) return sents.slice(0, 12);
  return [ref];
}

// ——— 科目专属解析（必改段）：逐行扫描 13180 版式 ———
function parse(text) {
  const chapters = [];
  const questions = [];
  let curChapter = "";
  let cur = null;
  let field = null;
  for (const rawLine of text.split("\n")) {
    const s = rawLine.replace(/\s+$/, "");
    if (!s.trim()) continue;
    if (/^第[一二三四五六七八九十百]+章/.test(s.trim())) {
      if (cur && cur.exp) questions.push(cur);
      cur = null;
      curChapter = clean(s.trim());
      chapters.push(curChapter);
      continue;
    }
    const m = s.trim().match(/^\[(单选|填空题|简答题)\]\s*(.*)$/);
    if (m) {
      if (cur && cur.exp) questions.push(cur);
      cur = { chapter: curChapter, type: TYPE_MAP[m[1]], stem: clean(m[2]), opts: [], ans: null, exp: null, expRaw: null };
      field = "stem";
      continue;
    }
    if (!cur) continue;
    const mo = s.trim().match(/^([A-D])[ \t]+(.*)$/);
    if (cur.type === "single" && mo && !s.trim().startsWith("正确答案")) {
      cur.opts.push([mo[1], clean(mo[2])]);
      field = "opt";
      continue;
    }
    if (s.trim().startsWith("正确答案：")) {
      cur.ans = s.trim().split("：").slice(1).join("：").trim();
      field = "ans";
      continue;
    }
    if (s.trim().startsWith("解析：")) {
      const raw = s.trim().split("：").slice(1).join("：");
      cur.exp = clean(raw);
      cur.expRaw = raw.trim();
      field = "exp";
      continue;
    }
    if (field === "exp" && cur.exp) {
      cur.exp += clean(s);
      cur.expRaw = (cur.expRaw + " " + s.trim()).trim();
    } else if (field === "stem") {
      cur.stem += clean(s);
    } else if (field === "opt" && cur.opts.length) {
      cur.opts[cur.opts.length - 1][1] += clean(s);
    }
  }
  if (cur && cur.exp) questions.push(cur);

  const out = [];
  const warnings = [];
  questions.forEach((q, idx) => {
    const i = idx + 1;
    const item = {
      id: i,
      chapter: q.chapter,
      type: q.type,
      stem: q.stem,
      ref: fullRef(q.exp).replace(/^答[：:]\s*/, ""),
      explanation: q.exp,
    };
    if (q.type === "single") {
      if (q.opts.length !== 4) warnings.push(`#${i} 单选选项数=${q.opts.length}`);
      item.options = q.opts.map(([k, t]) => ({ key: k, text: t }));
      const am = (q.ans || "").match(/[A-D]/);
      if (!am) warnings.push(`#${i} 单选答案异常: ${q.ans}`);
      item.answer = am ? am[0] : "A";
    } else if (q.type === "blank") {
      const n = (q.stem.match(/_{2,}/g) || []).length;
      if (n === 0) warnings.push(`#${i} 填空但题干无下划线`);
      item.blankCount = Math.max(n, 1);
      let parts = item.blankCount > 1 ? splitBlanks(q.expRaw || q.exp, item.blankCount) : null;
      if (item.blankCount === 1) parts = [fullRef(q.exp)];
      if (parts == null) {
        item.fallback = true;
        item.blanks = Array.from({ length: item.blankCount }, () => [fullRef(q.exp)]);
      } else {
        item.blanks = parts.map((p) => variantsOf(p));
      }
    } else {
      let pts = splitPoints(q.exp);
      if (!pts.length) { warnings.push(`#${i} 简答无法拆点`); pts = [fullRef(q.exp)]; }
      item.points = pts;
    }
    out.push(item);
  });
  return { chapters, questions: out, warnings };
}

function main() {
  if (!existsSync(RAW)) {
    console.error("❌ 缺 data/raw.txt —— 先转换源 docx：textutil -convert txt -stdout \"<docx路径>\" > subjects/" + path.basename(path.join(HERE, "..")) + "/data/raw.txt");
    process.exit(1);
  }
  const text = readFileSync(RAW, "utf8");
  const expl = existsSync(EXPL_PATH) ? JSON.parse(readFileSync(EXPL_PATH, "utf8")) : {};
  const essayPts = existsSync(ESSP_PATH) ? JSON.parse(readFileSync(ESSP_PATH, "utf8")) : {};
  const unord = existsSync(UNORD_PATH) ? JSON.parse(readFileSync(UNORD_PATH, "utf8")) : null;
  const { chapters, questions, warnings } = parse(text);
  applyUnordered(questions, unord, warnings);
  applyEssayPoints(questions, essayPts, warnings, { warnMissing: Object.keys(essayPts).length > 0 });
  applyExplains(questions, expl, warnings, { allTypes: true, warnMissingExplanation: Object.keys(expl).length > 0 });
  const cnt = { single: 0, blank: 0, essay: 0 };
  questions.forEach((q) => cnt[q.type]++);
  console.log("章节:", chapters.length);
  console.log("题目:", questions.length, cnt);
  console.log("解析覆盖:", questions.filter((q) => String(q.id) in expl).length, "/", questions.length);
  console.log("警告:", warnings.length ? warnings : "无");
  if (!questions.length) console.log("⚠ 题目区解析为 0：多半是源 docx 版式与骨架解析不符，请改 build_data.js 的 parse() 段");
  const payload = { title: SUBJECT.pageTitle, meta: metaOf(SUBJECT), chapters, questions };
  const { outJs, outJson } = writeArtifacts(path.join(HERE, ".."), payload);
  console.log("已生成:", outJs, outJson);
}

main();
