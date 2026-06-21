'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const isR2 = config.storageDriver === 'r2';
let client;

function r2Client() {
  if (!isR2) return null;
  if (!config.r2AccountId || !config.r2AccessKeyId || !config.r2SecretAccessKey || !config.r2Bucket) {
    throw new Error('R2 storage requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET');
  }
  if (!client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey },
    });
  }
  return client;
}

function key(kind, filename) {
  const clean = path.basename(filename);
  return [config.r2Prefix, kind, clean].filter(Boolean).join('/');
}

function localPath(kind, filename) {
  const dir = kind === 'screenshots' ? config.screenshotsDir
    : kind === 'apk' ? config.dataDir
      : config.contentDir;
  return path.join(dir, path.basename(filename));
}

async function putFile(kind, filename, sourcePath, contentType) {
  if (!isR2) return filename;
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await r2Client().send(new PutObjectCommand({
    Bucket: config.r2Bucket,
    Key: key(kind, filename),
    Body: fs.createReadStream(sourcePath),
    ContentType: contentType || undefined,
  }));
  return filename;
}

async function getObject(kind, filename) {
  if (!isR2) return { localPath: localPath(kind, filename) };
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const result = await r2Client().send(new GetObjectCommand({ Bucket: config.r2Bucket, Key: key(kind, filename) }));
  return { body: result.Body, contentType: result.ContentType, contentLength: result.ContentLength };
}

async function headObject(kind, filename) {
  if (!isR2) {
    const target = localPath(kind, filename);
    try {
      const stat = fs.statSync(target);
      return { contentLength: stat.size, lastModified: stat.mtime };
    } catch { return null; }
  }
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const result = await r2Client().send(new HeadObjectCommand({ Bucket: config.r2Bucket, Key: key(kind, filename) }));
    return { contentLength: result.ContentLength, contentType: result.ContentType, lastModified: result.LastModified };
  } catch (error) {
    if (error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function deleteObject(kind, filename) {
  if (!filename) return;
  if (!isR2) {
    const target = localPath(kind, filename);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await r2Client().send(new DeleteObjectCommand({ Bucket: config.r2Bucket, Key: key(kind, filename) }));
}

async function sendObject(res, kind, filename, fallbackType) {
  const object = await getObject(kind, filename);
  if (object.localPath) return res.sendFile(object.localPath);
  if (object.contentType || fallbackType) res.type(object.contentType || fallbackType);
  if (object.contentLength != null) res.setHeader('Content-Length', String(object.contentLength));
  object.body.on('error', error => res.destroy(error));
  object.body.pipe(res);
}

module.exports = { isR2, putFile, getObject, headObject, deleteObject, sendObject, key };
