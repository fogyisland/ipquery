// SPDX-License-Identifier: MIT
//
// The browser half of a chunked .ipq upload.
//
// A whole-library export is around two gigabytes. A form POST would have
// the whole body held in memory before a byte could be parsed, and one
// dropped connection would cost the entire transfer. So the file goes up
// in chunks: each one is small enough to retry on its own, and the server
// assembles them on disk.
//
// The server drives the loop. After every chunk it says how many bytes it
// has and where the next one starts; the browser follows that number
// rather than counting for itself. That is what makes a dropped chunk
// recoverable — the browser simply asks again.
//
// Markup contract (see src/web/views/admin/ranges.hbs):
//   #range-upload-form     the container; carries data-csrf
//   #range-upload-file     <input type="file">, carries data-mode
//   #range-upload-start    the button that begins the upload
//   #range-upload-progress a <progress>; its value is the bytes sent
//   #range-upload-status   where the reason for a failure is written
//
// CSP note: `script-src 'self'` blocks inline handlers, so the script is a
// separate file and every listener is attached from here.
(function () {
  "use strict";

  const CHUNK_FALLBACK_BYTES = 8 * 1024 * 1024;
  const MAX_CHUNK_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 1500;
  /** How long to wait before a chunk is tried again. A 429 or a 503 from
   *  a proxy under load is worth waiting out; a 400 is not, and the
   *  server's own message says why. */
  const RETRYABLE_STATUS = [408, 425, 429, 500, 502, 503, 504];

  const byId = (id) => document.getElementById(id);

  function setStatus(text, isError) {
    const el = byId("range-upload-status");
    if (!el) return;
    el.textContent = text;
    if (isError) el.setAttribute("data-error", "1");
    else el.removeAttribute("data-error");
  }

  function setProgress(bytesSent, totalBytes) {
    const el = byId("range-upload-progress");
    if (!el) return;
    if (totalBytes > 0) {
      el.setAttribute("value", String(bytesSent));
      el.setAttribute("max", String(totalBytes));
    } else {
      el.removeAttribute("value");
    }
  }

  function setBusy(isBusy) {
    const start = byId("range-upload-start");
    if (start) start.disabled = isBusy;
  }

  function csrfToken() {
    const form = byId("range-upload-form");
    if (!form) return "";
    const hidden = form.querySelector("[name=csrf]");
    if (hidden && hidden.value) return hidden.value;
    return form.getAttribute("data-csrf") || "";
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let index = 0;
    let value = bytes;
    while (value >= 1024 && index < units.length - 1) {
      value = value / 1024;
      index++;
    }
    return value.toFixed(value >= 100 || index === 0 ? 0 : 1) + " " + units[index];
  }

  /** A console note that is visible in the browser's own console. The
   *  page's own error line is the primary channel; this is the detail. */
  function appLog(message) {
    if (typeof console !== "undefined" && console.error) console.error("[range-upload] " + message);
  }

  /** The reason a request failed, in the operator's language. */
  async function readError(response) {
    let text = "";
    try {
      text = await response.text();
    } catch (err) {
      appLog("could not read the error body: " + String(err));
      text = "";
    }
    if (!text) return "HTTP " + response.status;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string") return parsed.error;
    } catch (err) {
      // Not JSON — the body is the message.
      appLog("the error body was not json: " + String(err));
    }
    return text.slice(0, 300);
  }

  /** Where the half-finished upload for this file is remembered. The
   *  session survives a page refresh — which is exactly the case worth
   *  resuming — and not much longer, which is right: an upload id from
   *  last week is not something to resume. */
  function resumeKey(file) {
    return "ipquery.range-upload." + file.name + "." + file.size;
  }

  function readResume(file) {
    let raw = null;
    try {
      raw = sessionStorage.getItem(resumeKey(file));
    } catch (err) {
      appLog("the session store is not available: " + String(err));
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.uploadId !== "number") return null;
      return parsed;
    } catch (err) {
      appLog("the resume record was unreadable: " + String(err));
      return null;
    }
  }

  function writeResume(file, uploadId, offset) {
    try {
      sessionStorage.setItem(
        resumeKey(file),
        JSON.stringify({ uploadId: uploadId, offset: offset, size: file.size, name: file.name }),
      );
    } catch (err) {
      appLog("the resume record could not be written: " + String(err));
    }
  }

  function clearResume(file) {
    try {
      sessionStorage.removeItem(resumeKey(file));
    } catch (err) {
      appLog("the resume record could not be cleared: " + String(err));
    }
  }

  /** The offset the page already knows about, if any. The server is the
   *  authority, but a page that was re-rendered with the upload still in
   *  progress can continue without a round trip. */
  function offsetFromMarkup(file) {
    const input = byId("range-upload-file");
    if (!input) return 0;
    const id = input.getAttribute("data-resume-id");
    const offset = input.getAttribute("data-resume-offset");
    if (!id || !offset) return 0;
    const parsedId = Number(id);
    const parsedOffset = Number(offset);
    if (!isFinite(parsedId) || parsedId <= 0) return 0;
    if (!isFinite(parsedOffset) || parsedOffset < 0) return 0;
    if (parsedOffset > file.size) return 0;
    return parsedOffset;
  }

  /** Reserve the upload. */
  async function startUpload(file, mode) {
    const token = csrfToken();
    const body = new URLSearchParams();
    body.set("csrf", token);
    body.set("mode", mode || "merge");
    body.set("filename", file.name);
    body.set("totalBytes", String(file.size));

    const response = await fetch("/admin/ranges/upload/start", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = await response.json();
    return {
      uploadId: Number(payload.id),
      chunkBytes: Number(payload.chunkBytes) || CHUNK_FALLBACK_BYTES,
    };
  }

  /** The name to put on the uploaded part. */
  function fileNameOf(chunk) {
    if (chunk && typeof chunk.name === "string" && chunk.name) return chunk.name;
    return "upload.ipq";
  }

  /** One chunk, tried again if the failure looks temporary. */
  async function sendChunk(uploadId, offset, chunk, token) {
    let attempt = 0;
    let lastError = "";
    while (attempt < MAX_CHUNK_ATTEMPTS) {
      attempt++;
      const form = new FormData();
      form.set("csrf", token);
      form.set("uploadId", String(uploadId));
      form.set("offset", String(offset));
      form.set("file", chunk, fileNameOf(chunk));
      let reason = "";
      try {
        const response = await fetch("/admin/ranges/upload/chunk", {
          method: "POST",
          body: form,
          credentials: "same-origin",
        });
        if (response.ok) {
          const payload = await response.json();
          return {
            nextOffset: Number(payload.nextOffset),
            complete: Boolean(payload.complete),
            receivedBytes: Number(payload.receivedBytes),
          };
        }
        reason = await readError(response);
        // A refusal is the server's decision; trying again would only
        // earn the same answer.
        if (RETRYABLE_STATUS.indexOf(response.status) === -1) {
          throw new Error(reason);
        }
      } catch (err) {
        if (err instanceof Error && /HTTP|not |cannot|invalid|mismatch/i.test(err.message)) {
          throw err;
        }
        reason = err instanceof Error ? err.message : String(err);
      }
      if (attempt >= MAX_CHUNK_ATTEMPTS) {
        throw new Error(reason || "the chunk was not accepted");
      }
      lastError = reason;
      setStatus("Retrying — " + formatBytes(offset) + " sent (" + reason + ")");
      await sleep(RETRY_DELAY_MS * attempt);
    }
    throw new Error(lastError || "the chunk was not accepted");
  }

  /** The import itself: the bytes are on disk, so the server streams them
   *  into the table and removes the file afterwards. */
  async function runImport(uploadId, mode) {
    const token = csrfToken();
    const body = new URLSearchParams();
    body.set("csrf", token);
    body.set("uploadId", String(uploadId));
    body.set("mode", mode || "merge");
    if (mode === "replace") {
      const typed = confirmRows();
      if (typed) body.set("confirmRows", typed);
    }
    const response = await fetch("/admin/ranges/import", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(await readError(response));
    return true;
  }

  /** The whole upload, from the first byte to the import. */
  async function upload(file, mode) {
    const token = csrfToken();
    let uploadId = 0;
    let chunkBytes = CHUNK_FALLBACK_BYTES;
    let offset = 0;

    // A file that was already partly sent — the page was reloaded, or the
    // connection dropped — continues instead of starting over. The two
    // sources are the session store and the markup; the session store is
    // written as the transfer goes, so it is the fresher of the two.
    const resumed = readResume(file);
    const markupOffset = offsetFromMarkup(file);
    if (resumed && resumed.size === file.size) {
      uploadId = resumed.uploadId;
      offset = Math.min(Number(resumed.offset) || 0, file.size);
    } else if (markupOffset > 0) {
      uploadId = Number(byId("range-upload-file").getAttribute("data-resume-id"));
      offset = markupOffset;
    }

    if (!uploadId) {
      setStatus("Preparing — reserving space on the server");
      const started = await startUpload(file, mode);
      uploadId = started.uploadId;
      chunkBytes = started.chunkBytes;
    }

    while (offset < file.size) {
      const end = Math.min(offset + chunkBytes, file.size);
      const chunk = file.slice(offset, end);
      const result = await sendChunk(uploadId, offset, chunk, token);
      // The server's number is the authority. It knows what actually
      // landed, which is not always what was sent: a chunk can be written
      // short, and then the next one has to start where the server says or
      // the assembled file has a hole in it. Counting for ourselves is
      // how a hole gets written.
      if (typeof result.nextOffset === "number" && result.nextOffset > offset) {
        offset = result.nextOffset;
      } else {
        // The server did not move. Counting for ourselves is the only
        // thing left — but it must move, or the loop never ends.
        offset = end;
      }
      writeResume(file, uploadId, offset);
      setProgress(offset, file.size);
      setStatus("Uploading — " + formatBytes(offset) + " of " + formatBytes(file.size));
    }

    setStatus("Uploaded — importing into the database");
    await runImport(uploadId, mode);
    clearResume(file);
    setProgress(file.size, file.size);
    setStatus("Imported — the file has been added to the library");
  }

  /** The mode the operator chose: merge or replace. */
  function selectedMode() {
    const select = byId("range-upload-mode");
    if (select && select.value === "replace") return "replace";
    return "merge";
  }

  /** The number the operator typed to confirm a replacement. It has to
   *  match the count the server holds, and the server is the one that
   *  decides — this is only what the operator said. */
  function confirmRows() {
    const field = byId("range-upload-confirm");
    if (!field) return "";
    return String(field.value ?? "").trim();
  }

  /** The entry point the button calls. */
  async function start() {
    const input = byId("range-upload-file");
    if (!input) return;
    const file = input.files && input.files.length > 0 ? input.files[0] : null;
    if (!file) {
      setStatus("Choose a file first", true);
      return;
    }
    const mode = selectedMode();
    if (mode === "replace") {
      // The replacement guard is the server's to enforce, but the page
      // can say so before the bytes travel: a replacement that is going
      // to be refused should not cost a two-gigabyte transfer.
      if (!confirmRows()) {
        setStatus("Type the current range count to confirm a replacement", true);
        return;
      }
    }
    setBusy(true);
    try {
      await upload(file, mode);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setStatus("Upload failed — " + reason, true);
      appLog(reason);
    } finally {
      setBusy(false);
    }
  }

  /** The confirmation field only exists for a replacement. */
  function syncMode() {
    const field = byId("range-upload-confirm-field");
    if (!field) return;
    if (selectedMode() === "replace") field.removeAttribute("hidden");
    else field.setAttribute("hidden", "");
  }

  function wire() {
    const button = byId("range-upload-start");
    const mode = byId("range-upload-mode");
    if (mode) {
      if (mode.__rangeUploadModeWired) return;
      mode.__rangeUploadModeWired = true;
      mode.addEventListener("change", syncMode);
      syncMode();
    }
    if (!button) return;
    if (button.__rangeUploadWired) return;
    button.__rangeUploadWired = true;
    button.addEventListener("click", (ev) => {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      start();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
