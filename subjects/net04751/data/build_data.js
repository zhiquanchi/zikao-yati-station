// 把 04751 押题 docx（textutil 转出的整段文本）解析成结构化题库 data.js（Bun 运行时）。
// 用法: textutil -convert txt -stdout <docx> > subjects/net04751/data/raw.txt && bun run build net04751
// 源文件格式：题目区（1..231 连续编号，单选带 A、B、C、D 选项）＋ 答案区（“N.答案…”连续编号），
// 两区编号各自从 1 开始、按序扫描切分；答案空缺或题图/计算类题目直接剔除，不入库。
// 科目身份（标题/存储键/组卷参数/特性开关）来自 ../subject.json，统一注入 QUIZ_DATA.meta。
// 装配段（并列互换、精简考点、解析覆盖、落盘）走共享层 scripts/build-lib.js；本文件只保留 04751 版式专属的解析。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { metaOf } from "../../../scripts/config.js";
import { fullRef, variantsOf, splitBlanks, applyUnordered, applyEssayPoints, applyExplains, writeArtifacts } from "../../../scripts/build-lib.js";

const HERE = import.meta.dir;
const SUBJECT = JSON.parse(readFileSync(path.join(HERE, "..", "subject.json"), "utf8"));
const RAW = path.join(HERE, "raw.txt");
const EXPL_PATH = path.join(HERE, "explanations.json");
const ESSP_PATH = path.join(HERE, "essay_points.json");
const UNORD_PATH = path.join(HERE, "unordered.json");

const CHAPTER = "04751 计算机网络安全押题";
const SINGLE_MAX = 105; // 原题号 ≤105 为单选
// 剔除：计算/题图依赖且答案缺失或仅复述题干的题目（112/117/144/176/223），其余空答案题目自动剔除
const EXCLUDED = new Set([112, 117, 144, 176, 223]);

// 04751 版式：括号内「或」写法先规范成普通括号，再交给共享 variantsOf 拆变体
const VAR_OPTS = { orParen: true };
const variants = (t) => variantsOf(t, VAR_OPTS);

// 去掉 OCR 造成的中文间空格与重复标点（不清理行尾数字：存在 “1000” 等纯数字答案）
function clean(s) {
  s = String(s).trim();
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(/(?<=[一-鿿）】])\s+(?=[一-鿿（(])/g, "");
    s = s.replace(/(?<=[一-鿿])\s+(?=[一-鿿(（])/g, "");
  }
  s = s.replace(/[。．]{2,}/g, "。");
  return s.trim();
}

const stripPunct = (s) => String(s).trim().replace(/^[ ；;，,。：:]+/, "").replace(/[ ；;，,。：:]+$/, "");

// 把简答参考答案拆成得分点（04751 版式：全/半角分值混排、答区复述、圈号归类等处理）
function splitPoints(ref) {
  ref = fullRef(ref).replace(/^答[：:]\s*/, "").replace(/^要求[：:][\s\S]*?(?=（?1[）)])/, "");
  // 分值标注（全/半角混排的“（2分)”）统一成句号分隔，再参与拆分
  ref = ref.replace(/[（(]\s*\d+\s*分\s*[)）]/g, "。");
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
    p = p.replace(/^[（(]?\d{1,2}[）)、]\s*/, "").replace(/^[和与及]\s*/, "").replace(/^[ ；;，,。：:]+/, "").replace(/[ ；;，,。：:]+$/, "");
    if (p.length >= 4) points.push(p);
  }
  if (points.length >= 2) return points.slice(0, 12);
  const joinClean = (s) => stripPunct(s.replace(/^[和与及]\s*/, ""));
  let sents = ref.split(/[。；;]/).map(joinClean).filter((s) => s.length >= 4);
  if (sents.length >= 2) return sents.slice(0, 12);
  sents = ref.split(/[，,、]/).map(joinClean).filter((s) => s.length >= 3);
  if (sents.length >= 2) return sents.slice(0, 12);
  return [fullRef(ref) || ref];
}

// 顺序扫描 “(\d+)\.” 编号标记：只认从 1 开始的连续编号，天然跳过正文里的 “202.99”“GB9361--88” 等数字串
function scanNumbered(text, markerRe) {
  const blocks = []; // { num, start, end }
  let expected = 1, pos = 0;
  const re = new RegExp(markerRe, "g");
  let m;
  while ((m = re.exec(text))) {
    const num = parseInt(m[1], 10);
    if (num !== expected) continue;
    if (blocks.length) blocks[blocks.length - 1].end = m.index;
    blocks.push({ num, start: m.index + m[0].length, end: text.length });
    expected++;
  }
  return blocks;
}

// 从单选块文本中找最后一段连续的 A、B、C、D 选项链（题干里可能先出现 “A、B类安全机房” 干扰）
function splitOptions(block) {
  const matches = [];
  const re = /(?:^|\s)([A-D])、/g;
  let m;
  while ((m = re.exec(block))) matches.push({ key: m[1], idx: m.index, len: m[0].length });
  let best = null;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].key !== "A") continue;
    const chain = [matches[i]];
    for (let j = i + 1; j < matches.length && chain.length < 4; j++) {
      if (matches[j].key === "ABCD"[chain.length]) chain.push(matches[j]);
    }
    if (chain.length === 4) best = chain; // 取最靠右的完整链
  }
  if (!best) return { stem: clean(block), opts: [] };
  const stem = clean(block.slice(0, best[0].idx));
  const opts = [];
  for (let i = 0; i < 4; i++) {
    const s = best[i].idx + best[i].len;
    const e = i + 1 < 4 ? best[i + 1].idx : block.length;
    opts.push([best[i].key, clean(block.slice(s, e))]);
  }
  return { stem, opts };
}

function parse(text) {
  const aStart = text.search(/(?:^|\s)1\.答案/);
  if (aStart < 0) throw new Error("未找到答案区起点 “1.答案”");
  const qPart = text.slice(0, aStart);
  const aPart = text.slice(aStart);

  const qBlocks = scanNumbered(qPart, "(?:^|\\s)(\\d{1,3})\\.");
  const aBlocks = scanNumbered(aPart, "(?:^|\\s)(\\d{1,3})\\.答案");
  if (qBlocks.length !== 231) console.log(`⚠ 题目区编号 ${qBlocks.length} 个（期望 231）`);
  if (aBlocks.length !== 231) console.log(`⚠ 答案区编号 ${aBlocks.length} 个（期望 231）`);

  const answers = {};
  for (const b of aBlocks) answers[b.num] = aPart.slice(b.start, b.end).trim();

  const questions = [];
  const warnings = [];
  for (const b of qBlocks) {
    const id = b.num;
    const block = qPart.slice(b.start, b.end).trim();
    const ans = answers[id] || "";
    if (!block || EXCLUDED.has(id)) { warnings.push(`#${id} 剔除（缺答案或依赖题图/计算）`); continue; }
    if (!ans.trim()) { warnings.push(`#${id} 剔除（答案区为空）`); continue; }
    let item;
    if (id <= SINGLE_MAX) {
      const { stem, opts } = splitOptions(block);
      const am = ans.match(/^([A-D])(?:[、，.]?\s*(?:解析)?\s*([\s\S]*))?$/);
      if (!am) { warnings.push(`#${id} 单选答案异常，剔除：${ans.slice(0, 30)}`); continue; }
      if (opts.length !== 4) { warnings.push(`#${id} 单选选项数=${opts.length}，需人工修正`); }
      const letter = am[1];
      let explanation = clean(am[2] || "");
      if (!explanation || explanation === "无") {
        const optText = (opts.find((o) => o[0] === letter) || ["", ""])[1];
        explanation = `正确答案 ${letter}：${optText}`;
      }
      item = {
        id, chapter: CHAPTER, type: "single", stem,
        options: opts.map(([key, text]) => ({ key, text })),
        answer: letter, ref: explanation, explanation,
      };
    } else if (/_{2,}/.test(block) && !/[？?]\s*$/.test(block)) {
      // 下划线视为填空
      const stem = clean(block);
      const n = (stem.match(/_{2,}/g) || []).length;
      const ref = fullRef(clean(ans));
      let blanks;
      if (n === 1) blanks = [variants(ref)];
      else {
        const parts = splitBlanks(ref, n);
        blanks = parts ? parts.map(variants) : null;
      }
      const fallback = blanks == null;
      if (fallback) blanks = Array.from({ length: n }, () => [ref]);
      // 数值类答案补 % 变体（如 “25%”↔“25”，题干带 ％ 时纯数字也接受 “NN%” 写法）
      for (const vs of blanks) {
        for (const v of [...vs]) {
          if (/^\d+([%％])$/.test(v)) vs.push(v.replace(/[%％]$/, ""));
          else if (/^\d+$/.test(v) && /[％%]/.test(stem)) vs.push(v + "%");
        }
      }
      item = { id, chapter: CHAPTER, type: "blank", stem, ref, blankCount: Math.max(n, 1), blanks, fallback };
    } else {
      item = mkEssay(id, block, ans);
    }
    questions.push(item);
  }
  return { questions, warnings };
}

function mkEssay(id, block, ans) {
  const stem = clean(block);
  let ref = clean(ans); // 有的条目把“要求：…”题干引言混进答案区，统一由下面的“(1)复述”规则切到正式作答
  // 答案区先复述子问题再以 “(1)” 开始正式作答的（#122/#135/#231），切到最后一个 “(1)” 起
  const first = ref.indexOf("(1)");
  const last = ref.lastIndexOf("(1)");
  if (first >= 0 && last > first && ref.slice(last).includes("(2)")) ref = ref.slice(last);
  ref = fullRef(ref);
  const points = splitPoints(ref);
  return { id, chapter: CHAPTER, type: "essay", stem, ref, points };
}

function main() {
  const text = readFileSync(RAW, "utf8");
  const expl = existsSync(EXPL_PATH) ? JSON.parse(readFileSync(EXPL_PATH, "utf8")) : {};
  const essayPts = existsSync(ESSP_PATH) ? JSON.parse(readFileSync(ESSP_PATH, "utf8")) : {};
  const unord = existsSync(UNORD_PATH) ? JSON.parse(readFileSync(UNORD_PATH, "utf8")) : null;
  const { questions, warnings } = parse(text);
  // 特例修正：#76 源文本选项与答案串行错乱（OCR），按标准结论修正为 n(n-1)/2
  const q76 = questions.find((q) => q.id === 76);
  if (q76) {
    q76.stem = "单钥密码算法中，n个人进行两两通信，总共需要的密钥个数为";
    q76.options = [
      { key: "A", text: "2n" },
      { key: "B", text: "n²" },
      { key: "C", text: "n(n-1)/2" },
      { key: "D", text: "n(n+1)" },
    ];
    q76.answer = "C";
    q76.ref = "单钥密码体制下 n 个人两两保密通信，共需 n(n-1)/2 个密钥";
    q76.explanation = q76.ref;
  }
  // 特例修正：#216 参考答案 “X-Prode” 为源文件笔误（工具名 X-Probe），保留原拼写作答也算对
  const q216 = questions.find((q) => q.id === 216);
  if (q216 && q216.type === "blank" && q216.ref === "X-Prode") {
    q216.ref = "X-Probe";
    q216.blanks = [["X-Probe", "X-Prode"]];
    q216.fallback = false;
  }
  // 特例修正：#164 按①~⑩归类的题，自动拆点会被圈号打断，直接给定三条归类得分点
  const q164 = questions.find((q) => q.id === 164);
  if (q164 && q164.type === "essay") {
    q164.points = ["生存技术：①②⑨⑩", "攻击技术：③④⑥⑧", "隐藏技术：⑤⑦"];
  }
  applyUnordered(questions, unord, warnings);
  // 可选人工覆盖：简答精简考点（**关键词** 加粗约定同 os13180）与主观题解析（本库暂无手写解析，缺省不告警）
  applyEssayPoints(questions, essayPts, warnings);
  applyExplains(questions, expl, warnings);
  const cnt = { single: 0, blank: 0, essay: 0 };
  questions.forEach((q) => cnt[q.type]++);
  console.log("题目:", questions.length, cnt);
  console.log("剔除:", warnings.length ? warnings.join("；") : "无");
  const payload = { title: SUBJECT.pageTitle, meta: metaOf(SUBJECT), chapters: [CHAPTER], questions };
  const { outJson } = writeArtifacts(path.join(HERE, ".."), payload);
  console.log("已生成:", outJson);
}

main();
