// 押题门户静态网关（Bun 运行时）：/os/ → 操作系统站，/net/ → 网络安全站，任意多科目同理——
// 科目清单读 portal/subjects.json（scripts/build.js 依据全部 subjects/<科目>/subject.json 生成，勿手改），
// 裸根 / 落主科目（primary）。新增科目只需进 subjects/ 并重新 build，门户自动纳入，无需改本文件。
// POST /<科目>/api/grade 代理到该科目的 Go 判分服务（GRADE_<PREFIX大写>），不可达返回 502 svc_down（前端据此降级本机估分）。
// /<科目>/api/store 作答进度云同步（store.js · bun:sqlite，每科目全局单槽，服务端合并为收敛点）。
// 本地调试可用 <PREFIX>_ROOT / GRADE_<PREFIX大写> / PORT / STORE_DB 环境变量覆盖根目录、判分上游等。
import path from "node:path";
import { handleStore } from "./store.js";

// 中文目录名 URL 会百分号编码，用 import.meta.dir 直拼（bun ESM 特性）
const manifest = await Bun.file(path.join(import.meta.dir, "subjects.json")).json();
const prefixes = manifest.map((s) => s.prefix);
const primary = (manifest.find((s) => s.primary) || manifest[0]).prefix;
const up = (p) => p.toUpperCase();
const ROOTS = Object.fromEntries(manifest.map((s) => [s.prefix, process.env[up(s.prefix) + "_ROOT"] || "/srv/" + s.prefix]));
const GRADE = Object.fromEntries(manifest.map((s) => [s.prefix, process.env["GRADE_" + up(s.prefix)] || "http://grade-svc-" + s.prefix + ":8792/api/grade"]));
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

    // 作答进度云同步：store.js 直接读写 SQLite（合并口径与前端 sync.js 一致，交叉校验见 test/merge_xcheck.test.js）
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

console.log(`🏛 押题门户已启动（Bun ${Bun.version}）：` + prefixes.map((s) => server.url + s + "/").join(" · ") + `（主科目 /${primary}/）`);
