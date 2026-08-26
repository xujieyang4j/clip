'use strict';

/**
 * Small, dependency-free keyframe model shared by the UI and export graph.
 *
 * Keyframes live on the final (export) timeline. A frame stores the complete
 * visual state of an overlay at `time`, plus the easing curve used to reach
 * the *next* frame. Keeping the evaluator here means the browser preview and
 * the FFmpeg compiler agree on the same values.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MiniClipKeyframes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CURVES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'bezier'];
  const PROPS = ['x', 'y', 'scale', 'opacity', 'rotation'];

  function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function baseValues(overlay) {
    const o = overlay || {};
    return {
      x: finite(o.x, 0),
      y: finite(o.y, 0),
      scale: clamp(finite(o.scale, 0.4), 0.02, 1),
      opacity: clamp(finite(o.opacity, 1), 0, 1),
      rotation: finite(o.rotation, 0),
    };
  }

  function overlayRange(overlay) {
    const start = Math.max(0, finite(overlay && overlay.start, 0));
    const endValue = finite(overlay && overlay.end, start + 3);
    return { start, end: endValue > start ? endValue : start + 3 };
  }

  function frameFrom(values, time, curve) {
    return {
      time,
      x: values.x, y: values.y, scale: values.scale, opacity: values.opacity, rotation: values.rotation,
      curve: CURVES.includes(curve) ? curve : 'linear',
      bezier: null,
    };
  }

  /**
   * Convert legacy `move` projects on read. They remain exportable even after
   * upgrading, while all newly edited animations use `keyframes`.
   */
  function legacyFrames(overlay) {
    const o = overlay || {};
    if (!o.move || (o.move.toX == null && o.move.toY == null)) return [];
    const range = overlayRange(o);
    const from = baseValues(o);
    const to = Object.assign({}, from, {
      x: finite(o.move.toX, from.x),
      y: finite(o.move.toY, from.y),
    });
    return [frameFrom(from, range.start, 'linear'), frameFrom(to, range.end, 'linear')];
  }

  /** Return sorted, bounded frames with every visual property populated. */
  function normaliseKeyframes(overlay) {
    const o = overlay || {};
    const range = overlayRange(o);
    const base = baseValues(o);
    const source = Array.isArray(o.keyframes) && o.keyframes.length
      ? o.keyframes
      : legacyFrames(o);
    const frames = source.map((raw) => {
      const f = raw || {};
      const values = {
        x: finite(f.x, base.x),
        y: finite(f.y, base.y),
        scale: clamp(finite(f.scale, base.scale), 0.02, 1),
        opacity: clamp(finite(f.opacity, base.opacity), 0, 1),
        rotation: finite(f.rotation, base.rotation),
      };
      const frame = frameFrom(values, clamp(finite(f.time, range.start), range.start, range.end), f.curve);
      if (frame.curve === 'bezier') {
        const b = f.bezier || {};
        frame.bezier = { x1: clamp(finite(b.x1, 0.25), 0, 1), y1: clamp(finite(b.y1, 0.1), 0, 1), x2: clamp(finite(b.x2, 0.25), 0, 1), y2: clamp(finite(b.y2, 1), 0, 1) };
      }
      return frame;
    }).sort((a, b) => a.time - b.time);

    // Same-time frames are ambiguous. Keep the newest (last) value so editing
    // a keyframe in place remains deterministic.
    return frames.filter((frame, index) => index === frames.length - 1 || frame.time !== frames[index + 1].time);
  }

  function easedProgress(progress, curve) {
    const p = clamp(finite(progress, 0), 0, 1);
    switch (curve) {
      case 'easeIn': return p * p;
      case 'easeOut': return p * (2 - p);
      case 'easeInOut': return p * p * (3 - 2 * p);
      default: return p;
    }
  }

  function cubicBezierValue(t, p1, p2) {
    const u = 1 - t;
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
  }
  function cubicBezierProgress(progress, bezier) {
    const p = clamp(finite(progress, 0), 0, 1);
    const b = bezier || { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
    let lo = 0, hi = 1, t = p;
    for (let i = 0; i < 14; i++) {
      t = (lo + hi) / 2;
      if (cubicBezierValue(t, b.x1, b.x2) < p) lo = t; else hi = t;
    }
    return cubicBezierValue(t, b.y1, b.y2);
  }

  function evaluateKeyframes(frames, time, fallback) {
    const base = Object.assign({}, baseValues(fallback));
    const list = Array.isArray(frames) ? frames : [];
    if (!list.length) return base;
    if (time <= list[0].time) return Object.assign({}, base, list[0]);
    const last = list[list.length - 1];
    if (time >= last.time) return Object.assign({}, base, last);
    for (let i = 0; i < list.length - 1; i++) {
      const from = list[i], to = list[i + 1];
      if (time <= to.time) {
        const span = Math.max(0.000001, to.time - from.time);
        const raw = (time - from.time) / span;
        const p = from.curve === 'bezier' ? cubicBezierProgress(raw, from.bezier) : easedProgress(raw, from.curve);
        const out = {};
        for (const prop of PROPS) out[prop] = from[prop] + (to[prop] - from[prop]) * p;
        return out;
      }
    }
    return Object.assign({}, base, last);
  }

  function valuesAt(overlay, time) {
    return evaluateKeyframes(normaliseKeyframes(overlay), time, overlay);
  }

  return {
    CURVES, PROPS, baseValues, overlayRange, frameFrom, legacyFrames,
    normaliseKeyframes, easedProgress, cubicBezierValue, cubicBezierProgress, evaluateKeyframes, valuesAt,
  };
});
