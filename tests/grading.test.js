// 判分引擎回归（bun test）：科目无关的合成用例测引擎口径；
// 数据不变量对 subjects/ 下每一科目循环校验（标准答案满分、简答原文≈满分锚点、unordered 轮换、结构完整）。
import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import "../frontend/grading.js"; // 副作用：设置 globalThis.GRADER
import { loadSubjects } from "../scripts/config.js";

const G = globalThis.GRADER;

describe("引擎口径（合成题）", () => {
  it("单选：选对满分、选错零分", () => {
    expect(G.gradeSingle("A", "A").score).toBe(100);
    expect(G.gradeSingle("A", "B").score).toBe(0);
  });
  it("填空：逐字一致才给分，全半角/大小写/空格容错，无包含匹配", () => {
    const q = { blankCount: 2, blanks: [["硬件资源"], ["软件资源"]] };
    expect(G.gradeBlanks(["硬件资源", "软件资源"], q).score).toBe(100);
    expect(G.gradeBlanks(["硬件", "软件"], q).score).toBe(0);
    expect(G.gradeBlanks(["硬件资源 ", "软件资源"], q).score).toBe(100); // 尾空格容忍
    const en = { blankCount: 1, blanks: [["batch processing"]] };
    expect(G.gradeBlanks(["BatchProcessing"], en).score).toBe(100);
    expect(G.gradeBlanks(["批处理"], en).score).toBe(0);
  });
  it("填空：fallback（整句参考答案）保留包含匹配兜底", () => {
    const q = { fallback: true, blanks: [["时间片轮转法调度算法"]] };
    expect(G.gradeBlanks(["采用时间片轮转法调度算法"], q).score).toBe(100);
    expect(G.gradeBlanks(["先来先服务调度算法"], q).score).toBe(0);
  });
  it("填空：unordered 标记跨空互换满分且不放宽逐字口径；未标记位置严格", () => {
    const un = { unordered: true, blankCount: 2, blanks: [["硬件资源"], ["软件资源"]] };
    expect(G.gradeBlanks(["软件资源", "硬件资源"], un).score).toBe(100);
    expect(G.gradeBlanks(["软件资源", "软件资源"], un).score).toBe(50);
    const strict = { blankCount: 2, blanks: [["进程"], ["线程"]] };
    expect(G.gradeBlanks(["线程", "进程"], strict).score).toBe(0);
  });
  it("简答：空答零分、乱答接近零分、要点覆盖部分得分", () => {
    const points = ["并发：宏观同时微观串行", "共享：资源供多程序共用"];
    expect(G.gradeEssay("", points).score).toBe(0);
    expect(G.gradeEssay("今天天气不错我们出去玩", points).score).toBeLessThanOrEqual(10);
    const s = G.gradeEssay("并发", points).score;
    expect(s > 0 && s < 100).toBe(true);
  });
  it("stateOf 阈值与 Go 侧 normalize 同口径（hit≥0.5、part≥0.22）", () => {
    expect(G.stateOf(0.5)).toBe("hit");
    expect(G.stateOf(0.49)).toBe("part");
    expect(G.stateOf(0.22)).toBe("part");
    expect(G.stateOf(0.21)).toBe("miss");
  });
});

// ——— 逐科目数据不变量 ———
for (const s of loadSubjects()) {
  if (!existsSync(path.join(s.dir, "data/questions.json"))) {
    // new-subject 刚建的骨架科目（尚无题库）跳过；部署链路会在 bun run build 处强制补齐
    continue;
  }
  const data = JSON.parse(readFileSync(path.join(s.dir, "data/questions.json"), "utf8"));
  const unordPath = path.join(s.dir, "data/unordered.json");
  const unord = existsSync(unordPath) ? JSON.parse(readFileSync(unordPath, "utf8")) : { ids: [], single: [] };
  const singles = data.questions.filter((q) => q.type === "single");
  const blanks = data.questions.filter((q) => q.type === "blank");
  const essays = data.questions.filter((q) => q.type === "essay");

  describe(`${s.slug}（${s.name}）数据不变量`, () => {
    it("meta 注入正确且三类题型齐全", () => {
      expect(data.meta.storageKey).toBe(s.storageKey);
      expect(data.meta.prefix).toBe(s.prefix);
      expect(singles.length).toBeGreaterThan(0);
      expect(blanks.length).toBeGreaterThan(0);
      expect(essays.length).toBeGreaterThan(0);
    });
    it("单选：四选项 ABCD 齐备、答案落在选项内", () => {
      for (const q of singles) {
        expect(q.options.length).toBe(4);
        expect(q.options.map((o) => o.key).join("")).toBe("ABCD");
        expect(q.options.some((o) => o.key === q.answer)).toBe(true);
      }
    });
    it("填空：blanks 组数与空数一致、组内有候选；标准答案作答均满分", () => {
      for (const q of blanks) {
        expect(q.blanks.length).toBe(q.blankCount);
        for (const vs of q.blanks) expect(vs.length >= 1 && vs[0].length > 0).toBe(true);
        expect(G.gradeBlanks(q.blanks.map((v) => v[0]), q).score).toBe(100);
      }
    });
    it("简答：有得分点与参考答案；按参考答案原文作答均为高分（≥95 锚点）", () => {
      for (const q of essays) {
        expect(q.points.length >= 1).toBe(true);
        expect(q.ref.length > 0).toBe(true);
        expect(G.gradeEssay(q.ref, q.points).score).toBeGreaterThanOrEqual(95);
      }
    });
    it("unordered 标记题：标准答案任意轮换均满分；清单全部有效", () => {
      for (const q of data.questions.filter((x) => x.unordered)) {
        const ans = q.blanks.map((v) => v[0]);
        for (let k = 0; k < ans.length; k++) {
          const rot = ans.slice(k).concat(ans.slice(0, k));
          expect(G.gradeBlanks(rot, q).score).toBe(100);
        }
      }
      for (const id of unord.ids || []) {
        const q = data.questions.find((x) => x.id === id);
        expect(!!q && q.type === "blank" && q.blanks.length >= 2 && !q.fallback && q.unordered === true).toBe(true);
      }
      for (const id of unord.single || []) {
        const q = data.questions.find((x) => x.id === id);
        expect(!!q && q.type === "blank" && q.blanks.length === 1).toBe(true);
        expect(q.blanks[0].length).toBeGreaterThan(1); // orderVariants 已追加认可写法
      }
      expect(data.questions.filter((q) => q.unordered).length).toBe((unord.ids || []).length);
    });
    it("单选题必有解析文本（前端内联展示依赖）", () => {
      for (const q of singles) expect(typeof q.explain === "string" && q.explain.length > 0).toBe(true);
    });
  });
}
