'use strict';

/**
 * Local speech-to-text (auto subtitles) via whisper.cpp, using the optional
 * `smart-whisper` native addon. Fully offline once a model is present.
 *
 * Design goals:
 *   - No hard dependency: if `smart-whisper` isn't installed, callers get a
 *     clear, actionable error instead of a crash.
 *   - Model is NOT bundled (models are 75MB–1.5GB). It's looked up in
 *     assets/models; if missing we report where to put it / how to fetch it.
 *   - Audio is extracted from the given media with the bundled ffmpeg to the
 *     16 kHz mono float PCM whisper.cpp expects — this part is pure enough to
 *     unit-test (see buildPcmExtractArgs / decodePcm / segmentsToOverlays).
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBinaries } = require('./ffmpeg-runner');

/** Development fallback shipped beside the sources (never assumed writable). */
function bundledModelsDir() {
  let dir = path.join(__dirname, '..', 'assets', 'models');
  if (dir.includes(`app.asar${path.sep}`)) {
    dir = dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  }
  return dir;
}

/**
 * Writable model directory. The main process passes app.getPath('userData') in
 * packaged builds; pure Node tests/dev fall back to MINICLIP_MODELS_DIR and
 * finally the source-tree assets/models directory.
 */
function modelsDir(explicitDir) {
  return explicitDir || process.env.MINICLIP_MODELS_DIR || bundledModelsDir();
}

/** Preference order when the caller doesn't name a model. */
const MODEL_PREFERENCE = [
  'ggml-medium.bin', 'ggml-small.bin', 'ggml-base.bin', 'ggml-tiny.bin',
  'ggml-medium-q5_0.bin', 'ggml-small-q5_1.bin', 'ggml-base-q5_1.bin', 'ggml-tiny-q5_1.bin',
];

/** Find an available model file, or null. */
function findModel(preferred, explicitDir, includeBundledFallback = true) {
  const dirs = [...new Set([
    modelsDir(explicitDir),
    ...(includeBundledFallback ? [bundledModelsDir()] : []),
  ])];
  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => {
        if (!/^ggml-.*\.bin$/i.test(f)) return false;
        try { return fs.statSync(path.join(dir, f)).size > 10 * 1024 * 1024; } catch { return false; }
      });
    } catch {
      continue;
    }
    if (preferred) {
      if (files.includes(preferred)) return path.join(dir, preferred);
      // When a particular model was requested, continue to the next directory
      // instead of silently substituting another size.
      continue;
    }
    for (const name of MODEL_PREFERENCE) {
      if (files.includes(name)) return path.join(dir, name);
    }
    if (files.length) return path.join(dir, files[0]);
  }
  return null;
}

/**
 * ffmpeg args to decode any media to raw 16 kHz mono 32-bit float PCM on stdout.
 * Pure function — unit-tested.
 */
function buildPcmExtractArgs(inputPath, opts = {}) {
  const args = ['-v', 'error'];
  const start = Math.max(0, Number(opts.start) || 0);
  const end = Number(opts.end);
  // Input-side seek avoids decoding/buffering the skipped prefix of long media.
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', inputPath);
  if (Number.isFinite(end) && end > start) args.push('-t', String(end - start));
  args.push(
    '-ac', '1',
    '-ar', '16000',
    '-f', 'f32le',
    '-acodec', 'pcm_f32le',
    'pipe:1'
  );
  return args;
}

/** Interpret a raw f32le Buffer as a Float32Array (handles odd lengths). */
function decodePcm(buffer) {
  const usable = buffer.length - (buffer.length % 4);
  return new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + usable)
  );
}

/** Extract mono 16k PCM from a media file using the bundled ffmpeg. */
function extractPcm(inputPath, opts = {}) {
  const { ffmpeg } = resolveBinaries();
  const args = buildPcmExtractArgs(inputPath, opts);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
    child.on('error', (e) => reject(new Error(`ffmpeg 启动失败: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`音频抽取失败: ${err.trim()}`));
      resolve(decodePcm(Buffer.concat(chunks)));
    });
  });
}

/** Yield after CPU-heavy native work so queued IPC/UI messages can flush. */
function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

const MODEL_SOURCES = [
  'https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/',
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
];

function downloadFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('模型下载重定向过多'));
    const tmp = dest + '.part';
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const redirected = new URL(res.headers.location, url).toString();
        return downloadFile(redirected, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(tmp);
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total && typeof onProgress === 'function') onProgress(got / total);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        try {
          if (fs.statSync(tmp).size < 10 * 1024 * 1024) throw new Error('模型文件过小，可能下载不完整');
          fs.renameSync(tmp, dest);
          resolve(dest);
        } catch (e) {
          try { fs.rmSync(tmp, { force: true }); } catch {}
          reject(e);
        }
      }));
    });
    req.on('timeout', () => req.destroy(new Error('模型下载超时')));
    req.on('error', (e) => { try { fs.rmSync(tmp, { force: true }); } catch {}; reject(e); });
  });
}

/** Ensure a model exists, downloading tiny (~75MB) by default on first use. */
async function ensureModel(preferred, explicitDir, onProgress) {
  const local = findModel(preferred, explicitDir, false);
  if (local) return local;
  const modelName = preferred || 'ggml-tiny.bin';
  const fileName = modelName.startsWith('ggml-') ? modelName : `ggml-${modelName}.bin`;
  const dest = path.join(modelsDir(explicitDir), fileName);
  // If this checkout contains a validated development model, copy it into the
  // writable runtime directory before attempting the network. This also makes
  // local/dev installs deterministic.
  const bundled = findModel(fileName, bundledModelsDir(), false);
  // Only treat this as a bundled fallback when it is genuinely a different
  // directory. In source mode modelsDir() equals bundledModelsDir(); otherwise
  // we'd skip network download and attempt to copy a file onto itself.
  if (bundled && path.resolve(bundledModelsDir()) !== path.resolve(modelsDir(explicitDir))) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(bundled, dest);
    return dest;
  }
  let lastError = null;
  for (const base of MODEL_SOURCES) {
    try {
      return await downloadFile(base + fileName, dest, onProgress);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`语音模型下载失败：${lastError ? lastError.message : '未知错误'}。可运行 npm run fetch:whisper-model 或手动放入 ${modelsDir(explicitDir)}`);
}

/** Copy a development/bundled model into the writable runtime model dir. */
function copyBundledModelTo(preferred, explicitDir) {
  if (!explicitDir) return null;
  const source = findModel(preferred, bundledModelsDir());
  if (!source || path.dirname(source) === explicitDir) return source;
  fs.mkdirSync(explicitDir, { recursive: true });
  const dest = path.join(explicitDir, path.basename(source));
  if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(source).size) {
    fs.copyFileSync(source, dest);
  }
  return dest;
}

/**
 * Convert whisper result segments (ms timestamps) into MiniClip text-overlay
 * items on the EXPORT timeline. Pure — unit-tested.
 *
 * @param {Array} segments  [{ from, to, text }] with millisecond timestamps
 * @param {object} [opts]   { offset=0 seconds, position='bottom', minDur=0.4 }
 */
function segmentsToOverlays(segments, opts = {}) {
  const offset = Number(opts.offset) || 0;
  const position = opts.position || 'bottom';
  const minDur = opts.minDur == null ? 0.4 : opts.minDur;
  const out = [];
  for (const s of segments || []) {
    const text = String(s.text || '').trim();
    if (!text) continue;
    const start = Math.max(0, (Number(s.from) || 0) / 1000 + offset);
    let end = (Number(s.to) || 0) / 1000 + offset;
    if (!(end > start)) end = start + minDur;
    const words = tokenTimingsToWords(s.tokens, { offset });
    out.push({ text, start, end, position, words, hasWordTimings: words.length > 0 });
  }
  return out;
}

/**
 * Convert Whisper token timestamps (ms) into displayable word/character cues.
 * Tokens without real t0/t1 are discarded instead of inventing timings. For
 * whitespace-delimited languages adjacent non-space BPE pieces are grouped;
 * CJK token pieces remain individually addressable.
 */
function tokenTimingsToWords(tokens, opts = {}) {
  const offset = Number(opts.offset) || 0;
  const raw = (Array.isArray(tokens) ? tokens : []).map((token) => ({
    text: String(token && token.text || ''),
    start: (Number(token && token.from) || 0) / 1000 + offset,
    end: (Number(token && token.to) || 0) / 1000 + offset,
  })).filter((token) => token.text && token.end > token.start && token.start >= offset);
  const out = [];
  let current = null;
  for (const token of raw) {
    const beginsWord = /^\s/.test(token.text);
    const hasCjk = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(token.text);
    if (hasCjk) {
      if (current) { out.push(current); current = null; }
      for (const char of Array.from(token.text.trim())) out.push({ text: char, start: token.start, end: token.end });
      continue;
    }
    if (beginsWord || !current) {
      if (current) out.push(current);
      current = { text: token.text, start: token.start, end: token.end };
    } else {
      current.text += token.text;
      current.end = token.end;
    }
  }
  if (current && current.text) out.push(current);
  return out.filter((word) => word.text && word.end > word.start);
}

/**
 * Map segments produced from a chunk back to the full trimmed-source clock.
 * Kept pure so long-media chunk stitching is unit-testable.
 */
function offsetSegments(segments, offsetSeconds) {
  const offsetMs = (Number(offsetSeconds) || 0) * 1000;
  return (segments || []).map((result) => {
    const out = Object.assign({}, result, {
      from: Number(result.from) + offsetMs,
      to: Number(result.to) + offsetMs,
    });
    if (Array.isArray(result.tokens)) {
      out.tokens = result.tokens.map((token) => Object.assign({}, token, {
        from: Number(token.from) + offsetMs,
        to: Number(token.to) + offsetMs,
      }));
    }
    return out;
  });
}

let whisperLoadError = null;

/** Lazy load of the optional native addon while preserving ABI/load errors. */
function loadWhisper() {
  try {
    const mod = require('smart-whisper');
    whisperLoadError = null;
    return mod;
  } catch (e) {
    whisperLoadError = e;
    return null;
  }
}

/**
 * Transcribe a media file to subtitle segments.
 *
 * @param {object} opts
 * @param {string} opts.input     media path to transcribe
 * @param {string} [opts.language] e.g. 'zh','en','auto' (default 'auto')
 * @param {string} [opts.model]   specific ggml-*.bin filename to use
 * @param {number} [opts.offset]  seconds to shift results by (timeline offset)
 * @param {function} [onProgress] 0..1
 * @returns {Promise<{overlays, segments, model}>}
 */
async function transcribe(opts, onProgress) {
  const mod = loadWhisper();
  if (!mod || !mod.Whisper) {
    const detail = whisperLoadError && whisperLoadError.code !== 'MODULE_NOT_FOUND'
      ? ` 原生模块加载错误：${whisperLoadError.message}`
      : '';
    throw new Error(
      '本地语音识别引擎（smart-whisper）不可用。请在 desktop/ 下重新运行 `npm install` 后重试。' + detail
    );
  }
  const requestedModel = opts && opts.model;
  let modelPath = findModel(requestedModel, opts && opts.modelsDir);
  // Native whisper.cpp expects a real filesystem path. In packaged builds a
  // development fallback may be under app.asar.unpacked; copy it to userData.
  if (modelPath && opts && opts.modelsDir && path.dirname(modelPath) !== opts.modelsDir) {
    modelPath = copyBundledModelTo(requestedModel, opts.modelsDir) || modelPath;
  }
  if (!modelPath && (!opts || opts.autoDownload !== false)) {
    modelPath = await ensureModel(requestedModel || 'ggml-tiny.bin', opts && opts.modelsDir, (p) => {
      if (typeof onProgress === 'function') onProgress(Math.min(0.2, p * 0.2));
    });
  }
  if (!modelPath) throw new Error(`未找到语音模型，请运行 npm run fetch:whisper-model 或放入 ${modelsDir(opts && opts.modelsDir)}`);

  const whisper = new mod.Whisper(modelPath, { gpu: false });
  try {
    // Process long media in bounded chunks so we never keep an hour-long PCM
    // buffer (about 230 MB) plus a native copy in memory at once. Exact chunk
    // boundaries can split a word; 60 seconds is a practical memory/accuracy
    // compromise for this lightweight editor.
    const sourceStart = Math.max(0, Number(opts.start) || 0);
    const sourceEnd = Number(opts.end);
    const requestedDuration = Number.isFinite(sourceEnd) && sourceEnd > sourceStart
      ? sourceEnd - sourceStart
      : null;
    const chunkSeconds = Math.max(10, Number(opts.chunkSeconds) || 60);
    const chunkCount = requestedDuration ? Math.ceil(requestedDuration / chunkSeconds) : 1;
    const segments = [];

    for (let index = 0; index < chunkCount; index++) {
      const chunkStart = sourceStart + index * chunkSeconds;
      const chunkEnd = requestedDuration
        ? Math.min(sourceEnd, chunkStart + chunkSeconds)
        : undefined;
      if (typeof onProgress === 'function') {
        onProgress(0.2 + (index / chunkCount) * 0.7);
      }
      const pcm = await extractPcm(opts.input, { start: chunkStart, end: chunkEnd });
      const task = await whisper.transcribe(pcm, {
        language: (opts && opts.language) || 'auto',
        format: 'detail',
        token_timestamps: true,
      });
      const chunkResults = await task.result;
      segments.push(...offsetSegments(chunkResults, index * chunkSeconds));
      await yieldEventLoop();
    }
    if (typeof onProgress === 'function') onProgress(1);
    return {
      model: path.basename(modelPath),
      segments,
      overlays: segmentsToOverlays(segments, { offset: (opts && opts.offset) || 0 }),
    };
  } finally {
    try { await whisper.free(); } catch {}
  }
}

/** Availability report for the UI. */
function status(explicitDir) {
  const engine = !!loadWhisper();
  const model = findModel(null, explicitDir);
  return {
    engineInstalled: engine,
    engineError: engine ? null : whisperLoadError && whisperLoadError.message,
    modelPath: model,
    modelsDir: modelsDir(explicitDir),
  };
}

module.exports = {
  modelsDir,
  bundledModelsDir,
  findModel,
  ensureModel,
  copyBundledModelTo,
  downloadFile,
  buildPcmExtractArgs,
  decodePcm,
  segmentsToOverlays,
  tokenTimingsToWords,
  offsetSegments,
  transcribe,
  status,
  MODEL_PREFERENCE,
};
