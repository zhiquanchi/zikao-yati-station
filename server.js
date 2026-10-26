// 本地开发静态服务器 + API 代理：bun run start（无科目参数）。
// 静态根＝build/web（先跑 bun run build && bun run stage）；/api/* 全量转发到本地 apivc。
// 任何路由判断只做「静态文件 / API 反代」二分，不含业务逻辑。
import path from "node:path";
import { existsSync } from "node:fs";
import { ROOT } from "./scripts/config.js";

const WEB = path.join(ROOT, "build", "web");
const API = (process.env.API_ORIGIN || "http://127.0.0.1:8793").replace(/\/+$/, "");
const port = Number(process.env.PORT || 8791);

if (!existsSync(path.join(WEB, "index.html"))) {
  console.error("缺 build/web/index.html：请先 bun run build && bun run stage");
  process.exit(1);
}

async function proxy(req, target, timeoutMs) {
  try {
    const headers = new Headers();
    headers.set("content-type", req.headers.get("content-type") || "application/json");
    const cookie = req.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
    headers.set("x-forwarded-host", req.headers.get("x-forwarded-host") || new URL(req.url).host);
    headers.set("x-forwarded-prefix", new URL(req.url).pathname.split("/").slice(0, 2).join("/") + "/");
    const up = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
      signal: AbortSignal.timeout(timeoutMs || 95000),
    });
    const ct = up.headers.get("content-type") || "application/json";
    const out = new Headers({ "content-type": ct });
    const cookies = typeof up.headers.getSetCookie === "function" ? up.headers.getSetCookie() : [];
    for (const c of cookies) out.append("set-cookie", c);
    if (ct.includes("text/event-stream")) {
      out.set("cache-control", "no-cache");
      out.set("x-accel-buffering", "no");
      return new Response(up.body, { status: up.status, headers: out });
    }
    return new Response(await up.text(), { status: up.status, headers: out });
  } catch (e) {
    const timedOut = !!e && (e.name === "TimeoutError" || e.name === "AbortError");
    return new Response(JSON.stringify(timedOut
      ? { error: "timeout", detail: "上游超时" }
      : { error: "svc_down", detail: String((e && e.message) || e) }), {
      status: timedOut ? 504 : 502, headers: { "content-type": "application/json" },
    });
  }
}

const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (e) { return new Response("Bad Request", { status: 400 }); }
    if (p.startsWith("/api/")) return proxy(req, API + p);
    if (p === "/" || p === "") return new Response(null, { status: 302, headers: { location: "/" + (process.env.PRIMARY_PREFIX || "os") + "/" } });
    // /<prefix>/<asset> → build/web/<asset>；/<prefix>/ → index.html
    const m = p.match(/^\/([a-z0-9]{1,32})(?:\/(.*))?$/);
    const rel = m ? (m[2] || "index.html") : p.replace(/^\/+/, "");
    const file = path.join(WEB, path.normalize(rel));
    if (file !== WEB && !file.startsWith(WEB + path.sep)) return new Response("Forbidden", { status: 403 });
    const f = Bun.file(file);
    if (await f.exists() && f.size > 0) return new Response(f);
    // 前端路由/未知静态资源回落到 index.html（同一份 SPA 按 URL 前缀识别科目）
    const idx = Bun.file(path.join(WEB, "index.html"));
    return new Response(idx);
  },
});

console.log(`📚 练习站已启动：${server.url}（静态 build/web，API → ${API}）`);