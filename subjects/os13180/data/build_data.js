// 把 textutil 导出的押题文本解析成结构化题库 data.js（Bun 运行时）。
// 用法: textutil -convert txt -stdout <docx> > data/raw.txt && bun data/build_data.js
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dir;
const RAW = path.join(HERE, "raw.txt");
const OUT_JS = path.join(HERE, "..", "data.js");
const OUT_JSON = path.join(HERE, "questions.json");
const EXPL_PATH = path.join(HERE, "explanations.json");
const ESSP_PATH = path.join(HERE, "essay_points.json");
const UNORD_PATH = path.join(HERE, "unordered.json");

const TYPE_MAP = { 单选: "single", 填空题: "blank", 简答题: "essay" };

function fullRef(s) {
  return String(s || "").trim().replace(/[。；;，,、\s]+$/g, "");
}

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

// 过滤括号拆解产生的无意义短词：纯中文要求≥3字，含ASCII要求≥2字符
function useful(v) {
  v = String(v).trim();
  if (!v) return false;
  if (/[一-鿿]/.test(v) && !/[A-Za-z0-9]/.test(v)) return v.length >= 3;
  return v.length >= 2;
}

// 一个填空答案的可接受写法集合：去括号本体、括号内各项、拼接形式
function variantsOf(term) {
  term = String(term).trim().replace(/[。；;，,、\s]+$/g, "").replace(/^[。；;，,、\s]+/g, "");
  const vs = [term];
  const m = term.match(/^(.*?)[（(](.*?)[）)](.*)$/);
  if (m) {
    const [, head, inner, tail] = m;
    const joined = head + tail;
    if (joined) vs.push(joined);
    for (let cand of [head, tail, ...inner.split(/[，,、;；]/)]) {
      cand = String(cand).trim();
      // 源文本括号本身不平衡时（如截断产生的“（文件内位置”），去掉括号形态，避免留下答不出的变体
      if (((cand.match(/[（(]/g) || []).length) !== ((cand.match(/[）)]/g) || []).length)) {
        cand = cand.replace(/[（()）]/g, "");
      }
      if (useful(cand)) vs.push(cand);
    }
  }
  for (const v of [...vs]) {
    const nv = v.replace(/\s+/g, " ").trim();
    if (nv !== v && nv) vs.push(nv);
  }
  const seen = new Set();
  const out = [];
  for (const v of vs) if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  return out;
}

// 单空并列/或选答案的额外认可写法（仅对 unordered.json single 清单里的题应用）：
// 「A或B」＝二者任选其一即对 → 每项单独成为变体；「A和/与/及/、/，B」＝两项都要、顺序自由 → 互换写法成为变体
function orderVariants(variants) {
  const base = variants[0] || "";
  const m = base.match(/^(.+?)(或|和|与|及|、|，)(.+)$/);
  if (!m || (m[1] + m[3]).match(/[或和与及、，]/)) return variants; // 只处理恰好一个分隔符的两项枚举
  const a = m[1].trim(), d = m[2], b = m[3].trim();
  const extra = d === "或" ? [a, b] : [b + d + a];
  const out = [...variants];
  for (const v of extra) if (useful(v) && !out.includes(v)) out.push(v);
  return out;
}

// 按空的个数把参考答案拆成每空的候选词列表。拆不动时返回 null（整句匹配兜底）
function splitBlanks(ref, n) {
  ref = fullRef(ref);
  const delims = [/、/, /[，,]/, /[；;]/, /\s+/, /[和与及]/];
  for (const d of delims) {
    let parts = ref.split(d).map((p) => p.trim()).filter(Boolean);
    parts = parts.map((p) => p.replace(/[。；;，,、\s]+$/g, ""));
    if (parts.length === n && parts.every((p) => p.length <= 40)) return parts;
  }
  return null;
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
        item.blanks = parts.map(variantsOf);
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
  const expl = existsSync(EXPL_PATH) ? JSON.parse(readFileSync(EXPL_PATH, "utf8")) : {};
  const essayPts = existsSync(ESSP_PATH) ? JSON.parse(readFileSync(ESSP_PATH, "utf8")) : {};
  const { chapters, questions, warnings } = parse(text);
  // 并列可互换题标记（data/unordered.json）：ids＝多空题打 unordered:true，判分引擎据此做跨空排列匹配；
  // single＝单空题但答案本身是并列/或选枚举，用 orderVariants 追加认可写法（互换/单项），不动判分引擎
  const unord = existsSync(UNORD_PATH) ? JSON.parse(readFileSync(UNORD_PATH, "utf8")) : null;
  if (unord) {
    const ids = new Set((unord.ids || []).map(Number));
    const singles = new Set((unord.single || []).map(Number));
    const seen = new Set();
    for (const q of questions) {
      if (singles.has(q.id)) {
        seen.add(q.id);
        if (q.type !== "blank" || q.blanks.length !== 1) {
          warnings.push(`#${q.id} unordered.single 无效（非单空填空题），已忽略`);
          continue;
        }
        q.blanks[0] = orderVariants(q.blanks[0]);
        continue;
      }
      if (!ids.has(q.id)) continue;
      seen.add(q.id);
      if (q.type !== "blank" || q.blankCount < 2 || q.fallback) {
        warnings.push(`#${q.id} unordered 标记无效（非多空填空题），已忽略`);
        continue;
      }
      q.unordered = true;
    }
    for (const id of new Set([...ids, ...singles])) if (!seen.has(id)) warnings.push(`unordered.json 中 #${id} 在题库中不存在`);
  }
  // 简答精简考点：人工/大模型提炼的拿分关键词，按 id 覆盖自动拆点结果
  // 支持 **关键词** 加粗标记：points 供判分（剥掉标记，与原文逐字一致），pointsMd 供展示
  for (const q of questions) {
    if (q.type !== "essay") continue;
    const simp = essayPts[String(q.id)];
    if (Array.isArray(simp) && simp.length) {
      const md = simp.map((p) => String(p).trim());
      q.points = md.map((p) => p.replace(/\*\*/g, ""));
      if (md.some((p) => p.includes("**"))) q.pointsMd = md;
    } else warnings.push(`#${q.id} 简答缺精简考点`);
  }
  // 主观题解析覆盖率检查
  for (const q of questions) {
    if ((q.type === "blank" || q.type === "essay") && !(String(q.id) in expl)) {
      warnings.push(`#${q.id} 缺解析`);
    }
  }
  const cnt = { single: 0, blank: 0, essay: 0 };
  questions.forEach((q) => cnt[q.type]++);
  console.log("章节:", chapters.length);
  console.log("题目:", questions.length, cnt);
  console.log("解析覆盖:", questions.filter((q) => String(q.id) in expl).length, "/", questions.length);
  console.log("警告:", warnings.length ? warnings : "无");
  for (const q of questions) {
    q.explain = expl[String(q.id)] || q.explanation; // 具体解析：主观题人工撰写，单选沿用原文解析
  }
  const payload = { title: "2026年10月自考 13180 操作系统 押题练习", chapters, questions };
  writeFileSync(OUT_JSON, JSON.stringify(payload, null, 1), "utf8");
  writeFileSync(OUT_JS, "// 由 data/build_data.js 自动生成，请勿手改\nwindow.QUIZ_DATA = " + JSON.stringify(payload) + ";\n", "utf8");
  console.log("已生成:", path.resolve(OUT_JS), path.resolve(OUT_JSON));
}

main();
