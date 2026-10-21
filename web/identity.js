// 多用户身份（同步码）管理（经典脚本 · 零依赖 · 无 DOM，bun 可直测）：
// 全局键 quizsync.code 存「本浏览器的同步码」——同一个人一码走全部科目（各科同源于路径前缀站点）。
// 云端槽位 =（科目, 码），本机存储分区 = storageKey + ".<码>"；无码＝旧版兼容全局槽（裸键），
// 站长既有进度零打断续用。新访客（无码且无旧版本地数据）静默签发随机码：
//   各人进度天然私有、互不可猜；别的设备输入同一码即续用（复用 LWW 合并）；同设备输不同码即切换用户。
// 码格式与服务端 grade-svc/cmd/syncsvc 的 userRe 必须一致（小写、去混淆字母表）。
(function (root) {
  "use strict";
  const CODE_KEY = "quizsync.code";
  const WAS_LEGACY_KEY = "quizsync.waslegacy"; // 迁移过来的身份可退回旧版槽（新访客不显示此路）
  const CODE_RE = /^[a-z2-9]{4,10}$/;
  const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789"; // 去 i/o/l/0/1，手抄不易错
  const SUFFIXES = ["", ".shuffle", ".syncsnap", ".synccleared", ".hist", ".expl", ".seen"]; // 一个分区的全部键（hist/expl 随 v2 同步推拉；.seen 组卷出现标记仅本机——均按用户分区）

  const ls = {
    get(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } },
    set(k, v) { try { root.localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { root.localStorage.removeItem(k); } catch (e) {} },
  };

  const valid = (c) => CODE_RE.test(String(c || ""));
  const user = () => { const c = ls.get(CODE_KEY); return c && CODE_RE.test(c) ? c : ""; };

  function mint() {
    const buf = new Uint8Array(6);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(buf);
    else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    let out = "";
    for (let i = 0; i < buf.length; i++) out += ALPHA[buf[i] % ALPHA.length];
    return out;
  }

  // 存储键基座：码即分区。旧版设备（无码）键形不变，兼容基线不动。
  const keyFor = (rawKey) => { const u = user(); return u ? rawKey + "." + u : rawKey; };

  // ensure：http(s) 下「无码且无旧版本地数据」才静默签发新码——旧版槽设备（如站长）绝不分码、零打断。
  function ensure(rawKey, isHttp) {
    if (!isHttp || user()) return user();
    if (ls.get(rawKey) != null) return ""; // 本机有旧版数据：留待用户主动迁移
    const c = mint();
    ls.set(CODE_KEY, c);
    return c;
  }

  function setCode(code) { if (valid(code)) { ls.set(CODE_KEY, String(code)); return true; } return false; }
  function clearCode() { ls.del(CODE_KEY); ls.del(WAS_LEGACY_KEY); }
  const wasLegacy = () => ls.get(WAS_LEGACY_KEY) != null;

  // migrateTo：当前分区 7 键「搬」到目标码分区并切换身份（搬而非抄：
  // 回到旧版槽时快照为空，diff 不会向云端误发对方记录的墓碑）。
  function migrateTo(rawKey, code) {
    if (!valid(code)) return false;
    const from = keyFor(rawKey), to = rawKey + "." + code;
    for (const suf of SUFFIXES) {
      const v = ls.get(from + suf);
      ls.del(from + suf);
      if (v != null) ls.set(to + suf, v);
    }
    ls.set(CODE_KEY, code);
    ls.set(WAS_LEGACY_KEY, "1"); // 标记迁移来路：弹层提供「退回旧版槽」
    return true;
  }

  const api = { CODE_KEY, CODE_RE, valid, user, mint, keyFor, ensure, setCode, clearCode, wasLegacy, migrateTo, SUFFIXES };
  root.IDENTITY = api; // 浏览器挂 window、Bun 测试挂 globalThis
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
