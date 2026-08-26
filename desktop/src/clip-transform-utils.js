'use strict';

/**
 * Keyframe model for main-timeline clip transforms. Key times are local to a
 * clip's effective (post-speed) duration, keeping the animation self-contained
 * when a project is moved or a preceding clip changes length.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MiniClipClipTransform = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CURVES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'bezier'];
  const PROPS = ['x', 'y', 'scale', 'opacity'];

  function finite(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function durationOf(clip) {
    const raw = Math.max(0, finite(clip && clip.trimEnd, 0) - finite(clip && clip.trimStart, 0));
    const speed = clamp(finite(clip && clip.speed, 1), 0.25, 4);
    return raw / speed;
  }
  function baseValues(clip) {
    const source = clip || {};
    return {
      x: clamp(finite(source.transformX, 0), -100, 100),
      y: clamp(finite(source.transformY, 0), -100, 100),
      scale: clamp(finite(source.transformScale, 1), 0.5, 2),
      opacity: clamp(finite(source.opacity, 1), 0, 1),
    };
  }
  function normalise(clip) {
    const duration = Math.max(0.001, durationOf(clip));
    const base = baseValues(clip);
    const list = Array.isArray(clip && clip.transformKeyframes) ? clip.transformKeyframes : [];
    return list.map((raw) => {
      const frame = raw || {};
      const curve = CURVES.includes(frame.curve) ? frame.curve : 'linear';
      return {
        time: clamp(finite(frame.time, 0), 0, duration),
        x: clamp(finite(frame.x, base.x), -100, 100),
        y: clamp(finite(frame.y, base.y), -100, 100),
        scale: clamp(finite(frame.scale, base.scale), 0.5, 2),
        opacity: clamp(finite(frame.opacity, base.opacity), 0, 1),
        curve,
        bezier: curve === 'bezier' ? {
          x1: clamp(finite(frame.bezier && frame.bezier.x1, 0.25), 0, 1),
          y1: clamp(finite(frame.bezier && frame.bezier.y1, 0.1), 0, 1),
          x2: clamp(finite(frame.bezier && frame.bezier.x2, 0.25), 0, 1),
          y2: clamp(finite(frame.bezier && frame.bezier.y2, 1), 0, 1),
        } : null,
      };
    }).sort((a, b) => a.time - b.time).filter((frame, index, frames) => index === frames.length - 1 || frame.time !== frames[index + 1].time);
  }
  function easedProgress(progress, curve, bezier) {
    const p = clamp(finite(progress, 0), 0, 1);
    if (curve === 'easeIn') return p * p;
    if (curve === 'easeOut') return p * (2 - p);
    if (curve === 'easeInOut') return p * p * (3 - 2 * p);
    if (curve !== 'bezier') return p;
    const b = bezier || { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
    const cubic = (t, p1, p2) => { const u = 1 - t; return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t; };
    let lo = 0, hi = 1, t = p;
    for (let index = 0; index < 14; index++) { t = (lo + hi) / 2; if (cubic(t, b.x1, b.x2) < p) lo = t; else hi = t; }
    return cubic(t, b.y1, b.y2);
  }
  function valuesAt(clip, time) {
    const frames = normalise(clip);
    const base = baseValues(clip);
    if (!frames.length) return base;
    if (time <= frames[0].time) return Object.assign({}, base, frames[0]);
    const last = frames[frames.length - 1];
    if (time >= last.time) return Object.assign({}, base, last);
    for (let index = 0; index < frames.length - 1; index++) {
      const from = frames[index], to = frames[index + 1];
      if (time <= to.time) {
        const p = easedProgress((time - from.time) / Math.max(0.000001, to.time - from.time), from.curve, from.bezier);
        const values = {};
        for (const prop of PROPS) values[prop] = from[prop] + (to[prop] - from[prop]) * p;
        return values;
      }
    }
    return Object.assign({}, base, last);
  }
  function frameFrom(values, time, curve = 'linear') {
    const source = values || {};
    return { time, x: source.x, y: source.y, scale: source.scale, opacity: source.opacity, curve: CURVES.includes(curve) ? curve : 'linear', bezier: null };
  }
  return { CURVES, PROPS, durationOf, baseValues, normalise, valuesAt, frameFrom, easedProgress };
});
