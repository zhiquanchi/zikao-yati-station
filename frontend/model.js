// 浏览器本地状态（只存草稿与 UI 偏好）：不放判分、合并、身份或云端快照。
// 另含一次性旧数据迁移：把 v1 的 quizsync.* 分区整包交给服务端转换，成功后删掉旧键。
(function (root) {
  "use strict";

  const API = root.API;
  const DRAFT_PREFIX = "exam.drafts.";
  const PREF_KEY = "exam.prefs";
  const OLD_ID_KEYS = ["quizsync.account", "quizsync.accountEmail", "quizsync.code", "quizsync.waslegacy"];
  const OLD_SUFFIXES = ["", ".shuffle", ".hist", ".expl", ".synccleared", ".seen"];

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
    keys() { try { return Object.keys(localStorage); } catch (e) { return []; } },
  };

  function parse(v) { try { return JSON.parse(v); } catch (e) { return null; } }

  // ——— 草稿（未提交的作答，仅本机） ———
  function draftKey(prefix) { return DRAFT_PREFIX + prefix; }
  function readDrafts(prefix) { return parse(ls.get(draftKey(prefix))) || {}; }
  function writeDrafts(prefix, drafts) { ls.set(draftKey(prefix), JSON.stringify(drafts)); }
  function getDraft(prefix, qid) { return readDrafts(prefix)[qid] || null; }
  function setDraft(prefix, qid, u) {
    const d = readDrafts(prefix);
    const has = u != null && (typeof u === "string" ? u.trim() : Array.isArray(u) ? u.some((x) => (x || "").trim()) : !!(u.whole || "").trim());
    if (has) d[qid] = u; else delete d[qid];
    writeDrafts(prefix, d);
  }
  function clearDrafts(prefix) { ls.del(draftKey(prefix)); }

  // ——— UI 偏好（筛选/背答案） ———
  function prefs() { return parse(ls.get(PREF_KEY)) || {}; }
  function savePrefs(p) { ls.set(PREF_KEY, JSON.stringify(p || {})); }

  // ——— 旧数据迁移（一次性） ———
  function legacySuffix() {
    const account = ls.get("quizsync.account") || "";
    if (account) return "." + account;
    const code = ls.get("quizsync.code") || "";
    return code ? "." + code : "";
  }

  function legacyBlobFor(storageKey, suffix) {
    const base = ls.get(storageKey + suffix);
    if (!base) return null;
    const store = parse(base);
    if (!store || typeof store !== "object") return null;
    const shuf = parse(ls.get(storageKey + suffix + ".shuffle"));
    const hist = parse(ls.get(storageKey + suffix + ".hist"));
    const expl = parse(ls.get(storageKey + suffix + ".expl"));
    const clearedAt = Number(ls.get(storageKey + suffix + ".synccleared") || 0) || 0;
    if (!Object.keys(store).length && !shuf && !hist && !expl) return null;
    const blob = { store, shuf: shuf || null, clearedAt };
    if (hist && Object.keys(hist).length) blob.hist = hist;
    if (expl && Object.keys(expl).length) blob.expl = expl;
    return blob;
  }

  async function migrateLegacy() {
    const suffix = legacySuffix();
    const list = (await API.subjects()).subjects || [];
    let imported = 0;
    const touched = [];
    for (const s of list) {
      const key = s.legacyStorageKey;
      if (!key) continue;
      const blob = legacyBlobFor(key, suffix);
      if (!blob) continue;
      try {
        const r = await API.migrate(s.prefix, blob);
        imported += (r && r.records) || 0;
        touched.push(key + suffix);
      } catch (e) {
        return { imported, failed: e.code || "network" };
      }
    }
    // 导入成功后才清理旧键：连同其它身份分区的残留一并删除
    const keys = ls.keys();
    for (const k of keys) {
      if (k.startsWith("quizsync.")) { ls.del(k); continue; }
      if (list.some((s) => s.legacyStorageKey && k.startsWith(s.legacyStorageKey))) ls.del(k);
    }
    for (const k of touched) ls.del(k);
    return { imported };
  }

  function hasLegacy() {
    if (OLD_ID_KEYS.some((k) => ls.get(k))) return true;
    const keys = ls.keys();
    return keys.some((k) => k.startsWith("quizsync."));
  }

  root.MODEL = {
    draftKey, readDrafts, getDraft, setDraft, clearDrafts,
    prefs, savePrefs, migrateLegacy, hasLegacy, OLD_SUFFIXES,
  };
})(typeof window !== "undefined" ? window : globalThis);