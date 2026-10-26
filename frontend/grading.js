// 判分引擎：填空题答案完全一致 + 简答题得分点覆盖率打分。纯函数，无 DOM 依赖。
(function (root) {
  "use strict";

  // 虚词/高频套话字：组成的二字组合不计入要点特征（如“的操作”“系统”）
  const STOP = new Set("的了和与及是在有等指为对将把被从这那其个中通过然后并且或者但如因于用则而之要能会可各所统".split(""));
  const PUNCT = /[。，、；：？！“”‘’（）()《》〈〉【】〔〕｛｝{}·…—～\-_/\\'"`~!@#$%^&*+=<>|;:,.\s\u3000]/g;

  function fw2h(s) {
    return s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
             .replace(/\u3000/g, " ");
  }
  // 扁平化：小写、去空白标点，只留汉字/字母/数字（用于子串包含判断）
  function flat(s) {
    return fw2h(String(s || "")).toLowerCase().replace(/[\s\u3000]+/g, "").replace(PUNCT, "").replace(/[\s\u3000]+/g, "");
  }
  // 分词：CJK 二字组合 + 字母数字词（要点特征）
  function tokens(s) {
    const bi = new Set(), la = new Set();
    const text = fw2h(String(s || "")).toLowerCase();
    for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
      for (let i = 0; i + 1 < run.length; i++) {
        const g = run.slice(i, i + 2);
        if (!STOP.has(g[0]) && !STOP.has(g[1])) bi.add(g);
      }
    }
    for (const w of text.match(/[a-z0-9]+/g) || []) if (w.length >= 2) la.add(w);
    return { bi, la, n: bi.size + la.size };
  }

  // 求两段文本互配的公共片段（长度≥min），用于高亮已答到的内容
  function commonRuns(a, b, min) {
    min = min || 3;
    const runs = [];
    let used = new Array(b.length).fill(false);
    let sa = a, sb = b;
    while (sa.length >= min && sb.length >= min) {
      // 最长公共子串 DP（滚动数组）
      let best = 0, endA = 0;
      let prev = new Array(sb.length + 1).fill(0);
      for (let i = 1; i <= sa.length; i++) {
        const cur = new Array(sb.length + 1).fill(0);
        for (let j = 1; j <= sb.length; j++) {
          if (sa[i - 1] === sb[j - 1] && !used[j - 1]) {
            cur[j] = prev[j - 1] + 1;
            if (cur[j] > best) { best = cur[j]; endA = i; }
          }
        }
        prev = cur;
      }
      if (best < min) break;
      const seg = sa.slice(endA - best, endA);
      const pos = sb.indexOf(seg);
      for (let k = pos; k < pos + seg.length && k < sb.length; k++) used[k] = true;
      runs.push(seg);
      sa = sa.replace(seg, ""); // 粗粒度防重复；片段不重叠即可
    }
    return runs;
  }

  // 单个得分点与用户整题答案的匹配度 0~1；ctx={df:Map(二字组合→出现的点数), total} 提供 IDF 加权
  function pointCoverage(point, userText, ctx) {
    const pf = flat(point), uf = flat(userText);
    if (!uf) return { cov: 0, segs: [] };
    let cov = 0;
    const pt = tokens(point), ut = tokens(userText);
    if (pt.n > 0) {
      let hit = 0, tot = 0;
      const weight = (g) => {
        if (!ctx || !ctx.total) return 1;
        const df = ctx.df.get(g) || 0;
        return 1 + 1.5 * (1 - df / ctx.total); // 越独特的词命中越值钱
      };
      pt.bi.forEach((g) => { const w = weight(g); tot += w; if (ut.bi.has(g)) hit += w; });
      pt.la.forEach((w0) => { tot += 1; if (ut.la.has(w0)) hit += 1; });
      cov = hit / tot;
    }
    // 字面重合度兜底：概括性作答时按内容字的覆盖比例给分（短要点权重更高）
    {
      const chars = new Set(pf.split("").filter((c) => /[\u4e00-\u9fff]/.test(c) && !STOP.has(c)));
      if (chars.size) {
        let h = 0;
        chars.forEach((c) => { if (uf.includes(c)) h++; });
        cov = Math.max(cov, (h / chars.size) * (pt.n <= 10 ? 0.9 : 0.7));
      }
    }
    if (pf.length >= 4 && uf.includes(pf)) cov = 1;                 // 整点原文抄出
    else if (uf.length >= 2 && pf.includes(uf)) cov = Math.max(cov, uf.length / pf.length);
    const lead = (point.match(/^([^：:，,、。\s]{2,10})[：:]/) || [])[1];
    if (lead) {
      const lf = flat(lead);
      let ls = 0;
      if (uf.includes(lf)) ls = 1;
      else {
        const lt = tokens(lf);
        if (lt.n) {
          let h = 0;
          lt.bi.forEach((g) => { if (ut.bi.has(g)) h++; });
          ls = h / lt.n;
        }
      }
      if (ls >= 0.6) cov = Math.max(cov, 0.6);                       // 答出要点标题词记部分命中
    }
    cov = Math.min(1, cov);
    return { cov, segs: commonRuns(uf, pf, 3) };
  }

  // 覆盖度 → 状态（与简答 UI 共用同一阈值）
  function stateOf(cov) { return cov >= 0.5 ? "hit" : cov >= 0.22 ? "part" : "miss"; }
  // 为一组得分点构建 IDF 上下文
  function ctxFor(points) {
    const df = new Map();
    points.forEach((p) => tokens(p).bi.forEach((g) => df.set(g, (df.get(g) || 0) + 1)));
    return { df, total: points.length };
  }

  // 简答评分：points 为参考答案拆分出的得分点数组
  function gradeEssay(userText, points) {
    const ctx = ctxFor(points);
    const per = points.map((p) => {
      const r = pointCoverage(p, userText, ctx);
      return { text: p, cov: r.cov, segs: r.segs, state: stateOf(r.cov) };
    });
    const score = Math.round((per.reduce((s, x) => s + x.cov, 0) / per.length) * 100);
    return { score, per };
  }

  // 严格比较用的归一化：仅容忍全/半角、大小写与空白（空格是输入法噪声，不参与比较），
  // 其余必须逐字一致——不做标点删除、不做包含/近似匹配
  function normStrict(s) {
    return fw2h(String(s || "")).toLowerCase().replace(/\s+/g, "");
  }

  // 单个填空：必须与某个候选答案变体完全一致才得分（变体即题库认可的可接受答案，如 RR＝时间片轮转法）；
  // loose=true 仅限 fallback（拆不出空、候选词为整句参考答案），用包含匹配兜底
  function blankMatch(userInput, variants, loose) {
    const un = normStrict(userInput);
    if (!un) return false;
    for (const v of variants) {
      const vn = normStrict(v);
      if (!vn) continue;
      if (un === vn) return true;
      if (loose && ((vn.length >= 2 && un.includes(vn)) || (un.length >= 2 && vn.includes(un)))) return true;
    }
    return false;
  }

  // 填空题整题评分；fallback=true 时候选词为整句参考答案（拆不出空时用包含匹配）。
  // unordered=true（并列枚举题，标记来自 data/unordered.json）允许空位间互换：
  // 枚举「输入→空位」的全部指派排列、取全等命中数最大者；每空仍是 blankMatch 逐字完全一致口径，不放宽单空标准
  function gradeBlanks(inputs, q) {
    const n = q.blanks.length;
    const loose = !!q.fallback;
    const matchAt = (inpIdx, slotIdx) => blankMatch(inputs[inpIdx] || "", q.blanks[slotIdx], loose);
    let order = q.blanks.map((_, i) => i); // order[输入号] = 指派到的空位号；默认按位置对齐
    if (q.unordered && !loose && n >= 2 && n <= 7) {
      let bestHits = -1;
      const used = new Array(n).fill(false);
      const cur = new Array(n);
      const rec = (fixed) => {
        if (fixed === n) {
          let hits = 0;
          for (let i = 0; i < n; i++) if (matchAt(i, cur[i])) hits++;
          if (hits > bestHits) { bestHits = hits; order = cur.slice(); } // 严格大于：平局保留先枚举的自然序
          return;
        }
        for (let s = 0; s < n; s++) {
          if (used[s]) continue;
          used[s] = true; cur[fixed] = s; rec(fixed + 1); used[s] = false;
        }
      };
      rec(0);
    }
    const per = q.blanks.map((variants, i) => ({
      ok: matchAt(i, order[i]),
      input: (inputs[i] || "").trim(),
      expect: variants[0],
    }));
    return { score: Math.round((per.filter((p) => p.ok).length / per.length) * 100), per };
  }

  function gradeSingle(choice, answer) {
    return { score: choice === answer ? 100 : 0 };
  }

  const api = { fw2h, flat, tokens, pointCoverage, gradeEssay, blankMatch, gradeBlanks, gradeSingle, commonRuns, stateOf, ctxFor };
  root.GRADER = api; // 浏览器挂 window、Bun/Node 挂 globalThis
  if (typeof module !== "undefined" && module.exports) module.exports = api; // 兼容 require
})(typeof window !== "undefined" ? window : globalThis);
