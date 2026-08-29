// src/web/assets/secret-reveal.js
// SPDX-License-Identifier: MIT
//
// Eye-icon toggle for the admin settings page secret fields. The inline
// version was blocked by CSP `script-src 'self'`, so the secret fields
// stayed masked even after click. This wires every .secret-toggle
// button to swap .secret-mask between "••••••••••" and the raw value
// held in data-secret. Idempotent — re-bind safe in case the script
// loads twice.
(function () {
  function bind() {
    document.querySelectorAll('.secret-toggle').forEach(function (btn) {
      if (btn.dataset.secretBound === '1') return;
      btn.dataset.secretBound = '1';
      btn.addEventListener('click', function () {
        var wrap = btn.closest('.input-trailing');
        if (!wrap) return;
        var mask = wrap.querySelector('.secret-mask');
        if (!mask) return;
        var shown = mask.classList.toggle('is-shown');
        mask.textContent = shown ? mask.dataset.secret : '••••••••••';
        btn.setAttribute('aria-label', shown ? (btn.dataset.hideLabel || '') : (btn.dataset.showLabel || ''));
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();