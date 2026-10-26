// 「考前重点记忆」数据装配（Bun 运行时）：把科目导图 md（同时是一份考点串讲）解析成结构化考点小节，
// 再按每题的「考点X.Y」标注（data/explanations.json）与人工补映射（data/memo_kp.json）把题目 id 挂到小节上。
// 产物进 QUIZ_DATA.memo，前端 frontend/memo.js 按作答记录判断小节是否还有未掌握题，渲染不含题干的记忆清单。
// 只做解析/装配，判分与掌握度口径仍在前端纯函数（frontend/memo.js）与 Go 服务，互不影响。
import { existsSync, readFileSync } from "node:fs";

const TAG = /〔[^〕]*〕/g;
const TYPE_ORDER = ["单选", "填空", "简答", "综合"];
const stripTags = (s) => String(s).replace(TAG, "").replace(/\s+/g, " ").trim();
const typeRank = (t) => {
  const i = TYPE_ORDER.indexOf(t);
  return i === -1 ? TYPE_ORDER.length : i;
};

// 解析导图 md：## 第X章 → ### 第Y节 → 缩进要点（- 开头，2 空格一层）。
// 题型标签〔单选·填空〕从标题与要点里收集（展示用），正文里的标签剥掉保持清爽。
export function parseMemoMd(md) {
  const chapters = [];
  let ch = null;
  let sec = null;
  for (const rawLine of String(md).split(/\r?\n/)) {
    const s = rawLine.replace(/\s+$/, "");
    if (!s.trim()) continue;
    const mc = s.match(/^##\s+(第[一二三四五六七八九十]章\s*.*)$/);
    if (mc) {
      ch = { name: mc[1].trim(), sections: [] };
      chapters.push(ch);
      sec = null;
      continue;
    }
    const ms = s.match(/^###\s+第[一二三四五六七八九十]节\s*(.*)$/);
    if (ms && ch) {
      sec = {
        id: `${chapters.length}.${ch.sections.length + 1}`,
        title: stripTags(ms[1]),
        types: [],
        items: [],
        ids: [],
      };
      for (const t of ms[1].matchAll(/〔([^〕]*)〕/g)) for (const x of t[1].split(/[·、/／,，\s]+/)) if (x) sec.types.push(x);
      ch.sections.push(sec);
      continue;
    }
    const mb = s.match(/^(\s*)[-*]\s+(.*)$/);
    if (mb && sec) {
      const depth = Math.min(Math.floor(mb[1].replace(/\t/g, "  ").length / 2), 2);
      for (const t of mb[2].matchAll(/〔([^〕]*)〕/g)) for (const x of t[1].split(/[·、/／,，\s]+/)) if (x) sec.types.push(x);
      const text = stripTags(mb[2]);
      if (text) sec.items.push({ d: depth, t: text });
    }
  }
  for (const chapter of chapters) {
    for (const section of chapter.sections) {
      section.types = [...new Set(section.types)].sort((a, b) => typeRank(a) - typeRank(b));
    }
  }
  return { chapters };
}

// 装配：给每个考点小节挂上题目 id（考点标注可跨章，如「考点1.1/2.1」）。
// kpMap 为人工补映射（{ "题号": ["X.Y"] }），只用于没有考点标注的题；warnings 收集缺映射/无效考点。
export function attachMemo({ md, questions, explains, kpMap, warnings }) {
  const memo = parseMemoMd(md);
  const warn = warnings || [];
  const index = new Map();
  for (const ch of memo.chapters) for (const sec of ch.sections) index.set(sec.id, sec);
  for (const q of questions || []) {
    const ids = new Set();
    const text = (explains && explains[String(q.id)]) || "";
    for (const m of text.matchAll(/考点\s*(\d+)\s*[.．]\s*(\d+)/g)) ids.add(`${m[1]}.${m[2]}`);
    const manual = kpMap && kpMap[String(q.id)];
    for (const id of [].concat(manual || [])) ids.add(String(id).trim());
    const valid = [];
    for (const id of ids) {
      if (!index.has(id)) { warn.push(`#${q.id} 考点「${id}」不在串讲 md 中，已忽略`); continue; }
      valid.push(id);
    }
    if (!valid.length) { warn.push(`#${q.id} 缺考点映射（补 data/memo_kp.json）`); continue; }
    for (const id of valid) index.get(id).ids.push(q.id);
  }
  let sections = 0;
  let mapped = 0;
  for (const ch of memo.chapters) {
    for (const sec of ch.sections) {
      sec.ids.sort((a, b) => a - b);
      sections++;
      if (sec.ids.length) mapped++;
    }
  }
  return { memo, stats: { chapters: memo.chapters.length, sections, mapped } };
}

// 科目 build_data.js 直接调用的薄封装：读导图 md 与 data/memo_kp.json，返回 memo 或 null。
export function buildSubjectMemo({ subjectDir, subject, questions, explains, warnings }) {
  if (!subject || !subject.memo || !subject.memo.enabled) return null;
  const mdFile = subject.mindmap && subject.mindmap.file;
  if (!mdFile) { warnings.push("memo 已开启但 subject.json 缺 mindmap.file"); return null; }
  const mdPath = `${subjectDir}/${mdFile}`;
  if (!existsSync(mdPath)) { warnings.push(`memo 已开启但导图文件不存在：${mdPath}`); return null; }
  const kpPath = `${subjectDir}/data/memo_kp.json`;
  const kpMap = existsSync(kpPath) ? JSON.parse(readFileSync(kpPath, "utf8")) : {};
  const { memo, stats } = attachMemo({ md: readFileSync(mdPath, "utf8"), questions, explains, kpMap, warnings });
  return { memo, stats };
}
