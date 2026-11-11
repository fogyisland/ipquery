"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.csvForRows = csvForRows;
exports.withBom = withBom;
function csvForRows(rows, columns) {
    const escape = (v) => {
        if (v == null)
            return "";
        const s = String(v);
        if (/[",\n\r]/.test(s))
            return `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    const head = columns.map((c) => escape(c.header)).join(",");
    const body = rows.map((r) => columns.map((c) => escape(c.get(r))).join(",")).join("\r\n");
    return body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}
function withBom(s) {
    return "﻿" + s;
}
//# sourceMappingURL=csv.js.map