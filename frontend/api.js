// 唯一网络层：所有业务请求走 API v1，页面不解释会话、不算分、不合并。
// 错误码统一映射中文；SSE 只负责解析事件，不做业务判断。
(function (root) {
  "use strict";

  const ERRORS = {
    bad_email: "邮箱格式不正确",
    bad_password: "密码需 8~128 位",
    email_taken: "该邮箱已注册，请直接登录",
    bad_credentials: "邮箱或密码不正确",
    registration_closed: "本站暂未开放注册",
    too_many_attempts: "尝试次数过多，请稍后再试",
    unauthorized: "登录已过期，请重新登录",
    bad_origin: "请求来源校验失败，请刷新页面重试",
    bad_request: "请求格式不正确",
    unsupported_media_type: "请求格式不正确",
    mail_unavailable: "邮件服务未配置，请联系站长",
    invalid_token: "链接无效或已过期，请重新获取",
    email_not_verified: "请先验证邮箱（可重新发送验证邮件）",
    already_verified: "邮箱已验证",
    no_key: "未配置 AI 密钥",
    bad_key: "AI 密钥无效",
    svc_down: "服务未启动",
    timeout: "上游超时，请重试",
    parse: "上游输出解析失败",
    upstream: "上游服务错误",
    internal: "服务内部错误",
    network: "网络中断，请检查网络后重试",
    incomplete: "连接中断，解析未完成，请重试",
    empty_pool: "当前筛选条件下没有题目",
    unknown_subject: "未知科目",
    question_not_found: "题目不存在",
    bad_input: "作答内容不合法",
    not_guest: "没有可合并的游客进度",
  };

  let base = "/api/v1";
  let prefix = (location.pathname.split("/")[1] || "").trim();
  let ready = null;

  function message(code) { return ERRORS[code] || "操作失败，请稍后重试"; }

  function bootstrap() {
    if (!ready) {
      ready = fetch("config.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => { if (c && c.apiBase) base = String(c.apiBase).replace(/\/+$/, ""); })
        .catch(() => {});
    }
    return ready;
  }

  async function call(path, opts, timeoutMs) {
    await bootstrap();
    const o = opts || {};
    const init = { method: o.method || (o.body === undefined ? "GET" : "POST"), credentials: "same-origin", signal: AbortSignal.timeout(timeoutMs || 20000) };
    if (o.body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(o.body);
    }
    let res;
    try {
      res = await fetch(base + path, init);
    } catch (e) {
      const code = e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network";
      throw errOf(code, 0);
    }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw errOf((data && data.error) || "http_" + res.status, res.status);
    return data;
  }

  function errOf(code, status) {
    const e = new Error(message(code));
    e.code = code;
    e.status = status;
    return e;
  }

  const subjectPath = (suffix) => "/subjects/" + encodeURIComponent(prefix) + suffix;

  const api = {
    message,
    prefix: () => prefix,
    setPrefix: (p) => { prefix = String(p || ""); },
    // 账号
    me: () => call("/auth/me", undefined, 3000),
    guest: () => call("/auth/guest", { body: {} }),
    login: (email, password) => call("/auth/login", { body: { email, password } }),
    register: (email, password) => call("/auth/register", { body: { email, password } }),
    logout: () => call("/auth/logout", { body: {} }, 5000),
    claim: (guestSlot) => call("/auth/claim", { body: { guest_slot: guestSlot } }),
    requestReset: (email) => call("/auth/request-reset", { body: { email } }),
    resetPassword: (token, password) => call("/auth/reset-password", { body: { token, password } }),
    verifyEmail: (token) => call("/auth/verify-email", { body: { token } }),
    resendVerify: (email) => call("/auth/resend-verify", { body: { email } }),
    // 科目与进度
    subjects: () => call("/subjects"),
    catalog: () => call(subjectPath("/catalog")),
    progress: () => call(subjectPath("/progress")),
    answer: (doc) => call(subjectPath("/answers"), { body: doc }, 45000),
    redo: (qid) => call(subjectPath("/answers/" + qid + "/redo"), { body: {} }),
    seen: (qids) => (qids.length ? call(subjectPath("/seen"), { body: { qids } }) : Promise.resolve()),
    viewed: (qid) => call(subjectPath("/viewed"), { body: { qid } }),
    paper: (filters) => call(subjectPath("/papers"), { body: filters || {} }),
    clearPaper: () => call(subjectPath("/papers"), { method: "DELETE" }),
    clearProgress: () => call(subjectPath("/progress/clear"), { body: {} }),
    stats: () => call(subjectPath("/stats")),
    recite: () => call(subjectPath("/recite")),
    memo: () => call(subjectPath("/memo")),
    migrate: (subject, blob) => call("/migrate", { body: { subject, blob } }),
    // 逐项解析（SSE；非 SSE 应答回落整包 JSON）
    explain: async (qid, onEvent) => {
      await bootstrap();
      let res;
      try {
        res = await fetch(base + subjectPath("/explain"), {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ qid, stream: true }),
          signal: AbortSignal.timeout(95000),
        });
      } catch (e) {
        throw errOf(e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network", 0);
      }
      if (!res.ok) {
        let data = null; try { data = await res.json(); } catch (e) {}
        throw errOf((data && data.error) || "http_" + res.status, res.status);
      }
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/event-stream")) {
        const data = await res.json();
        if (onEvent) onEvent("delta-done", data);
        return data;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let done = null;
      while (true) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message", data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload = null; try { payload = JSON.parse(data); } catch (e) {}
          if (event === "error") throw errOf((payload && payload.error) || "upstream", 0);
          if (event === "done") { done = payload; continue; }
          if (onEvent) onEvent(event, payload);
        }
      }
      if (!done) throw errOf("incomplete", 0);
      if (onEvent) onEvent("done", done);
      return done;
    },
  };

  root.API = api;
})(typeof window !== "undefined" ? window : globalThis);