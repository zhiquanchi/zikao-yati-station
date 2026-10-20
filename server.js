// 本地开发静态服务器（Bun 运行时）：bun server.js <科目>（目录名或 prefix，如 os13180 / net / os）。
// 静态双根解析：先科目目录（data.js、mindmap.html 等科目产物），再 web/（共享前端引擎）。
// /api/grade 与 /api/store 默认代理线上（部署约定：本机不常驻判分/门户服务，本机与云端同源）：
//   GRADE_API 用环境变量覆盖（./start-ai.sh <科目> 本地联调时自动指向本地 Go 服务）；
//   STORE_API 置 off 可本机禁用云同步；/api/store 与 /api/store/<同步码> 尾段原样转发
//   （多用户槽位由 Go 云同步服务区分，本机与线上同码即同进度）。判分服务不可达 → svc_down；未配 Key → 透传 501 no_key；前端据此降级。
// 超时 95s 覆盖单选逐项解析两级上游链路（Go 侧预算 85s）。
import path from "node:path";
import { findSubject, WEB_DIR } from "./scripts/config.js";

let subject;
try { subject = findSubject(process.argv[2]); } catch (e) {
  console.error(e.message + "\n用法：bun server.js <科目>（bun run start os13180）");
  process.exit(1);
}
const ONLINE = "http://121.40.43.229/" + subject.prefix;
const GRADE_API = process.env.GRADE_API || ONLINE + "/api/grade";
const STORE_API = process.env.STORE_API || ONLINE + "/api/store";
const port = Number(process.env.PORT || (subject.ports && subject.ports.web) || 8791);

async function proxy(req, target, timeoutMs, allowMethods) {
  if (target === "off") {
    return new Response(JSON.stringify({ error: "svc_down", detail: "本代理已禁用（" + target + "）" }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
  if (allowMethods && !allowMethods.includes(req.method)) {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
  }
  try {
    const up = await fetch(target, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return new Response(await up.text(), { status: up.status, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "svc_down", detail: String((e && e.message) || e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}

const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1", // 主机直跑仅本机可达；容器部署以 HOST=0.0.0.0 暴露给端口映射
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === "/api/grade" && req.method === "POST") return proxy(req, GRADE_API, 95000);
    if (p === "/api/store" || p.startsWith("/api/store/")) {
      const tail = p.slice("/api/store".length); // "" 或 "/<同步码>"
      return proxy(req, STORE_API === "off" ? "off" : STORE_API + tail, 15000, ["GET", "PUT"]);
    }
    if (p === "/" || p === "") p = "/index.html";
    // 防目录穿越：规范化后必须仍在根内；解析顺序＝科目产物优先、共享引擎兜底
    const rel = path.normalize(p).replace(/^([/\\])+/, "");
    for (const root of [subject.dir, WEB_DIR]) {
      const file = path.join(root, rel);
      if (file !== root && !file.startsWith(root + path.sep)) continue;
      const f = Bun.file(file);
      if (await f.exists() && f.size > 0) return new Response(f); // Bun 自动按扩展名设置 Content-Type
    }
    return new Response("404 Not Found: " + p, { status: 404 });
  },
});

console.log(`📚 ${subject.pageTitle} 练习站已启动（Bun ${Bun.version}）：${server.url}（科目 ${subject.name}，判分/同步代理 ${GRADE_API}）`);
