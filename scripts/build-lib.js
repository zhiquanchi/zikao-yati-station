// 题库装配共享层（Bun 运行时）：各科目 data/build_data.js 只负责「把自己源 docx 版式解析成规范题目数组」，
// 装配段（并列互换标记、简答精简考点、解析覆盖、产物落盘）全部走这里的共享实现——口径与两站历史逐字一致。
// 判分相关文本（blanks 变体、points 剥标）务必保持词序/原词，否则「原文作答≈满分」锚点会掉分（bun test 守卫）。
import path from "node:path";
import { writeFileSync } from "node:fs";

export function fullRef(s) {
  return String(s || "").trim().replace(/[。；;，,、\s]+$/g, "");
}

// 过滤括号拆解产生的无意义短词：纯中文要求≥3字，含ASCII要求≥2字符
export function useful(v) {
  v = String(v).trim();
  if (!v) return false;
  if (/[一-鿿]/.test(v) && !/[A-Za-z0-9]/.test(v)) return v.length >= 3;
  return v.length >= 2;
}

// 一个填空答案的可接受写法集合：去括号本体、括号内各项、拼接形式。
// opts.orParen：源文本存在「访问控制列表（或ACL）」式写法时（04751 库），先把「（或」规范成「（」以便拆出干净变体。
export function variantsOf(term, opts) {
  term = String(term).trim().replace(/[。；;，,、\s]+$/g, "").replace(/^[。；;，,、\s]+/g, "");
  if (opts && opts.orParen) term = term.replace(/[（(]\s*或\s*/g, "（");
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
export function orderVariants(variants) {
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
export function splitBlanks(ref, n) {
  ref = fullRef(ref);
  const delims = [/、/, /[，,]/, /[；;]/, /\s+/, /[和与及]/];
  for (const d of delims) {
    let parts = ref.split(d).map((p) => p.trim()).filter(Boolean);
    parts = parts.map((p) => p.replace(/[。；;，,、\s]+$/g, ""));
    if (parts.length === n && parts.every((p) => p.length <= 40)) return parts;
  }
  return null;
}

// 并列可互换题标记（data/unordered.json）：ids＝多空题打 unordered:true，判分引擎据此做跨空排列匹配；
// single＝单空题但答案本身是并列/或选枚举，用 orderVariants 追加认可写法（互换/单项），不动判分引擎。
// 有先后/语境锚定的多空题严禁入清单；新增 id 须逐题复核。
export function applyUnordered(questions, unord, warnings) {
  if (!unord) return;
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

// 简答精简考点：人工/大模型提炼的拿分关键词，按 id 覆盖自动拆点结果（选项 {warnMissing} 时缺考点告警）。
// 支持 **关键词** 加粗标记：points 供判分（剥掉标记，与原文逐字一致），pointsMd 供展示。
export function applyEssayPoints(questions, essayPts, warnings, opts) {
  for (const q of questions) {
    if (q.type !== "essay") continue;
    const simp = essayPts[String(q.id)];
    if (Array.isArray(simp) && simp.length) {
      const md = simp.map((p) => String(p).trim());
      q.points = md.map((p) => p.replace(/\*\*/g, ""));
      if (md.some((p) => p.includes("**"))) q.pointsMd = md;
    } else if (opts && opts.warnMissing) warnings.push(`#${q.id} 简答缺精简考点`);
  }
}

// 具体解析落位：主观题人工撰写（data/explanations.json），无手写解析时——
// 单选题沿用源文本解析；{allTypes:true}（13180 口径）主观题也沿用源解析；{warnMissingExplanation:true} 时主观题缺解析告警。
export function applyExplains(questions, expl, warnings, opts) {
  const allTypes = opts && opts.allTypes;
  const warnMissing = opts && opts.warnMissingExplanation;
  if (warnMissing) {
    for (const q of questions) {
      if ((q.type === "blank" || q.type === "essay") && !(String(q.id) in expl)) warnings.push(`#${q.id} 缺解析`);
    }
  }
  for (const q of questions) {
    if (expl[String(q.id)]) q.explain = expl[String(q.id)];
    else if (q.type === "single" || allTypes) q.explain = q.explanation;
  }
}

// 产物落盘：只生成 data/questions.json（服务端装载的唯一题库事实源）。
// 前端不再需要 data.js——题库由 API 下发。
export function writeArtifacts(subjectDir, payload) {
  const outJson = path.join(subjectDir, "data", "questions.json");
  writeFileSync(outJson, JSON.stringify(payload, null, 1), "utf8");
  return { outJson };
}
