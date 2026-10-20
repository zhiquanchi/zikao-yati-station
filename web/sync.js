// 作答进度云同步（经典脚本 · 零依赖）：同源相对路径 api/store——线上由门户落 SQLite，
// 本机经 server.js 代理到 STORE_API（默认线上站），因此本机与线上读写同一份云端进度。
// 合并口径与门户 portal/store.js 逐字一致（单仓两处实现，由 test/merge_xcheck.test.js 交叉校验锁定）：
//   store 逐题比 rec.ts 新者胜；ts ≤ clearedAt（两端取大）的记录一律作废；
//   本地删除 = 墓碑记录 {u:null,s:null,ts}（与合法「看过未作答」同形，判分/渲染均视为未答）；
//   shuf 按 ts 新者胜，关闭组卷用 {cleared:true,ts} 墓碑压制对端旧卷。
// 策略：页面加载先拉取合并再渲染（超时 2.5s 降级纯本机）；此后 save() 触发防抖 1.5s 上推，
//   服务端返回合并结果写回存储与内存（只按 ts 覆盖、绝不删除未同步的在编草稿，打字竞态安全）。
(function (root) {
  "use strict";
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  // ——— 纯函数：blob = {store, shuf, clearedAt}，两端共用 ———
  function mergeBlobs(a, b, now) {
    now = now || Date.now();
    const clearedAt = Math.max(num(a && a.clearedAt), num(b && b.clearedAt));
    const store = {};
    const sa = (a && a.store) || {}, sb = (b && b.store) || {};
    for (const id of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const ra = sa[id], rb = sb[id];
      const rec = !ra ? rb : !rb ? ra : num(rb.ts) > num(ra.ts) ? rb : ra;
      if (num(rec.ts) <= clearedAt) continue;
      store[id] = rec;
    }
    const fa = a && a.shuf, fb = b && b.shuf;
    const shuf = !fa ? fb || null : !fb ? fa : num(fb.ts) > num(fa.ts) ? fb : fa;
    return { store, shuf, clearedAt, updatedAt: now };
  }
  const isTomb = (r) => !!r && r.u == null && r.s == null && !r.v;
  // 上传载荷：当前 store 照抄；「快照有、当前无」的键——已同步过的墓碑原样重放（幂等、不抢赢对端新答），
  // 其余（本轮真删除的记录/看过标记）发新墓碑。本轮已触发「清空记录」时跳过逐键墓碑（clearedAt 全局压制更干净）。
  function payloadStore(store, snap, skipDiff, now) {
    const out = Object.assign({}, store);
    if (skipDiff) return out;
    let ts = now;
    for (const k in snap) {
      if (!(k in out)) out[k] = isTomb(snap[k]) ? snap[k] : { u: null, s: null, ts: ++ts };
    }
    return out;
  }
  function payloadShuf(shuf, snapShuf, now) {
    if (shuf) return Object.assign({}, shuf, { ts: num(shuf.ts) || now });
    if (snapShuf && Array.isArray(snapShuf.picked)) return { cleared: true, ts: now };
    if (snapShuf && snapShuf.cleared) return snapShuf; // 墓碑保持到被新卷覆盖
    return null;
  }
  // 合并结果写回内存 store 引用：只删「已同步且云端确无」的键；新 ts 才覆盖（保护在编草稿）
  function applyInto(target, merged, snapStore) {
    for (const k in snapStore) if (!(k in merged) && k in target) delete target[k];
    for (const k in merged) if (!target[k] || num(merged[k].ts) > num(target[k].ts)) target[k] = merged[k];
    return target;
  }

  const api = { mergeBlobs, payloadStore, payloadShuf, applyInto, prefetch, schedule, markCleared };
  root.SYNC = api; // 浏览器挂 window、Bun 测试挂 globalThis
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  // ——— 浏览器侧：键名由基础 KEY 派生（与 app.js 约定一致），全程静默降级 ———
  let KEY = "", SKEY = "", SNAPK = "", CLCK = "";
  let ready = false; // http(s) 且接口未被永久判死
  let timer = null, pushing = false, pending = null, dirty = false;

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  function readLocal() {
    let store = {}, shuf = null;
    try { store = JSON.parse(ls.get(KEY)) || {}; } catch (e) {}
    try { shuf = JSON.parse(ls.get(SKEY)) || null; } catch (e) {}
    return { store, shuf, clearedAt: num(+ls.get(CLCK) || 0) };
  }
  function readSnap() {
    try { const s = JSON.parse(ls.get(SNAPK)); if (s && s.store) return s; } catch (e) {}
    return { store: {}, shuf: null, at: 0 };
  }
  function writeSnap(blob) {
    ls.set(SNAPK, JSON.stringify({ store: blob.store || {}, shuf: blob.shuf || null, at: num(blob.updatedAt) }));
  }
  function writeShuf(shuf) {
    if (!shuf || shuf.cleared) ls.del(SKEY); else ls.set(SKEY, JSON.stringify(shuf));
  }
  function setStatus(cls, text) {
    const el = typeof document !== "undefined" && document.getElementById && document.getElementById("syncChip");
    if (!el) return;
    el.className = "sync-chip " + cls;
    el.textContent = text;
  }
  const hm = () => { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

  async function prefetch(key) {
    KEY = String(key || ""); SKEY = KEY + ".shuffle"; SNAPK = KEY + ".syncsnap"; CLCK = KEY + ".synccleared";
    if (typeof location === "undefined" || (location.protocol !== "http:" && location.protocol !== "https:")) return; // file:// 保持纯本机
    ready = true;
    let remote = null;
    try {
      const res = await fetch("api/store", { signal: AbortSignal.timeout(2500) });
      if (!res.ok) throw new Error(String(res.status));
      remote = (await res.json()).blob;
    } catch (e) {
      setStatus("off", "☁️ 未联网 · 暂存本机");
      return; // 后续 save 仍会尝试上推，联网即补同步
    }
    const merged = mergeBlobs(readLocal(), remote || { store: {}, shuf: null, clearedAt: 0 });
    ls.set(KEY, JSON.stringify(merged.store));
    writeShuf(merged.shuf);
    writeSnap(merged);
    setStatus("on", remote ? "☁️ 已同步 " + hm() : "☁️ 云同步已开启");
    schedule(merged.store, merged.shuf); // 把本机独有进度补传上去（服务端合并幂等）
  }

  async function push() {
    if (!ready || pushing || !pending) return;
    clearTimeout(timer); timer = null; // 触发本次 push 的定时器已生效，复位以便失败重试判定
    pushing = true;
    const had = pending;
    try {
      const snap = readSnap();
      const clearedAt = Math.max(num(snap.clearedAt), num(+ls.get(CLCK) || 0), readLocal().clearedAt);
      const body = {
        store: payloadStore(pending.store, snap.store, clearedAt >= snap.at && clearedAt > 0, Date.now()),
        shuf: payloadShuf(pending.shuf, snap.shuf, Date.now()),
        clearedAt,
      };
      const res = await fetch("api/store", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw Object.assign(new Error(String(res.status)), { permanent: res.status >= 400 && res.status < 500 });
      const merged = (await res.json()).blob;
      applyInto(pending.store, merged.store, snap.store);
      ls.set(KEY, JSON.stringify(pending.store));
      writeShuf(merged.shuf);
      writeSnap(merged);
      if (pending === had) dirty = false; // 推送期间无新改动才算干净
      setStatus("on", "☁️ 已同步 " + hm());
    } catch (e) {
      if (e.permanent) { ready = false; setStatus("off", "☁️ 云同步不可用"); } // 如旧门户无此接口：本次会话不再重试
      else { dirty = true; setStatus("off", "☁️ 未联网 · 暂存本机"); }
    } finally {
      pushing = false;
      if (ready && dirty && timer == null) timer = setTimeout(push, 30000); // 失败静默重试，联网后自动补推
    }
  }

  function schedule(store, shuf) {
    if (!ready) return;
    pending = { store, shuf };
    dirty = true;
    clearTimeout(timer); timer = null;
    timer = setTimeout(push, 1500);
  }

  function markCleared() {
    if (!ready) return;
    ls.set(CLCK, String(Date.now()));
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    const flush = () => { if (ready && timer != null && pending) { clearTimeout(timer); timer = null; push(); } };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
    window.addEventListener("pagehide", flush);
  }
})(typeof window !== "undefined" ? window : globalThis);
