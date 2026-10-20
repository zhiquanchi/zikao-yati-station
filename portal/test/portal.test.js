// 门户路由回归测试（bun test）：重定向、双科静态、判分代理按科目分流、降级与防穿越。
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";

const ROOT = import.meta.dir;
const PORT = 8895;
const FAKE_OS = 8897, FAKE_NET = 8898, DEAD = 8896;
let portal, fakeOs, fakeNet;

// 假科目目录：各放一个 index.html 便于断言来源
function fixture(name, marker) {
  const dir = path.join(ROOT, ".fixtures", name);
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
  fakeOs = Bun.serve({ hostname: "127.0.0.1", port: FAKE_OS, fetch: () => Response.json({ engine: "ai", subject: "os", score: 88, per: [] }) });
  fakeNet = Bun.serve({ hostname: "127.0.0.1", port: FAKE_NET, fetch: () => Response.json({ engine: "ai", subject: "net", score: 66, per: [] }) });
  const proc = Bun.spawn(["bun", "portal.js"], {
    cwd: path.join(ROOT, ".."),
    env: {
      ...process.env, PORT: String(PORT),
      OS_ROOT: fixture("os", "OS-SITE"), NET_ROOT: fixture("net", "NET-SITE"),
      GRADE_OS: `http://127.0.0.1:${FAKE_OS}/api/grade`,
      GRADE_NET: `http://127.0.0.1:${DEAD}/api/grade`, // 未启动科目 → svc_down
    },
    stdout: "ignore", stderr: "ignore",
  });
  portal = proc;
  await waitUp(`http://127.0.0.1:${PORT}/`);
});

afterAll(() => { portal?.kill(); fakeOs?.stop(); fakeNet?.stop(); });

describe("门户路由", () => {
  it("/ 与裸 /os /net 重定向到带斜杠入口", async () => {
    for (const [p, loc] of [["/", "/os/"], ["/os", "/os/"], ["/net", "/net/"]]) {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { redirect: "manual" });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(loc);
    }
  });
  it("双科静态按前缀分流、未知路径 404", async () => {
    expect(await (await fetch(`http://127.0.0.1:${PORT}/os/`)).text()).toContain("OS-SITE");
    expect(await (await fetch(`http://127.0.0.1:${PORT}/net/`)).text()).toContain("NET-SITE");
    expect((await fetch(`http://127.0.0.1:${PORT}/os/styles.css`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${PORT}/other/`)).status).toBe(404);
  });
  it("判分代理按科目走各自上游；上游不可达返回 502 svc_down", async () => {
    const body = JSON.stringify({ stem: "题干", ref: "参考答案", points: ["要点"], answer: "作答" });
    const rOs = await fetch(`http://127.0.0.1:${PORT}/os/api/grade`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(rOs.status).toBe(200);
    expect((await rOs.json()).subject).toBe("os");
    const rNet = await fetch(`http://127.0.0.1:${PORT}/net/api/grade`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(rNet.status).toBe(502);
    expect((await rNet.json()).error).toBe("svc_down");
    expect((await fetch(`http://127.0.0.1:${PORT}/os/api/grade`)).status).toBe(405);
  });
  it("目录穿越被拒（编码与点段都拦下，绝不逃逸科目根）", async () => {
    for (const p of ["/os/..%2f..%2fportal.js", "/os/%2e%2e/%2e%2e/portal.js", "/net/../../../../etc/passwd"]) {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
      expect([200]).not.toContain(r.status);
      expect(r.status === 200 && (await r.text()).includes("Bun.serve")).toBe(false);
    }
  });
});
