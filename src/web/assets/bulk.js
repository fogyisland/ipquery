// src/web/assets/bulk.js
// SPDX-License-Identifier: MIT
// Bulk-action handler for admin list pages. Wires buttons with
// `data-bulk-action="..."` to the form with id `bulk-form`, populating
// hidden inputs `bulk-action` and `bulk-ids` with selected row checkboxes
// (`.row-check:checked`) before submitting.
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("bulk-form");
  if (!form) return;
  form.querySelectorAll("[data-bulk-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const action = btn.dataset.bulkAction;
      const ids = [...document.querySelectorAll(".row-check:checked")].map((c) => c.value).join(",");
      if (!ids) {
        alert("Select rows first");
        return;
      }
      document.getElementById("bulk-action").value = action;
      document.getElementById("bulk-ids").value = ids;
      form.submit();
    });
  });
});
