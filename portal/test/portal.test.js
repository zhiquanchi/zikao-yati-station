// 门户路由回归测试（bun test）：科目清单驱动（读 portal/subjects.json，加科目零改用例）——
// 重定向、各科静态按前缀分流、判分代理独立上游、降级、防穿越、/__health。
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";

const ROOT = import.meta.dir;
const PORT = 8925;
const FAKE_LIVE = 8926; // 在线的假判分上游
const DEAD_BASE = 8927; // 离线科目上游端口段
let portal, fakeLive;

// 清单驱动
const manifest = await Bun.file(path.join(ROOT, "..", "subjects.json")).json();
const prefixes = manifest.map((s) => s.prefix);
const primary = (manifest.find((s) => s.primary) || manifest[0]).prefix;
const up = (p) => p.toUpperCase();

// 假科目目录：各放一个 index.html 便于断言来源
function fixture(prefix, marker) {
  const dir = path.join(ROOT, ".fixtures", prefix);
  Bun.write(path.join(dir, "index.html"), "<h1>" + marker + "</h1>");
  Bun.write(path.join(dir, "styles.css"), "/*x*/");
  return dir;
}

async function waitUp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { redirect: "manual" }); if (r.status < 500) return; } catch (e) {}
    await Bun.sleep(50);
  }
  throw new Error("服务启动超时: " + url);
}

beforeAll(async () => {
  fakeLive = Bun.serve({
    hostname: "127.0.0.1", port: FAKE_LIVE,
    async fetch(req) {
      const b = await req.json().catch(() => ({}));
      if (b.task === "explain" && b.stream) {
        // 假逐项解析流式上游（Go 帧格式）：验证门户代理逐帧透传不聚合
        const s = new ReadableStream({
          start(c) {
            c.enqueue('event: delta\ndata: {"key":"A","text":"并发"}\n\n');
            c.enqueue('event: done\ndata: {"engine":"ai","task":"explain","source":"material","items":[{"key":"A","correct":true,"why":"并发","src":"ref"}]}\n\n');
            c.close();
          },
        });
        return new Response(s, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } });
      }
      return Response.json({ engine: "ai", subject: "live", score: 88, per: [] });
    },
  });
  const env = { ...process.env, PORT: String(PORT) };
  prefixes.forEach((pre, i) => {
    env[up(pre) + "_ROOT"] = fixture(pre, pre.toUpperCase() + "-SITE");
    // 第一个科目接活上游，其余接死端口（验证按科目独立分流与 502 降级）
    env["GRADE_" + up(pre)] = i === 0 ? `http://127.0.0.1:${FAKE_LIVE}/api/grade` : `http://127.0.0.1:${DEAD_BASE + i}/api/grade`;
  });
  const proc = Bun.spawn(["bun", "portal.js"], { cwd: path.join(ROOT, ".."), env, stdout: "ignore", stderr: "ignore" });
  portal = proc;
  await waitUp(`http://127.0.0.1:${PORT}/`);
});

afterAll(() => { portal?.kill(); fakeLive?.stop(); });

describe("门户路由", () => {
  it("裸根落主科目；各科目裸前缀补斜杠", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/${primary}/`);
    for (const pre of prefixes) {
      const rr = await fetch(`http://127.0.0.1:${PORT}/${pre}`, { redirect: "manual" });
      expect(rr.status).toBe(302);
      expect(rr.headers.get("location")).toBe(`/${pre}/`);
    }
  });
  it("各科静态按前缀分流、未知路径 404", async () => {
    for (const pre of prefixes) {
      expect(await (await fetch(`http://127.0.0.1:${PORT}/${pre}/`)).text()).toContain(pre.toUpperCase() + "-SITE");
      expect((await fetch(`http://127.0.0.1:${PORT}/${pre}/styles.css`)).status).toBe(200);
    }
    expect((await fetch(`http://127.0.0.1:${PORT}/nosuch/`)).status).toBe(404);
  });
  it("判分代理按科目走各自上游；上游不可达返回 502 svc_down", async () => {
    const body = JSON.stringify({ stem: "题干", ref: "参考答案", points: ["要点"], answer: "作答" });
    const live = prefixes[0];
    const rLive = await fetch(`http://127.0.0.1:${PORT}/${live}/api/grade`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(rLive.status).toBe(200);
    expect((await rLive.json()).subject).toBe("live");
    for (const pre of prefixes.slice(1)) {
      const r = await fetch(`http://127.0.0.1:${PORT}/${pre}/api/grade`, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(r.status).toBe(502);
      expect((await r.json()).error).toBe("svc_down");
    }
    expect((await fetch(`http://127.0.0.1:${PORT}/${live}/api/grade`)).status).toBe(405);
  });
  it("逐项解析 SSE 流式应答原样透传（含 X-Accel-Buffering 供 nginx 关缓冲）", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/${prefixes[0]}/api/grade`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "explain", stream: true, stem: "题干", options: [{ key: "A", text: "并发" }], answer: "A" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("x-accel-buffering")).toBe("no");
    const text = await r.text();
    expect(text).toContain("event: delta");
    expect(text).toContain("event: done");
    expect(text).toContain("并发");
  });
  it("目录穿越被拒（编码与点段都拦下，绝不逃逸科目根）", async () => {
    for (const pre of prefixes) {
      for (const p of [`/${pre}/..%2f..%2fportal.js`, `/${pre}/%2e%2e/%2e%2e/portal.js`, `/${pre}/../../../../etc/passwd`]) {
        const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
        expect([200]).not.toContain(r.status);
      }
    }
  });
  it("/__health 汇报全部科目前缀", async () => {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/__health`)).json();
    expect(j.ok).toBe(true);
    expect(j.subjects).toEqual(prefixes);
  });
});
