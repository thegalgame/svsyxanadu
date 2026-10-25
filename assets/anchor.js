/* 锚点落点修正
   1) 实测粘性导航栏高度写入 --hdr-h，供 style.css 的 scroll-padding-top 使用
      （导航栏在窄屏会换行变高，写死数值必然会遮挡目标行）；
   2) 首次进入带 #锚点 的页面时，浏览器会按 scroll-behavior:smooth 从顶部
      缓慢滚过整个页面（长剧本上万像素要滚数秒），这里改为瞬时对齐。 */
(function () {
  var root = document.documentElement;
  var hd = document.querySelector('.hd');

  function sync() {
    if (!hd) return;
    var h = Math.round(hd.getBoundingClientRect().height);
    if (h > 0) root.style.setProperty('--hdr-h', h + 'px');
  }
  sync();
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  if (window.ResizeObserver && hd) new ResizeObserver(sync).observe(hd);

  function target() {
    var h = location.hash;
    if (!h || h.length < 2) return null;
    var id = h.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* 原样使用 */ }
    return document.getElementById(id);
  }

  var prev = root.style.scrollBehavior;

  function instantJump() {
    var t = target();
    if (!t) return;
    root.style.scrollBehavior = 'auto';
    sync();                              /* 先更新 --hdr-h，再对齐 */
    t.scrollIntoView({ block: 'start' });
  }
  function restore() {
    root.style.scrollBehavior = prev;
  }

  if (location.hash.length > 1) {
    instantJump();
    /* 字体/懒加载图片把布局撑开后再校一次，然后恢复平滑滚动 */
    window.addEventListener('load', function () {
      instantJump();
      setTimeout(restore, 60);
    });
    setTimeout(restore, 1500);
  }
})();
