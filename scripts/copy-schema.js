// SPDX-License-Identifier: MIT
const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const distStorage = path.join(projectRoot, "dist", "storage");
fs.mkdirSync(distStorage, { recursive: true });
fs.copyFileSync(path.join(projectRoot, "src", "storage", "schema.sql"), path.join(distStorage, "schema.sql"));

const distMigrations = path.join(distStorage, "migrations");
fs.mkdirSync(distMigrations, { recursive: true });
const srcMigrations = path.join(projectRoot, "src", "storage", "migrations");
for (const file of fs.readdirSync(srcMigrations)) {
  if (file.endsWith(".sql")) {
    fs.copyFileSync(path.join(srcMigrations, file), path.join(distMigrations, file));
  }
}

// Copy the optional demo seed rows. They are deliberately NOT a
// migration — `node dist/cli.js seed:demo` loads them on request, so a
// production database never ends up holding them by accident.
const distSeed = path.join(distStorage, "seed");
fs.mkdirSync(distSeed, { recursive: true });
const srcSeed = path.join(projectRoot, "src", "storage", "seed");
if (fs.existsSync(srcSeed)) {
  for (const file of fs.readdirSync(srcSeed)) {
    if (file.endsWith(".sql")) {
      fs.copyFileSync(path.join(srcSeed, file), path.join(distSeed, file));
    }
  }
}

// Copy web assets the runtime needs: view templates, static assets, i18n bundles.
// Without these, `node dist/cli.js serve` crashes:
//   - @fastify/view can't find .hbs templates
//   - @fastify/static can't serve /assets/*
//   - req.t() can't resolve i18n keys
const webSubdirs = ["views", "assets", "i18n"];
for (const sub of webSubdirs) {
  const src = path.join(projectRoot, "src", "web", sub);
  const dest = path.join(projectRoot, "dist", "web", sub);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, dest, { recursive: true });
}
