// frontend/auth.js 纯前端回归：请求形状、current 状态、401/网络失败的降级、错误码中文映射。
// 不触碰真实网络：globalThis.fetch 用 stub 替换。
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import "../frontend/auth.js";

const A = globalThis.AUTH;
let savedFetch;

beforeEach(() => { savedFetch = globalThis.fetch; A.expire(); });
afterEach(() => { globalThis.fetch = savedFetch; });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("AUTH", () => {
  it("login 发 POST JSON 并记录 current", async () => {
    let seen = null;
    globalThis.fetch = async (url, opts) => {
      seen = { url: String(url), opts };
      return json({ user: { email: "a@example.com", slot: "abcd234567" } });
    };
    const d = await A.login("a@example.com", "password123");
    expect(seen.url).toBe("api/auth/login");
    expect(seen.opts.method).toBe("POST");
    expect(JSON.parse(seen.opts.body)).toEqual({ email: "a@example.com", password: "password123" });
    expect(d.user.email).toBe("a@example.com");
    expect(A.current().slot).toBe("abcd234567");
  });

  it("401 → 中文错误且 current 保持空", async () => {
    globalThis.fetch = async () => json({ error: "bad_credentials" }, 401);
    await expect(A.login("a@example.com", "wrongpass")).rejects.toThrow("邮箱或密码不正确");
    expect(A.current()).toBeNull();
  });

  it("me：401 与网络失败都返回 null（不阻塞页面），并记录状态供离线判断", async () => {
    globalThis.fetch = async () => json({ error: "unauthorized" }, 401);
    expect(await A.me()).toBeNull();
    expect(A.lastStatus()).toBe(401);
    globalThis.fetch = async () => { throw new Error("net down"); };
    expect(await A.me()).toBeNull();
    expect(A.lastStatus()).toBe(0);
  });

  it("logout 后 current 清空", async () => {
    globalThis.fetch = async (url) =>
      String(url).endsWith("/login")
        ? json({ user: { email: "a@example.com", slot: "abcd234567" } })
        : new Response(null, { status: 204 });
    await A.login("a@example.com", "password123");
    expect(A.current()).not.toBeNull();
    await A.logout();
    expect(A.current()).toBeNull();
  });

  it("找回密码/验证/重发：请求形状与 current 更新", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      return json(String(url).endsWith("/verify-email")
        ? { user: { email: "a@example.com", slot: "abcd234567", email_verified: true } }
        : { ok: true });
    };
    await A.requestReset("a@example.com");
    expect(calls[0]).toEqual({ url: "api/auth/request-reset", method: "POST", body: { email: "a@example.com" } });
    await A.resendVerify("a@example.com");
    expect(calls[1]).toEqual({ url: "api/auth/resend-verify", method: "POST", body: { email: "a@example.com" } });
    await A.verifyEmail("tok-123");
    expect(calls[2]).toEqual({ url: "api/auth/verify-email", method: "POST", body: { token: "tok-123" } });
    expect(A.current().email_verified).toBe(true);
    await A.resetPassword("tok-456", "password123");
    expect(calls[3]).toEqual({ url: "api/auth/reset-password", method: "POST", body: { token: "tok-456", password: "password123" } });
    expect(A.current()).toBeNull();
  });

  it("错误码映射：未知错误有兜底文案", () => {
    expect(A.message("email_taken")).toBe("该邮箱已注册，请直接登录");
    expect(A.message("registration_closed")).toBe("本站暂未开放注册");
    expect(A.message("mail_unavailable")).toBe("邮件服务未配置，请联系站长");
    expect(A.message("invalid_token")).toBe("链接无效或已过期，请重新获取");
    expect(A.message("email_not_verified")).toContain("请先验证邮箱");
    expect(A.message("something_else")).toBe("操作失败，请稍后重试");
  });
});