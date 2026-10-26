// 云同步接口回归（bun test · 依赖 go 工具链构建 sync-svc 二进制 + PostgreSQL 测试库）：
// 登录后按会话槽位读写、逐题 ts-LWW、clearedAt 压制、科目/用户槽位隔离、载荷校验、
// v2 hist/expl 与派生行统计、认证经门户转发（Cookie/Set-Cookie 透传）、未登录 401。
// 未设置 TEST_DATABASE_URL 时整组跳过；本地测试库可用 scripts/test-pg.sh。
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import path from "node:path";

const ROOT = import.meta.dir;
const PORT = 8894;
const SYNC_PORT = 8896;
const BIN = path.join(ROOT, ".fixtures", "syncsvc-bin");
const TEST_DSN = process.env.TEST_DATABASE_URL || "";
const SKIP = !TEST_DSN;
const SCHEMA = `pgtest_${Date.now()}_${process.pid}`;
const DSN = TEST_DSN
  ? TEST_DSN + (TEST_DSN.includes("?") ? "&" : "?") + "search_path=" + SCHEMA
  : "";
let portal, syncsvc, admin;
let COOKIE_A = "", SLOT_A = "", COOKIE_B = "", SLOT_B = "";

const d = SKIP ? describe.skip : describe;

async function waitUp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 500) return r; } catch (e) {}
    await Bun.sleep(50);
  }
  throw new Error("服务未就绪: " + url);
}

async function registerOn(base, email) {
  const r = await fetch(base + "/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = await r.json();
  const cookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  if (r.status !== 201) throw new Error("注册失败: " + r.status + " " + JSON.stringify(body));
  return { cookie, slot: body.user.slot };
}

// who="a"|"b"|null；slot 省略时走无尾段（服务端按会话取槽位）
function api(who, subject, method, body, slot) {
  const cookie = who === "a" ? COOKIE_A : who === "b" ? COOKIE_B : "";
  const suffix = slot !== undefined ? "/" + slot : "";
  return fetch(`http://127.0.0.1:${PORT}/${subject}/api/store${suffix}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  });
}

beforeAll(async () => {
  if (SKIP) return;
  admin = new SQL(TEST_DSN);
  await admin.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  await Bun.$`go build -o ${BIN} ./cmd/syncsvc`.cwd(path.join(ROOT, "..", "..", "grade-svc"));
  syncsvc = Bun.spawn([BIN], {
    env: { ...process.env, SYNC_HOST: "127.0.0.1", SYNC_PORT: String(SYNC_PORT), DATABASE_URL: DSN },
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
  const a = await registerOn(`http://127.0.0.1:${SYNC_PORT}`, "a@example.com");
  COOKIE_A = a.cookie; SLOT_A = a.slot;
  const b = await registerOn(`http://127.0.0.1:${SYNC_PORT}`, "b@example.com");
  COOKIE_B = b.cookie; SLOT_B = b.slot;
});

afterAll(async () => {
  portal?.kill();
  syncsvc?.kill();
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  }
});

d("api/store 登录后读写（账号槽位）", () => {
  it("空槽 GET 返回 blob:null；PUT 后 GET 能取回", async () => {
    const g0 = await api("a", "os", "GET");
    expect(g0.status).toBe(200);
    expect((await g0.json()).blob).toBeNull();
    const put = await api("a", "os", "PUT", { store: { 7: { u: "C", s: 100, ts: 1000 } }, shuf: null, clearedAt: 0 });
    expect(put.status).toBe(200);
    const b1 = (await put.json()).blob;
    expect(b1.store["7"].s).toBe(100);
    expect(b1.updatedAt).toBeGreaterThan(0);
    const g1 = await api("a", "os", "GET");
    expect((await g1.json()).blob.store["7"].ts).toBe(1000);
  });

  it("服务端逐题 ts-LWW：新题并入、旧覆盖被拒、墓碑生效", async () => {
    await api("a", "net", "PUT", { store: { 1: { u: "a", s: 100, ts: 1000 }, 2: { u: "b", ts: 1500 } }, shuf: null, clearedAt: 0 });
    let r = await api("a", "net", "PUT", { store: { 1: { u: "old", ts: 500 }, 3: { u: "c", ts: 1600 } }, shuf: null, clearedAt: 0 });
    let blob = (await r.json()).blob;
    expect(blob.store["1"].u).toBe("a");
    expect(blob.store["3"].u).toBe("c");
    r = await api("a", "net", "PUT", { store: { 1: { u: null, s: null, ts: 1800 } }, shuf: null, clearedAt: 0 });
    blob = (await r.json()).blob;
    expect(blob.store["1"].u).toBeNull();
    expect(blob.store["2"].u).toBe("b");
  });

  it("clearedAt 取两端较大并压制更早记录，之后的新记录存活", async () => {
    let r = await api("a", "net", "PUT", { store: {}, shuf: null, clearedAt: 2000 });
    let blob = (await r.json()).blob;
    expect(Object.keys(blob.store).length).toBe(0);
    expect(blob.clearedAt).toBe(2000);
    r = await api("a", "net", "PUT", { store: { 4: { u: "d", ts: 2500 } }, shuf: null, clearedAt: 0 });
    blob = (await r.json()).blob;
    expect(blob.store["4"].u).toBe("d");
    expect(blob.clearedAt).toBe(2000);
  });

  it("shuf 按 ts 新者胜", async () => {
    let r = await api("a", "net", "PUT", { store: {}, shuf: { seed: 1, order: [], picked: [4], total: 5, ts: 3000 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.picked).toEqual([4]);
    r = await api("a", "net", "PUT", { store: {}, shuf: { seed: 2, order: [], picked: [], total: 0, ts: 2000 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.seed).toBe(1);
    r = await api("a", "net", "PUT", { store: {}, shuf: { seed: 3, order: [], picked: [1, 2], total: 10, ts: 4000 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.seed).toBe(3);
    r = await api("a", "net", "PUT", { store: {}, shuf: { cleared: true, ts: 5000 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.cleared).toBe(true);
    r = await api("a", "net", "PUT", { store: {}, shuf: { cleared: true, ts: 4500 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.cleared).toBe(true);
    r = await api("a", "net", "PUT", { store: {}, shuf: { bogus: 1 }, clearedAt: 0 });
    expect((await r.json()).blob.shuf.cleared).toBe(true);
  });

  it("两科目各占各的槽互不串", async () => {
    const os = await (await api("a", "os", "GET")).json();
    expect(os.blob.store["7"] !== undefined).toBe(true);
    const net = await (await api("a", "net", "GET")).json();
    expect(net.blob.store["7"]).toBeUndefined();
  });

  it("畸形载荷 400、超 4MB 413、非 GET/PUT 405、非 JSON 400、路径带他人 slot 403", async () => {
    expect((await api("a", "os", "PUT", { store: { abc: { u: "x", ts: 1 } }, shuf: null, clearedAt: 0 })).status).toBe(400);
    expect((await api("a", "os", "PUT", { store: { 1: { u: "x" } }, shuf: null, clearedAt: 0 })).status).toBe(400);
    expect((await api("a", "os", "PUT", { shuf: null, clearedAt: 0 })).status).toBe(400);
    expect((await api("a", "os", "DELETE")).status).toBe(405);
    expect((await api("a", "os", "PUT", "not-json")).status).toBe(400);
    const big = { store: {}, shuf: null, clearedAt: 0 };
    const junk = "x".repeat(64 * 1024);
    for (let i = 0; i < 80; i++) big.store[String(1000 + i)] = { u: junk, ts: 1 };
    expect((await api("a", "os", "PUT", big)).status).toBe(413);
    // 本人 slot 可写，他人 slot 403
    expect((await api("a", "os", "GET", undefined, SLOT_A)).status).toBe(200);
    expect((await api("a", "os", "GET", undefined, SLOT_B)).status).toBe(403);
  });
});

d("v2 数据完全上云（hist/expl）与派生行统计", () => {
  const syncApi = (method, body) =>
    fetch(`http://127.0.0.1:${SYNC_PORT}/store/os/${SLOT_A}`, {
      method,
      headers: { "content-type": "application/json", cookie: COOKIE_A },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it("hist 并集去重留最近 10、expl ts LWW、clearedAt 压 hist 不压 expl", async () => {
    let r = await syncApi("PUT", {
      store: { 1: { u: "答", s: 100, ts: 10 } }, shuf: null, clearedAt: 0,
      hist: { 1: [{ u: "旧答", s: 0, ts: 5 }, { u: "答", s: 100, ts: 7 }] },
      expl: { 1: { source: "material", items: [{ key: "A", correct: true, why: "对" }], ts: 8 } },
    });
    expect(r.status).toBe(200);
    r = await syncApi("PUT", {
      store: {}, shuf: null, clearedAt: 0,
      hist: { 1: [{ u: "篡改", s: 999, ts: 7 }, { u: "更旧答", s: 50, ts: 6 }] },
      expl: { 1: { source: "search", items: [], ts: 9 } },
    });
    let blob = (await r.json()).blob;
    expect(blob.hist["1"].find((e) => e.ts === 7).s).toBe(100);
    expect(blob.hist["1"].length).toBe(3);
    expect(blob.expl["1"].source).toBe("search");
    blob = (await (await syncApi("PUT", { store: {}, shuf: null, clearedAt: 106 })).json()).blob;
    expect(blob.hist["1"]).toBeUndefined();
    expect("hist" in blob).toBe(true);
    expect(blob.expl["1"].source).toBe("search");
  });

  it("旧版载荷（无 extras 段）响应不含 hist/expl 键——兼容基线", async () => {
    const r = await fetch(`http://127.0.0.1:${SYNC_PORT}/store/os/${SLOT_B}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: COOKIE_B },
      body: JSON.stringify({ store: { 2: { u: "b", ts: 200 } }, shuf: null, clearedAt: 0 }),
    });
    const blob = (await r.json()).blob;
    expect("hist" in blob).toBe(false);
    expect("expl" in blob).toBe(false);
  });

  it("派生行统计：/stats/os 出数（逐题量/均分/通过 + 逐用户），portal 不转发该端点", async () => {
    const stats = await (await fetch(`http://127.0.0.1:${SYNC_PORT}/stats/os`)).json();
    expect(stats.subject).toBe("os");
    expect(stats.questions.length).toBeGreaterThanOrEqual(2);
    const q7 = stats.questions.find((q) => q.qid === 7);
    expect(q7.answered).toBeGreaterThanOrEqual(1);
    expect(q7.avg).toBeGreaterThan(0);
    expect(stats.users.length).toBeGreaterThanOrEqual(2);
    expect((await fetch(`http://127.0.0.1:${PORT}/os/stats`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${PORT}/stats/os`)).status).toBe(404);
  });

  it("畸形 extras 400（hist 条目缺 u / expl 缺 ts）", async () => {
    expect((await syncApi("PUT", { store: {}, shuf: null, clearedAt: 0, hist: { 1: [{ s: 1, ts: 9 }] } })).status).toBe(400);
    expect((await syncApi("PUT", { store: {}, shuf: null, clearedAt: 0, expl: { 1: { items: [] } } })).status).toBe(400);
  });
});

d("鉴权与多用户隔离", () => {
  it("未登录访问同步/认证接口均 401", async () => {
    expect((await api(null, "os", "GET")).status).toBe(401);
    expect((await api(null, "os", "PUT", { store: {}, shuf: null, clearedAt: 0 })).status).toBe(401);
    const me = await fetch(`http://127.0.0.1:${PORT}/os/api/auth/me`);
    expect(me.status).toBe(401);
  });

  it("两个账号槽位互不串；「清空记录」只压制本人", async () => {
    // A 有 q7（前面的用例写入），B 有 q2（兼容基线用例写入）
    const a = await (await api("a", "os", "GET")).json();
    expect(a.blob.store["7"].u).toBe("C");
    expect(a.blob.store["2"]).toBeUndefined();
    const b = await (await api("b", "os", "GET")).json();
    expect(b.blob.store["2"].u).toBe("b");
    expect(b.blob.store["7"]).toBeUndefined();

    await api("b", "os", "PUT", { store: { 8: { u: "q", ts: 300 } }, shuf: null, clearedAt: 0 });
    let r = await api("b", "os", "PUT", { store: {}, shuf: null, clearedAt: 9999999999999 });
    expect(Object.keys((await r.json()).blob.store).length).toBe(0);
    r = await api("a", "os", "GET");
    expect((await r.json()).blob.store["7"].u).toBe("C"); // 他人槽位安然无恙
  });

  it("畸形同步码 400 bad_user（路径校验先于鉴权）", async () => {
    const bad = await api(null, "os", "GET", undefined, "ABC23");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("bad_user");
    expect((await api(null, "os", "GET", undefined, "abc")).status).toBe(400);
    expect((await api(null, "os", "GET", undefined, "abcdefghijk")).status).toBe(400);
  });

  it("认证经门户转发：注册返回 Set-Cookie，随后可用该 Cookie 同步", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/os/api/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "c@example.com", password: "password123" }),
    });
    expect(r.status).toBe(201);
    const cookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
    expect(cookies.join(";")).toContain("exam_session=");
    expect(cookies.join(";").toLowerCase()).toContain("httponly");
    const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const body = await r.json();
    expect(body.user.email).toBe("c@example.com");
    const put = await fetch(`http://127.0.0.1:${PORT}/os/api/store`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ store: { 3: { u: "c", ts: 1 } }, shuf: null, clearedAt: 0 }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).blob.store["3"].u).toBe("c");
  });

  it("门户转发降级：上游不可达 502 svc_down", async () => {
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
      const r = await fetch("http://127.0.0.1:8895/os/api/store");
      expect(r.status).toBe(502);
      expect((await r.json()).error).toBe("svc_down");
    } finally { p2.kill(); }
  });
});