// 作答进度云同步存储（门户内部模块 · bun:sqlite，零第三方依赖）：
// 每科目一行全局单槽（subject 主键），载荷为 {store, shuf, clearedAt, updatedAt}。
// 合并规则与两科目前端 sync.js 的 mergeBlobs 逐字一致（改一处必须同步三处）：
//   store 按题目 id 逐条比较 rec.ts，新者胜；ts ≤ clearedAt（取双方较大）的记录两端剔除；
//   shuf 按 shuf.ts 新者胜。服务端是收敛点：PUT 传入载荷与库中现值合并后落库并返回合并结果。
import { Database } from "bun:sqlite";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function mergeBlobs(a, b, now = Date.now()) {
  const clearedAt = Math.max(num(a && a.clearedAt), num(b && b.clearedAt));
  const store = {};
  const sa = (a && a.store) || {}, sb = (b && b.store) || {};
  for (const id of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    const ra = sa[id], rb = sb[id];
    const rec = !ra ? rb : !rb ? ra : num(rb.ts) > num(ra.ts) ? rb : ra;
    if (num(rec.ts) <= clearedAt) continue; // 早于等于「清空记录」时间的作答一律作废
    store[id] = rec;
  }
  const fa = a && a.shuf, fb = b && b.shuf;
  const shuf = !fa ? fb || null : !fb ? fa : num(fb.ts) > num(fa.ts) ? fb : fa;
  return { store, shuf, clearedAt, updatedAt: now };
}

// 前端 PUT 的载荷必须整形校验后才入库（公开无鉴权接口，宁拒不收畸形数据）
export function normalizeIncoming(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!body.store || typeof body.store !== "object" || Array.isArray(body.store)) return null;
  const ids = Object.keys(body.store);
  if (ids.length > 5000) return null;
  const store = {};
  for (const id of ids) {
    if (!/^\d+$/.test(id)) return null;
    const r = body.store[id];
    if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.ts !== "number" || !Number.isFinite(r.ts)) return null;
    if (!("u" in r) || (r.s != null && typeof r.s !== "number")) return null;
    store[id] = r;
  }
  // 组卷：真实卷（含 picked 数组）或「清空墓碑」{cleared:true,ts}（否则关闭组卷的动作无法压制对端旧卷）
  const shuf = body.shuf && typeof body.shuf === "object"
    && (Array.isArray(body.shuf.picked) || (body.shuf.cleared === true && Number.isFinite(body.shuf.ts)))
    ? body.shuf : null;
  return { store, shuf, clearedAt: num(body.clearedAt) };
}

const MAX_BODY = 1024 * 1024; // 1MB 上限（190 题全量作答也远小于此）

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

let db = null;
function useDb() {
  if (db) return db;
  const path = process.env.STORE_DB || "/data/sync.db";
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS sync (subject TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at INTEGER NOT NULL);");
  return db;
}

// portal.js 在 api/store 分支调用：GET 拉取合并槽位；PUT 合并落库并返回结果
export async function handleStore(subject, req) {
  if (req.method === "GET") {
    const row = useDb().query("SELECT blob FROM sync WHERE subject = ?").get(subject);
    let blob = null;
    if (row) { try { blob = JSON.parse(row.blob); } catch (e) { blob = null; } }
    return json({ blob });
  }
  if (req.method === "PUT") {
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: "bad_json" }, 400); }
    const incoming = normalizeIncoming(body);
    if (!incoming) return json({ error: "bad_payload" }, 400);
    const d = useDb();
    const row = d.query("SELECT blob FROM sync WHERE subject = ?").get(subject);
    let current = null;
    if (row) { try { current = JSON.parse(row.blob); } catch (e) { current = null; } }
    const merged = mergeBlobs(current || { store: {}, shuf: null, clearedAt: 0 }, incoming);
    d.run("INSERT INTO sync (subject, blob, updated_at) VALUES (?, ?, ?) ON CONFLICT(subject) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
      [subject, JSON.stringify(merged), merged.updatedAt]);
    return json({ blob: merged });
  }
  return new Response("Method Not Allowed", { status: 405 });
}

// 仅供测试复位连接
export function __resetDbForTest() { db = null; }
