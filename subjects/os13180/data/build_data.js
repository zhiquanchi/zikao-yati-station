// 把 textutil 导出的押题文本解析成结构化题库 data.js（Bun 运行时）。
// 用法: textutil -convert txt -stdout <docx> > subjects/os13180/data/raw.txt && bun run build os13180
// 科目身份（标题/存储键/组卷参数/特性开关）来自 ../subject.json，统一注入 QUIZ_DATA.meta。
// 装配段（并列互换、精简考点、解析覆盖、落盘）走共享层 scripts/build-lib.js，勿在此重复实现。
import { readFileSync } from "node:fs";
import path from "node:path";
import { metaOf } from "../../../scripts/config.js";
import { fullRef, variantsOf, splitBlanks, applyUnordered, applyEssayPoints, applyExplains, writeArtifacts } from "../../../scripts/build-lib.js";
import { buildSubjectMemo } from "../../../scripts/memo-lib.js";

const HERE = import.meta.dir;
const SUBJECT = JSON.parse(readFileSync(path.join(HERE, "..", "subject.json"), "utf8"));
const RAW = path.join(HERE, "raw.txt");
const EXPL_PATH = path.join(HERE, "explanations.json");
const ESSP_PATH = path.join(HERE, "essay_points.json");
const UNORD_PATH = path.join(HERE, "unordered.json");

const TYPE_MAP = { 单选: "single", 填空题: "blank", 简答题: "essay" };

// 去掉 OCR 造成的中文间空格、重复标点、行尾噪声数字
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
  // 带分值标注（如“（1分）”）的按分值切
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
      // 首段可能含题干式引言（以冒号结尾），去掉引言保留定义句
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
    // 续行：拼回最后一个字段
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
  const text = readFileSync(RAW, "utf8");
  const expl = JSON.parse(readFileSync(EXPL_PATH, "utf8"));
  const essayPts = JSON.parse(readFileSync(ESSP_PATH, "utf8"));
  const unord = JSON.parse(readFileSync(UNORD_PATH, "utf8"));
  const { chapters, questions, warnings } = parse(text);
  applyUnordered(questions, unord, warnings);
  applyEssayPoints(questions, essayPts, warnings, { warnMissing: true });
  applyExplains(questions, expl, warnings, { allTypes: true, warnMissingExplanation: true });
  // 「考前重点记忆」：把串讲导图 md 拆成考点小节并挂题目 id（科目 subject.json memo 开启时才装配）
  const memoRes = buildSubjectMemo({ subjectDir: path.join(HERE, ".."), subject: SUBJECT, questions, explains: expl, warnings });
  const cnt = { single: 0, blank: 0, essay: 0 };
  questions.forEach((q) => cnt[q.type]++);
  console.log("章节:", chapters.length);
  console.log("题目:", questions.length, cnt);
  console.log("解析覆盖:", questions.filter((q) => String(q.id) in expl).length, "/", questions.length);
  console.log("重点记忆:", memoRes ? `${memoRes.stats.sections} 个考点小节（${memoRes.stats.mapped} 个已挂题目）` : "未开启");
  console.log("警告:", warnings.length ? warnings : "无");
  const payload = { title: SUBJECT.pageTitle, meta: metaOf(SUBJECT), chapters, questions };
  if (memoRes) payload.memo = memoRes.memo;
  const { outJs, outJson } = writeArtifacts(path.join(HERE, ".."), payload);
  console.log("已生成:", outJs, outJson);
}

main();
