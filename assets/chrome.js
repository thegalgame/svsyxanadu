/* 站点公共框架（页头 / 页脚 / 锚点落点 / 交叉引用解析）
 *
 * 页头与页脚原本在 293 个页面里各写一份，词条数量一变就要逐页改；现在统一由本文件生成。
 *
 * 交叉引用：链接写作 #L67~<引文>。行号仅作提示，正文行序变动后仍按引文定位；
 * 引文本身被改写、找不到时退回行号，并在页脚上方提示一次。
 */
(function () {
  'use strict';

  var self = document.currentScript || (function () {
    var a = document.getElementsByTagName('script');
    return a[a.length - 1];
  })();
  var BASE = ((self && self.src) || '').replace(/assets\/chrome\.js(?:[?#].*)?$/, '');
  if (!BASE) BASE = './';

  var CATS = [
    ['规', '编纂说明'], ['歌', '歌词'], ['世', '世界线用语'], ['神', '世界观用语'],
    ['祭', '祭礼·神事'], ['人', '登场人物'], ['家', '四家·门第'], ['场', '佳城市·地名'],
    ['学', '学校·机构'], ['宝', '神具·古玉·宝刀'], ['食', '饮食·店铺'], ['杂', '杂学']
  ];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function decode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  /* ---------------------------------------------------------------- 当前分类 */

  function activeKey() {
    var path = decode(location.pathname);
    var m = path.match(/\/cat\/([^\/]+)\.html$/);
    if (m) return m[1];
    if (/\/(entry1|entry2)\//.test(path)) {
      var a = document.querySelector('.crumb a[href*="cat/"]');
      if (a) {
        var k = decode(a.getAttribute('href')).match(/cat\/([^\/]+)\.html/);
        if (k) return k[1];
      }
      return '';
    }
    if (/\/story1?\//.test(path) || /\/story\.html$/.test(path)) return 'story';
    if (/\/gallery(\.html|\/)/.test(path)) return 'gal';
    return '';
  }

  /* ---------------------------------------------------------------- 页头 */

  function buildHeader() {
    var on = activeKey();
    var nav = ['<a href="' + BASE + 'index.html">首页</a>'];
    for (var i = 0; i < CATS.length; i++) {
      var k = CATS[i][0];
      nav.push('<a href="' + BASE + 'cat/' + encodeURIComponent(k) + '.html"' +
        (k === on ? ' class="on"' : '') + '>' + esc(CATS[i][1]) + '</a>');
    }
    nav.push('<a href="' + BASE + 'gallery.html"' + (on === 'gal' ? ' class="on"' : '') +
      '>图片资料</a>');
    nav.push('<a href="' + BASE + 'story.html"' + (on === 'story' ? ' class="on"' : '') +
      '>参考资料</a>');

    var hd = document.createElement('header');
    hd.className = 'hd';
    hd.innerHTML = '<div class="hd-in">' +
      '<a class="logo" href="' + BASE + 'index.html">少女神域<span>用语词典</span></a>' +
      '<nav class="nav">' + nav.join('') + '</nav>' +
      '</div>';
    document.body.insertBefore(hd, document.body.firstChild);
    return hd;
  }

  /* ---------------------------------------------------------------- 页脚 */

  var REF = BASE + 'entry1/004_' + encodeURIComponent('参考资料简介') + '.html';

  function buildFooter() {
    var ft = document.createElement('footer');
    ft.className = 'ft';
    ft.innerHTML =
      '<p>少女神域∽少女天獄 用语词典 · 离线 HTML 文件库</p>\n' +
      '<p><span id="ft-cnt"></span><span id="ft-sep"></span>收录依据与资料来源见 ' +
      '<a href="' + REF + '">《参考资料简介》</a></p>\n' +
      '<p>建站者：bilibili <a href="https://space.bilibili.com/87412647" target="_blank" rel="noopener">月が綺麗ですね_</a>' +
      ' | 如有错漏，欢迎指正 | 联系方式：QQ：3099637681<br>\n' +
      '     游戏原版权方与现版权方：Lass | DMM<br>\n' +
      '    <a href="https://web.archive.org/web/20180601000000*/lass.jp" target="_blank" rel="noopener">原lass历史官网快照</a> |\n' +
      '\t\t\t\t<a href="https://dlsoft.dmm.co.jp/detail/russ_0144/?i3_ref=search&i3_ord=1" target="_blank" rel="noopener">正版购买链接</a><br></p>\n';
    document.body.appendChild(ft);
    fillStats();
  }

  function fillStats() {
    var E = window.ENTRIES;
    if (E && E.length) return setStats(E);
    var add = function () {
      var s = document.createElement('script');
      s.src = BASE + 'assets/entries.js';
      s.onload = function () { if (window.ENTRIES) setStats(window.ENTRIES); };
      document.head.appendChild(s);
    };
    /* 页脚在页末，晚一点取也不影响阅读；同一 URL 全站共用一份缓存 */
    if (window.requestIdleCallback) requestIdleCallback(add, { timeout: 1500 });
    else setTimeout(add, 400);
  }

  function setStats(E) {
    var cnt = document.getElementById('ft-cnt');
    if (!cnt || cnt.getAttribute('data-done')) return;
    var cats = {}, n = 0, i;
    for (i = 0; i < E.length; i++) {
      if (!E[i] || !E[i].u) continue;
      n++;
      if (E[i].c) cats[E[i].c] = 1;
    }
    cnt.textContent = '共 ' + n + ' 词条 / ' + Object.keys(cats).length + ' 分类';
    cnt.setAttribute('data-done', '1');
    var sep = document.getElementById('ft-sep');
    if (sep) sep.textContent = ' · ';
  }

  /* ---------------------------------------------------------------- 锚点落点 */

  function norm(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

  /* 行号槽 .ln 里的数字不在比对范围内（行号会变，正文不会） */
  function textOf(el) {
    if (!el) return '';
    var tx = el.querySelector ? el.querySelector('.tx') : null;
    return norm((tx || el).textContent);
  }

  function parseHash(hash) {
    if (!hash || hash.length < 2) return null;
    /* 先按 ~ 切分再逐段解码：引文里可能含 %7E（即 ~），先解码会把切分点弄错 */
    var raw = hash.slice(1);
    var i = raw.indexOf('~');
    if (i < 0) return { id: decode(raw), q: '' };
    return { id: decode(raw.slice(0, i)), q: decode(raw.slice(i + 1)) };
  }

  /* 行号只是提示：先看该行是否仍含引文，否则在同前缀的锚点里找引文。
     引文若被折行拆到相邻的两三行，就把相邻行拼起来再比——
     正文（日语原文）不会变，变的是行号与折行位置。 */
  function resolve(id, q) {
    var el = document.getElementById(id);
    if (!q) return { el: el, byQuote: false };
    if (el && textOf(el).indexOf(q) >= 0) return { el: el, byQuote: true };

    var prefix = id.replace(/\d+$/, '') || id;
    var hint = parseInt((id.match(/(\d+)$/) || [])[1], 10);
    var cands = [].slice.call(
      document.querySelectorAll('[id^="' + prefix.replace(/"/g, '') + '"]'));
    var best = null, bestD = Infinity;
    for (var k = 1; k <= 3 && !best; k++) {
      for (var i = 0; i + k <= cands.length; i++) {
        var joined = '';
        for (var j = 0; j < k; j++) joined += textOf(cands[i + j]);
        if (joined.indexOf(q) < 0) continue;
        var m = cands[i].id.match(/(\d+)$/);
        var d = (isNaN(hint) || !m) ? i
          : Math.abs(parseInt(m[1], 10) - hint);
        if (d < bestD) { bestD = d; best = cands[i]; }
      }
    }
    if (best) return { el: best, byQuote: true };
    return { el: el, byQuote: false, miss: true };
  }

  function jump() {
    var h = parseHash(location.hash);
    if (!h) return;
    var r = resolve(h.id, h.q);
    if (!r.el) return;
    var root = document.documentElement;
    var prev = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    syncHeader();
    r.el.scrollIntoView({ block: 'start' });
    root.style.scrollBehavior = prev;

    if (r.byQuote && r.el.id && r.el.id !== h.id) {
      try { history.replaceState(null, '', '#' + r.el.id); } catch (e) { /* file:// 下忽略 */ }
    }
    flash(r.el);
    if (r.miss) toast('引文已改动，未能定位到原句，已退回到第 ' +
      String(h.id).replace(/^L/, '') + ' 行');
  }

  var flashTimer = null;
  function flash(el) {
    if (!el.classList) return;
    el.classList.add('flash');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.classList.remove('flash'); }, 2600);
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('pos-miss');
    if (!t) {
      t = document.createElement('div');
      t.id = 'pos-miss';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 4200);
  }

  /* ---------------------------------------------------------------- 头部高度 */

  function syncHeader() {
    var hd = document.querySelector('.hd');
    if (!hd) return;
    var h = Math.round(hd.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--hdr-h', h + 'px');
  }

  /* ---------------------------------------------------------------- 启动 */

  function run() {
    buildHeader();
    buildFooter();
    syncHeader();
    window.addEventListener('resize', syncHeader);
    window.addEventListener('orientationchange', syncHeader);
    if (window.ResizeObserver) {
      var hd = document.querySelector('.hd');
      if (hd) new ResizeObserver(syncHeader).observe(hd);
    }

    if (location.hash.length > 1) {
      jump();
      /* 字体、图片把布局撑开后（高度会变）再校一次 */
      window.addEventListener('load', function () { jump(); });
    }
    window.addEventListener('hashchange', jump);

    /* 同页内点行号链接时，先按引文定位再滚动，避免先跳到旧行号 */
    document.addEventListener('click', function (e) {
      var a = e.target;
      while (a && a.tagName !== 'A') a = a.parentNode;
      if (!a || !a.getAttribute) return;
      var href = a.getAttribute('href') || '';
      if (href.charAt(0) !== '#' || href.length < 2) return;
      var h = parseHash(href);
      if (!h || !h.q) return;
      var r = resolve(h.id, h.q);
      if (!r.el || !r.byQuote) return;
      e.preventDefault();
      try { history.replaceState(null, '', '#' + r.el.id); } catch (err) { /* 忽略 */ }
      var root = document.documentElement;
      var prev = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      r.el.scrollIntoView({ block: 'start' });
      root.style.scrollBehavior = prev;
      flash(r.el);
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
