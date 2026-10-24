// 考前重点记忆（经典脚本 · 零依赖 · 纯函数，浏览器挂 window.MEMO、bun 挂 globalThis）：
// 把科目 QUIZ_DATA.memo（串讲导图拆出的考点小节＋关联题目 id）与作答记录结合，判断每个考点
// 「是否还有未掌握题」（首次评分 ≥80 才算掌握，与 recite.js/app.js 口径一致），供 app.js 渲染
// 只含知识点的记忆清单——不显示题干、不判分、不改任何记录。
// 只做筛选/统计/搜索，不读写 DOM 与 localStorage。
(function (root) {
  "use strict";

  const MASTER = (root.RECITE && root.RECITE.MASTER) || 80; // 掌握线，与重点优先背/状态筛选同口径
  const LOW = (root.RECITE && root.RECITE.LOW) || 60;      // <60＝答错，60~79＝待提高

  // 单题状态：无记录/未判分＝未作答；≥80＝已掌握；<60＝答错；其余待提高
  function stateOf(rec) {
    const s = rec && typeof rec.s === "number" && Number.isFinite(rec.s) ? rec.s : null;
    if (s == null) return "todo";
    if (s >= MASTER) return "master";
    return s < LOW ? "wrong" : "mid";
  }

  function labelOf(status) {
    return { pending: "未掌握", master: "已掌握", wrong: "答错", mid: "待提高", todo: "未作答" }[status] || "未掌握";
  }

  // build：memo 为 QUIZ_DATA.memo，store 为按题号索引的作答记录
  // 返回 {chapters:[{name, sections:[{id,title,types,items,ids,status,pendingIds,by}], pending, total}], counts}
  // status：该考点挂的题里只要还有未达 80 的（或根本没挂题）＝pending（未掌握），否则 master。
  function build(memo, store) {
    const counts = { chapters: 0, sections: 0, pending: 0, master: 0, questions: 0, mastered: 0, wrong: 0, mid: 0, todo: 0, draft: 0 };
    const seen = new Set();
    const chapters = [];
    for (const ch of (memo && memo.chapters) || []) {
      const row = { name: ch.name, sections: [], pending: 0, total: 0 };
      for (const sec of ch.sections || []) {
        const ids = Array.isArray(sec.ids) ? sec.ids : [];
        const by = { wrong: 0, mid: 0, todo: 0 };
        const pendingIds = [];
        for (const id of ids) {
          const st = stateOf(store && store[id]);
          if (st === "master") {
            if (!seen.has(id)) { seen.add(id); counts.mastered++; }
            continue;
          }
          by[st]++;
          pendingIds.push(id);
          if (seen.has(id)) continue;
          seen.add(id);
          counts[st]++;
          if (st === "todo") {
            const rec = store && store[id];
            if (rec && rec.u != null) counts.draft++; // 有草稿没提交：仍算未作答，统计里单独提示
          }
        }
        const status = !ids.length || pendingIds.length ? "pending" : "master";
        row.sections.push({ id: sec.id, title: sec.title, types: sec.types || [], items: sec.items || [], ids, status, pendingIds, by });
        row.total++;
        counts.sections++;
        if (status === "pending") { row.pending++; counts.pending++; } else counts.master++;
      }
      chapters.push(row);
      counts.chapters++;
    }
    counts.questions = counts.mastered + counts.wrong + counts.mid + counts.todo;
    return { chapters, counts };
  }

  // 界面筛选：status 取 all / pending / master；keyword 命中考点标题、编号或任一知识点文字
  function filter(view, opts) {
    const status = (opts && opts.status) || "pending";
    const kw = String((opts && opts.keyword) || "").trim().toLowerCase();
    const hit = (s) => !kw || String(s == null ? "" : s).toLowerCase().includes(kw);
    const chapters = [];
    let shown = 0;
    for (const ch of (view && view.chapters) || []) {
      const sections = ch.sections.filter((sec) =>
        (status === "all" || sec.status === status) &&
        (!kw || hit(sec.title) || hit(sec.id) || (sec.items || []).some((it) => hit(it.t))));
      if (!sections.length) continue;
      shown += sections.length;
      chapters.push({ name: ch.name, pending: ch.pending, total: ch.total, sections });
    }
    return { chapters, counts: view.counts, shown };
  }

  const api = { MASTER, LOW, stateOf, labelOf, build, filter };
  root.MEMO = api; // 浏览器挂 window、Bun 测试挂 globalThis
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
