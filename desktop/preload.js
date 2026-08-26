'use strict';

/**
 * Preload: exposes a minimal, typed-ish `window.miniclip` API to the renderer
 * over contextBridge. The renderer stays sandboxed — no direct Node access.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniclip', {
  // persisted UI language; Chinese is the default on first launch
  getLanguage: () => ipcRenderer.invoke('miniclip:getLanguage'),
  setLanguage: (language) => ipcRenderer.invoke('miniclip:setLanguage', language),

  // one-time probe of the bundled ffmpeg
  capabilities: () => ipcRenderer.invoke('miniclip:capabilities'),

  // file pickers (return probed metadata)
  pickVideos: () => ipcRenderer.invoke('miniclip:pickVideos'),
  pickAudio: (opts) => ipcRenderer.invoke('miniclip:pickAudio', opts),
  saveRecording: (payload) => ipcRenderer.invoke('miniclip:saveRecording', payload),
  pickOverlayMedia: () => ipcRenderer.invoke('miniclip:pickOverlayMedia'),
  pickLut: () => ipcRenderer.invoke('miniclip:pickLut'),
  relinkMedia: (opts) => ipcRenderer.invoke('miniclip:relinkMedia', opts),
  probe: (filePath) => ipcRenderer.invoke('miniclip:probe', filePath),
  waveform: (filePath, bars) => ipcRenderer.invoke('miniclip:waveform', filePath, bars),
  audioAnalysis: (filePath, opts) => ipcRenderer.invoke('miniclip:audioAnalysis', filePath, opts),
  sceneDetect: (filePath, opts) => ipcRenderer.invoke('miniclip:sceneDetect', filePath, opts),
  createProxy: (filePath) => ipcRenderer.invoke('miniclip:createProxy', filePath),
  createImageProxy: (payload) => ipcRenderer.invoke('miniclip:createImageProxy', payload),
  createFreezeFrame: (payload) => ipcRenderer.invoke('miniclip:createFreezeFrame', payload),

  // project persistence and crash recovery
  saveProject: (payload) => ipcRenderer.invoke('miniclip:saveProject', payload),
  packageProject: (state) => ipcRenderer.invoke('miniclip:packageProject', state),
  openProject: () => ipcRenderer.invoke('miniclip:openProject'),
  saveRecovery: (state) => ipcRenderer.invoke('miniclip:saveRecovery', state),
  loadRecovery: () => ipcRenderer.invoke('miniclip:loadRecovery'),
  clearRecovery: () => ipcRenderer.invoke('miniclip:clearRecovery'),

  // subtitle exchange
  importSrt: () => ipcRenderer.invoke('miniclip:importSrt'),
  exportSrt: (items) => ipcRenderer.invoke('miniclip:exportSrt', items),

  // local speech-to-text (auto subtitles)
  transcribe: (opts) => ipcRenderer.invoke('miniclip:transcribe', opts),
  onTranscribeProgress: (cb) => {
    const listener = (_evt, value) => cb(value);
    ipcRenderer.on('miniclip:transcribeProgress', listener);
    return () => ipcRenderer.removeListener('miniclip:transcribeProgress', listener);
  },

  // export
  exportTimeline: (spec) => ipcRenderer.invoke('miniclip:export', spec),
  renderPreview: (spec) => ipcRenderer.invoke('miniclip:renderPreview', spec),
  cancelExport: () => ipcRenderer.invoke('miniclip:cancelExport'),
  revealFile: (filePath) => ipcRenderer.invoke('miniclip:revealFile', filePath),

  // progress stream; returns an unsubscribe fn
  onExportProgress: (cb) => {
    const listener = (_evt, value) => cb(value);
    ipcRenderer.on('miniclip:exportProgress', listener);
    return () => ipcRenderer.removeListener('miniclip:exportProgress', listener);
  },
  onPreviewProgress: (cb) => {
    const listener = (_evt, value) => cb(value);
    ipcRenderer.on('miniclip:previewProgress', listener);
    return () => ipcRenderer.removeListener('miniclip:previewProgress', listener);
  },
});
