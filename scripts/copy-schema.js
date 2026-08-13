// SPDX-License-Identifier: MIT
const fs = require('fs');
const path = require('path');

const distStorage = path.join(__dirname, '..', 'dist', 'storage');
fs.mkdirSync(distStorage, { recursive: true });
fs.copyFileSync(
  path.join(__dirname, '..', 'src', 'storage', 'schema.sql'),
  path.join(distStorage, 'schema.sql'),
);

const distMigrations = path.join(distStorage, 'migrations');
fs.mkdirSync(distMigrations, { recursive: true });
const srcMigrations = path.join(__dirname, '..', 'src', 'storage', 'migrations');
for (const file of fs.readdirSync(srcMigrations)) {
  if (file.endsWith('.sql')) {
    fs.copyFileSync(path.join(srcMigrations, file), path.join(distMigrations, file));
  }
}
