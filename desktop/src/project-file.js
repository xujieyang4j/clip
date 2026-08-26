'use strict';

/**
 * Portable MiniClip project document format.
 *
 * Media stays at its original location; the project only stores local paths
 * and editing decisions. Keeping this module pure makes corruption/compatibility
 * rules testable without Electron or filesystem access.
 */

const FORMAT = 'miniclip-project';
const VERSION = 1;
const MAX_BYTES = 20 * 1024 * 1024;

function number(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function string(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function id(value, fallback) {
  return Math.max(1, Math.floor(number(value, fallback, 1, Number.MAX_SAFE_INTEGER)));
}

function colour(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(string(value)) ? value : fallback;
}

function cleanKeyframes(value) {
  return array(value).map((frame) => ({
    time: number(frame && frame.time, 0, 0, 24 * 60 * 60),
    x: number(frame && frame.x, 0, -100000, 100000),
    y: number(frame && frame.y, 0, -100000, 100000),
    scale: number(frame && frame.scale, 0.4, 0.02, 1),
    opacity: number(frame && frame.opacity, 1, 0, 1),
    rotation: number(frame && frame.rotation, 0, -3600, 3600),
    curve: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'bezier'].includes(frame && frame.curve) ? frame.curve : 'linear',
    bezier: frame && frame.curve === 'bezier' ? {
      x1: number(frame.bezier && frame.bezier.x1, 0.25, 0, 1), y1: number(frame.bezier && frame.bezier.y1, 0.1, 0, 1),
      x2: number(frame.bezier && frame.bezier.x2, 0.25, 0, 1), y2: number(frame.bezier && frame.bezier.y2, 1, 0, 1),
    } : null,
  }));
}

function cleanClipTransformKeyframes(value, sourceDuration, speed) {
  const duration = Math.max(0.001, sourceDuration / Math.max(0.25, speed));
  return array(value).map((frame) => ({
    time: number(frame && frame.time, 0, 0, duration),
    x: number(frame && frame.x, 0, -100, 100),
    y: number(frame && frame.y, 0, -100, 100),
    scale: number(frame && frame.scale, 1, 0.5, 2),
    opacity: number(frame && frame.opacity, 1, 0, 1),
    curve: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'bezier'].includes(frame && frame.curve) ? frame.curve : 'linear',
    bezier: frame && frame.curve === 'bezier' ? {
      x1: number(frame.bezier && frame.bezier.x1, 0.25, 0, 1), y1: number(frame.bezier && frame.bezier.y1, 0.1, 0, 1),
      x2: number(frame.bezier && frame.bezier.x2, 0.25, 0, 1), y2: number(frame.bezier && frame.bezier.y2, 1, 0, 1),
    } : null,
  }));
}

function cleanClip(value, index) {
  const clip = value || {};
  const sourceDuration = number(clip.sourceDuration, 0, 0, 24 * 60 * 60);
  const trimStart = number(clip.trimStart, 0, 0, sourceDuration || 24 * 60 * 60);
  const trimEnd = number(clip.trimEnd, sourceDuration, trimStart, sourceDuration || 24 * 60 * 60);
  const color = clip.color || {};
  const transition = clip.transitionToNext || {};
  const cleanAnimation = (animation) => {
    const source = animation && typeof animation === 'object' ? animation : {};
    return {
      style: ['none', 'fade', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'].includes(source.style) ? source.style : 'none',
      duration: number(source.duration, 0, 0, 2),
    };
  };
  return {
    id: id(clip.id, index + 1),
    path: string(clip.path), name: string(clip.name), kind: clip.kind === 'image' ? 'image' : 'video',
    sourceDuration, trimStart, trimEnd,
    hasAudio: !!clip.hasAudio, muted: !!clip.muted,
    speed: number(clip.speed, 1, 0.25, 4), reverse: !!clip.reverse,
    volume: number(clip.volume, 1, 0, 2),
    fadeIn: number(clip.fadeIn, 0, 0, 10),
    fadeOut: number(clip.fadeOut, 0, 0, 10),
    opacity: number(clip.opacity, 1, 0, 1),
    motion: ['none', 'zoomIn', 'zoomOut'].includes(clip.motion) ? clip.motion : 'none',
    animationIn: cleanAnimation(clip.animationIn),
    animationOut: cleanAnimation(clip.animationOut),
    stabilize: ['off', 'basic', 'strong'].includes(clip.stabilize) ? clip.stabilize : 'off',
    rotation: number(clip.rotation, 0, -3600, 3600),
    mirrorX: !!clip.mirrorX, mirrorY: !!clip.mirrorY,
    transformScale: number(clip.transformScale, 1, 0.5, 2),
    transformX: number(clip.transformX, 0, -100, 100),
    transformY: number(clip.transformY, 0, -100, 100),
    transformKeyframes: cleanClipTransformKeyframes(clip.transformKeyframes, trimEnd - trimStart, number(clip.speed, 1, 0.25, 4)),
    crop: {
      left: number(clip.crop && clip.crop.left, 0, 0, 0.45),
      right: number(clip.crop && clip.crop.right, 0, 0, 0.45),
      top: number(clip.crop && clip.crop.top, 0, 0, 0.45),
      bottom: number(clip.crop && clip.crop.bottom, 0, 0, 0.45),
    },
    fillMode: ['', 'pad', 'blur'].includes(clip.fillMode) ? clip.fillMode : '',
    color: {
      brightness: number(color.brightness, 0, -0.5, 0.5),
      contrast: number(color.contrast, 1, 0.5, 2),
      saturation: number(color.saturation, 1, 0, 3),
      temperature: number(color.temperature, 0, -100, 100),
      hue: number(color.hue, 0, -180, 180),
      gamma: number(color.gamma, 1, 0.5, 2),
      curve: ['none', 'lift', 'contrast'].includes(color.curve) ? color.curve : 'none',
      lutPath: string(color.lutPath),
    },
    effect: ['none', 'mono', 'vintage', 'soft', 'sharpen'].includes(clip.effect) ? clip.effect : 'none',
    vignette: number(clip.vignette, 0, 0, 1),
    grain: number(clip.grain, 0, 0, 1),
    transitionToNext: {
      style: string(transition.style, 'none'),
      duration: number(transition.duration, 0, 0, 2),
    },
  };
}

function cleanText(value, index) {
  const text = value || {};
  const start = number(text.start, 0, 0, 24 * 60 * 60);
  const optionalPercent = (value) => value == null ? null : number(value, 50, 0, 100);
  return {
    id: id(text.id, index + 1), text: string(text.text), start,
    secondaryText: string(text.secondaryText),
    end: number(text.end, start + 2, start, 24 * 60 * 60),
    position: ['top', 'bottom', 'center', 'bottom-left', 'bottom-right', 'top-left', 'top-right'].includes(text.position) ? text.position : 'bottom',
    fontSize: number(text.fontSize, 48, 12, 200),
    fontFamily: ['sans-serif', 'serif', 'monospace'].includes(text.fontFamily) ? text.fontFamily : 'sans-serif',
    bold: !!text.bold, italic: !!text.italic,
    opacity: number(text.opacity, 1, 0, 1),
    xPercent: optionalPercent(text.xPercent), yPercent: optionalPercent(text.yPercent),
    color: colour(text.color, '#ffffff'), outlineColor: colour(text.outlineColor, '#000000'),
    outlineWidth: number(text.outlineWidth, 2, 0, 12), shadow: number(text.shadow, 0, 0, 12), spacing: number(text.spacing, 0, -5, 20),
    karaoke: !!text.karaoke, karaokeHighlightColor: colour(text.karaokeHighlightColor, '#ffd54a'),
    words: array(text.words).map((word) => ({
      text: string(word && word.text),
      start: number(word && word.start, 0, 0, 24 * 60 * 60),
      end: number(word && word.end, 0, 0, 24 * 60 * 60),
    })).filter((word) => word.text && word.end > word.start),
    // Pre-caption projects did not distinguish titles from subtitles. Default
    // conservatively to false so applying a subtitle preset never restyles a
    // user's old title card by surprise. New ASR/SRT items set this explicitly.
    isCaption: !!text.isCaption,
    fade: number(text.fade, 0, 0, 2),
  };
}

function cleanOverlay(value, index) {
  const overlay = value || {};
  const start = number(overlay.start, 0, 0, 24 * 60 * 60);
  const move = overlay.move && typeof overlay.move === 'object' ? {
    toX: number(overlay.move.toX, number(overlay.x, 40, -100000, 100000), -100000, 100000),
    toY: number(overlay.move.toY, number(overlay.y, 40, -100000, 100000), -100000, 100000),
  } : null;
  return {
    id: id(overlay.id, index + 1), path: string(overlay.path), name: string(overlay.name),
    kind: overlay.kind === 'video' ? 'video' : 'image',
    start, end: number(overlay.end, start + 3, start + 0.001, 24 * 60 * 60),
    x: number(overlay.x, 40, -100000, 100000), y: number(overlay.y, 40, -100000, 100000),
    scale: number(overlay.scale, 0.4, 0.02, 1), opacity: number(overlay.opacity, 1, 0, 1),
    rotation: number(overlay.rotation, 0, -3600, 3600),
    mirrorX: !!overlay.mirrorX, mirrorY: !!overlay.mirrorY,
    crop: {
      left: number(overlay.crop && overlay.crop.left, 0, 0, 0.45),
      right: number(overlay.crop && overlay.crop.right, 0, 0, 0.45),
      top: number(overlay.crop && overlay.crop.top, 0, 0, 0.45),
      bottom: number(overlay.crop && overlay.crop.bottom, 0, 0, 0.45),
    },
    mask: ['none', 'ellipse', 'rounded'].includes(overlay.mask) ? overlay.mask : 'none',
    maskInvert: !!overlay.maskInvert,
    maskFeather: number(overlay.maskFeather, 0, 0, 0.25),
    chromaKey: {
      enabled: !!(overlay.chromaKey && overlay.chromaKey.enabled),
      color: colour(overlay.chromaKey && overlay.chromaKey.color, '#00ff00'),
      similarity: number(overlay.chromaKey && overlay.chromaKey.similarity, 0.1, 0.01, 1),
      blend: number(overlay.chromaKey && overlay.chromaKey.blend, 0, 0, 1),
    },
    blendMode: ['normal', 'screen', 'multiply', 'addition'].includes(overlay.blendMode) ? overlay.blendMode : 'normal',
    fade: number(overlay.fade, 0, 0, 2), move,
    keyframes: cleanKeyframes(overlay.keyframes),
    _w: number(overlay._w, 0, 0, 100000), _h: number(overlay._h, 0, 0, 100000),
  };
}

function cleanBroll(value, index) {
  const broll = value || {};
  const start = number(broll.start, 0, 0, 24 * 60 * 60);
  return {
    id: id(broll.id, index + 1), path: string(broll.path), name: string(broll.name),
    trackId: string(broll.trackId),
    duration: number(broll.duration, 0, 0, 24 * 60 * 60),
    start, end: number(broll.end, start + 3, start + 0.001, 24 * 60 * 60),
    trimStart: number(broll.trimStart, 0, 0, 24 * 60 * 60),
    loop: broll.loop !== false,
    x: number(broll.x, 0, -100000, 100000), y: number(broll.y, 0, -100000, 100000),
    scale: number(broll.scale, 1, 0.02, 2),
    opacity: number(broll.opacity, 1, 0, 1),
    rotation: number(broll.rotation, 0, -3600, 3600),
    fade: number(broll.fade, 0, 0, 2),
  };
}

function cleanVideoTrack(value, index) {
  const track = value || {};
  return {
    id: string(track.id, `video-${index + 1}`) || `video-${index + 1}`,
    name: string(track.name, `视频层 ${index + 1}`) || `视频层 ${index + 1}`,
    visible: track.visible !== false,
    locked: !!track.locked,
  };
}

function cleanBgm(value) {
  if (!value || typeof value !== 'object' || !string(value.path)) return null;
  return {
    path: string(value.path), name: string(value.name),
    duration: number(value.duration, 0, 0, 24 * 60 * 60),
    trimStart: number(value.trimStart, 0, 0, 24 * 60 * 60),
    fadeIn: number(value.fadeIn, 0, 0, 10),
    fadeOut: number(value.fadeOut, 0, 0, 10),
  };
}

function cleanAudioTrack(value, index) {
  const track = value || {};
  const start = number(track.start, 0, 0, 24 * 60 * 60);
  const muteRanges = array(track.muteRanges).map((range) => {
    const rangeStart = number(range && range.start, 0, 0, 24 * 60 * 60);
    return { start: rangeStart, end: number(range && range.end, rangeStart, rangeStart, 24 * 60 * 60) };
  }).filter((range) => range.end > range.start);
  return {
    id: id(track.id, index + 1), path: string(track.path), name: string(track.name),
    duration: number(track.duration, 0, 0, 24 * 60 * 60),
    start, end: number(track.end, start + 3, start + 0.001, 24 * 60 * 60),
    trimStart: number(track.trimStart, 0, 0, 24 * 60 * 60),
    speed: number(track.speed, 1, 0.25, 4), reverse: !!track.reverse,
    pitch: number(track.pitch, 0, -12, 12),
    denoise: !!track.denoise, voiceEnhance: !!track.voiceEnhance,
    volume: number(track.volume, 1, 0, 2),
    fadeIn: number(track.fadeIn, 0, 0, 10),
    fadeOut: number(track.fadeOut, 0, 0, 10),
    muteRanges,
    loop: !!track.loop,
  };
}

function outputProfile(value) {
  return ['720p', '1080p', '2k', '4k'].includes(value) ? value : '1080p';
}

function normaliseProjectState(value) {
  const state = value || {};
  const videoTracks = array(state.videoTracks).map(cleanVideoTrack);
  if (!videoTracks.length) {
    videoTracks.push({
      id: 'video-1', name: '视频层 1',
      visible: state.trackControls ? state.trackControls.brollVisible !== false : true,
      locked: !!(state.trackControls && state.trackControls.brollLocked),
    });
  }
  const brolls = array(state.brolls).map(cleanBroll).map((broll) => Object.assign(broll, {
    trackId: videoTracks.some((track) => track.id === broll.trackId) ? broll.trackId : videoTracks[0].id,
  }));
  return {
    clips: array(state.clips).map(cleanClip),
    texts: array(state.texts).map(cleanText),
    overlays: array(state.overlays).map(cleanOverlay),
    brolls,
    videoTracks,
    selectedVideoTrackId: videoTracks.some((track) => track.id === state.selectedVideoTrackId) ? state.selectedVideoTrackId : videoTracks[0].id,
    audioTracks: array(state.audioTracks).map(cleanAudioTrack),
    bgm: cleanBgm(state.bgm),
    originalVolume: number(state.originalVolume, 1, 0, 1),
    bgmVolume: number(state.bgmVolume, 0.5, 0, 1),
    bgmDuck: !!state.bgmDuck,
    bgmDuckAmount: number(state.bgmDuckAmount, 0.35, 0.1, 0.8),
    loudnessNormalize: !!state.loudnessNormalize,
    videoTrackLocked: !!state.videoTrackLocked,
    trackControls: {
      brollVisible: state.trackControls ? state.trackControls.brollVisible !== false : true,
      brollLocked: !!(state.trackControls && state.trackControls.brollLocked),
      overlayVisible: state.trackControls ? state.trackControls.overlayVisible !== false : true,
      overlayLocked: !!(state.trackControls && state.trackControls.overlayLocked),
      textVisible: state.trackControls ? state.trackControls.textVisible !== false : true,
      textLocked: !!(state.trackControls && state.trackControls.textLocked),
      audioMuted: !!(state.trackControls && state.trackControls.audioMuted),
      audioLocked: !!(state.trackControls && state.trackControls.audioLocked),
    },
    aspect: ['16:9', '9:16', '1:1', '4:3'].includes(state.aspect) ? state.aspect : '16:9',
    fillMode: ['pad', 'blur'].includes(state.fillMode) ? state.fillMode : 'pad',
    canvasColor: colour(state.canvasColor, '#000000'),
    outputProfile: outputProfile(state.outputProfile),
    frameRate: number(state.frameRate, 30, 24, 60),
  };
}

function createProjectDocument(state, savedAt = new Date().toISOString()) {
  return { format: FORMAT, version: VERSION, savedAt, state: normaliseProjectState(state) };
}

function serializeProject(state, savedAt) {
  return JSON.stringify(createProjectDocument(state, savedAt), null, 2) + '\n';
}

function parseProject(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    throw new Error('工程文件无效或超过 20 MB 限制');
  }
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('工程文件不是有效 JSON'); }
  if (!doc || doc.format !== FORMAT) throw new Error('这不是 MiniClip 工程文件');
  if (doc.version !== VERSION) throw new Error('不支持的工程版本：' + doc.version);
  if (!doc.state || typeof doc.state !== 'object') throw new Error('工程文件缺少编辑状态');
  return { savedAt: string(doc.savedAt), state: normaliseProjectState(doc.state) };
}

module.exports = {
  FORMAT, VERSION, MAX_BYTES,
  normaliseProjectState, createProjectDocument, serializeProject, parseProject,
};
