// 云同步合并口径 golden 夹具生成器（bun scripts/gen-merge-golden.js，幂等可重跑）：
// 多用户改造后合并逻辑跨语言两份实现——前端 web/sync.js（JS）与 grade-svc Go 云同步服务，
// 由 test/fixtures/merge_golden.json 单一夹具分别被 test/merge_xcheck.test.js（JS 侧）与
// grade-svc/store_golden_test.go（Go 侧）断言逐字段等价（替代原「JS↔JS 双实现对拍」守卫）。
// 期望值来源：merges 段用前端 mergeBlobs 计算（初版夹具由 portal/store.js 计算——彼时旧版
// merge_xcheck 全绿锁定两 JS 实现等价，Go 侧 golden 断言又证明与夹具一致，三者同源可信）；
// 载荷契约段 normalized 用 Go 端 normalizeIncoming 计算（syncsvc -normalize stdio 模式，服务端 JS 实现已退役）。
// 改合并/校验口径：两实现同改后重跑本脚本刷新夹具，任何单侧漂移必红。
import path from "node:path";
import "../web/sync.js";

const S = globalThis.SYNC;
const NOW = 1790000000000;

// 与 app.js / 初版 merge_xcheck 逐字同款确定性 PRNG（夹具可复现）
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

// ——— 合并夹具：60 组随机两端 + 4 组退化形态（null 端、缺字段、空对象）———
const merges = [];
{
  const rnd = mulberry32(20261020);
  for (let i = 0; i < 60; i++) {
    const a = randBlob(rnd), b = randBlob(rnd);
    merges.push({ a, b, out: S.mergeBlobs(a, b, NOW) });
  }
  const degenerate = [
    [{ store: {}, shuf: null, clearedAt: 0 }, null],
    [null, { store: { 1: { u: "x", ts: 5 } }, shuf: { picked: [1], ts: 5 }, clearedAt: 0 }],
    [{ store: { 2: { u: null, s: null, ts: 9 } } }, { clearedAt: 9 }],
    [{}, {}],
  ];
  for (const [a, b] of degenerate) merges.push({ a, b, out: S.mergeBlobs(a, b, NOW) });
}

// ——— 载荷契约夹具：前端 payloadStore/payloadShuf 真实产物 + Go 端 normalizeIncoming 期望输出 ———
// JS 侧（xcheck）断言「由输入重放的产物 == 夹具 payload/shufOut」，Go 侧断言「normalize(夹具产物) == normalized」，
// 传递性锁定：前端上传载荷必过 Go 端整形校验且形状原样不改。
const bodies = [];
const rawCases = [];
{
  const rnd = mulberry32(42);
  for (let i = 0; i < 40; i++) {
    const cur = randBlob(rnd).store, snap = randBlob(rnd).store;
    const skip = rnd() < 0.3;
    const payload = S.payloadStore(cur, snap, skip, NOW);
    const shufIn = rnd() < 0.5 ? { picked: [1], ts: NOW } : null;
    const snapShufIn = rnd() < 0.5 ? { picked: [2], ts: 1 } : null;
    const shufOut = S.payloadShuf(shufIn, snapShufIn, NOW);
    rawCases.push({ cur, snap, skip, shufIn, snapShufIn, payload, shufOut });
    bodies.push(JSON.stringify({ store: payload, shuf: shufOut, clearedAt: 0 }));
  }
}

async function normalizeViaGo(lines) {
  const proc = Bun.spawn(["go", "run", "./cmd/syncsvc", "-normalize"], {
    cwd: path.join(import.meta.dir, "..", "grade-svc"), // import.meta.dir 保中文目录原文（URL.pathname 会百分号编码致 spawn ENOENT）
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(lines.join("\n") + "\n");
  proc.stdin.end();
  const [text, errText, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error("go run ./cmd/syncsvc -normalize 失败：" + errText);
  const out = text.trim().split("\n").map((l) => JSON.parse(l));
  if (out.length !== lines.length) throw new Error("normalize 输出行数不符");
  return out;
}
const normalized = await normalizeViaGo(bodies);

const payloads = [];
for (let i = 0; i < rawCases.length; i++) {
  if (!normalized[i]) throw new Error("夹具第 " + i + " 组被 Go normalizeIncoming 拒收（契约破坏）");
  payloads.push(Object.assign({}, rawCases[i], { normalized: normalized[i] }));
}

const fixture = {
  _comment: "云同步合并口径 golden（scripts/gen-merge-golden.js 生成，勿手改）：JS 与 Go 两份 mergeBlobs/normalizeIncoming 必须逐字段命中本夹具，改口径两实现同改后重跑生成器。",
  now: NOW,
  merges,
  payloads,
};
const out = new URL("../test/fixtures/merge_golden.json", import.meta.url);
await Bun.write(out, JSON.stringify(fixture, null, 1) + "\n");
console.log(`✅ test/fixtures/merge_golden.json：${merges.length} 组合并夹具 + ${payloads.length} 组载荷契约夹具`);
