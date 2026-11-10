// 图片灯箱：点击缩略图查看大图
// 支持：← → 切换、Esc 关闭、滚轮缩放（以光标为中心）、中键拖拽平移
//
// 加载模型（2026-11-09 重写，解决「切换卡住」）：
//   1. 切换一律先出「压缩大图」（data-full = img_opt，全站最大 0.19MB），
//      绝不因为原图没到而空白，也绝不阻塞左右切换；
//   2. 原图（data-orig，jsDelivr，5–16MB）只在「原图优先」模式下后台拉取，
//      到达后替换当前显示；失败则保留压缩图，不重试、不串图；
//   3. 所有异步回调都核对「代次令牌 token」，切走即作废，杜绝旧请求回写画面；
//   4. 打开灯箱时预取相邻 ±2 张压缩大图（每张 ≤0.2MB），左右切换基本 0 延迟；
//   5. 灯箱顶部两条独立进度条：压缩大图 / 原图。file:// 下没有 XHR 进度，
//      自动降级为浏览器原生加载（进度行标注「本地预览」）。
(function () {
  var box = null, img = null, zoomBadge = null;
  var cur = 0, items = [];
  var MIN = 1, MAX = 5;          // 缩放范围 100%–500%
  var scale = 1, tx = 0, ty = 0; // 当前缩放与平移量
  var drag = null;               // 中键拖拽状态 {x, y, tx, ty}

  // ---------- 加载状态 ----------
  var IS_FILE = location.protocol === 'file:';
  // 跨域图片（原图在别的仓库，走 jsDelivr / raw）不能用 XHR 取 blob：
  // 那条链路会 301 到 raw.githubusercontent.com，XHR 遇跨域重定向会静默挂起，
  // 表现为进度条永远停在 0%。而浏览器原生 <img> 不受此限（file:// 下能出图就是证明），
  // 所以跨域一律走原生直载，只是拿不到精确字节进度。
  function isCross(u) {
    return /^https?:/i.test(u) && u.indexOf(location.origin + '/') !== 0;
  }
  // jsDelivr 对这批仓库一律 301 到 raw.githubusercontent.com，而 raw 在部分网络下不可达
  // ——这就是「有人能看原图、有人看不到」的成因。失败时换 ghproxy 镜像再试一次。
  function mirrorOf(u) {
    var m = /^https?:\/\/cdn\.jsdelivr\.net\/gh\/([^\/]+)\/([^@\/]+)@([^\/]+)\/(.+)$/.exec(u);
    if (!m) return null;
    return 'https://ghproxy.net/https://raw.githubusercontent.com/'
      + m[1] + '/' + m[2] + '/' + m[3] + '/' + m[4];
  }
  var token = 0;                 // 代次：每次切换 +1，旧回调据此作废
  var xhrFull = null, xhrOrig = null;
  var cacheFull = {}, keyFull = [];   // 压缩大图 blob 缓存
  var cacheOrig = {}, keyOrig = [];   // 原图 blob 缓存
  // 压缩大图（≤0.2MB）全留；原图单张 5–16MB，留 32 张够一页用（预取完的不要被立刻淘汰，
  // 否则预取了也等于白下）。再多由浏览器自己回收 blob。
  var LIM_FULL = 128, LIM_ORIG = 32;
  var pendFull = {};                  // 预取中的 URL，防重复请求
  var inflight = {};                  // url → 等待者列表（同一 URL 共享一个请求）

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
      '<div class="lb-load">' +
        '<div class="ld-row" data-k="full">' +
          '<span class="ld-lab">压缩大图</span>' +
          '<span class="ld-bar"><i></i></span>' +
          '<span class="ld-num">等待</span>' +
        '</div>' +
        '<div class="ld-row" data-k="orig">' +
          '<span class="ld-lab">原图</span>' +
          '<span class="ld-bar"><i></i></span>' +
          '<span class="ld-num">等待</span>' +
        '</div>' +
      '</div>' +
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

  // ---------- 进度条 / 缓存 / 带进度的加载 ----------
  function fmtMB(n) {
    if (!n) return '0MB';
    var m = n / 1048576;
    return (m >= 10 ? m.toFixed(0) : m.toFixed(1)) + 'MB';
  }

  // 更新某一行（'full' | 'orig'）
  // state: wait 等待 / run 加载中 / done 已完成 / fail 失败 / none 不适用
  function setRow(k, state, pct, note) {
    if (!box) return;
    var r = box.querySelector('.ld-row[data-k="' + k + '"]');
    if (!r) return;
    r.className = 'ld-row ' + state;
    var bar = r.querySelector('.ld-bar > i');
    if (bar) {
      var w = (state === 'done' || state === 'pulse') ? 100
            : (state === 'run' ? Math.max(3, Math.min(100, pct || 0)) : 0);
      bar.style.width = w + '%';
    }
    var num = r.querySelector('.ld-num');
    if (num) num.textContent = note || '';
  }

  function touch(keys, url) {
    var i = keys.indexOf(url);
    if (i >= 0) keys.splice(i, 1);
    keys.push(url);
  }

  function put(cache, keys, lim, url, blobUrl) {
    if (cache[url]) {                       // 已有同一 URL 的 blob：复用，丢弃新的
      try { URL.revokeObjectURL(blobUrl); } catch (e) {}
      touch(keys, url);
      return cache[url];
    }
    cache[url] = blobUrl;
    keys.push(url);
    while (keys.length > lim) {
      var k = keys.shift();
      var v = cache[k];
      if (v) { try { URL.revokeObjectURL(v); } catch (e) {} delete cache[k]; }
    }
    return blobUrl;
  }

  /* 原生 <img> 直载：能出图，但拿不到字节进度（file:// 与跨域不通时的保底）。
   * 主线路失败会换镜像再试一次，能显著提高「有人打得开有人打不开」的命中率。
   *
   * 必须带超时。之前没有任何超时，一张 15MB 的原图卡在 TCP 上既不 load 也不 error 时，
   * 预取队列就永远停在这一张上：回调不来 → ogActive 不减 → 主页那条原图进度
   * 永远显示「连接中」、已下载永远是 0.0 MB（设定集页 20 张原图全被这一张堵死）。
   */
  function directImg(url, live, cb, silent) {
    var pre = new Image();
    var settled = false, t1 = null, t2 = null;
    var mirror = mirrorOf(url);
    function clearT() {
      if (t1) { clearTimeout(t1); t1 = null; }
      if (t2) { clearTimeout(t2); t2 = null; }
    }
    function finish(u) {
      if (settled) return;
      settled = true; clearT();
      cb(null, u);
    }
    function stale() {                    // 已切走：也要回调，否则调用方的计数器永远等下去
      if (settled) return;
      settled = true; clearT();
      cb('stale');
    }
    function giveUp() {
      if (settled) return;
      settled = true; clearT();
      cb('direct');
    }
    pre.onload = function () { if (live()) finish(url); else stale(); };
    pre.onerror = function () {
      if (settled) return;
      if (!mirror) { giveUp(); return; }
      var pre2 = new Image();
      t2 = setTimeout(giveUp, 60000);
      pre2.onload = function () { if (live()) finish(mirror); else stale(); };
      pre2.onerror = giveUp;
      pre2.src = mirror;
    };
    pre.src = url;
    t1 = setTimeout(giveUp, 60000);       // 单张 60 秒不落地就判失败，让队列往下走
    return {
      abort: function () {
        if (settled) return;
        settled = true; clearT();
        pre.onload = pre.onerror = null;
        pre.src = '';
        cb('abort');
      },
      __got: 1           // 视为「已在走直连」，不再触发 XHR 兜底
    };
  }

  /* 跨域原图：fetch + ReadableStream 流式读取，能拿到真实字节数与速度。
   * 与 XHR 的区别是失败会 reject（XHR 遇到跨域重定向会静默挂起，进度永远停在 0%）。
   *
   * 三道闸门，任何一条断了都不会让队列卡住：
   *   1) 首字节超时：CDN 冷节点首包经常十几秒，给 20 秒，超时换一条新连接重试一次；
   *      两条都不通才退回原生 <img>（那条路有 60 秒超时）。
   *   2) 空转超时：已经收到过字节、之后 30 秒没有新数据 → 判 stall，保留压缩图。
   *   3) 组内共享：同一 URL 只有一条流（见 loadCross），预取与点开不再各下一份十几 MB。
   */
  function fetchStream(url, kind, grp, done) {
    if (!window.fetch || !window.AbortController || !window.ReadableStream) return null;

    var cache = kind === 'full' ? cacheFull : cacheOrig;
    var keys = kind === 'full' ? keyFull : keyOrig;
    var lim = kind === 'full' ? LIM_FULL : LIM_ORIG;
    var settled = false, ctrl = null, reader = null, first = null, idle = null;
    var attemptNo = 0, got = 0;

    function clearT() {
      if (first) { clearTimeout(first); first = null; }
      if (idle) { clearTimeout(idle); idle = null; }
    }
    function ui(state, pct, text) {
      if (grp.silent) return;      // 组里只剩后台预取在等，别去抢灯箱的进度行
      setRow(kind, state, pct, text);
    }
    var lastPaint = 0;
    function emit(loaded, total) {
      if (loaded > (grp.bytes || 0)) grp.bytes = loaded;
      var ws = grp.waiters;
      for (var i = 0; i < ws.length; i++) {
        if (ws[i].onProg) ws[i].onProg(loaded, total);
      }
      // 灯箱那一行也报真实字节：原来跨域只写「连接中…」，十几 MB 走几十秒，
      // 用户根本看不出到底动没动。300ms 节流，避免每 16KB 就写一次 DOM。
      if (grp.silent) return;
      var now = Date.now();
      if (now - lastPaint < 300) return;
      lastPaint = now;
      if (total > 0) {
        setRow(kind, 'run', loaded / total * 100,
          fmtMB2(loaded) + ' / ' + fmtMB2(total) + ' MB（' + Math.round(loaded / total * 100) + '%）');
      } else {
        setRow(kind, 'run', 0, '已下载 ' + fmtMB2(loaded) + ' MB');
      }
    }
    function stop() {
      clearT();
      try { if (reader) reader.cancel(); } catch (e) {}
      try { if (ctrl) ctrl.abort(); } catch (e) {}
    }
    function finish(err, blobUrl) {
      if (settled) return;
      settled = true;
      if (err) stop(); else clearT();
      done(err, blobUrl || null);
    }
    function viaImg() {                 // 流式两条线路都不通 → 原生 <img> 直载
      if (settled) return;
      settled = true;
      stop();
      directImg(url, function () { return true; }, done, grp.silent);
    }

    function attempt() {
      attemptNo++;
      try { ctrl = new AbortController(); } catch (e) { return viaImg(); }
      var wait = attemptNo === 1 ? (kind === 'orig' ? 20000 : 12000) : 30000;
      ui('pulse', 100, attemptNo === 1 ? '连接中…' : '换线路重试…');
      first = setTimeout(function () {
        if (settled || got > 0) return;
        stop();
        if (attemptNo < 2) attempt(); else viaImg();
      }, wait);

      fetch(url, { signal: ctrl.signal, mode: 'cors', credentials: 'omit' })
        .then(function (res) {
          if (settled) return;
          if (!res.ok) { finish('http ' + res.status); return; }
          var total = parseInt(res.headers.get('content-length'), 10) || 0;
          var ctype = res.headers.get('content-type') || 'image/png';
          if (!res.body || !res.body.getReader) {
            return res.arrayBuffer().then(function (ab) {
              if (settled) return;
              got = ab.byteLength;
              emit(got, got || total);
              finish(null, put(cache, keys, lim, url,
                   URL.createObjectURL(new Blob([ab], { type: ctype }))));
            });
          }
          reader = res.body.getReader();
          var chunks = [], size = 0;
          function pump() {
            reader.read().then(function (r) {
              if (settled) return;
              if (r.done) {
                finish(null, put(cache, keys, lim, url,
                     URL.createObjectURL(new Blob(chunks, { type: ctype }))));
                return;
              }
              chunks.push(r.value);
              size += (r.value && r.value.length) || 0;
              got = size;
              if (first) { clearTimeout(first); first = null; }   // 首字节已到
              if (idle) clearTimeout(idle);
              idle = setTimeout(function () {
                if (settled) return;
                finish('stall');     // 断流：保留压缩图，不再挂着
              }, 30000);
              emit(size, total);
              pump();
            }).catch(function () {
              if (settled) return;
              if (got > 0) { finish('read'); return; }
              stop();
              if (attemptNo < 2) attempt(); else viaImg();
            });
          }
          pump();
        })
        .catch(function () {
          if (settled) return;
          if (got > 0) { finish('fetch'); return; }
          stop();
          if (attemptNo < 2) attempt(); else viaImg();
        });
    }

    attempt();
    return {
      abort: function () { if (settled) return; settled = true; stop(); },
      __got: 0
    };
  }

  /* 跨域 URL 共享一条流：预取与「点开」撞到同一张时不再各下一份。
   * 之前设定集页一张 15MB 的原图要被下两遍，速度直接腰斩，
   * 而进度条只统计预取那一路，看上去就像卡死。
   */
  var inflightX = {};                   // kind|url → { waiters, silent, bytes, handle }
  function killIfAlone(g, key) {
    for (var i = 0; i < g.waiters.length; i++) if (!g.waiters[i].dead) return;
    if (inflightX[key] === g) delete inflightX[key];
    if (g.handle) { try { g.handle.abort(); } catch (e) {} }
  }
  function loadCross(url, kind, live, cb, silent, onProg) {
    var key = kind + '|' + url;
    var g = inflightX[key];
    var w = { live: live, cb: cb, onProg: onProg, dead: false };
    if (g) {
      g.waiters.push(w);
      if (!silent) g.silent = false;    // 有前台等待者，进度行照常刷
      return {
        abort: function () { w.dead = true; killIfAlone(g, key); },
        __got: g.bytes || 0
      };
    }
    g = inflightX[key] = { waiters: [w], silent: !!silent, bytes: 0, handle: null };
    var h = fetchStream(url, kind, g, function (err, u) {
      if (inflightX[key] === g) delete inflightX[key];
      var ws = g.waiters;
      for (var i = 0; i < ws.length; i++) {
        if (!ws[i].dead && ws[i].live()) ws[i].cb(err, u);
      }
    });
    if (!h) { delete inflightX[key]; return directImg(url, live, cb, silent); }
    g.handle = h;
    return {
      abort: function () { w.dead = true; killIfAlone(g, key); },
      __got: 0
    };
  }

  /* 带进度的图片加载。
   * url   目标地址（相对或 jsDelivr 绝对地址）
   * kind  'full' | 'orig'，决定缓存池、上限与进度行
   * live  () => boolean，返回 false 表示这次请求已过期（用户切走了）
   * cb    (err, displayUrl)  err 为字符串时表示失败
   * silent  true = 后台预取：不改进度行、失败静默
   * onProg (loaded, total)  仅 XHR 路径可用；silent 时也会回调，供页面预取条统计字节
   * 返回可 abort 的 XHR（已命中缓存或 file:// 降级时返回 null）
   *
   * 同一 URL 只发一个请求：预取与手动打开撞车时共享结果，
   * 避免「两次下载同一张、后到的把前一个 blob 撤销」导致图裂。
   */
  function loadImg(url, kind, live, cb, silent, onProg) {
    var cache = kind === 'full' ? cacheFull : cacheOrig;
    var keys = kind === 'full' ? keyFull : keyOrig;
    var lim = kind === 'full' ? LIM_FULL : LIM_ORIG;

    if (cache[url]) {                       // 命中缓存：0 延迟
      touch(keys, url);
      cb(null, cache[url]);
      return null;
    }
    if (IS_FILE) {
      // file:// 下 XHR 被 CORS 挡，只能原生 <img> 直载（拿不到字节进度）
      if (!silent) setRow(kind, 'run', 0, '本地预览');
      return directImg(url, live, cb, silent);
    }
    if (isCross(url)) {
      // 跨域原图：先试 fetch 流式（能拿真实字节与速度），不通再退回 <img> 直载；
      // 同一 URL 的多个请求由 loadCross 合并成一条流
      return loadCross(url, kind, live, cb, silent, onProg);
    }
    // 已有同 URL 的在途请求：挂上去等结果，不重复下载
    if (inflight[url]) {
      inflight[url].push({ live: live, cb: cb, silent: !!silent, onProg: onProg });
      return null;
    }

    var waiters = inflight[url] = [{ live: live, cb: cb, silent: !!silent, onProg: onProg }];
    function settle(err, u) {
      if (inflight[url] === waiters) delete inflight[url];
      for (var i = 0; i < waiters.length; i++) {
        if (waiters[i].live()) waiters[i].cb(err, u);
      }
    }

    if (!silent) setRow(kind, 'run', 0, '0%');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.timeout = 120000;

    // 迟迟拿不到首字节时给出「在连」的说明，避免 0% 看起来像卡死
    var gotByte = false;
    var stall = setTimeout(function () {
      if (gotByte) return;
      for (var i = 0; i < waiters.length; i++) {
        if (waiters[i].live() && !waiters[i].silent) {
          setRow(kind, 'run', 4, '连接中…（原图在境外 CDN，较慢）');
          break;
        }
      }
    }, 8000);
    xhr.__got = 0;
    xhr.onprogress = function (e) {
      xhr.__got = e.loaded || 0;
      var tot = (e.lengthComputable && e.total > 0) ? e.total : 0;
      // 先喂给字节统计（页面预取条用），silent 的预取也要算进去
      for (var w = 0; w < waiters.length; w++) {
        if (waiters[w].onProg) waiters[w].onProg(e.loaded || 0, tot);
      }
      var showProg = false;
      for (var i = 0; i < waiters.length; i++) {
        if (waiters[i].live() && !waiters[i].silent) { showProg = true; break; }
      }
      if (!showProg) return;
      if (tot > 0) {
        var p = e.loaded / e.total * 100;
        var got = (e.loaded / 1048576).toFixed(1);
        setRow(kind, 'run', p, Math.floor(p) + '% ' + got + '/' + fmtMB(e.total));
      } else {
        setRow(kind, 'run', 15, fmtMB(e.loaded));
      }
      gotByte = true;
    };
    xhr.onload = function () {
      clearTimeout(stall);
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        settle(null, put(cache, keys, lim, url, URL.createObjectURL(xhr.response)));
      } else {
        settle('http ' + xhr.status);
      }
    };
    xhr.onerror = function () { clearTimeout(stall); settle('error'); };
    xhr.ontimeout = function () { clearTimeout(stall); settle('timeout'); };
    xhr.onabort = function () { clearTimeout(stall); settle('abort'); };
    xhr.send();
    return xhr;
  }

  // 先解码再换 src：避免「旧图消失 → 空白 → 新图」的闪断。
  // 解码失败就保持原样（不把 img.src 设成坏地址，否则整张图会破掉）。
  function swapIn(url, live) {
    var pre = new Image();
    pre.onload = function () { if (live()) { img.src = url; } };
    pre.src = url;
  }

  // 预取相邻 ±2 张压缩大图（每张 ≤0.2MB，代价极低），让左右切换近乎 0 延迟
  function prefetchNear(i) {
    var n = items.length;
    if (n < 2) return;
    var order = [i + 1, i - 1, i + 2, i - 2];
    for (var m = 0; m < order.length; m++) {
      var j = ((order[m] % n) + n) % n;
      if (j === i) continue;
      var el = items[j];
      if (!el) continue;
      var u = el.getAttribute('data-full') || el.getAttribute('href');
      if (!u || cacheFull[u] || pendFull[u]) continue;
      pendFull[u] = 1;
      (function (target) {
        loadImg(target, 'full', function () { return true; }, function () {
          delete pendFull[target];
        }, true);
      })(u);
    }
  }

  // ---------- 页面级预取：不点开也把本页大图备好 ----------
  // 之前只有打开灯箱才拉 data-full，用户在页面上停留再久，灯箱要的图也一个字节都没下过。
  // 现在进页面就按顺序把本页所有压缩大图（img_opt，单张 ≤0.2MB）抓进 blob 缓存，
  // 点开即显示；队列一张接一张，只要没抓完就不让网络闲着。
  var pfQueue = [], pfIdx = 0, pfTotal = 0, pfDone = 0, pfActive = 0, pfFails = 0;
  var PF_PARALLEL = 2;          // 并发：留出连接给「点开插队」，不至于被预取占满
  var pfEl = null, pfRow = null, pfFill = null, pfNum = null;
  var pfCnt = null, pfByte = null, pfSpd = null;

  /* ---------- 字节与速度统计（两条预取进度条共用） ----------
   * 只显示真实数字：同源 img_opt 走 XHR，能拿到 lengthComputable；
   * 跨域原图走 <img> 直载拿不到过程中的字节，只在完成时用 resource timing
   * 的 transferSize/decodedBodySize 补一次，拿不到就不显示字节那一段。
   */
  function mkStat(total) {
    // fixed=true 表示总量来自构建时写入的 data-size，是精确值，不再随下载变化
    return { got: 0, known: total || 0, fixed: !!total, samp: [], t0: Date.now() };
  }
  var pfStat = mkStat(), ogStat = mkStat();

  function statProg(st, job, loaded, total) {
    var d = loaded - (job.got || 0);
    if (d > 0) st.got += d;
    job.got = loaded;
    if (total > 0) {
      if (!st.fixed && total !== job.size) st.known += total - (job.size || 0);
      job.size = total;
    }
    var now = Date.now(), s = st.samp;
    if (!s.length || now - s[s.length - 1].t >= 200) s.push({ t: now, b: st.got });
    while (s.length > 2 && now - s[0].t > 2000) s.shift();
  }

  function statSpeed(st) {
    var s = st.samp, now = Date.now();
    while (s.length > 2 && now - s[0].t > 2000) s.shift();
    if (s.length < 2) return 0;
    var a = s[0], b = s[s.length - 1];
    var dt = (b.t - a.t) / 1000;
    if (dt <= 0) return 0;
    if (now - b.t > 2500) return 0;      // 两秒多没有新字节，视为停下，不要挂个假速度
    return Math.max(0, (b.b - a.b) / dt);
  }

  function fmtMB2(n) {
    var m = (n || 0) / 1048576;
    return m >= 10 ? m.toFixed(0) : m.toFixed(1);
  }

  function fmtSpd(v) {
    if (v >= 1048576) return (v / 1048576).toFixed(2) + ' MB/s';
    if (v >= 1024) return Math.round(v / 1024) + ' KB/s';
    return Math.round(v) + ' B/s';
  }

  // 跨域直连拿不到过程中字节，完成后从资源时间线补一次真实体积
  function resSize(url) {
    try {
      var abs = url;
      try { abs = new URL(url, location.href).href; } catch (e0) {}
      var es = performance.getEntriesByName(abs, 'resource');
      if (!es || !es.length) es = performance.getEntriesByName(url, 'resource');
      if (!es || !es.length) return 0;
      var e = es[es.length - 1];
      return e.transferSize || e.decodedBodySize || 0;
    } catch (err) { return 0; }
  }

  /* 画一行：个数 + 已下载/共 + 速度
   * 写法示例：0 / 20　已下载 0.3 MB / 共 1.7 MB　0.42 MB/s
   * 总量未知时（原图体积拿不到）只显示已下载，不编造分母。
   */
  function paintBar(row, fill, cnt, byte, spd, done, total, st, fin, busy, fails, label) {
    if (!row || !fill) return;
    label = label || '图片';
    var pct = total ? (done / total * 100) : 0;
    fill.style.width = pct + '%';
    row.classList.toggle('done', !!fin && !(fails > 0 && fails >= done));
    row.classList.toggle('bad', !!fin && fails > 0 && fails >= done);
    row.classList.toggle('pulse', !!busy && !fin);
    if (cnt) cnt.textContent = done + ' / ' + total;
    if (byte) {
      if (fin) {
        if (fails > 0 && fails >= total) {
          byte.textContent = label + '线路不可用（' + total + ' 张全部取不到）';
        } else if (fails > 0) {
          byte.textContent = '共 ' + total + ' 张，' + fails + ' 张取不到'
            + (st.got ? ' · 已下载 ' + fmtMB2(st.got) + ' MB' : '');
        } else {
          byte.textContent = st.got ? '已全部缓存 · ' + fmtMB2(st.got) + ' MB' : '已全部缓存';
        }
      } else if (st.fixed && st.known > 0) {
        // 只有「构建期写死的整页总量」才配分母；原图是边下边累计，
        // 分母永远等于已下载量，会看着像一直满格，所以只报已下载量。
        byte.textContent = '已下载 ' + fmtMB2(st.got) + ' MB / 共 ' + fmtMB2(st.known) + ' MB';
      } else if (st.got > 0) {
        byte.textContent = '已下载 ' + fmtMB2(st.got) + ' MB';
      } else if (busy) {
        // 挂上秒数：真的在连（十几 MB 的原图首包就要十几秒）还是彻底卡死，
        // 光看「连接中…」分不出来，数字在走才说明还在试
        var sec = st.t0 ? Math.round((Date.now() - st.t0) / 1000) : 0;
        byte.textContent = '连接中…' + (sec > 0 ? ' ' + sec + 's' : '');
      } else {
        byte.textContent = '';
      }
    }
    if (spd) {
      var v = fin ? 0 : statSpeed(st);
      spd.textContent = v > 0 ? fmtSpd(v) : '';
    }
  }

  function pfBuildUI() {
    if (pfEl || !document.querySelector('.fg-lb')) return;
    if (pfTotal < 3) return;      // 只有一两张图的页面不值得占一条进度
    pfEl = document.createElement('div');
    pfEl.className = 'pf-box';
    pfEl.innerHTML =
      '<div class="pf-row">' +
        '<span class="pf-lab">本页大图</span>' +
        '<span class="pf-bar"><i></i></span>' +
        '<span class="pf-num">' +
          '<b class="pf-cnt">0 / 0</b>' +
          '<span class="pf-byte"></span>' +
          '<span class="pf-spd"></span>' +
        '</span>' +
      '</div>' +
      '<div class="pf-row pf-orig-row" hidden>' +
        '<span class="pf-lab">原图</span>' +
        '<span class="pf-bar"><i></i></span>' +
        '<span class="pf-num">' +
          '<b class="pf-cnt">0 / 0</b>' +
          '<span class="pf-byte"></span>' +
          '<span class="pf-spd"></span>' +
        '</span>' +
      '</div>';
    var h1 = document.querySelector('h1');
    if (h1 && h1.parentNode) h1.parentNode.insertBefore(pfEl, h1.nextSibling);
    else document.body.appendChild(pfEl);
    pfRow = pfEl.querySelector('.pf-row:not(.pf-orig-row)');
    pfFill = pfRow.querySelector('.pf-bar > i');
    pfNum = pfRow.querySelector('.pf-num');
    pfCnt = pfRow.querySelector('.pf-cnt');
    pfByte = pfRow.querySelector('.pf-byte');
    pfSpd = pfRow.querySelector('.pf-spd');
    ogRow = pfEl.querySelector('.pf-orig-row');
    ogFill = ogRow.querySelector('.pf-bar > i');
    ogNum = ogRow.querySelector('.pf-num');
    ogCnt = ogRow.querySelector('.pf-cnt');
    ogByte = ogRow.querySelector('.pf-byte');
    ogSpd = ogRow.querySelector('.pf-spd');
  }

  // 原图预取：单并发、只在「原图优先」模式下跑。
  // 压缩优先模式不碰原图——一页 20 张原图 100~300MB，不该在用户没要求时烧流量。
  var ogRow = null, ogFill = null, ogNum = null, ogCnt = null, ogByte = null, ogSpd = null;
  var ogQueue = [], ogIdx = 0, ogTotal = 0, ogDone = 0, ogActive = 0, ogStarted = false, ogFails = 0;
  var ogStreak = 0;      // 连续失败数：原图线路整体不通时不要一张一张地干等

  function ogPaint() {
    if (!ogRow) return;
    var fin = ogTotal > 0 && ogDone >= ogTotal;
    paintBar(ogRow, ogFill, ogCnt, ogByte, ogSpd, ogDone, ogTotal, ogStat, fin, ogActive > 0, ogFails, '原图');
  }

  function ogPump() {
    // 连续 3 张都取不到，说明这条线路整体不通，剩下的直接判失败，
    // 否则每张都要等一次 8 秒超时，用户要干等好几分钟。
    if (ogStreak >= 3) {
      while (ogIdx < ogQueue.length) {
        var rest = ogQueue[ogIdx++];
        if (rest && !rest.done) { rest.done = true; ogDone++; ogFails++; }
      }
      ogPaint();
      return;
    }
    while (ogActive < 1 && ogIdx < ogQueue.length) {
      var job = ogQueue[ogIdx++];
      if (!job || job.done) continue;
      if (cacheOrig[job.url]) {
        job.done = true; ogDone++;
        var osz = resSize(job.url);
        if (osz > 0) statProg(ogStat, job, osz, osz);
        continue;
      }
      ogActive++;
      (function (j) {
        // 收尾只许执行一次：兜底超时与正常回调谁先到算谁的，另一个直接返回。
        // （两处各减一次 ogActive 会让计数变负，进度条状态跟着错乱。）
        var closed = false, wd = null;
        function end(err) {
          if (closed) return;
          closed = true;
          if (wd) clearTimeout(wd);
          ogActive--;
          if (!j.done) { j.done = true; ogDone++; }
          if (err) { ogFails++; ogStreak++; } else { ogStreak = 0; }
          // fetch 拿不到时（退回 <img> 直载）完成后用资源时间线的体积补一次
          if (!err && !(j.got > 0)) {
            var sz = resSize(j.url);
            if (sz > 0) statProg(ogStat, j, sz, sz);
          }
          ogPaint();
          setTimeout(ogPump, 0);
        }
        // 兜底闸门：慢网下单张十几 MB 要几分钟，判得宽（5 分钟），但必须有——
        // 任何一条路径漏了回调，都不允许它把整条进度永远按住。
        wd = setTimeout(function () { end('timeout'); }, 300000);
        loadImg(j.url, 'orig', function () { return true; }, function (err, u) {
          end(err);
        }, true, function (loaded, total) {
          statProg(ogStat, j, loaded, total);   // fetch 流式读到的真实字节
          ogPaint();
        });
      })(job);
      ogPaint();   // 让「连接中…」立刻出现，而不是等这一张下完
      return;      // 单并发：原图动辄十几 MB，多开只会互相拖慢
    }
    ogPaint();
  }

  function ogStart() {
    if (ogStarted) return;
    // 两种模式都要把原图备好：压缩优先只是「先出压缩图、原图随后替换」，
    // 并不是不加载原图。顺序上仍然排在压缩大图之后、单并发，避免抢首屏带宽。
    var els = document.querySelectorAll('.fg-lb[data-orig]');
    if (!els.length) return;
    var seen = {}, list = [];
    for (var i = 0; i < els.length; i++) {
      var u = els[i].getAttribute('data-orig');
      if (!u || seen[u]) continue;
      seen[u] = 1;
      list.push({ url: u, done: false });
    }
    ogStarted = true;
    ogQueue = list;
    ogTotal = list.length;
    ogStat = mkStat(0);          // 原图体积构建时不可靠，只能边下边累计
    if (ogRow) ogRow.hidden = false;
    ogPaint();
    ogPump();
    pfTicker();
  }
  /* 灯箱自己把某张原图下完（用户点开的那张往往抢在预取队列前面），
   * 立刻在主页面那条进度里算数——否则会出现「灯箱已经显示原图了，
   * 页面上还写着连接中 0.0 MB」这种自相矛盾的画面。
   */
  function ogNote(url) {
    if (!ogStarted || !url) return;
    for (var i = ogIdx; i < ogQueue.length; i++) {
      var j = ogQueue[i];
      if (j.url !== url || j.done) continue;
      j.done = true; ogDone++;
      var sz = resSize(url);
      if (sz > 0) statProg(ogStat, j, sz, sz);
      ogPaint();
      // 队列可能已经空了，把它推下去（ogPump 内部幂等）
      setTimeout(ogPump, 0);
      return;
    }
  }
  window.__ogNote = ogNote;

  window.__pfOrigStart = ogStart;   // 模式切换成「原图优先」时由此启动

  function pfPaint() {
    if (!pfEl || !pfRow) return;
    var fin = pfTotal > 0 && pfDone >= pfTotal;
    paintBar(pfRow, pfFill, pfCnt, pfByte, pfSpd, pfDone, pfTotal, pfStat, fin, false, pfFails, '大图');
  }

  /* 定时刷新：网络停住时 progress 不再触发，靠这个把速度降回 0，
   * 否则界面会一直挂着「0.42 MB/s」这种早就过期的数字。
   */
  var pfTimer = null;
  function pfTicker() {
    if (pfTimer) return;
    pfTimer = setInterval(function () {
      pfPaint();
      ogPaint();
      var allDone = (pfTotal > 0 && pfDone >= pfTotal) && (!ogStarted || ogDone >= ogTotal);
      if (allDone) { clearInterval(pfTimer); pfTimer = null; }
    }, 500);
  }

  function pfPump() {
    while (pfActive < PF_PARALLEL && pfIdx < pfQueue.length) {
      var job = pfQueue[pfIdx++];
      if (!job || job.done) continue;
      if (cacheFull[job.url]) {
        job.done = true; pfDone++;
        var csz = resSize(job.url);          // 命中缓存也要计入已下载体积
        if (csz > 0) statProg(pfStat, job, csz, csz);
        continue;
      }
      pfActive++;
      (function (j) {
        // live 恒 true：预取结果与灯箱当前显示哪张无关，切图不该丢弃已下完的缓存
        loadImg(j.url, 'full', function () { return true; }, function (err) {
          pfActive--;
          if (!j.done) { j.done = true; pfDone++; }
          if (err) pfFails++;
          // 收尾补齐：最后一个 progress 事件可能没到
          if (j.size && (j.got || 0) < j.size) statProg(pfStat, j, j.size, j.size);
          pfPaint();
          if (pfDone >= pfTotal) ogStart();   // 压缩大图备齐后，若选了「原图优先」接着抓原图
          setTimeout(pfPump, 0);   // 一张接一张，不空转
        }, true, function (loaded, total) {
          statProg(pfStat, j, loaded, total);
          pfPaint();
        });
      })(job);
    }
    pfPaint();
    if (pfTotal && pfDone >= pfTotal) ogStart();
  }

  function pfStart() {
    var els = document.querySelectorAll('.fg-lb');
    if (!els.length) return;
    var seen = {}, list = [], szTotal = 0;
    for (var i = 0; i < els.length; i++) {
      var u = els[i].getAttribute('data-full') || els[i].getAttribute('href');
      if (!u || seen[u]) continue;
      seen[u] = 1;
      list.push({ url: u, done: false });
      szTotal += parseInt(els[i].getAttribute('data-size'), 10) || 0;   // 构建时写入的精确体积
    }
    pfQueue = list;
    pfTotal = list.length;
    pfStat = mkStat(szTotal);
    pfBuildUI();
    pfPaint();
    pfTicker();
    pfPump();
  }

  // 供灯箱调用：点开某张时把它提到队首（已在队列里就不动，靠 inflight 共享避免重复下载）
  function pfPrioritize(url) {
    if (!url) return;
    for (var i = pfIdx; i < pfQueue.length; i++) {
      if (pfQueue[i].url === url && !pfQueue[i].done) {
        var j = pfQueue.splice(i, 1)[0];
        pfQueue.splice(pfIdx, 0, j);
        pfPump();
        return;
      }
    }
  }


  function show(i) {
    if (!items.length) return;
    cur = (i + items.length) % items.length;
    var b = ensureBox();
    var a = items[cur];
    var myTok = ++token;
    function live() { return token === myTok; }

    // 切走即中止上一张的请求，释放连接（否则慢网下连接池被占满，越切越卡）
    if (xhrFull) { try { xhrFull.abort(); } catch (e) {} xhrFull = null; }
    if (xhrOrig) { try { xhrOrig.abort(); } catch (e) {} xhrOrig = null; }

    var full = a.getAttribute('data-full') || a.getAttribute('href');
    var orig = a.getAttribute('data-orig');
    var pri = window.__origPriority ? window.__origPriority() : 'compressed';
    if (window.__lazyNow) window.__lazyNow(a);   // 顺手确保页面上的缩略图本体也在加载
    pfPrioritize(full);                          // 点开即插队，不必等预取排到它

    img.alt = a.getAttribute('data-alt') || '';
    var capText = a.getAttribute('data-cap') || '';
    if (items.length > 1) {
      capText = (capText ? capText + '　' : '') + '（' + (cur + 1) + ' / ' + items.length + '）';
    }
    b.querySelector('figcaption').textContent = capText;
    b.classList.add('on');
    document.body.style.overflow = 'hidden';
    img.classList.remove('orig-loading');
    reset();

    // 原图行先摆出预期状态，避免用户以为「没反应」
    if (!orig) setRow('orig', 'none', 0, '无原图存档');
    else if (pri === 'orig') setRow('orig', 'wait', 0, '马上加载原图');
    else setRow('orig', 'wait', 0, '先显示压缩图，随后载入原图');

    // 1) 压缩大图：有缓存 0 延迟；否则边下边显示进度
    if (cacheFull[full]) {
      touch(keyFull, full);
      img.src = cacheFull[full];
      setRow('full', 'done', 100, '已就绪（缓存）');
    } else {
      setRow('full', 'run', 0, '0%');
      xhrFull = loadImg(full, 'full', live, function (err, u) {
        if (!live()) return;
        if (err) {
          // 取不到 blob（CORS / 断网）时退回浏览器原生加载，仍然能看图
          setRow('full', 'run', 0, '改用直连');
          img.src = full;
          return;
        }
        swapIn(u, live);
        setRow('full', 'done', 100, '已就绪');
      });
    }

    // 2) 原图：两种模式都加载，最终在灯箱内替换为原图（不需要新开标签页）
    //    「原图优先」立即并行拉取；「压缩优先」等压缩图先画出来（260ms）再拉，
    //    避免原图抢带宽把首屏拖慢。失败/超时一律保留压缩图，不重试、不串图。
    if (orig) {
      var origDone = false;
      var startOrig = function () {
        if (!live() || origDone) return;
        img.classList.add('orig-loading');

        // 兜底通道：XHR 久无字节时，改用普通 Image 直接加载。
        // 普通 img 不受 XHR 的 CORS 限制，只要浏览器能显示就能出来——
        // 这也是「另开标签页才看得到原图」时那条能走通的路。
        // 兜底通道只对同域 XHR 有意义：跨域本身已走原生 Image 直载，无需再兜一次
        var fallback = null;
        if (!isCross(orig)) {
          fallback = setTimeout(function () {
            if (origDone || !live()) return;
            // 已经在收字节说明线路可用，只是慢——继续等，不要另起一个请求抢带宽
            if (xhrOrig && xhrOrig.__got > 0) return;
            setRow('orig', 'pulse', 100, '直连加载中…');
            var pre = new Image();
            pre.onload = function () {
              if (origDone || !live()) return;
              origDone = true;
              if (xhrOrig) { try { xhrOrig.abort(); } catch (e) {} xhrOrig = null; }
              img.src = orig;                    // 浏览器已缓存，换上即显示
              img.classList.remove('orig-loading');
              setRow('orig', 'done', 100, '已显示原图');
            };
            pre.src = orig;
          }, 10000);
        }

        xhrOrig = loadImg(orig, 'orig', live, function (err, u) {
          if (origDone || !live()) return;
          clearTimeout(fallback);
          if (err) {
            setRow('orig', 'fail', 0,
              err === 'direct' ? '直连失败，保留压缩图'
              : err === 'timeout' ? '超时，保留压缩图' : '失败，保留压缩图');
            img.classList.remove('orig-loading');
            return;
          }
          origDone = true;
          swapIn(u, live);
          img.classList.remove('orig-loading');
          setRow('orig', 'done', 100, '已显示原图');
          if (window.__ogNote) window.__ogNote(orig);   // 让页面那条进度立刻算数
        });
      };
      if (pri === 'orig') startOrig();
      else setTimeout(startOrig, 260);
    }

    prefetchNear(cur);
  }

  function hide() {
    if (!box) return;
    token++;                        // 作废所有在途回调
    if (xhrFull) { try { xhrFull.abort(); } catch (e) {} xhrFull = null; }
    if (xhrOrig) { try { xhrOrig.abort(); } catch (e) {} xhrOrig = null; }
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
      if (idx < 0) return;
      show(idx);
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

  // 供「原图/压缩图 优先」按钮调用：切换模式后立即按新策略重载当前图
  window.__lbRefresh = function () {
    if (box && box.classList.contains('on')) show(cur);
  };

  // 等首屏自己的图先跑完，再开始后台预取，避免抢首屏带宽
  if (document.readyState === 'complete') setTimeout(pfStart, 300);
  else window.addEventListener('load', function () { setTimeout(pfStart, 300); });
})();

/* ---------- 图片懒加载（GitHub / github.io 加载优化） ----------
 * github.io 走 Fastly CDN，支持 HTTP/2 多路复用：浏览器自行调度并发比人工限流更快，
 * 早期版本的 4 并发队列反而把请求排成队，出现「从上往下一点点加载」、
 * 首屏长时间转圈、点开大图也打不开。现改为：
 *   - HTML 直接输出占位图 + data-src，浏览器从一开始就不会下载真实图片，
 *     进入视口（含 600px 预载边缘）立即加载，不排队、不渐入；
 *     （早期是「src 写真实地址、脚本再把 src 换成占位图」，但浏览器的预扫描
 *      在脚本执行前就已经把图片下了一半，换成占位图会把这些请求全部 abort，
 *      再从头下一遍——白烧一个往返，线上反而比原生 img 更慢。）
 *   - 小图（表情包，标记 data-eager）不接管，随页面直接并行加载；
 *   - 折叠区（未展开的 <details>）内的图片不预载，展开时才加载；
 *   - 失败自动退避重试 2 次；
 *   - 灯箱打开时经 window.__lazyNow 立即加载目标图。
 * 注意：本段在 lightbox.js 与 search.js 各有一份（改动需保持同步），
 * window.__lazyReady 保证同页两份共存时只初始化一次。
 */
(function () {
  if (window.__lazyReady) return;
  window.__lazyReady = true;

  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var io = null;

  function start(im) {
    var src = im.getAttribute('data-src');
    if (!src) return;
    im.removeAttribute('data-src');
    im.__lazyWant = src;
    var finish = function () {
      if (im.__lazyWant !== src) return;   // 占位图(data:)触发的事件，忽略
      im.__lazyWant = null;
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
      }
    });
    im.src = src;
  }

  function onSeen(entries) {
    for (var i = 0; i < entries.length; i++) {
      var im = entries[i].target;
      if (!entries[i].isIntersecting || !im.hasAttribute('data-src')) continue;
      io.unobserve(im);
      start(im);
    }
  }

  function init() {
    var imgs = document.querySelectorAll('img');
    var queue = [];
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im.hasAttribute('data-eager')) continue;      // 小图直载，不接管
      if (!im.hasAttribute('data-src')) {
        /* 兼容旧页面（HTML 只给了真实 src）：迁移成 data-src。
           这条分支会 abort 掉浏览器已经开始的下载，新页面不走这里。 */
        var src = im.getAttribute('src');
        if (!src || src.indexOf('data:') === 0) continue;
        im.setAttribute('data-src', src);
        im.src = BLANK;
      }
      queue.push(im);
    }

    if (!('IntersectionObserver' in window)) {          // 老浏览器：一次性全加载
      for (var j = 0; j < queue.length; j++) start(queue[j]);
      return;
    }
    /* 预载边缘 400px：线上有效吞吐只有 20~35KB/s，提前 600px 预载等于抢走
       当前屏的带宽；400px 约半屏，滚动时仍不会露白。 */
    io = new IntersectionObserver(onSeen, { rootMargin: '400px 0px', threshold: 0 });
    for (var k = 0; k < queue.length; k++) io.observe(queue[k]);
  }

  // 立即加载指定图片（灯箱打开时调用）
  window.__lazyNow = function (el) {
    if (!io) return;
    var im = el && el.tagName
      ? (el.tagName === 'IMG' ? el : el.querySelector('img[data-src]')) : null;
    if (!im) return;
    io.unobserve(im);
    start(im);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ---------- 原图 / 压缩图 优先切换 ----------
 * 两种模式的区别现在很明确（2026-11-09 重写）：
 *   压缩优先（默认）——只加载 img_opt 压缩大图（全站单张 ≤0.2MB，秒开），
 *                     不请求原图，省流量、切换最快；
 *   原图优先        ——仍先显示压缩大图兜底（绝不空白），后台并行拉原图，
 *                     到达后替换为原图；失败/超时保留压缩图，不影响切换。
 * 两种模式都不会阻塞左右切换。灯箱顶部有两条独立进度条（压缩大图 / 原图）。
 * 仅当页面存在 data-orig 时才显示按钮（当前未挂原图则不出现）。
 * 按钮与提示贴在页面标题（h1）之后，不再固定在右下角。
 * 切换模式时若灯箱正开着，立即按新策略重载当前图。
 */
(function () {
  var KEY = 'origPriority';
  function getP() { try { return localStorage.getItem(KEY) || 'compressed'; } catch (e) { return 'compressed'; } }
  function setP(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  var bar = null, btn = null, hint = null;
  function paint() {
    if (!btn) return;
    var p = getP();
    btn.textContent = p === 'orig' ? '优先：原图' : '优先：压缩图';
    btn.setAttribute('aria-pressed', p === 'orig' ? 'true' : 'false');
    btn.classList.toggle('on-orig', p === 'orig');
    if (hint) hint.classList.toggle('show', p === 'orig');
  }
  function ensure() {
    if (bar || !document.querySelector('.fg-lb[data-orig]')) return;
    bar = document.createElement('div');
    bar.className = 'orig-bar';
    btn = document.createElement('button');
    btn.id = 'origToggle';
    btn.type = 'button';
    btn.addEventListener('click', function () {
      setP(getP() === 'orig' ? 'compressed' : 'orig');
      paint();
      if (window.__lbRefresh) window.__lbRefresh();   // 灯箱开着就立即生效
      if (window.__pfOrigStart) window.__pfOrigStart();   // 切到「原图优先」就开始后台预取原图
    });
    hint = document.createElement('span');
    hint.className = 'orig-hint';
    hint.textContent = '提示：两种模式都会在灯箱内载入原图（单张 5–16MB，来自另一个 GitHub 仓库）。'
      + '「压缩图优先」先显示压缩大图、随后自动替换为原图；「原图优先」则立即开始下载原图。'
      + '灯箱左上角两条进度条分别显示压缩大图与原图的进度，加载期间可正常左右切换。';
    bar.appendChild(btn);
    bar.appendChild(hint);
    var h1 = document.querySelector('h1');
    if (h1 && h1.parentNode) h1.parentNode.insertBefore(bar, h1.nextSibling);
    else document.body.appendChild(bar);
    paint();
  }
  window.__origPriority = getP;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure);
  else ensure();
  window.addEventListener('storage', function () { paint(); });
})();
