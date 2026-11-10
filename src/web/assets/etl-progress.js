// SPDX-License-Identifier: MIT
//
// Live progress bars for the ETL run-detail page.
//
// Two update paths feed the bars:
//   1) Initial render: read data-* attributes off the container. These
//      are server-rendered with the latest values from etl_runs at page
//      load and refreshed every time the parent <section class="etl-stage-live">
//      is swapped (outerHTML, every 5s by the existing /live endpoint).
//   2) htmx JSON poll: the container has hx-get to /admin/etl/runs/:id/progress
//      which fires every 2s. htmx fetches the response, parses it as JSON,
//      then swaps innerHTML — but we also want to update the data-* attrs
//      so a subsequent outerHTML swap picks them up. We listen for
//      htmx:beforeSwap and, when the xhr is application/json, intercept
//      and call applyProgress(state) ourselves without swapping.
//
// The script is loaded with `defer` so it runs once at page load and
// again whenever a fresh <script> tag is injected by an outerHTML swap.
// Each invocation wires up listeners freshly — duplicates are deduped
// by the inner `init(container)` guard.

(function () {
  function fmtBytes(n) {
    if (n === 0 || !n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + " " + units[i];
  }

  function fmtRows(n) {
    if (!n) return "0";
    return n.toLocaleString();
  }

  function pct(done, total) {
    if (!total || total <= 0) return 0;
    const p = Math.round((done / total) * 100);
    return p < 0 ? 0 : p > 100 ? 100 : p;
  }

  function applyProgress(container) {
    const downloadDone = Number(container.getAttribute("data-done") || 0);
    const downloadTotal = Number(container.getAttribute("data-total") || 0);
    const rowsDone = Number(container.getAttribute("data-rows-done") || 0);
    const rowsTotal = Number(container.getAttribute("data-rows-total") || 0);
    const stage = container.getAttribute("data-stage") || "download";

    const dlBar = container.querySelector("#etl-progress-download-bar");
    const inBar = container.querySelector("#etl-progress-insert-bar");
    const dlFill = container.querySelector("#etl-progress-download-fill");
    const dlText = container.querySelector("#etl-progress-download-text");
    const inFill = container.querySelector("#etl-progress-insert-fill");
    const inText = container.querySelector("#etl-progress-insert-text");
    const stageEl = container.querySelector("#etl-progress-stage");
    if (!dlFill || !dlText || !inFill || !inText || !stageEl) return;

    // Download bar
    if (downloadTotal > 0) {
      dlFill.style.width = pct(downloadDone, downloadTotal) + "%";
      dlText.textContent = fmtBytes(downloadDone) + " / " + fmtBytes(downloadTotal)
        + " (" + pct(downloadDone, downloadTotal) + "%)";
      if (dlBar) {
        dlBar.setAttribute("aria-valuenow", String(pct(downloadDone, downloadTotal)));
        dlBar.setAttribute("aria-valuetext", dlText.textContent);
      }
    } else {
      dlFill.style.width = downloadDone > 0 ? "100%" : "0%";
      dlText.textContent = downloadDone > 0 ? fmtBytes(downloadDone) + " —" : "";
    }

    // Insert bar
    if (rowsTotal > 0) {
      inFill.style.width = pct(rowsDone, rowsTotal) + "%";
      inText.textContent = fmtRows(rowsDone) + " / " + fmtRows(rowsTotal)
        + " (" + pct(rowsDone, rowsTotal) + "%)";
      if (inBar) {
        inBar.setAttribute("aria-valuenow", String(pct(rowsDone, rowsTotal)));
        inBar.setAttribute("aria-valuetext", inText.textContent);
      }
    } else {
      inFill.style.width = "0%";
      inText.textContent = rowsDone > 0 ? fmtRows(rowsDone) + " —" : "0";
    }

    // Stage indicator
    const STAGE_LABEL = {
      download: "download",
      parse: "parse",
      insert: "insert",
      swap: "swap",
      done: "done",
    };
    stageEl.textContent = STAGE_LABEL[stage] || stage;
    stageEl.setAttribute("data-stage", stage);
  }

  function init(container) {
    if (!container || container.__etlProgressInit) return;
    container.__etlProgressInit = true;
    applyProgress(container);

    // Intercept the 2s JSON poll. htmx fires beforeSwap before touching
    // the DOM. If the response is JSON we handle it ourselves and cancel
    // the innerHTML swap (swap: false in event detail doesn't exist — we
    // set status to 204 so htmx's innerHTML path becomes a no-op via the
    // default swapNone-for-204 behaviour... actually htmx always swaps
    // innerHTML even on 204 with body). Simpler: stash the JSON on the
    // element and re-apply synchronously, and stop the swap by throwing
    // a sentinel — except htmx uses try/catch. Best approach: set
    // el.innerHTML to current content (i.e. no-op), then update attrs.
    container.addEventListener("htmx:beforeSwap", function (ev) {
      try {
        const xhr = ev.detail.xhr;
        if (!xhr) return;
        const ct = xhr.getResponseHeader("Content-Type") || "";
        if (ct.indexOf("application/json") === -1) return;
        const body = xhr.responseText || xhr.response || "";
        if (!body) return;
        const state = JSON.parse(body);
        container.setAttribute("data-done", state.downloadBytesDone);
        container.setAttribute("data-total", state.downloadBytesTotal);
        container.setAttribute("data-rows-done", state.insertRowsDone);
        container.setAttribute("data-rows-total", state.insertRowsTotal);
        container.setAttribute("data-stage", state.currentStage || "download");
        applyProgress(container);
        // Cancel the swap so htmx doesn't blow away our updated DOM.
        // htmx:beforeSwap's default swap is innerHTML — override with
        // outerHTML: false via setting swapOverride on the element.
        ev.detail.shouldSwap = false;
      } catch (_) {
        /* network blip — let htmx proceed normally */
      }
    });
  }

  function initAll(root) {
    const containers = (root || document).querySelectorAll("#etl-progress-bars");
    for (let i = 0; i < containers.length; i++) init(containers[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { initAll(); });
  } else {
    initAll();
  }
  // Re-init whenever htmx swaps new content in (outerHTML on the
  // <section class="etl-stage-live"> wrapper re-creates our container).
  document.body.addEventListener("htmx:afterSwap", function (ev) {
    initAll(ev.target);
  });
})();