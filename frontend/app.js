// 自考押题练习页（共享前端引擎，多科目复用）：渲染 + 交互 + 判分结果展示。
// 科目身份全部来自 QUIZ_DATA.meta（由 scripts/build.js 从 subjects/<科目>/subject.json 注入）。
(async function () {
  "use strict";
  const D = window.QUIZ_DATA, G = window.GRADER;
  const ID = window.IDENTITY;
  const AUTH = window.AUTH;
  const isHttp = typeof location !== "undefined" && (location.protocol === "http:" || location.protocol === "https:");
  // 先探测登录态（3s 超时，失败按未登录）：登录后账号 slot 优先，未登录退回匿名码（仅本机）。
  let me = null;
  if (isHttp && AUTH) me = await AUTH.me();
  if (me && !ID.setAccount(me)) me = null;
  // 只有服务端明确 401（会话失效）才清账号；网络失败保留本机账号分区，离线可继续读写，登录后自动补同步。
  if (!me && AUTH && AUTH.lastStatus && AUTH.lastStatus() === 401) ID.clearAccount();
  ID.ensure(D.meta.storageKey, isHttp);
  const KEY = ID.keyFor(D.meta.storageKey); // 存储键＝科目裸键+账号 slot/匿名码；未登录不上云
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const TYPE_CN = { single: "单选", blank: "填空", essay: "简答" };
  const RECITE = window.RECITE; // 重点优先背的纯排序模块（frontend/recite.js；科目 flags.recite 开启时才启用）

  // 云同步首拉合并：仅登录后发起；await 之后才装载 store/shuf（file:// 或超时自动降级纯本机）
  if (window.SYNC) {
    if (me) await window.SYNC.prefetch(KEY, ID.user());
    else window.SYNC.disable();
  }

  let store = load();
  let filters = { chapter: "all", type: "all", status: "all", search: "" };
  let shuffle = false, showRef = false;
  // 重点优先背弹层状态：all＝按薄弱程度排好的全队列，list＝当前分组/题型筛选后的可见队列；
  // mode＝back（背题卡）| practice（当前页内作答），result＝提交后的成绩展示（不跳转主列表）
  // folded＝收起统计/筛选只留题卡（手机默认收起，把高度让给题目；foldTouched＝用户手动切换后本次会话记住）
  const recite = { all: [], list: [], idx: 0, group: "all", type: "all", mode: "back", result: null, oldScore: null, folded: false, foldTouched: false };
  const QBYID = Object.fromEntries(D.questions.map((q) => [q.id, q]));

  // 判分口径升级迁移：已判分的填空记录用当前引擎重算（含 unordered 跨空匹配），
  // 分数有变则更新 s 并 bump ts（云同步按 ts LWW，令纠正结果收敛），一次性上推
  (function migrateBlankScores() {
    let dirty = false;
    for (const q of D.questions) {
      if (q.type !== "blank") continue;
      const r = store[q.id];
      if (!r || r.s == null || !Array.isArray(r.u)) continue;
      const s = G.gradeBlanks(r.u, q).score;
      if (s !== r.s) { r.s = s; r.ts = Date.now(); dirty = true; }
    }
    if (dirty) save();
  })();

  // ——— 随机组卷：加权抽约 TARGET 分，生成后固定，换一批才重排 ———
  const SKEY = KEY + ".shuffle";
  const SCORE = Object.assign({ single: 1, blank: 2, essay: 5 }, D.meta.paper.scores); // 每题分值（贴近真实卷面结构，subject.json 可覆盖）
  const TYPE_RANK = { single: 0, blank: 1, essay: 2 }; // 卷面题序：单选→填空→简答（同题型内保持抽题随机序）
  const TARGET = D.meta.paper.target || 100;           // 目标总分（约）
  let shuf = loadShuf();
  function loadShuf() { try { return JSON.parse(localStorage.getItem(SKEY)) || null; } catch (e) { return null; } }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function typeWeight(t) { return t === "essay" ? 3 : t === "blank" ? 2 : 1; } // 简答>填空>单选
  // ——— 出现标记：题卡在刷题/组卷模式下进过眼（滚入视口、进过卷面、有过任何作答记录）即算「出现过」。
  // 本机派生键 `.seen`（只存本机、不入云同步——只影响抽题倾向，不影响数据正确性）。背答案模式滚过不算。———
  const VKEY = KEY + ".seen";
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(VKEY)) || {}; } catch (e) {}
  function markSeen(id) {
    if (seen[id]) return; // 每题只记首次
    seen[id] = Date.now();
    try { localStorage.setItem(VKEY, JSON.stringify(seen)); } catch (e) {}
  }
  const hasSeen = (id) => !!seen[id] || store[id] != null; // store 有记录＝必然见过（老用户零迁移）
  function statusWeight(q) {
    if (!hasSeen(q.id)) return 8;   // 从未在刷题/组卷中出现过：最高权重
    const r = store[q.id];
    if (r && r.v) return 4;         // 点开过解析＝开卷混过（判分不洗白）：并入第二档
    const s = r ? r.s : null;
    if (s == null) return 4;        // 出现过但未作答：更易出现
    if (s < 60) return 4;           // 做错：更易出现
    if (s >= 80) return 0.3;        // 出现过且已通过、未看过解析：降低推荐频率
    return 1;                       // 60~79：正常
  }
  // 未判分的题点开解析：记录查看（v 字段），组卷时计入第二档；同时补记出现过（防观察器时序漏标）
  function markViewed(q) {
    markSeen(q.id);
    const r = store[q.id];
    if (r && (r.s != null || r.v)) return; // 已判分按分数定档；已标记过不重复写
    store[q.id] = { u: r ? r.u : null, s: null, ts: r && r.ts || Date.now(), v: Date.now() };
    save();
  }
  function newShuffle() {
    // 组卷范围跟随当前筛选：只在筛选命中的题目里抽（状态「待提高/已掌握/未作答」即组专项卷）。
    // 池为空返回 false，不产生卷面——调用方负责回退勾选 / 保留原卷
    const pool = D.questions.filter((q) => passFilters(q, true));
    if (!pool.length) { toast("当前筛选条件下没有符合的题目，已取消组卷"); return false; }
    const seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    const rnd = mulberry32(seed);
    // 加权无放回抽样（指数竞赛法）：权重越大 key 越小、排得越前
    const order = pool
      .map((q) => ({ id: q.id, k: -Math.log(Math.max(rnd(), 1e-9)) / (typeWeight(q.type) * statusWeight(q)) }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.id);
    // 从加权序列头部取题，累计分值约到 100 分为止
    let total = 0;
    const picked = [];
    for (const id of order) {
      picked.push(id);
      total += SCORE[QBYID[id].type];
      if (total >= TARGET) break;
    }
    shuf = { seed, order, picked, total };
    localStorage.setItem(SKEY, JSON.stringify(shuf));
    picked.forEach(markSeen); // 进过卷面＝出现过（下次组卷不再是「从未出现」档）
    // 组卷即全新：卷内题目旧作答记录一律清掉，再次刷题从全空白开始；判过分的先归档进本机历史（`.hist`）；
    // 保留「看过解析」v 标记供下次组卷加权。记录删除经 sync 墓碑同步云端（只增删键、不改记录形状）
    let reset = 0;
    for (const id of picked) {
      const r = store[id];
      if (!r || (r.u == null && r.s == null && !r.g)) continue; // 本就未作答，无需清
      archiveHist(id, r);
      if (r.v) store[id] = { u: null, s: null, ts: Date.now(), v: r.v };
      else delete store[id];
      reset++;
    }
    if (reset) { save(); toast(`🧹 已重置 ${reset} 题为未作答状态，全新开始`); }
    else if (window.SYNC) SYNC.schedule(store, shuf);
    return true;
  }
  function clearShuffle() {
    shuf = null;
    localStorage.removeItem(SKEY);
    if (window.SYNC) SYNC.schedule(store, shuf); // 关闭组卷以「清空墓碑」同步到云端
  }
  function updatePaperInfo() {
    const el = $("#paperInfo");
    if (!el) return;
    if (!paperActive()) { el.style.display = "none"; return; }
    const cnt = { single: 0, blank: 0, essay: 0 };
    shuf.picked.forEach((id) => cnt[QBYID[id].type]++);
    const inFilter = filters.chapter !== "all" || filters.type !== "all" || filters.status !== "all" || filters.search;
    el.style.display = "block";
    el.innerHTML = `📋 随机组卷 <b>${shuf.picked.length}</b> 题 · 总分 <b>${shuf.total}</b> 分` +
      (inFilter ? `（组卷范围：当前筛选）` : "") +
      `（单选 ${cnt.single}×${SCORE.single} ＋ 填空 ${cnt.blank}×${SCORE.blank} ＋ 简答 ${cnt.essay}×${SCORE.essay}）` +
      `<span class="pi-tip">从没在刷题/组卷出现过的最易入选，看过解析/未做/答错的次之，出现过的已掌握题低频；点「🎲 换一批」按最新掌握情况重新组卷；筛选圈定抽题范围，组卷后状态筛选不再影响卷面（组卷即全新已清空卷内得分）</span>`;
  }

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save() {
    localStorage.setItem(KEY, JSON.stringify(store));
    if (window.SYNC) SYNC.schedule(store, shuf); // 云同步防抖上推（sync.js 内部静默降级）
  }
  // ——— 草稿与批量提交 ———
  function hasContent(u) {
    if (u == null) return false;
    if (typeof u === "string") return !!u;
    if (Array.isArray(u)) return u.some((v) => (v || "").trim());
    if (u.mode === "whole") return !!(u.whole || "").trim();
    return (u.points || []).some((p) => (p || "").trim());
  }
  function draftList() {
    return D.questions.filter((q) => store[q.id] && store[q.id].s == null && hasContent(store[q.id].u));
  }
  function updateBulkBar() {
    const bar = $("#bulkBar");
    if (!bar) return;
    const n = draftList().length;
    bar.style.display = n ? "flex" : "none";
    $("#bulkCount").textContent = `已作答未提交 ${n} 题`;
  }
  function saveDraft(q, card) {
    const u = collect(q, card);
    const prev = store[q.id];
    if (!hasContent(u)) {
      if (prev && prev.s == null) {
        if (prev.v) { store[q.id] = { u: null, s: null, ts: prev.ts, v: prev.v }; } // 清空答案：保留「看过解析」标记
        else { delete store[q.id]; }
        save();
      }
      updateBulkBar();
      return;
    }
    if (prev && prev.s != null) { updateBulkBar(); return; } // 已判分：保留首次结果，编辑不落盘（重新评分也不改写记录）
    store[q.id] = { u, s: null, ts: Date.now(), v: prev && prev.v };
    save();
    updateBulkBar();
  }
  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("show"), 3600);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ——— 历史作答留档：判过分的记录在「组卷清理 / 重做此题」前归档进本机派生键 `.hist`
  // （每题最近 10 次；只存本机、不入云同步；**界面上不显示**——组卷/刷题时不出现历史做题数据，仅留档备查）———
  const HKEY = KEY + ".hist";
  let hist = {};
  try { hist = JSON.parse(localStorage.getItem(HKEY)) || {}; } catch (e) {}
  function persistHist() {
    try { localStorage.setItem(HKEY, JSON.stringify(hist)); }
    catch (e) { // 配额满：各题只留最近 3 次后重试一次
      for (const id in hist) hist[id] = hist[id].slice(-3);
      try { localStorage.setItem(HKEY, JSON.stringify(hist)); } catch (e2) {}
    }
  }
  function archiveHist(id, rec) {
    if (!rec || rec.s == null) return; // 只归档判过分的作答
    const list = hist[id] || (hist[id] = []);
    list.push({ u: rec.u, s: rec.s, ts: rec.ts });
    if (list.length > 10) list.splice(0, list.length - 10);
    persistHist();
  }

  // ——— 统计与章节 ———
  function ensureTrack() {
    let track = $(".progress-track");
    if (!track) {
      track = document.createElement("div");
      track.className = "progress-track";
      track.innerHTML = '<div class="progress-bar"></div>';
      $(".topbar .wrap").appendChild(track);
    }
    return track;
  }
  function renderStats() {
    const qs = D.questions, total = qs.length;
    const done = qs.filter((q) => store[q.id] && store[q.id].s != null).length;
    const scores = qs.map((q) => store[q.id] && store[q.id].s).filter((v) => v != null);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const good = scores.filter((s) => s >= 60).length;
    $("#stats").innerHTML =
      `<span class="stat">已练 <b>${done}</b>/${total}</span>` +
      `<span class="stat">平均分 <b>${avg}</b></span>` +
      `<span class="stat">60分以上 <b>${good}</b></span>` +
      `<span class="stat">未练 <b>${total - done}</b></span>`;
    $(".progress-bar", ensureTrack()).style.width = (done / total * 100).toFixed(1) + "%";
    updateReciteEntry(); // 顶栏「重点优先背」角标跟着掌握情况走
    updateMemoEntry();   // 顶栏「考前重点记忆」角标同理
  }

  function renderChapters() {
    const sel = $("#chapterSel");
    const opts = [`<option value="all">全部章节（${D.questions.length} 题）</option>`];
    D.chapters.forEach((c) => {
      const qs = D.questions.filter((q) => q.chapter === c);
      const done = qs.filter((q) => store[q.id] && store[q.id].s != null).length;
      opts.push(`<option value="${esc(c)}">${esc(c)} · ${done}/${qs.length}</option>`);
    });
    sel.innerHTML = opts.join("");
    sel.value = filters.chapter;
  }

  // ——— 重点优先背 ———
  // 「没掌握」＝首次评分 <80（含未作答）；排序纯函数在 frontend/recite.js（答错→待提高→未作答，
  // 同档简答/填空先背，未作答中看过解析的优先）。全屏逐题背、答案与得分点直接展开；
  // 「开始/重做并练习」在当前背题页内联作答（不跳主列表），提交后原地出分并更新掌握与队列。
  // 科目由 flags.recite 开启（subject.json→meta）。
  function reciteEnabled() { return !!(D.meta.flags && D.meta.flags.recite) && !!RECITE; }
  function reciteAll() { return RECITE.build(D.questions, store); }
  // 窄屏默认收起统计/筛选；「显示/隐藏筛选」随时切换，题卡区自动占满剩余高度
  function reciteNarrow() {
    return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches;
  }
  function reciteUpdateFold() {
    const shell = $(".recite-shell");
    if (shell) shell.classList.toggle("folded", !!recite.folded);
    const btn = $("#reciteFold");
    if (btn) {
      btn.textContent = recite.folded ? "▸ 显示筛选" : "▾ 隐藏筛选";
      btn.setAttribute("aria-expanded", recite.folded ? "false" : "true");
    }
    const sub = $("#reciteSub");
    if (sub) {
      if (recite.folded) {
        const c = RECITE.counts(recite.all);
        sub.textContent = `未掌握 ${c.total} · ❌ ${c.wrong} · ⚠️ ${c.mid} · ⬜ ${c.todo}`; // 收起后仅留一行战况，节省高度
      } else {
        sub.textContent = `${D.meta.name} · 按答题记录找出未掌握题，薄弱优先`;
      }
    }
  }
  function updateReciteEntry() {
    const btn = $("#reciteEntry");
    if (!reciteEnabled()) { if (btn) btn.remove(); return; } // 未开启的科目不注入入口
    if (!btn) return;
    const n = reciteAll().length;
    $("#reciteCount").textContent = n;
    btn.style.display = "";
    btn.classList.toggle("zero", n === 0);
    btn.title = n ? `按答题记录找出 ${n} 道未掌握题，按薄弱程度逐题背` : "全部题目已掌握，暂无重点背题";
  }
  function reciteOpen() {
    if (!reciteEnabled()) return;
    reciteLeavePractice();
    recite.all = reciteAll();
    recite.group = "all"; recite.type = "all"; recite.idx = 0;
    if (!recite.foldTouched) recite.folded = reciteNarrow(); // 手机默认收起，让题卡占满屏幕
    reciteRenderFilters();
    reciteApply();
    const dlg = $("#reciteDialog");
    if (dlg && !dlg.open) dlg.showModal();
    const main = $("#reciteCard"); if (main) main.scrollTop = 0;
  }
  function reciteApply() {
    recite.list = RECITE.filter(recite.all, { group: recite.group, type: recite.type });
    if (recite.idx >= recite.list.length) recite.idx = Math.max(0, recite.list.length - 1);
    reciteRenderQueue();
    reciteRenderCard();
    reciteRenderNav();
  }
  function reciteRenderFilters() {
    const c = RECITE.counts(recite.all);
    const groups = [["all", "全部未掌握", c.total], ["wrong", "❌ 答错", c.wrong], ["mid", "⚠️ 待提高 60~79", c.mid], ["todo", "⬜ 未作答", c.todo]];
    $("#reciteGroupChips").innerHTML = groups.map(([g, label, n]) =>
      `<button type="button" class="chip${recite.group === g ? " active" : ""}" data-group="${g}">${label} ${n}</button>`).join("");
    const byGroup = RECITE.counts(RECITE.filter(recite.all, { group: recite.group }));
    const types = [["all", "全部题型", byGroup.total], ["single", "单选", byGroup.single], ["blank", "填空", byGroup.blank], ["essay", "简答", byGroup.essay]];
    $("#reciteTypeChips").innerHTML = types.map(([t, label, n]) =>
      `<button type="button" class="chip${recite.type === t ? " active" : ""}" data-type="${t}">${label} ${n}</button>`).join("");
    const total = D.questions.length;
    $("#reciteSummary").innerHTML = recite.all.length
      ? `<span class="rs-item">未掌握 <b>${c.total}</b> / ${total}</span>` +
        `<span class="rs-item wrong">答错 <b>${c.wrong}</b></span>` +
        `<span class="rs-item mid">待提高 <b>${c.mid}</b></span>` +
        `<span class="rs-item todo">未作答 <b>${c.todo}</b></span>` +
        `<span class="rs-tip">排序：答错（分低在前）→ 待提高（60~79）→ 未作答；同档简答/填空先背，未作答中看过解析的优先。</span>`
      : `<span class="rs-ok">🎉 全部 ${total} 题已掌握（≥80 分），暂时没有需要重点背的题。</span>`;
    reciteUpdateFold(); // 分数/队列变化后同步收起态的一行战况
  }
  function reciteRenderQueue() {
    const box = $("#reciteQueue");
    $("#reciteQueueCount").textContent = `${recite.list.length} 题`;
    if (!recite.list.length) { box.innerHTML = `<li class="recite-q-empty">当前筛选下没有题目</li>`; return; }
    box.innerHTML = recite.list.map((it, i) => {
      const q = QBYID[it.id];
      return `<li class="recite-q-item${i === recite.idx ? " active" : ""}" data-i="${i}">` +
        `<span class="rq-no">${i + 1}</span><span class="rq-stem">${esc(q.stem)}</span>` +
        `<span class="rq-tag ${it.group}">${it.score != null ? it.score + "分" : "未答"}</span></li>`;
    }).join("");
    const active = $(".recite-q-item.active", box);
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }
  // 填空题背题态：横线位置直接填上应背答案（多空按 blanks 顺序；异常数据回落 ?）
  function reciteBlankStem(q) {
    const blanks = Array.isArray(q.blanks) ? q.blanks : [];
    const parts = q.stem.split(/_{2,}/);
    let out = "";
    parts.forEach((p, i) => {
      out += esc(p);
      if (i < parts.length - 1) out += `<b class="recite-blank">${esc((blanks[i] && blanks[i][0]) || "?")}</b>`;
    });
    return out;
  }
  // ——— 当前页内练习：表单（复用 collect/grade/首次评分/重做语义，答题不跳转） ———
  function recitePracticeForm(q, draftRec) {
    let body = "";
    if (q.type === "single") {
      const picked = draftRec && typeof draftRec.u === "string" ? draftRec.u : null;
      const opts = Array.isArray(q.options) ? q.options : [];
      body = `<div class="stem">${esc(q.stem)}</div><div class="opts">` + opts.map((o) =>
        `<div class="opt${o.key === picked ? " picked" : ""}" data-key="${o.key}"><span class="key">${o.key}</span><span>${esc(o.text)}</span></div>`).join("") + `</div>`;
    } else if (q.type === "blank") {
      body = `<div class="stem">${stemHTML(q)}</div>`;
    } else {
      const pts = Array.isArray(q.points) ? q.points : [];
      body = `<div class="stem">${esc(q.stem)}</div>` +
        `<textarea class="ans" rows="1" spellcheck="false">${esc(essayTextOf(draftRec && draftRec.u))}</textarea>
        <div class="hint-line">按要点写出答案，系统对照参考答案的 ${pts.length} 个得分点，按关键词覆盖度自动打分。</div>`;
    }
    return `<article class="rcard recite-practice" data-id="${q.id}">
      <div class="rcard-head"><span class="qno">第 ${recite.idx + 1} 题 · 原题 #${q.id}</span>
        <span class="badge ${q.type}">${TYPE_CN[q.type]}</span><span class="chap">${esc(q.chapter)}</span>
        <span class="rcard-tag practice">练习中</span></div>
      ${body}
      <div class="rcard-actions"><button type="button" class="primary" id="reciteSubmit">提交评分</button>
        <button type="button" class="secondary" id="reciteCancel">取消</button>
        <span class="rcard-tip">${recite.oldScore != null
          ? "已判分题：提交后按本次成绩重新计分（覆盖原记录），取消不写盘"
          : "提交后计入掌握，≥80 分即移出重点背队列"}</span></div>
    </article>`;
  }
  function reciteMountPractice() {
    const card = $("#reciteCard .recite-practice");
    const it = recite.list[recite.idx];
    if (!card || !it) return;
    const q = QBYID[it.id], rec = store[it.id];
    if (q.type === "blank" && rec && Array.isArray(rec.u)) {
      $$(".stem input.blank", card).forEach((inp, i) => (inp.value = rec.u[i] || ""));
    }
    if (q.type === "essay") { const ta = $("textarea.ans", card); autoGrow(ta); if (ta) ta.focus(); }
    else if (q.type === "blank") { const inp = $(".stem input.blank", card); if (inp) inp.focus(); }
  }
  function reciteRenderPractice() {
    const it = recite.list[recite.idx];
    if (!it) return;
    const q = QBYID[it.id];
    // 已判分题进入「重做」：表单留空；未判分题带出已有草稿
    const draftRec = recite.oldScore != null ? null : store[it.id];
    $("#reciteCard").innerHTML = recitePracticeForm(q, draftRec);
    reciteMountPractice();
  }
  function reciteRenderCard() {
    const box = $("#reciteCard");
    if (recite.mode === "practice") {
      if (recite.result) { reciteRenderResult(QBYID[recite.result.id], recite.result); return; }
      if (recite.list.length) { reciteRenderPractice(); return; }
      reciteLeavePractice(); // 队列已空（刚掌握最后一题）：回到空态
    }
    if (!recite.list.length) {
      box.innerHTML = `<div class="recite-empty">` + (recite.all.length
        ? "当前筛选下没有题目，换个分组或题型看看。"
        : "🎉 全部题目已掌握（≥80 分），去随机组卷检验一下吧。") + `</div>`;
      return;
    }
    const it = recite.list[recite.idx], q = QBYID[it.id];
    const rec = store[it.id];
    const graded = !!(rec && rec.s != null);
    const tags = [`<span class="rcard-tag ${it.group}">${it.score != null ? RECITE.labelOf(it.group) + " · " + it.score + " 分" : "未作答"}</span>`];
    if (it.viewed) tags.push('<span class="rcard-v">👀 看过解析</span>');
    if (it.draft) tags.push('<span class="rcard-draft">📝 有草稿未提交</span>');
    let body = "";
    if (q.type === "single") {
      const opts = Array.isArray(q.options) ? q.options : [];
      body = `<div class="stem">${esc(q.stem)}</div><div class="opts recite-opts">` + opts.map((o) =>
        `<div class="opt${o.key === q.answer ? " right" : ""}"><span class="key">${o.key}</span><span>${esc(o.text)}</span>` +
        (o.key === q.answer ? '<span class="opt-ans ok">✓ 正确答案</span>' : "") + `</div>`).join("") + `</div>` +
        `<div class="rcard-ans">✅ 正确答案：<b>${esc(q.answer)}</b> · ${esc((opts.find((o) => o.key === q.answer) || {}).text || "")}</div>`;
      if (q.explain || q.ref) body += `<div class="explain show">${explainHTML(q, { noAI: true })}</div>`;
    } else if (q.type === "blank") {
      const blanks = Array.isArray(q.blanks) ? q.blanks : [];
      body = `<div class="stem">${reciteBlankStem(q)}</div>` +
        `<div class="rcard-ans">✅ 应填：${blanks.map((v) => `<b>${esc((v && v[0]) || "")}</b>`).join("、")}${q.unordered ? ' <span class="pi-tip">（并列各空，顺序可互换）</span>' : ""}</div>`;
      if (q.explain) body += `<div class="explain show">${explainHTML(q, { noAI: true, noAns: true })}</div>`; // 无手写解析时不重复参考答案（应填已展示）
    } else {
      const pts = Array.isArray(q.points) ? q.points : [];
      body = `<div class="stem">${esc(q.stem)}</div>` + (pts.length
        ? `<div class="rcard-points"><h4>🎯 得分点（${pts.length} 条，背加粗关键词）</h4><ol>` +
          pts.map((p, i) => `<li>${rich(pointTexts(q, i, p), q)}</li>`).join("") + `</ol></div>`
        : q.ref ? `<div class="rcard-ans">✅ 参考答案：${esc(q.ref)}</div>` : ""); // 通用开关：未来科目缺 points 时回落整段答案
      if (q.explain) body += `<div class="explain show">${explainHTML(q, { noAI: true, noPts: true })}</div>`;
      if (q.ref) body += `<details class="rcard-ref"><summary>📄 完整参考答案</summary><p>${esc(q.ref)}</p></details>`;
    }
    box.innerHTML = `<article class="rcard" data-id="${q.id}">
      <div class="rcard-head"><span class="qno">第 ${recite.idx + 1} 题 · 原题 #${q.id}</span>
        <span class="badge ${q.type}">${TYPE_CN[q.type]}</span><span class="chap">${esc(q.chapter)}</span>${tags.join("")}</div>
      ${body}
      <div class="rcard-actions"><button type="button" class="primary" id="recitePractice">${graded ? "✍ 重做并练习" : "✍ 开始练习"}</button>
        <span class="rcard-tip">${graded ? "已判分：在此页重新作答，提交后按本次成绩覆盖原记录（取消不写盘）" : "背熟后练一遍：≥80 分即从「重点优先背」队列移除"}</span></div>
    </article>`;
  }
  // ——— 当前页内练习：提交评分与结果（答完不跳转，原地展示得分/逐项反馈/解析） ———
  function reciteSubmitPractice() {
    const it = recite.list[recite.idx];
    if (!it) return;
    const q = QBYID[it.id];
    const card = $("#reciteCard .recite-practice");
    if (!card) return;
    const input = collect(q, card);
    if (input == null) { toast(q.type === "single" ? "请先选择一个选项" : "请先写出你的答案"); return; }
    if (q.type === "blank" && input.every((v) => !v)) { toast("请先填写答案"); return; }
    const old = store[q.id];
    const out = grade(q, input);
    if (old && old.s != null) archiveHist(q.id, old); // 已判分＝重做：旧记录归档，新成绩成为掌握依据
    store[q.id] = { u: input, s: out.s, ts: Date.now(), v: old && old.v };
    save();
    recite.result = { id: q.id, input, out, oldScore: old && old.s != null ? old.s : null, aiPending: false, aiError: "" };
    reciteRefreshQueue(q.id);
    renderStats(); renderChapters(); renderList(); // 主列表在弹层背后同步刷新（不滚动、不跳转）
    reciteRenderCard();
    const main = $("#reciteCard"); if (main) main.scrollTop = 0;
    if (q.type === "essay") reciteUpgradeEssay(q, input); // 简答异步升级 AI 判分（同主站口径）
  }
  function reciteRefreshQueue(currentId) {
    recite.all = reciteAll();
    recite.list = RECITE.filter(recite.all, { group: recite.group, type: recite.type });
    const pos = currentId != null ? recite.list.findIndex((e) => e.id === currentId) : -1;
    if (pos >= 0) recite.idx = pos;
    else recite.idx = Math.min(recite.idx, Math.max(0, recite.list.length - 1)); // 已掌握被移出队列：留在原位
    reciteRenderFilters();
    reciteRenderQueue();
    reciteRenderNav();
  }
  function reciteResultHTML(q, r) {
    const out = r.out, s = out.s, cls = scoreCls(s), mastered = s >= 80;
    const label = mastered ? (s >= 85 ? "掌握良好" : "已掌握") : s >= 60 ? "基本及格，继续巩固" : "还需加强背诵";
    const badge = out.engine === "ai"
      ? '<span class="ai-badge ai">🤖 AI 判分</span>'
      : r.aiPending
        ? '<span class="ai-pending">🤖 AI 升级判分中…</span>'
        : r.aiError
          ? `<span class="ai-badge local" title="AI 判分不可用：${esc(r.aiError)}">本机估分</span>`
          : "";
    let detail = "";
    if (q.type === "single") {
      const opts = Array.isArray(q.options) ? q.options : [];
      detail = `<div class="stem">${esc(q.stem)}</div><div class="opts">` + opts.map((o) => {
        const right = o.key === q.answer, chosen = o.key === r.input;
        const c = right ? "right" : chosen ? "wrong" : "dim";
        return `<div class="opt ${c}"><span class="key">${o.key}</span><span>${esc(o.text)}</span>` +
          (right ? '<span class="opt-ans ok">✓ 正确答案</span>' : chosen ? '<span class="opt-ans no">你的选择 ✗</span>' : "") + `</div>`;
      }).join("") + `</div>` +
        `<div class="rcard-ans">✅ 正确答案：<b>${esc(q.answer)}</b> · ${esc((opts.find((o) => o.key === q.answer) || {}).text || "")}</div>`;
      if (q.explain || q.ref) detail += `<div class="explain show">${explainHTML(q, { noAI: true })}</div>`;
    } else if (q.type === "blank") {
      const blanks = Array.isArray(q.blanks) ? q.blanks : [];
      const parts = q.stem.split(/_{2,}/);
      let stem = "";
      parts.forEach((p, i) => {
        stem += esc(p);
        if (i < parts.length - 1) {
          const ok = out.per && out.per[i] && out.per[i].ok;
          stem += `<input class="blank ${ok ? "right" : "wrong"}" value="${esc((r.input && r.input[i]) || "")}" disabled>`;
        }
      });
      detail = `<div class="stem">${stem}</div>` +
        `<div class="rcard-ans">✅ 应填：${blanks.map((v) => `<b>${esc((v && v[0]) || "")}</b>`).join("、")}</div>` +
        (out.per || []).map((p, i) =>
          `<div class="blank-report">${i + 1}. ${p.ok ? `<span class="b-ok">✓ ${esc(p.input)}</span>` : `<span class="b-no">✗ 你填：${esc(p.input || "（空）")}</span> → 应填 <code>${esc(p.expect)}</code>`}</div>`).join("") +
        refBlock(q);
    } else {
      const per = out.per || [];
      detail = `<div class="stem">${esc(q.stem)}</div><div class="point-list">` + per.map((p, pi) => {
        const cn = { hit: "命中要点", part: "部分命中", miss: "未答到" }[p.state];
        const bar = `<div class="cov-track" style="color:${p.state === "hit" ? "var(--ok)" : p.state === "part" ? "var(--warn)" : "var(--bad)"}"><div class="cov-bar" style="width:${Math.round(p.cov * 100)}%"></div></div>`;
        const frags = p.segs && p.segs.length ? `<div class="frags">答到片段：${p.segs.slice(0, 6).map((seg) => `<span>${esc(seg)}</span>`).join("")}</div>` : "";
        const cmt = p.comment ? `<div class="per-comment">🤖 ${esc(p.comment)}</div>` : "";
        return `<div class="point ${p.state}"><div class="p-head"><span class="p-state">${cn} ${Math.round(p.cov * 100)}%</span>${bar}</div>` +
          `<div>${rich(pointTexts(q, pi, p.text), q)}</div>${frags}${cmt}</div>`;
      }).join("") + `</div>` +
        (out.summary ? `<details class="ai-reply"${out.fresh ? " open" : ""}><summary>🤖 AI 完整回复</summary><div class="ai-reply-body">${esc(out.summary)}</div></details>` : "");
    }
    const histNote = r.oldScore != null ? `原记录 ${r.oldScore} 分 → 本次 ${s} 分` : "本次成绩已计入掌握";
    return `<article class="rcard recite-result" data-id="${q.id}">
      <div class="rcard-head"><span class="qno">原题 #${q.id}</span>
        <span class="badge ${q.type}">${TYPE_CN[q.type]}</span><span class="chap">${esc(q.chapter)}</span>
        <span class="rcard-tag ${mastered ? "good" : s >= 60 ? "mid" : "wrong"}">${mastered ? "已掌握" : "未掌握"}</span></div>
      <div class="verdict"><span class="score-big ${cls}">${s}</span><span class="tag ${cls}">${label}</span>${badge}</div>
      ${detail}
      <div class="rcard-actions">
        <button type="button" class="primary" id="reciteNextAfter">下一题 →</button>
        ${mastered ? "" : '<button type="button" class="secondary" id="reciteBackCard">返回背题卡</button>'}
        <span class="rcard-tip">${histNote}${mastered ? "，已移出重点背队列" : ""}</span>
      </div>
    </article>`;
  }
  function reciteRenderResult(q, r) {
    if (!q) return;
    const box = $("#reciteCard"), st = box.scrollTop;
    box.innerHTML = reciteResultHTML(q, r);
    box.scrollTop = st;
  }
  function reciteRenderNav() {
    const n = recite.list.length, inPractice = recite.mode === "practice";
    const inResult = inPractice && !!recite.result;
    $("#recitePos").innerHTML = inPractice
      ? (recite.result ? "已提交评分" : "练习中")
      : n ? `第 <b>${recite.idx + 1}</b> / ${n} 题` : "—";
    $("#recitePrev").disabled = inPractice || !n || recite.idx <= 0;
    // 结果态的底部「下一题」直接进下一题（手机端不必滚到卡内按钮）；作答中点禁用
    $("#reciteNext").disabled = inResult ? false : inPractice || !n || recite.idx >= n - 1;
  }
  function reciteStep(delta) {
    if (recite.mode === "practice") return; // 练习中先提交/取消，避免误丢作答
    if (!recite.list.length) return;
    const next = Math.max(0, Math.min(recite.list.length - 1, recite.idx + delta));
    if (next === recite.idx) return;
    recite.idx = next;
    reciteRenderQueue(); reciteRenderCard(); reciteRenderNav();
    const main = $("#reciteCard"); if (main) main.scrollTop = 0;
  }
  function reciteLeavePractice() {
    if (recite.mode !== "practice") return;
    recite.mode = "back"; recite.result = null; recite.oldScore = null;
  }
  // 「开始练习」/「重做并练习」：不跳主列表，直接在当前背题卡里出作答表单。
  // 已判分题只在提交时归档旧记录并覆盖，取消/切题不写盘；未判分题沿用首次评分。
  function reciteStartPractice() {
    const it = recite.list[recite.idx];
    if (!it) return;
    const rec = store[it.id];
    recite.mode = "practice";
    recite.result = null;
    recite.oldScore = rec && rec.s != null ? rec.s : null;
    reciteRenderCard(); reciteRenderNav();
    const main = $("#reciteCard"); if (main) main.scrollTop = 0;
  }
  function reciteNextAfterResult() {
    const id = recite.result && recite.result.id;
    const list = recite.list;
    const pos = id != null ? list.findIndex((e) => e.id === id) : -1;
    const idx = pos >= 0 ? Math.min(pos + 1, list.length - 1) : Math.min(recite.idx, Math.max(0, list.length - 1));
    recite.idx = Math.max(0, idx);
    recite.mode = "back"; recite.result = null; recite.oldScore = null;
    reciteRenderQueue(); reciteRenderCard(); reciteRenderNav();
    const main = $("#reciteCard"); if (main) main.scrollTop = 0;
  }
  function reciteBackToCard() {
    recite.mode = "back"; recite.result = null; recite.oldScore = null;
    reciteRenderCard(); reciteRenderNav();
    const main = $("#reciteCard"); if (main) main.scrollTop = 0;
  }
  // 简答在背题页内作答后同样异步升级 AI 判分：成功更新成绩与逐点点评，失败保留本机分并标原因
  // （与主站 upgradeEssay 同口径；不写主列表 DOM，只刷新当前结果区与队列）。
  function reciteUpgradeEssay(q, input) {
    if (!aiEnabled()) return;
    if (!recite.result || recite.result.id !== q.id) return;
    recite.result.aiPending = true;
    reciteRenderCard();
    requestAI(q, input).then((data) => {
      const rec = store[q.id];
      if (!rec || essayTextOf(rec.u) !== input.whole) return; // 用户已重答/切题，丢弃过期结果
      const summary = typeof data.summary === "string" ? data.summary : "";
      rec.s = data.score;
      rec.g = { score: data.score, per: data.per, ts: Date.now() };
      if (summary) rec.g.summary = summary;
      save(); renderStats(); renderChapters(); renderList();
      if (!recite.result || recite.result.id !== q.id) return;
      recite.result.out = { s: data.score, per: data.per, engine: "ai", summary, fresh: true };
      recite.result.aiPending = false; recite.result.aiError = "";
      reciteRefreshQueue(q.id);
      reciteRenderCard();
    }).catch((e) => {
      if (e.code === "svc_down" || e.code === "no_key" || e.code === "bad_key") aiOff = true;
      if (!recite.result || recite.result.id !== q.id) return;
      recite.result.aiPending = false;
      recite.result.aiError = AI_CODES[e.code] || e.code || "upstream";
      reciteRenderCard();
    });
  }
  function bindRecite() {
    if (!reciteEnabled()) { const b = $("#reciteEntry"); if (b) b.remove(); return; }
    const entry = $("#reciteEntry");
    if (entry) entry.addEventListener("click", reciteOpen);
    const dlg = $("#reciteDialog");
    if (!dlg) return;
    $("#reciteFold").addEventListener("click", () => {
      recite.folded = !recite.folded;
      recite.foldTouched = true; // 手动选择后本次会话保持，不再被窄屏默认值覆盖
      reciteUpdateFold();
    });
    $("#reciteClose").addEventListener("click", () => dlg.close());
    $("#recitePrev").addEventListener("click", () => reciteStep(-1));
    $("#reciteNext").addEventListener("click", () => {
      if (recite.mode === "practice" && recite.result) { reciteNextAfterResult(); return; }
      reciteStep(1);
    });
    $("#reciteGroupChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      reciteLeavePractice();
      recite.group = b.dataset.group; recite.idx = 0;
      reciteRenderFilters(); reciteApply();
    });
    $("#reciteTypeChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      reciteLeavePractice();
      recite.type = b.dataset.type; recite.idx = 0;
      reciteRenderFilters(); reciteApply();
    });
    $("#reciteQueue").addEventListener("click", (e) => {
      const li = e.target.closest(".recite-q-item"); if (!li) return;
      reciteLeavePractice();
      recite.idx = +li.dataset.i;
      reciteRenderQueue(); reciteRenderCard(); reciteRenderNav();
      const main = $("#reciteCard"); if (main) main.scrollTop = 0;
    });
    // 背题卡内事件委托：开始/重做练习 → 提交 → 取消/下一题；练习表单的选项点击与输入草稿
    $("#reciteCard").addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("#recitePractice")) { reciteStartPractice(); return; }
      if (t.closest("#reciteSubmit")) { reciteSubmitPractice(); return; }
      if (t.closest("#reciteCancel")) {
        const id = recite.list[recite.idx] && recite.list[recite.idx].id;
        reciteLeavePractice();
        if (id != null) reciteRefreshQueue(id); // 未判分草稿已落盘：刷新队列让「有草稿未提交」标记即时生效
        reciteRenderCard(); reciteRenderNav();
        return;
      }
      if (t.closest("#reciteNextAfter")) { reciteNextAfterResult(); return; }
      if (t.closest("#reciteBackCard")) { reciteBackToCard(); return; }
      const opt = t.closest(".recite-practice .opt");
      if (opt && recite.mode === "practice" && !recite.result) {
        $$(".opt", opt.parentNode).forEach((o) => o.classList.remove("picked"));
        opt.classList.add("picked");
        const card = t.closest(".recite-practice"), q = card && QBYID[+card.dataset.id];
        if (q && !(store[q.id] && store[q.id].s != null)) saveDraft(q, card); // 仅未判分题存草稿；重做中取消不写盘
      }
    });
    $("#reciteCard").addEventListener("input", (e) => {
      if (e.target.matches("textarea.ans")) autoGrow(e.target);
      if (recite.mode !== "practice" || recite.result) return;
      const card = e.target.closest(".recite-practice");
      if (!card) return;
      const q = QBYID[+card.dataset.id];
      if (q && !(store[q.id] && store[q.id].s != null)) saveDraft(q, card);
    });
    // 关闭弹层/切题时退出练习态（未判分草稿已随输入落盘；重做未提交不写盘）
    dlg.addEventListener("close", reciteLeavePractice);
    // 左右方向键翻题（背题态；练习中禁用，Esc 由 <dialog> 原生关闭）
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); reciteStep(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); reciteStep(1); }
    });
  }

  // ——— 考前重点记忆 ———
  // 科目 meta.memo.enabled 开启（subject.json→meta）：把串讲导图拆出的考点小节，按「是否还有未掌握题」
  // 分档列出——只显示知识点、不显示题干，也不判分；某考点所挂的题全部 ≥80 分后自动移出「未掌握」。
  // 统计/筛选纯函数在 frontend/memo.js；入口与弹层样式复用重点优先背那一套。
  const MEMO = window.MEMO;
  const memoState = { status: "pending", keyword: "" };
  function memoEnabled() { return !!(D.meta.memo && D.meta.memo.enabled) && !!(MEMO && D.memo); }
  function memoView() { return MEMO.build(D.memo, store); }
  function updateMemoEntry() {
    const btn = $("#memoEntry");
    if (!memoEnabled()) { if (btn) btn.remove(); return; } // 未开启的科目不注入入口
    if (!btn) return;
    const n = memoView().counts.pending;
    $("#memoCount").textContent = n;
    btn.style.display = "";
    btn.classList.toggle("zero", n === 0);
    btn.title = n ? `未掌握考点 ${n} 个：只列知识点、不显示题干` : "考点对应题目都已掌握";
  }
  function memoSectionHTML(sec) {
    const tag = sec.status === "master"
      ? '<span class="memo-tag ok">✓ 已掌握</span>'
      : '<span class="memo-tag bad">未掌握</span>';
    const pieces = [];
    if (sec.by.wrong) pieces.push(`答错 ${sec.by.wrong}`);
    if (sec.by.mid) pieces.push(`待提高 ${sec.by.mid}`);
    if (sec.by.todo) pieces.push(`未作答 ${sec.by.todo}`);
    const stat = sec.status === "pending" ? `<span class="memo-stat">${pieces.join(" · ")}</span>` : "";
    const types = (sec.types || []).map((t) => `<span class="memo-type">${esc(t)}</span>`).join("");
    return `<details class="memo-sec${sec.status === "master" ? " done" : ""}" open>` +
      `<summary><span class="memo-no">${esc(sec.id)}</span><b class="memo-title">${esc(sec.title)}</b>${types}${tag}${stat}</summary>` +
      `<ul class="memo-list">` + (sec.items || []).map((it) => `<li class="memo-li d${it.d}">${mdBold(it.t)}</li>`).join("") + `</ul></details>`;
  }
  function memoSubHTML(c) {
    return `<span class="rs-item">未掌握考点 <b>${c.pending}</b> / ${c.sections}</span>` +
      `<span class="rs-item">未掌握题 <b>${c.questions - c.mastered}</b> / ${c.questions}</span>` +
      `<span class="rs-item wrong">答错 <b>${c.wrong}</b></span>` +
      `<span class="rs-item mid">待提高 <b>${c.mid}</b></span>` +
      `<span class="rs-item todo">未作答 <b>${c.todo}</b></span>` +
      (c.draft ? `<span class="rs-item">含草稿 <b>${c.draft}</b></span>` : "") +
      `<span class="rs-tip">只列考点、不显示题干；该考点所挂的题全部 ≥80 分后自动移出「未掌握」。</span>`;
  }
  function memoRender() {
    const view = memoView();
    const c = view.counts;
    $("#memoSub").innerHTML = memoSubHTML(c);
    const chips = [["pending", `未掌握 ${c.pending}`], ["wrong", `❗ 答错 ${c.sectionsWrong}`], ["master", `已掌握 ${c.master}`], ["all", `全部 ${c.sections}`]];
    $("#memoStatusChips").innerHTML = chips.map(([k, label]) =>
      `<button type="button" class="chip${memoState.status === k ? " active" : ""}" data-status="${k}">${label}</button>`).join("");
    const f = MEMO.filter(view, memoState);
    if (!f.chapters.length) {
      $("#memoBody").innerHTML = `<div class="memo-empty">` + (memoState.keyword
        ? "没有匹配的考点，换个关键词或切到「全部」看看。"
        : memoState.status === "wrong" ? "还没有答错的考点——保持住，去「未掌握」把没做过的补上。"
        : c.pending ? "当前筛选下没有考点。" : "🎉 考点对应题目都已掌握（≥80 分），考前翻翻思维导图保持手感即可。") + `</div>`;
      return;
    }
    $("#memoBody").innerHTML = f.chapters.map((ch) =>
      `<section class="memo-chap"><h3>${esc(ch.name)}<span class="memo-chap-count">${memoState.status === "wrong" ? `答错 ${ch.wrong} 题` : `未掌握 ${ch.pending} / ${ch.total} 考点`}</span></h3>` +
      ch.sections.map(memoSectionHTML).join("") + `</section>`).join("");
  }
  function memoOpen() {
    if (!memoEnabled()) return;
    memoState.status = "pending";
    memoState.keyword = "";
    const kw = $("#memoSearch"); if (kw) kw.value = "";
    memoRender();
    const dlg = $("#memoDialog");
    if (dlg && !dlg.open) dlg.showModal();
    const body = $("#memoBody"); if (body) body.scrollTop = 0;
  }
  function bindMemo() {
    if (!memoEnabled()) { const b = $("#memoEntry"); if (b) b.remove(); return; } // 未开启的科目不注入入口
    const entry = $("#memoEntry");
    if (entry) entry.addEventListener("click", memoOpen);
    const dlg = $("#memoDialog");
    if (!dlg) return;
    $("#memoClose").addEventListener("click", () => dlg.close());
    $("#memoStatusChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      memoState.status = b.dataset.status;
      memoRender();
    });
    $("#memoSearch").addEventListener("input", (e) => {
      memoState.keyword = e.target.value;
      memoRender();
    });
  }

  // ——— 题目过滤与列表 ———
  // 静态筛选（章节/题型/搜索）+ 可选状态筛选。状态筛选只在两个场合生效：组卷抽题范围、无卷时的刷题列表。
  // 卷激活时不参与卷面展示——「组卷即全新」会清掉卷内得分，状态已被重置（旧行为下「待提高/已掌握」组卷后全卷被自己筛空）；
  // 章节/题型/搜索是题目固有属性，组卷已按它们圈池，卷内继续生效（卷内收窄）
  function passFilters(q, withStatus) {
    if (filters.chapter !== "all" && q.chapter !== filters.chapter) return false;
    if (filters.type !== "all" && q.type !== filters.type) return false;
    if (filters.search && !q.stem.includes(filters.search) && !(q.ref || "").includes(filters.search)) return false;
    if (withStatus) {
      const s = store[q.id] && store[q.id].s;
      if (filters.status === "todo" && s != null) return false;
      if (filters.status === "low" && !(s != null && s < 60)) return false;
      if (filters.status === "master" && !(s != null && s >= 80)) return false;
    }
    return true;
  }
  function paperActive() { return !!(shuffle && shuf && shuf.picked); }
  function visible() {
    let qs = D.questions.filter((q) => passFilters(q, !paperActive()));
    if (paperActive()) {
      const pos = new Map(shuf.picked.map((id, i) => [id, i]));
      qs = qs.filter((q) => pos.has(q.id)).sort(
        (a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || pos.get(a.id) - pos.get(b.id));
    }
    return qs;
  }

  function stemHTML(q) {
    if (q.type !== "blank") return esc(q.stem);
    const parts = q.stem.split(/_{2,}/);
    let out = parts.map((p, i) =>
      esc(p) + (i < parts.length - 1 ? `<input class="blank" data-bi="${i}" autocomplete="off" spellcheck="false">` : "")
    ).join("");
    return out;
  }

  function cardHTML(q, idx) {
    const rec = store[q.id];
    let body = "";
    if (q.type === "single") {
      // 单选：正确答案与解析都落在选项区内（answer-badge 背答案态 / 判分后 showResult 打标记），不另设结果区与底部解析面板
      body = `<div class="opts">` + q.options.map((o) =>
        `<div class="opt" data-key="${o.key}"><span class="key">${o.key}</span><span>${esc(o.text)}</span>` +
        (showRef && o.key === q.answer ? '<span class="opt-ans ok">✓ 正确答案</span>' : "") + `</div>`).join("") +
        `<div class="explain"></div></div>`;
    } else if (q.type === "blank") {
      body = `<div class="stem">${stemHTML(q)}</div>`;
    } else {
      body = `<div class="essay-form"></div>`;
    }
    const head = `<div class="card-head">
        <span class="qno">第 ${idx} 题 · 原题 #${q.id}</span>
        <span class="badge ${q.type}">${TYPE_CN[q.type]}</span>
        <span class="chap">${esc(q.chapter)}</span>
        <span class="score-chip-slot">${rec && rec.s != null ? `<span class="score-chip ${scoreCls(rec.s)}">${rec.s} 分</span>` : ""}</span>
      </div>`;
    const ref = showRef && q.type !== "single" ? inlineRef(q) : "";
    return `<section class="card" data-id="${q.id}">${head}
      ${q.type === "blank" ? "" : `<div class="stem">${stemHTML(q)}</div>`}
      ${body}${ref}
      <div class="actions"><button class="primary grade-btn">提交评分</button><button class="secondary explain-btn">解析</button><span class="flash"></span></div>
      ${q.type === "single" ? "" : `<div class="result"></div>
      <div class="explain"></div>`}
    </section>`;
  }

  function inlineRef(q) {
    if (q.type === "single") return `<div class="inline-ref"><b>正确答案：${q.answer}</b></div>`;
    if (q.type === "essay") {
      return `<div class="inline-ref"><b>参考答案（得分点）</b><ol class="ex-list ref-list">` +
        q.points.map((p, i) => `<li>${rich(pointTexts(q, i, p), q)}</li>`).join("") + `</ol></div>`;
    }
    return `<div class="inline-ref"><b>参考答案</b>：${esc(q.ref)}</div>`;
  }

  function scoreCls(s) { return s >= 80 ? "good" : s >= 60 ? "mid" : "poor"; }

  // ——— 结构化解析：考点标签 + 答案行 + 逐条短句 + 大题得分点 ———
  // 数据级加粗：文案里的 **关键词**（解析/得分点展示版）渲染为 <b>，与启发式加粗并存
  function mdBold(s) {
    const html = String(s).split(/\*\*([\s\S]+?)\*\*/g).map((seg, i) => (i % 2 ? `<b>${esc(seg)}</b>` : esc(seg))).join("");
    const m = html.match(/^([^<——：:，,。]{2,14})(——|：|:)/);
    return m ? `<b>${m[1]}</b>${m[2]}${html.slice(m[0].length)}` : html;
  }
  function kwBold(s) {
    const m = s.match(/^([^——：:，,。]{2,14})(——|：|:)/);
    if (!m) return esc(s);
    return `<b>${esc(m[1])}</b>${esc(m[2])}${esc(s.slice(m[0].length))}`;
  }
  function boldFirstOccur(html, term) {
    const t = esc(term);
    for (let from = 0, m; (m = html.indexOf(t, from)) !== -1; from = m + t.length) {
      const before = html.slice(0, m);
      if ((before.match(/<b>/g) || []).length === (before.match(/<\/b>/g) || []).length)
        return html.slice(0, m) + `<b>${t}</b>` + html.slice(m + t.length);
    }
    return html;
  }
  function rich(s, q) {
    if (/\*\*[^*]+\*\*/.test(s)) return mdBold(s);
    if (q && q.type === "single") {
      const opt = ((q.options || []).find((o) => o.key === q.answer) || {}).text || "";
      const html = kwBold(s);
      return opt.length >= 2 && opt.length <= 16 ? boldFirstOccur(html, opt) : html;
    }
    return kwBold(s);
  }
  function pointTexts(q, i, fallback) {
    return q && q.pointsMd && q.points && q.points[i] === fallback ? q.pointsMd[i] : fallback;
  }
  function splitItems(body) {
    const frags = body.split(/[；;]/).flatMap((p) => p.split(/(?<=。)/)).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const f of frags) {
      if (out.length && f.length < 10) out[out.length - 1] += f;
      else out.push(f);
    }
    return out;
  }
  // opts.noAI：不渲染「逐项解析」按钮（重点优先背等静态展示场景）；noAns：不重复「应填」；
  // noPts：不重复简答得分点列表（背题卡已单列）。缺省与旧行为一致。
  function explainHTML(q, opts) {
    opts = opts || {};
    const text = q.explain || q.ref || "";
    let body = text, header = null;
    const m = text.match(/^考点\s*([^：:]{1,48}?)\s*[：:]\s*/);
    if (m) { header = m[1]; body = text.slice(m[0].length); }
    let html = "";
    if (header) html += `<div class="ex-tag">📍 考点 ${esc(header)}</div>`;
    if (q.type === "blank" && !opts.noAns) html += `<div class="ex-ans">应填：${q.blanks.map((v) => `<b>${esc(v[0])}</b>`).join("、")}${q.unordered ? ' <span class="pi-tip">（并列各空，顺序可互换）</span>' : ""}</div>`;
    const items = splitItems(body);
    html += `<ul class="ex-list">` + items.map((it) => {
      const cleaned = it.replace(/^（\d+）|^\(\d+\)|^\d+、/, "").trim();
      return `<li>${rich(cleaned, q)}</li>`;
    }).join("") + `</ul>`;
    if (q.type === "essay" && q.points && q.points.length && !opts.noPts) {
      html += `<div class="ex-pts"><h5>✅ 得分点（${q.points.length} 条，答出加粗关键词即得分）</h5><ol>` +
        q.points.map((p, i) => `<li>${rich(pointTexts(q, i, p), q)}</li>`).join("") + `</ol></div>`;
    }
    if (q.type === "single" && !opts.noAI && aiEnabled() && D.meta.flags.explain) { // file://、AI 熔断或科目未开启 explain 特性时不提供逐项解析入口
      html += `<div class="optexpl"><button class="secondary optexpl-btn" type="button">🤖 逐项解析</button><div class="optexpl-body"></div></div>`;
    }
    return html;
  }

  // 旧版「分点作答」记录（该模式已下线）归一为整题文本：历史与跨设备记录照常展示、重判
  function essayTextOf(u) {
    if (!u) return "";
    if (u.mode === "points") return (u.points || []).map((p) => (p || "").trim()).filter(Boolean).join("\n");
    return u.whole || "";
  }
  function essayFormHTML(q, rec) {
    const val = essayTextOf(rec && rec.u);
    return `<textarea class="ans" rows="1" spellcheck="false">${esc(val)}</textarea>
      <div class="hint-line">提示：按要点写出答案，系统将对照参考答案的 ${q.points.length} 个得分点，按关键词覆盖度自动打分（≥50% 视为命中该要点）。</div>`;
  }

  // 整题作答文本框高度随内容自适应（最低一行由 CSS min-height 兜底）；+2 补上下 1px 边框（box-sizing: border-box）
  function autoGrow(ta) { if (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; } }
  function mountEssayForm(card, q, rec) {
    $(".essay-form", card).innerHTML = essayFormHTML(q, rec);
    autoGrow($("textarea.ans", card));
  }

  // 出现标记观察器：题卡滚进视口即记「出现过」（背答案模式下不计——只看答案不算练过）；无 IntersectionObserver 时静默降级
  let seenObs = null;
  if (typeof IntersectionObserver !== "undefined") {
    seenObs = new IntersectionObserver((entries) => {
      if (showRef) return;
      for (const e of entries) if (e.isIntersecting) markSeen(+e.target.dataset.id);
    }, { threshold: 0 });
  }
  function renderList() {
    const qs = visible();
    const html = qs.length ? qs.map((q, i) => cardHTML(q, i + 1)).join("")
      : `<div class="empty">没有符合条件的题目</div>`;
    const list = $("#list");
    list.innerHTML = html;
    qs.forEach((q) => {
      const card = $(`.card[data-id="${q.id}"]`, list);
      if (!card) return;
      if (q.type === "essay") mountEssayForm(card, q, store[q.id]);
      bindCard(q, card);
      const rec = store[q.id];
      if (rec) {
        if (q.type === "blank" && Array.isArray(rec.u)) {
          $$(".stem input.blank", card).forEach((inp, i) => (inp.value = rec.u[i] || ""));
        }
        if (q.type === "single" && typeof rec.u === "string") {
          const el = $(`.opt[data-key="${rec.u}"]`, card);
          if (el) el.classList.add("picked");
        }
        if (rec.s != null) restoreResult(q, card);
      }
    });
    if (seenObs) {
      seenObs.disconnect(); // 卡片已整批重建，重新登记观察
      $$(".card[data-id]", list).forEach((card) => seenObs.observe(card));
    }
    updateBulkBar();
    updatePaperInfo();
  }

  // ——— 判分 ———
  function collect(q, card) {
    if (q.type === "single") {
      const picked = $(".opt.picked", card);
      return picked ? picked.dataset.key : null;
    }
    if (q.type === "blank") {
      return $$(".stem input.blank", card).map((i) => i.value.trim());
    }
    const whole = $("textarea.ans", card).value.trim();
    return whole ? { mode: "whole", whole } : null;
  }

  function grade(q, input) {
    if (q.type === "single") {
      const r = G.gradeSingle(input, q.answer);
      return { s: r.score, per: null };
    }
    if (q.type === "blank") {
      const r = G.gradeBlanks(input, q);
      return { s: r.score, per: r.per };
    }
    const r = G.gradeEssay(input.whole || "", q.points);
    return { s: r.score, per: r.per, engine: "local" };
  }

  // ——— 简答 AI 判分：经同源 /api/grade 调 Go 服务（grade-svc），不可用自动降级本机估分 ———
  let aiOff = false; // 会话级熔断：服务未启动 / 未配 Key / Key 无效时不再重复请求
  const AI_CODES = { no_key: "未配置 QWEN_API_KEY", bad_key: "API Key 无效", svc_down: "判分服务未启动", timeout: "上游超时", parse: "上游输出解析失败", upstream: "上游服务错误", bad_request: "请求参数异常", internal: "服务内部错误", network: "网络中断，请检查网络后重试", incomplete: "连接中断，解析未完成，请重试", unauthorized: "请先登录后使用 AI 判分", auth_unavailable: "登录状态校验失败，请稍后重试", too_many_requests: "本小时判分次数已达上限，请稍后再试" };
  function aiEnabled() { return !aiOff && location.protocol !== "file:"; }
  function liveCard(qid) { return document.querySelector(`.card[data-id="${qid}"]`); }
  function essayAnswerText(input) {
    return input.whole || "";
  }
  function markAIGrading(card) {
    const tag = $(".verdict .tag", card);
    if (tag && !$(".ai-pending", card)) tag.insertAdjacentHTML("afterend", '<span class="ai-pending">🤖 AI 判分中…</span>');
  }
  async function requestAI(q, input) {
    const res = await fetch("api/grade", { // 相对路径：门户子路径部署时自动打 /os/api/grade
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stem: q.stem, ref: q.ref, points: q.points, answer: essayAnswerText(input) }),
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !Array.isArray(data.per) || typeof data.score !== "number") {
      const e = new Error((data && data.error) || "upstream");
      e.code = (data && data.error) || "upstream";
      throw e;
    }
    return data;
  }
  // 成功：卡片升级为 AI 分并写 store.g；失败：保留本机分并在卡上标注原因。
  // record=false（重新评分）只把 AI 分展示出来，绝不写 store——首次评分才是掌握状态的依据。
  function upgradeEssay(q, input, localOut, record = true) {
    if (!aiEnabled()) return Promise.resolve(false);
    const c0 = liveCard(q.id);
    if (c0) markAIGrading(c0);
    // 结果回来时卡片仍停在这份作答才渲染（等分期间改了答案/切了模式即丢弃）
    const freshCard = () => {
      const c = liveCard(q.id);
      return c && JSON.stringify(collect(q, c)) === JSON.stringify(input) ? c : null;
    };
    return requestAI(q, input)
      .then((data) => {
        const summary = typeof data.summary === "string" ? data.summary : ""; // 「AI 完整回复」整段总评（旧服务无此字段）
        if (record) {
          const rec = store[q.id];
          if (!rec || rec.u !== input) return false; // 用户已重答，丢弃过期结果
          rec.s = data.score;
          rec.g = { score: data.score, per: data.per, ts: Date.now() };
          if (summary) rec.g.summary = summary; // 随作答记录持久化（刷新/换设备经云同步续用）
          save();
        }
        const c = freshCard();
        if (!c) return false;
        showResult(q, c, input, { s: data.score, per: data.per, engine: "ai", summary, practice: !record, fresh: true });
        if (record) { renderStats(); renderChapters(); }
        return true;
      })
      .catch((e) => {
        if (e.code === "svc_down" || e.code === "no_key" || e.code === "bad_key") aiOff = true;
        const c = freshCard();
        if (c) showResult(q, c, input, Object.assign({}, localOut, { unavailable: AI_CODES[e.code] || e.code, practice: !record }));
        return false;
      });
  }
  function bulkUpgradeEssays(jobs) {
    if (!jobs.length || !aiEnabled()) return;
    let upg = 0, fail = 0;
    const queue = jobs.slice();
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const job = queue.shift();
        const ok = await upgradeEssay(job.q, job.u, job.out);
        if (ok) upg++; else fail++;
      }
    });
    Promise.all(workers).then(() => {
      if (upg) toast(`🤖 AI 判分完成：${upg} 道简答已升级为 AI 评分`);
      else if (fail) toast(`🤖 AI 判分未完成 ${fail} 道，已保留本机估分`);
    });
  }

  // ——— 单选逐项解析：同源 /api/grade 的 task:"explain"（stream:true 走 SSE 流式）——LLM 先依《考点串讲》
  // 资料作答，资料不足自动带 enable_search 联网补充；上游默认关闭思考（enable_thinking:false），
  // 若仍推 reason 事件则实时展示思考过程（生成中展开、完成即收起、可手动切换，不入缓存）；
  // 逐选项 delta 实时渲染，done 整包整形后落缓存。
  // 应答为普通 JSON（旧网关/错误体）时回落整包口径；结果按题缓存于 localStorage（派生键），
  // 随 v2 云同步上云（expl 段逐题 ts LWW，跨设备复用不重复烧 token） ———
  const EKEY = KEY + ".expl";
  let explCache = {};
  try { explCache = JSON.parse(localStorage.getItem(EKEY)) || {}; } catch (e) {}
  function saveExplCache(id, v) {
    explCache[id] = Object.assign({}, v, { ts: Date.now() }); // ts＝解析生成时刻，供云端 expl LWW
    try { localStorage.setItem(EKEY, JSON.stringify(explCache)); } catch (e) {}
  }
  function explErr(msg, code) { const e = new Error(msg || "upstream"); e.code = code || msg || "upstream"; return e; }
  // 网络层失败归一：浏览器超时（AbortSignal.timeout）→timeout，其余 fetch 异常→network——
  // 避免 catch 里拿到无 code 的 DOMException 后只能提示「逐项解析失败：undefined」。
  function netErr(e) {
    const timedOut = !!e && (e.name === "TimeoutError" || e.name === "AbortError");
    return explErr(timedOut ? "timeout" : "network", timedOut ? "timeout" : "network");
  }
  function validExpl(data, q) { return data && Array.isArray(data.items) && data.items.length === q.options.length; }
  async function requestExplain(q, onEvent) {
    let res;
    try {
      res = await fetch("api/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "explain", stream: true, stem: q.stem, options: q.options, answer: q.answer, ref: q.explain || q.ref || "" }),
        signal: AbortSignal.timeout(95000), // 两级上游调用（资料级+联网级），预算比判分长
      });
    } catch (e) {
      throw netErr(e); // 请求没发出去/被超时中断：明确错误码，交上层展示可重试错误条
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) { // 非流式应答兜底（未升级的旧服务等；错误体也走这里）
      const data = await res.json().catch(() => null);
      if (!res.ok || !validExpl(data, q)) throw explErr(data && data.error, (data && data.error) || "upstream");
      return data;
    }
    const data = await readExplSSE(res.body, onEvent);
    if (!validExpl(data, q)) throw explErr("parse");
    return data;
  }
  // readExplSSE：读 SSE 帧并分发 reason/delta/reset 给 onEvent；done 整包 resolve、error 带 code reject。
  // 流断（网络断开/超时 abort 后余帧）未等到 done → 按连接中断（incomplete）失败处理，界面可重试。
  function readExplSSE(body, onEvent) {
    return new Promise((resolve, reject) => {
      const reader = body.getReader(), dec = new TextDecoder();
      let buf = "", settled = false;
      const done = (fn) => (arg) => { if (!settled) { settled = true; fn(arg); } };
      const ok = done(resolve), bad = done(reject);
      (async () => {
        while (!settled) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0 && !settled) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let ev = "message", data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) ev = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim(); // Go 端 data 为单行 JSON
            }
            if (!data) continue;
            let payload;
            try { payload = JSON.parse(data); } catch (e) { continue; }
            if (ev === "done") return ok(payload);
            if (ev === "error") return bad(explErr(payload.error, payload.error));
            onEvent(ev, payload);
          }
        }
        if (!settled) bad(explErr("incomplete", "incomplete"));
      })().catch((e) => bad(e && e.code ? e : netErr(e)));
    });
  }
  function thinkPanelHTML(think, live) {
    return `<div class="oe-think${live ? "" : " collapsed"}">` +
      `<button class="oe-think-head" type="button"><span>${live ? "🧠 思考中…" : "🧠 思考过程"}</span><span class="oe-caret">▾</span></button>` +
      `<div class="oe-think-body">${live ? "" : esc(think)}</div></div>`;
  }
  function renderOptExpl(body, data) {
    const chip = data.source === "material"
      ? '<span class="oe-src ref">📖 依据考点串讲资料</span>'
      : '<span class="oe-src search">🔍 联网搜索补充</span>';
    delete body.dataset.live;
    const think = body.__think || "";
    // 标签按「是否本题答案」而不按「选项表述对错」：否定式题干（不正确的是/不属于）下后者会读反。
    body.innerHTML = `<div class="oe-head">逐项解析 ${chip}</div>` + (think ? thinkPanelHTML(think, false) : "") +
      data.items.map((it) =>
      `<div class="oe-row ${it.correct ? "ok" : "no"}"><span class="oe-key">${esc(it.key)}</span>` +
      `<span class="oe-tag">${it.correct ? "✓ 本题答案" : "✗ 非本题答案"}</span><span class="oe-why">${esc(it.why)}</span></div>`).join("");
    body.classList.add("show");
  }
  // 流式渲染：reason 事件流式展示思考过程（生成中保持展开，用户可点标题手动收起/展开；
  // done 后整包重排默认收起）；delta 事件逐选项落行（行按到达序出现，done 整包整形后重排并标注对错）；
  // reset ＝ 资料级输出被弃用转联网，清回生成头（思考面板一并清空重建）。dataset.live 同时驱动光标样式。
  // 点按钮即调用（不等首个 delta）——长等待期先给可见「生成中」，避免点了像没反应。
  function startExplLive(body, head) {
    body.dataset.live = "1";
    body.__think = "";
    body.innerHTML = `<div class="oe-head">${head || "🤖 逐项解析生成中…"}</div>`;
    body.classList.add("show");
  }
  function explLiveReason(body, text) {
    if (!text) return;
    if (!body.dataset.live) startExplLive(body);
    if (!$(".oe-think", body)) body.insertAdjacentHTML("beforeend", thinkPanelHTML("", true));
    body.__think += text;
    const tb = $(".oe-think-body", body);
    tb.textContent = body.__think;
    if (!body.querySelector(".oe-think").classList.contains("collapsed")) tb.scrollTop = tb.scrollHeight;
  }
  function explLiveDelta(body, key, text) {
    if (!body.dataset.live) startExplLive(body);
    if (!text) return;
    let row = key ? $(`.oe-row[data-k="${key}"]`, body) : null;
    if (!row) {
      row = document.createElement("div"); // 未知 key（罕见：模型乱序）：并入最后活跃行，done 会纠正
      row.className = "oe-row";
      if (key) { row.dataset.k = key; row.innerHTML = `<span class="oe-key">${esc(key)}</span>`; }
      row.insertAdjacentHTML("beforeend", '<span class="oe-why"></span>');
      body.appendChild(row);
    }
    const why = $(".oe-why", row);
    why.textContent += text;
  }
  // 失败呈现（不再「toast 后一片空白」）：错误条 + 重试按钮；有旧结果则先回滚旧结果再挂错误条。
  function oeErrRow(msg) {
    return `<div class="oe-err"><span>⚠ ${esc(msg)}</span><button class="secondary oe-retry" type="button">重试</button></div>`;
  }
  function renderExplError(body, msg) {
    delete body.dataset.live;
    body.classList.add("show");
    body.innerHTML = `<div class="oe-head">🤖 逐项解析失败</div>` + oeErrRow(msg);
  }
  function wireOptExpl(q, btn, body) {
    let cached = explCache[q.id];
    if (cached && Array.isArray(cached.items)) {
      renderOptExpl(body, cached);
      btn.textContent = "🤖 重新逐项解析";
    }
    body.addEventListener("click", (e) => { // 事件委托（面板随 innerHTML 重建）：思考折叠 + 失败重试
      const t = e.target;
      if (!t || !t.closest) return;
      const head = t.closest(".oe-think-head");
      if (head) { head.parentNode.classList.toggle("collapsed"); return; }
      if (t.closest(".oe-retry")) run();
    });
    async function run() {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "🤖 逐项解析生成中…（可能要联网）";
      startExplLive(body); // 立即落生成头：等待首个 delta / 联网检索期间不再是空白
      try {
        const data = await requestExplain(q, (ev, p) => {
          if (ev === "delta") explLiveDelta(body, p.key, p.text);
          else if (ev === "reason") explLiveReason(body, p.text);
          else if (ev === "reset") startExplLive(body, "🤖 资料未覆盖，正在联网补充…");
        });
        saveExplCache(q.id, data);
        cached = data;
        renderOptExpl(body, data);
        btn.textContent = "🤖 重新逐项解析";
      } catch (e) {
        if (e.code === "svc_down" || e.code === "no_key" || e.code === "bad_key") aiOff = true; // 与简答判分共用熔断
        const msg = AI_CODES[e.code] || "服务暂时不可用，请稍后重试";
        if (cached && Array.isArray(cached.items)) { // 回滚旧完整结果，附错误条（可点重试）
          renderOptExpl(body, cached);
          body.insertAdjacentHTML("beforeend", oeErrRow(msg));
        } else {
          renderExplError(body, msg); // 没有旧结果也保留面板：错误条 + 重试，不清空消失
        }
        btn.textContent = cached && Array.isArray(cached.items) ? "🤖 重新逐项解析" : "🤖 逐项解析";
        toast("逐项解析失败：" + msg);
      } finally {
        btn.disabled = false;
      }
    }
    btn.addEventListener("click", run);
  }

  function flash(card, msg) {
    const f = $(".flash", card);
    f.textContent = msg;
    setTimeout(() => (f.textContent = ""), 2200);
  }

  function showResult(q, card, input, out) {
    if (q.type === "single") {
      // 单选结果只落在选项区：正确项绿+✓、错选项红+你的选择，分数走顶栏胶囊；不开独立结果区
      $$(".opt .opt-ans", card).forEach((b) => b.remove()); // 重评分先清旧标记
      $$(".opt", card).forEach((el) => {
        el.classList.remove("dim", "right", "wrong", "picked");
        el.classList.add("dim");
        if (el.dataset.key === q.answer) {
          el.classList.remove("dim"); el.classList.add("right");
          el.insertAdjacentHTML("beforeend", '<span class="opt-ans ok">✓ 正确答案</span>');
        } else if (el.dataset.key === input) {
          el.classList.remove("dim"); el.classList.add("wrong");
          el.insertAdjacentHTML("beforeend", '<span class="opt-ans no">你的选择 ✗</span>');
        }
      });
      armResultUI(q, card, out);
      return;
    } else if (q.type === "blank") {
      $$(".stem input.blank", card).forEach((el, i) => {
        el.classList.remove("right", "wrong");
        el.classList.add(out.per[i].ok ? "right" : "wrong");
      });
      const report = out.per.map((p, i) =>
        `<div class="blank-report">${i + 1}. ${p.ok ? '<span class="b-ok">✓ ' + esc(p.input) + "</span>"
          : `<span class="b-no">✗ 你填：${esc(p.input || "（空）")}</span> → 应填 <code>${esc(p.expect)}</code>`}</div>`).join("");
      $(".result", card).innerHTML = `<div class="verdict"><span class="score-big ${scoreCls(out.s)}">${out.s}</span>
        <span class="tag ${scoreCls(out.s)}">${out.s === 100 ? "全部填对" : `答对 ${out.per.filter((p) => p.ok).length}/${out.per.length}`}</span></div>${report}${refBlock(q)}`;
    } else {
      const pts = out.per.map((p, pi) => {
        const cn = { hit: "命中要点", part: "部分命中", miss: "未答到" }[p.state];
        const bar = `<div class="cov-track" style="color:${p.state === "hit" ? "var(--ok)" : p.state === "part" ? "var(--warn)" : "var(--bad)"}"><div class="cov-bar" style="width:${Math.round(p.cov * 100)}%"></div></div>`;
        const frags = p.segs && p.segs.length ? `<div class="frags">答到片段：${p.segs.slice(0, 6).map((s) => `<span>${esc(s)}</span>`).join("")}</div>` : "";
        const cmt = p.comment ? `<div class="per-comment">🤖 ${esc(p.comment)}</div>` : "";
        return `<div class="point ${p.state}"><div class="p-head"><span class="p-state">${cn} ${Math.round(p.cov * 100)}%</span>${bar}</div>
          <div>${rich(pointTexts(q, pi, p.text), q)}</div>${frags}${cmt}</div>`;
      }).join("");
      const label = out.s >= 85 ? "掌握良好" : out.s >= 60 ? "基本及格，漏掉部分要点" : "还需加强背诵";
      const badge = out.engine === "ai"
        ? '<span class="ai-badge ai">🤖 AI 判分</span>'
        : out.unavailable
          ? `<span class="ai-badge local" title="AI 判分不可用：${esc(out.unavailable)}">本机估分</span>`
          : "";
      // 「AI 完整回复」：整段总评折叠块；刚判完自动展开，刷新/恢复后收起（旧缓存无 summary 则不渲染）
      const reply = out.summary
        ? `<details class="ai-reply"${out.fresh ? " open" : ""}><summary>🤖 AI 完整回复</summary>
            <div class="ai-reply-body">${esc(out.summary)}</div></details>`
        : "";
      $(".result", card).innerHTML = `<div class="verdict"><span class="score-big ${scoreCls(out.s)}">${out.s}</span>
        <span class="tag ${scoreCls(out.s)}">${label}</span>${badge}</div>
        <div class="point-list">${pts}</div>${reply}${refBlock(q)}`;
    }
    $(".result", card).classList.add("show");
    armResultUI(q, card, out);
  }

  // 判分后的公共收尾：提交按钮变「重新评分」、追加「重做此题」（重做前留档）、刷新分数胶囊、未满分自动展开解析
  // （单选展开的是选项区内的解析，填空/简答是底部面板）
  // out.practice：重新评分只演示本次练习结果，不刷新分数胶囊（掌握状态以首次评分为准）
  function armResultUI(q, card, out) {
    const btn = $(".grade-btn", card);
    btn.textContent = "重新评分";
    if (!$(".redo-btn", card)) {
      btn.insertAdjacentHTML("beforebegin", '<button class="secondary redo-btn">重做此题</button>');
      $(".redo-btn", card).addEventListener("click", () => {
        archiveHist(q.id, store[q.id]); // 重做前留档，历史作答不丢
        delete store[q.id]; save();
        renderStats(); renderChapters(); renderList(); updateBulkBar();
        document.querySelector(`.card[data-id="${q.id}"]`)?.scrollIntoView({ block: "center" });
      });
    }
    if (out.practice) {
      if (!$(".practice-tag", card)) btn.insertAdjacentHTML("afterend", '<span class="practice-tag">练习分 · 不计入掌握</span>');
    } else {
      updateScoreChip(card, out.s);
    }
    // 未满分自动给出具体解析；简答题例外：默认只展开得分结果，解析由用户手动点开
    if (out.s < 100 && q.type !== "essay" && card.__setExplain) card.__setExplain(true);
  }

  function updateScoreChip(card, s) {
    $(".score-chip-slot", card).innerHTML = `<span class="score-chip ${scoreCls(s)}">${s} 分</span>`;
  }

  function refBlock(q) {
    if (q.type === "single") {
      return `<div class="ref-block"><h4>答案</h4><p>正确答案：<b>${q.answer}</b></p></div>`;
    }
    if (q.type === "essay") return ""; // 要点列表本身即参考答案
    return `<div class="ref-block"><h4>参考答案</h4><p>${esc(q.ref)}</p></div>`;
  }

  function restoreResult(q, card) {
    const rec = store[q.id];
    if (!rec) return;
    if (q.type === "single") {
      const el = $(`.opt[data-key="${rec.u}"]`, card);
      if (el) el.classList.add("picked");
    } else if (q.type === "blank") {
      $$(".stem input.blank", card).forEach((inp, i) => (inp.value = rec.u[i] || ""));
    } else {
      mountEssayForm(card, q, rec);
    }
    // 简答已有 AI 判分结果（g 字段）时直接渲染，不再重算、不打网络；否则走本机词面判分
    // （旧版分点记录先归一为整题文本再判，避免整题分支读到空串）
    const out = q.type === "essay" && rec.g
      ? { s: rec.g.score, per: rec.g.per, engine: "ai", summary: rec.g.summary || "" }
      : grade(q, q.type === "essay" ? { mode: "whole", whole: essayTextOf(rec.u) } : rec.u);
    showResult(q, card, q.type === "single" ? rec.u : rec.u, out);
  }

  // ——— 交互绑定 ———
  function bindCard(q, card) {
    // 解析面板：随时可看；答错时自动展开
    const exBtn = $(".explain-btn", card), exPanel = $(".explain", card);
    function setExplain(open) {
      exPanel.innerHTML = open ? explainHTML(q) : "";
      exPanel.classList.toggle("show", open);
      exBtn.classList.toggle("active", open);
      exBtn.textContent = open ? "收起解析" : "解析";
      if (open) {
        markViewed(q); // 点开解析即记为「看过」：未作答直接看解析＝完全没掌握
        if (q.type === "single" && !(store[q.id] && store[q.id].s != null)) {
          // 未判分就看解析：正确答案同样标进选项区（标出后保持）
          const el = $(`.opt[data-key="${q.answer}"]`, card);
          if (el && !el.querySelector(".opt-ans")) el.insertAdjacentHTML("beforeend", '<span class="opt-ans ok">✓ 正确答案</span>');
        }
        const ob = $(".optexpl-btn", exPanel);
        if (ob) wireOptExpl(q, ob, $(".optexpl-body", exPanel)); // 每次展开重新绑定（面板为重建 innerHTML）
      }
    }
    card.__setExplain = setExplain;
    exBtn.addEventListener("click", () => setExplain(!exPanel.classList.contains("show")));
    if (q.type === "single") {
      $$(".opt", card).forEach((el) => el.addEventListener("click", () => {
        if ($(".redo-btn", card)) return; // 已判分锁定选项（结果就在选项区，无独立结果区可查），需先「重做此题」
        $$(".opt", card).forEach((o) => o.classList.remove("picked"));
        el.classList.add("picked");
        saveDraft(q, card);
      }));
    }
    $(".grade-btn", card).addEventListener("click", () => {
      const input = collect(q, card);
      if (input == null) return flash(card, q.type === "single" ? "请先选择一个选项" : "请先写出你的答案");
      if (q.type === "blank" && input.every((v) => !v)) return flash(card, "请先填写答案");
      const prev = store[q.id];
      const first = !(prev && prev.s != null); // 首次评分（含草稿）：只有这一次会写入记录并决定掌握状态
      const out = grade(q, input);
      if (first) {
        archiveHist(q.id, prev); // 重新评分不再顶分留档：旧分即首次分，保留在记录里
        store[q.id] = { u: input, s: out.s, ts: Date.now(), v: prev && prev.v }; // 保留「看过解析」标记，判分不洗白
        save();
      } else {
        out.practice = true; // 重新评分只展示练习结果，掌握状态仍按首次评分
      }
      showResult(q, card, input, out);
      if (first) { renderStats(); renderChapters(); }
      updateBulkBar();
      if (q.type === "essay") upgradeEssay(q, input, out, first); // 异步升级为 AI 判分，失败保留上方本机分
    });
    // 回车提交（焦点在卡片输入区内）
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $(".grade-btn", card).click(); }
    });
  }

  // ——— 工具栏 ———
  function bindToolbar() {
    // 移动端：工具栏折叠开关（桌面端按钮本身不显示，面板常开）
    const toggle = $("#filterToggle"), toolbar = $(".toolbar");
    if (toggle && toolbar) toggle.addEventListener("click", () => {
      const open = toolbar.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $("#chapterSel").addEventListener("change", (e) => { filters.chapter = e.target.value; renderList(); });
    $("#typeChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      filters.type = b.dataset.type;
      $$("#typeChips .chip").forEach((c) => c.classList.toggle("active", c === b));
      renderList();
    });
    $("#statusChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      filters.status = b.dataset.status;
      $$("#statusChips .chip").forEach((c) => c.classList.toggle("active", c === b));
      renderList();
    });
    let t;
    $("#searchBox").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => { filters.search = e.target.value.trim(); renderList(); }, 200);
    });
    $("#shuffleBox").addEventListener("change", (e) => {
      shuffle = e.target.checked;
      if (shuffle) {
        if (!newShuffle()) { shuffle = false; e.target.checked = false; } // 筛选圈不出题：退回未勾选（toast 已提示）
      } else clearShuffle();
      $("#shuffleAgain").style.display = shuffle ? "" : "none";
      renderStats(); renderChapters(); renderList(); // 组卷清记录会即时影响统计
    });
    $("#shuffleAgain").addEventListener("click", () => { if (newShuffle()) { renderStats(); renderChapters(); renderList(); } }); // 池空则保留原卷
    $("#refBox").addEventListener("change", (e) => { showRef = e.target.checked; renderList(); });
    $("#resetBtn").addEventListener("click", () => {
      // 三步闸门：确认 → 输入随机码 → 最终确认，误触与手快都拦得住（随机码每次新生成）
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const cloudNote = window.SYNC ? "云端同步进度也会一并清除" : "此操作不可恢复";
      if (!confirm(`确定清空全部作答记录与得分？${cloudNote}`)) return;
      const typed = prompt(`【第 2 步 · 防误删验证】请输入随机码 ${code}`);
      if (typed == null) return;
      if (typed.replace(/\s/g, "") !== code) { toast("随机码不正确，已取消清空"); return; }
      if (!confirm("【第 3 步 · 最终确认】真的要删除全部作答记录、得分与历史留档？")) return;
      if (window.SYNC) SYNC.markCleared();
      store = {}; save();
      hist = {}; try { localStorage.removeItem(HKEY); } catch (e) {} // 历史留档随清空一并抹掉
      seen = {}; try { localStorage.removeItem(VKEY); } catch (e) {} // 出现标记同抹：全部题目回到「从未出现」最高档
      renderStats(); renderChapters(); renderList(); updateBulkBar();
      toast("已清空全部记录、得分与历史留档");
    });
    // 输入即存草稿（填空/简答），单选在点选项时已存
    $("#list").addEventListener("input", (e) => {
      if (e.target.matches("textarea.ans")) autoGrow(e.target); // 边写边长高
      const card = e.target.closest(".card");
      if (!card) return;
      const q = QBYID[+card.dataset.id];
      if (q && q.type !== "single") saveDraft(q, card);
    });
    // 批量提交：把所有“已作答未判分”的草稿一次性判分
    $("#bulkSubmit").addEventListener("click", () => {
      const ids = draftList();
      if (!ids.length) return;
      let sum = 0, full = 0;
      const essayJobs = [];
      ids.forEach((q) => {
        const u = store[q.id].u;
        const out = grade(q, u);
        store[q.id] = { u, s: out.s, ts: Date.now(), v: store[q.id] && store[q.id].v }; // 保留「看过解析」标记，判分不洗白
        sum += out.s;
        if (out.s === 100) full++;
        const card = $(`.card[data-id="${q.id}"]`);
        if (card) showResult(q, card, u, out);
        if (q.type === "essay") essayJobs.push({ q, u, out });
      });
      save();
      renderStats(); renderChapters(); updateBulkBar();
      toast(`本次批量提交 ${ids.length} 题：平均分 ${Math.round(sum / ids.length)}，满分 ${full} 题`);
      bulkUpgradeEssays(essayJobs); // 简答并发 AI 升级，不阻塞上面的即时反馈
    });
  }

  // ——— 科目身份落到页面：标题、顶栏文案、思维导图入口与组卷目标分（全部来自 meta） ———
  document.title = D.meta.pageTitle;
  const h1 = $(".topbar h1");
  if (h1) h1.textContent = D.meta.title;
  const ew = $("#examWhen");
  if (ew) ew.textContent = (D.meta.examMonth || "") + " 自考";
  const mm = $("#mmEntry");
  if (mm) {
    if (D.meta.mindmap.enabled) { mm.textContent = D.meta.mindmap.label; mm.style.display = ""; }
    else mm.remove();
  }
  const st = $("#shuffleTarget");
  if (st) st.textContent = TARGET;
  const again = $("#shuffleAgain");
  if (again) again.title = `按题型（简答>填空>单选）与掌握情况（未做/答错更易出现）加权，重新组一张约${TARGET}分的卷子`;
  $("#total").textContent = D.questions.length;
  // 组卷范围跟随筛选后，order 不再必为全题库——恢复卷面只校验 picked 题号有效
  if (shuf && (!Array.isArray(shuf.picked) || !Array.isArray(shuf.order) || !shuf.picked.every((id) => QBYID[id]))) clearShuffle();
  shuffle = !!(shuf && shuf.picked);
  $("#shuffleBox").checked = shuffle;
  $("#shuffleAgain").style.display = shuffle ? "" : "none";
  bindToolbar();
  bindRecite(); // 科目 flags.recite 开启时才注入顶栏入口（未开启自动移除）
  bindMemo();   // 科目 meta.memo 开启时才注入「考前重点记忆」入口（未开启自动移除）
  // ——— 账号：点顶栏云同步芯片开弹层（登录/注册/找回密码/退出/清除本机数据）———
  (function accountUI() {
    const chip = $("#syncChip"), dlg = $("#idDialog");
    if (!chip || !dlg || !isHttp) return; // file:// 无认证亦无芯片：账号功能不启用
    const q = (s) => dlg.querySelector(s);
    const raw = D.meta.storageKey;
    const params = new URLSearchParams(location.search);
    let resetToken = params.get("reset_token") || "";
    let mode = resetToken ? "new" : "login"; // login | register | reset | new
    const logged = () => !!(ID.account && ID.account());
    const verified = () => !!(AUTH && AUTH.current() && AUTH.current().email_verified);
    const showError = (sel, msg) => { const el = q(sel); el.textContent = msg || ""; el.hidden = !msg; };
    const setError = (msg) => showError("#idError", msg);
    const setResetError = (msg) => showError("#idResetError", msg);
    const setNewError = (msg) => showError("#idNewError", msg);
    const clearErrors = () => { setError(""); setResetError(""); setNewError(""); };

    function render() {
      const isLogged = logged();
      q("#idLoggedOut").hidden = isLogged;
      q("#idLoggedIn").hidden = !isLogged;
      q("#idTabs").hidden = mode === "reset" || mode === "new";
      q("#idForm").hidden = mode !== "login" && mode !== "register";
      q("#idResetForm").hidden = mode !== "reset";
      q("#idNewForm").hidden = mode !== "new";
      q("#idForgotRow").hidden = mode !== "login";
      q("#idResendRow").hidden = mode !== "login";
      q("#idConfirmRow").hidden = mode !== "register";
      q("#idPassword").autocomplete = mode === "register" ? "new-password" : "current-password";
      q("#idSubmit").textContent = mode === "register" ? "注册并登录" : "登录";
      q("#idTitle").textContent = isLogged ? "我的账号"
        : mode === "register" ? "注册账号"
          : mode === "reset" ? "找回密码"
            : mode === "new" ? "设置新密码"
              : "登录";
      q("#idDesc").textContent = isLogged
        ? "进度已绑定到账号；换设备用同一邮箱登录即可续用。"
        : mode === "reset" ? "输入注册邮箱，我们会发送重置链接（30 分钟内有效）。"
          : mode === "new" ? "设置新密码后，所有旧登录会立即失效。"
            : "登录后可云同步进度、使用 AI 判分；匿名也能浏览题库与本地判分。";
      if (isLogged) {
        q("#idWho").textContent = "已登录：" + (ID.accountEmail() || ID.account());
        q("#idVerifyRow").hidden = verified();
      }
      clearErrors();
    }

    async function onSubmit(e) {
      e.preventDefault();
      if (!AUTH) return;
      const email = q("#idEmail").value.trim();
      const password = q("#idPassword").value;
      if (mode === "register" && password !== q("#idConfirm").value) {
        setError("两次输入的密码不一致");
        return;
      }
      q("#idSubmit").disabled = true;
      setError("");
      q("#idResendRow").hidden = true;
      try {
        const data = mode === "register" ? await AUTH.register(email, password) : await AUTH.login(email, password);
        const u = data && data.user;
        if (!u || !ID.setAccount(u)) throw new Error("登录响应异常");
        // 首登：把本机匿名码分区 / 旧版裸键分区的用户数据搬进账号分区；刷新后启动流程按账号重新取 KEY
        if (ID.adoptLocal) ID.adoptLocal(raw);
        ID.clearCode();
        location.reload();
      } catch (err) {
        setError(err && err.message ? err.message : "操作失败，请稍后重试");
        if (err && err.code === "email_not_verified") q("#idResendRow").hidden = false;
      } finally {
        q("#idSubmit").disabled = false;
      }
    }

    async function onReset(e) {
      e.preventDefault();
      if (!AUTH) return;
      const email = q("#idResetEmail").value.trim();
      q("#idResetSubmit").disabled = true;
      setResetError("");
      try {
        await AUTH.requestReset(email);
        setResetError("如果该邮箱已注册，重置邮件已发送，请查收（30 分钟内有效）。");
      } catch (err) {
        setResetError(err && err.message ? err.message : "操作失败，请稍后重试");
      } finally {
        q("#idResetSubmit").disabled = false;
      }
    }

    async function onNewPassword(e) {
      e.preventDefault();
      if (!AUTH) return;
      const password = q("#idNewPassword").value;
      if (password !== q("#idNewPassword2").value) {
        setNewError("两次输入的密码不一致");
        return;
      }
      q("#idNewSubmit").disabled = true;
      setNewError("");
      try {
        await AUTH.resetPassword(resetToken, password);
        resetToken = "";
        mode = "login";
        history.replaceState({}, "", location.pathname);
        toast("密码已重置，请用新密码登录");
        render();
      } catch (err) {
        setNewError(err && err.message ? err.message : "操作失败，请稍后重试");
      } finally {
        q("#idNewSubmit").disabled = false;
      }
    }

    async function doLogout(clearLocal) {
      if (clearLocal && !confirm("退出并删除本机该账号的进度缓存？云端进度不受影响，下次登录会重新拉回。")) return;
      if (window.SYNC) { try { await SYNC.flushNow(); } catch (e) {} }
      if (AUTH) await AUTH.logout();
      ID.clearAccount();
      if (clearLocal && ID.clearPartition) ID.clearPartition(raw);
      if (window.SYNC) SYNC.disable();
      location.reload();
    }

    async function resendVerify(email, onMessage) {
      try {
        await AUTH.resendVerify(email);
        onMessage("如果该邮箱未验证，验证邮件已发送，请查收。");
      } catch (err) {
        onMessage(err && err.message ? err.message : "发送失败，请稍后重试");
      }
    }

    chip.classList.add("id-clickable");
    chip.title = "账号与云同步";
    chip.addEventListener("click", () => { render(); dlg.showModal(); });
    q("#idClose").addEventListener("click", () => dlg.close());
    q("#idClose2").addEventListener("click", () => dlg.close());
    q("#idResetBack").addEventListener("click", () => { mode = "login"; render(); });
    q("#idNewCancel").addEventListener("click", () => {
      resetToken = "";
      mode = "login";
      history.replaceState({}, "", location.pathname);
      render();
    });
    q("#idForgot").addEventListener("click", (e) => {
      e.preventDefault();
      q("#idResetEmail").value = q("#idEmail").value;
      mode = "reset";
      render();
    });
    dlg.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.tab;
      dlg.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
      render();
    }));
    q("#idForm").addEventListener("submit", onSubmit);
    q("#idResetForm").addEventListener("submit", onReset);
    q("#idNewForm").addEventListener("submit", onNewPassword);
    q("#idResendLogin").addEventListener("click", (e) => {
      e.preventDefault();
      resendVerify(q("#idEmail").value.trim(), setError);
    });
    q("#idResendVerify").addEventListener("click", (e) => {
      e.preventDefault();
      resendVerify(ID.accountEmail(), (msg) => toast(msg));
    });
    q("#idLogout").addEventListener("click", () => doLogout(false));
    q("#idLogoutClear").addEventListener("click", () => doLogout(true));

    // 邮件链接：?verify_token=... 自动验证；?reset_token=... 直接打开设置新密码
    const verifyToken = params.get("verify_token");
    if (verifyToken && AUTH) {
      AUTH.verifyEmail(verifyToken)
        .then(() => {
          const u = new URL(location.href);
          u.searchParams.delete("verify_token");
          history.replaceState({}, "", u.pathname + u.search);
          toast("邮箱验证成功");
          return AUTH.me();
        })
        .then(() => { if (logged()) location.reload(); })
        .catch((err) => toast("邮箱验证失败：" + (err && err.message ? err.message : "链接可能已过期")));
    }
    if (resetToken) { render(); dlg.showModal(); }

    if (window.SYNC) {
      SYNC.onAuthLost = () => {
        ID.clearAccount();
        if (AUTH) AUTH.expire();
        chip.textContent = "🔒 登录已过期 · 点此登录";
        toast("登录已过期，请重新登录");
      };
    }
    if (!logged() && !chip.textContent) chip.textContent = "🔑 登录";
  })();
  renderStats();
  renderChapters();
  renderList();
})();
