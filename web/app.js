// 自考押题练习页（共享前端引擎，多科目复用）：渲染 + 交互 + 判分结果展示。
// 科目身份全部来自 QUIZ_DATA.meta（由 scripts/build.js 从 subjects/<科目>/subject.json 注入）。
(async function () {
  "use strict";
  const D = window.QUIZ_DATA, G = window.GRADER;
  const ID = window.IDENTITY;
  const isHttp = typeof location !== "undefined" && (location.protocol === "http:" || location.protocol === "https:");
  ID.ensure(D.meta.storageKey, isHttp); // 新访客静默签发同步码；有旧版数据的设备继续兼容槽（站长零打断）
  const KEY = ID.keyFor(D.meta.storageKey); // 存储键＝科目裸键+同步码分区；云端槽=(科目,码)，各人进度独立
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const TYPE_CN = { single: "单选", blank: "填空", essay: "简答" };

  // 云同步首拉合并：await 之后才装载 store/shuf（file:// 或超时自动降级纯本机，绝不阻塞渲染）
  if (window.SYNC) await window.SYNC.prefetch(KEY, ID.user());

  let store = load();
  let filters = { chapter: "all", type: "all", status: "all", search: "" };
  let shuffle = false, showRef = false;
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
  function statusWeight(q) {
    const r = store[q.id];
    if (r && r.v) return 8;       // 作答前点开过解析＝开卷：不论得分，一律计入「完全没掌握」最高频出现（重做此题可清零）
    const s = r ? r.s : null;
    if (s == null) return 4;      // 未做/未判分：更易出现
    if (s < 60) return 4;         // 做错：更易出现
    if (s >= 80) return 0.3;      // 已通过且未看过解析：降低推荐频率
    return 1;                     // 60~79：正常
  }
  // 未判分的题点开解析：记录查看（v 字段），组卷时计入「完全没掌握」档
  function markViewed(q) {
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
      `<span class="pi-tip">点开过解析的最易入选（不论得分），未做/答错的次之，没看过解析且已通过的低频；点「🎲 换一批」按最新掌握情况重新组卷；筛选圈定抽题范围，组卷后状态筛选不再影响卷面（组卷即全新已清空卷内得分）</span>`;
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
    if (prev && prev.s != null) { updateBulkBar(); return; } // 已判分：保留旧结果，直到重新提交
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

  // ——— 历史作答留档：判过分的记录在「组卷清理 / 重做此题 / 重新评分顶掉旧分」前归档进本机派生键 `.hist`
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
      const mode = (rec && rec.u && rec.u.mode) || "whole";
      body = `<div class="modes">
        <button class="mode-btn ${mode === "whole" ? "active" : ""}" data-mode="whole">整题作答</button>
        <button class="mode-btn ${mode === "points" ? "active" : ""}" data-mode="points">分点作答（${q.points.length} 个要点）</button>
      </div><div class="essay-form"></div>`;
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
  function explainHTML(q) {
    const text = q.explain || q.ref || "";
    let body = text, header = null;
    const m = text.match(/^考点\s*([^：:]{1,48}?)\s*[：:]\s*/);
    if (m) { header = m[1]; body = text.slice(m[0].length); }
    let html = "";
    if (header) html += `<div class="ex-tag">📍 考点 ${esc(header)}</div>`;
    if (q.type === "blank") html += `<div class="ex-ans">应填：${q.blanks.map((v) => `<b>${esc(v[0])}</b>`).join("、")}${q.unordered ? ' <span class="pi-tip">（并列各空，顺序可互换）</span>' : ""}</div>`;
    const items = splitItems(body);
    html += `<ul class="ex-list">` + items.map((it) => {
      const cleaned = it.replace(/^（\d+）|^\(\d+\)|^\d+、/, "").trim();
      return `<li>${rich(cleaned, q)}</li>`;
    }).join("") + `</ul>`;
    if (q.type === "essay" && q.points && q.points.length) {
      html += `<div class="ex-pts"><h5>✅ 得分点（${q.points.length} 条，答出加粗关键词即得分）</h5><ol>` +
        q.points.map((p, i) => `<li>${rich(pointTexts(q, i, p), q)}</li>`).join("") + `</ol></div>`;
    }
    if (q.type === "single" && aiEnabled() && D.meta.flags.explain) { // file://、AI 熔断或科目未开启 explain 特性时不提供逐项解析入口
      html += `<div class="optexpl"><button class="secondary optexpl-btn" type="button">🤖 逐项解析</button><div class="optexpl-body"></div></div>`;
    }
    return html;
  }

  function essayFormHTML(q, mode, rec) {
    if (mode === "points") {
      return `<div class="points-form">` + q.points.map((p, i) => {
        const val = rec && rec.u && rec.u.points && rec.u.points[i] ? rec.u.points[i] : "";
        return `<div class="prow"><label>要点${i + 1}</label><input class="pinput" data-pi="${i}" value="${esc(val)}" autocomplete="off" spellcheck="false"></div>`;
      }).join("") + `</div><div class="hint-line">提示：每个输入框对应参考答案拆分出的一个得分点，逐条背诵。</div>`;
    }
    const val = rec && rec.u && rec.u.whole ? rec.u.whole : "";
    return `<textarea class="ans" rows="1" spellcheck="false">${esc(val)}</textarea>
      <div class="hint-line">提示：按要点写出答案，系统将对照参考答案的 ${q.points.length} 个得分点，按关键词覆盖度自动打分（≥50% 视为命中该要点）。</div>`;
  }

  // 整题作答文本框高度随内容自适应（最低一行由 CSS min-height 兜底）；+2 补上下 1px 边框（box-sizing: border-box）
  function autoGrow(ta) { if (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; } }
  function mountEssayForm(card, q, mode, rec) {
    $(".essay-form", card).innerHTML = essayFormHTML(q, mode, rec);
    autoGrow($("textarea.ans", card));
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
      if (q.type === "essay") {
        const mode = store[q.id] && store[q.id].u && store[q.id].u.mode || "whole";
        mountEssayForm(card, q, mode, store[q.id]);
      }
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
    const mode = $(".mode-btn.active", card).dataset.mode;
    if (mode === "points") {
      const pts = $$(".pinput", card).map((i) => i.value.trim());
      return pts.every((p) => !p) ? null : { mode, points: pts };
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
    if (input.mode === "points") {
      const ctx = G.ctxFor(q.points);
      const per = q.points.map((p, i) => {
        const r = G.pointCoverage(p, input.points[i] || "", ctx);
        return { text: p, cov: r.cov, segs: r.segs, state: G.stateOf(r.cov) };
      });
      return { s: Math.round(per.reduce((a, b) => a + b.cov, 0) / per.length * 100), per, engine: "local" };
    }
    const r = G.gradeEssay(input.whole || "", q.points);
    return { s: r.score, per: r.per, engine: "local" };
  }

  // ——— 简答 AI 判分：经同源 /api/grade 调 Go 服务（grade-svc），不可用自动降级本机估分 ———
  let aiOff = false; // 会话级熔断：服务未启动 / 未配 Key / Key 无效时不再重复请求
  const AI_CODES = { no_key: "未配置 QWEN_API_KEY", bad_key: "API Key 无效", svc_down: "判分服务未启动", timeout: "上游超时", parse: "上游输出解析失败", upstream: "上游服务错误", bad_request: "请求参数异常", internal: "服务内部错误" };
  function aiEnabled() { return !aiOff && location.protocol !== "file:"; }
  function liveCard(qid) { return document.querySelector(`.card[data-id="${qid}"]`); }
  function essayAnswerText(input) {
    return input.mode === "points"
      ? input.points.map((p, i) => `第${i + 1}点：${p || "（未作答）"}`).join("\n")
      : input.whole || "";
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
  function upgradeEssay(q, input, localOut) {
    if (!aiEnabled()) return Promise.resolve(false);
    const c0 = liveCard(q.id);
    if (c0) markAIGrading(c0);
    return requestAI(q, input)
      .then((data) => {
        const rec = store[q.id];
        if (!rec || rec.u !== input) return false; // 用户已重答，丢弃过期结果
        rec.s = data.score;
        rec.g = { score: data.score, per: data.per, ts: Date.now() };
        save();
        const c = liveCard(q.id);
        if (c) showResult(q, c, input, { s: data.score, per: data.per, engine: "ai" });
        renderStats(); renderChapters();
        return true;
      })
      .catch((e) => {
        if (e.code === "svc_down" || e.code === "no_key" || e.code === "bad_key") aiOff = true;
        const rec = store[q.id];
        const c = liveCard(q.id);
        if (c && rec && rec.u === input) showResult(q, c, input, Object.assign({}, localOut, { unavailable: AI_CODES[e.code] || e.code }));
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
  function validExpl(data, q) { return data && Array.isArray(data.items) && data.items.length === q.options.length; }
  async function requestExplain(q, onEvent) {
    const res = await fetch("api/grade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "explain", stream: true, stem: q.stem, options: q.options, answer: q.answer, ref: q.explain || q.ref || "" }),
      signal: AbortSignal.timeout(95000), // 两级上游调用（资料级+联网级），预算比判分长
    });
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
  // 流断（网络断开/超时 abort 后余帧）未等到 done → 按 upstream 失败处理。
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
        if (!settled) bad(explErr("upstream"));
      })().catch((e) => bad(e));
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
    body.innerHTML = `<div class="oe-head">逐项解析 ${chip}</div>` + (think ? thinkPanelHTML(think, false) : "") +
      data.items.map((it) =>
      `<div class="oe-row ${it.correct ? "ok" : "no"}"><span class="oe-key">${esc(it.key)}</span>` +
      `<span class="oe-tag">${it.correct ? "✓ 正确项" : "✗ 错误项"}</span><span class="oe-why">${esc(it.why)}</span></div>`).join("");
    body.classList.add("show");
  }
  // 流式渲染：reason 事件流式展示思考过程（生成中保持展开，用户可点标题手动收起/展开；
  // done 后整包重排默认收起）；delta 事件逐选项落行（行按到达序出现，done 整包整形后重排并标注对错）；
  // reset ＝ 资料级输出被弃用转联网，清回生成头（思考面板一并清空重建）。dataset.live 同时驱动光标样式。
  function startExplLive(body) {
    body.dataset.live = "1";
    body.__think = "";
    body.innerHTML = '<div class="oe-head">🤖 逐项解析生成中…</div>';
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
  function wireOptExpl(q, btn, body) {
    const cached = explCache[q.id];
    if (cached && Array.isArray(cached.items)) {
      renderOptExpl(body, cached);
      btn.textContent = "🤖 重新逐项解析";
    }
    body.addEventListener("click", (e) => { // 思考面板手动展开/收起（事件委托：面板随 innerHTML 重建）
      const head = e.target.closest && e.target.closest(".oe-think-head");
      if (head) head.parentNode.classList.toggle("collapsed");
    });
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "🤖 逐项解析生成中…（可能要联网）";
      try {
        const data = await requestExplain(q, (ev, p) => {
          if (ev === "delta") explLiveDelta(body, p.key, p.text);
          else if (ev === "reason") explLiveReason(body, p.text);
          else if (ev === "reset") startExplLive(body);
        });
        saveExplCache(q.id, data);
        renderOptExpl(body, data);
        btn.textContent = "🤖 重新逐项解析";
      } catch (e) {
        if (e.code === "svc_down" || e.code === "no_key" || e.code === "bad_key") aiOff = true; // 与简答判分共用熔断
        if (cached && Array.isArray(cached.items)) renderOptExpl(body, cached); // 失败回滚到旧完整结果，不留半截
        else if (body.dataset.live) { delete body.dataset.live; body.classList.remove("show"); body.innerHTML = ""; }
        btn.textContent = "🤖 逐项解析";
        toast("逐项解析失败：" + (AI_CODES[e.code] || e.code));
      } finally {
        btn.disabled = false;
      }
    });
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
      $(".result", card).innerHTML = `<div class="verdict"><span class="score-big ${scoreCls(out.s)}">${out.s}</span>
        <span class="tag ${scoreCls(out.s)}">${label}</span>${badge}</div>
        <div class="point-list">${pts}</div>${refBlock(q)}`;
      if (q.type === "essay" && $(".mode-btn.active", card)) {
        $$(".pinput", card).forEach((el, i) => {
          el.classList.remove("right", "wrong");
          if (out.per && out.per[i]) el.classList.add(out.per[i].state !== "miss" ? "right" : "wrong");
        });
      }
    }
    $(".result", card).classList.add("show");
    armResultUI(q, card, out);
  }

  // 判分后的公共收尾：提交按钮变「重新评分」、追加「重做此题」（重做前留档）、刷新分数胶囊、未满分自动展开解析
  // （单选展开的是选项区内的解析，填空/简答是底部面板）
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
    updateScoreChip(card, out.s);
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
      mountEssayForm(card, q, rec.u.mode, rec);
    }
    // 简答已有 AI 判分结果（g 字段）时直接渲染，不再重算、不打网络；否则走本机词面判分
    const out = q.type === "essay" && rec.g
      ? { s: rec.g.score, per: rec.g.per, engine: "ai" }
      : grade(q, rec.u);
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
    if (q.type === "essay") {
      $$(".mode-btn", card).forEach((btn) => btn.addEventListener("click", () => {
        const prev = store[q.id];
        if (prev) {
          if (prev.v) { store[q.id] = { u: null, s: null, ts: prev.ts, v: prev.v }; } // 切换作答方式只清作答，不清「看过解析」标记
          else { delete store[q.id]; }
          save(); renderStats(); renderChapters();
        }
        $$(".mode-btn", card).forEach((b) => b.classList.toggle("active", b === btn));
        mountEssayForm(card, q, btn.dataset.mode, null);
        $(".result", card).classList.remove("show");
        $(".result", card).innerHTML = "";
        const old = $(".redo-btn", card); if (old) old.remove();
        $(".grade-btn", card).textContent = "提交评分";
        const chip = $(".score-chip", card); if (chip) chip.remove();
        updateBulkBar();
      }));
    }
    $(".grade-btn", card).addEventListener("click", () => {
      const input = collect(q, card);
      if (input == null) return flash(card, q.type === "single" ? "请先选择一个选项" : "请先写出你的答案");
      if (q.type === "blank" && input.every((v) => !v)) return flash(card, "请先填写答案");
      const out = grade(q, input);
      archiveHist(q.id, store[q.id]); // 重新评分顶掉旧得分前留档
      store[q.id] = { u: input, s: out.s, ts: Date.now(), v: store[q.id] && store[q.id].v }; // 保留「看过解析」标记，判分不洗白
      save();
      showResult(q, card, input, out);
      renderStats(); renderChapters(); updateBulkBar();
      if (q.type === "essay") upgradeEssay(q, input, out); // 异步升级为 AI 判分，失败保留上方本机分
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
  // ——— 多用户身份：点顶栏云同步芯片开弹层（看码/复制/输码切换/一键迁移）———
  (function identityUI() {
    const chip = $("#syncChip"), dlg = $("#idDialog");
    if (!chip || !dlg || !isHttp) return; // file:// 无云同步亦无芯片文案：身份功能不启用
    const q = (s) => dlg.querySelector(s);
    const raw = D.meta.storageKey;
    const hasLegacyLocal = () => { try { return localStorage.getItem(raw) != null; } catch (e) { return false; } };
    function render() {
      const u = ID.user(), legacy = hasLegacyLocal();
      q("#idDesc").innerHTML = u
        ? "本机按同步码分槽上云，各人进度互不干扰；全部科目共用这一个码。"
        : "本机还在用旧版全局槽——" + (legacy ? "同科目旧版设备<b>共用同一份进度</b>，建议换成你自己的同步码。" : "尚无本机的私有进度。");
      const codeRow = q("#idCodeRow");
      codeRow.hidden = !u;
      if (u) codeRow.innerHTML = "我的同步码 <b>" + u + "</b>";
      q("#idMigrate").hidden = !!u || !legacy;
      q("#idCopy").hidden = !u;
      q("#idBack").hidden = !ID.wasLegacy(); // 迁移过来的身份可退回旧版槽（新访客无此路）
      q("#idInput").value = "";
    }
    async function switchTo(code, migrate) {
      code = String(code || "").trim().toLowerCase();
      if (!migrate && !ID.valid(code)) { toast("同步码应为 4~10 位小写字母数字（不含 i、l、o、0、1）"); return; }
      if (window.SYNC) await SYNC.flushNow(); // 最后一笔防抖改动推完再换身份
      if (migrate) ID.migrateTo(raw, code); else ID.setCode(code);
      location.reload();
    }
    chip.classList.add("id-clickable");
    chip.title = "云同步身份（多用户）";
    chip.addEventListener("click", () => { render(); dlg.showModal(); });
    q("#idClose").addEventListener("click", () => dlg.close());
    q("#idMigrate").addEventListener("click", () => switchTo(ID.mint(), true));
    q("#idApply").addEventListener("click", () => switchTo(q("#idInput").value, false));
    q("#idBack").addEventListener("click", async () => { if (window.SYNC) await SYNC.flushNow(); ID.clearCode(); location.reload(); });
    q("#idCopy").addEventListener("click", () => {
      const c = ID.user(); if (!c) return;
      const fb = () => toast("你的同步码：" + c);
      try { navigator.clipboard.writeText(c).then(() => toast("同步码已复制"), fb); } catch (e) { fb(); }
    });
  })();
  renderStats();
  renderChapters();
  renderList();
})();
