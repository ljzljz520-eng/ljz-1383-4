'use strict';
const path = require('path');
const fs = require('fs');
const { createApp } = require('./server');
const { seed } = require('./seed');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const app = createApp({
  storeFile: path.join(dataDir, 'store.json'),
  auditFile: path.join(dataDir, 'audit.log'),
});

if (seed(app.store)) console.log('[seed] demo cases created');

app.store.save().then(() => {
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, () => console.log(`translator-site listening on http://127.0.0.1:${port}`));
});
