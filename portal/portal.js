// 押题门户静态网关（Bun 运行时）：/os/ → 操作系统站，/net/ → 网络安全站，任意多科目同理——
// 科目清单读 portal/subjects.json（scripts/build.js 依据全部 subjects/<科目>/subject.json 生成，勿手改），
// 裸根 / 落主科目（primary）。新增科目只需进 subjects/ 并重新 build，门户自动纳入，无需改本文件。
// POST /<科目>/api/grade 代理到该科目的 Go 判分服务（GRADE_<PREFIX大写>），不可达返回 502 svc_down（前端据此降级本机估分）。
// GET/PUT /<科目>/api/store[/<同步码>] 云同步代理到 Go 云同步服务 sync-svc（SYNC_API，槽位与合并口径见
// grade-svc/cmd/syncsvc——多用户按码分槽，不带码＝旧版兼容全局槽；门户不执行业务逻辑，与判分代理同理）。
// 本地调试可用 <PREFIX>_ROOT / GRADE_<PREFIX大写> / SYNC_API / PORT 环境变量覆盖根目录、判分上游等。
import path from "node:path";

// 中文目录名 URL 会百分号编码，用 import.meta.dir 直拼（bun ESM 特性）
const manifest = await Bun.file(path.join(import.meta.dir, "subjects.json")).json();
const prefixes = manifest.map((s) => s.prefix);
const primary = (manifest.find((s) => s.primary) || manifest[0]).prefix;
const up = (p) => p.toUpperCase();
const ROOTS = Object.fromEntries(manifest.map((s) => [s.prefix, process.env[up(s.prefix) + "_ROOT"] || "/srv/" + s.prefix]));
const GRADE = Object.fromEntries(manifest.map((s) => [s.prefix, process.env["GRADE_" + up(s.prefix)] || "http://grade-svc-" + s.prefix + ":8792/api/grade"]));
const SYNC_UP = process.env.SYNC_API || "http://sync-svc:8793";
const rePrefix = new RegExp("^/(" + prefixes.join("|") + ")(?:/(.*))?$");

const redir = (loc) => new Response(null, { status: 302, headers: { location: loc } });

const server = Bun.serve({
  hostname: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 80),
  async fetch(req) {
    const url = new URL(req.url);
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (e) { return new Response("Bad Request", { status: 400 }); }
    if (p === "/__health") return Response.json({ ok: true, subjects: prefixes });
    if (p === "/" || p === "") return redir("/" + primary + "/");
    const m = p.match(rePrefix);
    if (!m) return new Response("404 Not Found: " + p, { status: 404 });
    const subject = m[1];
    const rest = m[2] === undefined ? null : m[2];
    if (rest === null) return redir("/" + subject + "/"); // 裸 /os /net 补斜杠

    // AI 判分代理：各科目独立上游（prompt 科目措辞与参考资料随 SUBJECT_DIR 注入）；
    // 超时覆盖单选逐项解析两级上游链路（Go 侧预算 85s），取 95s。
    if (rest === "api/grade") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      try {
        const up_ = await fetch(GRADE[subject], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await req.text(),
          signal: AbortSignal.timeout(95000),
        });
        return new Response(await up_.text(), { status: up_.status, headers: { "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: "svc_down", detail: String((e && e.message) || e) }), {
          status: 502, headers: { "content-type": "application/json" },
        });
      }
    }

    // 作答进度云同步代理：转发到 Go 云同步服务（sync-svc）——槽位=(科目,用户)，带码即私有槽，
    // 不带码走旧版兼容全局槽；合并/校验/落库业务逻辑全在 Go 端，门户仅搬运（超时 30s 富余覆盖慢网络 PUT）。
    if (rest === "api/store" || rest.startsWith("api/store/")) {
      const tail = rest.slice("api/store".length); // "" 或 "/<同步码>"
      try {
        const up2 = await fetch(SYNC_UP + "/store/" + subject + tail, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
          signal: AbortSignal.timeout(30000),
        });
        return new Response(await up2.text(), {
          status: up2.status,
          headers: { "content-type": up2.headers.get("content-type") || "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "svc_down", detail: String((e && e.message) || e) }), {
          status: 502, headers: { "content-type": "application/json" },
        });
      }
    }

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

console.log(`🏛 押题门户已启动（Bun ${Bun.version}）：` + prefixes.map((s) => server.url + s + "/").join(" · ") + `（主科目 /${primary}/）`);
