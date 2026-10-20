(function () {
  'use strict';

  // Keep the engine and every native dialog in the same landscape coordinate space.
  // A same-origin child retains the original URL, storage, and game session on rotation.
  if (window.parent !== window.self && window.frameElement && window.frameElement.id === 'poker-landscape-frame') return;
  var navigator = window.navigator || {};
  var mobile = (navigator.userAgentData && navigator.userAgentData.mobile === true) ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!mobile) return;

  window.__pokerLandscapeHost = true;
  document.body.classList.add('poker-landscape-host');
  var shell = document.querySelector('.game-shell');
  if (shell) {
    shell.hidden = true;
    shell.inert = true;
    shell.setAttribute('aria-hidden', 'true');
  }
  var frame = document.createElement('iframe');
  frame.id = 'poker-landscape-frame';
  frame.title = 'POKER CLUB 德州扑克';
  frame.setAttribute('allow', 'autoplay; fullscreen');
  frame.src = window.location.href;
  frame.style.transformOrigin = '0 0';
  document.body.appendChild(frame);

  function editing() {
    try {
      var element = frame.contentDocument && frame.contentDocument.activeElement;
      return element && (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable);
    } catch (_) {
      return false;
    }
  }
  function update(force) {
    // A software keyboard can make portrait dimensions temporarily look landscape.
    // Preserve the running viewport until editing ends or the device actually rotates.
    if (!force && editing()) return;
    var width = window.innerWidth || document.documentElement.clientWidth;
    var height = window.innerHeight || document.documentElement.clientHeight;
    if (!(width > 0 && height > 0)) return;
    var portrait = height > width;
    frame.style.width = (portrait ? height : width) + 'px';
    frame.style.height = (portrait ? width : height) + 'px';
    frame.style.transform = portrait ? 'translateX(' + width + 'px) rotate(90deg)' : 'none';
  }
  var orientationPending = false;
  function rotated() {
    orientationPending = true;
    update(true);
  }
  window.addEventListener('resize', function () {
    var force = orientationPending;
    orientationPending = false;
    update(force);
  });
  window.addEventListener('orientationchange', rotated);
  if (window.screen && window.screen.orientation && typeof window.screen.orientation.addEventListener === 'function') {
    window.screen.orientation.addEventListener('change', rotated);
  }
  update(true);
})();
