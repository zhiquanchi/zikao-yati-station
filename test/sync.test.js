// 云同步纯函数回归（bun test）：mergeBlobs 逐题 ts-LWW 与 clearedAt 压制、
// payloadStore 墓碑生成/幂等重放/清空跳过、payloadShuf 卷与清空墓碑、applyInto 竞态保护、
// prefetch 多用户槽位 URL 构造。与 Go 云同步服务的合并口径一致性由 test/merge_xcheck.test.js ↔
// grade-svc/store_golden_test.go 对同一夹具断言锁定。
import { describe, it, expect } from "bun:test";
import "../web/sync.js"; // UMD 收尾：浏览器挂 window、bun 挂 globalThis

const S = globalThis.SYNC;
const rec = (u, ts, extra) => Object.assign({ u, s: 100, ts }, extra || {});
const tomb = (ts) => ({ u: null, s: null, ts });
const blob = (store, shuf, clearedAt) => ({ store, shuf: shuf || null, clearedAt: clearedAt || 0 });

describe("mergeBlobs", () => {
  it("并集合并、同键 ts 新者胜（两端对称）", () => {
    const m = S.mergeBlobs(blob({ 1: rec("a", 100), 2: rec("x", 900) }), blob({ 2: rec("y", 800), 3: rec("z", 50) }), 5000);
    expect(Object.keys(m.store).sort()).toEqual(["1", "2", "3"]);
    expect(m.store["2"].u).toBe("x"); // a 端 ts 大
    const m2 = S.mergeBlobs(blob({ 2: rec("x", 800) }), blob({ 2: rec("y", 900) }));
    expect(m2.store["2"].u).toBe("y");
    expect(m2.updatedAt).toBeGreaterThan(0);
  });
  it("clearedAt 取两端较大并压制更早记录；之后的记录存活", () => {
    const m = S.mergeBlobs(blob({ 1: rec("a", 1000) }), blob({ 2: rec("b", 1500) }, null, 2000));
    expect(m.store).toEqual({});
    expect(m.clearedAt).toBe(2000);
    const m2 = S.mergeBlobs(blob({ 3: rec("c", 2500) }), blob({}, null, 2000));
    expect(m2.store["3"]).toBeTruthy();
  });
  it("shuf 按 ts 新者胜，null 不敌对象", () => {
    const p1 = { picked: [1], ts: 10 }, p2 = { picked: [2], ts: 20 };
    expect(S.mergeBlobs(blob({}, p1), blob({}, p2)).shuf).toBe(p2);
    expect(S.mergeBlobs(blob({}, p2), blob({}, null)).shuf).toBe(p2);
    expect(S.mergeBlobs(blob({}), blob({})).shuf).toBeNull();
  });
});

describe("mergeBlobs v2：hist 并集去重留 10、expl ts LWW", () => {
  const e = (ts, u) => ({ u: u || "答", s: 100, ts });
  const ex = (ts, src) => ({ source: src || "material", items: [{ key: "A", correct: true, why: "对" }], ts });
  it("两端皆无 extras 段 → 输出不含 hist/expl 键（旧版形状不变）", () => {
    const m = S.mergeBlobs(blob({ 1: rec("a", 10) }), blob({ 2: rec("b", 20) }));
    expect("hist" in m).toBe(false);
    expect("expl" in m).toBe(false);
  });
  it("hist 逐题并集：同 ts 先到先得（a 端优先）、升序留最近 10", () => {
    const ha = { 1: [e(5), e(7, "甲")] };
    const hb = { 1: [e(7, "乙"), e(6), e(8)] };
    const m = S.mergeBlobs(Object.assign(blob({}), { hist: ha }), Object.assign(blob({}), { hist: hb }));
    expect(m.hist["1"].map((x) => x.ts)).toEqual([5, 6, 7, 8]);
    expect(m.hist["1"][2].u).toBe("甲"); // 同 ts=7 取 a 端
    const big = { 2: Array.from({ length: 14 }, (_, i) => e(i + 1)) };
    const m2 = S.mergeBlobs(Object.assign(blob({}), { hist: big }), Object.assign(blob({}), { hist: {} }));
    expect(m2.hist["2"].length).toBe(10);
    expect(m2.hist["2"][9].ts).toBe(14); // 留的是最近的
  });
  it("hist 受 clearedAt 压制（含对端取大后），全压完该题不出键但 hist 段在", () => {
    const m = S.mergeBlobs(
      Object.assign(blob({}, null, 100), { hist: { 1: [e(50), e(150)] } }),
      Object.assign(blob({}), { hist: { 2: [e(90)] } }),
    );
    expect(m.hist["1"].map((x) => x.ts)).toEqual([150]);
    expect(m.hist["2"]).toBeUndefined();
  });
  it("expl 逐题 ts LWW，不受 clearedAt 压制", () => {
    const m = S.mergeBlobs(
      Object.assign(blob({}, null, 999), { expl: { 1: ex(10), 2: ex(500, "search") } }),
      Object.assign(blob({}), { expl: { 1: ex(20, "search") } }),
    );
    expect(m.expl["1"].ts).toBe(20);
    expect(m.expl["1"].source).toBe("search");
    expect(m.expl["2"].ts).toBe(500); // 单端独有无条件保留
  });
});

describe("payloadExtras v2（hist/expl 上云载荷清洗）", () => {
  it("hist 剔除缺/坏 ts 条目与非对象条目；空题不出键", () => {
    const out = S.payloadExtras({ 1: [{ u: "a", s: 1, ts: 5 }, { u: "b", s: 1 }, "坏", { u: "c", s: null, ts: 7 }], 2: [{ u: "d" }] }, {}, 100);
    expect(Object.keys(out.hist)).toEqual(["1"]);
    expect(out.hist["1"].map((x) => x.ts)).toEqual([5, 7]);
  });
  it("expl 缺 items 整条剔除；缺 ts 补 now，已有 ts 原样", () => {
    const out = S.payloadExtras({}, { 1: { source: "ref", items: [{ key: "A" }] }, 2: { items: [], ts: 42 }, 3: { source: "x" } }, 100);
    expect(out.expl["1"].ts).toBe(100);
    expect(out.expl["2"].ts).toBe(42);
    expect(out.expl["3"]).toBeUndefined();
  });
  it("两端皆空 → 两个空对象（调用侧据此不出键）", () => {
    const out = S.payloadExtras({}, {}, 1);
    expect(out).toEqual({ hist: {}, expl: {} });
  });
});

describe("payloadStore（快照 diff 出墓碑）", () => {
  const now = 10000;
  it("当前无、快照有（活记录）→ 发新墓碑", () => {
    const out = S.payloadStore({}, { 5: rec("a", 100) }, false, now);
    expect(out["5"].u).toBeNull();
    expect(out["5"].s).toBeNull();
    expect(out["5"].ts).toBeGreaterThan(now);
  });
  it("快照里已是墓碑 → 原样重放（ts 不变，绝不抢赢对端新答）", () => {
    const old = tomb(500);
    const out = S.payloadStore({}, { 5: old }, false, now);
    expect(out["5"]).toBe(old);
  });
  it("「看过解析」记录被删 → 也发墓碑", () => {
    const out = S.payloadStore({}, { 7: { u: null, s: null, ts: 100, v: 100 } }, false, now);
    expect(out["7"].u).toBeNull();
    expect(out["7"].v).toBeUndefined();
  });
  it("清空后 skipDiff：只发当前 store，逐键墓碑交给 clearedAt", () => {
    const out = S.payloadStore({ 8: rec("n", 99999) }, { 5: rec("a", 100) }, true, now);
    expect(Object.keys(out)).toEqual(["8"]);
  });
});

describe("payloadShuf", () => {
  it("真实卷缺 ts（历史数据）→ 补 now；已有 ts 原样", () => {
    expect(S.payloadShuf({ picked: [1] }, null, 700).ts).toBe(700);
    expect(S.payloadShuf({ picked: [1], ts: 300 }, null, 700).ts).toBe(300);
  });
  it("本地关了组卷而快照是活卷 → 发清空墓碑；快照墓碑保持；两端皆无 → null", () => {
    expect(S.payloadShuf(null, { picked: [1], ts: 300 }, 700)).toEqual({ cleared: true, ts: 700 });
    const t = { cleared: true, ts: 600 };
    expect(S.payloadShuf(null, t, 700)).toBe(t);
    expect(S.payloadShuf(null, null, 700)).toBeNull();
  });
});

describe("applyInto（合并结果写回内存引用，打字竞态安全）", () => {
  it("较新远端覆盖、较旧远端跳过；只删「已同步且云端已无」的键", () => {
    const target = { 1: rec("old", 100), 9: rec("typing", 9000) }; // 9 = 推送在途时的本地新改动（未进快照）
    const merged = { 1: rec("new", 200), 2: tomb(150) };
    const snap = { 1: rec("old", 100), 3: rec("gone", 50) };
    S.applyInto(target, merged, snap);
    expect(target["1"].u).toBe("new");
    expect(target["2"].u).toBeNull(); // 同步过的墓碑进入本地（判分/渲染视为未答）
    expect(target["3"]).toBeUndefined(); // 云端已删且已同步 → 本地删除
    expect(target["9"].u).toBe("typing"); // 未同步的在编记录绝不误删
  });
  it("远端更旧不覆盖本地在编草稿", () => {
    const target = { 4: { u: "drafting", s: null, ts: 500 } };
    S.applyInto(target, { 4: { u: "stale", s: null, ts: 400 } }, {});
    expect(target["4"].u).toBe("drafting");
  });
});

describe("prefetch 多用户槽位 URL", () => {
  it("带码 → api/store/<码>；无码（旧版兼容槽）→ api/store；GET 与防抖 PUT 同址", async () => {
    const saved = { ls: globalThis.localStorage, loc: globalThis.location, fetch: globalThis.fetch };
    const m = new Map();
    globalThis.localStorage = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
    globalThis.location = { protocol: "http:" };
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ blob: { store: {}, shuf: null, clearedAt: 0, updatedAt: Date.now() } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    try {
      await S.prefetch("k13180.v1.ab2cde", "ab2cde"); // 码用户：键与 URL 都带码（键由 identity.js 派生传入）
      await S.flushNow(); // 立即推完防抖队列，不留挂起计时器
      await S.prefetch("k13180.v1", ""); // 旧版兼容槽：裸键 + 无尾段 URL
      await S.flushNow();
      expect(urls).toEqual(["api/store/ab2cde", "api/store/ab2cde", "api/store", "api/store"]);
      // 分区键自然隔离：码用户的快照写在带码后缀的键上，两身份快照互不覆盖
      expect(m.has("k13180.v1.ab2cde.syncsnap")).toBe(true);
      expect(m.has("k13180.v1.syncsnap")).toBe(true);
    } finally {
      if (saved.ls === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved.ls;
      if (saved.loc === undefined) delete globalThis.location; else globalThis.location = saved.loc;
      globalThis.fetch = saved.fetch;
    }
  });

  it("v2：对端 hist/expl 随 prefetch 写回按码分区的派生键", async () => {
    const saved = { ls: globalThis.localStorage, loc: globalThis.location, fetch: globalThis.fetch };
    const m = new Map();
    globalThis.localStorage = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
    globalThis.location = { protocol: "http:" };
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        blob: {
          store: {}, shuf: null, clearedAt: 0, updatedAt: Date.now(),
          hist: { 3: [{ u: "云", s: 80, ts: 9 }] }, expl: { 3: { source: "search", items: [], ts: 8 } },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    try {
      await S.prefetch("k.net.v1.cd2xyz", "cd2xyz");
      await S.flushNow();
      expect(JSON.parse(m.get("k.net.v1.cd2xyz.hist"))["3"][0].u).toBe("云");
      expect(JSON.parse(m.get("k.net.v1.cd2xyz.expl"))["3"].source).toBe("search");
    } finally {
      if (saved.ls === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved.ls;
      if (saved.loc === undefined) delete globalThis.location; else globalThis.location = saved.loc;
      globalThis.fetch = saved.fetch;
    }
  });
});
