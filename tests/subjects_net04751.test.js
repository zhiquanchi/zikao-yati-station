// 04751 计算机网络安全题库精选边界用例（bun test）：迁移自旧单站测试；通用不变量见 grading.test.js 逐科目循环。
import { describe, it, expect } from "bun:test";
import "../frontend/grading.js";
import data from "../subjects/net04751/data/questions.json";

const G = globalThis.GRADER;
const byId = Object.fromEntries(data.questions.map((q) => [q.id, q]));

describe("网络安全：题库规模与题型", () => {
  it("205 题（105 单选 / 70 填空 / 30 简答）", () => {
    expect(data.questions.length).toBe(205);
    expect(data.questions.filter((q) => q.type === "single").length).toBe(105);
    expect(data.questions.filter((q) => q.type === "blank").length).toBe(70);
    expect(data.questions.filter((q) => q.type === "essay").length).toBe(30);
  });
});

describe("网络安全：填空精确口径", () => {
  it("答案须完全一致：错填不得分", () => {
    expect(G.gradeBlanks(["可执行"], byId[110]).score).toBe(100);
    expect(G.gradeBlanks(["系统"], byId[110]).score).toBe(0);
    expect(G.gradeBlanks(["X-Probe"], byId[216]).score).toBe(100);
    expect(G.gradeBlanks(["Windows"], byId[216]).score).toBe(0);
  });
  it("认可写法变体：括号拆词与全半角/大小写/空格容错", () => {
    expect(G.gradeBlanks(["访问控制列表"], byId[133]).score).toBe(100);
    expect(G.gradeBlanks(["ACL"], byId[133]).score).toBe(100);
    expect(G.gradeBlanks(["acl"], byId[133]).score).toBe(100);
    expect(G.gradeBlanks(["SYN"], byId[205]).score).toBe(100);
    expect(G.gradeBlanks(["syn"], byId[205]).score).toBe(100);
  });
  it("数值答案 % 变体互通", () => {
    expect(G.gradeBlanks(["25"], byId[167]).score).toBe(100); // 源答案 25%
    expect(G.gradeBlanks(["25%"], byId[172]).score).toBe(100); // 源答案 25、题干带％
  });
  it("单空「A和B」（single 清单）：互换顺序即对，错答仍错", () => {
    expect(G.gradeBlanks(["策略和管理"], byId[222]).score).toBe(100);
    expect(G.gradeBlanks(["管理" + "和" + "策略"], byId[222]).score).toBe(100); // orderVariants 追加的互换写法
    expect(G.gradeBlanks(["技术和管理"], byId[222]).score).toBe(0);
  });
});

describe("网络安全：简答与单选锚点", () => {
  it("无关作答接近零分", () => {
    expect(G.gradeEssay("今天天气不错我们出去玩", byId[192].points).score).toBeLessThanOrEqual(10);
    expect(G.gradeEssay("", byId[192].points).score).toBe(0);
  });
  it("列举式要点作答能拿分", () => {
    const s = G.gradeEssay("机房环境安全、通信线路安全、设备安全、电源安全", byId[192].points).score;
    expect(s).toBeGreaterThanOrEqual(90);
  });
  it("#76 已修正为标准结论 n(n-1)/2", () => {
    expect(byId[76].answer).toBe("C");
    expect(byId[76].options[2].text).toBe("n(n-1)/2");
  });
  it("抽题单选判分正确", () => {
    for (const id of [1, 52, 76, 105]) {
      expect(G.gradeSingle(byId[id].answer, byId[id].answer).score).toBe(100);
      const wrong = "ABCD".split("").find((k) => k !== byId[id].answer);
      expect(G.gradeSingle(wrong, byId[id].answer).score).toBe(0);
    }
  });
});
