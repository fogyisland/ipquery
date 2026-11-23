const applied = Array.from({ length: 40 }, (_, i) => ({ version: String(i).padStart(3, "0") }));
const queries = [];
const pool = {
  query: (sql) => {
    queries.push(sql);
    if (sql.includes("schema_migrations")) return Promise.resolve([applied, []]);
    return Promise.resolve([[], []]);
  },
};
const { runMigrations } = await import("./src/storage/migrations/runner.ts");
try {
  const r = await runMigrations(pool);
  console.log("OK applied:", r.applied, "skipped:", r.skipped.length);
} catch (e) {
  console.log("THREW:", e && e.message);
}
console.log("queries:", queries.length);
for (const q of queries) console.log("  Q:", q.slice(0, 90).replace(/\n/g, " "));
