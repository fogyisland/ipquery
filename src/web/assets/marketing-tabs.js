// src/web/assets/marketing-tabs.js
// SPDX-License-Identifier: MIT
//
// Two small handlers used by the public marketing pages:
//   1. /try IP chip filler — clicking a `.m-try-chip` copies its data-ip
//      (or text) into the page's `input[name="ip"]` and focuses it.
//   2. Code-block tab switcher — clicking `.m-codeblock-tab` toggles
//      .active on the tab and shows the matching `[data-pane]`
//      inside the same `.m-codeblock`.
//
// Both use event delegation so they keep working after htmx-style
// partial swaps. Previously inlined in layouts/marketing.hbs but CSP
// `script-src 'self'` blocked execution.
(function () {
  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;

    // 1. /try chip filler.
    const chip = e.target.closest(".m-try-chip");
    if (chip) {
      const input = document.querySelector('input[name="ip"]');
      if (input) {
        input.value = chip.dataset.ip || (chip.textContent || "").trim();
        input.focus();
      }
      return;
    }

    // 2. Code-block tab switcher.
    const tab = e.target.closest(".m-codeblock-tab");
    if (tab) {
      const block = tab.closest(".m-codeblock");
      if (!block) return;
      const id = tab.dataset.tab;
      block.querySelectorAll(".m-codeblock-tab").forEach(function (t) {
        t.classList.toggle("active", t === tab);
      });
      block.querySelectorAll("[data-pane]").forEach(function (p) {
        p.style.display = p.dataset.pane === id ? "" : "none";
      });
    }
  });
})();
