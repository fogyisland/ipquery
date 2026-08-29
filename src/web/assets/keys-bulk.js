// src/web/assets/keys-bulk.js
// SPDX-License-Identifier: MIT
//
// Bulk-select wiring for the API keys table. The inline version lived
// in keys.hbs but was blocked by CSP `script-src 'self'`, so the bulk
// "revoke" button never updated its count or enabled state.
//
// Selectors:
//   - #keys-check-all  → toggle all .keys-check-row checkboxes
//   - .keys-check-row  → per-row checkbox; updates count + button state
//   - #keys-bulk-btn   → submit button; disabled until ≥1 row selected
//   - #keys-bulk-count → badge showing selected count
//
// Already-revoked rows don't emit a checkbox at all (see the
// unless-this.revokedAt guard in the table body), so they're naturally
// excluded from the bulk action.
(function () {
  var checkAll = document.getElementById('keys-check-all');
  var rows = document.querySelectorAll('.keys-check-row');
  var btn = document.getElementById('keys-bulk-btn');
  var count = document.getElementById('keys-bulk-count');

  function update() {
    var n = 0;
    rows.forEach(function (r) { if (r.checked) n++; });
    if (count) count.textContent = String(n);
    if (btn) btn.disabled = n === 0;
    if (checkAll) {
      if (n === 0) { checkAll.indeterminate = false; checkAll.checked = false; }
      else if (n === rows.length) { checkAll.indeterminate = false; checkAll.checked = true; }
      else checkAll.indeterminate = true;
    }
  }

  if (checkAll) checkAll.addEventListener('change', function () {
    rows.forEach(function (r) { r.checked = checkAll.checked; });
    update();
  });
  rows.forEach(function (r) { r.addEventListener('change', update); });
  update();
})();