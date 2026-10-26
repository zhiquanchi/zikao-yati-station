// 前端主程序（纯视图）：题库、判分、进度、组卷、统计、背题、考点全部来自 API v1。
// 浏览器只负责渲染、交互、筛选与草稿（localStorage 仅存未提交作答与 UI 偏好）。
(function () {
  "use strict";
  const API = window.API;
  const MODEL = window.MODEL;
  if (!API || !MODEL) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TYPE_CN = { single: "单选", blank: "填空", essay: "简答" };
  const TYPE_RANK = { single: 0, blank: 1, essay: 2 };

  let D = null;            // 目录：{title, meta, chapters, questions, memo}
  let QBYID = {};
  let store = {};          // qid -> 服务端记录 {u,s,g,ts,v}
  let seenMap = {};
  let statsData = { done: 0, total: 0, avg: 0, good: 0, chapters: [] };
  let shuf = null;
  let user = null;
  let drafts = {};
  let filters = { chapter: "all", type: "all", status: "all", search: "" };
  let showRef = false;
  let shuffleOn = false;
  let aiOff = false;
  let prefix = API.prefix();
  const SCORE = { single: 1, blank: 2, essay: 5 };
  let TARGET = 100;

  // ——— 基础 ———
  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("show"), 3600);
  }
  function scoreCls(s) { return s >= 80 ? "good" : s >= 60 ? "mid" : "poor"; }
  function flash(card, msg) { const f = $(".flash", card); if (f) { f.textContent = msg; setTimeout(() => (f.textContent = ""), 2200); } }
  function autoGrow(ta) { if (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; } }
  function hasContent(u) {
    if (u == null) return false;
    if (typeof u === "string") return !!u.trim();
    if (Array.isArray(u)) return u.some((v) => (v || "").trim());
    return !!(u.whole || "").trim();
  }
  function essayTextOf(u) {
    if (!u) return "";
    if (typeof u === "string") return u;
    if (u.mode === "points") return (u.points || []).map((p) => (p || "").trim()).filter(Boolean).join("\n");
    return u.whole || "";
  }
  function aiEnabled() { return !aiOff && location.protocol !== "file:"; }

  // ——— 数据加载 ———
  async function loadSession() {
    try {
      user = (await API.me()).user;
      return;
    } catch (e) {
      if (e.status !== 401) throw e;
    }
    try { user = (await API.guest()).user; } catch (e) { user = null; }
  }
  function applyProgress(st) {
    store = st.records || {};
    seenMap = st.seen || {};
    shuf = st.paper || null;
    statsData = st.stats || statsData;
    shuffleOn = !!(shuf && Array.isArray(shuf.picked));
  }
  async function refreshProgress() {
    applyProgress(await API.progress());
    renderStats();
    renderChapters();
    renderList();
    updateBulkBar();
    renderSyncChip();
  }
  async function boot() {
    if (location.protocol === "file:") {
      document.body.innerHTML = '<div class="boot-error">请通过站点地址访问（在线使用）。判分与进度需要联网。</div>';
      return;
    }
    try {
      await loadSession();
    } catch (e) {
      document.body.innerHTML = '<div class="boot-error">服务暂时不可用，请稍后刷新重试。</div>';
      return;
    }
    if (MODEL.hasLegacy()) {
      try {
        const r = await MODEL.migrateLegacy();
        if (r && r.imported) toast(`已迁移本机旧进度 ${r.imported} 条`);
      } catch (e) { /* 迁移失败不阻塞使用 */ }
    }
    try {
      D = await API.catalog();
    } catch (e) {
      document.body.innerHTML = '<div class="boot-error">题库加载失败：' + esc(API.message(e.code)) + '</div>';
      return;
    }
    QBYID = Object.fromEntries(D.questions.map((q) => [q.id, q]));
    prefix = D.meta.prefix;
    API.setPrefix(prefix);
    Object.assign(SCORE, (D.meta.paper && D.meta.paper.scores) || {});
    TARGET = (D.meta.paper && D.meta.paper.target) || 100;
    drafts = MODEL.readDrafts(prefix);
    filters = Object.assign(filters, (MODEL.prefs().filters || {}));

    applyMeta();
    try {
      applyProgress(await API.progress());
    } catch (e) {
      toast("进度加载失败：" + API.message(e.code));
    }
    // 背题/记忆入口角标用服务端队列（失败不阻塞页面）
    if (reciteEnabled()) {
      try { recite.view = await API.recite(); } catch (e) {}
    }
    if (memoEnabled()) {
      try { memoView = await API.memo(); } catch (e) {}
    }
    renderStats();
    renderChapters();
    renderList();
    renderSyncChip();
    bindToolbar();
    bindRecite();
    bindMemo();
    bindAccount();
    applyQueryTokens();
  }

  function applyMeta() {
    document.title = D.meta.pageTitle;
    const h1 = $(".topbar h1"); if (h1) h1.textContent = D.meta.title;
    const ew = $("#examWhen"); if (ew) ew.textContent = (D.meta.examMonth || "") + " 自考";
    const mm = $("#mmEntry");
    if (mm) {
      if (D.meta.mindmap && D.meta.mindmap.enabled) {
        mm.textContent = D.meta.mindmap.label;
        mm.href = "/api/v1/subjects/" + encodeURIComponent(prefix) + "/mindmap";
        mm.style.display = "";
      } else mm.remove();
    }
    const st = $("#shuffleTarget"); if (st) st.textContent = TARGET;
    const again = $("#shuffleAgain");
    if (again) again.title = `按题型与掌握情况加权，重新组一张约 ${TARGET} 分的卷子`;
    const total = $("#total"); if (total) total.textContent = D.questions.length;
    $("#shuffleBox").checked = shuffleOn;
    $("#shuffleAgain").style.display = shuffleOn ? "" : "none";
  }

  // ——— 统计/章节 ———
  function renderStats() {
    const s = statsData;
    $("#stats").innerHTML =
      `<span class="stat">已练 <b>${s.done}</b>/${s.total}</span>` +
      `<span class="stat">平均分 <b>${s.avg}</b></span>` +
      `<span class="stat">60分以上 <b>${s.good}</b></span>` +
      `<span class="stat">未练 <b>${s.total - s.done}</b></span>`;
    let track = $(".progress-track");
    if (!track) {
      track = document.createElement("div");
      track.className = "progress-track";
      track.innerHTML = '<div class="progress-bar"></div>';
      $(".topbar .wrap").appendChild(track);
    }
    $(".progress-bar", track).style.width = (s.total ? (s.done / s.total * 100).toFixed(1) : 0) + "%";
    updateReciteEntry();
    updateMemoEntry();
  }
  function renderChapters() {
    const sel = $("#chapterSel");
    const opts = [`<option value="all">全部章节（${D.questions.length} 题）</option>`];
    (statsData.chapters || []).forEach((c) => {
      opts.push(`<option value="${esc(c.name)}">${esc(c.name)} · ${c.done}/${c.total}</option>`);
    });
    sel.innerHTML = opts.join("");
    sel.value = filters.chapter;
  }

  // ——— 筛选与列表 ———
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
  function paperActive() { return !!(shuffleOn && shuf && Array.isArray(shuf.picked)); }
  function visible() {
    let qs = D.questions.filter((q) => passFilters(q, !paperActive()));
    if (paperActive()) {
      const pos = new Map(shuf.picked.map((id, i) => [id, i]));
      qs = qs.filter((q) => pos.has(q.id)).sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || pos.get(a.id) - pos.get(b.id));
    }
    return qs;
  }

  function stemHTML(q) {
    if (q.type !== "blank") return esc(q.stem);
    const parts = q.stem.split(/_{2,}/);
    return parts.map((p, i) =>
      esc(p) + (i < parts.length - 1 ? `<input class="blank" data-bi="${i}" autocomplete="off" spellcheck="false">` : "")).join("");
  }
  function cardHTML(q, idx) {
    const rec = store[q.id];
    let body = "";
    if (q.type === "single") {
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
      ${q.type === "single" ? "" : `<div class="result"></div><div class="explain"></div>`}
    </section>`;
  }
  function inlineRef(q) {
    if (q.type === "single") return `<div class="inline-ref"><b>正确答案：${q.answer}</b></div>`;
    if (q.type === "essay") {
      return `<div class="inline-ref"><b>参考答案（得分点）</b><ol class="ex-list ref-list">` +
        (q.points || []).map((p, i) => `<li>${rich(pointTexts(q, i, p), q)}</li>`).join("") + `</ol></div>`;
    }
    return `<div class="inline-ref"><b>参考答案</b>：${esc(q.ref)}</div>`;
  }

  function renderList() {
    const qs = visible();
    const list = $("#list");
    list.innerHTML = qs.length ? qs.map((q, i) => cardHTML(q, i + 1)).join("") : `<div class="empty">没有符合条件的题目</div>`;
    qs.forEach((q) => {
      const card = $(`.card[data-id="${q.id}"]`, list);
      if (!card) return;
      if (q.type === "essay") mountEssayForm(card, q);
      bindCard(q, card);
      restoreInputs(q, card);
      const rec = store[q.id];
      if (rec && rec.s != null) restoreResult(q, card);
    });
    observeSeen();
    updatePaperInfo();
  }
  function mountEssayForm(card, q) {
    const val = essayTextOf((store[q.id] && store[q.id].u) || drafts[q.id]);
    $(".essay-form", card).innerHTML = `<textarea class="ans" rows="1" spellcheck="false">${esc(val)}</textarea>
      <div class="hint-line">按要点写出答案，系统对照 ${(q.points || []).length} 个得分点自动打分。</div>`;
    autoGrow($("textarea.ans", card));
  }
  function restoreInputs(q, card) {
    const rec = store[q.id];
    const u = rec && rec.u != null ? rec.u : drafts[q.id];
    if (u == null) return;
    if (q.type === "blank" && Array.isArray(u)) {
      $$(".stem input.blank", card).forEach((inp, i) => (inp.value = u[i] || ""));
    } else if (q.type === "single" && typeof u === "string") {
      const el = $(`.opt[data-key="${u}"]`, card);
      if (el) el.classList.add("picked");
    }
  }

  // ——— 出现标记 ———
  let seenObs = null, seenQueue = [], seenTimer = null;
  function queueSeen(id) {
    if (seenMap[id]) return;
    seenMap[id] = Date.now();
    if (!seenQueue.includes(id)) seenQueue.push(id);
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => {
      const batch = seenQueue.slice();
      seenQueue = [];
      API.seen(batch).catch(() => {});
    }, 800);
  }
  function observeSeen() {
    if (typeof IntersectionObserver === "undefined" || showRef) return;
    if (!seenObs) {
      seenObs = new IntersectionObserver((entries) => {
        if (showRef) return;
        for (const e of entries) if (e.isIntersecting) queueSeen(+e.target.dataset.id);
      }, { threshold: 0 });
    }
    seenObs.disconnect();
    $$(".card[data-id]", $("#list")).forEach((c) => seenObs.observe(c));
  }

  // ——— 解析渲染（纯展示） ———
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
      if ((before.match(/<b>/g) || []).length === (before.match(/<\/b>/g) || []).length) return html.slice(0, m) + `<b>${t}</b>` + html.slice(m + t.length);
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
  function explainHTML(q, opts) {
    opts = opts || {};
    const text = q.explain || q.ref || "";
    let body = text, header = null;
    const m = text.match(/^考点\s*([^：:]{1,48}?)\s*[：:]\s*/);
    if (m) { header = m[1]; body = text.slice(m[0].length); }
    let html = "";
    if (header) html += `<div class="ex-tag">📍 考点 ${esc(header)}</div>`;
    if (q.type === "blank" && !opts.noAns) {
      html += `<div class="ex-ans">应填：${(q.blanks || []).map((v) => `<b>${esc(v[0])}</b>`).join("、")}${q.unordered ? ' <span class="pi-tip">（并列各空，顺序可互换）</span>' : ""}</div>`;
    }
    const items = splitItems(body);
    html += `<ul class="ex-list">` + items.map((it) => {
      const cleaned = it.replace(/^（\d+）|^\(\d+\)|^\d+、/, "").trim();
      return `<li>${rich(cleaned, q)}</li>`;
    }).join("") + `</ul>`;
    if (q.type === "essay" && q.points && q.points.length && !opts.noPts) {
      html += `<div class="ex-pts"><h5>✅ 得分点（${q.points.length} 条）</h5><ol>` +
        q.points.map((p, i) => `<li>${rich(pointTexts(q, i, p), q)}</li>`).join("") + `</ol></div>`;
    }
    if (q.type === "single" && !opts.noAI && aiEnabled() && D.meta.flags && D.meta.flags.explain) {
      html += `<div class="optexpl"><button class="secondary optexpl-btn" type="button">🤖 逐项解析</button><div class="optexpl-body"></div></div>`;
    }
    return html;
  }
  function refBlock(q) {
    if (q.type === "single") return `<div class="ref-block"><h4>答案</h4><p>正确答案：<b>${q.answer}</b></p></div>`;
    if (q.type === "essay") return "";
    return `<div class="ref-block"><h4>参考答案</h4><p>${esc(q.ref)}</p></div>`;
  }

  // ——— 结果区 ———
  function showResult(q, card, input, out) {
    const s = out.s;
    if (q.type === "single") {
      $$(".opt .opt-ans", card).forEach((b) => b.remove());
      $$(".opt", card).forEach((el) => {
        el.classList.remove("dim", "right", "wrong", "picked");
        el.classList.add("dim");
        if (el.dataset.key === q.answer) { el.classList.remove("dim"); el.classList.add("right"); el.insertAdjacentHTML("beforeend", '<span class="opt-ans ok">✓ 正确答案</span>'); }
        else if (el.dataset.key === input) { el.classList.remove("dim"); el.classList.add("wrong"); el.insertAdjacentHTML("beforeend", '<span class="opt-ans no">你的选择 ✗</span>'); }
      });
      armResultUI(q, card, out);
      return;
    }
    if (q.type === "blank") {
      const per = out.per || [];
      $$(".stem input.blank", card).forEach((el, i) => {
        el.classList.remove("right", "wrong");
        el.classList.add(per[i] && per[i].ok ? "right" : "wrong");
      });
      const report = per.map((p, i) =>
        `<div class="blank-report">${i + 1}. ${p.ok ? '<span class="b-ok">✓ ' + esc(p.input) + "</span>" : `<span class="b-no">✗ 你填：${esc(p.input || "（空）")}</span> → 应填 <code>${esc(p.expect)}</code>`}</div>`).join("");
      $(".result", card).innerHTML = `<div class="verdict"><span class="score-big ${scoreCls(s)}">${s}</span>
        <span class="tag ${scoreCls(s)}">${s === 100 ? "全部填对" : `答对 ${per.filter((p) => p.ok).length}/${per.length}`}</span></div>${report}${refBlock(q)}`;
    } else {
      const per = out.per || [];
      const pts = per.map((p, pi) => {
        const cn = { hit: "命中要点", part: "部分命中", miss: "未答到" }[p.state];
        const bar = `<div class="cov-track" style="color:${p.state === "hit" ? "var(--ok)" : p.state === "part" ? "var(--warn)" : "var(--bad)"}"><div class="cov-bar" style="width:${Math.round(p.cov * 100)}%"></div></div>`;
        const frags = p.segs && p.segs.length ? `<div class="frags">答到片段：${p.segs.slice(0, 6).map((sg) => `<span>${esc(sg)}</span>`).join("")}</div>` : "";
        const cmt = p.comment ? `<div class="per-comment">🤖 ${esc(p.comment)}</div>` : "";
        return `<div class="point ${p.state}"><div class="p-head"><span class="p-state">${cn} ${Math.round(p.cov * 100)}%</span>${bar}</div><div>${rich(pointTexts(q, pi, p.text), q)}</div>${frags}${cmt}</div>`;
      }).join("");
      const label = s >= 85 ? "掌握良好" : s >= 60 ? "基本及格，漏掉部分要点" : "还需加强背诵";
      const badge = out.engine === "ai" ? '<span class="ai-badge ai">🤖 AI 判分</span>'
        : out.unavailable ? `<span class="ai-badge local" title="AI 不可用：${esc(out.unavailable)}">本机估分</span>` : "";
      const reply = out.summary ? `<details class="ai-reply"${out.fresh ? " open" : ""}><summary>🤖 AI 完整回复</summary><div class="ai-reply-body">${esc(out.summary)}</div></details>` : "";
      $(".result", card).innerHTML = `<div class="verdict"><span class="score-big ${scoreCls(s)}">${s}</span><span class="tag ${scoreCls(s)}">${label}</span>${badge}</div><div class="point-list">${pts}</div>${reply}${refBlock(q)}`;
    }
    $(".result", card).classList.add("show");
    armResultUI(q, card, out);
  }
  function armResultUI(q, card, out) {
    const btn = $(".grade-btn", card);
    btn.textContent = "重新评分";
    if (!$(".redo-btn", card)) {
      btn.insertAdjacentHTML("beforebegin", '<button class="secondary redo-btn">重做此题</button>');
      $(".redo-btn", card).addEventListener("click", async () => {
        try { await API.redo(q.id); } catch (e) { toast(API.message(e.code)); return; }
        delete store[q.id];
        MODEL.setDraft(prefix, q.id, null);
        delete drafts[q.id];
        await refreshProgress();
        document.querySelector(`.card[data-id="${q.id}"]`)?.scrollIntoView({ block: "center" });
      });
    }
    if (out.practice) {
      if (!$(".practice-tag", card)) btn.insertAdjacentHTML("afterend", '<span class="practice-tag">练习分 · 不计入掌握</span>');
    } else {
      updateScoreChip(card, out.s);
    }
    if (out.s < 100 && q.type !== "essay" && card.__setExplain) card.__setExplain(true);
  }
  function updateScoreChip(card, s) {
    $(".score-chip-slot", card).innerHTML = `<span class="score-chip ${scoreCls(s)}">${s} 分</span>`;
  }
  function restoreResult(q, card) {
    const rec = store[q.id];
    if (!rec) return;
    if (q.type === "single") {
      showResult(q, card, rec.u, { s: rec.s, per: null, engine: (rec.g && rec.g.engine) || "local", practice: false });
      return;
    }
    const g = rec.g || {};
    const out = {
      s: rec.s, per: g.per || [], engine: g.engine || "local", summary: g.summary || "",
      practice: false,
    };
    if (!out.per.length && q.type === "essay") {
      // 旧记录没有判分明细：只展示分数与解析，不重算
      $(".result", card).innerHTML = `<div class="verdict"><span class="score-big ${scoreCls(rec.s)}">${rec.s}</span>
        <span class="tag ${scoreCls(rec.s)}">已判分</span></div>${refBlock(q)}`;
      $(".result", card).classList.add("show");
      armResultUI(q, card, out);
      return;
    }
    showResult(q, card, rec.u, out);
  }

  // ——— 提交 ———
  function collect(q, card) {
    if (q.type === "single") {
      const picked = $(".opt.picked", card);
      return picked ? picked.dataset.key : null;
    }
    if (q.type === "blank") return $$(".stem input.blank", card).map((i) => i.value.trim());
    const whole = $("textarea.ans", card).value.trim();
    return whole ? { mode: "whole", whole } : null;
  }
  function setBusy(card, busy) {
    const btn = $(".grade-btn", card);
    if (!btn) return;
    btn.disabled = busy;
    if (busy) btn.dataset.label = btn.textContent, (btn.textContent = "判分中…");
    else if (btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
  }

  async function submitCard(q, card, mode) {
    const input = collect(q, card);
    if (input == null) return flash(card, q.type === "single" ? "请先选择一个选项" : "请先写出你的答案");
    if (q.type === "blank" && input.every((v) => !v)) return flash(card, "请先填写答案");
    setBusy(card, true);
    try {
      const res = await API.answer({ qid: q.id, u: input, mode: mode || "submit" });
      if (res.record) {
        const rec = JSON.parse(JSON.stringify(res.record));
        store[q.id] = rec;
        MODEL.setDraft(prefix, q.id, null);
        delete drafts[q.id];
      }
      showResult(q, card, input, {
        s: res.score, per: res.per || [], engine: res.engine, practice: !!res.practice,
        summary: (res.record && res.record.g && res.record.g.summary) || "",
      });
      if (res.first) {
        await refreshProgress();
        if (q.type === "essay" && res.ai_available && aiEnabled()) {
          upgradeEssay(q, input, true);
        }
      }
    } catch (e) {
      if (e.code === "svc_down" || e.code === "no_key" || e.code === "bad_key") aiOff = true;
      toast("提交失败：" + API.message(e.code));
    } finally {
      setBusy(card, false);
    }
  }

  async function upgradeEssay(q, input, first) {
    const card = document.querySelector(`.card[data-id="${q.id}"]`);
    if (card) {
      const tag = $(".verdict .tag", card);
      if (tag && !$(".ai-pending", card)) tag.insertAdjacentHTML("afterend", '<span class="ai-pending">🤖 AI 判分中…</span>');
    }
    try {
      const res = await API.answer({ qid: q.id, u: input, mode: "ai" });
      if (res.record) store[q.id] = JSON.parse(JSON.stringify(res.record));
      const card2 = document.querySelector(`.card[data-id="${q.id}"]`);
      if (card2 && JSON.stringify(collect(q, card2)) === JSON.stringify(input)) {
        showResult(q, card2, input, {
          s: res.score, per: res.per || [], engine: "ai", summary: (res.record && res.record.g && res.record.g.summary) || "", fresh: true,
        });
        if (first) renderStats();
      }
    } catch (e) {
      if (e.code === "svc_down" || e.code === "no_key" || e.code === "bad_key") aiOff = true;
      const card3 = document.querySelector(`.card[data-id="${q.id}"]`);
      if (card3) {
        const pend = $(".ai-pending", card3); if (pend) pend.remove();
        const tag = $(".verdict .tag", card3);
        if (tag && !$(".ai-badge", tag.parentNode)) tag.insertAdjacentHTML("afterend", `<span class="ai-badge local" title="AI 不可用：${esc(API.message(e.code))}">本机估分</span>`);
      }
    }
  }

  // ——— 单选逐项解析 ———
  function thinkPanelHTML(think, live) {
    return `<div class="oe-think${live ? "" : " collapsed"}"><button class="oe-think-head" type="button"><span>${live ? "🧠 思考中…" : "🧠 思考过程"}</span><span class="oe-caret">▾</span></button><div class="oe-think-body">${live ? "" : esc(think)}</div></div>`;
  }
  function renderOptExpl(body, data) {
    const chip = data.source === "material" ? '<span class="oe-src ref">📖 依据考点串讲资料</span>' : '<span class="oe-src search">🔍 联网搜索补充</span>';
    delete body.dataset.live;
    const think = body.__think || "";
    body.innerHTML = `<div class="oe-head">逐项解析 ${chip}</div>` + (think ? thinkPanelHTML(think, false) : "") +
      (data.items || []).map((it) => `<div class="oe-row ${it.correct ? "ok" : "no"}"><span class="oe-key">${esc(it.key)}</span><span class="oe-tag">${it.correct ? "✓ 本题答案" : "✗ 非本题答案"}</span><span class="oe-why">${esc(it.why)}</span></div>`).join("");
    body.classList.add("show");
  }
  function startExplLive(body, head) {
    body.dataset.live = "1";
    body.__think = "";
    body.innerHTML = `<div class="oe-head">${head || "🤖 逐项解析生成中…"}</div>`;
    body.classList.add("show");
  }
  function explLiveDelta(body, key, text) {
    if (!body.dataset.live) startExplLive(body);
    if (!text) return;
    let row = key ? $(`.oe-row[data-k="${key}"]`, body) : null;
    if (!row) {
      row = document.createElement("div");
      row.className = "oe-row";
      if (key) { row.dataset.k = key; row.innerHTML = `<span class="oe-key">${esc(key)}</span>`; }
      row.insertAdjacentHTML("beforeend", '<span class="oe-why"></span>');
      body.appendChild(row);
    }
    $(".oe-why", row).textContent += text;
  }
  function oeErrRow(msg) { return `<div class="oe-err"><span>⚠ ${esc(msg)}</span><button class="secondary oe-retry" type="button">重试</button></div>`; }
  function renderExplError(body, msg) { delete body.dataset.live; body.classList.add("show"); body.innerHTML = `<div class="oe-head">🤖 逐项解析失败</div>` + oeErrRow(msg); }
  function wireOptExpl(q, btn, body) {
    let cached = null;
    body.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(".oe-think-head")) { t.closest(".oe-think").classList.toggle("collapsed"); return; }
      if (t.closest(".oe-retry")) run();
    });
    async function run() {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "🤖 逐项解析生成中…";
      startExplLive(body);
      try {
        const data = await API.explain(q.id, (ev, p) => {
          if (ev === "delta") explLiveDelta(body, p.key, p.text);
          else if (ev === "reset") startExplLive(body, "🤖 正在联网补充…");
        });
        cached = data;
        renderOptExpl(body, data);
        btn.textContent = "🤖 重新逐项解析";
      } catch (e) {
        if (e.code === "svc_down" || e.code === "no_key" || e.code === "bad_key") aiOff = true;
        const msg = API.message(e.code);
        if (cached && cached.items) { renderOptExpl(body, cached); body.insertAdjacentHTML("beforeend", oeErrRow(msg)); }
        else renderExplError(body, msg);
        btn.textContent = "🤖 逐项解析";
        toast("逐项解析失败：" + msg);
      } finally { btn.disabled = false; }
    }
    btn.addEventListener("click", run);
  }

  // ——— 卡片交互 ———
  function bindCard(q, card) {
    const exBtn = $(".explain-btn", card), exPanel = $(".explain", card);
    function setExplain(open) {
      exPanel.innerHTML = open ? explainHTML(q) : "";
      exPanel.classList.toggle("show", open);
      exBtn.classList.toggle("active", open);
      exBtn.textContent = open ? "收起解析" : "解析";
      if (open) {
        markViewed(q);
        if (q.type === "single" && !(store[q.id] && store[q.id].s != null)) {
          const el = $(`.opt[data-key="${q.answer}"]`, card);
          if (el && !el.querySelector(".opt-ans")) el.insertAdjacentHTML("beforeend", '<span class="opt-ans ok">✓ 正确答案</span>');
        }
        const ob = $(".optexpl-btn", exPanel);
        if (ob) wireOptExpl(q, ob, $(".optexpl-body", exPanel));
      }
    }
    card.__setExplain = setExplain;
    exBtn.addEventListener("click", () => setExplain(!exPanel.classList.contains("show")));
    if (q.type === "single") {
      $$(".opt", card).forEach((el) => el.addEventListener("click", () => {
        if ($(".redo-btn", card)) return;
        $$(".opt", card).forEach((o) => o.classList.remove("picked"));
        el.classList.add("picked");
        saveDraft(q, card);
      }));
    }
    $(".grade-btn", card).addEventListener("click", () => {
      const first = !(store[q.id] && store[q.id].s != null);
      submitCard(q, card, first ? "submit" : "preview");
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $(".grade-btn", card).click(); }
    });
  }
  function saveDraft(q, card) {
    if (store[q.id] && store[q.id].s != null) return;
    const u = collect(q, card);
    if (!hasContent(u)) { MODEL.setDraft(prefix, q.id, null); delete drafts[q.id]; }
    else { MODEL.setDraft(prefix, q.id, u); drafts[q.id] = u; }
    updateBulkBar();
  }
  function markViewed(q) {
    if (store[q.id] && (store[q.id].s != null || store[q.id].v)) return;
    queueSeen(q.id);
    const rec = store[q.id] || { u: null, s: null, ts: Date.now() };
    rec.v = Date.now();
    store[q.id] = rec;
    API.viewed(q.id).catch(() => {});
  }

  // ——— 组卷 ———
  async function newShuffle() {
    try {
      const paper = await API.paper({
        chapter: filters.chapter, type: filters.type, status: filters.status, search: filters.search,
      });
      shuf = paper;
      shuffleOn = true;
      await refreshProgress();
      return true;
    } catch (e) {
      toast(API.message(e.code));
      return false;
    }
  }
  async function clearShuffle() {
    try { await API.clearPaper(); } catch (e) { toast(API.message(e.code)); }
    shuf = null;
    shuffleOn = false;
  }
  function updatePaperInfo() {
    const el = $("#paperInfo");
    if (!el) return;
    if (!paperActive()) { el.style.display = "none"; return; }
    const cnt = { single: 0, blank: 0, essay: 0 };
    shuf.picked.forEach((id) => { if (QBYID[id]) cnt[QBYID[id].type]++; });
    const inFilter = filters.chapter !== "all" || filters.type !== "all" || filters.status !== "all" || filters.search;
    el.style.display = "block";
    el.innerHTML = `📋 随机组卷 <b>${shuf.picked.length}</b> 题 · 总分 <b>${shuf.total}</b> 分` +
      (inFilter ? "（组卷范围：当前筛选）" : "") +
      `（单选 ${cnt.single}×${SCORE.single} ＋ 填空 ${cnt.blank}×${SCORE.blank} ＋ 简答 ${cnt.essay}×${SCORE.essay}）` +
      `<span class="pi-tip">加权抽题与重置作答均在服务端完成；点「🎲 换一批」按最新掌握情况重新组卷。</span>`;
  }

  // ——— 批量提交 ———
  function draftList() {
    return D.questions.filter((q) => {
      const rec = store[q.id];
      if (rec && rec.s != null) return false;
      return hasContent(drafts[q.id]);
    });
  }
  function updateBulkBar() {
    const bar = $("#bulkBar");
    if (!bar) return;
    const n = draftList().length;
    bar.style.display = n ? "flex" : "none";
    const c = $("#bulkCount"); if (c) c.textContent = `已作答未提交 ${n} 题`;
  }
  async function bulkSubmit() {
    const qs = draftList();
    if (!qs.length) return;
    let sum = 0, n = 0;
    for (const q of qs) {
      try {
        const u = drafts[q.id];
        const res = await API.answer({ qid: q.id, u, mode: "submit" });
        if (res.record) store[q.id] = JSON.parse(JSON.stringify(res.record));
        MODEL.setDraft(prefix, q.id, null); delete drafts[q.id];
        sum += res.score; n++;
        const card = document.querySelector(`.card[data-id="${q.id}"]`);
        if (card) showResult(q, card, u, { s: res.score, per: res.per || [], engine: res.engine, practice: !!res.practice });
        if (q.type === "essay" && res.first && res.ai_available && aiEnabled()) upgradeEssay(q, u, true);
      } catch (e) { toast(`#${q.id} 提交失败：` + API.message(e.code)); }
    }
    await refreshProgress();
    toast(`本次提交 ${n} 题，平均分 ${n ? Math.round(sum / n) : 0}`);
  }

  // ——— 工具栏 ———
  function bindToolbar() {
    const toggle = $("#filterToggle"), toolbar = $(".toolbar");
    if (toggle && toolbar) toggle.addEventListener("click", () => {
      const open = toolbar.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    const persist = () => MODEL.savePrefs({ filters });
    $("#chapterSel").addEventListener("change", (e) => { filters.chapter = e.target.value; persist(); renderList(); });
    $("#typeChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      filters.type = b.dataset.type; persist();
      $$("#typeChips .chip").forEach((c) => c.classList.toggle("active", c === b));
      renderList();
    });
    $("#statusChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      filters.status = b.dataset.status; persist();
      $$("#statusChips .chip").forEach((c) => c.classList.toggle("active", c === b));
      renderList();
    });
    let t;
    $("#searchBox").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => { filters.search = e.target.value.trim(); persist(); renderList(); }, 200);
    });
    $("#shuffleBox").addEventListener("change", async (e) => {
      if (e.target.checked) {
        const ok = await newShuffle();
        if (!ok) { e.target.checked = false; shuffleOn = false; }
      } else {
        await clearShuffle();
        await refreshProgress();
      }
      $("#shuffleAgain").style.display = shuffleOn ? "" : "none";
    });
    $("#shuffleAgain").addEventListener("click", async () => { if (await newShuffle()) renderList(); });
    $("#refBox").addEventListener("change", (e) => { showRef = e.target.checked; renderList(); });
    $("#resetBtn").addEventListener("click", async () => {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (!confirm("确定清空全部作答记录与得分？云端进度也会一并清除。")) return;
      const typed = prompt(`【第 2 步 · 防误删验证】请输入随机码 ${code}`);
      if (typed == null) return;
      if (typed.replace(/\s/g, "") !== code) { toast("随机码不正确，已取消清空"); return; }
      if (!confirm("【第 3 步 · 最终确认】真的要删除全部作答记录、得分与历史留档？")) return;
      try { await API.clearProgress(); } catch (e) { toast("清空失败：" + API.message(e.code)); return; }
      store = {}; shuf = null; seenMap = {}; drafts = {}; MODEL.clearDrafts(prefix);
      await refreshProgress();
      toast("已清空全部记录、得分与历史留档");
    });
    $("#list").addEventListener("input", (e) => {
      if (e.target.matches("textarea.ans")) autoGrow(e.target);
      const card = e.target.closest(".card");
      if (!card) return;
      const q = QBYID[+card.dataset.id];
      if (q && q.type !== "single") saveDraft(q, card);
    });
    $("#bulkSubmit").addEventListener("click", bulkSubmit);
  }

  // ——— 重点优先背（服务端队列） ———
  const recite = { view: null, list: [], idx: 0, group: "all", type: "all", mode: "back", result: null, oldScore: null, folded: false, foldTouched: false };
  const GROUP_CN = { wrong: "答错", mid: "待提高", todo: "未作答" };
  function reciteEnabled() { return !!(D.meta.flags && D.meta.flags.recite); }
  function reciteNarrow() { return typeof matchMedia === "function" && matchMedia("(max-width: 900px)").matches; }
  function reciteFilter() {
    const all = (recite.view && recite.view.items) || [];
    return all.filter((e) => (recite.group === "all" || e.group === recite.group) && (recite.type === "all" || e.type === recite.type));
  }
  function reciteUpdateFold() {
    const shell = $(".recite-shell"); if (shell) shell.classList.toggle("folded", !!recite.folded);
    const btn = $("#reciteFold");
    if (btn) { btn.textContent = recite.folded ? "▸ 显示筛选" : "▾ 隐藏筛选"; btn.setAttribute("aria-expanded", recite.folded ? "false" : "true"); }
    const sub = $("#reciteSub");
    if (sub) {
      const c = (recite.view && recite.view.counts) || { total: 0, wrong: 0, mid: 0, todo: 0 };
      sub.textContent = recite.folded
        ? `未掌握 ${c.total} · ❌ ${c.wrong} · ⚠️ ${c.mid} · ⬜ ${c.todo}`
        : `${D.meta.name} · 按答题记录找出未掌握题，薄弱优先`;
    }
  }
  function updateReciteEntry() {
    const btn = $("#reciteEntry");
    if (!reciteEnabled()) { if (btn) btn.remove(); return; }
    if (!btn) return;
    const n = recite.view
      ? recite.view.counts.total
      : store && Object.keys(store).length
        ? Object.values(store).filter((r) => r && r.s != null && r.s < 80).length + D.questions.filter((q) => !store[q.id] || store[q.id].s == null).length
        : D.questions.length;
    $("#reciteCount").textContent = n;
    btn.style.display = "";
    btn.classList.toggle("zero", n === 0);
  }
  async function reciteOpen() {
    try { recite.view = await API.recite(); } catch (e) { toast(API.message(e.code)); return; }
    recite.mode = "back"; recite.result = null; recite.idx = 0; recite.group = "all"; recite.type = "all";
    if (!recite.foldTouched) recite.folded = reciteNarrow();
    reciteApply();
    const dlg = $("#reciteDialog");
    if (dlg && !dlg.open) dlg.showModal();
  }
  function reciteApply() {
    recite.list = reciteFilter();
    if (recite.idx >= recite.list.length) recite.idx = Math.max(0, recite.list.length - 1);
    reciteRenderFilters(); reciteRenderQueue(); reciteRenderCard(); reciteRenderNav();
  }
  function reciteRenderFilters() {
    const c = (recite.view && recite.view.counts) || { total: 0, wrong: 0, mid: 0, todo: 0, single: 0, blank: 0, essay: 0 };
    const groups = [["all", "全部未掌握", c.total], ["wrong", "❌ 答错", c.wrong], ["mid", "⚠️ 待提高 60~79", c.mid], ["todo", "⬜ 未作答", c.todo]];
    $("#reciteGroupChips").innerHTML = groups.map(([g, label, n]) => `<button type="button" class="chip${recite.group === g ? " active" : ""}" data-group="${g}">${label} ${n}</button>`).join("");
    const inGroup = (recite.view && recite.view.items || []).filter((e) => recite.group === "all" || e.group === recite.group);
    const byGroup = { total: inGroup.length, single: 0, blank: 0, essay: 0 };
    inGroup.forEach((e) => { if (byGroup[e.type] != null) byGroup[e.type]++; });
    const types = [["all", "全部题型", byGroup.total], ["single", "单选", byGroup.single], ["blank", "填空", byGroup.blank], ["essay", "简答", byGroup.essay]];
    $("#reciteTypeChips").innerHTML = types.map(([t, label, n]) => `<button type="button" class="chip${recite.type === t ? " active" : ""}" data-type="${t}">${label} ${n}</button>`).join("");
    const total = D.questions.length;
    $("#reciteSummary").innerHTML = c.total
      ? `<span class="rs-item">未掌握 <b>${c.total}</b> / ${total}</span><span class="rs-item wrong">答错 <b>${c.wrong}</b></span><span class="rs-item mid">待提高 <b>${c.mid}</b></span><span class="rs-item todo">未作答 <b>${c.todo}</b></span><span class="rs-tip">排序由服务端按「答错 → 待提高 → 未作答；同档简答/填空优先」给出。</span>`
      : `<span class="rs-ok">🎉 全部 ${total} 题已掌握（≥80 分）。</span>`;
    reciteUpdateFold();
  }
  function reciteRenderQueue() {
    const box = $("#reciteQueue");
    $("#reciteQueueCount").textContent = `${recite.list.length} 题`;
    if (!recite.list.length) { box.innerHTML = `<li class="recite-q-empty">当前筛选下没有题目</li>`; return; }
    box.innerHTML = recite.list.map((it, i) => {
      const q = QBYID[it.id];
      return `<li class="recite-q-item${i === recite.idx ? " active" : ""}" data-i="${i}"><span class="rq-no">${i + 1}</span><span class="rq-stem">${esc(q.stem)}</span><span class="rq-tag ${it.group}">${it.score != null ? it.score + "分" : "未答"}</span></li>`;
    }).join("");
    const active = $(".recite-q-item.active", box);
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }
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
  function recitePracticeForm(q, draftRec) {
    let body = "";
    if (q.type === "single") {
      const picked = draftRec && typeof draftRec.u === "string" ? draftRec.u : null;
      body = `<div class="stem">${esc(q.stem)}</div><div class="opts">` + (q.options || []).map((o) =>
        `<div class="opt${o.key === picked ? " picked" : ""}" data-key="${o.key}"><span class="key">${o.key}</span><span>${esc(o.text)}</span></div>`).join("") + `</div>`;
    } else if (q.type === "blank") {
      body = `<div class="stem">${stemHTML(q)}</div>`;
    } else {
      body = `<div class="stem">${esc(q.stem)}</div><textarea class="ans" rows="1" spellcheck="false">${esc(essayTextOf(draftRec && draftRec.u))}</textarea>
        <div class="hint-line">按要点写出答案，系统对照 ${(q.points || []).length} 个得分点自动打分。</div>`;
    }
    return `<article class="rcard recite-practice" data-id="${q.id}">
      <div class="rcard-head"><span class="qno">第 ${recite.idx + 1} 题 · 原题 #${q.id}</span><span class="badge ${q.type}">${TYPE_CN[q.type]}</span><span class="chap">${esc(q.chapter)}</span><span class="rcard-tag practice">练习中</span></div>
      ${body}
      <div class="rcard-actions"><button type="button" class="primary" id="reciteSubmit">提交评分</button><button type="button" class="secondary" id="reciteCancel">取消</button><span class="rcard-tip">提交后计入掌握，≥80 分即移出本队列。</span></div>
    </article>`;
  }
  function reciteRenderCard() {
    const box = $("#reciteCard");
    if (recite.mode === "practice") {
      if (recite.result) { reciteRenderResult(QBYID[recite.result.id], recite.result); return; }
      if (recite.list.length) {
        const it = recite.list[recite.idx], q = QBYID[it.id];
        box.innerHTML = recitePracticeForm(q, recite.oldScore != null ? null : (store[it.id] || drafts[it.id]));
        if (q.type === "essay") { const ta = $("textarea.ans", box); autoGrow(ta); if (ta) ta.focus(); }
        else if (q.type === "blank") { const inp = $(".stem input.blank", box); if (inp) inp.focus(); }
        return;
      }
      recite.mode = "back";
    }
    if (!recite.list.length) {
      box.innerHTML = `<div class="recite-empty">🎉 当前筛选下没有未掌握题。</div>`;
      return;
    }
    const it = recite.list[recite.idx], q = QBYID[it.id];
    const rec = store[it.id];
    const graded = !!(rec && rec.s != null);
    const tags = [`<span class="rcard-tag ${it.group}">${GROUP_CN[it.group]}${it.score != null ? " · " + it.score + " 分" : ""}</span>`];
    if (it.viewed) tags.push('<span class="rcard-v">👀 看过解析</span>');
    let body = "";
    if (q.type === "single") {
      body = `<div class="stem">${esc(q.stem)}</div><div class="opts recite-opts">` + (q.options || []).map((o) =>
        `<div class="opt${o.key === q.answer ? " right" : ""}"><span class="key">${o.key}</span><span>${esc(o.text)}</span>${o.key === q.answer ? '<span class="opt-ans ok">✓ 正确答案</span>' : ""}</div>`).join("") + `</div>
        <div class="rcard-ans">✅ 正确答案：<b>${esc(q.answer)}</b></div>`;
      if (q.explain || q.ref) body += `<div class="explain show">${explainHTML(q, { noAI: true })}</div>`;
    } else if (q.type === "blank") {
      body = `<div class="stem">${reciteBlankStem(q)}</div><div class="rcard-ans">✅ 应填：${(q.blanks || []).map((v) => `<b>${esc((v && v[0]) || "")}</b>`).join("、")}${q.unordered ? ' <span class="pi-tip">（并列各空，顺序可互换）</span>' : ""}</div>`;
      if (q.explain) body += `<div class="explain show">${explainHTML(q, { noAI: true, noAns: true })}</div>`;
    } else {
      const pts = q.points || [];
      body = `<div class="stem">${esc(q.stem)}</div>` + (pts.length
        ? `<div class="rcard-points"><h4>🎯 得分点（${pts.length} 条）</h4><ol>${pts.map((p, i) => `<li>${rich(pointTexts(q, i, p), q)}</li>`).join("")}</ol></div>`
        : `<div class="rcard-ans">✅ 参考答案：${esc(q.ref)}</div>`);
      if (q.explain) body += `<div class="explain show">${explainHTML(q, { noAI: true, noPts: true })}</div>`;
    }
    box.innerHTML = `<article class="rcard" data-id="${q.id}">
      <div class="rcard-head"><span class="qno">第 ${recite.idx + 1} 题 · 原题 #${q.id}</span><span class="badge ${q.type}">${TYPE_CN[q.type]}</span><span class="chap">${esc(q.chapter)}</span>${tags.join("")}</div>
      ${body}
      <div class="rcard-actions"><button type="button" class="primary" id="recitePractice">${graded ? "✍ 重做并练习" : "✍ 开始练习"}</button>
        <span class="rcard-tip">${graded ? "提交后按本次成绩覆盖原记录。" : "≥80 分即从队列移除。"}</span></div>
    </article>`;
  }
  function reciteResultHTML(q, r) {
    const out = r.out, s = out.s, mastered = s >= 80;
    const label = mastered ? (s >= 85 ? "掌握良好" : "已掌握") : s >= 60 ? "基本及格，继续巩固" : "还需加强背诵";
    const badge = out.engine === "ai" ? '<span class="ai-badge ai">🤖 AI 判分</span>' : r.aiPending ? '<span class="ai-pending">🤖 AI 升级判分中…</span>' : "";
    let detail = "";
    if (q.type === "single") {
      detail = `<div class="stem">${esc(q.stem)}</div><div class="opts">` + (q.options || []).map((o) => {
        const right = o.key === q.answer, chosen = o.key === r.input;
        const c = right ? "right" : chosen ? "wrong" : "dim";
        return `<div class="opt ${c}"><span class="key">${o.key}</span><span>${esc(o.text)}</span>${right ? '<span class="opt-ans ok">✓ 正确答案</span>' : chosen ? '<span class="opt-ans no">你的选择 ✗</span>' : ""}</div>`;
      }).join("") + `</div>`;
      if (q.explain || q.ref) detail += `<div class="explain show">${explainHTML(q, { noAI: true })}</div>`;
    } else if (q.type === "blank") {
      const per = out.per || [];
      const parts = q.stem.split(/_{2,}/);
      let stem = "";
      parts.forEach((p, i) => {
        stem += esc(p);
        if (i < parts.length - 1) {
          const ok = per[i] && per[i].ok;
          stem += `<input class="blank ${ok ? "right" : "wrong"}" value="${esc((r.input && r.input[i]) || "")}" disabled>`;
        }
      });
      detail = `<div class="stem">${stem}</div><div class="rcard-ans">✅ 应填：${(q.blanks || []).map((v) => `<b>${esc((v && v[0]) || "")}</b>`).join("、")}</div>` +
        per.map((p, i) => `<div class="blank-report">${i + 1}. ${p.ok ? `<span class="b-ok">✓ ${esc(p.input)}</span>` : `<span class="b-no">✗ 你填：${esc(p.input || "（空）")}</span> → 应填 <code>${esc(p.expect)}</code>`}</div>`).join("");
    } else {
      detail = `<div class="stem">${esc(q.stem)}</div><div class="point-list">` + (out.per || []).map((p, pi) => {
        const cn = { hit: "命中要点", part: "部分命中", miss: "未答到" }[p.state];
        return `<div class="point ${p.state}"><div class="p-head"><span class="p-state">${cn} ${Math.round(p.cov * 100)}%</span></div><div>${rich(pointTexts(q, pi, p.text), q)}</div></div>`;
      }).join("") + `</div>` + (out.summary ? `<details class="ai-reply"><summary>🤖 AI 完整回复</summary><div class="ai-reply-body">${esc(out.summary)}</div></details>` : "");
    }
    return `<article class="rcard recite-result" data-id="${q.id}">
      <div class="rcard-head"><span class="qno">原题 #${q.id}</span><span class="badge ${q.type}">${TYPE_CN[q.type]}</span><span class="chap">${esc(q.chapter)}</span><span class="rcard-tag ${mastered ? "good" : s >= 60 ? "mid" : "wrong"}">${mastered ? "已掌握" : "未掌握"}</span></div>
      <div class="verdict"><span class="score-big ${scoreCls(s)}">${s}</span><span class="tag ${scoreCls(s)}">${label}</span>${badge}</div>
      ${detail}
      <div class="rcard-actions"><button type="button" class="primary" id="reciteNextAfter">下一题 →</button><span class="rcard-tip">≥80 分即移出队列。</span></div>
    </article>`;
  }
  function reciteRenderResult(q, r) {
    if (!q) return;
    const box = $("#reciteCard"), st = box.scrollTop;
    box.innerHTML = reciteResultHTML(q, r);
    box.scrollTop = st;
  }
  function reciteRenderNav() {
    const n = recite.list.length, inPractice = recite.mode === "practice", inResult = inPractice && !!recite.result;
    $("#recitePos").innerHTML = inPractice ? (recite.result ? "已提交评分" : "练习中") : n ? `第 <b>${recite.idx + 1}</b> / ${n} 题` : "—";
    $("#recitePrev").disabled = inPractice || !n || recite.idx <= 0;
    $("#reciteNext").disabled = inResult ? false : inPractice || !n || recite.idx >= n - 1;
  }
  function reciteStep(d) {
    if (recite.mode === "practice" || !recite.list.length) return;
    const next = Math.max(0, Math.min(recite.list.length - 1, recite.idx + d));
    if (next === recite.idx) return;
    recite.idx = next;
    reciteRenderQueue(); reciteRenderCard(); reciteRenderNav();
    $("#reciteCard").scrollTop = 0;
  }
  function reciteLeavePractice() { if (recite.mode === "practice") { recite.mode = "back"; recite.result = null; recite.oldScore = null; } }
  async function reciteSubmit() {
    const it = recite.list[recite.idx]; if (!it) return;
    const q = QBYID[it.id], card = $("#reciteCard .recite-practice");
    if (!card) return;
    const input = collect(q, card);
    if (input == null) { toast("请先作答"); return; }
    const old = store[q.id];
    try {
      const res = await API.answer({ qid: q.id, u: input, mode: old && old.s != null ? "preview" : "submit" });
      if (res.record) store[q.id] = JSON.parse(JSON.stringify(res.record));
      recite.result = { id: q.id, input, out: { s: res.score, per: res.per || [], engine: res.engine, summary: (res.record && res.record.g && res.record.g.summary) || "" }, oldScore: old && old.s != null ? old.s : null, aiPending: false };
      recite.view = await API.recite();
      reciteApply(); reciteRenderCard();
      await refreshProgress();
      if (q.type === "essay" && res.ai_available && aiEnabled()) reciteUpgradeEssay(q, input);
    } catch (e) { toast("提交失败：" + API.message(e.code)); }
  }
  async function reciteUpgradeEssay(q, input) {
    if (!recite.result || recite.result.id !== q.id) return;
    recite.result.aiPending = true; reciteRenderCard();
    try {
      const res = await API.answer({ qid: q.id, u: input, mode: "ai" });
      if (res.record) store[q.id] = JSON.parse(JSON.stringify(res.record));
      if (!recite.result || recite.result.id !== q.id) return;
      recite.result.out = { s: res.score, per: res.per || [], engine: "ai", summary: (res.record && res.record.g && res.record.g.summary) || "" };
      recite.result.aiPending = false;
      recite.view = await API.recite();
      reciteApply(); reciteRenderCard();
    } catch (e) {
      if (!recite.result || recite.result.id !== q.id) return;
      recite.result.aiPending = false; reciteRenderCard();
    }
  }
  function bindRecite() {
    if (!reciteEnabled()) { const b = $("#reciteEntry"); if (b) b.remove(); return; }
    $("#reciteEntry").addEventListener("click", reciteOpen);
    const dlg = $("#reciteDialog");
    $("#reciteFold").addEventListener("click", () => { recite.folded = !recite.folded; recite.foldTouched = true; reciteUpdateFold(); });
    $("#reciteClose").addEventListener("click", () => dlg.close());
    $("#recitePrev").addEventListener("click", () => reciteStep(-1));
    $("#reciteNext").addEventListener("click", () => {
      if (recite.mode === "practice" && recite.result) { recite.mode = "back"; recite.result = null; reciteStep(1); return; }
      reciteStep(1);
    });
    $("#reciteGroupChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      reciteLeavePractice(); recite.group = b.dataset.group; recite.idx = 0; reciteApply();
    });
    $("#reciteTypeChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      reciteLeavePractice(); recite.type = b.dataset.type; recite.idx = 0; reciteApply();
    });
    $("#reciteQueue").addEventListener("click", (e) => {
      const li = e.target.closest(".recite-q-item"); if (!li) return;
      reciteLeavePractice(); recite.idx = +li.dataset.i;
      reciteRenderQueue(); reciteRenderCard(); reciteRenderNav(); $("#reciteCard").scrollTop = 0;
    });
    $("#reciteCard").addEventListener("click", (e) => {
      const t = e.target; if (!t || !t.closest) return;
      if (t.closest("#recitePractice")) {
        const it = recite.list[recite.idx]; if (!it) return;
        const rec = store[it.id];
        recite.mode = "practice"; recite.result = null; recite.oldScore = rec && rec.s != null ? rec.s : null;
        reciteRenderCard(); reciteRenderNav(); $("#reciteCard").scrollTop = 0;
        return;
      }
      if (t.closest("#reciteSubmit")) { reciteSubmit(); return; }
      if (t.closest("#reciteCancel")) { reciteLeavePractice(); reciteRenderCard(); reciteRenderNav(); return; }
      if (t.closest("#reciteNextAfter")) { recite.mode = "back"; recite.result = null; reciteStep(1); return; }
      const opt = t.closest(".recite-practice .opt");
      if (opt && recite.mode === "practice" && !recite.result) {
        $$(".opt", opt.parentNode).forEach((o) => o.classList.remove("picked"));
        opt.classList.add("picked");
      }
    });
    $("#reciteCard").addEventListener("input", (e) => { if (e.target.matches("textarea.ans")) autoGrow(e.target); });
    dlg.addEventListener("close", reciteLeavePractice);
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); reciteStep(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); reciteStep(1); }
    });
  }

  // ——— 考前重点记忆（服务端视图 + 展示筛选） ———
  const memoState = { status: "pending", keyword: "" };
  let memoView = null;
  function memoEnabled() { return !!(D.meta.memo && D.meta.memo.enabled) && !!D.memo; }
  function updateMemoEntry() {
    const btn = $("#memoEntry");
    if (!memoEnabled()) { if (btn) btn.remove(); return; }
    if (!btn) return;
    btn.style.display = "";
    const n = memoView ? memoView.counts.pending : 0;
    $("#memoCount").textContent = n;
    btn.classList.toggle("zero", n === 0);
  }
  function memoFiltered() {
    if (!memoView) return { chapters: [], counts: { pending: 0, sections: 0, questions: 0, mastered: 0, wrong: 0, mid: 0, todo: 0, draft: 0, sectionsWrong: 0 } };
    const status = memoState.status, kw = String(memoState.keyword || "").trim().toLowerCase();
    const hit = (s) => !kw || String(s == null ? "" : s).toLowerCase().includes(kw);
    const chapters = [];
    let shown = 0;
    for (const ch of memoView.chapters) {
      let sections = ch.sections.filter((sec) => {
        if (status === "wrong") { if (!sec.by.wrong) return false; }
        else if (status !== "all" && sec.status !== status) return false;
        return !kw || hit(sec.title) || hit(sec.id) || (sec.items || []).some((it) => hit(it.t));
      });
      if (!sections.length) continue;
      if (status === "wrong") sections = sections.slice().sort((a, b) => (b.by.wrong - a.by.wrong) || (b.by.mid - a.by.mid) || (b.by.todo - a.by.todo));
      shown += sections.length;
      const wrong = sections.reduce((n, s) => n + s.by.wrong, 0);
      chapters.push({ name: ch.name, pending: ch.pending, total: ch.total, sections, wrong });
    }
    if (status === "wrong") chapters.sort((a, b) => b.wrong - a.wrong);
    return { chapters, counts: memoView.counts, shown };
  }
  function memoSectionHTML(sec) {
    const tag = sec.status === "master" ? '<span class="memo-tag ok">✓ 已掌握</span>' : '<span class="memo-tag bad">未掌握</span>';
    const pieces = [];
    if (sec.by.wrong) pieces.push(`答错 ${sec.by.wrong}`);
    if (sec.by.mid) pieces.push(`待提高 ${sec.by.mid}`);
    if (sec.by.todo) pieces.push(`未作答 ${sec.by.todo}`);
    const stat = sec.status === "pending" ? `<span class="memo-stat">${pieces.join(" · ")}</span>` : "";
    const types = (sec.types || []).map((t) => `<span class="memo-type">${esc(t)}</span>`).join("");
    return `<details class="memo-sec${sec.status === "master" ? " done" : ""}" open><summary><span class="memo-no">${esc(sec.id)}</span><b class="memo-title">${esc(sec.title)}</b>${types}${tag}${stat}</summary><ul class="memo-list">` +
      (sec.items || []).map((it) => `<li class="memo-li d${it.d}">${mdBold(it.t)}</li>`).join("") + `</ul></details>`;
  }
  function memoRender() {
    const c = memoView ? memoView.counts : { pending: 0, sections: 0, questions: 0, mastered: 0, wrong: 0, mid: 0, todo: 0, draft: 0, sectionsWrong: 0 };
    $("#memoSub").innerHTML = `<span class="rs-item">未掌握考点 <b>${c.pending}</b> / ${c.sections}</span><span class="rs-item">未掌握题 <b>${c.questions - c.mastered}</b> / ${c.questions}</span><span class="rs-item wrong">答错 <b>${c.wrong}</b></span><span class="rs-item mid">待提高 <b>${c.mid}</b></span><span class="rs-item todo">未作答 <b>${c.todo}</b></span><span class="rs-tip">只列考点、不显示题干；所挂题全部 ≥80 分后自动移出「未掌握」。</span>`;
    const chips = [["pending", `未掌握 ${c.pending}`], ["wrong", `❗ 答错 ${c.sectionsWrong}`], ["master", `已掌握 ${c.master}`], ["all", `全部 ${c.sections}`]];
    $("#memoStatusChips").innerHTML = chips.map(([k, label]) => `<button type="button" class="chip${memoState.status === k ? " active" : ""}" data-status="${k}">${label}</button>`).join("");
    const f = memoFiltered();
    if (!f.chapters.length) { $("#memoBody").innerHTML = `<div class="memo-empty">当前筛选下没有考点。</div>`; return; }
    $("#memoBody").innerHTML = f.chapters.map((ch) => `<section class="memo-chap"><h3>${esc(ch.name)}<span class="memo-chap-count">${memoState.status === "wrong" ? `答错 ${ch.wrong} 题` : `未掌握 ${ch.pending} / ${ch.total} 考点`}</span></h3>` + ch.sections.map(memoSectionHTML).join("") + `</section>`).join("");
  }
  async function memoOpen() {
    if (!memoEnabled()) return;
    try { memoView = await API.memo(); } catch (e) { toast(API.message(e.code)); return; }
    memoState.status = "pending"; memoState.keyword = "";
    $("#memoSearch").value = "";
    memoRender();
    const dlg = $("#memoDialog");
    if (dlg && !dlg.open) dlg.showModal();
    $("#memoBody").scrollTop = 0;
  }
  function bindMemo() {
    if (!memoEnabled()) { const b = $("#memoEntry"); if (b) b.remove(); return; }
    $("#memoEntry").addEventListener("click", memoOpen);
    const dlg = $("#memoDialog");
    $("#memoClose").addEventListener("click", () => dlg.close());
    $("#memoStatusChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      memoState.status = b.dataset.status; memoRender();
    });
    $("#memoSearch").addEventListener("input", (e) => { memoState.keyword = e.target.value; memoRender(); });
  }

  // ——— 账号弹层 ———
  function renderSyncChip() {
    const el = $("#syncChip");
    if (!el) return;
    el.classList.remove("on", "off");
    if (user && !user.guest) {
      el.classList.add("on");
      el.textContent = `☁️ ${user.email}${user.email_verified ? "" : "（未验证）"}`;
    } else {
      el.classList.add("off");
      el.textContent = "👤 游客 · 进度已保存";
    }
  }
  function bindAccount() {
    const chip = $("#syncChip"), dlg = $("#idDialog");
    if (!chip || !dlg) return;
    const q = (s) => dlg.querySelector(s);
    const params = new URLSearchParams(location.search);
    let resetToken = params.get("reset_token") || "";
    let verifyToken = params.get("verify_token") || "";
    let mode = resetToken ? "new" : "login";
    const logged = () => !!(user && !user.guest);
    const verified = () => !!(user && user.email_verified);
    const showError = (sel, msg) => { const el = q(sel); el.textContent = msg || ""; el.hidden = !msg; };
    function render() {
      const isLogged = logged();
      q("#idLoggedOut").hidden = isLogged;
      q("#idLoggedIn").hidden = !isLogged;
      q("#idTabs").hidden = mode === "reset" || mode === "new";
      q("#idForm").hidden = mode !== "login" && mode !== "register";
      q("#idResetForm").hidden = mode !== "reset";
      q("#idNewForm").hidden = mode !== "new";
      q("#idConfirmRow").hidden = mode !== "register";
      q("#idForgotRow").hidden = mode !== "login";
      q("#idSubmit").textContent = mode === "register" ? "注册" : "登录";
      q("#idTitle").textContent = mode === "reset" ? "找回密码" : mode === "new" ? "设置新密码" : "登录 / 注册";
      q("#idDesc").textContent = isLogged ? "进度已保存在服务端，换设备登录同一邮箱即可续用。" : "游客进度会自动保存；登录后并入账号。";
      if (isLogged) {
        q("#idWho").textContent = user.email + " · 账号 " + user.slot;
        q("#idVerifyRow").hidden = verified();
      }
    }
    async function reload() {
      try { user = (await API.me()).user; } catch (e) { try { user = (await API.guest()).user; } catch (e2) { user = null; } }
      applyProgress(await API.progress());
      renderSyncChip(); renderStats(); renderChapters(); renderList();
    }
    chip.addEventListener("click", () => { render(); if (!dlg.open) dlg.showModal(); });
    $("#idClose").addEventListener("click", () => dlg.close());
    $("#idClose2").addEventListener("click", () => dlg.close());
    $("#idTabs").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      mode = b.dataset.tab;
      $$("#idTabs .chip").forEach((c) => c.classList.toggle("active", c === b));
      showError("#idError", ""); render();
    });
    $("#idForgot").addEventListener("click", (e) => { e.preventDefault(); mode = "reset"; render(); });
    $("#idResetBack").addEventListener("click", () => { mode = "login"; render(); });
    $("#idNewCancel").addEventListener("click", () => { mode = "login"; render(); });
    $("#idForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = q("#idEmail").value.trim(), password = q("#idPassword").value;
      if (mode === "register" && password !== q("#idConfirm").value) { showError("#idError", "两次输入的密码不一致"); return; }
      try {
        const r = mode === "register" ? await API.register(email, password) : await API.login(email, password);
        user = r.user; showError("#idError", "");
        await reload(); render();
      } catch (err) { showError("#idError", err.message); }
    });
    $("#idResetForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await API.requestReset(q("#idResetEmail").value.trim()); showError("#idResetError", ""); toast("如果邮箱已注册，重置链接已发送"); }
      catch (err) { showError("#idResetError", err.message); }
    });
    $("#idNewForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const p1 = q("#idNewPassword").value, p2 = q("#idNewPassword2").value;
      if (p1 !== p2) { showError("#idNewError", "两次输入的密码不一致"); return; }
      try { await API.resetPassword(resetToken, p1); showError("#idNewError", ""); resetToken = ""; mode = "login"; toast("密码已重置，请重新登录"); render(); }
      catch (err) { showError("#idNewError", err.message); }
    });
    $("#idLogout").addEventListener("click", async () => {
      try { await API.logout(); } catch (e) {}
      try { user = (await API.guest()).user; } catch (e) { user = null; }
      await reload(); render(); dlg.close();
    });
    $("#idLogoutClear").addEventListener("click", async () => {
      if (!confirm("退出登录并清除本机草稿？云端进度仍保留，重新登录即可续用。")) return;
      MODEL.clearDrafts(prefix); drafts = {};
      try { await API.logout(); } catch (e) {}
      try { user = (await API.guest()).user; } catch (e) { user = null; }
      await reload(); render(); dlg.close();
    });
    $("#idResendVerify").addEventListener("click", async (e) => {
      e.preventDefault();
      if (!user || user.guest) return;
      try { await API.resendVerify(user.email); toast("验证邮件已发送"); } catch (err) { toast(err.message); }
    });
    $("#idResendLogin").addEventListener("click", async (e) => {
      e.preventDefault();
      const email = q("#idEmail").value.trim();
      if (!email) { showError("#idError", "请先填写邮箱"); return; }
      try { await API.resendVerify(email); toast("验证邮件已发送"); } catch (err) { showError("#idError", err.message); }
    });
    // 邮件链接：验证 / 重置
    if (verifyToken) {
      API.verifyEmail(verifyToken).then(async (r) => { user = r.user; toast("邮箱已验证"); await reload(); }).catch((e) => toast(e.message));
      history.replaceState(null, "", location.pathname);
    }
    if (resetToken) { q("#idEmail").closest("form"); render(); }
  }
  function applyQueryTokens() {
    const params = new URLSearchParams(location.search);
    if (params.get("reset_token")) { $("#syncChip").click(); }
  }

  boot();
})();