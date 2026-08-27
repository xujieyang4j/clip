'use strict';

/**
 * Headless renderer boot smoke test. A tiny DOM/API stub is enough to catch
 * missing IDs, top-level ReferenceErrors and event-wiring regressions without
 * needing a display server.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

function element(id) {
  return {
    id, value: '0', checked: false, disabled: false, textContent: '', src: '',
    style: {}, dataset: {}, children: [], clientWidth: 640, clientHeight: 360,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    appendChild(x) { this.children.push(x); }, remove() {}, load() {}, pause() {},
  };
}
const elements = new Map([...ids].map((id) => [id, element(id)]));
const document = {
  getElementById(id) { return elements.get(id) || null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  createElement(tag) { return element(tag); },
};
const context = {
  document, console, setTimeout, clearTimeout,
  window: {
    MiniClipI18n: { t: (value) => String(value), dynamic: (value) => String(value) },
    MiniClipClipTransform: { durationOf: () => 1, normalise: () => [], valuesAt: () => ({ x: 0, y: 0, scale: 1, opacity: 1 }), frameFrom: (values, time, curve) => Object.assign({ time, curve }, values) },
    MiniClipClipAppearance: { capture: (value) => value, apply: (target, value) => Object.assign(target, value) },
    miniclip: {
      getLanguage: async () => ({ language: 'zh-CN' }),
      setLanguage: async () => ({ language: 'zh-CN' }),
      capabilities: async () => ({ ok: true, version: 'test', hasXfade: true, hasSubtitles: true, hasDeshake: true }),
      onExportProgress: () => () => {},
      onTranscribeProgress: () => () => {},
      saveProject: async () => ({ canceled: true }),
      packageProject: async () => ({ canceled: true }),
      openProject: async () => ({ canceled: true }),
      saveRecovery: async () => ({ ok: true }),
      loadRecovery: async () => ({ found: false }),
      clearRecovery: async () => ({ ok: true }),
      importSrt: async () => ({ canceled: true }),
      exportSrt: async () => ({ canceled: true }),
      waveform: async () => ({ ok: true, peaks: [] }),
      audioAnalysis: async () => ({ ok: true, silences: [], beats: [] }),
      sceneDetect: async () => ({ ok: true, cuts: [] }),
      saveRecording: async () => ({ ok: false, error: 'test' }),
      pickLut: async () => ({ canceled: true }),
      createProxy: async () => ({ ok: true, url: 'file:///proxy.mp4' }),
      createImageProxy: async () => ({ ok: true, url: 'file:///image-proxy.mp4' }),
      createFreezeFrame: async () => ({ ok: false, error: 'test' }),
      relinkMedia: async () => ({ canceled: true }),
      renderPreview: async () => ({ ok: false, error: 'test' }),
      onPreviewProgress: () => () => {},
    },
  },
};
context.globalThis = context;
vm.runInNewContext(fs.readFileSync(path.join(src, 'timeline-utils.js'), 'utf8'), context, { filename: 'timeline-utils.js' });
vm.runInNewContext(fs.readFileSync(path.join(src, 'overlay-export-utils.js'), 'utf8'), context, { filename: 'overlay-export-utils.js' });
vm.runInNewContext(fs.readFileSync(path.join(src, 'renderer.js'), 'utf8'), context, { filename: 'renderer.js' });
console.log(`renderer boot smoke: ${ids.size} DOM ids wired`);
