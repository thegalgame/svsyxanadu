// 图片灯箱：点击缩略图查看大图
// 支持：← → 切换、Esc 关闭、滚轮缩放（以光标为中心）、中键拖拽平移
(function () {
  var box = null, img = null, zoomBadge = null;
  var cur = 0, items = [];
  var MIN = 1, MAX = 5;          // 缩放范围 100%–500%
  var scale = 1, tx = 0, ty = 0; // 当前缩放与平移量
  var drag = null;               // 中键拖拽状态 {x, y, tx, ty}

  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'lb';
    box.innerHTML =
      '<div class="lb-bg"></div>' +
      '<button class="lb-close" type="button" aria-label="关闭">&times;</button>' +
      '<button class="lb-nav lb-prev" type="button" aria-label="上一张">&#8249;</button>' +
      '<button class="lb-nav lb-next" type="button" aria-label="下一张">&#8250;</button>' +
      '<figure class="lb-fig"><img alt=""><figcaption></figcaption></figure>' +
      '<div class="lb-zoom">100%</div>' +
      '<div class="lb-hint">滚轮缩放 · 中键拖拽平移 · ← → 切换 · Esc 关闭</div>';
    document.body.appendChild(box);
    img = box.querySelector('img');
    zoomBadge = box.querySelector('.lb-zoom');
    bindZoomPan();
    return box;
  }

  // ---------- 缩放 / 平移 ----------
  function apply() {
    img.style.transform =
      (scale === 1 && !tx && !ty) ? ''
      : 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    img.classList.toggle('zoomable', scale > 1);
    zoomBadge.textContent = Math.round(scale * 100) + '%';
    zoomBadge.classList.toggle('big', scale > 1);
  }

  function reset() {
    scale = 1; tx = 0; ty = 0;
    apply();
  }

  // 平移边界：图片缩放后不得移出可视区（以 .lb 边框为准）
  function clamp() {
    var bw = img.clientWidth, bh = img.clientHeight;
    if (!bw || !bh) return; // 图片未加载完则跳过
    var mx = Math.max(0, bw * scale / 2 - box.clientWidth / 2);
    var my = Math.max(0, bh * scale / 2 - box.clientHeight / 2);
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  }

  // 以光标 (cx, cy) 为中心缩放 factor 倍：保持光标下的图像点不动
  function zoomAt(cx, cy, factor) {
    var s0 = scale;
    var s1 = Math.min(MAX, Math.max(MIN, s0 * factor));
    if (s1 === s0) return;
    var r = img.getBoundingClientRect();
    var px = cx - (r.left + r.width / 2); // 光标相对图片中心（屏幕坐标）
    var py = cy - (r.top + r.height / 2);
    var lx = (px - tx) / s0;              // 换算成未变换的局部坐标
    var ly = (py - ty) / s0;
    scale = s1;
    tx = px - lx * s1;
    ty = py - ly * s1;
    clamp();
    apply();
  }

  function bindZoomPan() {
    // 滚轮缩放（整个灯箱区域生效；passive:false 才能 preventDefault）
    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    // 中键（button 1）拖拽平移；preventDefault 抑制 Windows 中键自动滚动
    box.addEventListener('mousedown', function (e) {
      if (e.button !== 1) return;
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, tx: tx, ty: ty };
      img.classList.add('dragging', 'notrans');
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      e.preventDefault();
      tx = drag.tx + (e.clientX - drag.x);
      ty = drag.ty + (e.clientY - drag.y);
      clamp();
      apply();
    });
    function endDrag() {
      if (!drag) return;
      drag = null;
      img.classList.remove('dragging', 'notrans');
    }
    document.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
    box.addEventListener('auxclick', function (e) {
      if (e.button === 1) e.preventDefault();
    });
    // 禁止浏览器原生图片拖拽
    box.addEventListener('dragstart', function (e) { e.preventDefault(); });
  }

  // ---------- 显示 / 隐藏 ----------
  function show(i) {
    if (!items.length) return;
    cur = (i + items.length) % items.length;
    var b = ensureBox();
    var cap = b.querySelector('figcaption');
    var a = items[cur];
    img.src = a.getAttribute('data-full') || a.getAttribute('href');
    img.alt = a.getAttribute('data-alt') || '';
    cap.textContent = a.getAttribute('data-cap') || '';
    reset();
    b.classList.add('on');
    document.body.style.overflow = 'hidden';
  }

  function hide() {
    if (!box) return;
    box.classList.remove('on');
    document.body.style.overflow = '';
    if (drag) { drag = null; img.classList.remove('dragging', 'notrans'); }
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('.fg-lb') : null;
    if (a) {
      e.preventDefault();
      items = Array.prototype.slice.call(document.querySelectorAll('.fg-lb'));
      var idx = items.indexOf(a);
      show(idx);
      var cap = a.closest('.fg');
      if (cap && cap.querySelector('figcaption')) {
        box.querySelector('figcaption').textContent =
          (cap.querySelector('figcaption').textContent || '') +
          (items.length > 1 ? '　（' + (idx + 1) + ' / ' + items.length + '）' : '');
      }
      return;
    }
    if (e.target.closest && (e.target.closest('.lb-close') || e.target.closest('.lb-bg'))) {
      hide();
      return;
    }
    if (e.target.closest && e.target.closest('.lb-prev')) { show(cur - 1); return; }
    if (e.target.closest && e.target.closest('.lb-next')) { show(cur + 1); return; }
  });

  document.addEventListener('keydown', function (e) {
    if (!box || !box.classList.contains('on')) return;
    if (e.key === 'Escape') hide();
    else if (e.key === 'ArrowLeft') show(cur - 1);
    else if (e.key === 'ArrowRight') show(cur + 1);
  });
})();
