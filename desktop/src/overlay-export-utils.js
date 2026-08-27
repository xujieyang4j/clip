'use strict';

/** Pure mapping from an editable overlay item to the export specification. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MiniClipOverlayExport = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function number(value, fallback = 0) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function scaledMove(move, scaleX, scaleY) {
    if (!move || typeof move !== 'object') return null;
    return { toX: number(move.toX) * scaleX, toY: number(move.toY) * scaleY };
  }

  function scaledFrames(frames, scaleX, scaleY) {
    if (!Array.isArray(frames) || !frames.length) return undefined;
    return frames.map((frame) => Object.assign({}, frame, {
      x: number(frame && frame.x) * scaleX,
      y: number(frame && frame.y) * scaleY,
      bezier: frame && frame.bezier ? Object.assign({}, frame.bezier) : null,
    }));
  }

  function toExportOverlay(overlay, options = {}) {
    const item = overlay || {};
    const scaleX = number(options.scaleX, 1);
    const scaleY = number(options.scaleY, 1);
    const crop = item.crop || {};
    const chromaKey = item.chromaKey || {};
    return {
      path: item.path, kind: item.kind,
      start: number(item.start), end: number(item.end),
      x: number(item.x) * scaleX, y: number(item.y) * scaleY,
      scale: number(item.scale, 0.4), rotation: number(item.rotation),
      opacity: item.opacity == null ? 1 : number(item.opacity, 1),
      fadeDuration: number(item.fade),
      move: scaledMove(item.move, scaleX, scaleY),
      keyframes: scaledFrames(options.keyframes, scaleX, scaleY),
      mirrorX: !!item.mirrorX, mirrorY: !!item.mirrorY,
      crop: {
        left: number(crop.left), right: number(crop.right),
        top: number(crop.top), bottom: number(crop.bottom),
      },
      mask: item.mask || 'none', maskInvert: !!item.maskInvert,
      maskFeather: number(item.maskFeather),
      chromaKey: {
        enabled: !!chromaKey.enabled, color: chromaKey.color || '#00ff00',
        similarity: number(chromaKey.similarity, 0.1), blend: number(chromaKey.blend),
      },
      blendMode: item.blendMode || 'normal',
    };
  }

  return { toExportOverlay, scaledMove, scaledFrames };
});
