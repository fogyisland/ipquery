// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

/**
 * The browser half of the import progress bar.
 *
 * A whole-library import runs for hours. The page shows how far it has
 * got, but only when it is loaded — so the bar has to move while the page
 * is open, or the operator reloads every few minutes to find out whether
 * the job is still going.
 *
 * These tests load the real asset file into a sandbox with a DOM just
 * rich enough for it to run. The assertions are about the requests that
 * actually went out and the numbers that actually ended up on the bar.
 */

const ASSET = path.resolve(__dirname, "../../src/web/assets/range-progress.js");

class FakeElement {
  readonly attributes = new Map<string, string>();
  textContent = "";
  style: Record<string, string> = {};

  constructor(private readonly _tagName: string = "div") {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  querySelector(selector: string): FakeElement | null {
    return this._children.get(selector) ?? null;
  }
  readonly _children = new Map<string, FakeElement>();

  addChild(selector: string, child: FakeElement): void {
    this._children.set(selector, child);
  }
}

describe("range-progress.js", () => {
  it("asks the progress endpoint for the job it was given", async () => {
    // The row carries the job id, and the endpoint is addressed by it.
    const row = new FakeElement("tr");
    row.setAttribute("data-import-id", "7");
    const fill = new FakeElement("span");
    const text = new FakeElement("span");
    row.addChild(".range-import-bar-fill", fill);
    row.addChild(".range-import-progress-text", text);

    const doc = {
      readyState: "complete",
      addEventListener: () => undefined,
      querySelectorAll: () => [row],
    };
    let requested = "";
    const sandbox = {
      window: {},
      document: doc,
      setTimeout: () => undefined,
      Promise,
      Number,
      JSON,
      encodeURIComponent,
      console,
      fetch: (url: string) => {
        requested = url;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 7, rowsDone: 500, declaredRows: 1000 }),
        } as Response);
      },
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(ASSET, "utf8"), context, { filename: ASSET });

    // The script polls on a timer; give the first poll a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(requested).toContain("/admin/ranges/imports/7/progress");
    // The bar reflects what the server said.
    expect(fill.style.width).toBe("50%");
    expect(text.textContent).toContain("500");
    expect(text.textContent).toContain("1,000");
  });

  it("shows the row count alone when the file declared no total", async () => {
    const row = new FakeElement("tr");
    row.setAttribute("data-import-id", "8");
    const fill = new FakeElement("span");
    const text = new FakeElement("span");
    row.addChild(".range-import-bar-fill", fill);
    row.addChild(".range-import-progress-text", text);

    const sandbox = {
      window: {},
      document: {
        readyState: "complete",
        addEventListener: () => undefined,
        querySelectorAll: () => [row],
      },
      setTimeout: () => undefined,
      Promise,
      Number,
      JSON,
      encodeURIComponent,
      console,
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 8, rowsDone: 42, declaredRows: null }),
        } as Response),
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(ASSET, "utf8"), context, { filename: ASSET });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // No denominator, so no percentage — the count on its own.
    expect(fill.style.width).toBe("0%");
    expect(text.textContent).toBe("42");
  });

  it("stops polling a job that is over", async () => {
    // 204 is how the endpoint says "there is no progress left". The
    // script must not keep asking: a client that polls a finished job
    // forever is asking the database for nothing.
    const row = new FakeElement("tr");
    row.setAttribute("data-import-id", "9");
    const fill = new FakeElement("span");
    const text = new FakeElement("span");
    row.addChild(".range-import-bar-fill", fill);
    row.addChild(".range-import-progress-text", text);

    const timers: Array<() => void> = [];
    let fetchCount = 0;
    const sandbox = {
      window: {},
      document: {
        readyState: "complete",
        addEventListener: () => undefined,
        querySelectorAll: () => [row],
      },
      setTimeout: (fn: () => void) => {
        timers.push(fn);
      },
      Promise,
      Number,
      JSON,
      encodeURIComponent,
      console,
      fetch: () => {
        fetchCount += 1;
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) } as Response);
      },
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(ASSET, "utf8"), context, { filename: ASSET });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCount).toBe(1);

    // The timer was never armed, so nothing will poll again.
    expect(timers.length).toBe(0);
    expect(fetchCount).toBe(1);
  });

  it("does not poll a job that already finished", async () => {
    // The server marks a finished row with data-poll="off", so a page
    // opened after the job ended does not ask about it at all.
    const row = new FakeElement("tr");
    row.setAttribute("data-import-id", "10");
    row.setAttribute("data-poll", "off");

    let fetchCount = 0;
    const sandbox = {
      window: {},
      document: {
        readyState: "complete",
        addEventListener: () => undefined,
        querySelectorAll: () => [row],
      },
      setTimeout: () => undefined,
      Promise,
      Number,
      JSON,
      encodeURIComponent,
      console,
      fetch: () => {
        fetchCount += 1;
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) } as Response);
      },
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(ASSET, "utf8"), context, { filename: ASSET });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCount).toBe(0);
  });

  it("survives a network blip and keeps polling", async () => {
    // A failed poll is not a reason to stop: the operator sees a bar that
    // has not moved for a moment, which is honest, rather than an error
    // that has to be dismissed.
    const row = new FakeElement("tr");
    row.setAttribute("data-import-id", "11");
    const fill = new FakeElement("span");
    const text = new FakeElement("span");
    row.addChild(".range-import-bar-fill", fill);
    row.addChild(".range-import-progress-text", text);

    const timers: Array<() => void> = [];
    let fetchCount = 0;
    const sandbox = {
      window: {},
      document: {
        readyState: "complete",
        addEventListener: () => undefined,
        querySelectorAll: () => [row],
      },
      setTimeout: (fn: () => void) => {
        timers.push(fn);
      },
      Promise,
      Number,
      JSON,
      encodeURIComponent,
      console,
      fetch: () => {
        fetchCount += 1;
        return Promise.reject(new Error("the network went away"));
      },
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(ASSET, "utf8"), context, { filename: ASSET });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // The poll failed, but the next one was still scheduled.
    expect(fetchCount).toBe(1);
    expect(timers.length).toBe(1);
    expect(fill.style.width).toBeUndefined();
  });

  it("stops asking about a job that has finished", async () => {
    // The endpoint answers 204 for a job that is over. The script must
    // then stop asking about that job — not just stop counting it as
    // "alive". Otherwise the tick keeps hitting the endpoint for every
    // job on the page forever, and the answer is always the same:
    // nothing to report.
    const row = new FakeElement("tr");
    row.setAttribute("data-import-id", "12");
    const fill = new FakeElement("span");
    const text = new FakeElement("span");
    row.addChild(".range-import-bar-fill", fill);
    row.addChild(".range-import-progress-text", text);

    const timers: Array<() => void> = [];
    let fetchCount = 0;
    const sandbox = {
      window: {},
      document: {
        readyState: "complete",
        addEventListener: () => undefined,
        querySelectorAll: () => [row],
      },
      setTimeout: (fn: () => void) => {
        timers.push(fn);
      },
      Promise,
      Number,
      JSON,
      encodeURIComponent,
      console,
      fetch: () => {
        fetchCount += 1;
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) } as Response);
      },
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(ASSET, "utf8"), context, { filename: ASSET });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCount).toBe(1);

    // The row is marked so the next tick skips it. Without this the
    // script would ask again every two seconds for a job that can never
    // have progress again.
    expect(row.getAttribute("data-poll")).toBe("off");

    // And the next tick — if there were another job to watch — would
    // not ask about this one.
    if (timers.length > 0) {
      timers[0]!();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetchCount).toBe(1);
    }
  });
});
