// 作答进度云同步（经典脚本 · 零依赖）：同源相对路径 api/store[/<账号 slot>]——线上由门户转发到 Go 云同步服务
// （backend/grade-svc/cmd/syncsvc，多用户按 (科目,账号 slot) 分槽），
// 本机经 server.js 代理到 STORE_API（默认线上站），因此本机与线上读写同一云端槽位。
// 合并口径与 Go 服务端跨语言两份实现，由 tests/fixtures/merge_golden.json 单一夹具逐字段锁定
//   （JS 侧 tests/merge_xcheck.test.js、Go 侧 backend/grade-svc/cmd/syncsvc/store_golden_test.go——改口径两实现同改后重跑
//   scripts/gen-merge-golden.js 刷新夹具，任何单侧漂移必红）：
//   store 逐题比 rec.ts 新者胜；ts ≤ clearedAt（两端取大）的记录一律作废；
//   本地删除 = 墓碑记录 {u:null,s:null,ts}（与合法「看过未作答」同形，判分/渲染均视为未答）；
//   shuf 按 ts 新者胜，关闭组卷用 {cleared:true,ts} 墓碑压制对端旧卷；
//   hist（历史归档，v2 上云）逐题并集去重（同 ts 先到先得）→ 受 clearedAt 压制 → 升序留最近 10；
//   expl（AI 解析缓存，v2 上云）逐题 ts LWW，不受 clearedAt 压制（「清空记录」不洗解析缓存）；
//   两端皆无 hist/expl 时输出不含该键——旧版 blob 形状逐字节不变（兼容基线）。
// 策略：页面加载先拉取合并再渲染（超时 2.5s 降级纯本机）；此后 save() 触发防抖 1.5s 上推，
//   服务端返回合并结果写回存储与内存（只按 ts 覆盖、绝不删除未同步的在编草稿，打字竞态安全）。
//   「清空记录」的 clearedAt 压制仅在本人槽位内生效（本地键由身份分区，见 frontend/identity.js）。
(function (root) {
  "use strict";
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  // ——— 纯函数：blob = {store, shuf, clearedAt, hist?, expl?}，两端共用 ———
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v); // 与 Go 端 isObjectRaw 对齐：数组不算对象
  function mergeHist(ha, hb, clearedAt) {
    const out = {};
    for (const id of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
      const seen = new Set();
      const list = [];
      for (const src of [ha, hb]) {
        const arr = src[id];
        if (!Array.isArray(arr)) continue;
        for (const e of arr) {
          const t = num(e && e.ts);
          if (t <= clearedAt || seen.has(t)) continue; // 同 ts 先到先得（a 端优先）
          seen.add(t);
          list.push(e);
        }
      }
      if (!list.length) continue; // 全被压制/无有效条目：不出键（与 Go 端一致）
      list.sort((x, y) => num(x.ts) - num(y.ts));
      out[id] = list.slice(-10);
    }
    return out;
  }
  function mergeExpl(ea, eb) {
    const out = Object.assign({}, ea);
    for (const id in eb) {
      if (!(id in out) || num(eb[id] && eb[id].ts) > num(out[id] && out[id].ts)) out[id] = eb[id];
    }
    return out;
  }
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
    const out = { store, shuf, clearedAt };
    const ha = isObj(a && a.hist) ? a.hist : null, hb = isObj(b && b.hist) ? b.hist : null;
    const ea = isObj(a && a.expl) ? a.expl : null, eb = isObj(b && b.expl) ? b.expl : null;
    if (ha || hb) out.hist = mergeHist(ha || {}, hb || {}, clearedAt);
    if (ea || eb) out.expl = mergeExpl(ea || {}, eb || {});
    out.updatedAt = now;
    return out;
  }
  // payloadExtras：上云前的 hist/expl 载荷段（与 payloadStore/payloadShuf 同为夹具锁定口径）——
  // hist 剔除缺 ts 的畸形条目；expl 补 ts（改造前写入的旧缓存无 ts，按 LWW 语义以现存时刻盖章）。
  // 防单条畸形导致整包被服务端 400 拒收。空段返回 {}，由调用侧决定不出键。
  function payloadExtras(hist, expl, now) {
    const H = {}, E = {};
    for (const id in hist && typeof hist === "object" ? hist : {}) {
      const arr = Array.isArray(hist[id]) ? hist[id].filter((e) => isObj(e) && num(e.ts) > 0) : [];
      if (arr.length) H[id] = arr;
    }
    for (const id in expl && typeof expl === "object" ? expl : {}) {
      const v = expl[id];
      if (v && Array.isArray(v.items)) E[id] = num(v.ts) > 0 ? v : Object.assign({}, v, { ts: now });
    }
    return { hist: H, expl: E };
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

  const api = { mergeBlobs, payloadStore, payloadShuf, payloadExtras, applyInto, prefetch, schedule, markCleared, flushNow, disable, onAuthLost: null };
  root.SYNC = api; // 浏览器挂 window、Bun 测试挂 globalThis
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  // ——— 浏览器侧：键名由基础 KEY 派生（与 app.js 约定一致，KEY 已含同步码分区后缀），全程静默降级 ———
  let KEY = "", SKEY = "", SNAPK = "", CLCK = "", HKEY = "", EKEY = "";
  let USER = ""; // 同步码（空串＝旧版兼容全局槽），拼进 api/store URL
  let ready = false; // http(s) 且接口未被永久判死
  let timer = null, pushing = false, pending = null, dirty = false;

  const apiUrl = () => "api/store" + (USER ? "/" + USER : "");

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  function readLocal() {
    let store = {}, shuf = null, hist = {}, expl = {};
    try { store = JSON.parse(ls.get(KEY)) || {}; } catch (e) {}
    try { shuf = JSON.parse(ls.get(SKEY)) || null; } catch (e) {}
    try { hist = JSON.parse(ls.get(HKEY)) || {}; } catch (e) {} // v2：历史归档上云
    try { expl = JSON.parse(ls.get(EKEY)) || {}; } catch (e) {} // v2：AI 解析缓存上云
    return { store, shuf, clearedAt: num(+ls.get(CLCK) || 0), hist, expl };
  }
  // 合并结果里的 hist/expl 写回本机派生键（段缺失＝对端无此数据，不动本机）
  function writebackExtras(merged) {
    if (isObj(merged.hist)) ls.set(HKEY, JSON.stringify(merged.hist));
    if (isObj(merged.expl)) ls.set(EKEY, JSON.stringify(merged.expl));
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
    el.classList.remove("on", "off"); // 只换状态类：不得整体赋值 className 抹掉外部挂的 id-clickable 等类
    el.classList.add(cls);
    el.textContent = text;
  }
  const hm = () => { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

  async function prefetch(key, user) {
    KEY = String(key || ""); SKEY = KEY + ".shuffle"; SNAPK = KEY + ".syncsnap"; CLCK = KEY + ".synccleared";
    HKEY = KEY + ".hist"; EKEY = KEY + ".expl"; // 与 app.js/identity.js 的派生键约定一致
    USER = String(user || "");
    if (typeof location === "undefined" || (location.protocol !== "http:" && location.protocol !== "https:")) return; // file:// 保持纯本机
    ready = true;
    let remote = null;
    try {
      const res = await fetch(apiUrl(), { signal: AbortSignal.timeout(2500) });
      if (res.status === 401) {
        ready = false;
        setStatus("off", "🔒 登录已过期");
        if (typeof api.onAuthLost === "function") api.onAuthLost();
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      remote = (await res.json()).blob;
    } catch (e) {
      setStatus("off", "☁️ 未联网 · 暂存本机");
      return; // 后续 save 仍会尝试上推，联网即补同步
    }
    const merged = mergeBlobs(readLocal(), remote || { store: {}, shuf: null, clearedAt: 0 });
    ls.set(KEY, JSON.stringify(merged.store));
    writeShuf(merged.shuf);
    writebackExtras(merged); // 对端的历史归档/解析缓存并入本机（app.js 在 prefetch 之后才读这两键）
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
      const local = readLocal();
      const clearedAt = Math.max(num(snap.clearedAt), num(+ls.get(CLCK) || 0), local.clearedAt);
      const body = {
        store: payloadStore(pending.store, snap.store, clearedAt >= snap.at && clearedAt > 0, Date.now()),
        shuf: payloadShuf(pending.shuf, snap.shuf, Date.now()),
        clearedAt,
      };
      // v2：历史归档与解析缓存全量随包上云（追加型数据无墓碑语义，服务端并集/ LWW 收敛）
      const extras = payloadExtras(local.hist, local.expl, Date.now());
      if (Object.keys(extras.hist).length) body.hist = extras.hist;
      if (Object.keys(extras.expl).length) body.expl = extras.expl;
      const res = await fetch(apiUrl(), {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        if (res.status === 401) throw Object.assign(new Error("401"), { unauthorized: true });
        throw Object.assign(new Error(String(res.status)), { permanent: res.status >= 400 && res.status < 500 });
      }
      const merged = (await res.json()).blob;
      applyInto(pending.store, merged.store, snap.store);
      ls.set(KEY, JSON.stringify(pending.store));
      writeShuf(merged.shuf);
      writebackExtras(merged);
      writeSnap(merged);
      if (pending === had) dirty = false; // 推送期间无新改动才算干净
      setStatus("on", "☁️ 已同步 " + hm());
    } catch (e) {
      if (e && e.unauthorized) {
        ready = false;
        setStatus("off", "🔒 登录已过期");
        if (typeof api.onAuthLost === "function") api.onAuthLost();
      } else if (e.permanent) { ready = false; setStatus("off", "☁️ 云同步不可用"); } // 如旧门户无此接口：本次会话不再重试
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

  // 身份切换/迁移前收尾：立即推完防抖队列中的待传改动再换分区重载，避免最后一笔编辑滞留云端之外
  function flushNow() {
    if (!ready) return Promise.resolve();
    if (timer != null) { clearTimeout(timer); timer = null; }
    return pending ? push() : Promise.resolve();
  }

  // 登出/会话失效：停掉防抖与重试，避免拿旧身份继续写云。
  function disable() {
    ready = false;
    pending = null;
    dirty = false;
    USER = "";
    KEY = SKEY = SNAPK = CLCK = HKEY = EKEY = "";
    if (timer != null) { clearTimeout(timer); timer = null; }
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    const flush = () => { if (ready && timer != null && pending) { clearTimeout(timer); timer = null; push(); } };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
    window.addEventListener("pagehide", flush);
  }
})(typeof window !== "undefined" ? window : globalThis);
