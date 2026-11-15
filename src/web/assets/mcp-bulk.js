// src/web/assets/mcp-bulk.js
// SPDX-License-Identifier: MIT
//
// Bulk-select wiring for the MCP token approval table.
//
// The API-keys page has one bulk button; this table has three, because
// a pending token can be approved or rejected and an approved token can
// be revoked. All three post to the same endpoint, which reads the
// action from a hidden field — so each button has to write its own
// action into that field before the form submits.
//
// Selectors:
//   - #mcp-check-all  → toggle all .mcp-check-row checkboxes
//   - .mcp-check-row  → per-row checkbox; updates count + button state
//   - #mcp-bulk-count → badge showing the selected count
//   - #mcp-bulk-approve / #mcp-bulk-reject / #mcp-bulk-revoke
//                     → submit buttons; each carries its own action
//
// The inline version lived in the template but CSP `script-src 'self'`
// blocked it, which is why this is an external file — same lesson as
// keys-bulk.js.
(function () {
  const checkAll = document.getElementById("mcp-check-all");
  const rows = document.querySelectorAll(".mcp-check-row");
  const count = document.getElementById("mcp-bulk-count");
  const action = document.getElementById("mcp-bulk-action");
  const form = document.getElementById("mcp-bulk-form");
  const buttons = [
    { el: document.getElementById("mcp-bulk-approve"), value: "approve" },
    { el: document.getElementById("mcp-bulk-reject"), value: "reject" },
    { el: document.getElementById("mcp-bulk-revoke"), value: "revoke" },
  ].filter((entry) => entry.el);

  function selectedCount() {
    let n = 0;
    rows.forEach((row) => {
      if (row.checked) n++;
    });
    return n;
  }

  function update() {
    const n = selectedCount();
    if (count) count.textContent = String(n);
    // Every bulk button stays disabled until at least one row is
    // selected — an empty submission would be a silent no-op.
    buttons.forEach((entry) => {
      entry.el.disabled = n === 0;
    });
    if (checkAll) {
      if (n === 0) {
        checkAll.indeterminate = false;
        checkAll.checked = false;
      } else if (n === rows.length) {
        checkAll.indeterminate = false;
        checkAll.checked = true;
      } else {
        checkAll.indeterminate = true;
      }
    }
  }

  if (checkAll) {
    checkAll.addEventListener("change", function () {
      rows.forEach((row) => {
        row.checked = checkAll.checked;
      });
      update();
    });
  }
  rows.forEach((row) => {
    row.addEventListener("change", update);
  });

  // Each button stamps its own action into the hidden field, so the
  // server receives the intent that was actually clicked.
  buttons.forEach((entry) => {
    entry.el.addEventListener("click", function () {
      if (action) action.value = entry.value;
    });
  });

  // The form's own submit can also be triggered by pressing Enter in a
  // field; stamp the default action in that case.
  if (form) {
    form.addEventListener("submit", function () {
      if (action && !action.value) action.value = "approve";
    });
  }

  update();
})();
