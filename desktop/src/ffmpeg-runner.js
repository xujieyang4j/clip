'use strict';

/**
 * FFmpeg/ffprobe integration for the Electron main process.
 *
 * Responsibilities:
 *   - locate the ffmpeg & ffprobe binaries that ship with the app
 *     (ffmpeg-static / ffprobe-static), with an asar.unpacked fixup and a
 *     PATH fallback for dev machines;
 *   - verify the binary is modern enough (has the xfade filter);
 *   - probe a media file for duration / audio presence;
 *   - run an export, streaming progress back via a callback.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFFmpegArgs } = require('./ffmpeg-graph');
const { buildAss } = require('./ass-builder');

/** Directory that ships bundled fonts (e.g. a CJK font for subtitles). */
function fontsDir() {
  // src/ -> ../assets/fonts, also survives asar.unpacked via unpacked().
  const dirs = [
    // Because assets are explicitly asarUnpacked.
    unpacked(path.join(__dirname, '..', 'assets', 'fonts')),
    // Robust fallback if packaging layout changes to extraResources.
    process.resourcesPath && path.join(process.resourcesPath, 'fonts'),
  ].filter(Boolean);
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(ttf|ttc|otf)$/i.test(f))) {
        return dir;
      }
    } catch {}
  }
  return null;
}

/**
 * When packaged, node_modules lives inside app.asar (a read-only archive) and
 * native binaries can't be executed from there. electron-builder is configured
 * to unpack them to app.asar.unpacked; this rewrites the path accordingly.
 */
function unpacked(p) {
  if (p && p.includes(`app.asar${path.sep}`)) {
    return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  }
  return p;
}

/** Try to require an optional dependency without throwing. */
function tryRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

let _cache = null;

/**
 * Resolve { ffmpeg, ffprobe } absolute paths.
 * Order: bundled static binaries -> system PATH (dev fallback).
 */
function resolveBinaries() {
  if (_cache) return _cache;

  let ffmpeg = null;
  let ffprobe = null;

  const ffmpegStatic = tryRequire('ffmpeg-static');
  if (typeof ffmpegStatic === 'string') ffmpeg = unpacked(ffmpegStatic);

  const ffprobeStatic = tryRequire('ffprobe-static');
  if (ffprobeStatic && ffprobeStatic.path) ffprobe = unpacked(ffprobeStatic.path);

  // Dev fallback: assume they're on PATH.
  if (!ffmpeg || !fs.existsSync(ffmpeg)) ffmpeg = 'ffmpeg';
  if (!ffprobe || !fs.existsSync(ffprobe)) ffprobe = 'ffprobe';

  _cache = { ffmpeg, ffprobe };
  return _cache;
}

/** Validate a path received over IPC is a usable local file. */
function assertLocalFile(filePath, label = '文件') {
  if (typeof filePath !== 'string' || filePath.includes('\0')) {
    throw new Error(`${label}路径无效`);
  }
  const resolved = path.resolve(filePath);
  let st;
  try { st = fs.statSync(resolved); } catch { throw new Error(`${label}不存在: ${resolved}`); }
  if (!st.isFile()) throw new Error(`${label}不是普通文件: ${resolved}`);
  return resolved;
}

/** Promisified execFile that never rejects; returns { stdout, stderr, error }. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 1 << 24, ...opts }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Like run(), but keeps stdout as binary data for compact media analysis. */
function runBuffer(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 1 << 24, encoding: 'buffer', ...opts }, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''),
        stderr: Buffer.isBuffer(stderr) ? stderr.toString() : (stderr || ''),
      });
    });
  });
}

/** Reduce PCM samples to UI-friendly 0..1 peak values. Pure and unit-tested. */
function buildWaveform(samples, requestedBars = 160) {
  const bars = Math.max(16, Math.min(512, Math.round(Number(requestedBars) || 160)));
  const source = samples instanceof Float32Array ? samples : new Float32Array(0);
  if (!source.length) return Array(bars).fill(0);
  const out = [];
  for (let bar = 0; bar < bars; bar++) {
    const start = Math.floor(bar * source.length / bars);
    const end = Math.max(start + 1, Math.floor((bar + 1) * source.length / bars));
    let peak = 0;
    for (let i = start; i < end && i < source.length; i++) {
      const value = Math.abs(Number(source[i]) || 0);
      if (value > peak) peak = value;
    }
    // A gentle root curve keeps quiet speech visible without clipping loud music.
    out.push(Math.round(Math.min(1, Math.sqrt(peak)) * 1000) / 1000);
  }
  return out;
}

/** Parse FFmpeg silencedetect stderr into source-file time intervals. */
function parseSilenceIntervals(stderr) {
  const starts = [];
  const out = [];
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([-\d.]+)/);
    if (start) starts.push(Math.max(0, Number(start[1]) || 0));
    const end = line.match(/silence_end:\s*([-\d.]+)/);
    if (end && starts.length) {
      const from = starts.shift();
      const to = Math.max(from, Number(end[1]) || from);
      if (to > from) out.push({ start: from, end: to });
    }
  }
  return out;
}

/** Lightweight onset markers from a 100 Hz peak signal; suitable for snapping. */
function findBeatMarkers(samples, sampleRate = 100, opts = {}) {
  const source = samples instanceof Float32Array ? samples : new Float32Array(0);
  const rate = Math.max(1, Number(sampleRate) || 100);
  const minGap = Math.max(0.15, Number(opts.minGap) || 0.32);
  const threshold = Math.max(0.01, Number(opts.threshold) || 0.06);
  const out = [];
  let last = -Infinity;
  for (let i = 2; i < source.length - 2; i++) {
    const value = Math.abs(source[i]);
    if (value < threshold || value < Math.abs(source[i - 1]) || value < Math.abs(source[i + 1])) continue;
    const localMean = (Math.abs(source[i - 2]) + Math.abs(source[i - 1]) + Math.abs(source[i + 1]) + Math.abs(source[i + 2])) / 4;
    const time = i / rate;
    if (value > localMean * 1.35 && time - last >= minGap) { out.push(Math.round(time * 1000) / 1000); last = time; }
  }
  return out;
}

/** Parse showinfo frame timestamps emitted after FFmpeg's scene selector. */
function parseSceneCutTimes(stderr, start = 0, end = Infinity) {
  const min = Math.max(0, Number(start) || 0);
  const max = Number.isFinite(Number(end)) ? Math.max(min, Number(end)) : Infinity;
  const out = [];
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const match = line.match(/pts_time:\s*([-\d.]+)/);
    if (!match) continue;
    const time = Number(match[1]);
    if (!Number.isFinite(time) || time <= min + 0.05 || time >= max - 0.05) continue;
    const rounded = Math.round(time * 1000) / 1000;
    if (!out.length || Math.abs(out[out.length - 1] - rounded) > 0.04) out.push(rounded);
  }
  return out;
}

/** Detect visible scene changes in a bounded source interval. */
async function sceneDetect(filePath, opts = {}) {
  const { ffmpeg } = resolveBinaries();
  filePath = assertLocalFile(filePath, '待检测视频');
  const start = Math.max(0, Number(opts.start) || 0);
  const end = Number(opts.end);
  const threshold = Math.max(0.05, Math.min(0.95, Number(opts.threshold) || 0.3));
  const trim = Number.isFinite(end) && end > start
    ? 'trim=start=' + start + ':end=' + end + ','
    : 'trim=start=' + start + ',';
  const filter = trim + "select='gt(scene," + threshold + ")',showinfo";
  const result = await run(ffmpeg, [
    '-v', 'info', '-nostdin', '-i', filePath,
    '-map', '0:v:0', '-vf', filter, '-an', '-f', 'null', '-',
  ], { maxBuffer: 1 << 24 });
  if (result.error) throw new Error('场景检测失败: ' + (result.stderr || result.error.message));
  return parseSceneCutTimes(result.stderr, start, end);
}

/**
 * Extract a low-resolution waveform for timeline display. Audio is decoded to
 * 100 Hz mono f32le, so even long recordings stay within a modest IPC payload.
 */
async function waveform(filePath, bars = 160) {
  const { ffmpeg } = resolveBinaries();
  filePath = assertLocalFile(filePath, '音频素材');
  const { error, stdout, stderr } = await runBuffer(ffmpeg, [
    '-v', 'error', '-nostdin', '-i', filePath,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '100', '-f', 'f32le', 'pipe:1',
  ]);
  if (error) throw new Error('音频波形提取失败: ' + (stderr || error.message));
  const length = Math.floor(stdout.length / 4);
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, length);
  return buildWaveform(samples, bars);
}

async function audioAnalysis(filePath, opts = {}) {
  const { ffmpeg } = resolveBinaries();
  filePath = assertLocalFile(filePath, '音频素材');
  const noise = String(opts.noise || '-35dB');
  const duration = Math.max(0.1, Number(opts.silenceDuration) || 0.5);
  const detect = await run(ffmpeg, ['-v', 'info', '-nostdin', '-i', filePath, '-af', `silencedetect=noise=${noise}:d=${duration}`, '-f', 'null', '-']);
  if (detect.error && !detect.stderr) throw new Error('静音检测失败: ' + detect.error.message);
  const pcm = await runBuffer(ffmpeg, ['-v', 'error', '-nostdin', '-i', filePath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '100', '-f', 'f32le', 'pipe:1']);
  if (pcm.error) throw new Error('节拍分析失败: ' + (pcm.stderr || pcm.error.message));
  const length = Math.floor(pcm.stdout.length / 4);
  const samples = new Float32Array(pcm.stdout.buffer, pcm.stdout.byteOffset, length);
  return { silences: parseSilenceIntervals(detect.stderr), beats: findBeatMarkers(samples, 100, opts) };
}

/**
 * Check ffmpeg exists and supports the xfade filter (proxy for "modern enough").
 * Returns { ok, version, hasXfade, ffmpeg, ffprobe, error }.
 */
async function checkCapabilities() {
  const bins = resolveBinaries();
  const ver = await run(bins.ffmpeg, ['-hide_banner', '-version']);
  if (ver.error) {
    return {
      ok: false,
      error: `找不到可用的 ffmpeg（${bins.ffmpeg}）。开发模式下请先安装依赖或把 ffmpeg 放进 PATH。`,
      ffmpeg: bins.ffmpeg,
      ffprobe: bins.ffprobe,
    };
  }
  const version = (ver.stdout.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown';
  const filters = await run(bins.ffmpeg, ['-hide_banner', '-filters']);
  const hasXfade = /(^|\s)xfade(\s|$)/m.test(filters.stdout);
  const hasSubtitles = /(^|\s)subtitles(\s|$)/m.test(filters.stdout);
  const hasZoompan = /(^|\s)zoompan(\s|$)/m.test(filters.stdout);
  const hasOverlay = /(^|\s)overlay(\s|$)/m.test(filters.stdout);
  const hasDeshake = /(^|\s)deshake(\s|$)/m.test(filters.stdout);
  return {
    ok: true,
    version,
    hasXfade,
    hasSubtitles,
    hasZoompan,
    hasOverlay,
    hasDeshake,
    ffmpeg: bins.ffmpeg,
    ffprobe: bins.ffprobe,
  };
}

/**
 * Probe a media file. Returns { duration, hasAudio, hasVideo, width, height }.
 * Throws on failure so callers can surface a clear message.
 */
async function probe(filePath) {
  const { ffprobe } = resolveBinaries();
  filePath = assertLocalFile(filePath);
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];
  const { error, stdout, stderr } = await run(ffprobe, args);
  if (error) throw new Error(`ffprobe 失败: ${stderr || error.message}`);

  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error('无法解析 ffprobe 输出');
  }
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmtDur = parseFloat(json.format && json.format.duration);
  const vDur = v && parseFloat(v.duration);
  const duration = [fmtDur, vDur].find((x) => Number.isFinite(x) && x > 0) || 0;

  return {
    duration,
    hasAudio: !!a,
    hasVideo: !!v,
    width: v ? Number(v.width) || 0 : 0,
    height: v ? Number(v.height) || 0 : 0,
  };
}

/** Parse the microsecond `out_time_us`/`out_time_ms` field ffmpeg -progress emits. */
function parseProgressTimeSeconds(chunk) {
  // ffmpeg writes key=value lines; out_time_us is microseconds (newer),
  // out_time_ms is *also* microseconds despite the name on many builds.
  const us = chunk.match(/out_time_us=(\d+)/);
  if (us) return Number(us[1]) / 1e6;
  const ms = chunk.match(/out_time_ms=(\d+)/);
  if (ms) return Number(ms[1]) / 1e6;
  const t = chunk.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (t) return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
  return null;
}

/** Build a lightweight editing proxy; output is never used for final export. */
function buildProxyArgs(input, output) {
  return [
    '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease,fps=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output,
  ];
}

function buildImageProxyArgs(input, output, duration = 3) {
  const seconds = Math.max(0.1, Math.min(60 * 60, Number(duration) || 3));
  return [
    '-y', '-loop', '1', '-framerate', '30', '-i', input, '-t', String(seconds),
    '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,fps=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', output,
  ];
}

async function createProxy(input, output) {
  const { ffmpeg } = resolveBinaries();
  input = assertLocalFile(input, '代理源视频');
  const args = buildProxyArgs(input, output);
  const { error, stderr } = await run(ffmpeg, args, { maxBuffer: 1 << 22 });
  if (error) throw new Error('代理生成失败: ' + (stderr || error.message));
  return output;
}

async function createImageProxy(input, output, duration) {
  const { ffmpeg } = resolveBinaries();
  input = assertLocalFile(input, '图片代理源');
  const args = buildImageProxyArgs(input, output, duration);
  const { error, stderr } = await run(ffmpeg, args, { maxBuffer: 1 << 22 });
  if (error) throw new Error('图片代理生成失败: ' + (stderr || error.message));
  return output;
}

/**
 * Extract one exact source frame and turn it into a short, silent MP4.
 * Keeping the result as MP4 (rather than an ephemeral browser canvas/blob)
 * means it previews, exports and travels inside a packaged project normally.
 */
async function createFreezeFrame(input, seconds, output, duration = 2) {
  const { ffmpeg } = resolveBinaries();
  input = assertLocalFile(input, '定格帧源视频');
  const time = Math.max(0, Number(seconds) || 0);
  const clipDuration = Math.max(0.1, Math.min(30, Number(duration) || 2));
  const resolvedOutput = path.resolve(output);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const stillPath = resolvedOutput + '.png';
  try {
    const extracted = await run(ffmpeg, [
      '-y', '-nostdin', '-i', input, '-ss', String(time),
      '-frames:v', '1', stillPath,
    ], { maxBuffer: 1 << 22 });
    if (extracted.error) throw new Error('提取定格帧失败: ' + (extracted.stderr || extracted.error.message));
    const rendered = await run(ffmpeg, [
      '-y', '-nostdin', '-loop', '1', '-i', stillPath,
      '-t', String(clipDuration), '-r', '30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolvedOutput,
    ], { maxBuffer: 1 << 22 });
    if (rendered.error) throw new Error('生成定格帧片段失败: ' + (rendered.stderr || rendered.error.message));
    return resolvedOutput;
  } finally {
    try { fs.rmSync(stillPath, { force: true }); } catch {}
  }
}

/**
 * Export the timeline to `output`.
 *
 * If `spec.texts` (array of subtitle/title items) is present, an .ass file is
 * rendered to a temp path and wired into `spec.settings.assPath` so the graph's
 * subtitles filter burns it in. Bundled fonts (assets/fonts) are used if found.
 *
 * @param {object}   spec        shape buildFFmpegArgs expects, plus optional
 *                               `texts: [{text,start,end,position,...}]`
 * @param {function} onProgress  called with 0..1
 * @returns {{ promise, cancel }} promise resolves { output } / rejects Error
 */
function exportTimeline(spec, onProgress) {
  const { ffmpeg } = resolveBinaries();
  // IPC input is untrusted: validate every path before giving it to ffmpeg.
  for (const clip of spec.clips || []) clip.path = assertLocalFile(clip.path, '视频');
  for (const clip of spec.clips || []) {
    if (clip.color && clip.color.lutPath) clip.color.lutPath = assertLocalFile(clip.color.lutPath, 'LUT 调色文件');
  }
  if (spec.bgm && spec.bgm.path) spec.bgm.path = assertLocalFile(spec.bgm.path, '背景音乐');
  for (const track of spec.audioTracks || []) track.path = assertLocalFile(track.path, '独立音频');
  for (const broll of spec.brolls || []) broll.path = assertLocalFile(broll.path, 'B-roll 视频');
  for (const overlay of spec.overlays || []) overlay.path = assertLocalFile(overlay.path, '叠加素材');

  // Render subtitles/titles to a temp .ass and point the graph at it.
  let assTempPath = null;
  const settings = Object.assign({}, spec.settings || {});
  const texts = Array.isArray(spec.texts) ? spec.texts.filter((t) => t && t.text) : [];
  if (texts.length > 0) {
    const ass = buildAss({
      width: settings.width || 1280,
      height: settings.height || 720,
      fontName: settings.fontName || 'sans-serif',
      items: texts,
    });
    assTempPath = path.join(
      os.tmpdir(),
      `miniclip-${Date.now()}-${Math.random().toString(36).slice(2)}.ass`
    );
    fs.writeFileSync(assTempPath, ass, 'utf8');
    settings.assPath = assTempPath;
    const fd = fontsDir();
    if (fd) settings.fontsDir = fd;
  }

  const built = buildFFmpegArgs(Object.assign({}, spec, { settings }));
  const total = built.total || 0;

  // Insert `-progress pipe:1 -nostats` right after -y so we get machine-readable
  // progress on stdout while human logs stay on stderr.
  const args = built.args.slice();
  args.splice(1, 0, '-progress', 'pipe:1', '-nostats');

  let child = null;
  let stderrTail = '';
  const cleanup = () => {
    if (assTempPath) {
      try { fs.rmSync(assTempPath, { force: true }); } catch {}
      assTempPath = null;
    }
  };

  const promise = new Promise((resolve, reject) => {
    child = spawn(ffmpeg, args, { windowsHide: true });

    child.stdout.on('data', (buf) => {
      const secs = parseProgressTimeSeconds(buf.toString());
      if (secs != null && total > 0 && typeof onProgress === 'function') {
        onProgress(Math.max(0, Math.min(1, secs / total)));
      }
    });

    child.stderr.on('data', (buf) => {
      stderrTail = (stderrTail + buf.toString()).slice(-4000);
    });

    child.on('error', (err) => {
      cleanup();
      reject(new Error(`无法启动 ffmpeg: ${err.message}`));
    });

    child.on('close', (code) => {
      cleanup();
      if (code === 0) {
        if (typeof onProgress === 'function') onProgress(1);
        resolve({ output: spec.output });
      } else {
        reject(new Error(`导出失败（ffmpeg 退出码 ${code}）:\n${stderrTail.trim()}`));
      }
    });
  });

  const cancel = () => {
    if (child && !child.killed) {
      child.kill('SIGKILL');
    }
  };

  return { promise, cancel };
}

module.exports = {
  resolveBinaries,
  checkCapabilities,
  probe,
  exportTimeline,
  parseProgressTimeSeconds,
  buildProxyArgs,
  createProxy,
  buildImageProxyArgs,
  createImageProxy,
  createFreezeFrame,
  unpacked,
  fontsDir,
  assertLocalFile,
  buildWaveform,
  parseSilenceIntervals,
  findBeatMarkers,
  parseSceneCutTimes,
  waveform,
  audioAnalysis,
  sceneDetect,
};
