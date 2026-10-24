// 考前重点记忆纯函数（web/memo.js）：按作答记录把考点小节分成「未掌握 / 已掌握」，
// 口径与重点优先背一致（首次评分 ≥80 即掌握），并测筛选/统计/草稿计数。
import { describe, it, expect } from "bun:test";
import "../web/recite.js";
import "../web/memo.js";

const M = globalThis.MEMO;

const memo = {
  chapters: [
    {
      name: "第一章",
      sections: [
        { id: "1.1", title: "概念", types: ["单选"], items: [{ d: 0, t: "**定义**：OS 是系统软件" }, { d: 1, t: "子要点" }], ids: [1, 2] },
        { id: "1.2", title: "发展", types: ["填空"], items: [{ d: 0, t: "计算机四代" }], ids: [3] },
      ],
    },
    { name: "第二章", sections: [{ id: "2.1", title: "层次结构", types: [], items: [], ids: [] }] },
  ],
};

describe("考前重点记忆：掌握度分档", () => {
  it("≥80 掌握；60~79 待提高；<60 答错；无记录＝未作答", () => {
    expect(M.stateOf({ s: 100 })).toBe("master");
    expect(M.stateOf({ s: 80 })).toBe("master");
    expect(M.stateOf({ s: 79 })).toBe("mid");
    expect(M.stateOf({ s: 60 })).toBe("mid");
    expect(M.stateOf({ s: 59 })).toBe("wrong");
    expect(M.stateOf({ s: 0 })).toBe("wrong");
    expect(M.stateOf(null)).toBe("todo");
    expect(M.stateOf({ u: "只有草稿" })).toBe("todo");
    expect(M.MASTER).toBe(80);
  });

  it("考点还有未掌握题＝未掌握；全部 ≥80＝已掌握；没挂题的考点也留在未掌握", () => {
    const store = { 1: { s: 100 }, 2: { s: 0 }, 3: { s: 90 } };
    const v = M.build(memo, store);
    const [s11, s12] = v.chapters[0].sections;
    expect(s11.status).toBe("pending");
    expect(s11.by).toEqual({ wrong: 1, mid: 0, todo: 0 });
    expect(s11.pendingIds).toEqual([2]);
    expect(s12.status).toBe("master");
    expect(v.chapters[1].sections[0].status).toBe("pending"); // 没挂题：无法判定掌握，按未掌握展示
    expect(v.counts).toMatchObject({ chapters: 2, sections: 3, pending: 2, master: 1, questions: 3, mastered: 2, wrong: 1, mid: 0, todo: 0 });
  });

  it("同一道题挂在多个考点时只统计一次", () => {
    const two = { chapters: [{ name: "第一章", sections: [
      { id: "1.1", title: "甲", items: [], ids: [7] },
      { id: "1.2", title: "乙", items: [], ids: [7] },
    ] }] };
    const v = M.build(two, {});
    expect(v.counts.questions).toBe(1);
    expect(v.counts.todo).toBe(1);
    expect(v.counts.pending).toBe(2); // 两个考点都因这题未作答而留在清单里
  });

  it("有草稿未提交的未作答单独计数，但不改变未掌握判定", () => {
    const v = M.build(memo, { 2: { u: "草稿", s: null } });
    expect(v.counts.draft).toBe(1);
    expect(v.counts.todo).toBe(3); // 3 道题都没成绩
    expect(v.chapters[0].sections[0].status).toBe("pending");
  });

  it("不改入参", () => {
    const snapshot = JSON.stringify(memo);
    M.build(memo, { 1: { s: 100 } });
    expect(JSON.stringify(memo)).toBe(snapshot);
  });
});

describe("考前重点记忆：筛选与搜索", () => {
  const view = () => M.build(memo, { 1: { s: 100 }, 2: { s: 0 }, 3: { s: 90 } });

  it("按状态筛选", () => {
    expect(M.filter(view(), { status: "pending" }).shown).toBe(2);
    expect(M.filter(view(), { status: "master" }).shown).toBe(1);
    expect(M.filter(view(), { status: "all" }).shown).toBe(3);
    expect(M.filter(view(), { status: "all" }).chapters.length).toBe(2);
    expect(M.filter(view(), { status: "master" }).chapters.length).toBe(1);
  });

  it("关键词命中考点标题、编号或任一知识点文字", () => {
    expect(M.filter(view(), { status: "all", keyword: "子要点" }).shown).toBe(1);
    expect(M.filter(view(), { status: "all", keyword: "1.2" }).shown).toBe(1);
    expect(M.filter(view(), { status: "all", keyword: "发展" }).shown).toBe(1);
    expect(M.filter(view(), { status: "all", keyword: "层次结构" }).shown).toBe(1);
    expect(M.filter(view(), { status: "all", keyword: "不存在的词" }).shown).toBe(0);
    expect(M.filter(view(), { status: "all", keyword: "   " }).shown).toBe(3); // 空白关键词＝不过滤
  });

  it("筛掉的章节整章不出现，筛选结果保留原章节顺序", () => {
    const f = M.filter(view(), { status: "pending" });
    expect(f.chapters.map((c) => c.name)).toEqual(["第一章", "第二章"]);
    expect(f.chapters[0].sections.map((s) => s.id)).toEqual(["1.1"]);
  });
});
