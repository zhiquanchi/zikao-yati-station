// 押题门户静态网关（Bun 运行时）：/os/ → 13180 操作系统站，/net/ → 04751 网络安全站；裸根 / 落 /os/。
// POST /os|net/api/grade 代理到对应科目的 Go 判分服务（GRADE_OS / GRADE_NET），不可达返回 502 svc_down（前端据此降级本机估分）。
// /os|net/api/store 作答进度云同步（store.js · bun:sqlite，每科目全局单槽，服务端合并为收敛点）。
// 本地调试可用 OS_ROOT / NET_ROOT / PORT / GRADE_OS / GRADE_NET / STORE_DB 环境变量覆盖。
import path from "node:path";
import { handleStore } from "./store.js";

const ROOTS = {
  os: process.env.OS_ROOT || "/srv/os",
  net: process.env.NET_ROOT || "/srv/net",
};
const GRADE = {
  os: process.env.GRADE_OS || "http://grade-svc-os:8792/api/grade",
  net: process.env.GRADE_NET || "http://grade-svc-net:8792/api/grade",
};

const redir = (loc) => new Response(null, { status: 302, headers: { location: loc } });

const server = Bun.serve({
  hostname: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 80),
  async fetch(req) {
    const url = new URL(req.url);
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (e) { return new Response("Bad Request", { status: 400 }); }
    if (p === "/" || p === "") return redir("/os/");
    if (p === "/os" || p === "/net") return redir(p + "/");
    const m = p.match(/^\/(os|net)\/(.*)$/);
    if (!m) return new Response("404 Not Found: " + p, { status: 404 });
    const subject = m[1];
    const rest = m[2];

    // AI 判分代理：两科各自独立上游（prompt 科目措辞不同）；
    // 超时覆盖单选逐项解析两级上游链路（Go 侧预算 85s），取 95s。
    if (rest === "api/grade") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      try {
        const up = await fetch(GRADE[subject], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await req.text(),
          signal: AbortSignal.timeout(95000),
        });
        return new Response(await up.text(), { status: up.status, headers: { "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: "svc_down", detail: String((e && e.message) || e) }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // 作答进度云同步：store.js 直接读写 SQLite（合并口径与两科目前端 sync.js 一致）
    if (rest === "api/store") return handleStore(subject, req);

    // 静态文件：去前缀后在科目根内解析，防目录穿越
    let rel = rest === "" ? "index.html" : path.normalize("/" + rest).replace(/^\/+/, "");
    if (rel.endsWith("/")) rel += "index.html";
    const root = ROOTS[subject];
    const file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    const f = Bun.file(file);
    if (await f.exists() && f.size > 0) return new Response(f); // Bun 自动按扩展名设置 Content-Type
    return new Response("404 Not Found: " + p, { status: 404 });
  },
});

console.log(`🏛 押题门户已启动（Bun ${Bun.version}）：${server.url}os/ · ${server.url}net/`);
