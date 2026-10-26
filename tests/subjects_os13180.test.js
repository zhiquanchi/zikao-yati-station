// 13180 操作系统题库精选边界用例（bun test）：迁移自旧单站测试；通用不变量见 grading.test.js 逐科目循环。
import { describe, it, expect } from "bun:test";
import "../frontend/grading.js";
import data from "../subjects/os13180/data/questions.json";
import unord from "../subjects/os13180/data/unordered.json";

const G = globalThis.GRADER;
const byId = Object.fromEntries(data.questions.map((q) => [q.id, q]));

describe("操作系统：填空精确口径", () => {
  it("答案须完全一致：漏字、多字均不得分", () => {
    expect(G.gradeBlanks(["硬件资源", "软件资源"], byId[5]).score).toBe(100);
    expect(G.gradeBlanks(["硬件", "软件"], byId[5]).score).toBe(0);
    expect(G.gradeBlanks(["内存", "外存"], byId[5]).score).toBe(0);
    expect(G.gradeBlanks(["时间片轮转"], byId[72]).score).toBe(0); // 少一个“法”字
    expect(G.gradeBlanks(["时间片轮转法"], byId[72]).score).toBe(100);
  });
  it("题库候选变体精确命中即得分；全半角/大小写/空格不敏感", () => {
    expect(G.gradeBlanks(["批处理"], byId[8]).score).toBe(100);
    expect(G.gradeBlanks(["batch processing"], byId[8]).score).toBe(100);
    expect(G.gradeBlanks(["BatchProcessing"], byId[8]).score).toBe(100);
    expect(G.gradeBlanks(["Pthread"], byId[66]).score).toBe(100);
    expect(G.gradeBlanks(["POSIX thread"], byId[66]).score).toBe(100);
    expect(G.gradeBlanks(["Java"], byId[66]).score).toBe(0);
    expect(G.gradeBlanks(["硬件系统", "软件系统"], byId[25]).score).toBe(100);
  });
  it("特殊答案：缩写/斜杠/数学式", () => {
    const rr = data.questions.find((q) => q.type === "blank" && q.ref.startsWith("时间片轮转法"));
    expect(G.gradeBlanks(["RR"], rr).score).toBe(100);
    const pv = data.questions.find((q) => q.ref === "P，V");
    expect(G.gradeBlanks(["P", "V"], pv).score).toBe(100);
    const oneN = data.questions.find((q) => q.ref && q.ref.includes("1/n"));
    expect(G.gradeBlanks(["保证调度算法", "1/n"], oneN).score).toBe(100);
  });
});

describe("操作系统：并列可互换（unordered 标记）", () => {
  it("标记题跨空互换仍全对", () => {
    expect(G.gradeBlanks(["软件资源", "硬件资源"], byId[5]).score).toBe(100);
    expect(G.gradeBlanks(["UEFI引导", "BIOS引导"], byId[18]).score).toBe(100);
    expect(G.gradeBlanks(["编译系统", "数据库", "操作系统"], byId[26]).score).toBe(100);
  });
  it("互换不放宽逐字口径：重复答案只给一半、漏字照扣", () => {
    expect(G.gradeBlanks(["软件资源", "软件资源"], byId[5]).score).toBe(50);
    expect(G.gradeBlanks(["软件", "硬件资源"], byId[5]).score).toBe(50);
    expect(G.gradeBlanks(["软件", "内存"], byId[5]).score).toBe(0);
  });
  it("未标记的多空题保持位置严格：互换即错", () => {
    expect(G.gradeBlanks(["进程", "线程"], byId[62]).score).toBe(0);
    expect(G.gradeBlanks(["V", "P"], byId[190]).score).toBe(0);
    expect(G.gradeBlanks(["输出井", "输入井"], byId[167]).score).toBe(0);
  });
  it("逐空报告：互换后全 ok，expect 仍是本空标准答案", () => {
    const r = G.gradeBlanks(["软件资源", "硬件资源"], byId[5]);
    expect(r.per.every((p) => p.ok)).toBe(true);
    expect(r.per[0].expect).toBe("硬件资源");
    expect(r.per[0].input).toBe("软件资源");
  });
  it("单空或选（single 清单）：答出其一即对，乱答仍错", () => {
    expect(G.gradeBlanks(["SPOOLing技术"], byId[168]).score).toBe(100);
    expect(G.gradeBlanks(["虚拟设备技术"], byId[168]).score).toBe(100);
    expect(G.gradeBlanks(["虚拟设备技术或SPOOLing技术"], byId[168]).score).toBe(100);
    expect(G.gradeBlanks(["先入先出技术"], byId[168]).score).toBe(0);
  });
});

describe("操作系统：简答分档锚点", () => {
  it("只列要点标题 ≈ 及格线", () => {
    expect(G.gradeEssay("并发、共享、虚拟性、异步性", byId[6].points).score).toBeGreaterThanOrEqual(55);
    expect(G.gradeEssay("并发、共享、虚拟性、异步性", byId[6].points).score).toBeLessThanOrEqual(75);
    expect(G.gradeEssay("处理机管理、存储器管理、设备管理、文件管理、用户接口", byId[7].points).score).toBeGreaterThanOrEqual(55);
  });
  it("无关作答接近零分", () => {
    expect(G.gradeEssay("今天天气不错我们出去玩", byId[6].points).score).toBeLessThanOrEqual(10);
    expect(G.gradeEssay("", byId[6].points).score).toBe(0);
  });
  it("近义/列举式作答获得部分分", () => {
    const s135 = G.gradeEssay("读：可以读取目录内容；写：可以创建删除文件；执行：可以访问目录中文件", byId[135].points).score;
    expect(s135).toBeGreaterThanOrEqual(50);
    const s160 = G.gradeEssay("先来先服务、最短寻找时间优先、电梯调度、扫描算法", byId[160].points).score;
    expect(s160).toBeGreaterThanOrEqual(75);
  });
});

describe("操作系统：题库完整性", () => {
  it("190 题、三类题型（58/100/32）、每题都有解析", () => {
    expect(data.questions.length).toBe(190);
    expect(data.questions.filter((q) => q.type === "single").length).toBe(58);
    expect(data.questions.filter((q) => q.type === "blank").length).toBe(100);
    expect(data.questions.filter((q) => q.type === "essay").length).toBe(32);
    for (const q of data.questions) expect(typeof q.explain === "string" && q.explain.length > 0).toBe(true);
  });
  it("unordered.json 清单计数与标记一致", () => {
    expect(unord.ids.length).toBeGreaterThan(0);
  });
});

describe("操作系统：考前重点记忆数据", () => {
  it("memo 随 data.js 产出：8 章 46 个考点小节，条目不残留题型标签", () => {
    expect(data.meta.memo && data.meta.memo.enabled).toBe(true);
    expect(Array.isArray(data.memo.chapters)).toBe(true);
    expect(data.memo.chapters.length).toBe(8);
    const secs = data.memo.chapters.flatMap((c) => c.sections);
    expect(secs.length).toBe(46);
    for (const s of secs) {
      expect(s.id).toMatch(/^[1-8]\.[1-8]$/);
      expect(typeof s.title === "string" && s.title.length > 0).toBe(true);
      expect(s.items.length).toBeGreaterThan(0);
      expect(s.ids.length).toBeGreaterThan(0); // 每个考点都挂到题目，否则题全部答对也无法移出「未掌握」
      for (const it of s.items) expect(it.t).not.toContain("〔");
    }
  });
  it("190 道题都至少挂在一个考点上（不漏题）", () => {
    const ids = new Set();
    for (const ch of data.memo.chapters) for (const sec of ch.sections) for (const id of sec.ids) ids.add(id);
    expect(ids.size).toBe(190);
    for (const q of data.questions) expect(ids.has(q.id)).toBe(true);
  });
  it("考点编号唯一、章数与题库章节一致、编号前缀与章序对齐", () => {
    const secs = data.memo.chapters.flatMap((c) => c.sections);
    expect(new Set(secs.map((s) => s.id)).size).toBe(secs.length);
    expect(data.memo.chapters.length).toBe(data.chapters.length);
    data.memo.chapters.forEach((ch, i) => {
      for (const s of ch.sections) expect(s.id.split(".")[0]).toBe(String(i + 1));
    });
  });
});
