'use strict';

/**
 * A deliberately narrow visual-property clipboard for main timeline clips.
 * It never carries source media, source trims, timing, audio, speed, or the
 * outgoing transition, so applying a look cannot restructure the edit.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MiniClipClipAppearance = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const ANIMATION_STYLES = ['none', 'fade', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'];
  const MOTIONS = ['none', 'zoomIn', 'zoomOut'];
  const STABILIZATIONS = ['off', 'basic', 'strong'];
  const EFFECTS = ['none', 'mono', 'vintage', 'soft', 'sharpen'];
  const FILL_MODES = ['', 'pad', 'blur'];

  function number(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function animation(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      style: ANIMATION_STYLES.includes(source.style) ? source.style : 'none',
      duration: number(source.duration, 0, 0, 2),
    };
  }

  function capture(clip) {
    const source = clip && typeof clip === 'object' ? clip : {};
    const crop = source.crop || {};
    const color = source.color || {};
    return {
      version: 1,
      fillMode: FILL_MODES.includes(source.fillMode) ? source.fillMode : '',
      crop: {
        left: number(crop.left, 0, 0, 0.45), right: number(crop.right, 0, 0, 0.45),
        top: number(crop.top, 0, 0, 0.45), bottom: number(crop.bottom, 0, 0, 0.45),
      },
      mirrorX: !!source.mirrorX, mirrorY: !!source.mirrorY,
      rotation: number(source.rotation, 0, -3600, 3600),
      opacity: number(source.opacity, 1, 0, 1),
      transformScale: number(source.transformScale, 1, 0.5, 2),
      transformX: number(source.transformX, 0, -100, 100),
      transformY: number(source.transformY, 0, -100, 100),
      color: {
        brightness: number(color.brightness, 0, -0.5, 0.5),
        contrast: number(color.contrast, 1, 0.5, 2),
        saturation: number(color.saturation, 1, 0, 3),
        temperature: number(color.temperature, 0, -100, 100),
        hue: number(color.hue, 0, -180, 180),
        gamma: number(color.gamma, 1, 0.5, 2),
        curve: ['none', 'lift', 'contrast'].includes(color.curve) ? color.curve : 'none',
        lutPath: typeof color.lutPath === 'string' ? color.lutPath : '',
      },
      effect: EFFECTS.includes(source.effect) ? source.effect : 'none',
      vignette: number(source.vignette, 0, 0, 1),
      grain: number(source.grain, 0, 0, 1),
      motion: MOTIONS.includes(source.motion) ? source.motion : 'none',
      stabilize: STABILIZATIONS.includes(source.stabilize) ? source.stabilize : 'off',
      animationIn: animation(source.animationIn),
      animationOut: animation(source.animationOut),
    };
  }

  function apply(clip, appearance) {
    if (!clip || typeof clip !== 'object') return clip;
    const next = capture(appearance);
    // `capture` intentionally ignores unrelated object keys, giving us a
    // normalized deep copy with no shared nested references.
    Object.assign(clip, next);
    delete clip.version;
    return clip;
  }

  return { capture, apply };
});
