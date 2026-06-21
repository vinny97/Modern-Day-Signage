#!/usr/bin/env node
require('./load-env').loadEnv();

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.STORAGE_DRIVER = 'r2';
const storage = require('../server/lib/storage');

async function main() {
  const filename = `migration-check-${crypto.randomUUID()}.txt`;
  const local = path.join(os.tmpdir(), filename);
  const expected = `ScreenTinker R2 verification ${new Date().toISOString()}`;
  fs.writeFileSync(local, expected);
  try {
    await storage.putFile('migration-checks', filename, local, 'text/plain');
    const object = await storage.getObject('migration-checks', filename);
    const actual = Buffer.from(await object.body.transformToByteArray()).toString('utf8');
    if (actual !== expected) throw new Error('R2 round-trip content mismatch');
    await storage.deleteObject('migration-checks', filename);
    console.log('ok R2 put/get/delete round trip');
  } finally {
    try { fs.unlinkSync(local); } catch {}
    try { await storage.deleteObject('migration-checks', filename); } catch {}
  }
}

main().catch(error => {
  console.error(`R2 verification failed: ${error.message}`);
  process.exitCode = 1;
});
