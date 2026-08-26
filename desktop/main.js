'use strict';

/**
 * Electron main process: window lifecycle + IPC bridge to ffmpeg.
 *
 * The renderer never touches the filesystem or spawns processes directly.
 * Everything goes through the `miniclip` IPC channels exposed in preload.js.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const runner = require('./src/ffmpeg-runner');
const whisper = require('./src/whisper-runner');
const projects = require('./src/project-store');
const srt = require('./src/srt-utils');
const recordings = require('./src/recording-store');

let mainWindow = null;

/** Track the in-flight export so we can cancel it if asked. */
let currentExport = null;
const waveformCache = new Map();
const analysisCache = new Map();
const proxyJobs = new Map();

const UI_LANGUAGES = new Set(['zh-CN', 'en']);

function preferencesPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function getUiLanguage() {
  try {
    const preferences = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
    return UI_LANGUAGES.has(preferences.language) ? preferences.language : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

function setUiLanguage(language) {
  const value = UI_LANGUAGES.has(language) ? language : 'zh-CN';
  fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
  fs.writeFileSync(preferencesPath(), JSON.stringify({ language: value }, null, 2), 'utf8');
  return value;
}

function dialogText(zh, en) {
  return getUiLanguage() === 'en' ? en : zh;
}

function recoveryPath() {
  return path.join(app.getPath('userData'), 'recovery.miniclip');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 860,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'MiniClip',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for the ffmpeg modules
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // Microphone capture only starts from the explicit recording action in the
  // renderer. OS-level prompts (notably on macOS) remain in effect.
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.includes('audio'));
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('miniclip:getLanguage', async () => ({ language: getUiLanguage() }));
ipcMain.handle('miniclip:setLanguage', async (_evt, language) => ({ language: setUiLanguage(language) }));

/** One-time capability probe so the UI can warn early if ffmpeg is unusable. */
ipcMain.handle('miniclip:capabilities', async () => {
  return runner.checkCapabilities();
});

/** Open a file picker for main-timeline videos or still images. */
ipcMain.handle('miniclip:pickVideos', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: dialogText('导入视频或图片', 'Import video or image'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: dialogText('视频', 'Video'), extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm'] },
      { name: dialogText('图片', 'Image'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
      { name: dialogText('所有文件', 'All files'), extensions: ['*'] },
    ],
  });
  if (res.canceled) return { canceled: true, items: [] };
  return { canceled: false, items: await probeAll(res.filePaths) };
});

ipcMain.handle('miniclip:pickAudio', async (_evt, opts) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: opts && opts.title ? opts.title : dialogText('选择背景音乐', 'Choose background music'),
    properties: ['openFile'],
    filters: [
      { name: dialogText('音频', 'Audio'), extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'] },
      { name: dialogText('所有文件', 'All files'), extensions: ['*'] },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) return { canceled: true };
  const p = res.filePaths[0];
  try {
    const meta = await runner.probe(p);
    return {
      canceled: false,
      path: p,
      url: pathToFileURL(p).href,
      name: path.basename(p),
      duration: meta.duration,
    };
  } catch (e) {
    return { canceled: false, path: p, name: path.basename(p), duration: 0, error: e.message };
  }
});

/** Store microphone audio from the sandboxed renderer and return its metadata. */
ipcMain.handle('miniclip:saveRecording', async (_evt, payload) => {
  try {
    if (!payload || typeof payload !== 'object') throw new Error('缺少录音数据');
    const savedPath = recordings.saveRecording(path.join(app.getPath('userData'), 'recordings'), payload.data, payload.mimeType);
    const meta = await runner.probe(savedPath);
    if (!meta.duration || meta.duration <= 0) {
      try { fs.rmSync(savedPath, { force: true }); } catch {}
      throw new Error('录音没有有效音频');
    }
    return {
      ok: true, path: savedPath, url: pathToFileURL(savedPath).href,
      name: path.basename(savedPath), duration: meta.duration,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** Probe an arbitrary path on demand (used if the renderer needs a refresh). */
ipcMain.handle('miniclip:probe', async (_evt, filePath) => {
  return runner.probe(filePath);
});

/** Extract and cache a compact waveform for a timeline audio clip. */
ipcMain.handle('miniclip:waveform', async (_evt, filePath, bars) => {
  try {
    const resolved = runner.assertLocalFile(filePath, '音频素材');
    const count = Math.max(16, Math.min(512, Math.round(Number(bars) || 160)));
    const key = resolved + ':' + count;
    if (!waveformCache.has(key)) waveformCache.set(key, runner.waveform(resolved, count));
    return { ok: true, peaks: await waveformCache.get(key) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('miniclip:audioAnalysis', async (_evt, filePath, opts) => {
  try {
    const resolved = runner.assertLocalFile(filePath, '音频素材');
    const key = resolved + ':' + JSON.stringify(opts || {});
    if (!analysisCache.has(key)) analysisCache.set(key, runner.audioAnalysis(resolved, opts || {}));
    return { ok: true, ...(await analysisCache.get(key)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('miniclip:sceneDetect', async (_evt, filePath, opts) => {
  try {
    const resolved = runner.assertLocalFile(filePath, '待检测视频');
    return { ok: true, cuts: await runner.sceneDetect(resolved, opts || {}) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('miniclip:createProxy', async (_evt, filePath) => {
  try {
    const resolved = runner.assertLocalFile(filePath, '代理源视频');
    const stat = fs.statSync(resolved);
    const key = resolved + ':' + stat.mtimeMs + ':' + stat.size;
    if (!proxyJobs.has(key)) {
      const dir = path.join(app.getPath('userData'), 'proxies');
      fs.mkdirSync(dir, { recursive: true });
      const safe = Buffer.from(key).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 32);
      const output = path.join(dir, safe + '.mp4');
      const job = fs.existsSync(output) ? Promise.resolve(output) : runner.createProxy(resolved, output);
      proxyJobs.set(key, job);
    }
    const proxyPath = await proxyJobs.get(key);
    return { ok: true, path: proxyPath, url: pathToFileURL(proxyPath).href };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('miniclip:createImageProxy', async (_evt, payload) => {
  try {
    if (!payload || typeof payload.path !== 'string') throw new Error('缺少图片路径');
    const resolved = runner.assertLocalFile(payload.path, '图片代理源');
    const duration = Math.max(0.1, Math.min(60 * 60, Number(payload.duration) || 3));
    const stat = fs.statSync(resolved);
    const key = 'image:' + resolved + ':' + stat.mtimeMs + ':' + stat.size + ':' + duration;
    if (!proxyJobs.has(key)) {
      const dir = path.join(app.getPath('userData'), 'proxies');
      fs.mkdirSync(dir, { recursive: true });
      const safe = Buffer.from(key).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 32);
      const output = path.join(dir, safe + '.mp4');
      const job = fs.existsSync(output) ? Promise.resolve(output) : runner.createImageProxy(resolved, output, duration);
      proxyJobs.set(key, job);
    }
    const proxyPath = await proxyJobs.get(key);
    return { ok: true, path: proxyPath, url: pathToFileURL(proxyPath).href };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** Render a frozen source frame into a portable silent MP4 timeline clip. */
ipcMain.handle('miniclip:createFreezeFrame', async (_evt, payload) => {
  try {
    if (!payload || typeof payload.input !== 'string') throw new Error('缺少定格帧源视频');
    const input = runner.assertLocalFile(payload.input, '定格帧源视频');
    const sourceTime = Math.max(0, Number(payload.sourceTime) || 0);
    const duration = Math.max(0.1, Math.min(30, Number(payload.duration) || 2));
    const dir = path.join(app.getPath('userData'), 'freeze-frames');
    fs.mkdirSync(dir, { recursive: true });
    const output = path.join(dir, 'freeze-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mp4');
    await runner.createFreezeFrame(input, sourceTime, output, duration);
    const meta = await runner.probe(output);
    return {
      ok: true, path: output, url: pathToFileURL(output).href, name: '定格帧',
      duration: meta.duration, hasAudio: false, width: meta.width, height: meta.height,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** Pick an image/video to use as an overlay (picture-in-picture / sticker). */
ipcMain.handle('miniclip:pickOverlayMedia', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: dialogText('选择叠加素材（图片 / 视频）', 'Choose overlay media (image / video)'),
    properties: ['openFile'],
    filters: [
      { name: dialogText('图片', 'Image'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
      { name: dialogText('视频', 'Video'), extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm'] },
      { name: dialogText('所有文件', 'All files'), extensions: ['*'] },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) return { canceled: true };
  const p = res.filePaths[0];
  const imageExt = /\.(png|jpe?g|gif|webp|bmp)$/i.test(p);
  try {
    const meta = await runner.probe(p);
    return {
      canceled: false,
      path: p,
      url: pathToFileURL(p).href,
      name: path.basename(p),
      kind: imageExt || !meta.hasVideo ? 'image' : 'video',
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
    };
  } catch (e) {
    // ffprobe may not read some images; still allow it as an image overlay.
    return {
      canceled: false,
      path: p,
      url: pathToFileURL(p).href,
      name: path.basename(p),
      kind: 'image',
      duration: 0,
      error: e.message,
    };
  }
});

ipcMain.handle('miniclip:pickLut', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: dialogText('选择 LUT 调色文件', 'Choose LUT color file'), properties: ['openFile'],
    filters: [{ name: '3D LUT', extensions: ['cube', '3dl'] }],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const filePath = res.filePaths[0];
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('LUT 文件无效或超过 10 MB 限制');
    return { canceled: false, path: filePath, name: path.basename(filePath) };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

ipcMain.handle('miniclip:relinkMedia', async (_evt, opts) => {
  const kind = opts && opts.kind;
  const filters = kind === 'audio'
    ? [{ name: dialogText('音频', 'Audio'), extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'] }]
    : kind === 'lut'
      ? [{ name: '3D LUT', extensions: ['cube', '3dl'] }]
      : [{ name: dialogText('视频', 'Video'), extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm'] }, { name: dialogText('图片', 'Image'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }];
  const res = await dialog.showOpenDialog(mainWindow, { title: dialogText('重新链接素材', 'Relink media'), properties: ['openFile'], filters });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const filePath = res.filePaths[0];
  try {
    const meta = await runner.probe(filePath);
    return { canceled: false, path: filePath, url: pathToFileURL(filePath).href, name: path.basename(filePath), duration: meta.duration, hasAudio: meta.hasAudio, hasVideo: meta.hasVideo, width: meta.width, height: meta.height };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

/** Ask where to save, then run the export with progress events. */
ipcMain.handle('miniclip:export', async (_evt, spec) => {
  const save = await dialog.showSaveDialog(mainWindow, {
    title: dialogText('导出成片', 'Export video'),
    defaultPath: path.join(
      app.getPath('videos') || os.homedir(),
      `MiniClip-${Date.now()}.mp4`
    ),
    filters: [{ name: dialogText('MP4 视频', 'MP4 video'), extensions: ['mp4'] }],
  });
  if (save.canceled || !save.filePath) return { canceled: true };

  const fullSpec = Object.assign({}, spec, { output: save.filePath });

  const { promise, cancel } = runner.exportTimeline(fullSpec, (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('miniclip:exportProgress', p);
    }
  });
  currentExport = { cancel };

  try {
    const out = await promise;
    return { canceled: false, output: out.output };
  } catch (e) {
    return { canceled: false, error: e.message };
  } finally {
    currentExport = null;
  }
});

/** Render a low-bitrate temporary MP4 so preview can match final FFmpeg effects. */
ipcMain.handle('miniclip:renderPreview', async (_evt, spec) => {
  const previewDir = path.join(app.getPath('temp'), 'miniclip-preview');
  try { fs.mkdirSync(previewDir, { recursive: true }); } catch {}
  const output = path.join(previewDir, `preview-${Date.now()}.mp4`);
  const settings = Object.assign({}, spec && spec.settings, { crf: 28, preset: 'veryfast', audioBitrate: '128k' });
  try {
    const { promise } = runner.exportTimeline(Object.assign({}, spec, { output, settings }), (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('miniclip:previewProgress', p);
    });
    const out = await promise;
    return { ok: true, output: out.output, url: pathToFileURL(out.output).href };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('miniclip:cancelExport', async () => {
  if (currentExport) currentExport.cancel();
  return { ok: true };
});

ipcMain.handle('miniclip:importSrt', async () => {
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: dialogText('导入 SRT 字幕', 'Import SRT captions'), properties: ['openFile'],
    filters: [{ name: dialogText('SRT 字幕', 'SRT captions'), extensions: ['srt'] }],
  });
  if (selected.canceled || !selected.filePaths.length) return { canceled: true };
  try {
    const filePath = selected.filePaths[0];
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('字幕文件无效或超过 10 MB 限制');
    const items = srt.parseSrt(fs.readFileSync(filePath, 'utf8'));
    if (!items.length) throw new Error('未找到有效字幕条目');
    return { canceled: false, items, path: filePath };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

ipcMain.handle('miniclip:exportSrt', async (_evt, items) => {
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: dialogText('导出 SRT 字幕', 'Export SRT captions'),
    defaultPath: path.join(app.getPath('documents') || os.homedir(), dialogText('MiniClip 字幕.srt', 'MiniClip captions.srt')),
    filters: [{ name: dialogText('SRT 字幕', 'SRT captions'), extensions: ['srt'] }],
  });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  try {
    fs.writeFileSync(selected.filePath, srt.serializeSrt(items), 'utf8');
    return { canceled: false, path: selected.filePath };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

/** Save a portable .miniclip project using an explicit path. */
ipcMain.handle('miniclip:saveProject', async (_evt, payload) => {
  try {
    const selected = payload && payload.path ? { canceled: false, filePath: payload.path } : await dialog.showSaveDialog(mainWindow, {
      title: dialogText('保存工程', 'Save project'),
      defaultPath: path.join(app.getPath('documents') || os.homedir(), dialogText('未命名工程.miniclip', 'Untitled Project.miniclip')),
      filters: [{ name: dialogText('MiniClip 工程', 'MiniClip project'), extensions: ['miniclip'] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    const savedPath = projects.writeProject(selected.filePath, payload && payload.state);
    return { canceled: false, path: savedPath };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

ipcMain.handle('miniclip:packageProject', async (_evt, state) => {
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: dialogText('选择工程包保存位置', 'Choose project package destination'), properties: ['openDirectory', 'createDirectory'],
  });
  if (selected.canceled || !selected.filePaths.length) return { canceled: true };
  try {
    const result = projects.packageProject(selected.filePaths[0], state);
    return { canceled: false, ...result };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

/** Choose and open a .miniclip project. */
ipcMain.handle('miniclip:openProject', async () => {
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: dialogText('打开工程', 'Open project'), properties: ['openFile'],
    filters: [{ name: dialogText('MiniClip 工程', 'MiniClip project'), extensions: ['miniclip'] }],
  });
  if (selected.canceled || !selected.filePaths.length) return { canceled: true };
  try {
    const loaded = projects.readProject(selected.filePaths[0]);
    const mediaPaths = projects.collectMediaPaths(loaded.state);
    const missingMedia = mediaPaths.filter((mediaPath) => !mediaPath || !fs.existsSync(mediaPath));
    return { canceled: false, path: loaded.path, state: loaded.state, savedAt: loaded.savedAt, missingMedia };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

/** Autosave is intentionally separate from user-visible project files. */
ipcMain.handle('miniclip:saveRecovery', async (_evt, state) => {
  try {
    projects.writeRecovery(recoveryPath(), state);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('miniclip:loadRecovery', async () => {
  const loaded = projects.readRecovery(recoveryPath());
  return loaded ? { found: true, state: loaded.state, savedAt: loaded.savedAt } : { found: false };
});

ipcMain.handle('miniclip:clearRecovery', async () => {
  try { fs.rmSync(recoveryPath(), { force: true }); } catch {}
  return { ok: true };
});

/**
 * Local auto-subtitle: transcribe a media file to subtitle overlays.
 * Returns { canceled?, overlays, segments, model } or { error }.
 */
ipcMain.handle('miniclip:transcribe', async (_evt, opts) => {
  try {
    if (!opts || typeof opts.input !== 'string') {
      throw new Error('缺少要识别的视频路径');
    }
    const input = runner.assertLocalFile(opts.input, '待识别视频');
    // Models are user-downloaded data, so use a writable per-user directory
    // instead of the app.asar/resources tree. The source-tree model remains a
    // development fallback inside whisper-runner.
    const userModelsDir = path.join(app.getPath('userData'), 'models');
    fs.mkdirSync(userModelsDir, { recursive: true });
    const res = await whisper.transcribe(
      Object.assign({}, opts, { input, modelsDir: userModelsDir }),
      (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('miniclip:transcribeProgress', p);
        }
      }
    );
    return { canceled: false, ...res };
  } catch (e) {
    return { error: e.message };
  }
});

/** Reveal a finished file in the OS file manager. */
ipcMain.handle('miniclip:revealFile', async (_evt, filePath) => {
  if (filePath) {
    try { shell.showItemInFolder(runner.assertLocalFile(filePath)); } catch {}
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function probeAll(paths) {
  const items = [];
  for (const p of paths) {
    try {
      const meta = await runner.probe(p);
      const image = /\.(png|jpe?g|webp|bmp)$/i.test(p);
      if (image) {
        items.push({
          path: p, url: pathToFileURL(p).href, name: path.basename(p), kind: 'image',
          duration: 3, hasAudio: false, width: meta.width, height: meta.height,
        });
        continue;
      }
      if (!meta.hasVideo || !(meta.duration > 0)) {
        items.push({ path: p, name: path.basename(p), error: '不是有效视频或无法读取时长' });
        continue;
      }
      items.push({
        path: p,
        url: pathToFileURL(p).href,
        name: path.basename(p),
        kind: 'video',
        duration: meta.duration,
        hasAudio: meta.hasAudio,
        width: meta.width,
        height: meta.height,
      });
    } catch (e) {
      items.push({ path: p, name: path.basename(p), error: e.message });
    }
  }
  return items;
}
