#!/usr/bin/env node
'use strict';

/**
 * Optional: download an open-source CJK font so burned-in subtitles/titles can
 * render Chinese out of the box. Not run automatically (the app works without
 * it — libass falls back to any system font). Run when you want a bundled font:
 *
 *   npm run fetch:font
 *
 * Uses a mirror-friendly source and writes to assets/fonts. Idempotent; never
 * hard-fails.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DEST_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const DEST = path.join(DEST_DIR, 'NotoSansSC-Regular.otf');

// jsDelivr mirrors the google/fonts repo and is usually reachable in CN.
const SOURCES = [
  'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
  'https://fastly.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
];

function log(m) { console.log(`[fetch-font] ${m}`); }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.rmSync(tmp, { force: true });
        const redirected = new URL(res.headers.location, url).toString();
        return download(redirected, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.rmSync(tmp, { force: true });
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve(); }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => { file.close(); fs.rmSync(tmp, { force: true }); reject(e); });
  });
}

(async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  if (fs.existsSync(DEST) && fs.statSync(DEST).size > 1e6) {
    log('字体已存在，跳过。');
    return;
  }
  for (const url of SOURCES) {
    try {
      log(`下载中：${url}`);
      await download(url, DEST);
      if (fs.statSync(DEST).size > 1e6) {
        log(`完成：${DEST}`);
        return;
      }
    } catch (e) {
      log(`失败（${e.message}），尝试下一个源…`);
    }
  }
  log('所有源都失败。可手动下载任意中文 .otf/.ttf 放到 assets/fonts/ 即可。');
  process.exitCode = 0; // never break installs
})();
