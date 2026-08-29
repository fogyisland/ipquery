// SPDX-License-Identifier: MIT
//
// Intercepts the "Test Lookup" mini-form submits on
// /admin/unknown-ips/providers/custom. Each row's <form> POSTs to
// /:name/test and renders the JSON response inline. We don't navigate
// away because the page is a form-heavy list and a redirect would dump
// the admin back to the top of the page (losing context). CSP-safe:
// external file, no inline scripts.

(function () {
  document.querySelectorAll('.custom-provider-test-form').forEach(function (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var url = form.getAttribute('action');
      var fd = new FormData(form);
      var resultCell = form.parentElement.querySelector('.custom-provider-test-result');
      if (!resultCell) return;
      resultCell.textContent = '...';
      fetch(url, {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
      })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'parse' }; }); })
        .then(function (j) {
          if (j.ok && j.record) {
            resultCell.textContent = j.record.countryCode + (j.record.city ? ' · ' + j.record.city : '');
          } else {
            resultCell.textContent = 'ERR ' + (j.error || 'unknown');
          }
        })
        .catch(function (err) {
          resultCell.textContent = 'ERR ' + (err && err.message ? err.message : 'fetch');
        });
    });
  });
})();
