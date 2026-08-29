// src/web/assets/endpoint-copy.js
// SPDX-License-Identifier: MIT
//
// Copy endpoint URL to clipboard. The inline version was blocked by
// CSP `script-src 'self'`. Event delegation so it works after htmx-
// style partial swaps. Falls back to selecting the text if the
// clipboard API is unavailable.
(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.endpoint-copy') : null;
    if (!btn) return;
    var target = document.getElementById(btn.dataset.target);
    if (!target) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(target.textContent || '').then(
        function () {
          btn.textContent = btn.dataset.copiedLabel || '✓';
          setTimeout(function () {
            btn.textContent = btn.dataset.origLabel || btn.textContent;
          }, 1500);
        },
        function () { if (target.select) target.select(); }
      );
    } else if (target.select) {
      target.select();
    }
  });
  document.querySelectorAll('.endpoint-copy').forEach(function (b) {
    b.dataset.origLabel = b.textContent || '';
  });
})();