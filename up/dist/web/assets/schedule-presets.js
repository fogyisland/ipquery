// SPDX-License-Identifier: MIT
//
// Preset buttons for the ETL schedule field.
//
// CSP forbids inline handlers, so the buttons carry their expression in a
// data attribute and this file wires the click. Without JavaScript the
// buttons do nothing — the text input still works, which is the degraded
// path we want.
(function () {
  "use strict";

  function applyPreset(button) {
    var expression = button.getAttribute("data-cron-preset");
    if (!expression) return;
    var form = button.closest("form");
    if (!form) return;
    var input = form.querySelector('input[name="schedule"]');
    if (!input) return;
    input.value = expression;
    input.focus();
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var button = target.closest("[data-cron-preset]");
    if (!button) return;
    event.preventDefault();
    applyPreset(button);
  });
})();
