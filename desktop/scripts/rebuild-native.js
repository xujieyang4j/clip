#!/usr/bin/env node
'use strict';

/**
 * Rebuild optional native modules for Electron's Node ABI. smart-whisper's npm
 * install compiles for the host Node runtime; Electron uses a different ABI.
 * electron-builder's install-app-deps performs the required rebuild.
 *
 * This helper is deliberately non-fatal because smart-whisper is optional: the
 * video editor must still install when a machine has no compiler toolchain.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let installed = false;
try { require.resolve('smart-whisper/package.json'); installed = true; } catch {}
if (!installed) {
  console.log('[rebuild-native] smart-whisper 未安装，跳过 Electron 原生模块重建。');
  process.exit(0);
}

const exe = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder';
const bin = path.join(__dirname, '..', 'node_modules', '.bin', exe);
const writableHome = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclip-native-'));
try {
  execFileSync(bin, ['install-app-deps', `--arch=${process.arch}`], {
    stdio: 'inherit',
    env: {
      ...process.env,
      COMPUTE_BACKEND: process.env.COMPUTE_BACKEND || 'cpu',
      // Some managed/dev environments expose a read-only HOME; node-gyp needs
      // a writable cache for Electron headers.
      HOME: writableHome,
      npm_config_devdir: path.join(writableHome, '.electron-gyp'),
    },
  });
  console.log('[rebuild-native] smart-whisper 已按 Electron ABI 重建。');
} catch (e) {
  console.warn('[rebuild-native] 原生语音引擎重建失败；视频编辑仍可使用，自动字幕会不可用。');
  console.warn('[rebuild-native] 安装 C/C++ 编译工具后重跑：node scripts/rebuild-native.js');
} finally {
  try { fs.rmSync(writableHome, { recursive: true, force: true }); } catch {}
}
