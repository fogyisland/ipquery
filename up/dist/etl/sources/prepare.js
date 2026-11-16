"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.materializeRecords = materializeRecords;
exports.prepareGithubSources = prepareGithubSources;
// SPDX-License-Identifier: MIT
const path = __importStar(require("node:path"));
const dedupe_1 = require("./dedupe");
async function* materializeRecords(records) {
    yield* records;
}
async function prepareGithubSources(files, rawDir) {
    const byFile = new Map();
    const inputs = [];
    for (const file of files) {
        const { records, stats } = file.parse(path.join(rawDir, file.filename));
        byFile.set(file.etlSource, stats);
        for await (const record of records)
            inputs.push(record);
    }
    const dedupe = await (0, dedupe_1.dedupeSourceRecords)(materializeRecords(inputs));
    for (const [etlSource, stats] of byFile) {
        byFile.set(etlSource, {
            ...stats,
            rowsEmitted: dedupe.stats.emittedByFile[etlSource] ?? 0,
            gunzipErrors: 0,
        });
    }
    return { byFile, dedupe };
}
//# sourceMappingURL=prepare.js.map