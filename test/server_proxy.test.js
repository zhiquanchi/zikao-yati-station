// server.js（本地开发服务器）回归测试（bun test）：/api/grade 与 /api/store 代理透传/降级/off 禁用，
// 以及科目参数化的静态双根解析（科目产物 data.js/mindmap.html 优先、共享引擎 web/ 兜底）。
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadSubjects } from "../scripts/config.js";

const ROOT = path.join(import.meta.dir, "..");
let portCounter = 0;
const PORT = 8911;
const FAKE_PORT = 8912; // 假 Go 判分服务（POST /api/grade）
const FAKE_STORE = 8913; // 假门户云同步接口（GET/PUT api/store）
const DEAD = 8914; // 无人监听
let serverProc, fake, fakeStore;

async function waitUp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch (e) { /* 尚未就绪 */ }
    await Bun.sleep(50);
  }
  throw new Error("服务启动超时: " + url);
}
function spawnSite(subject, port, gradeApi, storeApi) {
  return Bun.spawn(["bun", "server.js", subject], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), GRADE_API: gradeApi, ...(storeApi ? { STORE_API: storeApi } : {}) },
    stdout: "ignore",
    stderr: "ignore",
  });
}

beforeAll(async () => {
  fake = Bun.serve({
    hostname: "127.0.0.1",
    port: FAKE_PORT,
    async fetch(req) {
      if (req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (b.task === "explain" && b.stream) {
          // 假逐项解析流式上游：delta×2 + done（Go 端帧格式），验证代理聚合不破坏透传
          const s = new ReadableStream({
            start(c) {
              c.enqueue('event: delta\ndata: {"key":"A","text":"并发"}\n\n');
              c.enqueue('event: done\ndata: {"engine":"ai","task":"explain","source":"material","items":[{"key":"A","correct":true,"why":"并发","src":"ref"}]}\n\n');
              c.close();
            },
          });
          return new Response(s, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } });
        }
        return Response.json({ engine: "ai", score: 88, cached: false, per: [{ text: "x", cov: 0.88, state: "hit", comment: "点评", segs: [] }] });
      }
      return Response.json({ ok: true });
    },
  });
  // 假门户 store：GET 给固定槽位，PUT 原样回包（模拟服务端合并返回）；附带 path 回显收到的请求路径（验证码尾段透传）
  fakeStore = Bun.serve({
    hostname: "127.0.0.1",
    port: FAKE_STORE,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET") return Response.json({ path, blob: { store: { 1: { u: "C", s: 100, ts: 11 } }, shuf: null, clearedAt: 0, updatedAt: 11 } });
      if (req.method === "PUT") {
        const b = await req.json().catch(() => null);
        if (!b || !b.store) return Response.json({ error: "bad_payload" }, { status: 400 });
        return Response.json({ path, blob: { store: b.store, shuf: b.shuf, clearedAt: b.clearedAt, updatedAt: 22 } });
      }
      return new Response("405", { status: 405 });
    },
  });
  serverProc = spawnSite("os13180", PORT, `http://127.0.0.1:${FAKE_PORT}/api/grade`, `http://127.0.0.1:${FAKE_STORE}/api/store`);
  await waitUp(`http://127.0.0.1:${PORT}/index.html`);
});

afterAll(() => {
  serverProc?.kill();
  fake?.stop();
  fakeStore?.stop();
});

describe("/api/grade 代理", () => {
  it("上游可达时透传状态与 JSON", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/grade`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stem: "题干", ref: "参考答案", points: ["要点"], answer: "作答" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const data = await r.json();
    expect(data.engine).toBe("ai");
    expect(data.score).toBe(88);
  });

  it("SSE 流式应答原样透传（逐项解析 stream:true 链路）", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/grade`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "explain", stream: true, stem: "题干", options: [{ key: "A", text: "并发" }], answer: "A" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("x-accel-buffering")).toBe("no"); // nginx 关缓冲依赖该头逐跳透传
    const text = await r.text();
    expect(text).toContain("event: delta");
    expect(text).toContain("event: done");
    expect(text).toContain("并发");
  });

  it("上游不可达时返回 502 svc_down（前端据此降级本机估分）", async () => {
    const deadProc = spawnSite("os13180", PORT + 5, `http://127.0.0.1:${DEAD}/api/grade`);
    try {
      await waitUp(`http://127.0.0.1:${PORT + 5}/index.html`);
      const r = await fetch(`http://127.0.0.1:${PORT + 5}/api/grade`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(r.status).toBe(502);
      const data = await r.json();
      expect(data.error).toBe("svc_down");
    } finally {
      deadProc.kill();
    }
  });
});

describe("/api/store 云同步代理", () => {
  it("GET/PUT 透传上游 JSON 与状态码", async () => {
    const g = await fetch(`http://127.0.0.1:${PORT}/api/store`);
    expect(g.status).toBe(200);
    expect(g.headers.get("content-type")).toContain("application/json");
    expect((await g.json()).blob.store["1"].u).toBe("C");
    const p = await fetch(`http://127.0.0.1:${PORT}/api/store`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ store: { 5: { u: "x", ts: 9 } }, shuf: null, clearedAt: 0 }),
    });
    expect(p.status).toBe(200);
    const blob = (await p.json()).blob;
    expect(blob.store["5"].u).toBe("x");
    expect(blob.updatedAt).toBe(22);
    const bad = await fetch(`http://127.0.0.1:${PORT}/api/store`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400); // 上游校验码原样透传
  });
  it("非 GET/PUT 一律 405（不透传）", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/store`, { method: "POST", body: "{}" });
    expect(r.status).toBe(405);
  });
  it("门户不可达时 502 svc_down（前端转离线提示）", async () => {
    const deadProc = spawnSite("os13180", PORT + 6, `http://127.0.0.1:${FAKE_PORT}/api/grade`, `http://127.0.0.1:${DEAD}/api/store`);
    try {
      await waitUp(`http://127.0.0.1:${PORT + 6}/index.html`);
      const r = await fetch(`http://127.0.0.1:${PORT + 6}/api/store`);
      expect(r.status).toBe(502);
      expect((await r.json()).error).toBe("svc_down");
    } finally {
      deadProc.kill();
    }
  });
  it("STORE_API=off 直接 502（本机禁用云同步）", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/store`); // 主实例已连假门户，另起 off 实例
    expect(r.status).toBe(200);
    const offProc = spawnSite("os13180", PORT + 7, `http://127.0.0.1:${FAKE_PORT}/api/grade`, "off");
    try {
      await waitUp(`http://127.0.0.1:${PORT + 7}/index.html`);
      const o = await fetch(`http://127.0.0.1:${PORT + 7}/api/store`);
      expect(o.status).toBe(502);
      expect((await o.json()).error).toBe("svc_down");
    } finally {
      offProc.kill();
    }
  });
  it("同步码尾段原样透传（/api/store/<码> → 上游同路径）", async () => {
    const g = await fetch(`http://127.0.0.1:${PORT}/api/store/abcd23`);
    expect(g.status).toBe(200);
    expect((await g.json()).path).toBe("/api/store/abcd23");
    const p = await fetch(`http://127.0.0.1:${PORT}/api/store/abcd23`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ store: { 6: { u: "y", ts: 8 } }, shuf: null, clearedAt: 0 }),
    });
    const pj = await p.json();
    expect(pj.path).toBe("/api/store/abcd23");
    expect(pj.blob.store["6"].u).toBe("y");
  });
  it("STORE_API=off 时带码请求同样 502（off 判定不受尾段影响）", async () => {
    const offProc = spawnSite("os13180", PORT + 8, `http://127.0.0.1:${FAKE_PORT}/api/grade`, "off");
    try {
      await waitUp(`http://127.0.0.1:${PORT + 8}/index.html`);
      const o = await fetch(`http://127.0.0.1:${PORT + 8}/api/store/abcd23`);
      expect(o.status).toBe(502);
      expect((await o.json()).error).toBe("svc_down");
    } finally {
      offProc.kill();
    }
  });
});

// ——— 科目参数化的静态解析：每个科目都能起站、都拿自己的题库、共享引擎兜底 ———
for (const s of loadSubjects()) {
  if (!existsSync(path.join(s.dir, "data.js"))) continue; // 骨架科目（尚无题库）跳过
  describe(`静态双根解析 · ${s.slug}`, () => {
    let proc, port;
    beforeAll(async () => {
      port = 8931 + portCounter++;
      proc = spawnSite(s.slug, port, `http://127.0.0.1:${FAKE_PORT}/api/grade`, `http://127.0.0.1:${FAKE_STORE}/api/store`);
      await waitUp(`http://127.0.0.1:${port}/index.html`);
    });
    afterAll(() => proc?.kill());

    it("通用骨架 + 题库 meta + 科目产物 + 共享引擎", async () => {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(html).toContain("押题练习"); // 共享骨架文案（科目文案由 app.js 注入）
      const djs = await (await fetch(`http://127.0.0.1:${port}/data.js`)).text();
      expect(djs).toContain(`"storageKey":"${s.storageKey}"`); // 科目目录产物优先
      expect(djs).toContain(`"prefix":"${s.prefix}"`);
      for (const f of ["app.js", "grading.js", "sync.js", "identity.js", "recite.js", "memo.js", "subject-switch.js", "styles.css", "subjects.js"]) {
        expect((await fetch(`http://127.0.0.1:${port}/${f}`)).status).toBe(200); // web/ 共享引擎兜底
      }
      if (s.mindmap && s.mindmap.enabled) {
        expect((await fetch(`http://127.0.0.1:${port}/mindmap.html`)).status).toBe(200);
      }
      const subs = await (await fetch(`http://127.0.0.1:${port}/subjects.js`)).text();
      expect(subs).toContain(`"prefix":"${s.prefix}"`);
    });
    it("目录穿越不逃逸", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/..%2f..%2fserver.js`);
      expect(r.status).toBe(404);
    });
    it("缺科目参数时退出并给出用法", async () => {
      const p = Bun.spawn(["bun", "server.js"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
      await p.exited;
      expect(p.exitCode).not.toBe(0);
      expect(out).toContain("用法");
    });
  });
}
