// 歌词页「只显示歌词 / 显示翻译」切换
// 仅作用于 <article class="lyrics-basic">，按钮由生成器注入。
// 默认显示「歌词＋翻译」；点击后仅显示「歌词」（直译、翻译一并隐藏，对应 .kvt）。
(function () {
  function init() {
    var arts = document.querySelectorAll('article.lyrics-basic');
    for (var i = 0; i < arts.length; i++) {
      (function (art) {
        var btn = art.querySelector('.lyr-toggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
          var hidden = art.classList.toggle('hide-tr');
          btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
          btn.textContent = hidden ? '显示翻译' : '只显示歌词';
        });
      })(arts[i]);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
