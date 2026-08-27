'use strict';

const assert = require('assert');
const project = require('../src/project-file');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('project-file:');

function sampleState() {
  return {
    clips: [{
      id: 7, path: '/media/a.mp4', url: 'file:///media/a.mp4', name: 'a.mp4', sourceDuration: 10,
      trimStart: 1, trimEnd: 8, hasAudio: true, muted: true, speed: 1.5, reverse: false, volume: 0.6, fadeIn: 0.2, fadeOut: 0.4, opacity: 0.65, motion: 'zoomIn', animationIn: { style: 'slideLeft', duration: 0.6 }, animationOut: { style: 'fade', duration: 0.8 }, stabilize: 'strong', effect: 'vintage', vignette: 0.45, grain: 0.2, mirrorX: true, rotation: 15, transformScale: 1.5, transformX: 30, transformY: -20, transformKeyframes: [{ time: 0, x: 0, y: 0, scale: 1, opacity: 1, curve: 'easeIn' }, { time: 2, x: 40, y: -10, scale: 1.4, opacity: 0.5, curve: 'linear' }], crop: { left: 0.1, right: 0, top: 0, bottom: 0.05 }, fillMode: 'blur',
      color: { brightness: 0.1, contrast: 1.2, saturation: 1.3, temperature: -20 },
      transitionToNext: { style: 'fade', duration: 0.5 },
    }],
    texts: [{ id: 8, text: '字幕', secondaryText: 'Subtitle', start: 2, end: 3, position: 'bottom', fontSize: 48, fontFamily: 'serif', bold: true, italic: true, opacity: 0.65, xPercent: 25, yPercent: 80, color: '#ffffff', outlineColor: '#000000', outlineWidth: 4, shadow: 2, spacing: 1.5, karaoke: true, karaokeHighlightColor: '#ffd54a', isCaption: true, fade: 0.2 }],
    overlays: [{
      id: 9, path: '/media/logo.png', url: 'file:///media/logo.png', kind: 'image', name: 'logo.png',
      start: 1, end: 4, x: 10, y: 20, scale: 0.4, opacity: 0.8, fade: 0.2,
      keyframes: [{ time: 1, x: 10, y: 20, scale: 0.4, opacity: 0.8, curve: 'easeInOut' }],
    }],
    brolls: [{ id: 11, path: '/media/broll.mp4', name: 'broll.mp4', duration: 12, start: 1, end: 6, trimStart: 0.5, loop: true, opacity: 0.8, fade: 0.2 }],
    videoTracks: [{ id: 'video-1', name: '底层视频', visible: true, locked: false }, { id: 'video-2', name: '顶层视频', visible: false, locked: true }],
    selectedVideoTrackId: 'video-2',
    markers: [{ id: 21, time: 2.5, name: '开场' }, { id: 22, time: 7.25, name: '产品亮点' }],
    bgm: { path: '/media/music.mp3', name: 'music.mp3', duration: 60, trimStart: 1.2, fadeIn: 0.5, fadeOut: 0.8 },
    audioTracks: [{ id: 10, path: '/media/voice.wav', name: 'voice.wav', duration: 8, start: 1, end: 5, trimStart: 0.5, volume: 0.7, fadeIn: 0.2, fadeOut: 0.4, muteRanges: [{ start: 0.5, end: 1.25 }], loop: false }],
    originalVolume: 0.8, bgmVolume: 0.3, bgmDuck: true, bgmDuckAmount: 0.5, loudnessNormalize: true, aspect: '9:16', fillMode: 'blur', canvasColor: '#123456', outputProfile: '4k', frameRate: 60, snapEnabled: false,
  };
}

ok('serializes a portable, versioned document', () => {
  const text = project.serializeProject(sampleState(), '2026-08-24T00:00:00.000Z');
  const doc = JSON.parse(text);
  assert.strictEqual(doc.format, project.FORMAT);
  assert.strictEqual(doc.version, project.VERSION);
  assert.ok(!text.includes('file:///media/a.mp4'), 'transient renderer URLs are not persisted');
  assert.strictEqual(doc.state.clips[0].path, '/media/a.mp4');
});

ok('preserves static image main-track clips', () => {
  const parsed = project.parseProject(project.serializeProject({
    clips: [{ id: 1, path: '/media/still.png', name: 'still.png', kind: 'image', sourceDuration: 5, trimStart: 0, trimEnd: 5 }],
  }));
  assert.strictEqual(parsed.state.clips[0].kind, 'image');
  assert.strictEqual(parsed.state.clips[0].hasAudio, false);
  assert.strictEqual(parsed.state.clips[0].trimEnd, 5);
});

ok('round-trips all editable state', () => {
  const parsed = project.parseProject(project.serializeProject(sampleState()));
  assert.strictEqual(parsed.state.clips[0].speed, 1.5);
  assert.strictEqual(parsed.state.clips[0].name, 'a.mp4');
  assert.strictEqual(parsed.state.clips[0].muted, true);
  assert.strictEqual(parsed.state.clips[0].volume, 0.6);
  assert.strictEqual(parsed.state.clips[0].fadeIn, 0.2);
  assert.strictEqual(parsed.state.clips[0].fadeOut, 0.4);
  assert.strictEqual(parsed.state.clips[0].opacity, 0.65);
  assert.deepStrictEqual(parsed.state.clips[0].animationIn, { style: 'slideLeft', duration: 0.6 });
  assert.deepStrictEqual(parsed.state.clips[0].animationOut, { style: 'fade', duration: 0.8 });
  assert.strictEqual(parsed.state.clips[0].mirrorX, true);
  assert.strictEqual(parsed.state.clips[0].rotation, 15);
  assert.strictEqual(parsed.state.clips[0].effect, 'vintage');
  assert.strictEqual(parsed.state.clips[0].vignette, 0.45);
  assert.strictEqual(parsed.state.clips[0].grain, 0.2);
  assert.strictEqual(parsed.state.clips[0].crop.left, 0.1);
  assert.strictEqual(parsed.state.clips[0].transformScale, 1.5);
  assert.strictEqual(parsed.state.clips[0].transformX, 30);
  assert.strictEqual(parsed.state.clips[0].transformY, -20);
  assert.deepStrictEqual(parsed.state.clips[0].transformKeyframes.map((frame) => [frame.time, frame.x, frame.scale, frame.opacity, frame.curve]), [[0, 0, 1, 1, 'easeIn'], [2, 40, 1.4, 0.5, 'linear']]);
  assert.strictEqual(parsed.state.clips[0].stabilize, 'strong');
  assert.strictEqual(parsed.state.texts[0].text, '字幕');
  assert.strictEqual(parsed.state.texts[0].karaoke, true);
  assert.strictEqual(parsed.state.texts[0].isCaption, true);
  assert.strictEqual(parsed.state.texts[0].secondaryText, 'Subtitle');
  assert.strictEqual(parsed.state.texts[0].fontFamily, 'serif');
  assert.strictEqual(parsed.state.texts[0].bold, true);
  assert.strictEqual(parsed.state.texts[0].italic, true);
  assert.strictEqual(parsed.state.texts[0].opacity, 0.65);
  assert.strictEqual(parsed.state.texts[0].xPercent, 25);
  assert.strictEqual(parsed.state.texts[0].yPercent, 80);
  assert.strictEqual(parsed.state.texts[0].outlineWidth, 4);
  assert.strictEqual(parsed.state.texts[0].shadow, 2);
  assert.strictEqual(parsed.state.texts[0].spacing, 1.5);
  assert.strictEqual(parsed.state.overlays[0].keyframes[0].curve, 'easeInOut');
  assert.strictEqual(parsed.state.brolls[0].trimStart, 0.5);
  assert.strictEqual(parsed.state.brolls[0].loop, true);
  assert.strictEqual(parsed.state.brolls[0].trackId, 'video-1');
  assert.strictEqual(parsed.state.videoTracks[1].locked, true);
  assert.strictEqual(parsed.state.selectedVideoTrackId, 'video-2');
  assert.deepStrictEqual(parsed.state.markers, [{ id: 21, time: 2.5, name: '开场' }, { id: 22, time: 7.25, name: '产品亮点' }]);
  assert.strictEqual(parsed.state.bgm.path, '/media/music.mp3');
  assert.strictEqual(parsed.state.bgm.trimStart, 1.2);
  assert.strictEqual(parsed.state.bgm.fadeOut, 0.8);
  assert.strictEqual(parsed.state.audioTracks[0].trimStart, 0.5);
  assert.strictEqual(parsed.state.audioTracks[0].volume, 0.7);
  assert.deepStrictEqual(parsed.state.audioTracks[0].muteRanges, [{ start: 0.5, end: 1.25 }]);
  assert.strictEqual(parsed.state.aspect, '9:16');
  assert.strictEqual(parsed.state.canvasColor, '#123456');
  assert.strictEqual(parsed.state.outputProfile, '4k');
  assert.strictEqual(parsed.state.frameRate, 60);
  assert.strictEqual(parsed.state.snapEnabled, false);
  assert.strictEqual(parsed.state.bgmDuck, true);
  assert.strictEqual(parsed.state.loudnessNormalize, true);
});

ok('clamps unsafe values to supported editor ranges', () => {
  const parsed = project.parseProject(JSON.stringify({
    format: project.FORMAT, version: project.VERSION,
    state: { clips: [{ path: 'x', sourceDuration: 5, trimStart: -10, trimEnd: 99, speed: 99, color: { saturation: 99 } }], originalVolume: -2, aspect: 'invalid' },
  }));
  const clip = parsed.state.clips[0];
  assert.strictEqual(clip.trimStart, 0);
  assert.strictEqual(clip.trimEnd, 5);
  assert.strictEqual(clip.speed, 4);
  assert.strictEqual(clip.muted, false);
  assert.strictEqual(clip.fadeIn, 0);
  assert.strictEqual(clip.fadeOut, 0);
  assert.strictEqual(clip.opacity, 1);
  assert.deepStrictEqual(clip.animationIn, { style: 'none', duration: 0 });
  assert.deepStrictEqual(clip.animationOut, { style: 'none', duration: 0 });
  assert.strictEqual(clip.rotation, 0);
  assert.strictEqual(clip.effect, 'none');
  assert.strictEqual(clip.vignette, 0);
  assert.strictEqual(clip.grain, 0);
  assert.strictEqual(clip.crop.left, 0);
  assert.strictEqual(clip.transformScale, 1);
  assert.strictEqual(clip.transformX, 0);
  assert.deepStrictEqual(clip.transformKeyframes, []);
  assert.strictEqual(clip.stabilize, 'off');
  assert.strictEqual(clip.color.saturation, 3);
  assert.strictEqual(parsed.state.originalVolume, 0);
  assert.strictEqual(parsed.state.aspect, '16:9');
  assert.strictEqual(parsed.state.canvasColor, '#000000');
  assert.strictEqual(parsed.state.outputProfile, '1080p');
  assert.strictEqual(parsed.state.frameRate, 30);
  assert.strictEqual(parsed.state.snapEnabled, true);
  assert.deepStrictEqual(parsed.state.markers, []);
});

ok('normalizes malformed markers into unique bounded timeline positions', () => {
  const parsed = project.parseProject(project.serializeProject({
    markers: [{ id: 5, time: -2 }, { id: 5, time: 'bad' }, { id: 0, time: 99999999 }],
  }));
  assert.deepStrictEqual(parsed.state.markers, [
    { id: 5, time: 0, name: '' }, { id: 6, time: 0, name: '' }, { id: 1, time: 24 * 60 * 60, name: '' },
  ]);
});

ok('rejects malformed, foreign and future documents', () => {
  assert.throws(() => project.parseProject('{'));
  assert.throws(() => project.parseProject(JSON.stringify({ format: 'other', version: 1, state: {} })));
  assert.throws(() => project.parseProject(JSON.stringify({ format: project.FORMAT, version: 99, state: {} })));
});

console.log('\n' + passed + ' passed');
