'use strict';

/** Persist renderer-recorded microphone audio as a local project asset. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_RECORDING_BYTES = 512 * 1024 * 1024;

function extensionForMime(mimeType) {
  // Chromium currently records Opus in WebM on desktop. Keep the lookup
  // deliberately narrow: an unknown recording format must not masquerade as
  // a playable audio file.
  if (/^audio\/webm(?:;|$)/i.test(String(mimeType || ''))) return '.webm';
  if (/^audio\/ogg(?:;|$)/i.test(String(mimeType || ''))) return '.ogg';
  throw new Error('不支持的录音格式：' + (mimeType || '未知'));
}

function bytesFrom(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  throw new Error('录音数据无效');
}

function saveRecording(directory, data, mimeType, now = Date.now()) {
  const bytes = bytesFrom(data);
  if (!bytes.length) throw new Error('录音为空');
  if (bytes.length > MAX_RECORDING_BYTES) throw new Error('录音超过 512 MB 限制');
  const ext = extensionForMime(mimeType);
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true });
  let filePath;
  do {
    const suffix = crypto.randomBytes(5).toString('hex');
    filePath = path.join(root, 'voice-' + now + '-' + suffix + ext);
  } while (fs.existsSync(filePath));
  fs.writeFileSync(filePath, bytes, { flag: 'wx' });
  return filePath;
}

module.exports = { MAX_RECORDING_BYTES, extensionForMime, bytesFrom, saveRecording };
