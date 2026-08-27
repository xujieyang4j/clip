'use strict';

/**
 * Renderer: editor state + timeline + inspector + preview.
 *
 * Everything the user configures maps to the export spec consumed by
 * src/ffmpeg-graph.js / ffmpeg-runner.js. Heavy work (probe, transcribe,
 * export) is delegated to the main process via window.miniclip.
 *
 * Preview is an approximation for responsiveness:
 *   - speed  -> video.playbackRate
 *   - color  -> CSS filter on the video
 *   - aspect -> canvas aspect-ratio + letterbox
 *   - text   -> HTML overlays; media overlays -> HTML img/video
 * The authoritative render (transitions, real color, burned subs, PiP, mix)
 * happens in ffmpeg at export time.
 */

const api = window.miniclip;
const i18n = window.MiniClipI18n || { t: (value) => String(value), dynamic: (value) => String(value) };
const $ = (id) => document.getElementById(id);
const timeline = window.MiniClipTimeline;
const keyframe = window.MiniClipKeyframes;
const clipAppearance = window.MiniClipClipAppearance;
const clipTransform = window.MiniClipClipTransform;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XFADE_STYLES = [
  ['none', '硬切'], ['fade', '淡入淡出'], ['fadeblack', '黑场'], ['fadewhite', '白场'],
  ['dissolve', '溶解'], ['wipeleft', '左擦除'], ['wiperight', '右擦除'],
  ['wipeup', '上擦除'], ['wipedown', '下擦除'], ['slideleft', '左滑'],
  ['slideright', '右滑'], ['slideup', '上滑'], ['slidedown', '下滑'],
  ['smoothleft', '平滑左'], ['smoothright', '平滑右'], ['circleopen', '圆形展开'],
  ['circleclose', '圆形闭合'], ['radial', '径向'], ['pixelize', '像素化'], ['diagtl', '对角'],
];

const ASPECTS = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720], '4:3': [960, 720] };
const OUTPUT_PROFILE_LONG_EDGE = { '720p': 1280, '1080p': 1920, '2k': 2560, '4k': 3840 };

const COLOR_PRESETS = {
  none: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
  warm: { brightness: 0.03, contrast: 1.05, saturation: 1.15, temperature: -40 },
  cool: { brightness: 0.0, contrast: 1.05, saturation: 1.05, temperature: 45 },
  vivid: { brightness: 0.04, contrast: 1.2, saturation: 1.5, temperature: 0 },
  bw: { brightness: 0, contrast: 1.1, saturation: 0, temperature: 0 },
};
const EFFECT_LABELS = { mono: '黑白', vintage: '复古', soft: '柔光', sharpen: '锐化' };

const CAPTION_PRESETS = {
  default: { position: 'bottom', fontSize: 48, fontFamily: 'sans-serif', bold: false, italic: false, color: '#ffffff', outlineColor: '#000000', karaoke: false, karaokeHighlightColor: '#ffd54a' },
  karaoke: { position: 'bottom', fontSize: 52, fontFamily: 'sans-serif', bold: false, italic: false, color: '#ffffff', outlineColor: '#000000', karaoke: true, karaokeHighlightColor: '#ffd54a' },
  bold: { position: 'center', fontSize: 68, fontFamily: 'sans-serif', bold: true, italic: false, color: '#ffffff', outlineColor: '#000000', karaoke: false, karaokeHighlightColor: '#ffd54a' },
};
const EXPORT_PRESETS = {
  draft: { crf: 28, preset: 'veryfast', audioBitrate: '128k' },
  standard: { crf: 20, preset: 'medium', audioBitrate: '192k' },
  high: { crf: 16, preset: 'slow', audioBitrate: '256k' },
};
const SPEED_CURVE_PRESETS = {
  montage: [1, 2, 1],
  slowFocus: [1, 0.5, 1],
  fastSlowFast: [2, 0.5, 2],
};

const waveformCache = new Map();
const waveformLoading = new Set();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let seq = 0;
const state = {
  clips: [],       // see makeClip()
  texts: [],       // { id, text, start, end, position, fontSize, color, outlineColor, fade }
  overlays: [],    // { id, path, url, kind, name, start, end, x, y, scale, opacity, fade, move, keyframes? }
  brolls: [],      // { id, path, url, name, duration, start, end, trimStart, loop, opacity, fade }
  videoTracks: [{ id: 'video-1', name: '视频层 1', visible: true, locked: false }],
  audioTracks: [], // { id, path, name, duration, start, end, trimStart, volume, fadeIn, fadeOut, loop }
  bgm: null,       // { path, name, duration }
  originalVolume: 1,
  bgmVolume: 0.5,
  bgmDuck: false,
  bgmDuckAmount: 0.35,
  loudnessNormalize: false,
  videoTrackLocked: false,
  trackControls: { brollVisible: true, brollLocked: false, overlayVisible: true, overlayLocked: false, textVisible: true, textLocked: false, audioMuted: false, audioLocked: false },
  exportPreset: 'standard',
  aspect: '16:9',
  fillMode: 'pad',
  canvasColor: '#000000',
  outputProfile: '1080p',
  frameRate: 30,
  snapEnabled: true,
  markers: [],      // { id, time } persistent final-timeline markers
  selectedClipId: null,
  selectedTextId: null,
  selectedOverlayId: null,
  selectedBrollId: null,
  selectedVideoTrackId: 'video-1',
  selectedAudioTrackId: null,
  selectedMarkerId: null,
  selectedKeyframeTime: null,
  exportedPath: null,
  projectPath: null,
  missingMedia: [],
};

function makeClip(item) {
  return {
    id: ++seq,
    path: item.path,
    url: item.url,
    proxyUrl: '',
    name: item.name,
    kind: item.kind === 'image' ? 'image' : 'video',
    sourceDuration: item.kind === 'image' ? Math.max(0.1, Number(item.duration) || 3) : item.duration,
    trimStart: 0,
    trimEnd: item.kind === 'image' ? Math.max(0.1, Number(item.duration) || 3) : item.duration,
    hasAudio: !!item.hasAudio,
    speed: 1,
    reverse: false, muted: false, transformKeyframes: [],
    volume: 1, fadeIn: 0, fadeOut: 0, opacity: 1,
    motion: 'none', animationIn: { style: 'none', duration: 0 }, animationOut: { style: 'none', duration: 0 }, stabilize: 'off', effect: 'none', vignette: 0, grain: 0, rotation: 0, mirrorX: false, mirrorY: false, transformScale: 1, transformX: 0, transformY: 0, crop: { left: 0, right: 0, top: 0, bottom: 0 },
    fillMode: '', // '' = follow canvas
    color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0, hue: 0, gamma: 1, curve: 'none', lutPath: '' },
    transitionToNext: { style: 'none', duration: 0 },
  };
}

// ---------------------------------------------------------------------------
// Undo / redo (JSON snapshots of the editable slice)
// ---------------------------------------------------------------------------

const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 60;

/** Only user-editable data is persisted; local media URLs are rebuilt on open. */
function editableProjectState() {
  const copy = JSON.parse(snapshot());
  return copy;
}

function urlForLocalPath(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  return (normalized.startsWith('/') ? 'file://' : 'file:///') + encodeURI(normalized);
}

function restoreProjectState(saved) {
  const data = saved || {};
  Object.assign(state, data, {
    clips: (data.clips || []).map((clip) => {
      const restored = Object.assign({}, clip, { url: urlForLocalPath(clip.path), proxyUrl: '' });
      createProxyForClip(restored);
      return restored;
    }),
    overlays: (data.overlays || []).map((overlay) => Object.assign({}, overlay, { url: urlForLocalPath(overlay.path) })),
    brolls: (data.brolls || []).map((broll) => Object.assign({}, broll, { url: urlForLocalPath(broll.path) })),
    videoTracks: data.videoTracks || [{ id: 'video-1', name: '视频层 1', visible: true, locked: false }],
    audioTracks: data.audioTracks || [], markers: data.markers || [], snapEnabled: data.snapEnabled !== false,
    selectedClipId: null, selectedTextId: null, selectedOverlayId: null, selectedBrollId: null, selectedVideoTrackId: data.selectedVideoTrackId || 'video-1', selectedAudioTrackId: null, selectedMarkerId: null, selectedKeyframeTime: null,
    exportedPath: null,
  });
  undoStack.length = 0;
  redoStack.length = 0;
  normalizeSelections();
}

function snapshot() {
  return JSON.stringify({
    clips: state.clips, texts: state.texts, overlays: state.overlays, brolls: state.brolls, videoTracks: state.videoTracks, selectedVideoTrackId: state.selectedVideoTrackId, audioTracks: state.audioTracks, markers: state.markers,
    bgm: state.bgm, originalVolume: state.originalVolume, bgmVolume: state.bgmVolume,
    bgmDuck: state.bgmDuck, bgmDuckAmount: state.bgmDuckAmount, loudnessNormalize: state.loudnessNormalize, videoTrackLocked: state.videoTrackLocked, trackControls: state.trackControls, exportPreset: state.exportPreset,
    aspect: state.aspect, fillMode: state.fillMode, canvasColor: state.canvasColor, outputProfile: state.outputProfile, frameRate: state.frameRate, snapEnabled: state.snapEnabled,
  });
}
function applySnapshot(s) {
  const o = JSON.parse(s);
  Object.assign(state, o);
  normalizeSelections();
}
function ensureSeqAboveExistingIds() {
  const all = state.clips.concat(state.texts, state.overlays, state.brolls, state.audioTracks, state.markers);
  seq = Math.max(seq, ...all.map((x) => Number(x.id) || 0), 0);
}
function normalizeSelections() {
  ensureSeqAboveExistingIds();
  if (!findClip(state.selectedClipId)) state.selectedClipId = state.clips[0] ? state.clips[0].id : null;
  if (!findText(state.selectedTextId)) state.selectedTextId = state.texts[0] ? state.texts[0].id : null;
  if (!findOverlay(state.selectedOverlayId)) state.selectedOverlayId = state.overlays[0] ? state.overlays[0].id : null;
  if (!findBroll(state.selectedBrollId)) state.selectedBrollId = state.brolls[0] ? state.brolls[0].id : null;
  if (!findAudioTrack(state.selectedAudioTrackId)) state.selectedAudioTrackId = state.audioTracks[0] ? state.audioTracks[0].id : null;
  if (!(state.markers || []).some((marker) => marker.id === state.selectedMarkerId)) state.selectedMarkerId = null;
}
function recordUndo() {
  if (accuratePreviewMode) accuratePreviewDirty = true;
  undoStack.push(snapshot());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  scheduleRecovery();
}
let dragSnap = null;
function beginInteractiveEdit() { dragSnap = snapshot(); }
function commitInteractiveEdit() {
  if (dragSnap != null) {
    undoStack.push(dragSnap);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    dragSnap = null;
    updateHistoryButtons();
    scheduleRecovery();
  }
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  applySnapshot(undoStack.pop());
  setStatus('已撤销');
  renderAll();
  scheduleRecovery();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  applySnapshot(redoStack.pop());
  setStatus('已重做');
  renderAll();
  scheduleRecovery();
}

// ---------------------------------------------------------------------------
// Derived timing
// ---------------------------------------------------------------------------

const rawDur = timeline.rawDuration;
const clipSpeed = timeline.speedOf;
const effDur = timeline.effectiveDuration;

function gapDur(i, clips = state.clips) {
  const c = clips[i];
  if (!c || i >= clips.length - 1) return 0;
  const t = c.transitionToNext || {};
  if (!t.style || t.style === 'none' || t.style === 'cut') return 0;
  const bound = Math.min(effDur(clips[i]), effDur(clips[i + 1])) / 2;
  return Math.min(Number(t.duration) || 0, bound);
}

function totalDuration() {
  let sum = 0;
  for (const c of state.clips) sum += effDur(c);
  for (let i = 0; i < state.clips.length - 1; i++) sum -= gapDur(i);
  return Math.max(0, sum);
}

function outputDimensions(aspect = state.aspect, profile = state.outputProfile) {
  const ratio = ASPECTS[aspect] || ASPECTS['16:9'];
  const longEdge = OUTPUT_PROFILE_LONG_EDGE[profile] || OUTPUT_PROFILE_LONG_EDGE['1080p'];
  const landscape = ratio[0] >= ratio[1];
  const scale = longEdge / (landscape ? ratio[0] : ratio[1]);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return [even(ratio[0] * scale), even(ratio[1] * scale)];
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const els = {
  openProject: $('btnOpenProject'), saveProject: $('btnSaveProject'), packageProject: $('btnPackageProject'), relinkMedia: $('btnRelinkMedia'),
  undo: $('btnUndo'), redo: $('btnRedo'), import: $('btnImport'), insertClip: $('btnInsertClip'), overwriteClip: $('btnOverwriteClip'), rippleDelete: $('btnRippleDelete'), extractAudio: $('btnExtractAudio'), exportPreset: $('exportPreset'), export: $('btnExport'),
  preview: $('previewBox'), canvas: $('previewCanvas'), player: $('player'),
  textLayer: $('textLayer'), brollLayer: $('brollLayer'), overlayLayer: $('overlayLayer'), transformLayer: $('transformLayer'),
  previewEmpty: $('previewEmpty'), play: $('btnPlay'), renderPreview: $('btnRenderPreview'), timeLabel: $('timeLabel'),
  status: $('status'), progressWrap: $('progressWrap'), progress: $('progress'),
  cancel: $('btnCancel'), reveal: $('btnReveal'),
  timelineViewport: $('timelineViewport'), timelineRuler: $('timelineRuler'), timelineTrack: $('timelineTrack'),
  timelinePlayhead: $('timelinePlayhead'), timelineSnapGuide: $('timelineSnapGuide'), timelineZoomOut: $('btnTimelineZoomOut'), timelineZoomIn: $('btnTimelineZoomIn'), timelineFit: $('btnTimelineFit'), timelineZoomLabel: $('timelineZoomLabel'),
  toggleSnap: $('btnToggleSnap'), addMarker: $('btnAddMarker'), prevMarker: $('btnPrevMarker'), nextMarker: $('btnNextMarker'), deleteMarker: $('btnDeleteMarker'), markerName: $('markerName'), timelineTimecode: $('timelineTimecode'),
  videoTrackLane: $('videoTrackLane'), lockVideoTrack: $('btnLockVideoTrack'), brollTrackLane: $('brollTrackLane'), overlayTrackLane: $('overlayTrackLane'), textTrackLane: $('textTrackLane'), toggleBroll: $('btnToggleBroll'), lockBroll: $('btnLockBroll'), toggleOverlay: $('btnToggleOverlay'), lockOverlay: $('btnLockOverlay'), toggleText: $('btnToggleText'), lockText: $('btnLockText'), muteAudio: $('btnMuteAudio'), lockAudio: $('btnLockAudio'),
  clips: $('clips'), timelineEmpty: $('timelineEmpty'), timelineHint: $('timelineHint'),
  // clip inspector
  clipEmpty: $('clipEmpty'), clipInspector: $('clipInspector'), clipTitle: $('clipTitle'), clipName: $('clipName'),
  splitClip: $('btnSplitClip'), duplicateClip: $('btnDuplicateClip'), freezeFrame: $('btnFreezeFrame'), freezeFrameDuration: $('freezeFrameDuration'), toggleClipMute: $('btnToggleClipMute'), copyClipAppearance: $('btnCopyClipAppearance'), pasteClipAppearance: $('btnPasteClipAppearance'),
  removeSilence: $('btnRemoveSilence'), detectBeats: $('btnDetectBeats'), detectScenes: $('btnDetectScenes'), stepBack: $('btnStepBack'), stepForward: $('btnStepForward'),
  trimStart: $('trimStart'), trimEnd: $('trimEnd'), trimStartVal: $('trimStartVal'), imageDurationField: $('imageDurationField'), imageDuration: $('imageDuration'),
  trimEndVal: $('trimEndVal'), trimDurationVal: $('trimDurationVal'),
  speed: $('speed'), speedVal: $('speedVal'), speedChips: $('speedChips'), speedCurvePreset: $('speedCurvePreset'), applySpeedCurve: $('btnApplySpeedCurve'), clipVolume: $('clipVolume'), clipVolumeVal: $('clipVolumeVal'), clipFadeIn: $('clipFadeIn'), clipFadeOut: $('clipFadeOut'),
  reverse: $('reverse'), motion: $('motion'), animationInStyle: $('animationInStyle'), animationInDuration: $('animationInDuration'), animationOutStyle: $('animationOutStyle'), animationOutDuration: $('animationOutDuration'), stabilize: $('stabilize'), clipFill: $('clipFill'), clipMirrorX: $('clipMirrorX'), clipMirrorY: $('clipMirrorY'), clipRotation: $('clipRotation'), clipRotationVal: $('clipRotationVal'), clipCropLeft: $('clipCropLeft'), clipCropRight: $('clipCropRight'), clipCropTop: $('clipCropTop'), clipCropBottom: $('clipCropBottom'), clipOpacity: $('clipOpacity'), clipOpacityVal: $('clipOpacityVal'), clipTransformScale: $('clipTransformScale'), clipTransformScaleVal: $('clipTransformScaleVal'), clipTransformX: $('clipTransformX'), clipTransformY: $('clipTransformY'), clipTransformKeyframeTime: $('clipTransformKeyframeTime'), clipTransformKeyframeCurve: $('clipTransformKeyframeCurve'), addClipTransformKeyframe: $('btnAddClipTransformKeyframe'), clipTransformKeyframeList: $('clipTransformKeyframeList'),
  brightness: $('brightness'), briVal: $('briVal'), contrast: $('contrast'), conVal: $('conVal'),
  saturation: $('saturation'), satVal: $('satVal'), temperature: $('temperature'), tempVal: $('tempVal'),
  hue: $('hue'), hueVal: $('hueVal'), gamma: $('gamma'), gammaVal: $('gammaVal'), colorCurve: $('colorCurve'), pickLut: $('btnPickLut'), clearLut: $('btnClearLut'), lutName: $('lutName'),
  colorPresets: $('colorPresets'), effectPresets: $('effectPresets'), vignette: $('vignette'), vignetteVal: $('vignetteVal'), grain: $('grain'), grainVal: $('grainVal'),
  transStyle: $('transStyle'), transDur: $('transDur'), transDurVal: $('transDurVal'), transitionField: $('transitionField'),
  // canvas
  aspectChips: $('aspectChips'), fillMode: $('fillMode'), canvasColor: $('canvasColor'), outputProfile: $('outputProfile'), frameRate: $('frameRate'), canvasInfo: $('canvasInfo'),
  // text
  addText: $('btnAddText'), autoSub: $('btnAutoSub'), autoSubAll: $('btnAutoSubAll'), autoSubHint: $('autoSubHint'),
  importSrt: $('btnImportSrt'), exportSrt: $('btnExportSrt'),
  captionPreset: $('captionPreset'), applyCaptionPreset: $('btnApplyCaptionPreset'),
  captionFind: $('captionFind'), captionReplace: $('captionReplace'), replaceCaptions: $('btnReplaceCaptions'),
  textList: $('textList'), textEditor: $('textEditor'), textContent: $('textContent'), textSecondary: $('textSecondary'),
  textStart: $('textStart'), textEnd: $('textEnd'), textPos: $('textPos'), textSize: $('textSize'), textXPercent: $('textXPercent'), textYPercent: $('textYPercent'), resetTextPosition: $('btnResetTextPosition'), textFontFamily: $('textFontFamily'), textBold: $('textBold'), textItalic: $('textItalic'),
  textColor: $('textColor'), textOutline: $('textOutline'), textFade: $('textFade'), textOutlineWidth: $('textOutlineWidth'), textShadow: $('textShadow'), textSpacing: $('textSpacing'), textOpacity: $('textOpacity'), textOpacityVal: $('textOpacityVal'), textKaraoke: $('textKaraoke'), textHighlightColor: $('textHighlightColor'), splitCaption: $('btnSplitCaption'), mergeCaption: $('btnMergeCaption'), deleteText: $('btnDeleteText'),
  // overlay
  addOverlay: $('btnAddOverlay'), overlayList: $('overlayList'), overlayEditor: $('overlayEditor'),
  overlayName: $('overlayName'), ovStart: $('ovStart'), ovEnd: $('ovEnd'),
  overlayLayerUp: $('btnOverlayLayerUp'), overlayLayerDown: $('btnOverlayLayerDown'),
  ovScale: $('ovScale'), ovScaleVal: $('ovScaleVal'), ovX: $('ovX'), ovY: $('ovY'),
  ovOpacity: $('ovOpacity'), ovOpacityVal: $('ovOpacityVal'), ovFade: $('ovFade'),
  ovRotation: $('ovRotation'), ovRotationVal: $('ovRotationVal'),
  ovMirrorX: $('ovMirrorX'), ovMirrorY: $('ovMirrorY'), ovMask: $('ovMask'), ovMaskInvert: $('ovMaskInvert'), ovMaskFeather: $('ovMaskFeather'),
  ovCropLeft: $('ovCropLeft'), ovCropRight: $('ovCropRight'), ovCropTop: $('ovCropTop'), ovCropBottom: $('ovCropBottom'),
  ovBlendMode: $('ovBlendMode'), ovChromaEnabled: $('ovChromaEnabled'), ovChromaColor: $('ovChromaColor'), ovChromaSimilarity: $('ovChromaSimilarity'),
  ovMoveEnable: $('ovMoveEnable'), ovMoveX: $('ovMoveX'), ovMoveY: $('ovMoveY'), deleteOverlay: $('btnDeleteOverlay'),
  keyframeNewTime: $('keyframeNewTime'), addKeyframe: $('btnAddKeyframe'), keyframeList: $('keyframeList'),
  keyframeEditor: $('keyframeEditor'), kfTime: $('kfTime'), kfCurve: $('kfCurve'), kfBezierControls: $('kfBezierControls'), kfBezierX1: $('kfBezierX1'), kfBezierY1: $('kfBezierY1'), kfBezierX2: $('kfBezierX2'), kfBezierY2: $('kfBezierY2'),
  kfX: $('kfX'), kfY: $('kfY'), kfScale: $('kfScale'), kfOpacity: $('kfOpacity'), kfRotation: $('kfRotation'), deleteKeyframe: $('btnDeleteKeyframe'),
  // B-roll
  addBroll: $('btnAddBroll'), brollList: $('brollList'), brollEditor: $('brollEditor'), brollName: $('brollName'),
  brollLayerUp: $('btnBrollLayerUp'), brollLayerDown: $('btnBrollLayerDown'),
  addVideoTrack: $('btnAddVideoTrack'), videoTrackSelect: $('videoTrackSelect'), videoTrackUp: $('btnVideoTrackUp'), videoTrackDown: $('btnVideoTrackDown'), toggleVideoTrack: $('btnToggleVideoTrack'), lockVideoLayerTrack: $('btnLockVideoLayerTrack'), deleteVideoTrack: $('btnDeleteVideoTrack'), brollTrackSelect: $('brollTrackSelect'),
  brollStart: $('brollStart'), brollEnd: $('brollEnd'), brollTrimStart: $('brollTrimStart'), brollLoop: $('brollLoop'),
  brollOpacity: $('brollOpacity'), brollOpacityVal: $('brollOpacityVal'), brollRotation: $('brollRotation'), brollRotationVal: $('brollRotationVal'), brollFade: $('brollFade'), deleteBroll: $('btnDeleteBroll'),
  // audio
  music: $('btnMusic'), removeMusic: $('btnRemoveMusic'), musicName: $('musicName'),
  volumeRow: $('volumeRow'), volOriginal: $('volOriginal'), volOriginalVal: $('volOriginalVal'),
  volBgm: $('volBgm'), volBgmVal: $('volBgmVal'),
  bgmDuck: $('bgmDuck'), bgmDuckControls: $('bgmDuckControls'), bgmDuckAmount: $('bgmDuckAmount'), bgmDuckAmountVal: $('bgmDuckAmountVal'), bgmClipControls: $('bgmClipControls'), bgmTrimStart: $('bgmTrimStart'), bgmFadeIn: $('bgmFadeIn'), bgmFadeOut: $('bgmFadeOut'), loudnessNormalize: $('loudnessNormalize'),
  addAudioTrack: $('btnAddAudioTrack'), recordVoice: $('btnRecordVoice'), stopVoice: $('btnStopVoice'), voiceRecordStatus: $('voiceRecordStatus'), audioTrackList: $('audioTrackList'), audioTrackEditor: $('audioTrackEditor'), audioTrackName: $('audioTrackName'),
  audioTrackStart: $('audioTrackStart'), audioTrackEnd: $('audioTrackEnd'), audioTrackTrimStart: $('audioTrackTrimStart'), audioTrackLoop: $('audioTrackLoop'),
  splitAudioTrack: $('btnSplitAudioTrack'), audioTrackVolume: $('audioTrackVolume'), audioTrackVolumeVal: $('audioTrackVolumeVal'), audioTrackFadeIn: $('audioTrackFadeIn'), audioTrackFadeOut: $('audioTrackFadeOut'), addAudioMute: $('btnAddAudioMute'), audioMuteList: $('audioMuteList'), deleteAudioTrack: $('btnDeleteAudioTrack'),
  audioTrackDenoise: $('audioTrackDenoise'), audioTrackVoiceEnhance: $('audioTrackVoiceEnhance'), audioTrackSpeed: $('audioTrackSpeed'), audioTrackPitch: $('audioTrackPitch'),
  audioTrackLane: $('audioTrackLane'),
};

function setStatus(m) {
  els.status.dataset.sourceText = String(m);
  els.status.textContent = i18n.t(m);
}

let recoveryTimer = null;
let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceStartedAt = 0;
let voiceInsertAt = 0;
let voiceUiTimer = null;
let voiceBusy = false;

function setVoiceRecordingUi(message) {
  const recording = !!voiceRecorder && voiceRecorder.state !== 'inactive';
  els.recordVoice.disabled = recording || voiceBusy;
  els.stopVoice.classList.toggle('hidden', !recording);
  els.stopVoice.disabled = !recording;
  if (message) els.voiceRecordStatus.textContent = message;
  else if (recording) {
    const seconds = Math.max(0, (Date.now() - voiceStartedAt) / 1000);
    els.voiceRecordStatus.textContent = '正在录制旁白 ' + seconds.toFixed(1) + ' 秒；停止后会从 ' + voiceInsertAt.toFixed(1) + ' 秒插入。';
  } else if (!voiceBusy) {
    els.voiceRecordStatus.textContent = '录音会从当前播放头位置插入时间线。';
  }
}

function releaseVoiceStream() {
  if (voiceStream) voiceStream.getTracks().forEach((track) => track.stop());
  voiceStream = null;
}

function audioTrackFromMedia(media, start, name) {
  const duration = Math.max(0.1, Number(media.duration) || 0.1);
  return {
    id: ++seq, path: media.path, name: name || media.name, duration,
    start, end: start + duration, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0, loop: false,
  };
}

function supportedRecordingOptions() {
  if (typeof MediaRecorder === 'undefined') return null;
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const mimeType = types.find((type) => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type));
  return mimeType ? { mimeType } : {};
}

async function startVoiceRecording() {
  if (voiceRecorder || voiceBusy) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined' || !api.saveRecording) {
    setVoiceRecordingUi('当前运行环境不支持麦克风录音。');
    return;
  }
  voiceBusy = true;
  setVoiceRecordingUi('正在请求麦克风权限…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
    const options = supportedRecordingOptions();
    if (!options) throw new Error('浏览器不支持录音编码器');
    const recorder = new MediaRecorder(stream, options);
    voiceStream = stream;
    voiceRecorder = recorder;
    voiceChunks = [];
    voiceInsertAt = Math.max(0, Math.min(totalDuration(), playheadTime));
    voiceStartedAt = Date.now();
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) voiceChunks.push(event.data);
    });
    recorder.addEventListener('error', () => {
      setVoiceRecordingUi('录音设备出错，请重新开始录制。');
    });
    recorder.addEventListener('stop', finishVoiceRecording, { once: true });
    recorder.start(250);
    if (voiceUiTimer) clearInterval(voiceUiTimer);
    voiceUiTimer = setInterval(() => setVoiceRecordingUi(), 200);
    setStatus('正在录制旁白…');
    setVoiceRecordingUi();
  } catch (e) {
    releaseVoiceStream();
    setVoiceRecordingUi('无法开始录音：' + (e && e.message ? e.message : String(e)));
  } finally {
    voiceBusy = false;
    if (!voiceRecorder) setVoiceRecordingUi();
  }
}

async function finishVoiceRecording() {
  const recorder = voiceRecorder;
  const chunks = voiceChunks;
  const startedAt = voiceStartedAt;
  voiceRecorder = null;
  voiceChunks = [];
  voiceStartedAt = 0;
  if (voiceUiTimer) clearInterval(voiceUiTimer);
  voiceUiTimer = null;
  releaseVoiceStream();
  if (!chunks.length) { setVoiceRecordingUi('未检测到有效录音。'); return; }
  voiceBusy = true;
  setVoiceRecordingUi('正在保存旁白…');
  try {
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    const data = await blob.arrayBuffer();
    const res = await api.saveRecording({ data, mimeType: blob.type });
    if (!res || !res.ok) throw new Error((res && res.error) || '保存录音失败');
    recordUndo();
    const track = audioTrackFromMedia(res, voiceInsertAt, '旁白 ' + new Date(startedAt).toLocaleTimeString());
    state.audioTracks.push(track);
    state.selectedAudioTrackId = track.id;
    activeTimelineItem = { type: 'audio', id: track.id };
    setStatus('旁白已添加到时间线：' + track.name);
    renderAll();
    setVoiceRecordingUi('旁白已保存并从 ' + voiceInsertAt.toFixed(1) + ' 秒插入时间线。');
  } catch (e) {
    const message = '保存旁白失败：' + (e && e.message ? e.message : String(e));
    setStatus(message);
    setVoiceRecordingUi(message);
  } finally {
    voiceBusy = false;
    if (!voiceRecorder) setVoiceRecordingUi();
  }
}

function stopVoiceRecording() {
  if (!voiceRecorder || voiceRecorder.state === 'inactive') return;
  setVoiceRecordingUi('正在结束录音…');
  voiceRecorder.stop();
}

function hasEditableContent() {
  return state.clips.length > 0 || state.texts.length > 0 || state.overlays.length > 0 || state.brolls.length > 0 || state.audioTracks.length > 0 || state.markers.length > 0 || !!state.bgm;
}
function scheduleRecovery() {
  if (!api.saveRecovery) return;
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (!hasEditableContent()) {
      api.clearRecovery && api.clearRecovery().catch(() => {});
      return;
    }
    api.saveRecovery(editableProjectState()).catch(() => {});
  }, 500);
}
function updateProjectChrome() {
  const label = state.projectPath ? state.projectPath.split(/[\\/]/).pop() : '未命名工程';
  document.title = label + ' — MiniClip';
  els.saveProject.disabled = !hasEditableContent();
  els.packageProject.disabled = !hasEditableContent();
  els.relinkMedia.classList.toggle('hidden', !state.missingMedia.length);
  els.relinkMedia.textContent = state.missingMedia.length ? `重新链接素材（${state.missingMedia.length}）` : '重新链接素材';
}
const findClip = (id) => state.clips.find((c) => c.id === id);
const findText = (id) => state.texts.find((t) => t.id === id);
const findOverlay = (id) => state.overlays.find((o) => o.id === id);
const findBroll = (id) => state.brolls.find((broll) => broll.id === id);
const findVideoTrack = (id) => state.videoTracks.find((track) => track.id === id);
function orderedVisibleBrolls() {
  return state.videoTracks.flatMap((track) => track.visible === false ? [] : state.brolls.filter((broll) => broll.trackId === track.id));
}
const findAudioTrack = (id) => state.audioTracks.find((track) => track.id === id);
let activeTimelineItem = { type: 'clip', id: null };
function activateTimelineItem(type, id) {
  activeTimelineItem = { type, id };
  state.selectedMarkerId = null;
  if (type === 'clip') state.selectedClipId = id;
  else if (type === 'text') state.selectedTextId = id;
  else if (type === 'overlay') { state.selectedOverlayId = id; state.selectedKeyframeTime = null; }
  else if (type === 'broll') state.selectedBrollId = id;
  else if (type === 'audio') state.selectedAudioTrackId = id;
}
function activeTimedItem() {
  if (activeTimelineItem.type === 'text') return findText(activeTimelineItem.id);
  if (activeTimelineItem.type === 'overlay') return findOverlay(activeTimelineItem.id);
  if (activeTimelineItem.type === 'broll') return findBroll(activeTimelineItem.id);
  if (activeTimelineItem.type === 'audio') return findAudioTrack(activeTimelineItem.id);
  return null;
}
function selectedKeyframe(o) {
  if (!o || state.selectedKeyframeTime == null) return null;
  return keyframe.normaliseKeyframes(o).find((f) => f.time === state.selectedKeyframeTime) || null;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function importVideos() {
  const res = await api.pickVideos();
  if (res.canceled || !res.items.length) return;
  recordUndo();
  let added = 0;
  const errs = [];
  for (const item of res.items) {
    if (item.error) { errs.push(`${item.name}: ${item.error}`); continue; }
    state.clips.push(makeClip(item));
    createProxyForClip(state.clips[state.clips.length - 1]);
    added++;
  }
  if (!added) { undoStack.pop(); if (errs.length) setStatus('导入失败：' + errs[0]); return; }
  if (!state.selectedClipId) state.selectedClipId = state.clips[state.clips.length - 1].id;
  setStatus(errs.length ? `已添加 ${added} 段，${errs.length} 个失败` : `已添加 ${state.clips.length} 段视频`);
  renderAll();
}

function createProxyForClip(clip) {
  if (!clip || !clip.path) return;
  const create = clip.kind === 'image' ? api.createImageProxy : api.createProxy;
  if (!create) return;
  const request = clip.kind === 'image' ? { path: clip.path, duration: rawDur(clip) } : clip.path;
  create(request).then((res) => {
    if (res && res.ok) clip.proxyUrl = res.url;
  }).catch(() => {});
}

async function saveProject() {
  if (!hasEditableContent()) return;
  const res = await api.saveProject({ path: state.projectPath || undefined, state: editableProjectState() });
  if (res.canceled) return;
  if (res.error) { setStatus('保存工程失败：' + res.error); return; }
  state.projectPath = res.path;
  api.clearRecovery && api.clearRecovery().catch(() => {});
  updateProjectChrome();
  setStatus('工程已保存：' + res.path.split(/[\\/]/).pop());
}

async function packageProject() {
  if (!hasEditableContent() || !api.packageProject) return;
  els.packageProject.disabled = true;
  setStatus('正在收集素材并打包工程…');
  try {
    const res = await api.packageProject(editableProjectState());
    if (res.canceled) return;
    if (res.error) { setStatus('打包工程失败：' + res.error); return; }
    setStatus(`工程包已创建：${res.projectPath}（已收集 ${res.mediaCount || 0} 个媒体）`);
  } catch (e) {
    setStatus('打包工程出错：' + (e && e.message ? e.message : String(e)));
  } finally {
    updateProjectChrome();
  }
}

async function openProject() {
  const res = await api.openProject();
  if (res.canceled) return;
  if (res.error) { setStatus('打开工程失败：' + res.error); return; }
  stopPreview();
  restoreProjectState(res.state);
  state.projectPath = res.path;
  api.clearRecovery && api.clearRecovery().catch(() => {});
  renderAll();
  state.missingMedia = Array.isArray(res.missingMedia) ? res.missingMedia.map((path) => ({ path })) : [];
  const missing = state.missingMedia.length;
  setStatus(missing
    ? '已打开工程，但有 ' + missing + ' 个素材路径失效；请恢复素材后再导出。'
    : '已打开工程：' + res.path.split(/[\\/]/).pop());
}

function mediaReferencesForPath(path) {
  const refs = [];
  state.clips.forEach((item) => { if (item.path === path) refs.push({ kind: item.kind === 'image' ? 'image' : 'video', item }); });
  state.brolls.forEach((item) => { if (item.path === path) refs.push({ kind: 'video', item }); });
  state.overlays.forEach((item) => { if (item.path === path) refs.push({ kind: item.kind === 'image' ? 'image' : 'video', item }); });
  state.audioTracks.forEach((item) => { if (item.path === path) refs.push({ kind: 'audio', item }); });
  if (state.bgm && state.bgm.path === path) refs.push({ kind: 'audio', item: state.bgm });
  state.clips.forEach((item) => { if (item.color && item.color.lutPath === path) refs.push({ kind: 'lut', item }); });
  return refs;
}

async function relinkMissingMedia() {
  if (!state.missingMedia.length) return;
  const missing = state.missingMedia[0];
  const refs = mediaReferencesForPath(missing.path);
  const kind = refs[0] ? refs[0].kind : 'video';
  const res = await api.relinkMedia({ kind });
  if (res.canceled) return;
  if (res.error) { setStatus('重新链接失败：' + res.error); return; }
  recordUndo();
  refs.forEach((ref) => {
    if (ref.kind === 'lut') { ref.item.color.lutPath = res.path; return; }
    ref.item.path = res.path; ref.item.name = res.name || ref.item.name;
    if (ref.kind !== 'audio') ref.item.url = res.url;
    if (ref.kind === 'video' && ref.item.sourceDuration != null && res.duration > 0) {
      ref.item.sourceDuration = res.duration;
      ref.item.trimStart = Math.min(ref.item.trimStart || 0, Math.max(0, res.duration - 0.1));
      ref.item.trimEnd = Math.min(Math.max(ref.item.trimEnd || res.duration, ref.item.trimStart + 0.1), res.duration);
      ref.item.hasAudio = !!res.hasAudio;
      createProxyForClip(ref.item);
    }
    if (ref.kind === 'image' && ref.item.kind === 'image') createProxyForClip(ref.item);
    if (ref.kind === 'audio' && res.duration > 0) ref.item.duration = res.duration;
  });
  state.missingMedia.shift();
  setStatus(state.missingMedia.length ? `已重新链接，仍有 ${state.missingMedia.length} 个素材待处理` : '所有缺失素材已重新链接');
  renderAll();
}

async function restoreRecovery() {
  if (!api.loadRecovery) return;
  try {
    const res = await api.loadRecovery();
    if (!res || !res.found || !res.state || !hasRestorableContent(res.state)) return;
    restoreProjectState(res.state);
    renderAll();
    setStatus('已恢复上次未保存的编辑内容');
  } catch {}
}

function hasRestorableContent(saved) {
  return !!saved && ((saved.clips && saved.clips.length) || (saved.texts && saved.texts.length) || (saved.overlays && saved.overlays.length) || (saved.brolls && saved.brolls.length) || (saved.audioTracks && saved.audioTracks.length) || saved.bgm);
}

async function pickMusic() {
  const res = await api.pickAudio();
  if (res.canceled) return;
  if (res.error) { setStatus('音乐读取失败：' + res.error); return; }
  recordUndo();
  state.bgm = { path: res.path, name: res.name, duration: res.duration, trimStart: 0, fadeIn: 0, fadeOut: 0 };
  setStatus('已添加背景音乐：' + res.name);
  renderAll();
}

async function addAudioTrack() {
  const res = await api.pickAudio({ title: '添加独立音频片段' });
  if (res.canceled) return;
  if (res.error) { setStatus('音频读取失败：' + res.error); return; }
  recordUndo();
  const total = totalDuration();
  const start = Math.max(0, Math.min(total, playheadTime));
  const track = audioTrackFromMedia(res, start);
  state.audioTracks.push(track);
  state.selectedAudioTrackId = track.id;
  activeTimelineItem = { type: 'audio', id: track.id };
  setStatus('已添加独立音频：' + res.name);
  renderAll();
}
function removeMusic() {
  if (!state.bgm) return;
  recordUndo();
  state.bgm = null;
  setStatus('已移除背景音乐');
  renderAll();
}

async function addOverlay() {
  const res = await api.pickOverlayMedia();
  if (res.canceled) return;
  recordUndo();
  const ov = {
    id: ++seq, path: res.path, url: res.url, kind: res.kind, name: res.name,
    start: 0, end: Math.min(3, totalDuration() || 3),
    x: 40, y: 40, scale: 0.4, opacity: 1, rotation: 0, fade: 0,
    mirrorX: false, mirrorY: false, crop: { left: 0, right: 0, top: 0, bottom: 0 },
    mask: 'none', maskInvert: false, maskFeather: 0, chromaKey: { enabled: false, color: '#00ff00', similarity: 0.1, blend: 0 }, blendMode: 'normal',
    move: null, _w: res.width || 0, _h: res.height || 0,
  };
  state.overlays.push(ov);
  state.selectedOverlayId = ov.id;
  activeTimelineItem = { type: 'overlay', id: ov.id };
  state.selectedKeyframeTime = null;
  setStatus('已添加叠加素材：' + res.name);
  renderAll();
}

async function addBroll() {
  const res = await api.pickOverlayMedia();
  if (res.canceled) return;
  if (res.kind !== 'video') { setStatus('视频层只接受视频素材'); return; }
  recordUndo();
  const start = Math.max(0, Math.min(totalDuration(), playheadTime));
  const duration = Math.max(0.1, Number(res.duration) || 3);
  const broll = {
    id: ++seq, path: res.path, url: res.url, name: res.name, duration,
    trackId: state.selectedVideoTrackId || 'video-1', start, end: start + duration, trimStart: 0, loop: true, x: 0, y: 0, scale: 1, opacity: 1, rotation: 0, fade: 0,
  };
  state.brolls.push(broll);
  state.selectedBrollId = broll.id;
  activeTimelineItem = { type: 'broll', id: broll.id };
  setStatus('已添加视频层：' + res.name);
  renderAll();
}

// ---------------------------------------------------------------------------
// Auto subtitle (whisper)
// ---------------------------------------------------------------------------

async function autoSubtitle() {
  if (!state.clips.length) { setStatus('请先导入视频'); return; }
  const clip = findClip(state.selectedClipId) || state.clips[0];
  if (clip.kind === 'image' || !clip.hasAudio) { setStatus('静态图片没有可识别的语音'); return; }
  setSubtitleBusy(true);
  setStatus('正在识别语音…（首次需要模型，可能较慢）');
  const unsub = api.onTranscribeProgress((p) => { setStatus(`识别中… ${Math.round(p * 100)}%`); });
  try {
    const result = await transcribeClipToCaptions(clip);
    if (!result.items.length) { setStatus('未识别到语音'); return; }
    recordUndo();
    appendCaptionItems(result.items);
    setStatus(`已生成 ${result.items.length} 条字幕（模型 ${result.model}）`);
    renderAll();
  } catch (e) {
    setStatus('自动字幕出错：' + (e && e.message ? e.message : String(e)));
  } finally {
    unsub();
    setSubtitleBusy(false);
  }
}

function setSubtitleBusy(busy) {
  els.autoSub.disabled = busy;
  els.autoSubAll.disabled = busy;
}

async function transcribeClipToCaptions(clip) {
  const res = await api.transcribe({
    input: clip.path, language: 'auto', start: clip.trimStart, end: clip.trimEnd,
  });
  if (res.error) throw new Error(res.error.split('\n')[0]);
  const base = clipStartOnTimeline(clip.id);
  return { model: res.model, items: mapSourceSubtitlesToClip(res.overlays || [], clip, base) };
}

function appendCaptionItems(items) {
  for (const item of items || []) {
    state.texts.push({
      id: ++seq, text: item.text, start: item.start, end: item.end,
      position: 'bottom', fontSize: 48, color: '#ffffff', outlineColor: '#000000',
      karaoke: false, karaokeHighlightColor: '#ffd54a', words: item.words || [], isCaption: true, fade: 0,
    });
  }
  if (items && items.length) {
    state.selectedTextId = state.texts[state.texts.length - 1].id;
    activateTimelineItem('text', state.selectedTextId);
  }
}

async function autoSubtitleAll() {
  if (!state.clips.length) { setStatus('请先导入视频'); return; }
  setSubtitleBusy(true);
  let current = 0;
  const candidates = state.clips.filter((clip) => clip.kind !== 'image' && clip.hasAudio);
  if (!candidates.length) { setStatus('工程中没有可识别语音的视频片段'); return; }
  const total = candidates.length;
  const unsub = api.onTranscribeProgress((p) => {
    setStatus(`识别第 ${current + 1}/${total} 段… ${Math.round(p * 100)}%`);
  });
  try {
    const all = [];
    let model = '';
    for (current = 0; current < total; current++) {
      setStatus(`准备识别第 ${current + 1}/${total} 段…`);
      const result = await transcribeClipToCaptions(candidates[current]);
      all.push(...result.items);
      model = result.model || model;
    }
    if (!all.length) { setStatus('所有片段均未识别到语音'); return; }
    recordUndo();
    appendCaptionItems(all);
    setStatus(`已生成 ${all.length} 条字幕（${total} 段，模型 ${model || 'local'}）`);
    renderAll();
  } catch (e) {
    setStatus(`全片自动字幕在第 ${Math.min(total, current + 1)}/${total} 段失败：${e && e.message ? e.message : String(e)}`);
  } finally {
    unsub();
    setSubtitleBusy(false);
  }
}

function applyCaptionPreset() {
  const preset = CAPTION_PRESETS[els.captionPreset.value] || CAPTION_PRESETS.default;
  const captions = state.texts.filter((text) => text.isCaption);
  if (!captions.length) { setStatus('还没有自动字幕或导入字幕'); return; }
  recordUndo();
  captions.forEach((text) => Object.assign(text, preset));
  setStatus(`已将「${els.captionPreset.options[els.captionPreset.selectedIndex].textContent}」应用到 ${captions.length} 条字幕`);
  renderAll();
}

function replaceCaptions() {
  const find = els.captionFind.value;
  if (!find) { setStatus('请输入要查找的字幕内容'); return; }
  const captions = state.texts.filter((text) => text.isCaption && text.text.includes(find));
  if (!captions.length) { setStatus('没有匹配的字幕'); return; }
  recordUndo();
  captions.forEach((text) => { text.text = text.text.split(find).join(els.captionReplace.value); });
  setStatus(`已替换 ${captions.length} 条字幕`);
  renderAll();
}

function splitSelectedCaption() {
  const text = findText(state.selectedTextId);
  if (!text || !text.isCaption) { setStatus('请先选择一条字幕'); return; }
  const at = playheadTime;
  if (!(at > text.start + 0.05 && at < text.end - 0.05)) { setStatus('播放头需位于字幕条内部'); return; }
  const chars = Array.from(text.text || '');
  let index = Math.max(1, Math.min(chars.length - 1, Math.round((at - text.start) / (text.end - text.start) * chars.length)));
  const words = Array.isArray(text.words) ? text.words : [];
  const wordIndex = words.findIndex((word) => word.start >= at);
  if (wordIndex > 0) {
    const before = words.slice(0, wordIndex).map((word) => word.text).join('');
    if (before) index = Math.max(1, Math.min(chars.length - 1, Array.from(before).length));
  }
  const leftText = chars.slice(0, index).join('').trim();
  const rightText = chars.slice(index).join('').trim();
  if (!leftText || !rightText) { setStatus('无法在当前位置拆分字幕'); return; }
  const ratio = index / chars.length;
  const secondary = Array.from(text.secondaryText || '');
  const leftSecondary = secondary.length ? secondary.slice(0, Math.round(secondary.length * ratio)).join('').trim() : '';
  const rightSecondary = secondary.length ? secondary.slice(Math.round(secondary.length * ratio)).join('').trim() : '';
  const leftWords = words.filter((word) => word.end <= at);
  const rightWords = words.filter((word) => word.start >= at);
  recordUndo();
  const right = Object.assign({}, text, { id: ++seq, text: rightText, secondaryText: rightSecondary, start: at, words: rightWords });
  text.text = leftText; text.secondaryText = leftSecondary; text.end = at; text.words = leftWords;
  const pos = state.texts.findIndex((item) => item.id === text.id);
  state.texts.splice(pos + 1, 0, right);
  activateTimelineItem('text', right.id);
  setStatus('已在播放头拆分字幕');
  renderAll();
}

function mergeSelectedCaption() {
  const text = findText(state.selectedTextId);
  if (!text || !text.isCaption) { setStatus('请先选择一条字幕'); return; }
  const sorted = state.texts.filter((item) => item.isCaption).sort((a, b) => a.start - b.start);
  const index = sorted.findIndex((item) => item.id === text.id);
  const next = sorted[index + 1];
  if (!next) { setStatus('没有可合并的下一条字幕'); return; }
  recordUndo();
  text.text = (text.text + ' ' + next.text).replace(/\s+/g, ' ').trim();
  text.secondaryText = [text.secondaryText, next.secondaryText].filter(Boolean).join(' ').trim();
  text.end = Math.max(text.end, next.end);
  text.words = (text.words || []).concat(next.words || []);
  state.texts = state.texts.filter((item) => item.id !== next.id);
  setStatus('已合并下一条字幕');
  renderAll();
}

async function importSrt() {
  const res = await api.importSrt();
  if (res.canceled) return;
  if (res.error) { setStatus('导入 SRT 失败：' + res.error); return; }
  recordUndo();
  for (const item of res.items || []) {
    state.texts.push({
      id: ++seq, text: item.text, start: item.start, end: item.end,
      position: 'bottom', fontSize: 48, color: '#ffffff', outlineColor: '#000000',
      karaoke: false, karaokeHighlightColor: '#ffd54a', words: item.words || [], isCaption: true, fade: 0,
    });
  }
  state.selectedTextId = state.texts.length ? state.texts[state.texts.length - 1].id : null;
  setStatus('已导入 ' + (res.items || []).length + ' 条 SRT 字幕');
  renderAll();
}

async function exportSrt() {
  const items = state.texts.map((text) => ({ text: [text.text, text.secondaryText].filter(Boolean).join('\n'), start: text.start, end: text.end }));
  if (!items.length) { setStatus('没有可导出的文字或字幕'); return; }
  const res = await api.exportSrt(items);
  if (res.canceled) return;
  if (res.error) { setStatus('导出 SRT 失败：' + res.error); return; }
  setStatus('SRT 已导出：' + res.path.split(/[\/]/).pop());
}

/** Map source-file Whisper timestamps through trim, speed and reverse. */
const mapSourceSubtitlesToClip = timeline.mapSourceSubtitlesToClip;

function clipStartOnTimeline(id) {
  let t = 0;
  for (let i = 0; i < state.clips.length; i++) {
    if (state.clips[i].id === id) return t;
    t += effDur(state.clips[i]) - gapDur(i);
  }
  return 0;
}

function retimeItemsForSpeedCurve(items, originalStart, sourceDuration, oldEffectiveDuration, oldSpeed, speeds, newEffectiveDuration) {
  for (const item of items) {
    if (item.end <= originalStart || item.start >= originalStart + oldEffectiveDuration) continue;
    const tailDuration = Math.max(0, item.end - (originalStart + oldEffectiveDuration));
    const start = Math.max(originalStart, item.start);
    const end = Math.min(originalStart + oldEffectiveDuration, item.end);
    const mappedStart = timeline.mapSpeedCurveTimelineTime(start, originalStart, sourceDuration, oldSpeed, speeds);
    const mappedEnd = timeline.mapSpeedCurveTimelineTime(end, originalStart, sourceDuration, oldSpeed, speeds);
    item.start = item.start < originalStart ? item.start : mappedStart;
    item.end = item.end > originalStart + oldEffectiveDuration
      ? originalStart + newEffectiveDuration + tailDuration
      : Math.max(item.start + 0.05, mappedEnd);
    if (Array.isArray(item.words)) {
      item.words = item.words.map((word) => {
        const copy = Object.assign({}, word);
        if (copy.start >= originalStart && copy.start <= originalStart + oldEffectiveDuration) {
          copy.start = timeline.mapSpeedCurveTimelineTime(copy.start, originalStart, sourceDuration, oldSpeed, speeds);
        }
        if (copy.end >= originalStart && copy.end <= originalStart + oldEffectiveDuration) {
          copy.end = timeline.mapSpeedCurveTimelineTime(copy.end, originalStart, sourceDuration, oldSpeed, speeds);
        }
        return copy;
      });
    }
  }
}

function distributeClipTransformKeyframesForSpeedCurve(clip, pieces) {
  if (!clipTransform || !Array.isArray(clip.transformKeyframes) || !clip.transformKeyframes.length) return;
  const frames = clipTransform.normalise(clip);
  const oldDuration = clipTransform.durationOf(clip);
  const count = pieces.length;
  pieces.forEach((piece, index) => {
    const from = oldDuration * index / count;
    const to = oldDuration * (index + 1) / count;
    const targetDuration = effDur(piece);
    const startValues = clipTransform.valuesAt(clip, from);
    const endValues = clipTransform.valuesAt(clip, to);
    const distributed = [clipTransform.frameFrom(startValues, 0, 'linear')];
    frames.filter((frame) => frame.time > from + 0.000001 && frame.time < to - 0.000001).forEach((frame) => {
      distributed.push(Object.assign({}, frame, { time: (frame.time - from) / Math.max(0.000001, to - from) * targetDuration }));
    });
    distributed.push(clipTransform.frameFrom(endValues, targetDuration, 'linear'));
    piece.transformKeyframes = distributed;
  });
}

function applySpeedCurvePreset() {
  if (!ensureVideoTrackEditable()) return;
  const clip = findClip(state.selectedClipId);
  if (!clip) { setStatus('请先选择一个片段'); return; }
  const speeds = SPEED_CURVE_PRESETS[els.speedCurvePreset.value];
  if (!speeds) return;
  const index = state.clips.findIndex((item) => item.id === clip.id);
  const oldDuration = rawDur(clip);
  const oldSpeed = clipSpeed(clip);
  const start = clipStartOnTimeline(clip.id);
  const oldEffective = effDur(clip);
  const pieces = timeline.splitClipBySpeedCurve(clip, speeds, speeds.slice(1).map(() => ++seq));
  if (!pieces) { setStatus('当前片段太短，无法应用变速曲线'); return; }
  distributeClipTransformKeyframesForSpeedCurve(clip, pieces);
  const newEffective = pieces.reduce((sum, piece) => sum + effDur(piece), 0);
  const following = new Set();
  const collectFollowing = (items) => items.forEach((item) => {
    if (item.start >= start + oldEffective - 0.0001) following.add(item);
  });
  collectFollowing(state.texts); collectFollowing(state.overlays); collectFollowing(state.brolls); collectFollowing(state.audioTracks);
  recordUndo();
  retimeItemsForSpeedCurve(state.texts, start, oldDuration, oldEffective, oldSpeed, speeds, newEffective);
  retimeItemsForSpeedCurve(state.overlays, start, oldDuration, oldEffective, oldSpeed, speeds, newEffective);
  retimeItemsForSpeedCurve(state.brolls, start, oldDuration, oldEffective, oldSpeed, speeds, newEffective);
  retimeItemsForSpeedCurve(state.audioTracks, start, oldDuration, oldEffective, oldSpeed, speeds, newEffective);
  retimeMarkersForSpeedCurve(start, oldDuration, oldEffective, oldSpeed, speeds, newEffective);
  const delta = newEffective - oldEffective;
  const shiftFollowing = (items) => items.forEach((item) => {
    if (following.has(item)) { item.start += delta; item.end += delta; }
  });
  shiftFollowing(state.texts); shiftFollowing(state.overlays); shiftFollowing(state.brolls); shiftFollowing(state.audioTracks);
  state.clips.splice(index, 1, ...pieces);
  state.selectedClipId = pieces[0].id;
  activeTimelineItem = { type: 'clip', id: pieces[0].id };
  stopPreview();
  setStatus('已应用变速曲线：' + speeds.map((speed) => speed + '×').join(' → '));
  renderAll();
}

// ---------------------------------------------------------------------------
// Timeline edit
// ---------------------------------------------------------------------------

function selectClip(id) { activateTimelineItem('clip', id); switchTab('clip'); renderAll(); }
function copyClipAppearance() {
  const clip = findClip(state.selectedClipId);
  if (!clip || !clipAppearance) { setStatus('请先选择一个片段'); return false; }
  copiedClipAppearance = clipAppearance.capture(clip);
  setStatus('已复制当前片段的画面属性');
  renderAll();
  return true;
}
function pasteClipAppearance() {
  if (!ensureVideoTrackEditable()) return false;
  const clip = findClip(state.selectedClipId);
  if (!clip || !copiedClipAppearance || !clipAppearance) { setStatus('还没有可粘贴的画面属性'); return false; }
  recordUndo();
  clipAppearance.apply(clip, copiedClipAppearance);
  setStatus('已粘贴画面属性；素材、裁剪、速度、音频和转场保持不变');
  renderAll();
  return true;
}
function ensureVideoTrackEditable() {
  if (!state.videoTrackLocked) return true;
  setStatus('主视频轨已锁定，先点击轨道左侧解锁');
  return false;
}
function deleteClip(id) {
  if (!ensureVideoTrackEditable()) return;
  const index = state.clips.findIndex((clip) => clip.id === id);
  if (index < 0) return;
  recordUndo();
  state.clips = state.clips.filter((c) => c.id !== id);
  if (state.selectedClipId === id) {
    const next = state.clips[Math.min(index, state.clips.length - 1)];
    state.selectedClipId = next ? next.id : null;
    activeTimelineItem = { type: 'clip', id: state.selectedClipId };
  }
  stopPreview();
  renderAll();
}
function moveClip(id, off) {
  if (!ensureVideoTrackEditable()) return;
  const i = state.clips.findIndex((c) => c.id === id);
  const j = i + off;
  if (i < 0 || j < 0 || j >= state.clips.length) return;
  recordUndo();
  const [c] = state.clips.splice(i, 1);
  state.clips.splice(j, 0, c);
  renderAll();
}
function moveLayer(items, id, offset) {
  const index = items.findIndex((item) => item.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= items.length) return;
  recordUndo();
  const [item] = items.splice(index, 1);
  items.splice(target, 0, item);
  renderAll();
}
function addVideoTrack() {
  const id = 'video-' + (++seq);
  recordUndo();
  state.videoTracks.push({ id, name: `视频层 ${state.videoTracks.length + 1}`, visible: true, locked: false });
  state.selectedVideoTrackId = id;
  renderAll();
}
function moveVideoTrack(offset) {
  const index = state.videoTracks.findIndex((track) => track.id === state.selectedVideoTrackId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= state.videoTracks.length) return;
  recordUndo();
  const [track] = state.videoTracks.splice(index, 1);
  state.videoTracks.splice(target, 0, track);
  renderAll();
}
function deleteSelectedVideoTrack() {
  const track = findVideoTrack(state.selectedVideoTrackId);
  if (!track) return;
  if (state.videoTracks.length <= 1) { setStatus('至少保留一个视频层轨'); return; }
  if (state.brolls.some((broll) => broll.trackId === track.id)) { setStatus('请先移动或删除该轨中的视频层'); return; }
  recordUndo();
  state.videoTracks = state.videoTracks.filter((item) => item.id !== track.id);
  state.selectedVideoTrackId = state.videoTracks[0].id;
  renderAll();
}
function reorderTo(id, targetId) {
  if (!ensureVideoTrackEditable()) return;
  if (id === targetId) return;
  const from = state.clips.findIndex((c) => c.id === id);
  if (from < 0) return;
  recordUndo();
  const [c] = state.clips.splice(from, 1);
  const to = state.clips.findIndex((x) => x.id === targetId);
  state.clips.splice(to < 0 ? state.clips.length : to, 0, c);
  renderAll();
}

/** Split the selected clip at the source time currently under the preview head. */
function splitSelectedClip() {
  if (!ensureVideoTrackEditable()) return;
  const layout = timelineLayout();
  const locatedOutput = timeline.locateTimelineTime(layout, playheadTime, state.selectedClipId);
  const clip = locatedOutput ? locatedOutput.clip : findClip(state.selectedClipId);
  if (!clip) { setStatus('请先选择一个片段'); return; }
  const sourceTime = locatedOutput
    ? timeline.sourceTimeAtClipOutputOffset(clip, playheadTime - locatedOutput.start)
    : (clip.trimStart + clip.trimEnd) / 2;
  const splitAt = Math.max(clip.trimStart, Math.min(clip.trimEnd, sourceTime));
  if (!(splitAt > clip.trimStart + 0.05 && splitAt < clip.trimEnd - 0.05)) {
    setStatus('播放位置太靠近片段边缘，无法分割');
    return;
  }
  const split = timeline.splitClipAtSourceTime(clip, splitAt, ++seq);
  if (!split) { setStatus('播放位置太靠近片段边缘，无法分割'); return; }
  const index = state.clips.findIndex((c) => c.id === clip.id);
  recordUndo();
  // A transition belongs to the boundary after the original material, so it
  // moves to the newly created right half instead of appearing at split.
  state.clips.splice(index, 1, split.left, split.right);
  state.selectedClipId = split.right.id;
  stopPreview();
  renderAll();
  setStatus('已在 ' + splitAt.toFixed(2) + 's 分割片段');
}

function trimClipEdgeToPlayhead(edge) {
  if (!ensureVideoTrackEditable()) return false;
  const layout = timelineLayout();
  const located = timeline.locateTimelineTime(layout, playheadTime, state.selectedClipId);
  const clip = located ? located.clip : findClip(state.selectedClipId);
  if (!clip || !located) { setStatus('播放头不在可裁剪片段内'); return false; }
  const sourceAt = timeline.sourceTimeAtClipOutputOffset(clip, playheadTime - located.start);
  const min = 0.05;
  if (edge === 'start' && !(sourceAt > clip.trimStart + min && sourceAt < clip.trimEnd - min)) {
    setStatus('播放位置太靠近片段边缘，无法设置入点');
    return false;
  }
  if (edge === 'end' && !(sourceAt > clip.trimStart + min && sourceAt < clip.trimEnd - min)) {
    setStatus('播放位置太靠近片段边缘，无法设置出点');
    return false;
  }
  const index = state.clips.findIndex((item) => item.id === clip.id);
  const oldNextStart = layout.items[index + 1] ? layout.items[index + 1].start : layout.total;
  recordUndo();
  if (edge === 'start') {
    if (clip.reverse) clip.trimEnd = sourceAt;
    else clip.trimStart = sourceAt;
  } else if (clip.reverse) clip.trimStart = sourceAt;
  else clip.trimEnd = sourceAt;
  const updated = timelineLayout();
  const nextStart = updated.items[index + 1] ? updated.items[index + 1].start : updated.total;
  const rippleDelta = nextStart - oldNextStart;
  if (Math.abs(rippleDelta) > 0.000001) rippleShiftAfter(oldNextStart, rippleDelta);
  stopPreview();
  setStatus(edge === 'start' ? '已将片段入点设为播放头位置' : '已将片段出点设为播放头位置');
  renderAll();
  return true;
}

function duplicateSelectedClip() {
  if (!ensureVideoTrackEditable()) return false;
  const clip = findClip(state.selectedClipId);
  if (!clip) { setStatus('请先选择一个片段'); return false; }
  const index = state.clips.findIndex((item) => item.id === clip.id);
  if (index < 0) return false;
  const duplicated = timeline.duplicateClipAfter(clip, ++seq);
  if (!duplicated) return false;
  const duplicate = duplicated.duplicate;
  Object.assign(clip, duplicated.original);
  duplicate.name = (clip.name || '片段') + ' · 副本';
  const insertionTime = clipStartOnTimeline(clip.id) + effDur(clip);
  const duration = effDur(duplicate);
  recordUndo();
  state.clips.splice(index + 1, 0, duplicate);
  rippleShiftAfter(insertionTime, duration);
  state.selectedClipId = duplicate.id;
  activeTimelineItem = { type: 'clip', id: duplicate.id };
  stopPreview();
  setStatus('已复制当前片段并插入其后');
  renderAll();
  return true;
}

async function createFreezeFrameAtPlayhead() {
  if (!ensureVideoTrackEditable() || !api.createFreezeFrame) return;
  const clip = findClip(state.selectedClipId);
  if (!clip) { setStatus('请先选择要定格的主视频片段'); return; }
  const index = state.clips.findIndex((item) => item.id === clip.id);
  if (index < 0) return;
  const sequential = timeline.exportToPreviewTime(playheadTime, previewDuration(), totalDuration());
  const located = timeline.locateSequentialTime(state.clips, sequential);
  let sourceTime = (clip.trimStart + clip.trimEnd) / 2;
  if (located && located.index === index) {
    sourceTime = clip.reverse
      ? clip.trimEnd - located.local * clipSpeed(clip)
      : clip.trimStart + located.local * clipSpeed(clip);
  }
  sourceTime = Math.max(clip.trimStart, Math.min(clip.trimEnd, sourceTime));
  const localTime = clip.reverse
    ? (clip.trimEnd - sourceTime) / clipSpeed(clip)
    : (sourceTime - clip.trimStart) / clipSpeed(clip);
  const insertionTime = clipStartOnTimeline(clip.id) + Math.max(0, Math.min(effDur(clip), localTime));
  const requestedDuration = Math.max(0.1, Math.min(30, parseFloat(els.freezeFrameDuration.value) || 2));
  els.freezeFrameDuration.value = String(requestedDuration);
  els.freezeFrame.disabled = true;
  setStatus('正在生成定格帧…');
  try {
    const res = await api.createFreezeFrame({ input: clip.path, sourceTime, duration: requestedDuration });
    if (!res || !res.ok) throw new Error((res && res.error) || '生成定格帧失败');
    const frozen = makeClip(res);
    frozen.name = (clip.name || '片段') + ' · 定格帧';
    frozen.hasAudio = false;
    // The extracted frame is raw source media. Keep the original clip's visual
    // treatment so the inserted still has the same look on the timeline.
    frozen.fillMode = clip.fillMode || '';
    frozen.color = JSON.parse(JSON.stringify(clip.color || {}));
    frozen.rotation = clip.rotation || 0;
    frozen.mirrorX = !!clip.mirrorX; frozen.mirrorY = !!clip.mirrorY;
    frozen.crop = JSON.parse(JSON.stringify(clip.crop || { left: 0, right: 0, top: 0, bottom: 0 }));
    frozen.stabilize = 'off';
    frozen.motion = 'none';
    frozen.animationIn = { style: 'none', duration: 0 };
    frozen.animationOut = { style: 'none', duration: 0 };
    const frozenDuration = effDur(frozen);
    recordUndo();
    const atStart = sourceTime <= clip.trimStart + 0.05;
    const atEnd = sourceTime >= clip.trimEnd - 0.05;
    if (atStart) {
      frozen.transitionToNext = { style: 'none', duration: 0 };
      state.clips.splice(index, 0, frozen);
    } else if (atEnd) {
      frozen.transitionToNext = Object.assign({}, clip.transitionToNext || { style: 'none', duration: 0 });
      clip.transitionToNext = { style: 'none', duration: 0 };
      state.clips.splice(index + 1, 0, frozen);
    } else {
      const split = timeline.splitClipAtSourceTime(clip, sourceTime, ++seq);
      if (!split) throw new Error('播放位置太靠近片段边缘，无法插入定格帧');
      frozen.transitionToNext = { style: 'none', duration: 0 };
      state.clips.splice(index, 1, split.left, frozen, split.right);
    }
    rippleShiftAfter(insertionTime, frozenDuration);
    state.selectedClipId = frozen.id;
    activeTimelineItem = { type: 'clip', id: frozen.id };
    stopPreview();
    setStatus('已在播放头插入 ' + requestedDuration.toFixed(1) + ' 秒定格帧');
    renderAll();
  } catch (e) {
    setStatus('生成定格帧失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    els.freezeFrame.disabled = false;
  }
}

function rippleShiftAfter(time, delta, shiftMarkers = true) {
  const shift = (items) => items.forEach((item) => {
    if (item.start >= time) { item.start += delta; item.end += delta; }
    else if (item.end > time) item.end += delta;
  });
  shift(state.texts); shift(state.overlays); shift(state.brolls); shift(state.audioTracks);
  if (shiftMarkers) rippleMarkersAfter(time, delta);
}

function rippleMarkersOverRemovedRanges(removed) {
  for (const marker of state.markers || []) marker.time = timeline.rippleTime(marker.time, removed);
}

function insertMainClipsAtPlayhead(clips, statusPrefix) {
  const valid = Array.isArray(clips) ? clips.filter(Boolean) : [];
  if (!valid.length) return false;
  const layout = timelineLayout();
  let index = state.clips.length;
  let at = totalDuration();
  let split = null;
  const target = timeline.locateTimelineTime(layout, playheadTime, state.selectedClipId);
  if (target && playheadTime > target.start + 0.05 && playheadTime < target.end - 0.05) {
    const sourceAt = timeline.sourceTimeAtClipOutputOffset(target.clip, playheadTime - target.start);
    split = timeline.splitClipAtSourceTime(target.clip, sourceAt, ++seq);
    if (split) { index = target.index + 1; at = playheadTime; }
  }
  if (!split) {
    for (const item of layout.items) {
      if (playheadTime <= item.start + 0.05) { index = item.index; at = item.start; break; }
    }
  }
  const insertedDuration = valid.reduce((sum, clip) => sum + effDur(clip), 0);
  recordUndo();
  if (split) state.clips.splice(index - 1, 1, split.left, ...valid, split.right);
  else state.clips.splice(index, 0, ...valid);
  rippleShiftAfter(at, insertedDuration);
  state.selectedClipId = valid[0].id;
  activeTimelineItem = { type: 'clip', id: valid[0].id };
  stopPreview();
  setStatus((statusPrefix || '已在播放头插入') + valid.length + ' 段视频，并波纹后移后续内容');
  renderAll();
  return true;
}

async function insertClipAtSelection() {
  if (!ensureVideoTrackEditable()) return;
  const res = await api.pickVideos();
  if (res.canceled || !res.items.length) return;
  const valid = res.items.filter((item) => !item.error).map(makeClip);
  if (!valid.length) { setStatus('没有可插入的视频素材'); return; }
  insertMainClipsAtPlayhead(valid);
}

async function overwriteSelectedClip() {
  if (!ensureVideoTrackEditable()) return;
  const target = findClip(state.selectedClipId);
  if (!target) { setStatus('请先选择要覆盖的主视频片段'); return; }
  const res = await api.pickVideos();
  if (res.canceled || !res.items.length || res.items[0].error) return;
  const replacement = makeClip(res.items[0]);
  const index = state.clips.findIndex((clip) => clip.id === target.id);
  const at = clipStartOnTimeline(target.id);
  const delta = effDur(replacement) - effDur(target);
  replacement.transitionToNext = target.transitionToNext;
  recordUndo();
  state.clips.splice(index, 1, replacement);
  rippleShiftAfter(at + effDur(target), delta);
  state.selectedClipId = replacement.id;
  setStatus('已覆盖当前主视频片段');
  renderAll();
}

function rippleDeleteSelectedClip() {
  if (!ensureVideoTrackEditable()) return;
  const target = findClip(state.selectedClipId);
  if (!target) { setStatus('请先选择要波纹删除的主视频片段'); return; }
  const at = clipStartOnTimeline(target.id);
  const index = state.clips.findIndex((clip) => clip.id === target.id);
  const duration = effDur(target) - gapDur(index);
  recordUndo();
  state.clips = state.clips.filter((clip) => clip.id !== target.id);
  const removedDuration = Math.max(0, duration);
  rippleShiftAfter(at + removedDuration, -removedDuration, false);
  rippleMarkersOverRemovedRanges([{ start: at, end: at + removedDuration }]);
  const next = state.clips[Math.min(index, state.clips.length - 1)];
  state.selectedClipId = next ? next.id : null;
  activeTimelineItem = { type: 'clip', id: state.selectedClipId };
  setStatus('已波纹删除主视频片段');
  renderAll();
}

function extractAudioFromSelectedClip() {
  const clip = findClip(state.selectedClipId);
  if (!clip || !clip.hasAudio) { setStatus('选中片段没有可分离的原声'); return; }
  const start = clipStartOnTimeline(clip.id);
  const duration = effDur(clip);
  recordUndo();
  const originalVolume = clip.volume == null ? 1 : clip.volume;
  const originalFadeIn = clip.fadeIn || 0, originalFadeOut = clip.fadeOut || 0;
  clip.volume = 0;
  const track = {
    id: ++seq, path: clip.path, name: clip.name + ' · 原声', duration: rawDur(clip),
    start, end: start + duration, trimStart: clip.trimStart, speed: clipSpeed(clip), reverse: !!clip.reverse,
    volume: originalVolume, fadeIn: originalFadeIn, fadeOut: originalFadeOut, muteRanges: [], loop: false,
  };
  state.audioTracks.push(track);
  activateTimelineItem('audio', track.id);
  setStatus('已将片段原声分离到独立音频轨');
  renderAll();
}

function toggleSelectedClipMute() {
  const clip = findClip(state.selectedClipId);
  if (!clip || !clip.hasAudio) { setStatus('选中片段没有可静音的原声'); return; }
  recordUndo();
  clip.muted = !clip.muted;
  setStatus(clip.muted ? '已静音当前片段原声' : '已恢复当前片段原声');
  syncPreviewStatics();
  renderAll();
}

function stepPreviewFrame(direction) {
  if (!state.clips.length) return;
  const fps = Math.max(1, Number(state.frameRate) || 30);
  const target = Math.max(0, Math.min(totalDuration(), playheadTime + direction / fps));
  stopPreview();
  seekTimelineTime(target, false);
}

function nudgePlayhead(delta) {
  if (!state.clips.length) return false;
  stopPreview();
  const next = Math.max(0, Math.min(totalDuration(), playheadTime + delta));
  seekTimelineTime(next, false);
  revealTimelineTime(next);
  return true;
}

function jumpEditPoint(direction) {
  if (!state.clips.length) return false;
  const point = timeline.adjacentEditPoint(timelineLayout(), playheadTime, direction);
  if (point == null) return false;
  stopPreview();
  seekTimelineTime(point, false);
  revealTimelineTime(point);
  return true;
}

function jklPlayback(key) {
  if (key === 'k') { stopPreview(); return true; }
  if (!state.clips.length) return false;
  if (key === 'j') {
    stopPreview();
    playing = true; els.play.textContent = '⏸ 暂停';
    reversePreviewTimer = setInterval(() => {
      const next = playheadTime - 0.08;
      if (next <= 0) { seekTimelineTime(0, false); stopPreview(); return; }
      seekTimelineTime(next, false);
    }, 50);
    return true;
  }
  playing = true; els.play.textContent = '⏸ 暂停';
  seekTimelineTime(playheadTime, true);
  els.player.playbackRate = 2;
  return true;
}

function copyActiveTimelineItem() {
  if (activeTimelineItem.type === 'clip') {
    const clip = findClip(state.selectedClipId);
    if (!clip) { setStatus('请先选择一个主视频片段'); return false; }
    clipboardTimelineItem = { type: 'clip', item: JSON.parse(JSON.stringify(clip)) };
    setStatus('已复制选中主视频片段');
    return true;
  }
  const item = activeTimedItem();
  if (!item) { setStatus('请先选择文字、视频层、叠加或独立音频'); return false; }
  clipboardTimelineItem = { type: activeTimelineItem.type, item: JSON.parse(JSON.stringify(item)) };
  setStatus('已复制选中时间线素材');
  return true;
}

function pasteTimelineItem() {
  if (!clipboardTimelineItem) { setStatus('剪贴板中没有可粘贴的时间线素材'); return false; }
  const copy = JSON.parse(JSON.stringify(clipboardTimelineItem.item));
  if (clipboardTimelineItem.type === 'clip') {
    if (!ensureVideoTrackEditable()) return false;
    copy.id = ++seq;
    copy.name = (copy.name || '片段') + ' · 副本';
    return insertMainClipsAtPlayhead([copy], '已在播放头粘贴 ');
  }
  const duration = Math.max(0.05, copy.end - copy.start);
  copy.id = ++seq; copy.start = playheadTime; copy.end = playheadTime + duration;
  recordUndo();
  if (clipboardTimelineItem.type === 'text') { state.texts.push(copy); activateTimelineItem('text', copy.id); }
  else if (clipboardTimelineItem.type === 'overlay') { state.overlays.push(copy); activateTimelineItem('overlay', copy.id); }
  else if (clipboardTimelineItem.type === 'broll') { state.brolls.push(copy); activateTimelineItem('broll', copy.id); }
  else if (clipboardTimelineItem.type === 'audio') { state.audioTracks.push(copy); activateTimelineItem('audio', copy.id); }
  else return false;
  setStatus('已在播放头位置粘贴时间线素材');
  renderAll();
  return true;
}

function splitSelectedAudioTrack() {
  const track = findAudioTrack(state.selectedAudioTrackId);
  if (!track) { setStatus('请先选择一个独立音频片段'); return; }
  const split = timeline.splitTimedItem(track, playheadTime, ++seq);
  if (!split) { setStatus('播放头太靠近音频片段边缘，无法分割'); return; }
  const index = state.audioTracks.findIndex((item) => item.id === track.id);
  const offset = split.right.start - track.start;
  split.right.trimStart = Math.max(0, (Number(track.trimStart) || 0) + offset);
  const muteRanges = normaliseAudioMuteRanges(track);
  split.left.muteRanges = muteRanges.map((range) => ({ start: range.start, end: Math.min(range.end, offset) })).filter((range) => range.end > range.start);
  split.right.muteRanges = muteRanges.map((range) => ({ start: Math.max(0, range.start - offset), end: Math.max(0, range.end - offset) })).filter((range) => range.end > range.start);
  // Each resulting piece has its own edge, so retain fades only at the outer ends.
  split.left.fadeOut = 0;
  split.right.fadeIn = 0;
  recordUndo();
  state.audioTracks.splice(index, 1, split.left, split.right);
  activateTimelineItem('audio', split.right.id);
  renderAll();
  setStatus('已在 ' + playheadTime.toFixed(2) + 's 分割音频片段');
}

async function removeSilenceFromSelectedClip() {
  const clip = findClip(state.selectedClipId);
  if (!clip) { setStatus('请先选择一个片段'); return; }
  if (clip.kind === 'image' || !clip.hasAudio) { setStatus('该片段没有可检测的原声'); return; }
  els.removeSilence.disabled = true;
  setStatus('正在检测当前片段静音…');
  try {
    const res = await api.audioAnalysis(clip.path, { noise: '-35dB', silenceDuration: 0.5 });
    if (!res.ok) throw new Error(res.error);
    const local = timeline.silenceToClipLocalRanges(clip, res.silences, 0.35);
    if (!local.length) { setStatus('未检测到可删除的静音区间'); return; }
    const base = clipStartOnTimeline(clip.id);
    const totalClipDuration = effDur(clip);
    const kept = [];
    let cursor = 0;
    for (const silence of local) {
      if (silence.start - cursor >= 0.1) kept.push({ start: cursor, end: silence.start });
      cursor = silence.end;
    }
    if (totalClipDuration - cursor >= 0.1) kept.push({ start: cursor, end: totalClipDuration });
    if (!kept.length) { setStatus('静音覆盖整个片段，未执行删除'); return; }
    const removed = local.map((range) => ({ start: base + range.start, end: base + range.end }));
    const index = state.clips.findIndex((item) => item.id === clip.id);
    const pieces = kept.map((range, pieceIndex) => {
      const sourceStart = clip.reverse
        ? clip.trimEnd - range.end * clipSpeed(clip)
        : clip.trimStart + range.start * clipSpeed(clip);
      const sourceEnd = clip.reverse
        ? clip.trimEnd - range.start * clipSpeed(clip)
        : clip.trimStart + range.end * clipSpeed(clip);
      return Object.assign({}, clip, {
        id: pieceIndex === 0 ? clip.id : ++seq,
        trimStart: sourceStart, trimEnd: sourceEnd,
        transitionToNext: pieceIndex === kept.length - 1 ? clip.transitionToNext : { style: 'none', duration: 0 },
      });
    });
    recordUndo();
    state.clips.splice(index, 1, ...pieces);
    const rippleItems = (items) => items.forEach((item) => {
      item.start = timeline.rippleTime(item.start, removed);
      item.end = Math.max(item.start + 0.05, timeline.rippleTime(item.end, removed));
    });
    rippleItems(state.texts); rippleItems(state.overlays); rippleItems(state.brolls); rippleItems(state.audioTracks);
    rippleMarkersOverRemovedRanges(removed);
    state.selectedClipId = pieces[0].id;
    setStatus(`已删除 ${local.length} 段静音，保留 ${pieces.length} 段画面`);
    renderAll();
  } catch (e) {
    setStatus('静音删除失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    els.removeSilence.disabled = false;
  }
}

async function detectBeatsForSelectedClip() {
  const clip = findClip(state.selectedClipId);
  if (!clip) { setStatus('请先选择一个片段'); return; }
  if (clip.kind === 'image' || !clip.hasAudio) { setStatus('该片段没有可检测的音频节拍'); return; }
  els.detectBeats.disabled = true;
  setStatus('正在检测节拍标记…');
  try {
    const res = await api.audioAnalysis(clip.path, { threshold: 0.05, minGap: 0.32 });
    if (!res.ok) throw new Error(res.error);
    const base = clipStartOnTimeline(clip.id);
    const duration = rawDur(clip);
    beatMarkers = (res.beats || []).filter((beat) => beat >= clip.trimStart && beat <= clip.trimEnd).map((beat) => {
      const local = clip.reverse ? (clip.trimEnd - beat) / clipSpeed(clip) : (beat - clip.trimStart) / clipSpeed(clip);
      return Math.round((base + local) * 1000) / 1000;
    });
    setStatus(`已检测到 ${beatMarkers.length} 个节拍标记，可用于时间线磁吸`);
  } catch (e) {
    setStatus('节拍检测失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    els.detectBeats.disabled = false;
  }
}

async function detectScenesForSelectedClip() {
  if (!ensureVideoTrackEditable() || !api.sceneDetect) return;
  const clip = findClip(state.selectedClipId);
  if (!clip) { setStatus('请先选择一个片段'); return; }
  if (clip.kind === 'image') { setStatus('静态图片没有可检测的镜头切换'); return; }
  els.detectScenes.disabled = true;
  setStatus('正在检测镜头切换…');
  try {
    const res = await api.sceneDetect(clip.path, { start: clip.trimStart, end: clip.trimEnd, threshold: 0.3 });
    if (!res || !res.ok) throw new Error((res && res.error) || '镜头检测失败');
    const cuts = Array.from(new Set((res.cuts || []).map(Number)))
      .filter((time) => Number.isFinite(time) && time > clip.trimStart + 0.08 && time < clip.trimEnd - 0.08)
      .sort((a, b) => a - b);
    if (!cuts.length) { setStatus('未检测到明显镜头切换'); return; }
    const bounds = [clip.trimStart].concat(cuts, [clip.trimEnd]);
    const pieces = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      if (bounds[i + 1] - bounds[i] < 0.08) continue;
      pieces.push(Object.assign({}, clip, {
        id: i === 0 ? clip.id : ++seq,
        trimStart: bounds[i], trimEnd: bounds[i + 1],
        transitionToNext: i === bounds.length - 2
          ? Object.assign({}, clip.transitionToNext || { style: 'none', duration: 0 })
          : { style: 'none', duration: 0 },
      }));
    }
    if (pieces.length < 2) { setStatus('未找到可用的镜头分割点'); return; }
    const index = state.clips.findIndex((item) => item.id === clip.id);
    recordUndo();
    state.clips.splice(index, 1, ...pieces);
    state.selectedClipId = pieces[0].id;
    activeTimelineItem = { type: 'clip', id: pieces[0].id };
    stopPreview();
    setStatus('已按 ' + cuts.length + ' 个镜头切换拆分为 ' + pieces.length + ' 段');
    renderAll();
  } catch (e) {
    setStatus('镜头分割失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    els.detectScenes.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function updateHistoryButtons() {
  els.undo.disabled = !undoStack.length;
  els.redo.disabled = !redoStack.length;
}

let exporting = false;

function renderAll() {
  playheadTime = Math.max(0, Math.min(totalDuration(), playheadTime));
  renderCanvas();
  renderTimeline();
  renderClipInspector();
  renderCanvasPane();
  renderTextPane();
  renderOverlayPane();
  renderBrollPane();
  renderAudioPane();
  renderAudioTimeline();
  renderSecondaryTimelineTracks();
  updateHistoryButtons();
  updateProjectChrome();
  els.export.disabled = !state.clips.length || exporting;
  els.exportPreset.value = state.exportPreset;
  els.insertClip.disabled = state.videoTrackLocked;
  els.overwriteClip.disabled = state.videoTrackLocked || !state.selectedClipId;
  els.rippleDelete.disabled = state.videoTrackLocked || !state.selectedClipId;
  els.extractAudio.disabled = !state.selectedClipId || !(findClip(state.selectedClipId) || {}).hasAudio;
  els.duplicateClip.disabled = state.videoTrackLocked || !state.selectedClipId;
  els.copyClipAppearance.disabled = !state.selectedClipId;
  els.pasteClipAppearance.disabled = state.videoTrackLocked || !state.selectedClipId || !copiedClipAppearance;
  els.applySpeedCurve.disabled = state.videoTrackLocked || !state.selectedClipId || rawDur(findClip(state.selectedClipId) || {}) <= 0.1;
  els.videoTrackLane.classList.toggle('locked', !!state.videoTrackLocked);
  els.lockVideoTrack.textContent = state.videoTrackLocked ? '🔒' : '🔓';
  els.lockVideoTrack.title = state.videoTrackLocked ? '解锁主视频轨' : '锁定主视频轨';
  els.play.disabled = !state.clips.length;
  els.renderPreview.disabled = !state.clips.length || exporting;
  els.renderPreview.textContent = accuratePreviewMode
    ? (accuratePreviewDirty ? '▣ 重新渲染预览' : '↩ 普通预览')
    : '▣ 成片预览';
  els.previewEmpty.classList.toggle('hidden', state.clips.length > 0);
  els.timeLabel.textContent = `${playheadTime.toFixed(1)} / ${totalDuration().toFixed(1)}s`;
  syncPreviewStatics();
}

document.addEventListener('miniclip-languagechange', () => {
  if (els.status && els.status.dataset.sourceText) els.status.textContent = i18n.t(els.status.dataset.sourceText);
  renderAll();
});

function renderCanvas() {
  const [w, h] = ASPECTS[state.aspect] || ASPECTS['16:9'];
  els.canvas.style.aspectRatio = `${w} / ${h}`;
  els.canvas.style.backgroundColor = state.canvasColor || '#000000';
}

let draggingId = null;
let clipTrimEdit = null;
let inspectorTrimEdit = null;
let playheadTime = 0;
let pixelsPerSecond = 80;
const MIN_PIXELS_PER_SECOND = 24;
const MAX_PIXELS_PER_SECOND = 320;
const TIMELINE_LABEL_WIDTH = 46;
let beatMarkers = [];

function timelineLayout(clips = state.clips) {
  return timeline.layoutClips(clips, clips.map((_clip, index) => gapDur(index, clips)));
}

function timelineContentWidth(total) {
  return Math.max(els.timelineViewport ? els.timelineViewport.clientWidth : 0, Math.ceil(TIMELINE_LABEL_WIDTH + total * pixelsPerSecond + 40), 360);
}

function orderedMarkers() {
  return timeline.sortedMarkers ? timeline.sortedMarkers(state.markers) : (state.markers || []).slice().sort((a, b) => a.time - b.time);
}

function markerAtPlayhead() {
  const threshold = Math.max(0.02, 6 / pixelsPerSecond);
  return orderedMarkers().find((marker) => Math.abs(marker.time - playheadTime) <= threshold) || null;
}

function addMarkerAtPlayhead() {
  if (!state.clips.length) { setStatus('请先导入视频'); return false; }
  const existing = markerAtPlayhead();
  if (existing) {
    state.selectedMarkerId = existing.id;
    seekTimelineTime(existing.time, false);
    renderTimeline();
    setStatus('播放头位置已有标记');
    return true;
  }
  recordUndo();
  const marker = { id: ++seq, time: Math.round(playheadTime * 1000) / 1000, name: '' };
  state.markers.push(marker);
  state.selectedMarkerId = marker.id;
  renderTimeline();
  setStatus('已在 ' + marker.time.toFixed(2) + 's 添加标记');
  return true;
}

function deleteSelectedMarker() {
  const marker = orderedMarkers().find((item) => item.id === state.selectedMarkerId);
  if (!marker) { setStatus('请先选择一个标记'); return false; }
  recordUndo();
  state.markers = state.markers.filter((item) => item.id !== marker.id);
  state.selectedMarkerId = null;
  renderTimeline();
  setStatus('已删除标记');
  return true;
}

function selectedMarker() {
  return orderedMarkers().find((marker) => marker.id === state.selectedMarkerId) || null;
}

let markerNameSnapshot = null;
function renderMarkerControls() {
  const marker = selectedMarker();
  els.markerName.disabled = !marker;
  els.markerName.value = marker ? (marker.name || '') : '';
}
function commitMarkerName() {
  if (markerNameSnapshot != null && markerNameSnapshot !== snapshot()) {
    undoStack.push(markerNameSnapshot);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    scheduleRecovery();
    updateHistoryButtons();
  }
  markerNameSnapshot = null;
}

function jumpMarker(direction) {
  if (!state.clips.length) return false;
  const marker = timeline.adjacentMarker
    ? timeline.adjacentMarker(state.markers, playheadTime, direction)
    : null;
  if (!marker) {
    setStatus(direction < 0 ? '播放头之前没有标记' : '播放头之后没有标记');
    return false;
  }
  state.selectedMarkerId = marker.id;
  stopPreview();
  seekTimelineTime(marker.time, false);
  revealTimelineTime(marker.time);
  renderTimeline();
  return true;
}

function retimeMarkersForSpeedCurve(originalStart, sourceDuration, oldEffectiveDuration, oldSpeed, speeds, newEffectiveDuration) {
  for (const marker of state.markers || []) {
    if (marker.time > originalStart && marker.time < originalStart + oldEffectiveDuration) {
      marker.time = timeline.mapSpeedCurveTimelineTime(marker.time, originalStart, sourceDuration, oldSpeed, speeds);
    } else if (marker.time >= originalStart + oldEffectiveDuration) {
      marker.time += newEffectiveDuration - oldEffectiveDuration;
    }
  }
}

function rippleMarkersAfter(time, delta) {
  for (const marker of state.markers || []) {
    if (marker.time >= time) marker.time = Math.max(0, marker.time + delta);
  }
}

function formatTimelineTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(s / 60);
  const remainder = s - minutes * 60;
  return minutes ? minutes + ':' + remainder.toFixed(remainder < 10 ? 1 : 0).padStart(remainder < 10 ? 4 : 2, '0') : remainder.toFixed(1) + 's';
}

function syncTimelinePlayhead() {
  const total = totalDuration();
  playheadTime = Math.max(0, Math.min(total, playheadTime));
  els.timelinePlayhead.classList.toggle('hidden', !state.clips.length);
  els.timelinePlayhead.style.left = String(TIMELINE_LABEL_WIDTH + playheadTime * pixelsPerSecond) + 'px';
  if (document.activeElement !== els.timelineTimecode) els.timelineTimecode.value = timeline.formatTimecode(playheadTime);
  followTimelinePlayhead();
}

function followTimelinePlayhead() {
  if (!playing || draggingPlayhead || clipTrimEdit || timedEdit) return;
  const viewport = els.timelineViewport;
  const width = Number(viewport && viewport.clientWidth) || 0;
  if (width <= 0) return;
  const x = TIMELINE_LABEL_WIDTH + playheadTime * pixelsPerSecond;
  const scroll = Number(viewport.scrollLeft) || 0;
  const padding = Math.min(80, Math.max(36, width * 0.12));
  if (x >= scroll + padding && x <= scroll + width - padding) return;
  viewport.scrollLeft = Math.max(0, x - width * 0.35);
}

function revealTimelineTime(seconds) {
  const viewport = els.timelineViewport;
  const width = Number(viewport && viewport.clientWidth) || 0;
  if (width <= 0) return;
  const x = TIMELINE_LABEL_WIDTH + Math.max(0, Number(seconds) || 0) * pixelsPerSecond;
  const scroll = Number(viewport.scrollLeft) || 0;
  const padding = Math.min(70, Math.max(28, width * 0.1));
  if (x >= scroll + padding && x <= scroll + width - padding) return;
  viewport.scrollLeft = Math.max(0, x - width * 0.4);
}

function showTimelineSnapGuide(time) {
  const at = Number(time);
  if (!Number.isFinite(at)) { hideTimelineSnapGuide(); return; }
  els.timelineSnapGuide.classList.remove('hidden');
  els.timelineSnapGuide.style.left = String(TIMELINE_LABEL_WIDTH + at * pixelsPerSecond) + 'px';
}

function hideTimelineSnapGuide() {
  els.timelineSnapGuide.classList.add('hidden');
}

function renderTimelineRuler(total, width) {
  const ruler = els.timelineRuler;
  ruler.innerHTML = '';
  ruler.style.width = String(width) + 'px';
  const data = timeline.rulerTicks(total, pixelsPerSecond, 64);
  data.ticks.forEach((at, index) => {
    const tick = document.createElement('div');
    tick.className = 'ruler-tick' + (index % 5 === 0 || at === total ? ' major' : '');
    tick.style.left = String(TIMELINE_LABEL_WIDTH + at * pixelsPerSecond) + 'px';
    if (index % 5 === 0 || at === total) {
      const label = document.createElement('span');
      label.textContent = formatTimelineTime(at);
      tick.appendChild(label);
    }
    ruler.appendChild(tick);
  });
  for (const beat of beatMarkers) {
    if (!(beat >= 0 && beat <= total)) continue;
    const marker = document.createElement('i');
    marker.className = 'ruler-beat';
    marker.style.left = String(TIMELINE_LABEL_WIDTH + beat * pixelsPerSecond) + 'px';
    marker.title = '节拍 ' + beat.toFixed(2) + 's';
    ruler.appendChild(marker);
  }
  return data.step;
}

function renderTimelineMarkers() {
  document.querySelectorAll('.timeline-marker').forEach((node) => node.remove());
  for (const marker of orderedMarkers()) {
    if (marker.time < 0 || marker.time > totalDuration() + 0.001) continue;
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'timeline-marker' + (marker.id === state.selectedMarkerId ? ' selected' : '');
    node.style.left = String(TIMELINE_LABEL_WIDTH + marker.time * pixelsPerSecond) + 'px';
    node.title = i18n.t('标记') + ' ' + marker.time.toFixed(2) + 's' + (marker.name ? ' · ' + marker.name : '');
    node.setAttribute('aria-label', node.title);
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      state.selectedMarkerId = marker.id;
      seekTimelineTime(marker.time, false);
      renderTimeline();
    });
    els.timelineTrack.appendChild(node);
  }
}

function timelineTimeFromPointer(event) {
  const rect = els.timelineTrack.getBoundingClientRect();
  const x = event.clientX - rect.left - TIMELINE_LABEL_WIDTH;
  return Math.max(0, Math.min(totalDuration(), x / pixelsPerSecond));
}

let draggingPlayhead = false;
function handleTimelinePointer(event) {
  if (!state.clips.length) return;
  if (event.target.closest && event.target.closest('.card, .timeline-marker')) return;
  draggingPlayhead = true;
  seekTimelineTime(timelineTimeFromPointer(event), false);
}
function handleTimelinePointerMove(event) {
  if (clipTrimEdit) { applyClipTrimEdit(event); return; }
  if (timedEdit) { applyTimedEdit(event); return; }
  if (!draggingPlayhead) return;
  seekTimelineTime(timelineTimeFromPointer(event), false);
}
function stopTimelinePointer() {
  if (clipTrimEdit) { commitClipTrimEdit(); return; }
  if (timedEdit) { commitTimedEdit(); return; }
  draggingPlayhead = false;
}

function beginClipTrimEdit(event, clip, edge) {
  if (!ensureVideoTrackEditable()) return;
  event.preventDefault();
  event.stopPropagation();
  activateTimelineItem('clip', clip.id);
  const layout = timelineLayout();
  const index = state.clips.findIndex((item) => item.id === clip.id);
  clipTrimEdit = {
    id: clip.id, edge, originX: event.clientX, snapshot: snapshot(),
    trimStart: clip.trimStart, trimEnd: clip.trimEnd,
    start: layout.items[index] ? layout.items[index].start : 0,
    end: layout.items[index] ? layout.items[index].end : effDur(clip),
    nextStart: layout.items[index + 1] ? layout.items[index + 1].start : layout.total,
  };
  document.body.classList.add('timeline-editing');
}

function applyClipTrimEdit(event) {
  if (!clipTrimEdit) return;
  const clip = findClip(clipTrimEdit.id);
  if (!clip) return;
  const delta = (event.clientX - clipTrimEdit.originX) / pixelsPerSecond;
  const base = Object.assign({}, clip, { trimStart: clipTrimEdit.trimStart, trimEnd: clipTrimEdit.trimEnd });
  let trimmed = timeline.trimClipByOutputDelta(base, clipTrimEdit.edge, delta);
  if (!trimmed) return;
  const proposed = Object.assign({}, clip, trimmed);
  const proposedClips = state.clips.map((item) => item.id === clip.id ? proposed : item);
  const layout = timelineLayout(proposedClips);
  const index = state.clips.findIndex((item) => item.id === clip.id);
  const ranged = layout.items[index];
  const edgeTime = clipTrimEdit.edge === 'start' ? ranged.start : ranged.end;
  const guides = timelineSnapGuides('clip', clip.id);
  const threshold = Math.max(0.04, 9 / pixelsPerSecond);
  const snappedTime = timeline.snapTime(edgeTime, guides, threshold);
  const effectiveSnap = state.snapEnabled ? snappedTime : edgeTime;
  showTimelineSnapGuide(effectiveSnap !== edgeTime ? effectiveSnap : null);
  if (effectiveSnap !== edgeTime) {
    const snappedDelta = clipTrimEdit.edge === 'start'
      ? effectiveSnap - clipTrimEdit.start
      : effectiveSnap - clipTrimEdit.end;
    trimmed = timeline.trimClipByOutputDelta(base, clipTrimEdit.edge, snappedDelta);
  }
  clip.trimStart = trimmed.trimStart;
  clip.trimEnd = trimmed.trimEnd;
  renderAll();
}

function commitClipTrimEdit() {
  if (!clipTrimEdit) return;
  const index = state.clips.findIndex((item) => item.id === clipTrimEdit.id);
  const layout = timelineLayout();
  const nextStart = layout.items[index + 1] ? layout.items[index + 1].start : layout.total;
  const rippleDelta = nextStart - clipTrimEdit.nextStart;
  if (Math.abs(rippleDelta) > 0.000001) rippleShiftAfter(clipTrimEdit.nextStart, rippleDelta);
  const changed = clipTrimEdit.snapshot !== snapshot();
  if (changed) {
    if (accuratePreviewMode) accuratePreviewDirty = true;
    undoStack.push(clipTrimEdit.snapshot);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    scheduleRecovery();
    setStatus('已裁剪片段');
  }
  clipTrimEdit = null;
  hideTimelineSnapGuide();
  document.body.classList.remove('timeline-editing');
  if (changed) renderAll();
  else updateHistoryButtons();
}

function beginInspectorTrimEdit() {
  const clip = findClip(state.selectedClipId);
  if (!clip || (inspectorTrimEdit && inspectorTrimEdit.id === clip.id)) return;
  const layout = timelineLayout();
  const index = state.clips.findIndex((item) => item.id === clip.id);
  inspectorTrimEdit = {
    id: clip.id, snapshot: snapshot(),
    nextStart: layout.items[index + 1] ? layout.items[index + 1].start : layout.total,
  };
}

function commitInspectorTrimEdit() {
  const edit = inspectorTrimEdit;
  inspectorTrimEdit = null;
  if (!edit) return;
  const index = state.clips.findIndex((item) => item.id === edit.id);
  const layout = timelineLayout();
  const nextStart = layout.items[index + 1] ? layout.items[index + 1].start : layout.total;
  const rippleDelta = nextStart - edit.nextStart;
  if (Math.abs(rippleDelta) > 0.000001) rippleShiftAfter(edit.nextStart, rippleDelta);
  const changed = edit.snapshot !== snapshot();
  if (changed) {
    if (accuratePreviewMode) accuratePreviewDirty = true;
    undoStack.push(edit.snapshot);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    scheduleRecovery();
    setStatus('已裁剪片段');
  }
  renderAll();
}

function changeTimelineZoom(multiplier, anchorClientX) {
  const old = pixelsPerSecond;
  pixelsPerSecond = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, Math.round(old * multiplier)));
  if (pixelsPerSecond === old) return;
  const previousScroll = els.timelineViewport.scrollLeft;
  const viewportRect = els.timelineViewport.getBoundingClientRect ? els.timelineViewport.getBoundingClientRect() : { left: 0 };
  const pointerOffset = Number.isFinite(anchorClientX) ? Math.max(0, anchorClientX - viewportRect.left) : 0;
  const anchor = (previousScroll + pointerOffset) / old;
  renderTimeline();
  els.timelineViewport.scrollLeft = Math.max(0, anchor * pixelsPerSecond - pointerOffset);
}

function handleTimelineWheel(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  changeTimelineZoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX);
}

function fitTimeline() {
  if (!state.clips.length) return;
  const available = Math.max(1, (els.timelineViewport.clientWidth || 0) - TIMELINE_LABEL_WIDTH - 40);
  pixelsPerSecond = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, Math.floor(available / Math.max(0.1, totalDuration()))));
  renderTimeline();
  els.timelineViewport.scrollLeft = 0;
}

let timedEdit = null;
function beginTimedEdit(event, type, item, edge) {
  if ((type === 'broll' && (state.trackControls.brollLocked || (findVideoTrack(item.trackId) || {}).locked)) || (type === 'overlay' && state.trackControls.overlayLocked) || (type === 'text' && state.trackControls.textLocked) || (type === 'audio' && state.trackControls.audioLocked)) {
    setStatus('当前轨道已锁定');
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  activateTimelineItem(type, item.id);
  timedEdit = {
    type, id: item.id, edge: edge || 'move', originX: event.clientX,
    snapshot: snapshot(), start: Number(item.start) || 0, end: Number(item.end) || 0,
  };
  document.body.classList.add('timeline-editing');
}
function timelineSnapGuides(excludeType, excludeId) {
  const guides = [0, playheadTime, totalDuration()].concat(beatMarkers, orderedMarkers().map((marker) => marker.time));
  const layout = timelineLayout();
  layout.items.forEach(({ clip, start, end }) => {
    if (excludeType === 'clip' && clip.id === excludeId) return;
    guides.push(start, end);
  });
  const add = (items, type) => {
    for (const item of items || []) {
      if (type === excludeType && item.id === excludeId) continue;
      guides.push(Number(item.start) || 0, Number(item.end) || 0);
    }
  };
  add(state.texts, 'text');
  add(state.overlays, 'overlay');
  add(state.audioTracks, 'audio');
  return guides;
}
function snapTimedRange(range, edge, type, id) {
  if (!state.snapEnabled) return range;
  const guides = timelineSnapGuides(type, id);
  const threshold = Math.max(0.04, 9 / pixelsPerSecond);
  if (edge === 'move') {
    const snappedStart = timeline.snapTime(range.start, guides, threshold);
    return timeline.moveTimedRange(range, snappedStart - range.start);
  }
  if (edge === 'start') return Object.assign({}, range, { start: timeline.snapTime(range.start, guides, threshold) });
  return Object.assign({}, range, { end: timeline.snapTime(range.end, guides, threshold) });
}
function applyTimedEdit(event) {
  if (!timedEdit) return;
  const item = activeTimedItem();
  if (!item || item.id !== timedEdit.id) return;
  const delta = (event.clientX - timedEdit.originX) / pixelsPerSecond;
  const source = { start: timedEdit.start, end: timedEdit.end };
  let range;
  if (timedEdit.edge === 'move') range = timeline.moveTimedRange(source, delta);
  else range = timeline.resizeTimedRange(source, timedEdit.edge, delta);
  range = snapTimedRange(range, timedEdit.edge, timedEdit.type, timedEdit.id);
  const rawEdge = timedEdit.edge === 'move' ? source.start + delta : (timedEdit.edge === 'start' ? source.start + delta : source.end + delta);
  const snappedEdge = timedEdit.edge === 'move' ? range.start : (timedEdit.edge === 'start' ? range.start : range.end);
  showTimelineSnapGuide(Math.abs(rawEdge - snappedEdge) > 0.000001 ? snappedEdge : null);
  if (!(range.end > range.start + 0.04)) return;
  item.start = range.start;
  item.end = range.end;
  renderAll();
}
function commitTimedEdit() {
  if (!timedEdit) return;
  const changed = timedEdit.snapshot !== snapshot();
  if (changed) {
    undoStack.push(timedEdit.snapshot);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    scheduleRecovery();
  }
  timedEdit = null;
  hideTimelineSnapGuide();
  document.body.classList.remove('timeline-editing');
  updateHistoryButtons();
}
function makeTrimHandle(edge, type, item) {
  const handle = document.createElement('span');
  handle.className = 'timeline-trim-handle ' + edge;
  handle.addEventListener('pointerdown', (event) => beginTimedEdit(event, type, item, edge));
  return handle;
}
function deleteActiveTimelineItem() {
  const item = activeTimedItem();
  if (!item) return false;
  if ((activeTimelineItem.type === 'broll' && (state.trackControls.brollLocked || (findVideoTrack(item.trackId) || {}).locked)) || (activeTimelineItem.type === 'overlay' && state.trackControls.overlayLocked) || (activeTimelineItem.type === 'text' && state.trackControls.textLocked) || (activeTimelineItem.type === 'audio' && state.trackControls.audioLocked)) {
    setStatus('当前轨道已锁定');
    return true;
  }
  recordUndo();
  if (activeTimelineItem.type === 'text') {
    state.texts = state.texts.filter((text) => text.id !== item.id);
    state.selectedTextId = null;
  } else if (activeTimelineItem.type === 'overlay') {
    state.overlays = state.overlays.filter((overlay) => overlay.id !== item.id);
    state.selectedOverlayId = null;
  } else if (activeTimelineItem.type === 'broll') {
    state.brolls = state.brolls.filter((broll) => broll.id !== item.id);
    state.selectedBrollId = null;
  } else if (activeTimelineItem.type === 'audio') {
    state.audioTracks = state.audioTracks.filter((track) => track.id !== item.id);
    state.selectedAudioTrackId = null;
  }
  activeTimelineItem = { type: 'clip', id: state.selectedClipId };
  renderAll();
  return true;
}
function nudgeActiveTimelineItem(delta) {
  const item = activeTimedItem();
  if (!item) return false;
  if ((activeTimelineItem.type === 'broll' && (state.trackControls.brollLocked || (findVideoTrack(item.trackId) || {}).locked)) || (activeTimelineItem.type === 'overlay' && state.trackControls.overlayLocked) || (activeTimelineItem.type === 'text' && state.trackControls.textLocked) || (activeTimelineItem.type === 'audio' && state.trackControls.audioLocked)) return false;
  const range = timeline.moveTimedRange(item, delta);
  recordUndo();
  item.start = range.start; item.end = range.end;
  renderAll();
  return true;
}

function renderTimeline() {
  const box = els.clips;
  box.innerHTML = '';
  if (!state.clips.length) {
    box.appendChild(els.timelineEmpty);
    els.timelineHint.textContent = '';
    els.timelineRuler.innerHTML = '';
    els.timelineTrack.style.width = '100%';
    renderTimelineMarkers();
    els.addMarker.disabled = true;
    els.prevMarker.disabled = true;
    els.nextMarker.disabled = true;
    els.deleteMarker.disabled = true;
    els.timelineFit.disabled = true;
    renderMarkerControls();
    syncTimelinePlayhead();
    return;
  }
  const layout = timelineLayout();
  const width = timelineContentWidth(layout.total);
  els.timelineTrack.style.width = String(width) + 'px';
  const step = renderTimelineRuler(layout.total, width);
  els.timelineHint.textContent = '点击定位 · 拖动播放头 · M 标记 · Ctrl/⌘+B 分割 · 网格 ' + step + 's';
  els.timelineZoomLabel.textContent = Math.round(pixelsPerSecond / 80 * 100) + '%';

  layout.items.forEach(({ clip, index: idx, start, duration }) => {
    const card = document.createElement('div');
    card.className = 'card' + (clip.id === state.selectedClipId ? ' selected' : '');
    card.draggable = true;
    card.dataset.id = String(clip.id);
    card.style.left = String(start * pixelsPerSecond) + 'px';
    card.style.width = String(Math.max(64, duration * pixelsPerSecond)) + 'px';
    card.addEventListener('click', (event) => { event.stopPropagation(); selectClip(clip.id); seekTimelineTime(start + duration / 2, false); });
    card.addEventListener('dragstart', (e) => { draggingId = clip.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    card.addEventListener('dragend', () => { draggingId = null; card.classList.remove('dragging'); document.querySelectorAll('.card.drop-target').forEach((n) => n.classList.remove('drop-target')); });
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-target'); });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('drop-target'); if (draggingId != null) reorderTo(draggingId, clip.id); });
    const trimStart = document.createElement('span');
    trimStart.className = 'clip-trim-handle start';
    trimStart.title = '拖动裁剪片段起点';
    trimStart.addEventListener('pointerdown', (event) => beginClipTrimEdit(event, clip, 'start'));
    const trimEnd = document.createElement('span');
    trimEnd.className = 'clip-trim-handle end';
    trimEnd.title = '拖动裁剪片段终点';
    trimEnd.addEventListener('pointerdown', (event) => beginClipTrimEdit(event, clip, 'end'));
    card.append(trimStart, trimEnd);

    const top = document.createElement('div');
    top.className = 'card-top';
    const index = document.createElement('span');
    index.className = 'card-index';
    index.textContent = `#${idx + 1}`;
    top.appendChild(index);
    card.appendChild(top);

    const thumb = document.createElement(clip.kind === 'image' ? 'img' : 'video');
    thumb.className = 'card-thumb';
    thumb.src = clip.url;
    if (clip.kind !== 'image') {
      thumb.muted = true; thumb.preload = 'metadata';
      thumb.addEventListener('loadedmetadata', () => { try { thumb.currentTime = clip.trimStart + 0.05; } catch {} });
    }
    card.appendChild(thumb);

    const badges = document.createElement('div');
    badges.className = 'card-badges';
    if (clipSpeed(clip) !== 1) badges.appendChild(badge(`${clipSpeed(clip)}×`));
    if (clip.kind === 'image') badges.appendChild(badge('图片'));
    if (clip.reverse) badges.appendChild(badge('倒放'));
    if (clip.muted) badges.appendChild(badge('静音'));
    if (clip.motion !== 'none') badges.appendChild(badge('运动'));
    if (clip.stabilize && clip.stabilize !== 'off') badges.appendChild(badge('防抖'));
    if (clip.effect && clip.effect !== 'none') badges.appendChild(badge(EFFECT_LABELS[clip.effect] || '特效'));
    if (isGraded(clip)) badges.appendChild(badge('调色'));
    if (idx < state.clips.length - 1 && (clip.transitionToNext || {}).style && clip.transitionToNext.style !== 'none' && (clip.transitionToNext.duration || 0) > 0) {
      badges.appendChild(badge('转场→'));
    }
    card.appendChild(badges);

    const dur = document.createElement('div');
    dur.className = 'card-dur';
    dur.textContent = `${rawDur(clip).toFixed(1)}s → ${effDur(clip).toFixed(1)}s`;
    card.appendChild(dur);

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = clip.name || '片段';
    name.title = clip.name || '片段';
    card.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.appendChild(iconBtn('←', (e) => { e.stopPropagation(); moveClip(clip.id, -1); }));
    actions.appendChild(iconBtn('→', (e) => { e.stopPropagation(); moveClip(clip.id, 1); }));
    const del = iconBtn('🗑', (e) => { e.stopPropagation(); deleteClip(clip.id); });
    del.classList.add('btn-danger');
    actions.appendChild(del);
    card.appendChild(actions);

    box.appendChild(card);
  });
  renderTimelineMarkers();
  els.addMarker.disabled = false;
  els.toggleSnap.classList.toggle('is-active', state.snapEnabled !== false);
  els.toggleSnap.textContent = state.snapEnabled !== false ? '🧲 磁吸' : '○ 磁吸';
  els.toggleSnap.title = state.snapEnabled !== false ? '关闭时间线磁吸' : '开启时间线磁吸';
  els.timelineFit.disabled = false;
  els.prevMarker.disabled = !timeline.adjacentMarker || !timeline.adjacentMarker(state.markers, playheadTime, -1);
  els.nextMarker.disabled = !timeline.adjacentMarker || !timeline.adjacentMarker(state.markers, playheadTime, 1);
  els.deleteMarker.disabled = !orderedMarkers().some((marker) => marker.id === state.selectedMarkerId);
  renderMarkerControls();
  syncTimelinePlayhead();
}

function badge(text) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = text; return b; }
function iconBtn(text, on) { const b = document.createElement('button'); b.className = 'btn btn-small'; b.textContent = text; b.addEventListener('click', on); return b; }
function isGraded(c) {
  const x = c.color || {};
  return x.brightness || (x.contrast != null && x.contrast !== 1) || (x.saturation != null && x.saturation !== 1) || x.temperature
    || x.hue || (x.gamma != null && x.gamma !== 1) || (x.curve && x.curve !== 'none') || !!x.lutPath;
}

// ---- clip inspector ----
function renderClipInspector() {
  const clip = findClip(state.selectedClipId);
  els.clipEmpty.classList.toggle('hidden', !!clip);
  els.clipInspector.classList.toggle('hidden', !clip);
  if (!clip) return;

  els.clipTitle.textContent = clip.name;
  els.clipName.value = clip.name || '';
  els.trimStart.max = String(clip.sourceDuration);
  els.trimEnd.max = String(clip.sourceDuration);
  els.trimStart.value = String(clip.trimStart);
  els.trimEnd.value = String(clip.trimEnd);
  els.trimStartVal.textContent = `${clip.trimStart.toFixed(1)}s`;
  els.trimEndVal.textContent = `${clip.trimEnd.toFixed(1)}s`;
  els.trimDurationVal.textContent = `保留 ${rawDur(clip).toFixed(1)}s · 成片占用 ${effDur(clip).toFixed(1)}s`;
  els.imageDurationField.classList.toggle('hidden', clip.kind !== 'image');
  els.imageDuration.value = String(clip.sourceDuration);
  els.speed.value = String(clipSpeed(clip));
  els.speedVal.textContent = `${clipSpeed(clip).toFixed(2).replace(/\.?0+$/, '')}×`;
  els.clipVolume.value = String(clip.volume == null ? 1 : clip.volume);
  els.clipVolumeVal.textContent = Math.round((clip.volume == null ? 1 : clip.volume) * 100) + '%';
  els.clipFadeIn.value = String(clip.fadeIn || 0);
  els.clipFadeOut.value = String(clip.fadeOut || 0);
  els.toggleClipMute.textContent = clip.muted ? '🔇 解除静音' : '🔊 静音片段';
  els.reverse.checked = !!clip.reverse;
  els.motion.value = clip.motion || 'none';
  const animationIn = clip.animationIn || { style: 'none', duration: 0 };
  const animationOut = clip.animationOut || { style: 'none', duration: 0 };
  els.animationInStyle.value = animationIn.style || 'none';
  els.animationInDuration.value = String(animationIn.duration || 0);
  els.animationOutStyle.value = animationOut.style || 'none';
  els.animationOutDuration.value = String(animationOut.duration || 0);
  els.stabilize.value = clip.stabilize || 'off';
  els.clipFill.value = clip.fillMode || '';
  els.clipMirrorX.checked = !!clip.mirrorX;
  els.clipMirrorY.checked = !!clip.mirrorY;
  els.clipRotation.value = String(clip.rotation || 0);
  els.clipRotationVal.textContent = Math.round(clip.rotation || 0) + '°';
  els.clipOpacity.value = String(clip.opacity == null ? 1 : clip.opacity);
  els.clipOpacityVal.textContent = Math.round((clip.opacity == null ? 1 : clip.opacity) * 100) + '%';
  els.clipTransformScale.value = String(clip.transformScale == null ? 1 : clip.transformScale);
  els.clipTransformScaleVal.textContent = Math.round((clip.transformScale == null ? 1 : clip.transformScale) * 100) + '%';
  els.clipTransformX.value = String(clip.transformX || 0);
  els.clipTransformY.value = String(clip.transformY || 0);
  renderClipTransformKeyframes(clip);
  const crop = clip.crop || {};
  els.clipCropLeft.value = Math.round((crop.left || 0) * 100);
  els.clipCropRight.value = Math.round((crop.right || 0) * 100);
  els.clipCropTop.value = Math.round((crop.top || 0) * 100);
  els.clipCropBottom.value = Math.round((crop.bottom || 0) * 100);

  const c = clip.color || {};
  els.brightness.value = String(c.brightness || 0);
  els.briVal.textContent = String(c.brightness || 0);
  els.contrast.value = String(c.contrast == null ? 1 : c.contrast);
  els.conVal.textContent = (c.contrast == null ? 1 : c.contrast).toFixed(2);
  els.saturation.value = String(c.saturation == null ? 1 : c.saturation);
  els.satVal.textContent = (c.saturation == null ? 1 : c.saturation).toFixed(2);
  els.temperature.value = String(c.temperature || 0);
  els.tempVal.textContent = String(c.temperature || 0);
  els.hue.value = String(c.hue || 0); els.hueVal.textContent = String(c.hue || 0) + '°';
  els.gamma.value = String(c.gamma == null ? 1 : c.gamma); els.gammaVal.textContent = (c.gamma == null ? 1 : c.gamma).toFixed(2);
  els.colorCurve.value = c.curve || 'none';
  els.lutName.textContent = c.lutPath ? c.lutPath.split(/[\/]/).pop() : '';
  els.clearLut.classList.toggle('hidden', !c.lutPath);
  els.vignette.value = String(clip.vignette || 0);
  els.vignetteVal.textContent = Math.round((clip.vignette || 0) * 100) + '%';
  els.grain.value = String(clip.grain || 0);
  els.grainVal.textContent = Math.round((clip.grain || 0) * 100) + '%';

  const isLast = state.clips.findIndex((x) => x.id === clip.id) === state.clips.length - 1;
  els.transitionField.classList.toggle('hidden', isLast);
  const t = clip.transitionToNext || { style: 'none', duration: 0 };
  els.transStyle.value = t.style || 'none';
  els.transDur.value = String(t.duration || 0);
  els.transDurVal.textContent = `${(t.duration || 0).toFixed(1)}s`;
}

function currentClipLocalTime(clip) {
  if (!clip) return 0;
  const start = clipStartOnTimeline(clip.id);
  return Math.max(0, Math.min(effDur(clip), playheadTime - start));
}

function renderClipTransformKeyframes(clip) {
  if (!clipTransform) return;
  const frames = clipTransform.normalise(clip);
  const duration = clipTransform.durationOf(clip);
  const current = currentClipLocalTime(clip);
  els.clipTransformKeyframeTime.min = '0';
  els.clipTransformKeyframeTime.max = String(duration);
  const requested = parseFloat(els.clipTransformKeyframeTime.value);
  if (!Number.isFinite(requested) || requested < 0 || requested > duration) els.clipTransformKeyframeTime.value = String(current.toFixed(2));
  els.clipTransformKeyframeList.innerHTML = '';
  if (!frames.length) {
    const empty = document.createElement('div');
    empty.className = 'muted small';
    empty.textContent = i18n.t('还没有变换关键帧。调整构图后，在所需时刻记录。');
    els.clipTransformKeyframeList.appendChild(empty);
    return;
  }
  frames.forEach((frame) => {
    const item = document.createElement('div');
    item.className = 'keyframe-item';
    const label = document.createElement('span');
    label.className = 'keyframe-values';
    label.textContent = `${frame.time.toFixed(1)}s · X ${Math.round(frame.x)} · Y ${Math.round(frame.y)} · ${Math.round(frame.scale * 100)}% · ${Math.round(frame.opacity * 100)}% · ${i18n.t(CURVE_LABELS[frame.curve] || '线性')}`;
    const remove = iconBtn(i18n.t('移除'), () => {
      recordUndo();
      clip.transformKeyframes = clipTransform.normalise(clip).filter((candidate) => candidate.time !== frame.time);
      renderAll();
    });
    item.append(label, remove);
    els.clipTransformKeyframeList.appendChild(item);
  });
}

// ---- canvas pane ----
function renderCanvasPane() {
  Array.from(els.aspectChips.children).forEach((ch) => ch.classList.toggle('active', ch.dataset.aspect === state.aspect));
  els.fillMode.value = state.fillMode;
  els.canvasColor.value = state.canvasColor || '#000000';
  els.outputProfile.value = state.outputProfile || '1080p';
  els.frameRate.value = String(state.frameRate || 30);
  const [w, h] = outputDimensions();
  els.canvasInfo.textContent = `导出 ${w}×${h} · ${state.frameRate || 30} fps`;
}

// ---- text pane ----
function defaultTextPositionPercent(position) {
  const map = {
    top: { x: 50, y: 12 }, bottom: { x: 50, y: 88 }, center: { x: 50, y: 50 },
    'bottom-left': { x: 18, y: 88 }, 'bottom-right': { x: 82, y: 88 },
    'top-left': { x: 18, y: 12 }, 'top-right': { x: 82, y: 12 },
  };
  return map[position] || map.bottom;
}

function textPositionPercent(text) {
  const fallback = defaultTextPositionPercent(text && text.position);
  return {
    x: text && text.xPercent != null ? Math.max(0, Math.min(100, Number(text.xPercent) || 0)) : fallback.x,
    y: text && text.yPercent != null ? Math.max(0, Math.min(100, Number(text.yPercent) || 0)) : fallback.y,
    custom: !!text && (text.xPercent != null || text.yPercent != null),
  };
}

function renderTextPane() {
  const list = els.textList;
  list.innerHTML = '';
  state.texts.forEach((t) => {
    const it = document.createElement('div');
    it.className = 'item' + (t.id === state.selectedTextId ? ' active' : '');
    it.addEventListener('click', () => { activateTimelineItem('text', t.id); renderTextPane(); renderSecondaryTimelineTracks(); });
    const main = document.createElement('div'); main.className = 'item-main'; main.textContent = t.text || '(空)';
    const time = document.createElement('div'); time.className = 'item-time'; time.textContent = `${t.start.toFixed(1)}–${t.end.toFixed(1)}s`;
    it.appendChild(main); it.appendChild(time);
    list.appendChild(it);
  });
  const t = findText(state.selectedTextId);
  els.textEditor.classList.toggle('hidden', !t);
  if (t) {
    els.textContent.value = t.text;
    els.textSecondary.value = t.secondaryText || '';
    els.textStart.value = t.start; els.textEnd.value = t.end;
    els.textPos.value = t.position; els.textSize.value = t.fontSize;
    const position = textPositionPercent(t);
    els.textXPercent.value = String(position.x); els.textYPercent.value = String(position.y);
    els.resetTextPosition.disabled = !position.custom;
    els.textFontFamily.value = t.fontFamily || 'sans-serif';
    els.textBold.checked = !!t.bold; els.textItalic.checked = !!t.italic;
    els.textColor.value = t.color; els.textOutline.value = t.outlineColor; els.textFade.value = t.fade || 0;
    els.textOutlineWidth.value = t.outlineWidth == null ? 2 : t.outlineWidth;
    els.textShadow.value = t.shadow || 0; els.textSpacing.value = t.spacing || 0;
    els.textOpacity.value = String(t.opacity == null ? 1 : t.opacity);
    els.textOpacityVal.textContent = Math.round((t.opacity == null ? 1 : t.opacity) * 100) + '%';
    els.textKaraoke.checked = !!t.karaoke; els.textHighlightColor.value = t.karaokeHighlightColor || '#ffd54a';
  }
}

// ---- overlay pane ----
function renderOverlayPane() {
  const list = els.overlayList;
  list.innerHTML = '';
  state.overlays.forEach((o) => {
    const it = document.createElement('div');
    it.className = 'item' + (o.id === state.selectedOverlayId ? ' active' : '');
    it.addEventListener('click', () => { activateTimelineItem('overlay', o.id); renderOverlayPane(); renderSecondaryTimelineTracks(); });
    const main = document.createElement('div'); main.className = 'item-main'; main.textContent = `${o.kind === 'video' ? '🎬' : '🖼'} ${o.name}`;
    const time = document.createElement('div'); time.className = 'item-time'; time.textContent = `${o.start.toFixed(1)}–${o.end.toFixed(1)}s`;
    it.appendChild(main); it.appendChild(time);
    list.appendChild(it);
  });
  const o = findOverlay(state.selectedOverlayId);
  els.overlayEditor.classList.toggle('hidden', !o);
  if (o) {
    els.overlayName.textContent = o.name;
    els.ovStart.value = o.start; els.ovEnd.value = o.end;
    els.ovScale.value = String(o.scale); els.ovScaleVal.textContent = Math.round(o.scale * 100) + '%';
    els.ovX.value = o.x; els.ovY.value = o.y;
    els.ovOpacity.value = String(o.opacity); els.ovOpacityVal.textContent = Math.round(o.opacity * 100) + '%';
    els.ovRotation.value = String(o.rotation || 0); els.ovRotationVal.textContent = Math.round(o.rotation || 0) + '°';
    const crop = o.crop || {};
    els.ovMirrorX.checked = !!o.mirrorX; els.ovMirrorY.checked = !!o.mirrorY; els.ovMask.value = o.mask || 'none'; els.ovMaskInvert.checked = !!o.maskInvert; els.ovMaskFeather.value = Math.round((o.maskFeather || 0) * 100);
    els.ovCropLeft.value = Math.round((crop.left || 0) * 100); els.ovCropRight.value = Math.round((crop.right || 0) * 100);
    els.ovCropTop.value = Math.round((crop.top || 0) * 100); els.ovCropBottom.value = Math.round((crop.bottom || 0) * 100);
    els.ovBlendMode.value = o.blendMode || 'normal';
    const chroma = o.chromaKey || {};
    els.ovChromaEnabled.checked = !!chroma.enabled; els.ovChromaColor.value = chroma.color || '#00ff00'; els.ovChromaSimilarity.value = chroma.similarity == null ? 0.1 : chroma.similarity;
    els.ovFade.value = o.fade || 0;
    const hasMove = !!o.move;
    els.ovMoveEnable.checked = hasMove;
    els.ovMoveX.disabled = !hasMove; els.ovMoveY.disabled = !hasMove;
    if (hasMove) { els.ovMoveX.value = o.move.toX; els.ovMoveY.value = o.move.toY; }
    renderKeyframes(o);
  } else {
    els.keyframeList.innerHTML = '';
    els.keyframeEditor.classList.add('hidden');
  }
}

function renderBrollPane() {
  populateVideoTrackSelect(els.videoTrackSelect, state.selectedVideoTrackId);
  const selectedTrack = findVideoTrack(state.selectedVideoTrackId);
  els.toggleVideoTrack.textContent = selectedTrack && selectedTrack.visible === false ? '◉ 轨道' : '👁 轨道';
  els.lockVideoLayerTrack.textContent = selectedTrack && selectedTrack.locked ? '🔒 轨道' : '🔓 轨道';
  const list = els.brollList;
  list.innerHTML = '';
  state.brolls.forEach((broll) => {
    const item = document.createElement('div');
    item.className = 'item' + (broll.id === state.selectedBrollId ? ' active' : '');
    item.addEventListener('click', () => { activateTimelineItem('broll', broll.id); renderBrollPane(); renderSecondaryTimelineTracks(); });
    const main = document.createElement('div'); main.className = 'item-main'; main.textContent = '▣ ' + broll.name;
    const time = document.createElement('div'); time.className = 'item-time'; time.textContent = `${broll.start.toFixed(1)}–${broll.end.toFixed(1)}s`;
    item.append(main, time);
    list.appendChild(item);
  });
  const broll = findBroll(state.selectedBrollId);
  els.brollEditor.classList.toggle('hidden', !broll);
  if (broll) {
    els.brollName.textContent = broll.name;
    els.brollStart.value = broll.start; els.brollEnd.value = broll.end;
    els.brollTrimStart.value = broll.trimStart || 0; els.brollLoop.checked = broll.loop !== false;
    els.brollOpacity.value = broll.opacity; els.brollOpacityVal.textContent = Math.round(broll.opacity * 100) + '%';
    els.brollRotation.value = broll.rotation || 0; els.brollRotationVal.textContent = Math.round(broll.rotation || 0) + '°';
    els.brollFade.value = broll.fade || 0;
    populateVideoTrackSelect(els.brollTrackSelect, broll.trackId || state.selectedVideoTrackId);
  }
}

function populateVideoTrackSelect(select, selectedId) {
  select.innerHTML = '';
  state.videoTracks.forEach((track, index) => {
    const option = document.createElement('option');
    option.value = track.id; option.textContent = `${index + 1}. ${track.name}`;
    option.selected = track.id === selectedId;
    select.appendChild(option);
  });
}

const CURVE_LABELS = { linear: '线性', easeIn: '缓入', easeOut: '缓出', easeInOut: '缓入缓出' };

function renderKeyframes(o) {
  const frames = keyframe.normaliseKeyframes(o);
  const current = currentPreviewTime();
  const range = keyframe.overlayRange(o);
  els.keyframeNewTime.min = String(range.start);
  els.keyframeNewTime.max = String(range.end);
  if (!Number.isFinite(Number(els.keyframeNewTime.value)) || Number(els.keyframeNewTime.value) < range.start || Number(els.keyframeNewTime.value) > range.end) {
    els.keyframeNewTime.value = String(Math.max(range.start, Math.min(range.end, current)));
  }
  if (state.selectedKeyframeTime != null && !frames.some((f) => f.time === state.selectedKeyframeTime)) {
    state.selectedKeyframeTime = null;
  }
  els.keyframeList.innerHTML = '';
  if (!frames.length) {
    const empty = document.createElement('div');
    empty.className = 'muted small';
    empty.textContent = '还没有关键帧。先调整属性，再在所需时刻记录。';
    els.keyframeList.appendChild(empty);
  }
  for (const f of frames) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'keyframe-item' + (f.time === state.selectedKeyframeTime ? ' active' : '');
    item.addEventListener('click', () => { state.selectedKeyframeTime = f.time; renderKeyframes(o); });
    const time = document.createElement('span'); time.className = 'keyframe-time'; time.textContent = `${f.time.toFixed(1)}s`;
    const values = document.createElement('span'); values.className = 'keyframe-values';
    values.textContent = `X ${Math.round(f.x)} · Y ${Math.round(f.y)} · ${Math.round(f.scale * 100)}% · ${Math.round(f.opacity * 100)}%`;
    const curve = document.createElement('span'); curve.className = 'keyframe-curve'; curve.textContent = CURVE_LABELS[f.curve] || '线性';
    item.append(time, values, curve);
    els.keyframeList.appendChild(item);
  }
  const selected = selectedKeyframe(o);
  els.keyframeEditor.classList.toggle('hidden', !selected);
  if (selected) {
    els.kfTime.min = String(range.start); els.kfTime.max = String(range.end);
    els.kfTime.value = selected.time; els.kfCurve.value = selected.curve;
    els.kfX.value = selected.x; els.kfY.value = selected.y;
    els.kfScale.value = selected.scale; els.kfOpacity.value = selected.opacity; els.kfRotation.value = selected.rotation || 0;
    const bezier = selected.bezier || { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
    els.kfBezierControls.classList.toggle('hidden', selected.curve !== 'bezier');
    els.kfBezierX1.value = bezier.x1; els.kfBezierY1.value = bezier.y1; els.kfBezierX2.value = bezier.x2; els.kfBezierY2.value = bezier.y2;
  }
}

// ---- audio pane ----
function renderAudioPane() {
  els.removeMusic.classList.toggle('hidden', !state.bgm);
  els.volumeRow.classList.toggle('hidden', !state.bgm);
  els.bgmClipControls.classList.toggle('hidden', !state.bgm);
  els.musicName.textContent = state.bgm ? state.bgm.name : '';
  els.music.textContent = state.bgm ? '♪ 更换背景音乐' : '♪ 添加背景音乐';
  els.volOriginal.value = String(state.originalVolume);
  els.volOriginalVal.textContent = Math.round(state.originalVolume * 100) + '%';
  els.volBgm.value = String(state.bgmVolume);
  els.volBgmVal.textContent = Math.round(state.bgmVolume * 100) + '%';
  els.bgmDuck.checked = !!state.bgmDuck;
  els.bgmDuckControls.classList.toggle('hidden', !state.bgmDuck || !state.bgm);
  els.bgmDuckAmount.value = String(state.bgmDuckAmount);
  els.bgmDuckAmountVal.textContent = Math.round(state.bgmDuckAmount * 100) + '%';
  els.loudnessNormalize.checked = !!state.loudnessNormalize;
  if (state.bgm) {
    els.bgmTrimStart.value = state.bgm.trimStart || 0;
    els.bgmFadeIn.value = state.bgm.fadeIn || 0;
    els.bgmFadeOut.value = state.bgm.fadeOut || 0;
  }

  const list = els.audioTrackList;
  list.innerHTML = '';
  state.audioTracks.forEach((track) => {
    const item = document.createElement('div');
    item.className = 'item' + (track.id === state.selectedAudioTrackId ? ' active' : '');
    item.addEventListener('click', () => { activateTimelineItem('audio', track.id); renderAudioPane(); renderAudioTimeline(); });
    const main = document.createElement('div'); main.className = 'item-main'; main.textContent = '♪ ' + track.name;
    const time = document.createElement('div'); time.className = 'item-time'; time.textContent = `${track.start.toFixed(1)}–${track.end.toFixed(1)}s`;
    item.append(main, time);
    list.appendChild(item);
  });
  const track = findAudioTrack(state.selectedAudioTrackId);
  els.audioTrackEditor.classList.toggle('hidden', !track);
  if (track) {
    els.audioTrackName.textContent = track.name;
    els.audioTrackStart.value = track.start; els.audioTrackEnd.value = track.end;
    els.audioTrackTrimStart.value = track.trimStart || 0; els.audioTrackLoop.checked = !!track.loop;
    els.audioTrackVolume.value = track.volume; els.audioTrackVolumeVal.textContent = Math.round(track.volume * 100) + '%';
    els.audioTrackFadeIn.value = track.fadeIn || 0; els.audioTrackFadeOut.value = track.fadeOut || 0;
    els.audioTrackDenoise.checked = !!track.denoise; els.audioTrackVoiceEnhance.checked = !!track.voiceEnhance;
    els.audioTrackSpeed.value = track.speed || 1; els.audioTrackPitch.value = track.pitch || 0;
    renderAudioMuteRanges(track);
  } else {
    els.audioMuteList.innerHTML = '';
  }
}

function normaliseAudioMuteRanges(track) {
  const max = Math.max(0.001, Number(track.end) - Number(track.start));
  const source = Array.isArray(track.muteRanges) ? track.muteRanges : [];
  const ranges = source.map((range) => ({
    start: Math.max(0, Math.min(max, Number(range && range.start) || 0)),
    end: Math.max(0, Math.min(max, Number(range && range.end) || 0)),
  })).filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 0.001) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

function renderAudioMuteRanges(track) {
  els.audioMuteList.innerHTML = '';
  const ranges = normaliseAudioMuteRanges(track);
  if (!ranges.length) {
    const empty = document.createElement('div'); empty.className = 'muted small'; empty.textContent = '还没有局部静音区间。';
    els.audioMuteList.appendChild(empty);
    return;
  }
  ranges.forEach((range, index) => {
    const row = document.createElement('div'); row.className = 'item';
    const label = document.createElement('div'); label.className = 'item-main'; label.textContent = '🔇 ' + range.start.toFixed(1) + '–' + range.end.toFixed(1) + 's（片段内）';
    const remove = iconBtn('移除', () => {
      recordUndo();
      track.muteRanges = normaliseAudioMuteRanges(track).filter((_item, itemIndex) => itemIndex !== index);
      renderAudioPane();
    });
    row.append(label, remove); els.audioMuteList.appendChild(row);
  });
}

function renderAudioTimeline() {
  const lane = els.audioTrackLane;
  lane.innerHTML = '';
  const total = totalDuration();
  lane.style.width = els.timelineTrack.style.width || '100%';
  if (!state.clips.length) return;
  const packed = timeline.packTimedItems(state.audioTracks);
  packed.items.forEach(({ item: track, row }) => {
    const card = document.createElement('div');
    card.className = 'audio-card' + (track.id === state.selectedAudioTrackId ? ' selected' : '');
    card.style.left = `${TIMELINE_LABEL_WIDTH + Math.max(0, track.start) * pixelsPerSecond}px`;
    card.style.top = `${5 + row * 34}px`;
    card.style.width = `${Math.max(42, Math.max(0.001, track.end - track.start) * pixelsPerSecond)}px`;
    card.appendChild(buildWaveformNode(track.path));
    const label = document.createElement('span'); label.className = 'audio-card-label'; label.textContent = '♪ ' + track.name; card.appendChild(label);
    card.title = `${track.name} · ${track.start.toFixed(1)}–${track.end.toFixed(1)}s`;
    card.addEventListener('click', (event) => { event.stopPropagation(); activateTimelineItem('audio', track.id); switchTab('audio'); renderAudioPane(); renderAudioTimeline(); seekTimelineTime(track.start, false); });
    card.addEventListener('pointerdown', (event) => beginTimedEdit(event, 'audio', track, 'move'));
    card.appendChild(makeTrimHandle('start', 'audio', track));
    card.appendChild(makeTrimHandle('end', 'audio', track));
    lane.appendChild(card);
  });
  lane.style.height = `${Math.max(42, packed.rows * 34 + 10)}px`;
  if (total <= 0) lane.innerHTML = '';
}

function buildWaveformNode(filePath) {
  const node = document.createElement('span');
  node.className = 'waveform';
  const peaks = waveformCache.get(filePath);
  if (peaks) {
    for (const peak of peaks) {
      const bar = document.createElement('i');
      bar.style.height = `${Math.max(10, peak * 100)}%`;
      node.appendChild(bar);
    }
  } else {
    node.classList.add('waveform-loading');
    if (!waveformLoading.has(filePath) && api.waveform) {
      waveformLoading.add(filePath);
      api.waveform(filePath, 96).then((res) => {
        if (res && res.ok && Array.isArray(res.peaks)) waveformCache.set(filePath, res.peaks);
      }).catch(() => {}).finally(() => { waveformLoading.delete(filePath); renderAudioTimeline(); });
    }
  }
  return node;
}

function renderTimedLane(lane, items, options) {
  lane.innerHTML = '';
  lane.style.width = els.timelineTrack.style.width || '100%';
  const packed = timeline.packTimedItems(items);
  packed.items.forEach(({ item, row, start, end }) => {
    const card = document.createElement('div');
    card.className = options.className + (options.selected(item) ? ' selected' : '');
    card.style.left = `${TIMELINE_LABEL_WIDTH + start * pixelsPerSecond}px`;
    card.style.top = `${5 + row * 34}px`;
    card.style.width = `${Math.max(44, (end - start) * pixelsPerSecond)}px`;
    card.textContent = options.label(item);
    card.title = `${options.label(item)} · ${start.toFixed(1)}–${end.toFixed(1)}s`;
    card.addEventListener('click', (event) => {
      event.stopPropagation();
      options.select(item);
      seekTimelineTime(start, false);
    });
    card.addEventListener('pointerdown', (event) => beginTimedEdit(event, options.type, item, 'move'));
    card.appendChild(makeTrimHandle('start', options.type, item));
    card.appendChild(makeTrimHandle('end', options.type, item));
    lane.appendChild(card);
  });
  lane.style.height = `${Math.max(52, packed.rows * 34 + 10)}px`;
}

function renderSecondaryTimelineTracks() {
  els.brollTrackLane.innerHTML = '';
  els.brollTrackLane.style.width = els.timelineTrack.style.width || '100%';
  for (const track of state.videoTracks) {
    const lane = document.createElement('div');
    lane.className = 'nested-video-lane' + (track.visible === false ? ' hidden-track' : '');
    const label = document.createElement('span'); label.className = 'nested-video-label'; label.textContent = track.name + (track.locked ? ' 🔒' : ''); lane.appendChild(label);
    renderTimedLane(lane, track.visible === false ? [] : state.brolls.filter((broll) => broll.trackId === track.id), {
      type: 'broll', className: 'broll-card',
      selected: (broll) => broll.id === state.selectedBrollId,
      label: (broll) => '▣ ' + (broll.name || '视频层'),
      select: (broll) => { activateTimelineItem('broll', broll.id); state.selectedVideoTrackId = track.id; switchTab('broll'); renderBrollPane(); renderSecondaryTimelineTracks(); },
    });
    els.brollTrackLane.appendChild(lane);
  }
  els.brollTrackLane.style.height = `${Math.max(52, state.videoTracks.length * 52)}px`;
  renderTimedLane(els.textTrackLane, state.trackControls.textVisible ? state.texts : [], {
    type: 'text',
    className: 'text-card',
    selected: (text) => text.id === state.selectedTextId,
    label: (text) => 'T ' + (text.text || '文字'),
    select: (text) => { activateTimelineItem('text', text.id); switchTab('text'); renderTextPane(); renderSecondaryTimelineTracks(); },
  });
  renderTimedLane(els.overlayTrackLane, state.trackControls.overlayVisible ? state.overlays : [], {
    type: 'overlay',
    className: 'overlay-card',
    selected: (overlay) => overlay.id === state.selectedOverlayId,
    label: (overlay) => (overlay.kind === 'video' ? '▣ ' : '◇ ') + (overlay.name || '叠加'),
    select: (overlay) => { activateTimelineItem('overlay', overlay.id); switchTab('overlay'); renderOverlayPane(); renderSecondaryTimelineTracks(); },
  });
  const h = (els.videoTrackLane.offsetHeight || 98) + (els.brollTrackLane.offsetHeight || 52) + (els.overlayTrackLane.offsetHeight || 52) +
    (els.textTrackLane.offsetHeight || 52) + (els.audioTrackLane.offsetHeight || 42) + 4;
  els.timelineTrack.style.height = `${Math.max(255, h)}px`;
  els.toggleBroll.textContent = state.trackControls.brollVisible ? '👁' : '◉'; els.lockBroll.textContent = state.trackControls.brollLocked ? '🔒' : '🔓';
  els.toggleOverlay.textContent = state.trackControls.overlayVisible ? '👁' : '◉'; els.lockOverlay.textContent = state.trackControls.overlayLocked ? '🔒' : '🔓';
  els.toggleText.textContent = state.trackControls.textVisible ? '👁' : '◉'; els.lockText.textContent = state.trackControls.textLocked ? '🔒' : '🔓';
  els.muteAudio.textContent = state.trackControls.audioMuted ? '🔇' : '🔊'; els.lockAudio.textContent = state.trackControls.audioLocked ? '🔒' : '🔓';
}

// ---------------------------------------------------------------------------
// Preview (approximate)
// ---------------------------------------------------------------------------

let playing = false;
let previewIndex = 0;
let reversePreviewTimer = null;
let clipboardTimelineItem = null;
let copiedClipAppearance = null;
let accuratePreviewMode = false;
let accuratePreviewDirty = false;

function cssColorFilter(c) {
  if (!c) return 'none';
  const parts = [];
  const b = Number(c.brightness) || 0;
  if (b) parts.push(`brightness(${1 + b})`);
  const con = c.contrast == null ? 1 : Number(c.contrast);
  if (con !== 1) parts.push(`contrast(${con})`);
  const sat = c.saturation == null ? 1 : Number(c.saturation);
  if (sat !== 1) parts.push(`saturate(${sat})`);
  const temp = Number(c.temperature) || 0;
  if (temp) parts.push(`sepia(${Math.min(0.6, Math.abs(temp) / 160)}) hue-rotate(${temp > 0 ? 180 : 0}deg)`);
  return parts.length ? parts.join(' ') : 'none';
}

function cssEffectFilter(effect) {
  if (effect === 'mono') return 'grayscale(1) contrast(1.15)';
  if (effect === 'vintage') return 'sepia(.45) saturate(.72) contrast(.96)';
  if (effect === 'soft') return 'blur(1.2px) brightness(1.03)';
  if (effect === 'sharpen') return 'contrast(1.08) saturate(1.05)';
  return '';
}

function cssFinishingFilter(clip) {
  const vignette = Math.max(0, Math.min(1, Number(clip && clip.vignette) || 0));
  const grain = Math.max(0, Math.min(1, Number(clip && clip.grain) || 0));
  const parts = [];
  // CSS cannot create deterministic film grain without a shader/canvas, so
  // preview represents it as a slight contrast/saturation texture cue only.
  if (vignette > 0) parts.push(`brightness(${1 - vignette * 0.08}) contrast(${1 + vignette * 0.08})`);
  if (grain > 0) parts.push(`contrast(${1 + grain * 0.08}) saturate(${1 - grain * 0.04})`);
  return parts.filter(Boolean).join(' ') || 'none';
}

function previewFilterForClip(clip) {
  return [cssColorFilter(clip && clip.color), cssEffectFilter(clip && clip.effect), cssFinishingFilter(clip)].filter((value) => value && value !== 'none').join(' ') || 'none';
}

function clipLocalPreviewTime(clip) {
  if (!clip) return 0;
  const source = Number(els.player.currentTime);
  if (!Number.isFinite(source)) return currentClipLocalTime(clip);
  const speed = clipSpeed(clip);
  const local = clip.reverse ? (clip.trimEnd - source) / speed : (source - clip.trimStart) / speed;
  return Math.max(0, Math.min(effDur(clip), local));
}

function clipTransformValues(clip, localTime) {
  if (clipTransform && clip && Array.isArray(clip.transformKeyframes) && clip.transformKeyframes.length) {
    return clipTransform.valuesAt(clip, localTime == null ? clipLocalPreviewTime(clip) : localTime);
  }
  return {
    x: Number(clip && clip.transformX) || 0, y: Number(clip && clip.transformY) || 0,
    scale: clip && clip.transformScale != null ? Number(clip.transformScale) : 1,
    opacity: clip && clip.opacity != null ? Number(clip.opacity) : 1,
  };
}

function applyClipPreviewGeometry(clip, localTime) {
  const crop = (clip && clip.crop) || {};
  const top = Math.max(0, Math.min(45, (Number(crop.top) || 0) * 100));
  const right = Math.max(0, Math.min(45, (Number(crop.right) || 0) * 100));
  const bottom = Math.max(0, Math.min(45, (Number(crop.bottom) || 0) * 100));
  const left = Math.max(0, Math.min(45, (Number(crop.left) || 0) * 100));
  els.player.style.clipPath = (top || right || bottom || left) ? `inset(${top}% ${right}% ${bottom}% ${left}%)` : '';
  const rotation = Number(clip && clip.rotation) || 0;
  const values = clipTransformValues(clip, localTime);
  const scale = Math.max(0.5, Math.min(2, Number(values.scale) || 1));
  const x = Math.max(-100, Math.min(100, Number(values.x) || 0));
  const y = Math.max(-100, Math.min(100, Number(values.y) || 0));
  els.player.style.transformOrigin = 'center center';
  els.player.style.transform = `translate(${x / 2}%, ${y / 2}%) rotate(${rotation}deg) scale(${scale}) scaleX(${clip && clip.mirrorX ? -1 : 1}) scaleY(${clip && clip.mirrorY ? -1 : 1})`;
  els.player.style.opacity = String(Math.max(0, Math.min(1, Number(values.opacity == null ? 1 : values.opacity))));
}

function clipAudioGainAt(clip, sourceTime) {
  if (!clip || !clip.hasAudio || clip.muted) return 0;
  const speed = clipSpeed(clip);
  const duration = rawDur(clip) / speed;
  if (!(duration > 0)) return 0;
  const source = Number(sourceTime);
  const local = clip.reverse
    ? (clip.trimEnd - (Number.isFinite(source) ? source : clip.trimEnd)) / speed
    : ((Number.isFinite(source) ? source : clip.trimStart) - clip.trimStart) / speed;
  const volume = Math.max(0, Math.min(2, Number(clip.volume == null ? 1 : clip.volume)));
  const fadeIn = Math.min(duration, Math.max(0, Number(clip.fadeIn) || 0));
  const fadeOut = Math.min(duration, Math.max(0, Number(clip.fadeOut) || 0));
  const inGain = fadeIn > 0 ? Math.max(0, Math.min(1, local / fadeIn)) : 1;
  const outGain = fadeOut > 0 ? Math.max(0, Math.min(1, (duration - local) / fadeOut)) : 1;
  return volume * Math.min(inGain, outGain);
}

function syncPreviewStatics() {
  if (accuratePreviewMode) {
    els.textLayer.innerHTML = '';
    els.brollLayer.innerHTML = '';
    els.overlayLayer.innerHTML = '';
    els.transformLayer.innerHTML = '';
    return;
  }
  // Reflect currently-playing clip's look even when paused.
  const clip = state.clips[previewIndex] || findClip(state.selectedClipId) || state.clips[0];
  if (clip) {
    els.player.style.filter = previewFilterForClip(clip);
    els.player.playbackRate = clipSpeed(clip);
    els.player.volume = Math.max(0, Math.min(1, state.originalVolume * clipAudioGainAt(clip, els.player.currentTime)));
    applyClipPreviewGeometry(clip);
  }
  renderTextLayer(currentPreviewTime());
  renderBrollLayer(currentPreviewTime());
  renderOverlayLayer(currentPreviewTime());
  renderTransformLayer(currentPreviewTime());
}

function currentSequentialPreviewTime() {
  if (!state.clips.length) return 0;
  let before = 0;
  for (let i = 0; i < previewIndex; i++) before += effDur(state.clips[i]);
  const clip = state.clips[previewIndex];
  if (!clip) return before;
  const within = Math.max(0, (els.player.currentTime - clip.trimStart)) / clipSpeed(clip);
  return before + within;
}

function currentPreviewTime() {
  if (accuratePreviewMode) return Math.max(0, Math.min(totalDuration(), Number(els.player.currentTime) || 0));
  // Sequential HTML preview cannot truly overlap two videos. Scale its
  // monotonic clock onto the shorter export timeline, so time-bound text/PiP
  // does not duplicate across a transition boundary.
  return timeline.previewToExportTime(
    currentSequentialPreviewTime(), previewDuration(), totalDuration()
  );
}

function previewDuration() {
  return state.clips.reduce((sum, clip) => sum + effDur(clip), 0);
}

/** Seek the sequential browser preview from a final-output timeline time. */
function seekTimelineTime(seconds, autoplay) {
  if (!state.clips.length) return;
  const total = totalDuration();
  playheadTime = Math.max(0, Math.min(total, Number(seconds) || 0));
  if (accuratePreviewMode) {
    try { els.player.currentTime = playheadTime; } catch {}
    if (autoplay && playing) els.player.play().catch(() => {});
    syncTimelinePlayhead();
    els.timeLabel.textContent = playheadTime.toFixed(1) + ' / ' + total.toFixed(1) + 's';
    return;
  }
  const sequential = timeline.exportToPreviewTime(playheadTime, previewDuration(), total);
  const located = timeline.locateSequentialTime(state.clips, sequential);
  if (!located) return;
  const clip = located.clip;
  previewIndex = located.index;
  state.selectedClipId = clip.id;
  const target = Math.max(clip.trimStart, Math.min(clip.trimEnd, clip.trimStart + located.local * clipSpeed(clip)));
  const setTime = () => { try { els.player.currentTime = target; } catch {} };
  const previewUrl = clip.proxyUrl || clip.url;
  if (els.player.src !== previewUrl) {
    els.player.src = previewUrl;
    els.player.muted = false;
    els.player.volume = Math.max(0, Math.min(1, state.originalVolume * clipAudioGainAt(clip, target)));
    els.player.playbackRate = clipSpeed(clip);
    els.player.addEventListener('loadedmetadata', function onLoaded() {
      els.player.removeEventListener('loadedmetadata', onLoaded);
      setTime();
      if (autoplay && playing) els.player.play().catch(() => {});
    });
    els.player.load();
  } else {
    setTime();
    if (autoplay && playing) els.player.play().catch(() => {});
  }
  syncTimelinePlayhead();
  els.timeLabel.textContent = playheadTime.toFixed(1) + ' / ' + total.toFixed(1) + 's';
  renderTextLayer(playheadTime);
  renderBrollLayer(playheadTime);
  renderOverlayLayer(playheadTime);
  renderTransformLayer(playheadTime);
}

function renderTextLayer(t) {
  if (!state.trackControls.textVisible) { els.textLayer.innerHTML = ''; return; }
  const layer = els.textLayer;
  layer.innerHTML = '';
  for (const it of state.texts) {
    if (t < it.start || t > it.end) continue;
    const d = document.createElement('div');
    d.className = 'txt';
    d.style.color = it.color;
    d.style.opacity = String(it.opacity == null ? 1 : it.opacity);
    d.style.fontSize = Math.max(10, it.fontSize * (els.canvas.clientHeight / (ASPECTS[state.aspect][1]))) + 'px';
    d.style.fontFamily = it.fontFamily || 'sans-serif';
    d.style.fontWeight = it.bold ? '700' : '400';
    d.style.fontStyle = it.italic ? 'italic' : 'normal';
    d.style.letterSpacing = ((it.spacing || 0) * (els.canvas.clientHeight / ASPECTS[state.aspect][1])) + 'px';
    const outline = Math.max(0, Number(it.outlineWidth == null ? 2 : it.outlineWidth)) * (els.canvas.clientHeight / ASPECTS[state.aspect][1]);
    const shadow = Math.max(0, Number(it.shadow) || 0) * (els.canvas.clientHeight / ASPECTS[state.aspect][1]);
    d.style.webkitTextStroke = outline ? outline + 'px ' + (it.outlineColor || '#000000') : '';
    d.style.textShadow = shadow ? shadow + 'px ' + shadow + 'px ' + Math.max(1, shadow * 1.5) + 'px rgba(0,0,0,.7)' : '';
    const pos = it.position;
    const customPosition = textPositionPercent(it);
    if (customPosition.custom) {
      d.style.left = customPosition.x + '%'; d.style.right = 'auto'; d.style.width = '88%';
      d.style.top = customPosition.y + '%'; d.style.bottom = 'auto';
      d.style.transform = 'translate(-50%, -50%)'; d.style.textAlign = 'center';
    } else {
      if (pos.startsWith('top')) d.style.top = '6%';
      else if (pos.startsWith('bottom')) d.style.bottom = '6%';
      else { d.style.top = '50%'; d.style.transform = 'translateY(-50%)'; }
      if (pos.endsWith('left')) d.style.textAlign = 'left';
      else if (pos.endsWith('right')) d.style.textAlign = 'right';
    }
    if (it.karaoke) {
      const chars = Array.from(String(it.text || ''));
      const wordTimedChars = buildWordTimedChars(chars, it.words);
      const progress = Math.max(0, Math.min(1, (t - it.start) / Math.max(0.001, it.end - it.start)));
      const filled = Math.round(chars.length * progress);
      chars.forEach((ch, index) => {
        if (ch === '\n') { d.appendChild(document.createElement('br')); return; }
        const span = document.createElement('span');
        span.textContent = ch;
        if (wordTimedChars ? t >= wordTimedChars[index].end : index < filled) span.style.color = it.karaokeHighlightColor || '#ffd54a';
        d.appendChild(span);
      });
    } else {
      d.textContent = it.text;
    }
    layer.appendChild(d);
  }
}

function buildWordTimedChars(chars, words) {
  const list = Array.isArray(words) ? words.filter((word) => word && word.text && word.end > word.start) : [];
  if (!list.length) return null;
  const out = [];
  let cursor = 0;
  for (const word of list) {
    const tokenChars = Array.from(String(word.text));
    for (const tokenChar of tokenChars) {
      while (cursor < chars.length && /\s/.test(chars[cursor]) && !/\s/.test(tokenChar)) {
        out[cursor++] = { start: word.start, end: word.start };
      }
      if (cursor >= chars.length) break;
      out[cursor++] = { start: word.start, end: word.end };
    }
  }
  return out.length === chars.length ? out : null;
}

function renderOverlayLayer(t) {
  if (!state.trackControls.overlayVisible) { els.overlayLayer.innerHTML = ''; return; }
  const layer = els.overlayLayer;
  const [cw, ch] = ASPECTS[state.aspect];
  const sx = els.canvas.clientWidth / cw;
  const sy = els.canvas.clientHeight / ch;
  const wanted = new Set();
  for (const o of state.overlays) {
    if (t < o.start || t > o.end) continue;
    wanted.add(String(o.id));
    let node = layer.querySelector(`[data-overlay-id="${o.id}"]`);
    if (!node) {
      node = document.createElement(o.kind === 'video' ? 'video' : 'img');
      node.dataset.overlayId = String(o.id);
      node.src = o.url;
      if (o.kind === 'video') { node.muted = true; node.autoplay = true; node.loop = true; node.playsInline = true; }
      layer.appendChild(node);
    }
    const values = o.keyframes && o.keyframes.length ? keyframe.valuesAt(o, t) : null;
    node.style.width = (cw * (values ? values.scale : o.scale) * sx) + 'px';
    let x = values ? values.x : o.x, y = values ? values.y : o.y;
    if (!values && o.move) {
      const prog = Math.max(0, Math.min(1, (t - o.start) / Math.max(0.001, o.end - o.start)));
      x = o.x + (o.move.toX - o.x) * prog;
      y = o.y + (o.move.toY - o.y) * prog;
    }
    node.style.left = (x * sx) + 'px';
    node.style.top = (y * sy) + 'px';
    node.style.opacity = String(values ? values.opacity : o.opacity);
    node.style.transformOrigin = 'center center';
    node.style.transform = `rotate(${values ? values.rotation : (o.rotation || 0)}deg) scaleX(${o.mirrorX ? -1 : 1}) scaleY(${o.mirrorY ? -1 : 1})`;
    const crop = o.crop || {};
    node.style.clipPath = o.mask === 'ellipse' ? 'ellipse(50% 50% at 50% 50%)' : (o.mask === 'rounded' ? 'inset(0 round 12%)' : `inset(${(crop.top || 0) * 100}% ${(crop.right || 0) * 100}% ${(crop.bottom || 0) * 100}% ${(crop.left || 0) * 100}%)`);
    node.style.filter = o.maskFeather ? `blur(${Math.max(0, o.maskFeather) * 12}px)` : '';
    node.style.mixBlendMode = o.blendMode === 'addition' ? 'plus-lighter' : (o.blendMode || 'normal');
  }
  layer.querySelectorAll('[data-overlay-id]').forEach((node) => {
    if (!wanted.has(node.dataset.overlayId)) node.remove();
  });
}

function renderBrollLayer(t) {
  if (!state.trackControls.brollVisible) { els.brollLayer.innerHTML = ''; return; }
  const layer = els.brollLayer;
  const wanted = new Set();
  for (const broll of orderedVisibleBrolls()) {
    if (t < broll.start || t > broll.end) continue;
    wanted.add(String(broll.id));
    let node = layer.querySelector(`[data-broll-id="${broll.id}"]`);
    if (!node) {
      node = document.createElement('video');
      node.dataset.brollId = String(broll.id);
      node.src = broll.url; node.muted = true; node.autoplay = true; node.loop = broll.loop !== false; node.playsInline = true;
      layer.appendChild(node);
    }
    const [cw, ch] = ASPECTS[state.aspect];
    const sx = els.canvas.clientWidth / cw, sy = els.canvas.clientHeight / ch;
    node.style.left = ((broll.x || 0) * sx) + 'px'; node.style.top = ((broll.y || 0) * sy) + 'px';
    node.style.width = (els.canvas.clientWidth * (broll.scale == null ? 1 : broll.scale)) + 'px';
    node.style.height = (els.canvas.clientHeight * (broll.scale == null ? 1 : broll.scale)) + 'px';
    node.style.objectFit = 'cover'; node.style.opacity = String(broll.opacity);
    node.style.transformOrigin = 'center center'; node.style.transform = `rotate(${broll.rotation || 0}deg)`;
  }
  layer.querySelectorAll('[data-broll-id]').forEach((node) => {
    if (!wanted.has(node.dataset.brollId)) node.remove();
  });
}

function layerTransformValues(type, item, time) {
  if (type === 'overlay') {
    return item.keyframes && item.keyframes.length ? keyframe.valuesAt(item, time) : keyframe.baseValues(item);
  }
  return { x: item.x || 0, y: item.y || 0, scale: item.scale == null ? 1 : item.scale, opacity: item.opacity == null ? 1 : item.opacity, rotation: item.rotation || 0 };
}

function renderTransformLayer(t) {
  const layer = els.transformLayer;
  layer.innerHTML = '';
  // A hidden or locked layer must neither show selection handles nor allow
  // direct manipulation on the canvas.
  if (!state.trackControls.overlayVisible && activeTimelineItem.type === 'overlay') return;
  if (!state.trackControls.brollVisible && activeTimelineItem.type === 'broll') return;
  const [cw, ch] = ASPECTS[state.aspect];
  const sx = els.canvas.clientWidth / cw, sy = els.canvas.clientHeight / ch;
  let type = null, item = null;
  const overlay = findOverlay(state.selectedOverlayId);
  const broll = findBroll(state.selectedBrollId);
  if (activeTimelineItem.type === 'overlay' && overlay && !state.trackControls.overlayLocked && t >= overlay.start && t <= overlay.end) { type = 'overlay'; item = overlay; }
  else if (activeTimelineItem.type === 'broll' && broll && !state.trackControls.brollLocked && !(findVideoTrack(broll.trackId) || {}).locked && t >= broll.start && t <= broll.end) { type = 'broll'; item = broll; }
  if (!item) return;
  const values = layerTransformValues(type, item, t);
  const box = document.createElement('div');
  box.className = 'transform-box' + (type === 'broll' ? ' broll' : '');
  box.dataset.transformType = type; box.dataset.transformId = String(item.id);
  if (type === 'overlay') {
    const width = Math.max(24, cw * values.scale * sx);
    const height = item._w > 0 && item._h > 0 ? width * item._h / item._w : width * 0.56;
    box.style.left = (values.x * sx) + 'px'; box.style.top = (values.y * sy) + 'px';
    box.style.width = width + 'px'; box.style.height = height + 'px';
  } else {
    box.style.left = (values.x * sx) + 'px'; box.style.top = (values.y * sy) + 'px';
    box.style.width = (els.canvas.clientWidth * values.scale) + 'px'; box.style.height = (els.canvas.clientHeight * values.scale) + 'px';
  }
  box.style.transformOrigin = 'center center'; box.style.transform = `rotate(${values.rotation || 0}deg)`;
  const label = document.createElement('span'); label.className = 'transform-label'; label.textContent = type === 'broll' ? '视频层' : item.name;
  const scaleHandle = document.createElement('span'); scaleHandle.className = 'handle';
  const rotateHandle = document.createElement('span'); rotateHandle.className = 'rotate-handle';
  box.append(label, scaleHandle, rotateHandle);
  box.addEventListener('pointerdown', (event) => beginCanvasTransform(event, 'move', type, item));
  scaleHandle.addEventListener('pointerdown', (event) => beginCanvasTransform(event, 'scale', type, item));
  rotateHandle.addEventListener('pointerdown', (event) => beginCanvasTransform(event, 'rotate', type, item));
  layer.appendChild(box);
}

let canvasTransform = null;
function beginCanvasTransform(event, mode, type, item) {
  event.preventDefault(); event.stopPropagation();
  activateTimelineItem(type, item.id);
  const rect = els.canvas.getBoundingClientRect();
  const values = layerTransformValues(type, item, currentPreviewTime());
  canvasTransform = { mode, type, id: item.id, originX: event.clientX, originY: event.clientY, rect, values, snapshot: snapshot() };
  document.body.classList.add('canvas-transforming');
}
function applyCanvasTransform(event) {
  if (!canvasTransform) return;
  const item = canvasTransform.type === 'overlay' ? findOverlay(canvasTransform.id) : findBroll(canvasTransform.id);
  if (!item) return;
  const { mode, rect, values } = canvasTransform;
  const dx = (event.clientX - canvasTransform.originX) / Math.max(1, rect.width);
  const dy = (event.clientY - canvasTransform.originY) / Math.max(1, rect.height);
  if (mode === 'move') {
    applyLayerValues(item, canvasTransform.type, Object.assign({}, values, { x: values.x + dx * ASPECTS[state.aspect][0], y: values.y + dy * ASPECTS[state.aspect][1] }));
  } else if (mode === 'scale') {
    const scale = Math.max(0.02, Math.min(canvasTransform.type === 'broll' ? 2 : 1, values.scale * (1 + dx + dy)));
    applyLayerValues(item, canvasTransform.type, Object.assign({}, values, { scale }));
  } else if (mode === 'rotate') {
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const start = Math.atan2(canvasTransform.originY - cy, canvasTransform.originX - cx);
    const now = Math.atan2(event.clientY - cy, event.clientX - cx);
    applyLayerValues(item, canvasTransform.type, Object.assign({}, values, { rotation: values.rotation + (now - start) * 180 / Math.PI }));
  }
  syncPreviewStatics();
}
function endCanvasTransform() {
  if (!canvasTransform) return;
  if (canvasTransform.snapshot !== snapshot()) {
    undoStack.push(canvasTransform.snapshot);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0; scheduleRecovery(); updateHistoryButtons();
  }
  canvasTransform = null; document.body.classList.remove('canvas-transforming');
}
function applyLayerValues(item, type, values) {
  if (type === 'overlay' && item.keyframes && item.keyframes.length) {
    const time = currentPreviewTime();
    const frames = keyframe.normaliseKeyframes(item).filter((frame) => frame.time !== time);
    frames.push(Object.assign({ time, curve: 'linear' }, values));
    item.keyframes = frames.sort((a, b) => a.time - b.time);
  } else {
    Object.assign(item, values);
  }
}

function stopPreview() {
  playing = false;
  if (reversePreviewTimer) { clearInterval(reversePreviewTimer); reversePreviewTimer = null; }
  els.player.pause(); els.play.textContent = '▶ 播放';
}
function playPreview() {
  if (!state.clips.length) return;
  if (playing) { stopPreview(); return; }
  playing = true; els.play.textContent = '⏸ 暂停';
  if (accuratePreviewMode) { els.player.play().catch(() => {}); return; }
  previewIndex = Math.min(previewIndex, state.clips.length - 1);
  loadPreviewClip(previewIndex, true);
}
function loadPreviewClip(i, autoplay) {
  accuratePreviewMode = false;
  if (i >= state.clips.length) { stopPreview(); previewIndex = 0; return; }
  previewIndex = i;
  const clip = state.clips[i];
  if (!autoplay) {
    const before = state.clips.slice(0, i).reduce((sum, item) => sum + effDur(item), 0);
    playheadTime = timeline.previewToExportTime(before, previewDuration(), totalDuration());
  }
  const v = els.player;
  v.src = clip.proxyUrl || clip.url; v.muted = false; v.volume = Math.max(0, Math.min(1, state.originalVolume * clipAudioGainAt(clip, clip.trimStart)));
  v.style.filter = previewFilterForClip(clip);
  applyClipPreviewGeometry(clip);
  const onLoaded = () => {
    v.removeEventListener('loadedmetadata', onLoaded);
    try { v.currentTime = clip.trimStart; } catch {}
    v.playbackRate = clipSpeed(clip);
    v.volume = Math.max(0, Math.min(1, state.originalVolume * clipAudioGainAt(clip, v.currentTime)));
    if (autoplay && playing) v.play().catch(() => {});
  };
  v.addEventListener('loadedmetadata', onLoaded);
  v.load();
}

els.player.addEventListener('timeupdate', () => {
  if (accuratePreviewMode) {
    playheadTime = Math.max(0, Math.min(totalDuration(), Number(els.player.currentTime) || 0));
    els.timeLabel.textContent = `${playheadTime.toFixed(1)} / ${totalDuration().toFixed(1)}s`;
    syncTimelinePlayhead();
    return;
  }
  const clip = state.clips[previewIndex];
  if (!clip) return;
  const exportTime = currentPreviewTime();
  els.player.volume = Math.max(0, Math.min(1, state.originalVolume * clipAudioGainAt(clip, els.player.currentTime)));
  applyClipPreviewGeometry(clip, clipLocalPreviewTime(clip));
  playheadTime = exportTime;
  els.timeLabel.textContent = `${exportTime.toFixed(1)} / ${totalDuration().toFixed(1)}s`;
  renderTextLayer(exportTime);
  renderBrollLayer(exportTime);
  renderOverlayLayer(exportTime);
  renderTransformLayer(exportTime);
  syncTimelinePlayhead();
  if (playing && els.player.currentTime >= clip.trimEnd) loadPreviewClip(previewIndex + 1, true);
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function buildSpec() {
  const [w, h] = outputDimensions();
  const [baseW, baseH] = ASPECTS[state.aspect] || ASPECTS['16:9'];
  const scaleX = w / baseW;
  const scaleY = h / baseH;
  const scalePoint = (point) => point && {
    toX: Number(point.toX) * scaleX,
    toY: Number(point.toY) * scaleY,
  };
  const scaleFrames = (frames) => keyframe.normaliseKeyframes({ keyframes: frames }).map((frame) => Object.assign({}, frame, {
    x: frame.x * scaleX, y: frame.y * scaleY,
  }));
  const preset = EXPORT_PRESETS[state.exportPreset] || EXPORT_PRESETS.standard;
  return {
    clips: state.clips.map((c) => ({
      path: c.path, kind: c.kind || 'video', trimStart: c.trimStart, trimEnd: c.trimEnd, hasAudio: c.hasAudio, muted: !!c.muted,
      speed: clipSpeed(c), reverse: !!c.reverse, volume: c.volume == null ? 1 : c.volume, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, motion: c.motion, animationIn: c.animationIn, animationOut: c.animationOut, stabilize: c.stabilize || 'off',
      opacity: c.opacity == null ? 1 : c.opacity, fillMode: c.fillMode || undefined, color: c.color, effect: c.effect || 'none', vignette: c.vignette || 0, grain: c.grain || 0, rotation: c.rotation || 0, mirrorX: !!c.mirrorX, mirrorY: !!c.mirrorY, transformScale: c.transformScale == null ? 1 : c.transformScale, transformX: c.transformX || 0, transformY: c.transformY || 0, crop: c.crop,
      transformKeyframes: c.transformKeyframes,
      transitionToNext: c.transitionToNext,
    })),
    overlays: state.overlays.map((o) => ({
      path: o.path, kind: o.kind, start: o.start, end: o.end,
      x: o.x * scaleX, y: o.y * scaleY, scale: o.scale, rotation: o.rotation || 0, opacity: o.opacity,
      fadeDuration: o.fade || 0, move: scalePoint(o.move),
      keyframes: o.keyframes && o.keyframes.length ? scaleFrames(o.keyframes) : undefined,
    })).filter(() => state.trackControls.overlayVisible),
    brolls: orderedVisibleBrolls().map((broll) => ({
      path: broll.path, kind: 'video', start: broll.start, end: broll.end, trimStart: broll.trimStart || 0,
      loop: broll.loop !== false, fit: 'cover', x: (broll.x || 0) * scaleX, y: (broll.y || 0) * scaleY, scale: broll.scale == null ? 1 : broll.scale, rotation: broll.rotation || 0, opacity: broll.opacity, fadeDuration: broll.fade || 0,
    })).filter(() => state.trackControls.brollVisible),
    texts: state.texts.map((t) => ({
      text: [t.text, t.secondaryText].filter(Boolean).join('\n'), start: t.start, end: t.end, position: t.position,
      fontSize: t.fontSize * Math.min(scaleX, scaleY), fontFamily: t.fontFamily || 'sans-serif', bold: !!t.bold, italic: !!t.italic, alpha: t.opacity == null ? 1 : t.opacity, xPercent: t.xPercent, yPercent: t.yPercent, primaryColor: t.color, outlineColor: t.outlineColor, outline: t.outlineWidth == null ? 2 : t.outlineWidth, shadow: t.shadow || 0, spacing: t.spacing || 0, fade: t.fade || 0,
      karaoke: !!t.karaoke, karaokeHighlightColor: t.karaokeHighlightColor || '#ffd54a',
    })).filter(() => state.trackControls.textVisible),
    bgm: state.bgm ? { path: state.bgm.path, trimStart: state.bgm.trimStart || 0, fadeIn: state.bgm.fadeIn || 0, fadeOut: state.bgm.fadeOut || 0 } : null,
    audioTracks: state.audioTracks.map((track) => ({
      path: track.path, start: track.start, end: track.end, trimStart: track.trimStart || 0,
      speed: track.speed || 1, reverse: !!track.reverse, pitch: track.pitch || 0, denoise: !!track.denoise, voiceEnhance: !!track.voiceEnhance, volume: track.volume, fadeIn: track.fadeIn || 0, fadeOut: track.fadeOut || 0, muteRanges: normaliseAudioMuteRanges(track), loop: !!track.loop,
    })).filter(() => !state.trackControls.audioMuted),
    settings: {
      width: w, height: h, fps: state.frameRate || 30, fillMode: state.fillMode, backgroundColor: state.canvasColor || '#000000',
      originalVolume: state.originalVolume, bgmVolume: state.bgmVolume,
      bgmDuck: state.bgmDuck, bgmDuckAmount: state.bgmDuckAmount, loudnessNormalize: state.loudnessNormalize,
      crf: preset.crf, preset: preset.preset, audioBitrate: preset.audioBitrate,
    },
  };
}

async function doExport() {
  if (exporting || !state.clips.length) return;
  stopPreview();
  exporting = true; state.exportedPath = null;
  els.export.disabled = true; els.reveal.classList.add('hidden');
  els.progressWrap.classList.remove('hidden'); els.progress.value = 0;
  setStatus('正在导出…');
  const unsub = api.onExportProgress((p) => { els.progress.value = p; });
  try {
    const res = await api.exportTimeline(buildSpec());
    if (res.canceled) setStatus('已取消导出');
    else if (res.error) setStatus('导出失败：' + res.error);
    else { state.exportedPath = res.output; setStatus('导出完成 ✅ ' + res.output); els.reveal.classList.remove('hidden'); }
  } catch (e) {
    setStatus('导出出错：' + (e && e.message ? e.message : String(e)));
  } finally {
    unsub(); exporting = false;
    els.progressWrap.classList.add('hidden');
    els.export.disabled = !state.clips.length;
  }
}

async function renderAccuratePreview() {
  if (exporting || !state.clips.length) return;
  if (accuratePreviewMode && !accuratePreviewDirty) {
    accuratePreviewMode = false;
    loadPreviewClip(previewIndex, false);
    setStatus('已返回普通代理预览');
    renderAll();
    return;
  }
  stopPreview();
  exporting = true;
  els.renderPreview.disabled = true;
  els.progressWrap.classList.remove('hidden'); els.progress.value = 0;
  setStatus('正在渲染成片预览…');
  const unsub = api.onPreviewProgress((p) => { els.progress.value = p; });
  try {
    const res = await api.renderPreview(buildSpec());
    if (!res.ok) setStatus('成片预览失败：' + res.error);
    else {
      accuratePreviewMode = true;
      accuratePreviewDirty = false;
      els.player.src = res.url; els.player.muted = false; els.player.playbackRate = 1;
      els.player.style.filter = ''; els.player.style.transform = ''; els.player.style.clipPath = ''; els.player.style.opacity = '1';
      els.textLayer.innerHTML = ''; els.brollLayer.innerHTML = ''; els.overlayLayer.innerHTML = ''; els.transformLayer.innerHTML = '';
      els.player.load();
      setStatus('成片预览已就绪：含转场、字幕、图层和混音效果');
    }
  } catch (e) {
    setStatus('成片预览出错：' + (e && e.message ? e.message : String(e)));
  } finally {
    unsub(); exporting = false;
    els.progressWrap.classList.add('hidden');
    if (!accuratePreviewMode) renderAll();
  }
}

// ---------------------------------------------------------------------------
// Wire events
// ---------------------------------------------------------------------------

els.openProject.addEventListener('click', openProject);
els.saveProject.addEventListener('click', saveProject);
els.packageProject.addEventListener('click', packageProject);
els.relinkMedia.addEventListener('click', relinkMissingMedia);
els.import.addEventListener('click', importVideos);
els.insertClip.addEventListener('click', insertClipAtSelection);
els.overwriteClip.addEventListener('click', overwriteSelectedClip);
els.rippleDelete.addEventListener('click', rippleDeleteSelectedClip);
els.extractAudio.addEventListener('click', extractAudioFromSelectedClip);
els.exportPreset.addEventListener('change', () => { recordUndo(); state.exportPreset = els.exportPreset.value; });
els.lockVideoTrack.addEventListener('click', () => { recordUndo(); state.videoTrackLocked = !state.videoTrackLocked; renderAll(); });
els.toggleBroll.addEventListener('click', () => { recordUndo(); state.trackControls.brollVisible = !state.trackControls.brollVisible; renderAll(); });
els.lockBroll.addEventListener('click', () => { recordUndo(); state.trackControls.brollLocked = !state.trackControls.brollLocked; renderAll(); });
els.toggleOverlay.addEventListener('click', () => { recordUndo(); state.trackControls.overlayVisible = !state.trackControls.overlayVisible; renderAll(); });
els.lockOverlay.addEventListener('click', () => { recordUndo(); state.trackControls.overlayLocked = !state.trackControls.overlayLocked; renderAll(); });
els.toggleText.addEventListener('click', () => { recordUndo(); state.trackControls.textVisible = !state.trackControls.textVisible; renderAll(); });
els.lockText.addEventListener('click', () => { recordUndo(); state.trackControls.textLocked = !state.trackControls.textLocked; renderAll(); });
els.muteAudio.addEventListener('click', () => { recordUndo(); state.trackControls.audioMuted = !state.trackControls.audioMuted; renderAll(); });
els.lockAudio.addEventListener('click', () => { recordUndo(); state.trackControls.audioLocked = !state.trackControls.audioLocked; renderAll(); });
els.export.addEventListener('click', doExport);
els.renderPreview.addEventListener('click', renderAccuratePreview);
els.timelineZoomOut.addEventListener('click', () => changeTimelineZoom(1 / 1.25));
els.timelineZoomIn.addEventListener('click', () => changeTimelineZoom(1.25));
els.timelineFit.addEventListener('click', fitTimeline);
els.toggleSnap.addEventListener('click', () => { recordUndo(); state.snapEnabled = !state.snapEnabled; hideTimelineSnapGuide(); renderTimeline(); });
els.timelineViewport.addEventListener('wheel', handleTimelineWheel, { passive: false });
els.addMarker.addEventListener('click', addMarkerAtPlayhead);
els.prevMarker.addEventListener('click', () => jumpMarker(-1));
els.nextMarker.addEventListener('click', () => jumpMarker(1));
els.deleteMarker.addEventListener('click', deleteSelectedMarker);
els.markerName.addEventListener('focus', () => { markerNameSnapshot = snapshot(); });
els.markerName.addEventListener('input', () => {
  const marker = selectedMarker();
  if (!marker) return;
  marker.name = els.markerName.value.slice(0, 120);
  renderTimelineMarkers();
});
els.markerName.addEventListener('change', commitMarkerName);
els.markerName.addEventListener('blur', commitMarkerName);
els.timelineTimecode.addEventListener('change', () => {
  const time = timeline.parseTimecode(els.timelineTimecode.value);
  if (time == null) { els.timelineTimecode.value = timeline.formatTimecode(playheadTime); setStatus('时间码格式无效'); return; }
  stopPreview();
  seekTimelineTime(Math.min(totalDuration(), time), false);
});
els.timelineTimecode.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); els.timelineTimecode.dispatchEvent(new Event('change')); els.timelineTimecode.blur(); }
});
els.timelineTrack.addEventListener('pointerdown', handleTimelinePointer);
document.addEventListener('pointermove', handleTimelinePointerMove);
document.addEventListener('pointerup', stopTimelinePointer);
document.addEventListener('pointermove', applyCanvasTransform);
document.addEventListener('pointerup', endCanvasTransform);
els.undo.addEventListener('click', undo);
els.redo.addEventListener('click', redo);
els.play.addEventListener('click', playPreview);
els.cancel.addEventListener('click', () => api.cancelExport());
els.reveal.addEventListener('click', () => state.exportedPath && api.revealFile(state.exportedPath));
els.splitClip.addEventListener('click', splitSelectedClip);
els.duplicateClip.addEventListener('click', duplicateSelectedClip);
els.freezeFrame.addEventListener('click', createFreezeFrameAtPlayhead);
els.toggleClipMute.addEventListener('click', toggleSelectedClipMute);
els.copyClipAppearance.addEventListener('click', copyClipAppearance);
els.pasteClipAppearance.addEventListener('click', pasteClipAppearance);
els.removeSilence.addEventListener('click', removeSilenceFromSelectedClip);
els.detectBeats.addEventListener('click', detectBeatsForSelectedClip);
els.detectScenes.addEventListener('click', detectScenesForSelectedClip);
els.stepBack.addEventListener('click', () => stepPreviewFrame(-1));
els.stepForward.addEventListener('click', () => stepPreviewFrame(1));

// clip inspector
function withClip(fn) { const c = findClip(state.selectedClipId); if (c) { fn(c); } }
let clipNameSnapshot = null;
function commitClipName() {
  if (clipNameSnapshot != null && clipNameSnapshot !== snapshot()) {
    undoStack.push(clipNameSnapshot);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    scheduleRecovery();
    updateHistoryButtons();
  }
  clipNameSnapshot = null;
}
els.clipName.addEventListener('focus', () => { clipNameSnapshot = snapshot(); });
els.clipName.addEventListener('input', () => withClip((clip) => {
  clip.name = els.clipName.value.slice(0, 160);
  els.clipTitle.textContent = clip.name || '片段';
  renderTimeline();
}));
els.clipName.addEventListener('change', commitClipName);
els.clipName.addEventListener('blur', commitClipName);
function trimInput(which) {
  const el = which === 'start' ? els.trimStart : els.trimEnd;
  el.addEventListener('pointerdown', beginInspectorTrimEdit);
  el.addEventListener('focus', beginInspectorTrimEdit);
  el.addEventListener('keydown', beginInspectorTrimEdit);
  el.addEventListener('input', () => withClip((c) => {
    const value = parseFloat(el.value);
    if (which === 'start') c.trimStart = Math.max(0, Math.min(value, c.trimEnd - 0.1));
    else c.trimEnd = Math.min(c.sourceDuration, Math.max(value, c.trimStart + 0.1));
    els.trimStartVal.textContent = `${c.trimStart.toFixed(1)}s`;
    els.trimEndVal.textContent = `${c.trimEnd.toFixed(1)}s`;
    els.trimDurationVal.textContent = `保留 ${rawDur(c).toFixed(1)}s · 成片占用 ${effDur(c).toFixed(1)}s`;
    renderTimeline();
    if (!playing && c.id === state.selectedClipId) {
      if (els.player.src !== c.url) els.player.src = c.url;
      try { els.player.currentTime = which === 'start' ? c.trimStart : Math.max(c.trimStart, c.trimEnd - 0.05); } catch {}
    }
    els.timeLabel.textContent = `0.0 / ${totalDuration().toFixed(1)}s`;
  }));
  el.addEventListener('change', commitInspectorTrimEdit);
  el.addEventListener('blur', commitInspectorTrimEdit);
}
trimInput('start');
trimInput('end');
els.imageDuration.addEventListener('change', () => withClip((c) => {
  if (c.kind !== 'image') return;
  const duration = Math.max(0.1, Math.min(60, parseFloat(els.imageDuration.value) || 3));
  recordUndo();
  c.sourceDuration = duration; c.trimStart = 0; c.trimEnd = duration;
  c.proxyUrl = ''; createProxyForClip(c);
  renderAll();
}));
els.speed.addEventListener('pointerdown', beginInteractiveEdit);
els.speed.addEventListener('input', () => withClip((c) => { c.speed = parseFloat(els.speed.value); els.speedVal.textContent = `${c.speed.toFixed(2).replace(/\.?0+$/, '')}×`; els.player.playbackRate = clipSpeed(c); els.timeLabel.textContent = `0.0 / ${totalDuration().toFixed(1)}s`; }));
els.speed.addEventListener('change', () => { commitInteractiveEdit(); renderTimeline(); });
els.speedChips.querySelectorAll('.chip').forEach((ch) => ch.addEventListener('click', () => withClip((c) => { recordUndo(); c.speed = parseFloat(ch.dataset.speed); renderAll(); })));
els.applySpeedCurve.addEventListener('click', applySpeedCurvePreset);
els.clipVolume.addEventListener('pointerdown', beginInteractiveEdit);
els.clipVolume.addEventListener('input', () => withClip((c) => {
  c.volume = Math.max(0, Math.min(2, parseFloat(els.clipVolume.value) || 0));
  els.clipVolumeVal.textContent = Math.round(c.volume * 100) + '%';
  if (state.clips[previewIndex] === c) els.player.volume = Math.max(0, Math.min(1, state.originalVolume * clipAudioGainAt(c, els.player.currentTime)));
}));
els.clipVolume.addEventListener('change', commitInteractiveEdit);
els.clipFadeIn.addEventListener('change', () => withClip((c) => { recordUndo(); c.fadeIn = Math.max(0, Math.min(10, parseFloat(els.clipFadeIn.value) || 0)); syncPreviewStatics(); }));
els.clipFadeOut.addEventListener('change', () => withClip((c) => { recordUndo(); c.fadeOut = Math.max(0, Math.min(10, parseFloat(els.clipFadeOut.value) || 0)); syncPreviewStatics(); }));
els.reverse.addEventListener('change', () => withClip((c) => { recordUndo(); c.reverse = els.reverse.checked; renderTimeline(); }));
els.motion.addEventListener('change', () => withClip((c) => { recordUndo(); c.motion = els.motion.value; renderTimeline(); }));
function setClipAnimation(which, style, duration) {
  withClip((c) => {
    recordUndo();
    const key = which === 'in' ? 'animationIn' : 'animationOut';
    c[key] = {
      style: ['none', 'fade', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'].includes(style) ? style : 'none',
      duration: Math.max(0, Math.min(2, Number(duration) || 0)),
    };
    renderAll();
  });
}
els.animationInStyle.addEventListener('change', () => setClipAnimation('in', els.animationInStyle.value, els.animationInDuration.value));
els.animationInDuration.addEventListener('change', () => setClipAnimation('in', els.animationInStyle.value, els.animationInDuration.value));
els.animationOutStyle.addEventListener('change', () => setClipAnimation('out', els.animationOutStyle.value, els.animationOutDuration.value));
els.animationOutDuration.addEventListener('change', () => setClipAnimation('out', els.animationOutStyle.value, els.animationOutDuration.value));
els.stabilize.addEventListener('change', () => withClip((c) => { recordUndo(); c.stabilize = els.stabilize.value; renderAll(); }));
els.clipFill.addEventListener('change', () => withClip((c) => { recordUndo(); c.fillMode = els.clipFill.value; }));
els.clipMirrorX.addEventListener('change', () => withClip((c) => { recordUndo(); c.mirrorX = els.clipMirrorX.checked; syncPreviewStatics(); }));
els.clipMirrorY.addEventListener('change', () => withClip((c) => { recordUndo(); c.mirrorY = els.clipMirrorY.checked; syncPreviewStatics(); }));
els.clipRotation.addEventListener('pointerdown', beginInteractiveEdit);
els.clipRotation.addEventListener('input', () => withClip((c) => { c.rotation = parseFloat(els.clipRotation.value) || 0; els.clipRotationVal.textContent = Math.round(c.rotation) + '°'; syncPreviewStatics(); }));
els.clipRotation.addEventListener('change', commitInteractiveEdit);
els.clipOpacity.addEventListener('pointerdown', beginInteractiveEdit);
els.clipOpacity.addEventListener('input', () => withClip((c) => {
  c.opacity = Math.max(0, Math.min(1, parseFloat(els.clipOpacity.value) || 0));
  els.clipOpacityVal.textContent = Math.round(c.opacity * 100) + '%';
  applyClipPreviewGeometry(c);
}));
els.clipOpacity.addEventListener('change', commitInteractiveEdit);
els.addClipTransformKeyframe.addEventListener('click', () => withClip((clip) => {
  if (!clipTransform) return;
  const duration = clipTransform.durationOf(clip);
  const requested = parseFloat(els.clipTransformKeyframeTime.value);
  const time = Math.max(0, Math.min(duration, Number.isFinite(requested) ? requested : currentClipLocalTime(clip)));
  const frames = clipTransform.normalise(clip).filter((frame) => frame.time !== time);
  frames.push(clipTransform.frameFrom({
    x: clip.transformX || 0, y: clip.transformY || 0,
    scale: clip.transformScale == null ? 1 : clip.transformScale,
    opacity: clip.opacity == null ? 1 : clip.opacity,
  }, time, els.clipTransformKeyframeCurve.value));
  recordUndo();
  clip.transformKeyframes = frames.sort((a, b) => a.time - b.time);
  renderAll();
}));
function clipCropUpdate(key, el) {
  el.addEventListener('change', () => withClip((c) => {
    recordUndo();
    c.crop = c.crop || { left: 0, right: 0, top: 0, bottom: 0 };
    c.crop[key] = Math.max(0, Math.min(0.45, (parseFloat(el.value) || 0) / 100));
    syncPreviewStatics();
  }));
}
clipCropUpdate('left', els.clipCropLeft); clipCropUpdate('right', els.clipCropRight);
clipCropUpdate('top', els.clipCropTop); clipCropUpdate('bottom', els.clipCropBottom);
els.clipTransformScale.addEventListener('pointerdown', beginInteractiveEdit);
els.clipTransformScale.addEventListener('input', () => withClip((c) => {
  c.transformScale = Math.max(0.5, Math.min(2, parseFloat(els.clipTransformScale.value) || 1));
  els.clipTransformScaleVal.textContent = Math.round(c.transformScale * 100) + '%';
  syncPreviewStatics();
}));
els.clipTransformScale.addEventListener('change', commitInteractiveEdit);
function clipTransformPositionUpdate(key, el) {
  el.addEventListener('change', () => withClip((c) => {
    recordUndo();
    c[key] = Math.max(-100, Math.min(100, parseFloat(el.value) || 0));
    syncPreviewStatics();
  }));
}
clipTransformPositionUpdate('transformX', els.clipTransformX);
clipTransformPositionUpdate('transformY', els.clipTransformY);

function colorInput(el, key, valEl, fmt) {
  el.addEventListener('pointerdown', beginInteractiveEdit);
  el.addEventListener('input', () => withClip((c) => { c.color = c.color || {}; c.color[key] = parseFloat(el.value); valEl.textContent = fmt(c.color[key]); els.player.style.filter = previewFilterForClip(c); }));
  el.addEventListener('change', () => { commitInteractiveEdit(); renderTimeline(); });
}
colorInput(els.brightness, 'brightness', els.briVal, (v) => String(v));
colorInput(els.contrast, 'contrast', els.conVal, (v) => v.toFixed(2));
colorInput(els.saturation, 'saturation', els.satVal, (v) => v.toFixed(2));
colorInput(els.temperature, 'temperature', els.tempVal, (v) => String(v));
colorInput(els.hue, 'hue', els.hueVal, (v) => String(v) + '°');
colorInput(els.gamma, 'gamma', els.gammaVal, (v) => v.toFixed(2));
els.colorCurve.addEventListener('change', () => withClip((c) => { recordUndo(); c.color = c.color || {}; c.color.curve = els.colorCurve.value; }));
els.pickLut.addEventListener('click', async () => {
  const res = await api.pickLut();
  if (res.canceled) return;
  if (res.error) { setStatus('导入 LUT 失败：' + res.error); return; }
  withClip((c) => { recordUndo(); c.color = c.color || {}; c.color.lutPath = res.path; renderClipInspector(); });
});
els.clearLut.addEventListener('click', () => withClip((c) => { recordUndo(); c.color = c.color || {}; c.color.lutPath = ''; renderClipInspector(); }));
els.colorPresets.querySelectorAll('.chip').forEach((ch) => ch.addEventListener('click', () => withClip((c) => { recordUndo(); c.color = Object.assign({}, COLOR_PRESETS[ch.dataset.preset]); renderAll(); })));
els.effectPresets.querySelectorAll('.chip').forEach((ch) => ch.addEventListener('click', () => withClip((c) => { recordUndo(); c.effect = ch.dataset.effect; renderAll(); })));
function finishingInput(el, key, valueEl) {
  el.addEventListener('pointerdown', beginInteractiveEdit);
  el.addEventListener('input', () => withClip((c) => {
    c[key] = Math.max(0, Math.min(1, parseFloat(el.value) || 0));
    valueEl.textContent = Math.round(c[key] * 100) + '%';
    els.player.style.filter = previewFilterForClip(c);
  }));
  el.addEventListener('change', commitInteractiveEdit);
}
finishingInput(els.vignette, 'vignette', els.vignetteVal);
finishingInput(els.grain, 'grain', els.grainVal);

// transition style dropdown (populated once)
XFADE_STYLES.forEach(([val, label]) => { const o = document.createElement('option'); o.value = val; o.textContent = label; els.transStyle.appendChild(o); });
els.transStyle.addEventListener('change', () => withClip((c) => { recordUndo(); c.transitionToNext = c.transitionToNext || {}; c.transitionToNext.style = els.transStyle.value; if ((c.transitionToNext.duration || 0) === 0 && els.transStyle.value !== 'none') c.transitionToNext.duration = 0.5; renderAll(); }));
els.transDur.addEventListener('pointerdown', beginInteractiveEdit);
els.transDur.addEventListener('input', () => withClip((c) => { c.transitionToNext = c.transitionToNext || {}; c.transitionToNext.duration = parseFloat(els.transDur.value); els.transDurVal.textContent = `${c.transitionToNext.duration.toFixed(1)}s`; els.timeLabel.textContent = `0.0 / ${totalDuration().toFixed(1)}s`; }));
els.transDur.addEventListener('change', () => { commitInteractiveEdit(); renderTimeline(); });

// canvas pane
els.aspectChips.querySelectorAll('.chip').forEach((ch) => ch.addEventListener('click', () => { recordUndo(); state.aspect = ch.dataset.aspect; renderAll(); }));
els.fillMode.addEventListener('change', () => { recordUndo(); state.fillMode = els.fillMode.value; });
els.canvasColor.addEventListener('change', () => { recordUndo(); state.canvasColor = els.canvasColor.value; renderCanvasPane(); });
els.outputProfile.addEventListener('change', () => { recordUndo(); state.outputProfile = els.outputProfile.value; renderCanvasPane(); });
els.frameRate.addEventListener('change', () => { recordUndo(); state.frameRate = Number(els.frameRate.value) || 30; renderCanvasPane(); });

// text pane
els.addText.addEventListener('click', () => {
  recordUndo();
  const t = { id: ++seq, text: '新文字', start: 0, end: Math.min(2, totalDuration() || 2), position: 'bottom', fontSize: 48, fontFamily: 'sans-serif', bold: false, italic: false, opacity: 1, color: '#ffffff', outlineColor: '#000000', outlineWidth: 2, shadow: 0, spacing: 0, karaoke: false, karaokeHighlightColor: '#ffd54a', isCaption: false, fade: 0 };
  state.texts.push(t); state.selectedTextId = t.id; activeTimelineItem = { type: 'text', id: t.id }; switchTab('text'); renderTextPane(); renderTimeline();
});
els.autoSub.addEventListener('click', autoSubtitle);
els.autoSubAll.addEventListener('click', autoSubtitleAll);
els.importSrt.addEventListener('click', importSrt);
els.exportSrt.addEventListener('click', exportSrt);
els.applyCaptionPreset.addEventListener('click', applyCaptionPreset);
els.replaceCaptions.addEventListener('click', replaceCaptions);
function withText(fn, record) { const t = findText(state.selectedTextId); if (t) { if (record) recordUndo(); fn(t); } }
let textTypingSnapshot = null;
els.textContent.addEventListener('focus', () => { textTypingSnapshot = snapshot(); });
els.textContent.addEventListener('input', () => withText((t) => {
  t.text = els.textContent.value;
  // Do not rerender the pane while typing (that would reset the caret).
  const active = els.textList.querySelector('.item.active .item-main');
  if (active) active.textContent = t.text || '(空)';
  syncPreviewStatics();
}));
els.textContent.addEventListener('blur', () => {
  if (textTypingSnapshot != null && textTypingSnapshot !== snapshot()) {
    undoStack.push(textTypingSnapshot);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
    scheduleRecovery();
  }
  textTypingSnapshot = null;
});
els.textSecondary.addEventListener('change', () => withText((t) => { t.secondaryText = els.textSecondary.value; }, true));
els.textStart.addEventListener('change', () => withText((t) => { t.start = parseFloat(els.textStart.value) || 0; renderTextPane(); }, true));
els.textEnd.addEventListener('change', () => withText((t) => { t.end = parseFloat(els.textEnd.value) || 0; renderTextPane(); }, true));
els.textPos.addEventListener('change', () => withText((t) => { t.position = els.textPos.value; syncPreviewStatics(); }, true));
els.textSize.addEventListener('change', () => withText((t) => { t.fontSize = parseInt(els.textSize.value, 10) || 48; syncPreviewStatics(); }, true));
function customTextPositionUpdate(key, el) {
  el.addEventListener('pointerdown', beginInteractiveEdit);
  el.addEventListener('input', () => withText((t) => {
    t[key] = Math.max(0, Math.min(100, parseFloat(el.value) || 0));
    syncPreviewStatics();
  }));
  el.addEventListener('change', () => { commitInteractiveEdit(); renderTextPane(); });
}
customTextPositionUpdate('xPercent', els.textXPercent);
customTextPositionUpdate('yPercent', els.textYPercent);
els.resetTextPosition.addEventListener('click', () => withText((t) => {
  recordUndo(); delete t.xPercent; delete t.yPercent; renderTextPane(); syncPreviewStatics();
}));
els.textFontFamily.addEventListener('change', () => withText((t) => { t.fontFamily = els.textFontFamily.value; syncPreviewStatics(); }, true));
els.textBold.addEventListener('change', () => withText((t) => { t.bold = els.textBold.checked; syncPreviewStatics(); }, true));
els.textItalic.addEventListener('change', () => withText((t) => { t.italic = els.textItalic.checked; syncPreviewStatics(); }, true));
els.textColor.addEventListener('change', () => withText((t) => { t.color = els.textColor.value; syncPreviewStatics(); }, true));
els.textOutline.addEventListener('change', () => withText((t) => { t.outlineColor = els.textOutline.value; }, true));
els.textFade.addEventListener('change', () => withText((t) => { t.fade = parseFloat(els.textFade.value) || 0; }, true));
els.textOutlineWidth.addEventListener('change', () => withText((t) => { t.outlineWidth = Math.max(0, Math.min(12, parseFloat(els.textOutlineWidth.value) || 0)); syncPreviewStatics(); }, true));
els.textShadow.addEventListener('change', () => withText((t) => { t.shadow = Math.max(0, Math.min(12, parseFloat(els.textShadow.value) || 0)); syncPreviewStatics(); }, true));
els.textSpacing.addEventListener('change', () => withText((t) => { t.spacing = Math.max(-5, Math.min(20, parseFloat(els.textSpacing.value) || 0)); syncPreviewStatics(); }, true));
els.textOpacity.addEventListener('pointerdown', beginInteractiveEdit);
els.textOpacity.addEventListener('input', () => withText((t) => { t.opacity = parseFloat(els.textOpacity.value); els.textOpacityVal.textContent = Math.round(t.opacity * 100) + '%'; syncPreviewStatics(); }));
els.textOpacity.addEventListener('change', commitInteractiveEdit);
els.textKaraoke.addEventListener('change', () => withText((t) => { t.karaoke = els.textKaraoke.checked; }, true));
els.textHighlightColor.addEventListener('change', () => withText((t) => { t.karaokeHighlightColor = els.textHighlightColor.value; }, true));
els.splitCaption.addEventListener('click', splitSelectedCaption);
els.mergeCaption.addEventListener('click', mergeSelectedCaption);
els.deleteText.addEventListener('click', () => { const t = findText(state.selectedTextId); if (!t) return; recordUndo(); state.texts = state.texts.filter((x) => x.id !== t.id); state.selectedTextId = null; renderTextPane(); renderTimeline(); });

// overlay pane
els.addBroll.addEventListener('click', addBroll);
els.addVideoTrack.addEventListener('click', addVideoTrack);
els.videoTrackSelect.addEventListener('change', () => { state.selectedVideoTrackId = els.videoTrackSelect.value; renderBrollPane(); renderSecondaryTimelineTracks(); });
els.videoTrackUp.addEventListener('click', () => moveVideoTrack(1));
els.videoTrackDown.addEventListener('click', () => moveVideoTrack(-1));
els.toggleVideoTrack.addEventListener('click', () => { const track = findVideoTrack(state.selectedVideoTrackId); if (!track) return; recordUndo(); track.visible = track.visible === false; renderAll(); });
els.lockVideoLayerTrack.addEventListener('click', () => { const track = findVideoTrack(state.selectedVideoTrackId); if (!track) return; recordUndo(); track.locked = !track.locked; renderAll(); });
els.deleteVideoTrack.addEventListener('click', deleteSelectedVideoTrack);
function withBroll(fn, record) { const broll = findBroll(state.selectedBrollId); if (broll) { if (record) recordUndo(); fn(broll); } }
els.brollStart.addEventListener('change', () => withBroll((broll) => { broll.start = Math.max(0, parseFloat(els.brollStart.value) || 0); if (broll.end <= broll.start) broll.end = broll.start + 0.1; renderAll(); }, true));
els.brollEnd.addEventListener('change', () => withBroll((broll) => { broll.end = Math.max(broll.start + 0.1, parseFloat(els.brollEnd.value) || (broll.start + 0.1)); renderAll(); }, true));
els.brollTrimStart.addEventListener('change', () => withBroll((broll) => { broll.trimStart = Math.max(0, parseFloat(els.brollTrimStart.value) || 0); }, true));
els.brollTrackSelect.addEventListener('change', () => withBroll((broll) => {
  const target = findVideoTrack(els.brollTrackSelect.value);
  if (target && target.locked) { setStatus('目标视频轨已锁定'); renderBrollPane(); return; }
  broll.trackId = els.brollTrackSelect.value; state.selectedVideoTrackId = broll.trackId; renderAll();
}, true));
els.brollLoop.addEventListener('change', () => withBroll((broll) => { broll.loop = els.brollLoop.checked; }, true));
els.brollOpacity.addEventListener('pointerdown', beginInteractiveEdit);
els.brollOpacity.addEventListener('input', () => withBroll((broll) => { broll.opacity = parseFloat(els.brollOpacity.value); els.brollOpacityVal.textContent = Math.round(broll.opacity * 100) + '%'; syncPreviewStatics(); }));
els.brollOpacity.addEventListener('change', commitInteractiveEdit);
els.brollRotation.addEventListener('pointerdown', beginInteractiveEdit);
els.brollRotation.addEventListener('input', () => withBroll((broll) => { broll.rotation = parseFloat(els.brollRotation.value) || 0; els.brollRotationVal.textContent = Math.round(broll.rotation) + '°'; syncPreviewStatics(); }));
els.brollRotation.addEventListener('change', commitInteractiveEdit);
els.brollFade.addEventListener('change', () => withBroll((broll) => { broll.fade = Math.max(0, parseFloat(els.brollFade.value) || 0); }, true));
els.deleteBroll.addEventListener('click', () => { const broll = findBroll(state.selectedBrollId); if (!broll) return; recordUndo(); state.brolls = state.brolls.filter((item) => item.id !== broll.id); state.selectedBrollId = null; renderAll(); });
els.brollLayerUp.addEventListener('click', () => moveLayer(state.brolls, state.selectedBrollId, 1));
els.brollLayerDown.addEventListener('click', () => moveLayer(state.brolls, state.selectedBrollId, -1));

els.addOverlay.addEventListener('click', addOverlay);
els.overlayLayerUp.addEventListener('click', () => moveLayer(state.overlays, state.selectedOverlayId, 1));
els.overlayLayerDown.addEventListener('click', () => moveLayer(state.overlays, state.selectedOverlayId, -1));
function withOverlay(fn, record) { const o = findOverlay(state.selectedOverlayId); if (o) { if (record) recordUndo(); fn(o); } }
els.ovStart.addEventListener('change', () => withOverlay((o) => { o.start = parseFloat(els.ovStart.value) || 0; renderOverlayPane(); }, true));
els.ovEnd.addEventListener('change', () => withOverlay((o) => { o.end = parseFloat(els.ovEnd.value) || 0; renderOverlayPane(); }, true));
els.ovScale.addEventListener('pointerdown', beginInteractiveEdit);
els.ovScale.addEventListener('input', () => withOverlay((o) => { o.scale = parseFloat(els.ovScale.value); els.ovScaleVal.textContent = Math.round(o.scale * 100) + '%'; syncPreviewStatics(); }));
els.ovScale.addEventListener('change', commitInteractiveEdit);
els.ovX.addEventListener('change', () => withOverlay((o) => { o.x = parseFloat(els.ovX.value) || 0; syncPreviewStatics(); }, true));
els.ovY.addEventListener('change', () => withOverlay((o) => { o.y = parseFloat(els.ovY.value) || 0; syncPreviewStatics(); }, true));
els.ovOpacity.addEventListener('pointerdown', beginInteractiveEdit);
els.ovOpacity.addEventListener('input', () => withOverlay((o) => { o.opacity = parseFloat(els.ovOpacity.value); els.ovOpacityVal.textContent = Math.round(o.opacity * 100) + '%'; syncPreviewStatics(); }));
els.ovOpacity.addEventListener('change', commitInteractiveEdit);
els.ovRotation.addEventListener('pointerdown', beginInteractiveEdit);
els.ovRotation.addEventListener('input', () => withOverlay((o) => { o.rotation = parseFloat(els.ovRotation.value) || 0; els.ovRotationVal.textContent = Math.round(o.rotation) + '°'; syncPreviewStatics(); }));
els.ovRotation.addEventListener('change', commitInteractiveEdit);
els.ovFade.addEventListener('change', () => withOverlay((o) => { o.fade = parseFloat(els.ovFade.value) || 0; }, true));
function overlayCropUpdate(key, el) {
  el.addEventListener('change', () => withOverlay((o) => {
    o.crop = o.crop || { left: 0, right: 0, top: 0, bottom: 0 };
    o.crop[key] = Math.max(0, Math.min(0.45, (parseFloat(el.value) || 0) / 100));
    syncPreviewStatics();
  }, true));
}
els.ovMirrorX.addEventListener('change', () => withOverlay((o) => { o.mirrorX = els.ovMirrorX.checked; syncPreviewStatics(); }, true));
els.ovMirrorY.addEventListener('change', () => withOverlay((o) => { o.mirrorY = els.ovMirrorY.checked; syncPreviewStatics(); }, true));
els.ovMask.addEventListener('change', () => withOverlay((o) => { o.mask = els.ovMask.value; syncPreviewStatics(); }, true));
els.ovMaskInvert.addEventListener('change', () => withOverlay((o) => { o.maskInvert = els.ovMaskInvert.checked; }, true));
els.ovMaskFeather.addEventListener('change', () => withOverlay((o) => { o.maskFeather = Math.max(0, Math.min(0.25, (parseFloat(els.ovMaskFeather.value) || 0) / 100)); syncPreviewStatics(); }, true));
overlayCropUpdate('left', els.ovCropLeft); overlayCropUpdate('right', els.ovCropRight); overlayCropUpdate('top', els.ovCropTop); overlayCropUpdate('bottom', els.ovCropBottom);
els.ovBlendMode.addEventListener('change', () => withOverlay((o) => { o.blendMode = els.ovBlendMode.value; syncPreviewStatics(); }, true));
els.ovChromaEnabled.addEventListener('change', () => withOverlay((o) => { o.chromaKey = o.chromaKey || {}; o.chromaKey.enabled = els.ovChromaEnabled.checked; }, true));
els.ovChromaColor.addEventListener('change', () => withOverlay((o) => { o.chromaKey = o.chromaKey || {}; o.chromaKey.color = els.ovChromaColor.value; }, true));
els.ovChromaSimilarity.addEventListener('change', () => withOverlay((o) => { o.chromaKey = o.chromaKey || {}; o.chromaKey.similarity = parseFloat(els.ovChromaSimilarity.value) || 0.1; }, true));
els.ovMoveEnable.addEventListener('change', () => withOverlay((o) => {
  if (els.ovMoveEnable.checked) o.move = { toX: parseFloat(els.ovMoveX.value) || o.x, toY: parseFloat(els.ovMoveY.value) || o.y };
  else o.move = null;
  renderOverlayPane();
}, true));
els.ovMoveX.addEventListener('change', () => withOverlay((o) => { if (o.move) o.move.toX = parseFloat(els.ovMoveX.value) || 0; }, true));
els.ovMoveY.addEventListener('change', () => withOverlay((o) => { if (o.move) o.move.toY = parseFloat(els.ovMoveY.value) || 0; }, true));

function replaceKeyframe(o, previousTime, next) {
  const frames = keyframe.normaliseKeyframes(o).filter((f) => f.time !== previousTime && f.time !== next.time);
  frames.push(next);
  o.keyframes = frames.sort((a, b) => a.time - b.time);
  // A real keyframe animation supersedes the older two-point move control.
  o.move = null;
  state.selectedKeyframeTime = next.time;
}

function selectedKeyframeInputNumber(el, fallback) {
  const n = parseFloat(el.value);
  return Number.isFinite(n) ? n : fallback;
}

els.addKeyframe.addEventListener('click', () => withOverlay((o) => {
  const range = keyframe.overlayRange(o);
  const requested = selectedKeyframeInputNumber(els.keyframeNewTime, currentPreviewTime());
  const time = Math.max(range.start, Math.min(range.end, requested));
  const values = keyframe.valuesAt(o, time);
  recordUndo();
  replaceKeyframe(o, null, Object.assign({ time, curve: 'linear' }, values));
  renderOverlayPane();
  syncPreviewStatics();
}));

function editSelectedKeyframe(mutator) {
  withOverlay((o) => {
    const selected = selectedKeyframe(o);
    if (!selected) return;
    recordUndo();
    const range = keyframe.overlayRange(o);
    const next = Object.assign({}, selected);
    mutator(next, range);
    next.time = Math.max(range.start, Math.min(range.end, next.time));
    next.scale = Math.max(0.02, Math.min(1, next.scale));
    next.opacity = Math.max(0, Math.min(1, next.opacity));
    replaceKeyframe(o, selected.time, next);
    renderOverlayPane();
    syncPreviewStatics();
  });
}

els.kfTime.addEventListener('change', () => editSelectedKeyframe((f) => { f.time = selectedKeyframeInputNumber(els.kfTime, f.time); }));
els.kfCurve.addEventListener('change', () => editSelectedKeyframe((f) => {
  f.curve = els.kfCurve.value;
  if (f.curve === 'bezier' && !f.bezier) f.bezier = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
}));
els.kfX.addEventListener('change', () => editSelectedKeyframe((f) => { f.x = selectedKeyframeInputNumber(els.kfX, f.x); }));
els.kfY.addEventListener('change', () => editSelectedKeyframe((f) => { f.y = selectedKeyframeInputNumber(els.kfY, f.y); }));
els.kfScale.addEventListener('change', () => editSelectedKeyframe((f) => { f.scale = selectedKeyframeInputNumber(els.kfScale, f.scale); }));
els.kfOpacity.addEventListener('change', () => editSelectedKeyframe((f) => { f.opacity = selectedKeyframeInputNumber(els.kfOpacity, f.opacity); }));
els.kfRotation.addEventListener('change', () => editSelectedKeyframe((f) => { f.rotation = selectedKeyframeInputNumber(els.kfRotation, f.rotation || 0); }));
function editBezierPoint(key, el) {
  el.addEventListener('change', () => editSelectedKeyframe((f) => {
    f.curve = 'bezier';
    f.bezier = Object.assign({ x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }, f.bezier || {});
    f.bezier[key] = Math.max(0, Math.min(1, selectedKeyframeInputNumber(el, f.bezier[key])));
  }));
}
editBezierPoint('x1', els.kfBezierX1); editBezierPoint('y1', els.kfBezierY1); editBezierPoint('x2', els.kfBezierX2); editBezierPoint('y2', els.kfBezierY2);
els.deleteKeyframe.addEventListener('click', () => withOverlay((o) => {
  const selected = selectedKeyframe(o);
  if (!selected) return;
  recordUndo();
  o.keyframes = keyframe.normaliseKeyframes(o).filter((f) => f.time !== selected.time);
  state.selectedKeyframeTime = null;
  renderOverlayPane();
  syncPreviewStatics();
}));

els.deleteOverlay.addEventListener('click', () => { const o = findOverlay(state.selectedOverlayId); if (!o) return; recordUndo(); state.overlays = state.overlays.filter((x) => x.id !== o.id); state.selectedOverlayId = null; state.selectedKeyframeTime = null; renderOverlayPane(); });

// audio pane
els.music.addEventListener('click', pickMusic);
els.removeMusic.addEventListener('click', removeMusic);
els.addAudioTrack.addEventListener('click', addAudioTrack);
els.recordVoice.addEventListener('click', startVoiceRecording);
els.stopVoice.addEventListener('click', stopVoiceRecording);
els.splitAudioTrack.addEventListener('click', splitSelectedAudioTrack);
function withAudioTrack(fn, record) { const track = findAudioTrack(state.selectedAudioTrackId); if (track) { if (record) recordUndo(); fn(track); } }
els.audioTrackStart.addEventListener('change', () => withAudioTrack((track) => { track.start = Math.max(0, parseFloat(els.audioTrackStart.value) || 0); if (track.end <= track.start) track.end = track.start + 0.1; renderAll(); }, true));
els.audioTrackEnd.addEventListener('change', () => withAudioTrack((track) => { track.end = Math.max(track.start + 0.1, parseFloat(els.audioTrackEnd.value) || (track.start + 0.1)); renderAll(); }, true));
els.audioTrackTrimStart.addEventListener('change', () => withAudioTrack((track) => { track.trimStart = Math.max(0, parseFloat(els.audioTrackTrimStart.value) || 0); }, true));
els.audioTrackLoop.addEventListener('change', () => withAudioTrack((track) => { track.loop = els.audioTrackLoop.checked; }, true));
els.audioTrackVolume.addEventListener('pointerdown', beginInteractiveEdit);
els.audioTrackVolume.addEventListener('input', () => withAudioTrack((track) => { track.volume = parseFloat(els.audioTrackVolume.value); els.audioTrackVolumeVal.textContent = Math.round(track.volume * 100) + '%'; }));
els.audioTrackVolume.addEventListener('change', commitInteractiveEdit);
els.audioTrackFadeIn.addEventListener('change', () => withAudioTrack((track) => { track.fadeIn = Math.max(0, parseFloat(els.audioTrackFadeIn.value) || 0); }, true));
els.audioTrackFadeOut.addEventListener('change', () => withAudioTrack((track) => { track.fadeOut = Math.max(0, parseFloat(els.audioTrackFadeOut.value) || 0); }, true));
els.addAudioMute.addEventListener('click', () => withAudioTrack((track) => {
  const duration = Math.max(0.001, track.end - track.start);
  const local = Math.max(0, Math.min(duration, playheadTime - track.start));
  const start = Math.max(0, local - 0.5), end = Math.min(duration, local + 0.5);
  recordUndo();
  track.muteRanges = normaliseAudioMuteRanges(Object.assign({}, track, { muteRanges: (track.muteRanges || []).concat({ start, end }) }));
  renderAudioPane();
  setStatus('已将当前播放头附近 1 秒静音');
}));
els.audioTrackDenoise.addEventListener('change', () => withAudioTrack((track) => { track.denoise = els.audioTrackDenoise.checked; }, true));
els.audioTrackVoiceEnhance.addEventListener('change', () => withAudioTrack((track) => { track.voiceEnhance = els.audioTrackVoiceEnhance.checked; }, true));
els.audioTrackSpeed.addEventListener('change', () => withAudioTrack((track) => { track.speed = Math.max(0.25, Math.min(4, parseFloat(els.audioTrackSpeed.value) || 1)); }, true));
els.audioTrackPitch.addEventListener('change', () => withAudioTrack((track) => { track.pitch = Math.max(-12, Math.min(12, parseFloat(els.audioTrackPitch.value) || 0)); }, true));
els.deleteAudioTrack.addEventListener('click', () => { const track = findAudioTrack(state.selectedAudioTrackId); if (!track) return; recordUndo(); state.audioTracks = state.audioTracks.filter((item) => item.id !== track.id); state.selectedAudioTrackId = null; renderAll(); });
els.volOriginal.addEventListener('pointerdown', beginInteractiveEdit);
els.volOriginal.addEventListener('input', () => { state.originalVolume = parseFloat(els.volOriginal.value); els.volOriginalVal.textContent = Math.round(state.originalVolume * 100) + '%'; els.player.volume = state.originalVolume; });
els.volOriginal.addEventListener('change', commitInteractiveEdit);
els.volBgm.addEventListener('pointerdown', beginInteractiveEdit);
els.volBgm.addEventListener('input', () => { state.bgmVolume = parseFloat(els.volBgm.value); els.volBgmVal.textContent = Math.round(state.bgmVolume * 100) + '%'; });
els.volBgm.addEventListener('change', commitInteractiveEdit);
els.bgmDuck.addEventListener('change', () => { recordUndo(); state.bgmDuck = els.bgmDuck.checked; renderAudioPane(); });
els.bgmDuckAmount.addEventListener('pointerdown', beginInteractiveEdit);
els.bgmDuckAmount.addEventListener('input', () => { state.bgmDuckAmount = parseFloat(els.bgmDuckAmount.value); els.bgmDuckAmountVal.textContent = Math.round(state.bgmDuckAmount * 100) + '%'; });
els.bgmDuckAmount.addEventListener('change', commitInteractiveEdit);
els.bgmTrimStart.addEventListener('change', () => { if (!state.bgm) return; recordUndo(); state.bgm.trimStart = Math.max(0, parseFloat(els.bgmTrimStart.value) || 0); });
els.bgmFadeIn.addEventListener('change', () => { if (!state.bgm) return; recordUndo(); state.bgm.fadeIn = Math.max(0, Math.min(10, parseFloat(els.bgmFadeIn.value) || 0)); });
els.bgmFadeOut.addEventListener('change', () => { if (!state.bgm) return; recordUndo(); state.bgm.fadeOut = Math.max(0, Math.min(10, parseFloat(els.bgmFadeOut.value) || 0)); });
els.loudnessNormalize.addEventListener('change', () => { recordUndo(); state.loudnessNormalize = els.loudnessNormalize.checked; });

// keyboard
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const mod = e.metaKey || e.ctrlKey;
  const nudge = e.shiftKey ? 1 : 0.1;
  if (e.code === 'Space' && !exporting) { e.preventDefault(); playPreview(); }
  else if (!mod && e.key.toLowerCase() === 'm' && addMarkerAtPlayhead()) { e.preventDefault(); }
  else if (!mod && e.key === '[' && jumpMarker(-1)) { e.preventDefault(); }
  else if (!mod && e.key === ']' && jumpMarker(1)) { e.preventDefault(); }
  else if (!mod && e.key === 'PageUp' && jumpEditPoint(-1)) { e.preventDefault(); }
  else if (!mod && e.key === 'PageDown' && jumpEditPoint(1)) { e.preventDefault(); }
  else if (!mod && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); fitTimeline(); }
  else if (!mod && e.key === 'Home') { e.preventDefault(); stopPreview(); seekTimelineTime(0, false); }
  else if (!mod && e.key === 'End') { e.preventDefault(); stopPreview(); seekTimelineTime(totalDuration(), false); }
  else if (e.key.toLowerCase() === 'j' && jklPlayback('j')) { e.preventDefault(); }
  else if (e.key.toLowerCase() === 'k' && jklPlayback('k')) { e.preventDefault(); }
  else if (e.key.toLowerCase() === 'l' && jklPlayback('l')) { e.preventDefault(); }
  else if (e.key === ',' || e.key === '<') { e.preventDefault(); stepPreviewFrame(-1); }
  else if (e.key === '.' || e.key === '>') { e.preventDefault(); stepPreviewFrame(1); }
  else if (!mod && e.key.toLowerCase() === 'i' && trimClipEdgeToPlayhead('start')) { e.preventDefault(); }
  else if (!mod && e.key.toLowerCase() === 'o' && trimClipEdgeToPlayhead('end')) { e.preventDefault(); }
  else if (e.altKey && e.key === 'ArrowLeft' && state.selectedClipId) { e.preventDefault(); moveClip(state.selectedClipId, -1); }
  else if (e.altKey && e.key === 'ArrowRight' && state.selectedClipId) { e.preventDefault(); moveClip(state.selectedClipId, 1); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'c' && copyClipAppearance()) { e.preventDefault(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'v' && pasteClipAppearance()) { e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'd' && duplicateSelectedClip()) { e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'c' && copyActiveTimelineItem()) { e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'v' && pasteTimelineItem()) { e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); splitSelectedClip(); }
  else if (mod && e.key.toLowerCase() === 'j' && activeTimelineItem.type === 'audio') { e.preventDefault(); splitSelectedAudioTrack(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedMarkerId && deleteSelectedMarker()) { e.preventDefault(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && activeTimelineItem.type === 'clip' && state.selectedClipId) { e.preventDefault(); rippleDeleteSelectedClip(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && deleteActiveTimelineItem()) { e.preventDefault(); }
  else if (e.key === 'ArrowLeft' && (nudgeActiveTimelineItem(-nudge) || nudgePlayhead(-(e.shiftKey ? 1 : 1 / (state.frameRate || 30))))) { e.preventDefault(); }
  else if (e.key === 'ArrowRight' && (nudgeActiveTimelineItem(nudge) || nudgePlayhead(e.shiftKey ? 1 : 1 / (state.frameRate || 30)))) { e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

(async function init() {
  renderAll();
  await restoreRecovery();
  try {
    const cap = await api.capabilities();
    if (!cap.ok) setStatus('⚠ ' + cap.error);
    else if (!cap.hasXfade) setStatus(`ffmpeg ${cap.version} 可用，但缺少 xfade：请只使用硬切。`);
    else if (!cap.hasSubtitles) setStatus(`ffmpeg ${cap.version} 缺少 subtitles/libass：文字导出不可用。`);
    else if (!cap.hasDeshake) setStatus(`ffmpeg ${cap.version} 可用，但不支持片段防抖。`);
    else setStatus(`就绪（ffmpeg ${cap.version}）。导入视频开始。`);
  } catch (e) {
    setStatus('无法检测 ffmpeg：' + (e && e.message ? e.message : String(e)));
  }
})();
