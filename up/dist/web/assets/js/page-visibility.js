// src/web/assets/js/page-visibility.js
// SPDX-License-Identifier: MIT
//
// Pauses htmx polling while the tab is in the background.
//
// The admin dashboard and /admin/queries both poll with
// `hx-trigger="every 30s"`. htmx 1.9 fires that whether or not the tab is
// visible, so a console left open in a background tab queried the
// database every 30 seconds all day for numbers nobody was reading.
//
// HOW, AND WHY NOT THE OBVIOUS WAY
//
// htmx's conditional-trigger syntax (`every 30s [expr]`) is the natural
// fit, but htmx evaluates the expression with `new Function(...)`. The
// app's CSP is `script-src 'self'` with no 'unsafe-eval', so that
// evaluation throws an EvalError on every poll — the condition never
// takes effect and the console fills with CSP violations.
//
// So this controls the poll from outside: htmx re-reads `hx-trigger`
// when the attribute changes, and removing it stops the timer. The
// attribute is restored (and the timer restarted) when the tab comes
// back.
//
// This has to be an external file: an inline <script> is blocked by the
// same CSP, silently, leaving the page polling as if this did not exist.
(function () {
  var POLL_ATTR = "hx-trigger";
  var PAUSED_KEY = "data-poll-paused";

  function pause(el) {
    if (!el.hasAttribute(POLL_ATTR)) return;
    el.setAttribute(PAUSED_KEY, el.getAttribute(POLL_ATTR));
    el.removeAttribute(POLL_ATTR);
  }

  function resume(el) {
    if (!el.hasAttribute(PAUSED_KEY)) return;
    el.setAttribute(POLL_ATTR, el.getAttribute(PAUSED_KEY));
    el.removeAttribute(PAUSED_KEY);
  }

  function apply() {
    var isHidden = document.visibilityState !== "visible";
    var pollers = document.querySelectorAll("[" + POLL_ATTR + "], [" + PAUSED_KEY + "]");
    for (var i = 0; i < pollers.length; i++) {
      if (isHidden) pause(pollers[i]);
      else resume(pollers[i]);
    }
    document.documentElement.dataset.pageVisible = isHidden ? "0" : "1";
  }

  document.addEventListener("visibilitychange", apply);

  // htmx swaps the whole <section> in, so the element carrying the trigger
  // is a new node after every poll; re-apply once the swap settles.
  document.addEventListener("htmx:afterSettle", apply);
  document.addEventListener("DOMContentLoaded", apply);
})();
