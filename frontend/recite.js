// 重点优先背（经典脚本 · 零依赖 · 纯函数，浏览器挂 window.RECITE、bun 挂 globalThis）：
// 从作答记录推导「未掌握」题并按薄弱程度排序——答错（分低在前）→ 待提高（60~79）→ 未作答；
// 同档简答/填空先背（分值高、更易失分），未作答里点开过解析的优先（已暴露但没练）。
// 掌握线 80 与状态筛选「已掌握 ≥80」一致：达到即移出背题队列（成绩只记首次，见 app.js）。
// 只做排序/筛选/计数，不读写 DOM 与 localStorage；界面与持久化由 app.js 负责。
(function (root) {
  "use strict";

  const MASTER = 80; // 掌握线：>=80 不进队列（与 passFilters 的「已掌握」口径一致）
  const LOW = 60;    // <60＝答错（待提高）；60~79＝待提高
  const GROUP_RANK = { wrong: 0, mid: 1, todo: 2 };
  const TYPE_RANK = { essay: 0, blank: 1, single: 2 }; // 同档先背大题：简答>填空>单选

  // 单题分组：已掌握返回 null（不进背题队列）；无分数/无记录＝未作答
  function groupOf(rec) {
    const s = rec && typeof rec.s === "number" && Number.isFinite(rec.s) ? rec.s : null;
    if (s == null) return "todo";
    if (s >= MASTER) return null;
    return s < LOW ? "wrong" : "mid";
  }

  function labelOf(group) {
    return { wrong: "答错", mid: "待提高", todo: "未作答" }[group] || "未作答";
  }

  // 排序：分组优先（答错>待提高>未作答）→ 同组低分在前 → 未作答看「看过解析」→ 题型（简答>填空>单选）→ 题号稳定
  function compare(a, b) {
    if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (a.score != null && b.score != null && a.score !== b.score) return a.score - b.score;
    if (a.group === "todo" && a.viewed !== b.viewed) return a.viewed ? -1 : 1;
    const t = (TYPE_RANK[a.type] == null ? 9 : TYPE_RANK[a.type]) - (TYPE_RANK[b.type] == null ? 9 : TYPE_RANK[b.type]);
    if (t) return t;
    return a.id - b.id;
  }

  // build：questions 为 QUIZ_DATA.questions，store 为 localStorage 里按题号索引的作答记录
  // 返回 [{id,type,group,score,viewed,draft}]，已按优先级排好；不改入参
  function build(questions, store) {
    const out = [];
    for (const q of questions || []) {
      const rec = store && store[q.id];
      const group = groupOf(rec);
      if (!group) continue; // 已掌握
      const s = rec && typeof rec.s === "number" && Number.isFinite(rec.s) ? rec.s : null;
      out.push({
        id: q.id,
        type: q.type,
        group,
        score: s,
        viewed: !!(rec && rec.v),
        draft: !!(rec && rec.u != null && s == null), // 有草稿未提交：仍是未作答档，但界面提示
      });
    }
    out.sort(compare);
    return out;
  }

  // 界面筛选：group/type 取 "all" 或具体值
  function filter(queue, opts) {
    const g = (opts && opts.group) || "all";
    const t = (opts && opts.type) || "all";
    return (queue || []).filter((e) => (g === "all" || e.group === g) && (t === "all" || e.type === t));
  }

  // 计数：总量/三档/三题型（题型按当前队列统计）
  function counts(queue) {
    const c = { total: 0, wrong: 0, mid: 0, todo: 0, single: 0, blank: 0, essay: 0 };
    for (const e of queue || []) {
      c.total++;
      if (c[e.group] != null) c[e.group]++;
      if (c[e.type] != null) c[e.type]++;
    }
    return c;
  }

  const api = { MASTER, LOW, GROUP_RANK, TYPE_RANK, groupOf, labelOf, build, filter, counts };
  root.RECITE = api; // 浏览器挂 window、Bun 测试挂 globalThis
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
