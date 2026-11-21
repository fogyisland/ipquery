// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The browser half of a chunked upload.
 *
 * A whole-library .ipq is around two gigabytes, so it cannot be one POST:
 * the body would be held in memory before a byte could be parsed. The
 * server already takes chunks and says where to continue; what was missing
 * was the browser half, and without it the page could only post a form.
 *
 * These tests drive the real asset file — the same bytes the browser
 * downloads — against a real HTTP server. Nothing is stubbed on the wire:
 * the script is loaded into a sandbox with a DOM just rich enough for it to
 * run, and the assertions are about the requests that actually arrived.
 */

const ASSET = path.resolve(__dirname, "../../src/web/assets/range-upload.js");

/** The DOM surface the script uses. Kept deliberately small: if the script
 *  grows a dependency the harness does not provide, the test fails loudly
 *  rather than silently passing. */
class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((_: unknown) => void)[]>();
  textContent = "";
  value = "";
  disabled = false;
  files: File[] = [];
  innerHTML = "";

  constructor(readonly _tagName: string = "div") {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(type: string, handler: (_: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  dispatch(type: string, ev: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(ev);
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
}

/** One request the server received. */
interface Received {
  readonly path: string;
  readonly fields: Record<string, string>;
  readonly fileName: string;
  readonly fileBytes: Buffer;
}

/**
 * A minimal multipart parser.
 *
 * The script posts a FormData; Node's fetch encodes it as multipart/form-data
 * with a boundary the server tells us about. The parser only needs to find
 * the fields and the one file part — exactly the shape the server's own
 * reader expects.
 */
function parseMultipart(
  body: Buffer,
  contentType: string,
): { fields: Record<string, string>; fileName: string; fileBytes: Buffer } {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!match) throw new Error("no boundary in " + contentType);
  const boundary = `--${match[1] ?? match[2]}`;
  const fields: Record<string, string> = {};
  let fileName = "";
  let fileBytes = Buffer.alloc(0);
  for (const part of body.toString("latin1").split(boundary)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const rawHeaders = part.slice(0, headerEnd);
    const content = Buffer.from(part.slice(headerEnd + 4).replace(/\r\n$/, ""), "latin1");
    const nameMatch = /name="([^"]*)"/.exec(rawHeaders);
    if (!nameMatch) continue;
    const fileMatch = /filename="([^"]*)"/.exec(rawHeaders);
    if (fileMatch) {
      fileName = fileMatch[1] ?? "";
      fileBytes = content;
    } else {
      fields[nameMatch[1] ?? ""] = content.toString("utf8");
    }
  }
  return { fields, fileName, fileBytes };
}

/** The script's view of the world. */
interface Sandbox {
  readonly elements: Record<string, FakeElement>;
}

/** Load the asset into a sandbox. Each call gets a clean global: the script
 *  reads its state off the DOM at load time, so a shared global would let
 *  one test's DOM leak into the next.
 *
 *  `store` models the session store. Passing the same map to two loads is
 *  how a page refresh is modelled: the DOM is rebuilt from scratch, but
 *  the session store survives. */
async function loadAsset(origin: string, store: Map<string, string> = new Map()): Promise<Sandbox> {
  const source = fs.readFileSync(ASSET, "utf8");
  const elements: Record<string, FakeElement> = {
    "range-upload-form": new FakeElement("form"),
    "range-upload-file": new FakeElement("input"),
    "range-upload-start": new FakeElement("button"),
    "range-upload-progress": new FakeElement("progress"),
    "range-upload-status": new FakeElement("span"),
    "range-upload-submit": new FakeElement("button"),
    "range-upload-mode": new FakeElement("select"),
    "range-upload-confirm": new FakeElement("input"),
    "range-upload-confirm-field": new FakeElement("div"),
  };

  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    URLSearchParams: globalThis.URLSearchParams,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    Blob: globalThis.Blob,
    File: globalThis.File,
    FormData: globalThis.FormData,
    location: { href: origin + "/admin/ranges", origin },
    sessionStorage: {
      getItem(k: string): string | null {
        return store.has(k) ? (store.get(k) as string) : null;
      },
      setItem(k: string, v: string): void {
        store.set(k, v);
      },
      removeItem(k: string): void {
        store.delete(k);
      },
    },
  };

  const documentStub = {
    readyState: "complete",
    body: new FakeElement("body"),
    getElementById(id: string): FakeElement | null {
      return elements[id] ?? null;
    },
    querySelector(): null {
      return null;
    },
    querySelectorAll(): FakeElement[] {
      return [];
    },
    addEventListener(): void {
      /* the script may listen for DOMContentLoaded; readyState is complete */
    },
    createElement(tag: string): FakeElement {
      return new FakeElement(tag);
    },
  };

  sandbox.window = sandbox;
  sandbox.document = documentStub;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // Node's fetch needs an absolute URL; a browser resolves a relative one
  // against the page. The script uses relative URLs on purpose — a proxy
  // can put the app under a path prefix — so the harness resolves them the
  // way the browser would rather than changing the script.
  sandbox.fetch = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    return globalThis.fetch(url.startsWith("http") ? url : origin + url, init);
  }) as typeof fetch;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "range-upload.js" });

  return {
    elements,
  };
}

/** Wait for the microtask queue to drain, plus any timer the script set. */
async function settle(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let server: Server;
let origin: string;
let received: Received[] = [];
/** How many bytes the server credited for each chunk it received. */
let chunkCredits: number[] = [];
/** The server's own tally of what landed. */
let landed = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.startsWith("multipart/form-data")) {
        const parsed = parseMultipart(body, contentType);
        received.push({ path: req.url ?? "", ...parsed });
      } else {
        const fields: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(body.toString("utf8"))) {
          fields[key] = value;
        }
        received.push({ path: req.url ?? "", fields, fileName: "", fileBytes: Buffer.alloc(0) });
      }

      if ((req.url ?? "").endsWith("/upload/start")) {
        const payload = { id: 7, chunkBytes: 1024 };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      if ((req.url ?? "").endsWith("/upload/chunk")) {
        const sent = received[received.length - 1]!.fileBytes.length;
        // The server is the authority on what landed. It credits only
        // part of what it was sent, the way a truncated write would, so a
        // browser that counts for itself instead of following the reply
        // sends the next chunk at the wrong place.
        const credited = chunkCredits.length === 0 ? Math.floor(sent / 2) : sent;
        chunkCredits.push(credited);
        landed += credited;
        const payload = {
          nextOffset: landed,
          complete: false,
          receivedBytes: landed,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  received = [];
  chunkCredits = [];
  landed = 0;
});

/** A file of `size` bytes with recognisable content. */
function makeFile(size: number, name = "library.ipq"): File {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return new File([bytes], name, { type: "application/octet-stream" });
}

describe("the range uploader in the browser", () => {
  it("is shipped as an asset the page can load", () => {
    // A script that only defines functions and never wires them up would
    // pass every behavioural test below vacuously.
    expect(fs.existsSync(ASSET)).toBe(true);
    expect(fs.readFileSync(ASSET, "utf8")).toMatch(/addEventListener/);
  });

  it("uploads a file in chunks instead of in one request", async () => {
    const box = await loadAsset(origin);
    const file = makeFile(1000);
    box.elements["range-upload-file"]!.files = [file];

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    const starts = received.filter((r) => r.path.endsWith("/upload/start"));
    const chunks = received.filter((r) => r.path.endsWith("/upload/chunk"));
    expect(starts.length).toBe(1);
    // The whole point of the chunked path: the bytes do not go up in one
    // request. A single POST of a two-gigabyte file is what this avoids.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(starts.length + 100);
  });

  it("tells the server how big the file is before sending any bytes", async () => {
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(4096)];

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    const start = received.find((r) => r.path.endsWith("/upload/start"));
    expect(start).toBeDefined();
    expect(Number(start!.fields["totalBytes"])).toBe(4096);
    expect(start!.fields["filename"]).toBe("library.ipq");
  });

  it("sends each chunk at the offset the server asked for", async () => {
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(3000)];

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    const chunks = received.filter((r) => r.path.endsWith("/upload/chunk"));
    expect(chunks.length).toBeGreaterThan(0);
    // The server credited only half of the first chunk, the way a
    // truncated write would. The second chunk has to start where the
    // server said, not where the browser thinks it got to — otherwise the
    // assembled file has a hole in it.
    expect(Number(chunks[0]!.fields["offset"])).toBe(0);
    // The server credited only half of the first chunk, the way a
    // truncated write would, so the second chunk has to start at the
    // server's number rather than the browser's.
    expect(chunkCredits[0]).toBeLessThan(chunks[0]!.fileBytes.length);
    expect(Number(chunks[1]!.fields["offset"])).toBe(chunkCredits[0]);
    // Every chunk starts where the previous one was credited to end.
    // Every chunk starts where the server credited the previous one to
    // end — never where the browser thought it got to.
    let expected = 0;
    for (let i = 0; i < chunks.length; i++) {
      expect(Number(chunks[i]!.fields["offset"])).toBe(expected);
      expected += chunkCredits[i] ?? 0;
    }
    // And the transfer finishes: the last chunk reaches the end of the file.
    expect(expected).toBe(3000);
  });

  it("carries the csrf token with every request", async () => {
    const box = await loadAsset(origin);
    box.elements["range-upload-form"]!.setAttribute("data-csrf", "token-abc");
    box.elements["range-upload-file"]!.files = [makeFile(1000)];

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    // The server refuses a request without the token, so a chunked upload
    // that omits it gets 403 on the first chunk and the file never lands.
    for (const request of received) {
      expect(request.fields["csrf"]).toBe("token-abc");
    }
  });

  it("names the upload id on each chunk", async () => {
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(1000)];

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    for (const chunk of received.filter((r) => r.path.endsWith("/upload/chunk"))) {
      expect(Number(chunk.fields["uploadId"])).toBe(7);
    }
  });

  it("hands the upload id to the import when the file is fully sent", async () => {
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(2000)];

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    // The import is the last step: the browser posts the upload id and the
    // server streams the file off disk into the table.
    const imports = received.filter((r) => r.path.endsWith("/admin/ranges/import"));
    expect(imports.length).toBe(1);
    expect(Number(imports[0]!.fields["uploadId"])).toBe(7);
  });

  it("shows how far the upload has got", async () => {
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(2000)];

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    // The operator is looking at a two-gigabyte transfer; a page that says
    // nothing until the end is a page they assume has hung.
    const progress = box.elements["range-upload-progress"]!;
    expect(progress.getAttribute("value")).not.toBeNull();
    expect(Number(progress.getAttribute("value"))).toBeGreaterThan(0);
    expect(box.elements["range-upload-status"]!.textContent.length).toBeGreaterThan(0);
  });

  it("resumes an interrupted upload instead of starting over", async () => {
    // The operator's browser was closed half-way through a two-gigabyte
    // transfer. Re-picking the same file must not resend what already
    // landed — the browser has to remember where it got to, and the
    // server has to say where to continue.
    //
    // The session store is what survives a refresh: the browser cannot
    // restore a File into the file input, so the operator re-picks the
    // same file and the script recognises it by name and size.
    const store = new Map<string, string>();
    const box = await loadAsset(origin, store);
    box.elements["range-upload-file"]!.files = [makeFile(2000)];

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();
    const firstPass = received.filter((r) => r.path.endsWith("/upload/chunk")).length;
    expect(firstPass).toBeGreaterThan(0);
    // The transfer was interrupted, so the session store still holds the
    // upload id. (In this test it runs to the end; the store is cleared
    // only when the import succeeds, so a fresh store stands in for the
    // interrupted case below.)
    expect(store.size).toBe(0);

    // The interrupted case: the store still holds the record because the
    // transfer never finished.
    const interrupted = new Map<string, string>();
    interrupted.set("ipquery.range-upload.library.ipq.2000", JSON.stringify({
      uploadId: 7,
      offset: 1024,
      size: 2000,
      name: "library.ipq",
    }));
    received = [];
    const second = await loadAsset(origin, interrupted);
    second.elements["range-upload-file"]!.files = [makeFile(2000)];

    second.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    // The upload was resumed, not started over: there is no second
    // reservation, and the first chunk picks up where it left off.
    expect(received.filter((r) => r.path.endsWith("/upload/start")).length).toBe(0);
    const chunks = received.filter((r) => r.path.endsWith("/upload/chunk"));
    expect(chunks.length).toBeGreaterThan(0);
    expect(Number(chunks[0]!.fields["offset"])).toBe(1024);
    expect(Number(chunks[0]!.fields["uploadId"])).toBe(7);
  });

  it("does not resume a different file that happens to have the same name", async () => {
    // The store is keyed by name and size. A different file with the same
    // name but a different size is a different file, and resuming it
    // would splice two files together.
    const store = new Map<string, string>();
    store.set("ipquery.range-upload.library.ipq.2000", JSON.stringify({
      uploadId: 7,
      offset: 1024,
      size: 2000,
      name: "library.ipq",
    }));
    const box = await loadAsset(origin, store);
    box.elements["range-upload-file"]!.files = [makeFile(999)];

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    // A different size means a fresh upload.
    expect(received.filter((r) => r.path.endsWith("/upload/start")).length).toBe(1);
    const chunks = received.filter((r) => r.path.endsWith("/upload/chunk"));
    expect(Number(chunks[0]!.fields["offset"])).toBe(0);
  });

  it("continues from the offset the page was told about", async () => {
    // The server also writes the offset into the markup, so a page that
    // was re-rendered with the upload still in progress can continue
    // without a round trip.
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(2000)];
    box.elements["range-upload-file"]!.setAttribute("data-resume-id", "7");
    box.elements["range-upload-file"]!.setAttribute("data-resume-offset", "1000");

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    const chunks = received.filter((r) => r.path.endsWith("/upload/chunk"));
    expect(chunks.length).toBeGreaterThan(0);
    expect(Number(chunks[0]!.fields["offset"])).toBe(1000);
  });

  it("does nothing when no file was chosen", async () => {
    const box = await loadAsset(origin);
    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();
    expect(received.length).toBe(0);
  });

  it("asks for a replacement only when the operator chose one", async () => {
    // A replacement is the destructive direction. The page has to carry
    // the operator's confirmation number through to the server — the
    // server is what enforces it, but the number has to arrive.
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(1000)];
    box.elements["range-upload-mode"]!.value = "replace";
    box.elements["range-upload-confirm"]!.value = "4242";

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    const importRequest = received.find((r) => r.path.endsWith("/admin/ranges/import"));
    expect(importRequest).toBeDefined();
    expect(importRequest!.fields["mode"]).toBe("replace");
    expect(importRequest!.fields["confirmRows"]).toBe("4242");
  });

  it("merges when the operator did not ask for a replacement", async () => {
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(1000)];
    box.elements["range-upload-mode"]!.value = "merge";

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    const importRequest = received.find((r) => r.path.endsWith("/admin/ranges/import"));
    expect(importRequest).toBeDefined();
    expect(importRequest!.fields["mode"]).toBe("merge");
    // A merge carries no confirmation — there is nothing to confirm.
    expect(importRequest!.fields["confirmRows"]).toBeUndefined();
  });

  it("refuses to start a replacement that was not confirmed", async () => {
    // The server would refuse it anyway. Refusing here means a
    // two-gigabyte file does not travel to be turned away at the end.
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(1000)];
    box.elements["range-upload-mode"]!.value = "replace";
    box.elements["range-upload-confirm"]!.value = "";

    box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
    await settle();

    expect(received.length).toBe(0);
    expect(box.elements["range-upload-status"]!.textContent).toMatch(/confirm/i);
  });

  it("says why it stopped when the server refuses a chunk", async () => {
    // A 403 or a 500 on a chunk must not look like a silent hang. The
    // operator has to see the reason next to the progress bar.
    const box = await loadAsset(origin);
    box.elements["range-upload-file"]!.files = [makeFile(1000)];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/upload/chunk")) {
        return new Response(JSON.stringify({ error: "the upload is not complete" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input as never, init);
    }) as typeof fetch;

    try {
      box.elements["range-upload-start"]!.dispatch("click", { preventDefault() {} });
      await settle();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const status = box.elements["range-upload-status"]!.textContent;
    expect(status).toContain("not complete");
    // A failed upload must not go on to import a file that never arrived.
    expect(received.filter((r) => r.path.endsWith("/admin/ranges/import")).length).toBe(0);
  });
});
