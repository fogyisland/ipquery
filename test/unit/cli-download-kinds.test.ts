// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  ALL_SPECS,
  DEFAULT_SPECS,
  EXTRA_SPECS,
  parseDownloadKinds,
  type DownloadKind,
} from "../../src/etl/download";

const _acceptedKind: DownloadKind = "runishiwo-v6";
void _acceptedKind;
// @ts-expect-error FixedKind must stay a closed literal union.
const _rejectedKind: DownloadKind = "unknown-source";
void _rejectedKind;

describe("parseDownloadKinds", () => {
  it("defaults to the seven specs in canonical order", () => {
    expect(parseDownloadKinds(undefined)).toEqual([...ALL_SPECS]);
    expect(parseDownloadKinds(",, ")).toEqual([...ALL_SPECS]);
    expect(ALL_SPECS).toHaveLength(7);
  });

  it("selects a monthly and a fixed spec by kind", () => {
    expect(parseDownloadKinds("city,sapics-user")).toEqual([
      DEFAULT_SPECS[0],
      EXTRA_SPECS[3],
    ]);
  });

  it("rejects an unknown kind and names all seven valid kinds", () => {
    let thrown: unknown;
    try {
      parseDownloadKinds("city,bogus");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("bogus");
    for (const kind of [
      "city",
      "country",
      "asn",
      "metowolf-cn",
      "runishiwo-cn",
      "runishiwo-v6",
      "sapics-user",
    ]) {
      expect(message).toContain(kind);
    }
  });
});
