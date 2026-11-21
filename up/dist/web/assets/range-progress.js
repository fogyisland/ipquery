// SPDX-License-Identifier: MIT
//
// Live progress for a running range import.
//
// The import log on /admin/ranges shows how far each job has got — but
// only when the page is loaded. A whole-library import runs for hours, and
// an operator watching it wants to see the bar move, not to reload the
// page every few minutes to find out whether it is still going.
//
// So the page polls /admin/ranges/imports/:id/progress every two seconds
// while a job is running, and this script updates the bar in place.
//
// The polling stops on its own: the endpoint answers 204 once the job has
// finished, and there is nothing left to report. The bar is then left
// showing the last number it saw, which is the number the job record
// holds — the same one the server would render.
//
// The script is loaded with `defer`, so it runs once the DOM is ready.
// The `data-` attributes it reads are server-rendered, so the bar is
// correct before the first poll and does not flicker.

(function () {
  const POLL_INTERVAL_MS = 2000;

  function formatRows(n) {
    if (!n) return "0";
    return n.toLocaleString();
  }

  /** The bar's width as a percentage, clamped to 0..100. */
  function percent(done, total) {
    if (!total || total <= 0) return 0;
    const p = Math.round((done / total) * 100);
    if (p < 0) return 0;
    if (p > 100) return 100;
    return p;
  }

  /**
   * Update one row from the endpoint's answer.
   *
   * The row is found by the job id the server rendered into it, so two
   * jobs on the same page do not write over each other.
   */
  function applyProgress(row, state) {
    const fill = row.querySelector(".range-import-bar-fill");
    const text = row.querySelector(".range-import-progress-text");
    if (!fill || !text) return;

    const done = Number(state.rowsDone || 0);
    const total = Number(state.declaredRows || 0);
    const pct = percent(done, total);

    fill.style.width = pct + "%";
    if (total > 0) {
      text.textContent = formatRows(done) + " / " + formatRows(total) + " (" + pct + "%)";
    } else {
      // The file did not declare a row count, so there is no denominator
      // to be a percentage of. The count alone is still worth showing.
      text.textContent = formatRows(done);
    }
  }

  /** One poll of one row. Resolves with `false` when the row is done
   *  polling — the job has finished, so there is nothing left to ask for. */
  function poll(row) {
    const id = row.getAttribute("data-import-id");
    if (!id) return Promise.resolve(false);

    return fetch("/admin/ranges/imports/" + encodeURIComponent(id) + "/progress", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then(function (response) {
        // 204 means the job is over: there is no progress left, so the
        // polling stops here. 404 means the job is not there at all —
        // also nothing to poll.
        if (response.status === 204 || response.status === 404) return null;
        if (!response.ok) return undefined;
        return response.json();
      })
      .then(function (state) {
        if (state === null) return false;
        if (state === undefined) return true;
        applyProgress(row, state);
        return true;
      })
      .catch(function () {
        // A network blip is not a reason to stop: the next poll in two
        // seconds tries again. Swallowing it here is deliberate — the
        // operator sees a bar that has not moved for a moment, which is
        // honest, rather than an error that has to be dismissed.
        return true;
      });
  }

  /** Poll every running row, forever, until each one says it is done. */
  function start() {
    const rows = document.querySelectorAll(".range-import-row[data-import-id]");
    if (rows.length === 0) return;

    function tick() {
      const pending = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.getAttribute("data-poll") === "off") continue;
        pending.push(
          poll(row).then(function (stillGoing) {
            // A job that has finished is not asked about again. Without
            // this the tick would keep asking about every job on the
            // page forever, and the answer to a finished job is always
            // the same: nothing to report.
            if (!stillGoing) row.setAttribute("data-poll", "off");
            return stillGoing ? row : null;
          }),
        );
      }
      if (pending.length === 0) return;
      Promise.all(pending).then(function (results) {
        const alive = results.filter(function (row) {
          return row !== null;
        });
        // Nothing is running any more: the polling stops. A client that
        // keeps asking about a finished job is asking the database for
        // nothing, forever.
        if (alive.length === 0) return;
        setTimeout(tick, POLL_INTERVAL_MS);
      });
    }

    tick();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
