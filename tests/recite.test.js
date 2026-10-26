// 重点优先背排序纯函数（frontend/recite.js）：未掌握判定 + 薄弱优先排序 + 筛选计数。
import { describe, it, expect } from "bun:test";
import "../frontend/recite.js";
import data from "../subjects/net04751/data/questions.json";
import netSubject from "../subjects/net04751/subject.json";

const R = globalThis.RECITE;
const QS = data.questions;
const ids = (queue) => queue.map((e) => e.id);

// 合成题：只关心类型/题号，排序逻辑与题库内容无关
const synth = [
  { id: 1, type: "single" }, { id: 2, type: "blank" }, { id: 3, type: "essay" },
  { id: 4, type: "single" }, { id: 5, type: "essay" }, { id: 6, type: "blank" },
  { id: 7, type: "single" },
];

describe("重点优先背 · 未掌握判定（掌握线 ≥80，与状态筛选一致）", () => {
  it("无记录＝全部未作答", () => {
    const q = R.build(QS, {});
    expect(q.length).toBe(205);
    expect(q.every((e) => e.group === "todo")).toBe(true);
    expect(R.counts(q)).toEqual({ total: 205, wrong: 0, mid: 0, todo: 205, single: 105, blank: 70, essay: 30 });
  });

  it("<60 答错、60~79 待提高、≥80 已掌握移出队列", () => {
    const q = R.build(synth, {
      1: { s: 0 }, 2: { s: 59 }, 3: { s: 60 }, 4: { s: 79 }, 5: { s: 80 }, 6: { s: 100 }, 7: null,
    });
    expect(ids(q)).toEqual([1, 2, 3, 4, 7]);
    expect(q.map((e) => e.group)).toEqual(["wrong", "wrong", "mid", "mid", "todo"]);
  });

  it("非数字分数（脏记录）按未作答处理，不炸", () => {
    const q = R.build(synth, { 1: { s: "80" }, 2: { s: NaN }, 3: { s: null }, 4: {} });
    expect(q.every((e) => e.group === "todo")).toBe(true);
    expect(q.every((e) => e.score === null)).toBe(true);
  });

  it("有草稿未提交＝未作答档，带 draft 标记", () => {
    const q = R.build(synth, { 1: { u: "选A", s: null, ts: 1 } });
    expect(q.find((e) => e.id === 1)).toMatchObject({ group: "todo", draft: true, viewed: false });
  });

  it("看过解析标记 viewed 透传", () => {
    const q = R.build(synth, { 3: { s: 40, v: 123 } });
    expect(q.find((e) => e.id === 3)).toMatchObject({ group: "wrong", viewed: true });
  });
});

describe("重点优先背 · 优先级排序", () => {
  it("分组优先：答错 → 待提高 → 未作答", () => {
    const q = R.build(synth, { 1: { s: 70 }, 2: { s: 20 }, 7: { s: 75 } });
    expect(q.map((e) => e.group)).toEqual(["wrong", "mid", "mid", "todo", "todo", "todo", "todo"]);
    expect(ids(q).slice(0, 3)).toEqual([2, 1, 7]); // 答错在前；待提高低分在前
  });

  it("答错同组低分在前", () => {
    const q = R.build(synth, { 1: { s: 55 }, 2: { s: 5 }, 3: { s: 30 } });
    expect(ids(q).slice(0, 3)).toEqual([2, 3, 1]); // 5 < 30 < 55
  });

  it("同分同档先背大题：简答 > 填空 > 单选", () => {
    const q = R.build(synth, { 1: { s: 0 }, 2: { s: 0 }, 3: { s: 0 } });
    expect(ids(q).slice(0, 3)).toEqual([3, 2, 1]);
  });

  it("未作答里看过解析的优先", () => {
    const q = R.build(synth, { 1: { u: "x", s: null, v: 1 } }); // 单选但看过解析
    expect(ids(q)[0]).toBe(1); // 排在未看解析的简答之前
    expect(q[0]).toMatchObject({ group: "todo", viewed: true });
  });

  it("同档同分同题型按题号稳定升序", () => {
    const q = R.build(
      [{ id: 9, type: "single" }, { id: 3, type: "single" }, { id: 7, type: "single" }],
      { 9: { s: 0 }, 3: { s: 0 }, 7: { s: 0 } }
    );
    expect(ids(q)).toEqual([3, 7, 9]);
  });

  it("真实题库：无记录时先 30 简答、再 70 填空、最后 105 单选", () => {
    const q = R.build(QS, {});
    expect(q.slice(0, 30).every((e) => e.type === "essay")).toBe(true);
    expect(q.slice(30, 100).every((e) => e.type === "blank")).toBe(true);
    expect(q.slice(100).every((e) => e.type === "single")).toBe(true);
  });
});

describe("重点优先背 · 筛选与计数", () => {
  const queue = R.build(synth, { 1: { s: 0 }, 2: { s: 70 }, 3: { s: 40 }, 4: { s: 75 } });
  it("按分组筛选", () => {
    expect(ids(R.filter(queue, { group: "wrong" }))).toEqual([1, 3]);
    expect(ids(R.filter(queue, { group: "mid" }))).toEqual([2, 4]);
    expect(R.filter(queue, { group: "todo" }).length).toBe(3);
  });
  it("按题型筛选（可与分组叠加）", () => {
    expect(R.filter(queue, { type: "single" }).every((e) => e.type === "single")).toBe(true);
    expect(ids(R.filter(queue, { group: "wrong", type: "essay" }))).toEqual([3]);
  });
  it("all 等同于不过滤；非法值回落 all", () => {
    expect(R.filter(queue, { group: "all", type: "all" }).length).toBe(queue.length);
    expect(R.filter(queue, {}).length).toBe(queue.length);
  });
  it("counts 统计三档与三题型", () => {
    expect(R.counts(queue)).toEqual({ total: 7, wrong: 2, mid: 2, todo: 3, single: 3, blank: 2, essay: 2 });
  });
  it("labelOf 中文档位", () => {
    expect(R.labelOf("wrong")).toBe("答错");
    expect(R.labelOf("mid")).toBe("待提高");
    expect(R.labelOf("todo")).toBe("未作答");
  });
});

describe("重点优先背 · 科目开关", () => {
  it("04751 计算机网络安全已开启 flags.recite", () => {
    expect(netSubject.flags.recite).toBe(true);
  });
  it("阈值常量与状态筛选口径一致", () => {
    expect(R.MASTER).toBe(80);
    expect(R.LOW).toBe(60);
    expect(R.groupOf({ s: 79 })).toBe("mid");
    expect(R.groupOf({ s: 80 })).toBe(null);
  });
});
