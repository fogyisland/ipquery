// src/web/assets/confirm-form.js
// SPDX-License-Identifier: MIT
//
// Attach a `confirm()` dialog to any <form data-confirm="...">. Used
// wherever the previous inline `onsubmit="return confirm('...')"`
// lived — CSP `script-src 'self'` blocks inline event handlers, so
// the dialogs stopped firing. This module wires the same UX without
// inline scripts.
//
// Markup contract:
//   <form data-confirm="Are you sure?">...</form>
//
//   data-confirm = message string shown in window.confirm()
//   data-confirm-submit-attr = (optional) submit button selector, e.g.
//       "#bulk-revoke". When set, only attach when the submitter
//       matches. Lets pages with multiple submit buttons choose
//       which ones confirm.
//
// Behavior:
//   - submit → if confirm() returns false, preventDefault + stop
//   - confirms once per submit (subsequent clicks within the same
//     in-flight submit are coalesced — already-default-prevented
//     forms just stay cancelled)

(function () {
  function wire(form) {
    if (form.__confirmFormWired) return;
    form.__confirmFormWired = true;
    const message = form.getAttribute("data-confirm");
    if (!message) return;
    form.addEventListener("submit", function (ev) {
      // Only intercept on real user-initiated submits; programmatic
      // htmx-triggered submits get a synthetic SubmitEvent we want
      // to skip (htmx carries data-confirm via headers; not used
      // today).
      if (ev.defaultPrevented) return;
      if (!window.confirm(message)) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      }
    });
  }

  function wireAll(root) {
    const scope = root && root.querySelectorAll
      ? root
      : document;
    scope.querySelectorAll("form[data-confirm]").forEach(wire);
  }

  // Initial pass on DOMContentLoaded. The defer-attribute on the
  // <script src> already runs after parsing, but waiting one tick
  // keeps htmx-loaded fragments (e.g. backfill preview) from racing.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      wireAll(document);
    });
  } else {
    wireAll(document);
  }

  // htmx-driven swaps may inject new <form data-confirm> nodes —
  // wire them as they land.
  document.body.addEventListener("htmx:afterSwap", function (ev) {
    wireAll(ev.target);
  });
})();
