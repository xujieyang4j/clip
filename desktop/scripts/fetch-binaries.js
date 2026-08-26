#!/usr/bin/env node
'use strict';

/**
 * postinstall helper: make sure the two native binaries the app bundles
 * (ffmpeg-static's ffmpeg, and the Electron runtime) actually landed, and if a
 * download was skipped/failed, retry it against the npmmirror.com mirror.
 *
 * Why this exists:
 *   - Electron's own postinstall already honours `electron_mirror` from .npmrc,
 *     so it usually just works — but we still verify and can re-fetch.
 *   - ffmpeg-static picks its download URL from the FFMPEG_BINARIES_URL env var,
 *     which .npmrc cannot inject. So we set it here and re-run its installer.
 *
 * The script is idempotent and never hard-fails `npm install`: if the network
 * is unavailable it prints clear guidance and exits 0, so the user can retry
 * with `npm run fetch:binaries` later.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MIRROR = {
  ffmpeg: process.env.FFMPEG_BINARIES_URL ||
    'https://registry.npmmirror.com/-/binary/ffmpeg-static',
  electron: process.env.ELECTRON_MIRROR ||
    'https://registry.npmmirror.com/-/binary/electron/',
};

// A real ffmpeg/electron binary is tens of MB; anything smaller means the
// download was skipped or truncated.
const MIN_BINARY_BYTES = 10 * 1024 * 1024;

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

function log(msg) {
  console.log(`[fetch-binaries] ${msg}`);
}

/** Resolve a dependency's directory without importing its (heavy) main. */
function pkgDir(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

function ensureFfmpeg() {
  let binPath;
  try {
    binPath = require('ffmpeg-static'); // just a path string
  } catch {
    log('ffmpeg-static 未安装，跳过。');
    return;
  }
  const size = sizeOf(binPath);
  if (size >= MIN_BINARY_BYTES) {
    log(`ffmpeg 已就绪 (${(size / 1e6).toFixed(0)} MB)。`);
    return;
  }
  const dir = pkgDir('ffmpeg-static');
  const installer = dir && path.join(dir, 'install.js');
  if (!installer || !fs.existsSync(installer)) {
    log('找不到 ffmpeg-static/install.js，跳过。');
    return;
  }
  log(`ffmpeg 缺失/不完整，正从镜像下载：${MIRROR.ffmpeg}`);
  try {
    // Remove any truncated file so the installer re-downloads.
    try { fs.rmSync(binPath, { force: true }); } catch {}
    execFileSync(process.execPath, [installer], {
      stdio: 'inherit',
      env: { ...process.env, FFMPEG_BINARIES_URL: MIRROR.ffmpeg },
    });
    const after = sizeOf(binPath);
    if (after >= MIN_BINARY_BYTES) {
      try { fs.chmodSync(binPath, 0o755); } catch {}
      log(`ffmpeg 下载完成 (${(after / 1e6).toFixed(0)} MB)。`);
    } else {
      log('ffmpeg 下载后仍不完整，请检查网络后重试 `npm run fetch:binaries`。');
    }
  } catch (e) {
    log(`ffmpeg 下载失败：${e.message.split('\n')[0]}`);
    log('联网后可重试：npm run fetch:binaries');
  }
}

function ensureElectron() {
  const dir = pkgDir('electron');
  if (!dir) {
    log('electron 未安装，跳过。');
    return;
  }
  // electron writes the unpacked binary path into path.txt inside its dir.
  const pathTxt = path.join(dir, 'path.txt');
  const distDir = path.join(dir, 'dist');
  const hasDist = fs.existsSync(distDir) && fs.readdirSync(distDir).length > 0;
  if (fs.existsSync(pathTxt) && hasDist) {
    log('Electron 运行时已就绪。');
    return;
  }
  const installer = path.join(dir, 'install.js');
  if (!fs.existsSync(installer)) {
    log('找不到 electron/install.js，跳过。');
    return;
  }
  log(`Electron 运行时缺失，正从镜像下载：${MIRROR.electron}`);
  try {
    execFileSync(process.execPath, [installer], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_MIRROR: MIRROR.electron },
    });
    log('Electron 运行时下载完成。');
  } catch (e) {
    log(`Electron 下载失败：${e.message.split('\n')[0]}`);
    log('联网后可重试：npm run fetch:binaries');
  }
}

ensureElectron();
ensureFfmpeg();
