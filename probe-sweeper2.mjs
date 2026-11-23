const applied = Array.from({ length: 40 }, (_, i) => ({ version: String(i).padStart(3, "0") }));
const queries = [];
const pool = {
  query: (sql) => {
    queries.push(sql);
    if (sql.includes("schema_migrations")) return Promise.resolve([applied, []]);
    return Promise.resolve([[], []]);
  },
};
const { purgeAbandonedUploads } = await import("./src/storage/rangeUpload.ts");
try {
  const n = await purgeAbandonedUploads(pool);
  console.log("OK purged:", n);
} catch (e) {
  console.log("THREW:", e && e.message);
}
console.log("queries:", queries.length);
for (const q of queries) console.log("  Q:", q.slice(0, 100).replace(/\n/g, " "));
