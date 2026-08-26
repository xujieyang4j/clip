#!/usr/bin/env node
'use strict';

/**
 * Optional: download a whisper.cpp ggml model for the local auto-subtitle
 * feature. Models are large (75MB–1.5GB) and not bundled. Run when you want it:
 *
 *   npm run fetch:whisper-model            # default: small (~466MB, good CN)
 *   npm run fetch:whisper-model -- base    # smaller/faster, less accurate
 *   npm run fetch:whisper-model -- medium  # larger/slower, more accurate
 *
 * Tries HuggingFace mirrors that are usually reachable in China first. Writes
 * to assets/models/ggml-<name>.bin. Idempotent; never hard-fails.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const name = (process.argv[2] || 'small').replace(/[^a-z0-9._-]/gi, '');
const file = `ggml-${name}.bin`;
const DEST_DIR = path.join(__dirname, '..', 'assets', 'models');
const DEST = path.join(DEST_DIR, file);

// Mirror-first so CN networks succeed; official HF last.
const HOSTS = [
  'https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/',
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
];

function log(m) { console.log(`[fetch-whisper-model] ${m}`); }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        out.close(); fs.rmSync(tmp, { force: true });
        const redirected = new URL(res.headers.location, url).toString();
        return download(redirected, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        out.close(); fs.rmSync(tmp, { force: true });
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0, lastPct = -1;
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`\r  ${pct}%  `); }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); process.stdout.write('\n'); resolve(); }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { out.close(); fs.rmSync(tmp, { force: true }); reject(e); });
  });
}

(async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  if (fs.existsSync(DEST) && fs.statSync(DEST).size > 1e7) {
    log(`模型已存在：${DEST}，跳过。`);
    return;
  }
  log(`目标模型：${file}`);
  for (const host of HOSTS) {
    const url = host + file;
    try {
      log(`下载中：${url}`);
      await download(url, DEST);
      if (fs.statSync(DEST).size > 1e7) {
        log(`完成：${DEST}`);
        return;
      }
    } catch (e) {
      log(`失败（${e.message}），尝试下一个源…`);
    }
  }
  log('所有源都失败。可手动下载 ggml 模型放到 assets/models/ 后再用自动字幕。');
  log('例如从 modelscope.cn 搜索 “whisper ggml”，或 hf-mirror.com/ggerganov/whisper.cpp');
  process.exitCode = 0;
})();
