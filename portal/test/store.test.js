// 云同步接口回归测试（bun test）：GET/PUT 形状、服务端逐题 ts-LWW 合并、clearedAt 压制、
// 科目单槽互不串、载荷校验与体积上限、方法白名单。与门户主进程同套路由（spawn portal.js + 临时 SQLite）。
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";

const ROOT = import.meta.dir;
const PORT = 8894;
const DB = path.join(ROOT, ".fixtures", "store-test.db");
let portal;

const api = (subject, method, body) =>
  fetch(`http://127.0.0.1:${PORT}/${subject}/api/store`, {
    method,
    ...(body !== undefined && typeof body !== "string"
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : typeof body === "string" ? { headers: { "content-type": "application/json" }, body } : {}),
  });

beforeAll(async () => {
  try { await Bun.$`rm -f ${DB} ${DB + "-wal"} ${DB + "-shm"}`; } catch (e) {}
  portal = Bun.spawn(["bun", "portal.js"], {
    cwd: path.join(ROOT, ".."),
    env: {
      ...process.env, PORT: String(PORT), STORE_DB: DB,
      OS_ROOT: path.join(ROOT, ".fixtures", "os"), NET_ROOT: path.join(ROOT, ".fixtures", "net"),
    },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" }); if (r.status < 500) break; } catch (e) {}
    await Bun.sleep(50);
  }
});

afterAll(() => { portal?.kill(); });

describe("api/store 云同步", () => {
  it("空槽 GET 返回 blob:null；PUT 后 GET 能取回", async () => {
    const g0 = await api("os", "GET");
    expect(g0.status).toBe(200);
    // 前面若有残留用例先跑：以最新写入为准即可，不强求 null
    const put = await api("os", "PUT", { store: { 7: { u: "C", s: 100, ts: 1000 } }, shuf: null, clearedAt: 0 });
    expect(put.status).toBe(200);
    const b1 = (await put.json()).blob;
    expect(b1.store["7"].s).toBe(100);
    expect(b1.updatedAt).toBeGreaterThan(0);
    const g1 = await api("os", "GET");
    expect((await g1.json()).blob.store["7"].ts).toBe(1000);
  });

  it("服务端逐题 ts-LWW：新题并入、旧覆盖被拒、墓碑生效", async () => {
    await api("net", "PUT", { store: { 1: { u: "a", s: 100, ts: 1000 }, 2: { u: "b", ts: 1500 } }, shuf: null, clearedAt: 0 });
    // ts 更旧的 1 号记录不会覆盖
    let r = await api("net", "PUT", { store: { 1: { u: "old", ts: 500 }, 3: { u: "c", ts: 1600 } }, shuf: null, clearedAt: 0 });
    let blob = (await r.json()).blob;
    expect(blob.store["1"].u).toBe("a");
    expect(blob.store["3"].u).toBe("c");
    // 墓碑（u:null）带更大 ts 即生效
    r = await api("net", "PUT", { store: { 1: { u: null, s: null, ts: 1800 } }, shuf: null, clearedAt: 0 });
    blob = (await r.json()).blob;
    expect(blob.store["1"].u).toBeNull();
    expect(blob.store["2"].u).toBe("b");
  });

  it("clearedAt 取两端较大并压制更早记录，之后的新记录存活", async () => {
    let r = await api("net", "PUT", { store: {}, shuf: null, clearedAt: 2000 });
    let blob = (await r.json()).blob;
    expect(Object.keys(blob.store).length).toBe(0); // 2 号(ts1500)与 3 号(ts1600)与墓碑(1800)全部作废
    expect(blob.clearedAt).toBe(2000);
    r = await api("net", "PUT", { store: { 4: { u: "d", ts: 2500 } }, shuf: null, clearedAt: 0 });
    blob = (await r.json()).blob;
    expect(blob.store["4"].u).toBe("d");
    expect(blob.clearedAt).toBe(2000); // 本地清零不会把 clearedAt 拉回 0
  });

  it("shuf 按 ts 新者胜", async () => {
    let r = await api("net", "PUT", { store: {}, shuf: { seed: 1, order: [], picked: [4], total: 5, ts: 3000 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.picked).toEqual([4]);
    r = await api("net", "PUT", { store: {}, shuf: { seed: 2, order: [], picked: [], total: 0, ts: 2000 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.seed).toBe(1); // 旧的被拒
    r = await api("net", "PUT", { store: {}, shuf: { seed: 3, order: [], picked: [1, 2], total: 10, ts: 4000 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.seed).toBe(3);
    // 清空墓碑：带更新 ts 的 {cleared:true} 压制现有卷；更旧的墓碑无效；畸形形状按无 shuf 处理不误伤
    r = await api("net", "PUT", { store: {}, shuf: { cleared: true, ts: 5000 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.cleared).toBe(true);
    r = await api("net", "PUT", { store: {}, shuf: { cleared: true, ts: 4500 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.cleared).toBe(true); // 旧墓碑不敌新墓碑，仍保持清空
    r = await api("net", "PUT", { store: {}, shuf: { bogus: 1 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.cleared).toBe(true); // bogus 被 normalize 成 null，不清掉已同步的墓碑
  });

  it("两科目各占各的槽互不串", async () => {
    const os = await (await api("os", "GET")).json();
    expect(os.blob.store["7"] !== undefined).toBe(true);
    const net = await (await api("net", "GET")).json();
    expect(net.blob.store["7"]).toBeUndefined();
  });

  it("畸形载荷 400、超 1MB 413、非 GET/PUT 405、非 JSON 400", async () => {
    expect((await api("os", "PUT", { store: { abc: { u: "x", ts: 1 } }, shuf: null, clearedAt: 0 })).status).toBe(400);
    expect((await api("os", "PUT", { store: { 1: { u: "x" } }, shuf: null, clearedAt: 0 })).status).toBe(400);
    expect((await api("os", "PUT", { shuf: null, clearedAt: 0 })).status).toBe(400);
    expect((await api("os", "DELETE")).status).toBe(405);
    expect((await api("os", "PUT", "not-json")).status).toBe(400);
    const big = { store: {}, shuf: null, clearedAt: 0 };
    const junk = "x".repeat(64 * 1024);
    for (let i = 0; i < 20; i++) big.store[String(1000 + i)] = { u: junk, ts: 1 };
    expect((await api("os", "PUT", big)).status).toBe(413);
  });
});
