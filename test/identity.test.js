// 多用户身份（同步码）逻辑回归：码格式与签发、存储键分区派生、ensure 三分支（有码/旧版数据/全新访客）、
// 迁移搬键完整性（七键全搬、旧分区清干净、可退回标记）。纯 localStorage 操作，用内存 stub 直测。
import { describe, it, expect, beforeEach } from "bun:test";
import "../web/identity.js";

const ID = globalThis.IDENTITY;
const RAW = "os13180.v1";
const SUFFIXES = ["", ".shuffle", ".syncsnap", ".synccleared", ".hist", ".expl", ".seen"];

function storageStub(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}

beforeEach(() => {
  globalThis.localStorage = storageStub();
});

describe("同步码", () => {
  it("user()：无码/坏码按旧版槽，合法码原样返回", () => {
    expect(ID.user()).toBe("");
    globalThis.localStorage.setItem(ID.CODE_KEY, "ABC23"); // 大写不合法（坏值视为未设）
    expect(ID.user()).toBe("");
    globalThis.localStorage.setItem(ID.CODE_KEY, "ab2cde");
    expect(ID.user()).toBe("ab2cde");
  });

  it("mint()：6 位、字母表无混淆字符（i/l/o/0/1 不出现）", () => {
    for (let i = 0; i < 200; i++) {
      const c = ID.mint();
      expect(c).toMatch(/^[a-z2-9]{6}$/);
      expect("ilo01".split("").some((ch) => c.includes(ch))).toBe(false);
    }
  });

  it("keyFor()：码即分区后缀，无码键形不变（旧版兼容基线）", () => {
    expect(ID.keyFor(RAW)).toBe(RAW);
    ID.setCode("ab2cde");
    expect(ID.keyFor(RAW)).toBe(RAW + ".ab2cde");
  });

  it("ensure()：全新访客静默签发；有旧版本地数据不分码；file:// 不分码", () => {
    expect(ID.ensure(RAW, true)).toMatch(/^[a-z2-9]{6}$/); // 新访客
    globalThis.localStorage.removeItem(ID.CODE_KEY);
    globalThis.localStorage.setItem(RAW, "{}"); // 旧版槽设备已有数据
    expect(ID.ensure(RAW, true)).toBe("");
    expect(globalThis.localStorage.getItem(ID.CODE_KEY)).toBeNull();
    globalThis.localStorage.removeItem(RAW);
    expect(ID.ensure(RAW, false)).toBe(""); // 非 http 场景（file://）与有无数据无关，一律不分码
    ID.setCode("z9k2mm");
    expect(ID.ensure(RAW, true)).toBe("z9k2mm"); // 已有码不重签
  });

  it("setCode/clearCode：格式把关", () => {
    expect(ID.setCode("NOPE!")).toBe(false);
    expect(ID.user()).toBe("");
    expect(ID.setCode("abcd23")).toBe(true);
    expect(ID.user()).toBe("abcd23");
    ID.clearCode();
    expect(ID.user()).toBe("");
  });
});

describe("账号分区（登录态）", () => {
  it("setAccount 后 user() 优先账号 slot，keyFor 指向账号分区", () => {
    ID.setCode("ab2cde"); // 匿名码仍在，但账号优先
    expect(ID.setAccount({ slot: "abcd234567", email: "a@example.com" })).toBe(true);
    expect(ID.user()).toBe("abcd234567");
    expect(ID.account()).toBe("abcd234567");
    expect(ID.accountEmail()).toBe("a@example.com");
    expect(ID.keyFor(RAW)).toBe(RAW + ".abcd234567");
  });

  it("坏 slot 拒绝；clearAccount 回退匿名码", () => {
    ID.setCode("ab2cde");
    expect(ID.setAccount({ slot: "BAD!", email: "x" })).toBe(false);
    expect(ID.user()).toBe("ab2cde");
    expect(ID.setAccount({ slot: "abcd234567", email: "a@example.com" })).toBe(true);
    ID.clearAccount();
    expect(ID.user()).toBe("ab2cde");
    expect(ID.accountEmail()).toBe("");
  });

  it("adoptLocal：匿名分区优先、旧版裸键补缺；只搬用户数据，不搬同步状态键", () => {
    const m = globalThis.localStorage._m;
    m.set(ID.CODE_KEY, "ab2cde");
    for (const suf of ["", ".shuffle", ".hist", ".expl", ".seen", ".syncsnap", ".synccleared"]) {
      m.set(RAW + ".ab2cde" + suf, "anon" + suf);
    }
    m.set(RAW, "legacy");
    m.set(RAW + ".hist", "legacy.hist");
    m.set(RAW + ".expl", "legacy.expl"); // 匿名分区没有 expl → 旧版补上
    m.delete(RAW + ".ab2cde.expl");

    ID.setAccount({ slot: "abcd234567", email: "a@example.com" });
    expect(ID.adoptLocal(RAW)).toBe(true);
    const to = RAW + ".abcd234567";
    expect(m.get(to)).toBe("anon");
    expect(m.get(to + ".shuffle")).toBe("anon.shuffle");
    expect(m.get(to + ".hist")).toBe("anon.hist");
    expect(m.get(to + ".expl")).toBe("legacy.expl"); // 匿名缺、旧版补
    expect(m.get(to + ".seen")).toBe("anon.seen");
    // 同步状态键不搬
    expect(m.has(to + ".syncsnap")).toBe(false);
    expect(m.has(to + ".synccleared")).toBe(false);
    // 源分区已清空
    expect(m.has(RAW)).toBe(false);
    expect(m.has(RAW + ".hist")).toBe(false);
    expect(m.has(RAW + ".ab2cde")).toBe(false);
    expect(m.has(RAW + ".ab2cde.hist")).toBe(false);
  });

  it("登录态禁止 migrateTo 把账号分区搬走；clearPartition 清空账号分区", () => {
    ID.setAccount({ slot: "abcd234567", email: "a@example.com" });
    expect(ID.migrateTo(RAW, "z9k2mm")).toBe(false);
    globalThis.localStorage.setItem(RAW + ".abcd234567", "X");
    globalThis.localStorage.setItem(RAW + ".abcd234567.hist", "H");
    ID.clearPartition(RAW);
    expect(globalThis.localStorage.getItem(RAW + ".abcd234567")).toBeNull();
    expect(globalThis.localStorage.getItem(RAW + ".abcd234567.hist")).toBeNull();
  });
});

describe("迁移搬键（旧版槽 → 同步码分区）", () => {
  it("七键全搬、旧分区清空、身份切换、可退回标记", () => {
    const m = globalThis.localStorage._m;
    for (const suf of SUFFIXES) m.set(RAW + suf, "V" + suf);
    const code = ID.mint();
    expect(ID.migrateTo(RAW, code)).toBe(true);
    for (const suf of SUFFIXES) {
      expect(m.get(RAW + "." + code + suf), "迁到 " + suf).toBe("V" + suf);
      expect(m.has(RAW + suf), "旧键清掉 " + suf).toBe(false);
    }
    expect(ID.user()).toBe(code);
    expect(ID.wasLegacy()).toBe(true);
    ID.clearCode(); // 退回旧版槽
    expect(ID.wasLegacy()).toBe(false);
  });

  it("码分区之间切换不搬键（输码切换走 setCode，数据留在原分区）", () => {
    ID.setCode("ab2cde");
    globalThis.localStorage.setItem(RAW + ".ab2cde", "MINE");
    ID.setCode("z9k2mm"); // 切换身份
    expect(globalThis.localStorage.getItem(RAW + ".ab2cde")).toBe("MINE"); // 上一人数据原样封存
    expect(ID.user()).toBe("z9k2mm");
    expect(ID.keyFor(RAW)).toBe(RAW + ".z9k2mm");
  });

  it("坏码拒绝迁移；迁移自码分区也能整组搬走", () => {
    expect(ID.migrateTo(RAW, "BAD!")).toBe(false);
    ID.setCode("ab2cde");
    globalThis.localStorage.setItem(RAW + ".ab2cde", "X");
    expect(ID.migrateTo(RAW, "z9k2mm")).toBe(true);
    expect(globalThis.localStorage.getItem(RAW + ".z9k2mm")).toBe("X");
    expect(globalThis.localStorage.getItem(RAW + ".ab2cde")).toBeNull();
    expect(ID.user()).toBe("z9k2mm");
  });
});
