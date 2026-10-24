// 主页交互：分类折叠（<details>）+ 词条名检索
(function () {
  var q = document.getElementById('q');
  var info = document.getElementById('qinfo');
  var tog = document.getElementById('tog');
  if (!q || !info) return;

  var blks = Array.prototype.slice.call(document.querySelectorAll('.blk'));
  var lst = Array.prototype.slice.call(document.querySelectorAll('.lst li a'));

  function norm(s) { return s.toLowerCase().replace(/\s+/g, ''); }

  // manual[i]  = 用户手动展开/收起后的状态（检索清空时恢复）
  // expected[i]= 程序最后一次写入的状态；toggle 时两者不等即判定为用户操作
  var manual = {};
  var expected = {};
  blks.forEach(function (b, i) {
    manual[i] = b.open;
    expected[i] = b.open;
    b.addEventListener('toggle', function () {
      if (b.open === expected[i]) return;   // 程序写入引起的，忽略
      manual[i] = b.open;
      expected[i] = b.open;
    });
  });

  function setOpen(b, i, v) {
    expected[i] = v;
    if (b.open !== v) b.open = v;
  }

  function syncTog() {
    var anyClosed = blks.some(function (b) { return !b.open; });
    tog.textContent = anyClosed ? '全部展开' : '全部收起';
  }

  function run() {
    var key = norm(q.value.trim());
    if (!key) {
      // 清空检索：恢复用户此前的折叠状态
      blks.forEach(function (b, i) {
        setOpen(b, i, manual[i]);
        b.classList.remove('hit');
      });
      lst.forEach(function (a) { a.parentNode.style.display = ''; });
      info.textContent = '';
      syncTog();
      return;
    }
    // 检索中：命中分类自动展开，无命中分类隐藏
    var hit = 0;
    lst.forEach(function (a) {
      var ok = norm(a.textContent).indexOf(key) >= 0;
      a.parentNode.style.display = ok ? '' : 'none';
      if (ok) hit++;
    });
    blks.forEach(function (b, i) {
      var vis = b.querySelectorAll('.lst li:not([style*="display: none"])').length;
      b.classList.toggle('hit', vis === 0);
      setOpen(b, i, vis > 0);        // 命中分类强制展开
    });
    info.textContent = hit ? ('命中 ' + hit + ' 条') : '无匹配';
    syncTog();
  }

  q.addEventListener('input', run);

  // 回车跳到第一个命中项
  q.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var first = lst.filter(function (a) { return a.parentNode.style.display !== 'none'; })[0];
    if (first) first.click();
  });

  // 全部展开 / 全部收起
  tog.addEventListener('click', function () {
    var anyClosed = blks.some(function (b) { return !b.open; });
    blks.forEach(function (b, i) {
      setOpen(b, i, anyClosed);
      manual[i] = b.open;
    });
    syncTog();
  });

  // 支持 index.html#关键词 直接进入检索状态
  if (location.hash.length > 1) {
    q.value = decodeURIComponent(location.hash.slice(1));
    run();
  } else {
    syncTog();
  }
})();

/* ---------- 图片懒加载（GitHub / github.io 加载优化） ----------
 * github.io 单域名带宽有限，一页几十张图同时抢连接会出现
 * 「从上往下一点点加载」、首屏长时间转圈、点开大图也打不开。
 * 用 IntersectionObserver 接管全部 <img>：
 *   - 仅加载进入视口（含 300px 预载边缘）的图片，其余滚动到附近再加载；
 *   - 请求并发限制为 4，失败自动退避重试 2 次；
 *   - 折叠区（未展开的 <details>）内的图片不预载，展开时才加载；
 *   - 灯箱打开时经 window.__lazyNow 立即加载目标图，跳过等待队列。
 * 注意：本段在 lightbox.js 与 search.js 各有一份（改动需保持同步），
 * window.__lazyReady 保证同页两份共存时只初始化一次。
 */
(function () {
  if (window.__lazyReady) return;
  window.__lazyReady = true;

  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var MAX_PARALLEL = 4;
  var queue = [], running = 0, io = null;

  function pump() {
    while (running < MAX_PARALLEL && queue.length) start(queue.shift());
  }

  function start(im) {
    var src = im.getAttribute('data-src');
    if (!src) return;
    im.removeAttribute('data-src');
    running++;
    im.__lazyWant = src;
    var finish = function () {
      if (im.__lazyWant !== src) return;   // 占位图(data:)触发的事件，忽略
      im.__lazyWant = null;
      running--;
      pump();
    };
    im.addEventListener('load', finish);
    im.addEventListener('error', function onErr() {
      if (im.__lazyWant !== src) return;
      var n = (im.__lazyRetry || 0) + 1;
      if (n <= 2) {
        im.__lazyRetry = n;
        // 同值 src 不会重新发起请求，加查询参数强制重试
        var retry = src + (src.indexOf('?') < 0 ? '?' : '&') + 'retry=' + n;
        setTimeout(function () { im.src = retry; }, 500 * n);
      } else {
        im.__lazyWant = null;
        running--;
        pump();
      }
    });
    im.src = src;
  }

  function onSeen(entries) {
    for (var i = 0; i < entries.length; i++) {
      var im = entries[i].target;
      if (!entries[i].isIntersecting || !im.hasAttribute('data-src')) continue;
      io.unobserve(im);
      queue.push(im);
    }
    pump();
  }

  function init() {
    if (!('IntersectionObserver' in window)) return;   // 老浏览器：保持原生加载行为
    io = new IntersectionObserver(onSeen, { rootMargin: '300px 0px', threshold: 0 });
    var imgs = document.querySelectorAll('img[src]');
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      var src = im.getAttribute('src');
      if (!src || src.indexOf('data:') === 0) continue;
      im.setAttribute('data-src', src);
      im.src = BLANK;
      io.observe(im);
    }
  }

  // 立即加载指定图片（灯箱打开时调用，跳过等待队列）
  window.__lazyNow = function (el) {
    if (!io) return;
    var im = el && el.tagName
      ? (el.tagName === 'IMG' ? el : el.querySelector('img[data-src]')) : null;
    if (!im) return;
    io.unobserve(im);
    var k = queue.indexOf(im);
    if (k >= 0) queue.splice(k, 1);
    start(im);
    pump();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
