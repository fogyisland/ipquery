// SPDX-License-Identifier: MIT
//
// /admin/ingest/backfill/preview — disable the confirm button on first
// submit so a double-click can't fire two POSTs (which would either run
// the backfill twice or, worse, replay a stale token after the cookie
// has been cleared server-side). CSP-safe: external file, no inline JS.

(function () {
  document.addEventListener('submit', function (e) {
    var form = e.target && e.target.closest ? e.target.closest('.backfill-confirm-form') : null;
    if (!form) return;
    var btn = form.querySelector('button[type="submit"]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    if (btn.dataset.busyLabel) btn.textContent = btn.dataset.busyLabel;
  });
})();
