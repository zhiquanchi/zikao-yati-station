// 科目切换器：仅在门户按路径部署（/<科目 prefix>/ 前缀）时渲染顶栏按钮组；
// 科目清单来自 web/subjects.js（scripts/build.js 依据全部 subject.json 生成）；
// 本地开发/单站根路径部署命中不了清单前缀，静默不渲染，避免出现死链。
(function () {
  "use strict";
  var subs = window.SUBJECTS || [];
  if (subs.length < 2) return;
  var m = location.pathname.match(/^\/([^/]+)(?:\/|$)/);
  if (!m) return;
  var known = subs.some(function (s) { return s.prefix === m[1]; });
  if (!known) return;
  var wrap = document.querySelector(".topbar .wrap");
  if (!wrap) return;
  var html = '<nav class="subj-switch" aria-label="切换科目">' + subs.map(function (s) {
    return s.prefix === m[1]
      ? '<span class="subj on">' + s.label + "</span>"
      : '<a class="subj" href="../' + s.prefix + '/">' + s.label + "</a>";
  }).join("") + "</nav>";
  wrap.insertAdjacentHTML("afterbegin", html);
})();
