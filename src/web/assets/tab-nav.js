// src/web/assets/tab-nav.js
// SPDX-License-Identifier: MIT
//
// Hash-routed tab navigation for admin/settings/unknown-ips.
// The inline script previously lived at the bottom of each view, but
// CSP `script-src 'self'` blocks inline <script>, so the tabs stopped
// responding to clicks. This module wires:
//   - .settings-tab-link clicks → activate the matching pane
//   - location.hash on load → resolve and activate
//   - hashchange → re-resolve and activate
//   - ?tab= query param fallback (POST redirects land here)
//
// Tab IDs come from data-tab on both the <a> link and the <div> pane;
// activation toggles the .is-active class on both. Defer-attribute on
// the <script src> tag means this runs after the DOM is parsed.

(function () {
  const VALID_TABS = new Set([
    "overview",
    "providers",
    "failure-logs",
    "general",
    "security",
    "integrations",
    "system",
  ]);

  function resolveTab() {
    let hashTab = "";
    try {
      hashTab = (location.hash || "").replace(/^#/, "");
    } catch {
      /* legacy */
    }
    if (VALID_TABS.has(hashTab)) return hashTab;
    try {
      const params = new URLSearchParams(location.search);
      const qTab = params.get("tab");
      if (qTab && VALID_TABS.has(qTab)) return qTab;
    } catch {
      /* legacy */
    }
    return "";
  }

  function activate(tabId) {
    document.querySelectorAll(".settings-tab-link").forEach(function (el) {
      el.classList.toggle("is-active", el.dataset.tab === tabId);
    });
    document.querySelectorAll(".settings-tab-pane").forEach(function (el) {
      el.classList.toggle("is-active", el.dataset.tab === tabId);
    });
  }

  function applyHash() {
    const tabId = resolveTab();
    if (tabId) activate(tabId);
  }

  document.querySelectorAll(".settings-tab-link").forEach(function (el) {
    el.addEventListener("click", function () {
      setTimeout(applyHash, 0);
    });
  });
  window.addEventListener("hashchange", applyHash);
  applyHash();
})();
