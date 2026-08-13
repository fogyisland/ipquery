// SPDX-License-Identifier: MIT
const fs = require('fs');
const path = require('path');
fs.mkdirSync(path.join(__dirname, '..', 'dist', 'storage'), { recursive: true });
fs.copyFileSync(
  path.join(__dirname, '..', 'src', 'storage', 'schema.sql'),
  path.join(__dirname, '..', 'dist', 'storage', 'schema.sql'),
);
