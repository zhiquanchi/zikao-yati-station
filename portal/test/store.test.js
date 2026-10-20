// 云同步接口回归（bun test · 依赖 go 工具链构建 sync-svc 二进制）：GET/PUT 形状、服务端逐题 ts-LWW 合并、
// clearedAt 压制、科目/用户槽位互不串（旧版兼容槽 user=''、同步码私有槽）、同步码与载荷校验、体积与方法白名单、
// 旧版单槽库启动迁移。链路走完整形态：portal.js（api/store 转发 SYNC_API）→ Go syncsvc（真实 SQLite）。
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import { Database } from "bun:sqlite";

const ROOT = import.meta.dir;
const PORT = 8894;
const SYNC_PORT = 8896;
const DB = path.join(ROOT, ".fixtures", "store-test.db");
const BIN = path.join(ROOT, ".fixtures", "syncsvc-bin");
let portal, syncsvc;

const api = (subject, method, body, user) =>
  fetch(`http://127.0.0.1:${PORT}/${subject}/api/store${user ? "/" + user : ""}`, {
    method,
    ...(body !== undefined && typeof body !== "string"
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : typeof body === "string" ? { headers: { "content-type": "application/json" }, body } : {}),
  });

async function waitUp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 500) return r; } catch (e) {}
    await Bun.sleep(50);
  }
  throw new Error("服务未就绪: " + url);
}

beforeAll(async () => {
  try { await Bun.$`rm -f ${DB} ${DB + "-wal"} ${DB + "-shm"}`; } catch (e) {}
  await Bun.$`go build -o ${BIN} ./cmd/syncsvc`.cwd(path.join(ROOT, "..", "..", "grade-svc"));
  syncsvc = Bun.spawn([BIN], {
    env: { ...process.env, SYNC_HOST: "127.0.0.1", SYNC_PORT: String(SYNC_PORT), STORE_DB: DB },
    stdout: "ignore", stderr: "ignore",
  });
  await waitUp(`http://127.0.0.1:${SYNC_PORT}/api/health`);
  portal = Bun.spawn(["bun", "portal.js"], {
    cwd: path.join(ROOT, ".."),
    env: {
      ...process.env, PORT: String(PORT), SYNC_API: `http://127.0.0.1:${SYNC_PORT}`,
      OS_ROOT: path.join(ROOT, ".fixtures", "os"), NET_ROOT: path.join(ROOT, ".fixtures", "net"),
    },
    stdout: "ignore", stderr: "ignore",
  });
  await waitUp(`http://127.0.0.1:${PORT}/__health`);
});

afterAll(() => {
  portal?.kill(); syncsvc?.kill();
});

describe("api/store 云同步（旧版兼容槽 user=''）", () => {
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

describe("api/store 同步码私有槽（多用户）", () => {
  const A = "ab2cde", B = "z9k2mm";

  it("码槽之间、码槽与旧版槽互不串", async () => {
    let r = await api("os", "PUT", { store: { 7: { u: "X", s: 50, ts: 100 } }, shuf: null, clearedAt: 0 }, A);
    expect((await r.json()).blob.store["7"].u).toBe("X");
    // 另一码槽为空
    expect((await (await api("os", "GET", undefined, B)).json()).blob).toBeNull();
    // 旧版槽不受影响（前序用例写入的 7 号记录 ts=1000 仍在）
    const legacy = (await (await api("os", "GET")).json()).blob;
    expect(legacy.store["7"].ts).toBe(1000);
    // 同码可续写（LWW 在槽内收敛）
    r = await api("os", "PUT", { store: { 7: { u: "Y", s: 100, ts: 200 } }, shuf: null, clearedAt: 0 }, A);
    expect((await r.json()).blob.store["7"].u).toBe("Y");
    r = await api("os", "PUT", { store: { 7: { u: "Z", ts: 100 } }, shuf: null, clearedAt: 0 }, A);
    expect((await r.json()).blob.store["7"].u).toBe("Y"); // 旧 ts 覆盖被拒
  });

  it("「清空记录」只压制本人槽位", async () => {
    await api("os", "PUT", { store: { 8: { u: "q", ts: 300 } }, shuf: null, clearedAt: 0 }, B);
    let r = await api("os", "PUT", { store: {}, shuf: null, clearedAt: 9999999999999 }, B);
    expect(Object.keys((await r.json()).blob.store).length).toBe(0);
    r = await api("os", "GET", undefined, A);
    expect((await r.json()).blob.store["7"].u).toBe("Y"); // 他人码槽安然无恙
  });

  it("畸形同步码 400 bad_user", async () => {
    const bad = await api("os", "GET", undefined, "ABC23");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("bad_user");
    expect((await api("os", "PUT", { store: {}, shuf: null, clearedAt: 0 }, "ab01io")).status).toBe(400); // 含混淆禁用字符
    expect((await api("os", "GET", undefined, "abc")).status).toBe(400); // 过短
    expect((await api("os", "GET", undefined, "abcdefghijk")).status).toBe(400); // 过长（合法字符 11 位）
  });

  it("门户转发降级：上游不可达 502 svc_down", async () => {
    // 另起一个指向死上游的门户实例（不影响主实例）
    const p2 = Bun.spawn(["bun", "portal.js"], {
      cwd: path.join(ROOT, ".."),
      env: {
        ...process.env, PORT: "8895", SYNC_API: "http://127.0.0.1:1",
        OS_ROOT: path.join(ROOT, ".fixtures", "os"), NET_ROOT: path.join(ROOT, ".fixtures", "net"),
      },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      await waitUp("http://127.0.0.1:8895/__health");
      const r = await fetch("http://127.0.0.1:8895/os/api/store/ab2cde");
      expect(r.status).toBe(502);
      expect((await r.json()).error).toBe("svc_down");
    } finally { p2.kill(); }
  });
});

describe("旧版单槽库迁移（站长存量进度无缝续用）", () => {
  it("syncsvc 启动检出旧 DDL：重建复合主键并回填 user=''，存量原样可读、新码不相扰", async () => {
    const dbPath = path.join(ROOT, ".fixtures", "store-migrate.db");
    for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) { try { await Bun.$`rm -f ${f}`; } catch (e) {} }
    {
      const db = new Database(dbPath, { create: true });
      db.exec("CREATE TABLE sync (subject TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at INTEGER NOT NULL);");
      const legacyBlob = { store: { 3: { u: "A", s: 100, ts: 555 } }, shuf: null, clearedAt: 0, updatedAt: 555 };
      db.run("INSERT INTO sync (subject, blob, updated_at) VALUES (?, ?, ?)", ["os", JSON.stringify(legacyBlob), 555]);
      db.close();
    }
    const port = 8897;
    const svc = Bun.spawn([BIN], {
      env: { ...process.env, SYNC_HOST: "127.0.0.1", SYNC_PORT: String(port), STORE_DB: dbPath },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      await waitUp(`http://127.0.0.1:${port}/api/health`);
      const r = await (await fetch(`http://127.0.0.1:${port}/store/os`)).json();
      expect(r.blob.store["3"].u).toBe("A"); // 存量原样
      const p = await fetch(`http://127.0.0.1:${port}/store/os/abcd23`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ store: { 9: { u: "x", ts: 600 } }, shuf: null, clearedAt: 0 }),
      });
      expect(p.status).toBe(200);
      const after = await (await fetch(`http://127.0.0.1:${port}/store/os`)).json();
      expect(after.blob.store["9"]).toBeUndefined();
      expect(after.blob.store["3"].u).toBe("A");
    } finally { svc.kill(); }
  });
});
