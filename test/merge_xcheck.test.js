// 云同步合并口径交叉校验（bun test）：前端 web/sync.js 的 mergeBlobs 与门户 portal/store.js 的 mergeBlobs
// 是同一口径的两处实现（单仓内），本测试用固定种子的随机夹具断言两端逐字等价——
// 替代旧「三处同改」口头约定：改任何一处合并逻辑，本测试必红。
// 另校验契约：前端 payloadStore/payloadShuf 的输出必能通过服务端 normalizeIncoming 整形校验。
import { describe, it, expect } from "bun:test";
import "../web/sync.js";
import { mergeBlobs as storeMergeBlobs, normalizeIncoming } from "../portal/store.js";

const front = globalThis.SYNC.mergeBlobs;
const NOW = 1790000000000;

// 与 app.js 同款确定性 PRNG
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randRec(rnd) {
  const ts = Math.floor(rnd() * 6000);
  const kind = rnd();
  if (kind < 0.22) return { u: null, s: null, ts }; // 墓碑
  if (kind < 0.32) return { u: null, s: null, ts, v: ts + 1 }; // 看过解析未作答
  const rec = { u: "答" + Math.floor(rnd() * 9), s: [null, 0, 50, 100][Math.floor(rnd() * 4)], ts };
  if (rnd() < 0.3) rec.g = { score: 60, per: [], ts }; // AI 升级结果
  if (rnd() < 0.2) rec.v = 123; // 看过解析标记
  return rec;
}

function randBlob(rnd) {
  const store = {};
  const n = Math.floor(rnd() * 25);
  for (let i = 0; i < n; i++) store[String(1 + Math.floor(rnd() * 40))] = randRec(rnd);
  const k = rnd();
  const shuf = k < 0.4 ? { picked: [1, 2, 3], ts: Math.floor(rnd() * 6000) }
    : k < 0.6 ? { cleared: true, ts: Math.floor(rnd() * 6000) } : null;
  const clearedAt = rnd() < 0.3 ? Math.floor(rnd() * 4000) : 0;
  return { store, shuf, clearedAt };
}

describe("sync.mergeBlobs ≡ store.mergeBlobs", () => {
  it("固定种子 300 轮随机夹具逐字段等价", () => {
    const rnd = mulberry32(20261020);
    for (let i = 0; i < 300; i++) {
      const a = randBlob(rnd), b = randBlob(rnd);
      expect(storeMergeBlobs(a, b, NOW)).toEqual(front(a, b, NOW));
    }
  });
  it("退化形态（空端、null 端、缺字段）同样等价", () => {
    const forms = [
      [{ store: {}, shuf: null, clearedAt: 0 }, null],
      [null, { store: { 1: { u: "x", ts: 5 } }, shuf: { picked: [1], ts: 5 }, clearedAt: 0 }],
      [{ store: { 2: { u: null, s: null, ts: 9 } } }, { clearedAt: 9 }],
      [{}, {}],
    ];
    for (const [a, b] of forms) {
      expect(storeMergeBlobs(a, b, NOW)).toEqual(front(a, b, NOW));
    }
  });
});

describe("前端上传载荷 ≡ 服务端整形校验", () => {
  it("payloadStore/payloadShuf 的产物必过 normalizeIncoming", () => {
    const rnd = mulberry32(42);
    const S = globalThis.SYNC;
    for (let i = 0; i < 200; i++) {
      const cur = randBlob(rnd).store, snap = randBlob(rnd).store;
      const skip = rnd() < 0.3;
      const payload = S.payloadStore(cur, snap, skip, NOW);
      const shuf = S.payloadShuf(rnd() < 0.5 ? { picked: [1], ts: NOW } : null, rnd() < 0.5 ? { picked: [2], ts: 1 } : null, NOW);
      const incoming = normalizeIncoming({ store: payload, shuf, clearedAt: 0 });
      expect(incoming).not.toBeNull();
      // 墓碑与活记录原样入库（形状不改）
      for (const k of Object.keys(payload)) expect(incoming.store[k]).toEqual(payload[k]);
    }
  });
});
