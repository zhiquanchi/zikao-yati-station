// 科目切换器：仅在门户按路径部署（/os/ 或 /net/ 前缀）时渲染顶栏按钮组；
// 本地开发/单站根路径部署拿不到前缀，静默不渲染，避免出现死链。
(function () {
  "use strict";
  var m = location.pathname.match(/^\/(os|net)(?:\/|$)/);
  if (!m) return;
  var wrap = document.querySelector(".topbar .wrap");
  if (!wrap) return;
  var items = [["os", "操作系统 13180"], ["net", "网络安全 04751"]];
  var html = '<nav class="subj-switch" aria-label="切换科目">' + items.map(function (it) {
    return it[0] === m[1]
      ? '<span class="subj on">' + it[1] + "</span>"
      : '<a class="subj" href="../' + it[0] + '/">' + it[1] + "</a>";
  }).join("") + "</nav>";
  wrap.insertAdjacentHTML("afterbegin", html);
})();
