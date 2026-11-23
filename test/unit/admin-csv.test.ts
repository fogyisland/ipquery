// SPDX-License-Identifier: MIT
//
// The admin console's CSV export.
//
// `csvForRows` is the last thing between a row's contents and a spreadsheet.
// Everything it gets is operator-visible text that an outside party wrote:
// a user-chosen email, a city name from a scraped data file, an IP range
// comment. So the escaping is not cosmetic — a value containing a comma
// silently shifts every column after it, and a value containing a newline
// silently becomes two rows. The export is "download a CSV" from the
// console, so nobody is looking at the raw bytes when it goes wrong.
//
// The rules below are the RFC 4180 ones, and they are worth pinning down
// because the failure mode is invisible until someone opens the file.
import { describe, it, expect } from "vitest";
import { csvForRows, withBom, type CsvColumn } from "../../src/web/admin/csv";

interface Row {
  email: string;
  count: number;
  note: string | null;
}

const columns: CsvColumn<Row>[] = [
  { header: "Email", get: (row) => row.email },
  { header: "Count", get: (row) => row.count },
  { header: "Note", get: (row) => row.note },
];

function parseCsv(text: string): string[][] {
  // A deliberately small RFC 4180 reader: it is the only honest way to
  // check that quoting survived, because a string comparison would accept
  // `a,b` and `"a,b"` alike.
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("csvForRows", () => {
  it("writes the headers on the first line", () => {
    const csv = csvForRows<Row>([], columns);
    expect(csv.split("\r\n")[0]).toBe("Email,Count,Note");
  });

  it("writes one line per row, in order", () => {
    const csv = csvForRows<Row>(
      [
        { email: "a@x.com", count: 1, note: null },
        { email: "b@x.com", count: 2, note: "two" },
      ],
      columns,
    );
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ["Email", "Count", "Note"],
      ["a@x.com", "1", ""],
      ["b@x.com", "2", "two"],
    ]);
  });

  it("writes only the header when there are no rows", () => {
    const csv = csvForRows<Row>([], columns);
    expect(parseCsv(csv)).toEqual([["Email", "Count", "Note"]]);
  });

  it("ends the last row with CRLF", () => {
    const csv = csvForRows<Row>([{ email: "a@x.com", count: 1, note: null }], columns);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("renders null and undefined as an empty field", () => {
    const csv = csvForRows<Row>([{ email: "a@x.com", count: 0, note: null }], columns);
    expect(parseCsv(csv)[1]).toEqual(["a@x.com", "0", ""]);
  });

  it("quotes a value containing a comma so the columns do not shift", () => {
    const csv = csvForRows<Row>([{ email: "a@x.com", count: 1, note: "Paris, France" }], columns);
    expect(csv).toContain('"Paris, France"');
    expect(parseCsv(csv)[1]).toEqual(["a@x.com", "1", "Paris, France"]);
  });

  it("doubles an embedded quote instead of ending the field", () => {
    // A lone `"` inside a value would close the quoted field early, and
    // everything after it would be read as new columns.
    const csv = csvForRows<Row>([{ email: "a@x.com", count: 1, note: 'say "hi"' }], columns);
    expect(csv).toContain('"say ""hi"""');
    expect(parseCsv(csv)[1]).toEqual(["a@x.com", "1", 'say "hi"']);
  });

  it("quotes a value containing a newline so it does not become two rows", () => {
    const csv = csvForRows<Row>([{ email: "a@x.com", count: 1, note: "line1\nline2" }], columns);
    expect(parseCsv(csv)).toHaveLength(2);
    expect(parseCsv(csv)[1]).toEqual(["a@x.com", "1", "line1\nline2"]);
  });

  it("quotes a value containing a carriage return", () => {
    const csv = csvForRows<Row>([{ email: "a@x.com", count: 1, note: "a\rb" }], columns);
    expect(csv).toContain('"a\rb"');
  });

  it("quotes a header that contains a comma", () => {
    const csv = csvForRows<Row>([], [{ header: "IP, Range", get: () => "x" }]);
    expect(csv.split("\r\n")[0]).toBe('"IP, Range"');
  });

  it("does not quote a value that needs no quoting", () => {
    const csv = csvForRows<Row>([{ email: "a@x.com", count: 7, note: "plain" }], columns);
    expect(csv).toContain("a@x.com,7,plain");
  });
});

describe("withBom", () => {
  it("prepends a UTF-8 byte order mark", () => {
    expect(withBom("a,b\r\n")).toBe("﻿a,b\r\n");
  });

  it("prepends exactly one BOM and leaves the body alone", () => {
    const out = withBom("x");
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe("x");
  });
});
