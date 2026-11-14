// src/web/assets/bulk.js
// SPDX-License-Identifier: MIT
// Bulk-action handler for admin list pages. Wires buttons with
// `data-bulk-action="..."` to the form with id `bulk-form`, populating
// hidden inputs `bulk-action` and `bulk-ids` with selected row checkboxes
// (`.row-check:checked`) before submitting.
//
// The buttons are disabled until at least one row is selected. They used
// to always be clickable and answered an empty selection with alert() —
// a modal dialog to report a state the interface already knew about, and
// a button that looks available but can only fail.
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("bulk-form");
  if (!form) return;

  const rows = [...document.querySelectorAll(".row-check")];
  const buttons = [...form.querySelectorAll("[data-bulk-action]")];
  if (buttons.length === 0) return;

  const selectedIds = () =>
    rows.filter((c) => c.checked).map((c) => c.value).join(",");

  // Reflect "is there a selection?" on the buttons themselves.
  const syncButtons = () => {
    const hasSelection = selectedIds() !== "";
    for (const btn of buttons) btn.disabled = !hasSelection;
  };

  rows.forEach((row) => row.addEventListener("change", syncButtons));
  syncButtons();

  for (const btn of buttons) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const ids = selectedIds();
      if (!ids) {
        // Should be unreachable while the buttons are disabled; kept as a
        // guard so a selection cleared by an htmx swap cannot submit an
        // empty id list to the server.
        syncButtons();
        return;
      }
      document.getElementById("bulk-action").value = btn.dataset.bulkAction;
      document.getElementById("bulk-ids").value = ids;
      form.submit();
    });
  }
});
