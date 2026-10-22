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
