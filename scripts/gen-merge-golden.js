// 云同步合并口径 golden 夹具生成器（bun scripts/gen-merge-golden.js，幂等可重跑）：
// 多用户改造后合并逻辑跨语言两份实现——前端 frontend/sync.js（JS）与 backend/grade-svc Go 云同步服务，
// 由 tests/fixtures/merge_golden.json 单一夹具分别被 tests/merge_xcheck.test.js（JS 侧）与
// backend/grade-svc/cmd/syncsvc/store_golden_test.go（Go 侧）断言逐字段等价（替代原「JS↔JS 双实现对拍」守卫）。
// 期望值来源：merges 段用前端 mergeBlobs 计算（初版夹具由 portal/store.js 计算——彼时旧版
// merge_xcheck 全绿锁定两 JS 实现等价，Go 侧 golden 断言又证明与夹具一致，三者同源可信）；
// 载荷契约段 normalized 用 Go 端 normalizeIncoming 计算（syncsvc -normalize stdio 模式，服务端 JS 实现已退役）。
// 改合并/校验口径：两实现同改后重跑本脚本刷新夹具，任何单侧漂移必红。
import path from "node:path";
import "../frontend/sync.js";

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

// randHist：v2 历史归档段（qid → [{u,s,ts}…]）——刻意造出 >10 条（触发裁剪）、两端同 ts（触发去重）、
// 与 clearedAt 交叠的 ts（触发压制）；35% 概率整段缺失（旧版形状）。
function randHist(rnd) {
  if (rnd() < 0.35) return null;
  const h = {};
  const n = Math.floor(rnd() * 12);
  for (let i = 0; i < n; i++) {
    const id = String(1 + Math.floor(rnd() * 40));
    const arr = [];
    const m = Math.floor(rnd() * 14); // 允许 0 条与超 10 条
    for (let j = 0; j < m; j++) {
      const ts = Math.floor(rnd() * 6000);
      arr.push({ u: "答" + Math.floor(rnd() * 9), s: [null, 0, 50, 100][Math.floor(rnd() * 4)], ts });
    }
    if (arr.length) h[id] = arr;
  }
  return h;
}

// randExpl：v2 解析缓存段（qid → {source,items,ts}）；40% 概率整段缺失。
function randExpl(rnd) {
  if (rnd() < 0.4) return null;
  const e = {};
  const n = Math.floor(rnd() * 8);
  for (let i = 0; i < n; i++) {
    const id = String(1 + Math.floor(rnd() * 40));
    e[id] = {
      source: rnd() < 0.5 ? "material" : "search",
      items: [{ key: "A", correct: true, why: "理由甲" }, { key: "B", correct: false, why: "理由乙" }],
      ts: Math.floor(rnd() * 6000),
    };
  }
  return e;
}

function randBlob(rnd) {
  const store = {};
  const n = Math.floor(rnd() * 25);
  for (let i = 0; i < n; i++) store[String(1 + Math.floor(rnd() * 40))] = randRec(rnd);
  const k = rnd();
  const shuf = k < 0.4 ? { picked: [1, 2, 3], ts: Math.floor(rnd() * 6000) }
    : k < 0.6 ? { cleared: true, ts: Math.floor(rnd() * 6000) } : null;
  const clearedAt = rnd() < 0.3 ? Math.floor(rnd() * 4000) : 0;
  const b = { store, shuf, clearedAt };
  const hist = randHist(rnd), expl = randExpl(rnd);
  if (hist) b.hist = hist;
  if (expl) b.expl = expl;
  return b;
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
    // v2 定向退化组：hist 同 ts 两端先到先得（a 端 y 胜 b 端 z）、ts≤clearedAt 压制（ts4 出局）、
    // 仅剩 ts6；expl 平手取 a 端之外按 ts 新者胜（b 端 ts2 胜 a 端 ts1）。
    [{ store: {}, shuf: null, clearedAt: 5, hist: { 7: [{ u: "x", s: 1, ts: 4 }, { u: "y", s: 0, ts: 6 }] }, expl: { 3: { items: [], ts: 1 } } },
      { hist: { 7: [{ u: "z", s: 9, ts: 6 }] }, expl: { 3: { items: [{ key: "A", correct: true, why: "w" }], ts: 2 } } }],
    // hist/expl 全被压制/空段：键仍出现但值为空对象（与「本就没有该段」区分，旧版形状不受影响）
    [{ clearedAt: 100, hist: { 1: [{ u: "a", s: 1, ts: 5 }] }, expl: null }, { hist: { 2: [] } }],
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
    // v2：extras 走前端 payloadExtras 真实产物（含畸形剔除与补 ts），再进 Go 契约校验
    const histIn = randHist(rnd), explIn = randExpl(rnd);
    const extras = S.payloadExtras(histIn || {}, explIn || {}, NOW);
    const histOut = Object.keys(extras.hist).length ? extras.hist : null;
    const explOut = Object.keys(extras.expl).length ? extras.expl : null;
    rawCases.push({ cur, snap, skip, shufIn, snapShufIn, payload, shufOut, histIn, explIn, histOut, explOut });
    const body = { store: payload, shuf: shufOut, clearedAt: 0 };
    if (histOut) body.hist = histOut;
    if (explOut) body.expl = explOut;
    bodies.push(JSON.stringify(body));
  }
}

async function normalizeViaGo(lines) {
  const proc = Bun.spawn(["go", "run", "./cmd/syncsvc", "-normalize"], {
    cwd: path.join(import.meta.dir, "..", "backend", "grade-svc"), // import.meta.dir 保中文目录原文（URL.pathname 会百分号编码致 spawn ENOENT）
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
const out = new URL("../tests/fixtures/merge_golden.json", import.meta.url);
await Bun.write(out, JSON.stringify(fixture, null, 1) + "\n");
console.log(`✅ tests/fixtures/merge_golden.json：${merges.length} 组合并夹具 + ${payloads.length} 组载荷契约夹具`);
