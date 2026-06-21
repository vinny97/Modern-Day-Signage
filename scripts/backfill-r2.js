#!/usr/bin/env node
require('./load-env').loadEnv();

const fs = require('fs');
const path = require('path');

process.env.STORAGE_DRIVER = 'r2';

const config = require('../server/config');
const { db } = require('../server/db/client');
const storage = require('../server/lib/storage');

const dryRun = process.argv.includes('--dry-run');
const deleteLocal = process.argv.includes('--delete-local');
const skipApk = process.argv.includes('--skip-apk');

function sourcePath(kind, filename) {
  const dir = kind === 'screenshots' ? config.screenshotsDir
    : kind === 'apk' ? config.dataDir
      : config.contentDir;
  return path.join(dir, path.basename(filename));
}

async function candidates() {
  const rows = [];
  for (const content of await db.prepare('SELECT filepath, thumbnail_path, mime_type FROM content').all()) {
    if (content.filepath && !/^https?:\/\//i.test(content.filepath)) {
      rows.push({ kind: 'content', filename: content.filepath, contentType: content.mime_type || 'application/octet-stream' });
    }
    if (content.thumbnail_path && !/^https?:\/\//i.test(content.thumbnail_path)) {
      rows.push({ kind: 'content', filename: content.thumbnail_path, contentType: 'image/jpeg' });
    }
  }
  for (const screenshot of await db.prepare('SELECT filepath FROM screenshots WHERE filepath IS NOT NULL').all()) {
    rows.push({ kind: 'screenshots', filename: screenshot.filepath, contentType: 'image/jpeg' });
  }
  if (!skipApk) {
    const dataApk = sourcePath('apk', 'ScreenTinker.apk');
    const repoApk = path.join(__dirname, '..', 'ScreenTinker.apk');
    const apkPath = fs.existsSync(dataApk) ? dataApk : (fs.existsSync(repoApk) ? repoApk : null);
    if (apkPath) rows.push({ kind: 'apk', filename: 'ScreenTinker.apk', contentType: 'application/vnd.android.package-archive', source: apkPath });
  }
  const unique = new Map();
  for (const row of rows) unique.set(`${row.kind}/${path.basename(row.filename)}`, row);
  return [...unique.values()];
}

async function main() {
  const stats = { total: 0, uploaded: 0, skipped: 0, missingLocal: 0, failed: 0, deletedLocal: 0 };
  for (const item of await candidates()) {
    stats.total += 1;
    const local = item.source || sourcePath(item.kind, item.filename);
    if (!fs.existsSync(local)) {
      stats.missingLocal += 1;
      console.warn(`missing local source: ${local}`);
      continue;
    }
    const size = fs.statSync(local).size;
    try {
      const existing = dryRun ? null : await storage.headObject(item.kind, item.filename);
      if (existing && Number(existing.contentLength) === size) {
        stats.skipped += 1;
        console.log(`skip ${storage.key(item.kind, item.filename)} (${size} bytes)`);
      } else if (dryRun) {
        console.log(`would upload ${storage.key(item.kind, item.filename)} (${size} bytes)`);
      } else {
        await storage.putFile(item.kind, item.filename, local, item.contentType);
        const uploaded = await storage.headObject(item.kind, item.filename);
        if (!uploaded || Number(uploaded.contentLength) !== size) throw new Error('uploaded size verification failed');
        stats.uploaded += 1;
        console.log(`uploaded ${storage.key(item.kind, item.filename)} (${size} bytes)`);
      }
      if (!dryRun && deleteLocal) {
        fs.unlinkSync(local);
        stats.deletedLocal += 1;
      }
    } catch (error) {
      stats.failed += 1;
      console.error(`failed ${item.kind}/${path.basename(item.filename)}: ${error.message}`);
    }
  }
  console.log(JSON.stringify(stats));
  if (stats.failed) process.exitCode = 1;
}

main()
  .catch(error => { console.error(`R2 backfill failed: ${error.message}`); process.exitCode = 1; })
  .finally(() => db.close());
