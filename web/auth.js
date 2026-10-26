// 账号认证（经典脚本 · 零依赖 · 无 DOM）：只负责同源 fetch 与错误码到中文文案的映射。
// 密码哈希、会话签发、注册开关、限流全部在 Go 端（grade-svc/cmd/syncsvc/auth.go）；
// 浏览器不读取会话 token（HttpOnly Cookie），只持有服务端返回的 {email, slot} 用于显示与分区。
(function (root) {
  "use strict";
  const BASE = "api/auth";
  const ERRORS = {
    bad_email: "邮箱格式不正确",
    bad_password: "密码需 8~128 位",
    email_taken: "该邮箱已注册，请直接登录",
    bad_credentials: "邮箱或密码不正确",
    registration_closed: "本站暂未开放注册",
    too_many_attempts: "尝试次数过多，请稍后再试",
    unauthorized: "请先登录",
    bad_origin: "请求来源校验失败，请刷新页面重试",
    bad_request: "请求格式不正确",
    unsupported_media_type: "请求格式不正确",
    mail_unavailable: "邮件服务未配置，请联系站长",
    invalid_token: "链接无效或已过期，请重新获取",
    email_not_verified: "请先验证邮箱（可重新发送验证邮件）",
    already_verified: "邮箱已验证",
  };

  let currentUser = null;
  let lastStatus = 0; // 最近一次 me 的 HTTP 状态；0＝网络失败，401＝会话失效

  const message = (code) => ERRORS[code] || "操作失败，请稍后重试";

  async function call(path, body, timeoutMs) {
    const res = await fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      signal: AbortSignal.timeout(timeoutMs || 15000),
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const code = (data && data.error) || (res.status === 401 ? "unauthorized" : "http_" + res.status);
      const err = new Error(message(code));
      err.code = code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // me：启动时静默探测登录态；3 秒超时，网络失败按未登录处理，绝不阻塞页面。
  async function me() {
    try {
      const d = await call("/me", undefined, 3000);
      lastStatus = 200;
      currentUser = d && d.user ? d.user : null;
      return currentUser;
    } catch (e) {
      lastStatus = (e && e.status) || 0;
      currentUser = null;
      return null;
    }
  }

  async function register(email, password) {
    const d = await call("/register", { email, password });
    currentUser = d && d.user ? d.user : null;
    return d;
  }

  async function login(email, password) {
    const d = await call("/login", { email, password });
    currentUser = d && d.user ? d.user : null;
    return d;
  }

  async function logout() {
    try { await call("/logout", {}, 5000); } catch (e) {}
    currentUser = null;
  }

  async function requestReset(email) {
    return call("/request-reset", { email });
  }

  async function resetPassword(token, password) {
    const d = await call("/reset-password", { token, password });
    currentUser = null; // 服务端已删除全部会话
    return d;
  }

  async function verifyEmail(token) {
    const d = await call("/verify-email", { token });
    if (d && d.user) currentUser = d.user;
    return d;
  }

  async function resendVerify(email) {
    return call("/resend-verify", { email });
  }

  const api = {
    message,
    me,
    register,
    login,
    logout,
    requestReset,
    resetPassword,
    verifyEmail,
    resendVerify,
    current: () => currentUser,
    lastStatus: () => lastStatus,
    expire: () => { currentUser = null; },
  };
  root.AUTH = api; // 浏览器挂 window、Bun 测试挂 globalThis
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);