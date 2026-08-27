'use strict';

/**
 * End-to-end integration test (requires the real bundled ffmpeg/ffprobe).
 * Not part of `npm test` (which stays GUI/binary-free); run explicitly:
 *   node test/e2e-export.test.js
 *
 * It probes generated clips, then exports several timeline variants and
 * asserts each produces a valid mp4 whose duration matches the expected total.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const runner = require('../src/ffmpeg-runner');
const overlayExport = require('../src/overlay-export-utils');

const MEDIA = path.join(os.tmpdir(), 'mc_e2e');
const OUT = path.join(os.tmpdir(), 'mc_e2e_out');
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

/** Generate the fixture clips with the bundled ffmpeg if they're not present. */
function ensureFixtures() {
  const { ffmpeg } = runner.resolveBinaries();
  const gen = (args) => execFileSync(ffmpeg, ['-y', ...args], { stdio: 'ignore' });
  const v = (src, dur, freq, out) =>
    gen([
      '-f', 'lavfi', '-i', `${src}=duration=${dur}:size=640x360:rate=30`,
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      path.join(MEDIA, out),
    ]);
  if (!fs.existsSync(path.join(MEDIA, 'a.mp4'))) v('testsrc', 3, 330, 'a.mp4');
  if (!fs.existsSync(path.join(MEDIA, 'b.mp4'))) v('testsrc2', 4, 440, 'b.mp4');
  if (!fs.existsSync(path.join(MEDIA, 'c.mp4'))) v('smptebars', 3, 550, 'c.mp4');
  if (!fs.existsSync(path.join(MEDIA, 'silent.mp4'))) {
    gen([
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(MEDIA, 'silent.mp4'),
    ]);
  }
  if (!fs.existsSync(path.join(MEDIA, 'music.m4a'))) {
    gen(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-c:a', 'aac', path.join(MEDIA, 'music.m4a')]);
  }
  if (!fs.existsSync(path.join(MEDIA, 'logo.png'))) {
    gen(['-f', 'lavfi', '-i', 'color=c=red:s=120x120:d=1', '-frames:v', '1', path.join(MEDIA, 'logo.png')]);
  }
  if (!fs.existsSync(path.join(MEDIA, 'overlay.mp4'))) {
    gen([
      '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=2:r=30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(MEDIA, 'overlay.mp4'),
    ]);
  }
  if (!fs.existsSync(path.join(MEDIA, 'title.ass'))) {
    // English text avoids depending on a bundled CJK font in CI.
    const { buildAss } = require('../src/ass-builder');
    fs.writeFileSync(
      path.join(MEDIA, 'title.ass'),
      buildAss({ width: 640, height: 360, fontName: 'Sans', items: [{ text: 'Hello MiniClip', start: 0, end: 3, position: 'bottom', fade: 0.3 }] })
    );
  }
}

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log('  \u2713', name);
}

async function probedClip(file, trimStart, trimEnd, extra = {}) {
  const p = path.join(MEDIA, file);
  const meta = await runner.probe(p);
  return Object.assign(
    {
      path: p,
      trimStart,
      trimEnd: trimEnd == null ? meta.duration : trimEnd,
      hasAudio: meta.hasAudio,
      _meta: meta,
    },
    extra
  );
}

async function exportAndCheck(spec, expectedTotal, label) {
  const out = path.join(OUT, label + '.mp4');
  spec.output = out;
  const { promise } = runner.exportTimeline(spec, () => {});
  await promise;
  assert.ok(fs.existsSync(out), `${label}: output missing`);
  assert.ok(fs.statSync(out).size > 1000, `${label}: output too small`);
  const meta = await runner.probe(out);
  assert.ok(meta.hasVideo, `${label}: no video stream`);
  assert.ok(meta.hasAudio, `${label}: no audio stream`);
  // duration within 0.5s of expected (encoder/keyframe slack)
  assert.ok(
    Math.abs(meta.duration - expectedTotal) < 0.5,
    `${label}: duration ${meta.duration.toFixed(2)} != expected ~${expectedTotal}`
  );
  return meta;
}

(async function main() {
  console.log('e2e-export (real ffmpeg):');

  const cap = await runner.checkCapabilities();
  assert.ok(cap.ok, 'ffmpeg not usable: ' + (cap.error || ''));
  console.log(`  (ffmpeg ${cap.version}, xfade=${cap.hasXfade})`);
  ensureFixtures();

  await ok('editing proxy renders and probes as a valid MP4', async () => {
    const source = path.join(MEDIA, 'a.mp4');
    const proxy = path.join(OUT, 'a-proxy.mp4');
    await runner.createProxy(source, proxy);
    const meta = await runner.probe(proxy);
    assert.ok(meta.hasVideo);
    assert.ok(meta.duration > 2.5 && meta.duration < 3.5);
    assert.ok(meta.width <= 960);
  });

  await ok('freeze-frame clip is silent and exports on the main timeline', async () => {
    const source = path.join(MEDIA, 'a.mp4');
    const frozenPath = path.join(OUT, 'source-freeze.mp4');
    await runner.createFreezeFrame(source, 1, frozenPath, 1);
    const frozen = await runner.probe(frozenPath);
    assert.strictEqual(frozen.hasAudio, false);
    const clip = { path: frozenPath, trimStart: 0, trimEnd: frozen.duration, hasAudio: false };
    await exportAndCheck({ clips: [clip], settings: {} }, frozen.duration, 'freezeTimeline');
  });

  await ok('custom-duration freeze-frame retains the requested duration', async () => {
    const source = path.join(MEDIA, 'a.mp4');
    const frozenPath = path.join(OUT, 'source-freeze-custom.mp4');
    await runner.createFreezeFrame(source, 1, frozenPath, 2.4);
    const frozen = await runner.probe(frozenPath);
    assert.ok(Math.abs(frozen.duration - 2.4) < 0.2);
    await exportAndCheck({ clips: [{ path: frozenPath, trimStart: 0, trimEnd: frozen.duration, hasAudio: false }], settings: {} }, frozen.duration, 'freezeCustomDuration');
  });

  await ok('static image is looped as a silent main-timeline clip', async () => {
    const still = path.join(MEDIA, 'logo.png');
    const meta = await exportAndCheck(
      { clips: [{ path: still, kind: 'image', trimStart: 0, trimEnd: 2, hasAudio: false }], settings: {} },
      2,
      'imageMainClip'
    );
    assert.strictEqual(meta.hasAudio, true, 'main timeline synthesizes a silent audio stream');
  });

  await ok('probe reports duration and audio presence', async () => {
    const a = await probedClip('a.mp4');
    assert.ok(Math.abs(a._meta.duration - 3) < 0.3);
    assert.strictEqual(a.hasAudio, true);
    const s = await probedClip('silent.mp4');
    assert.strictEqual(s.hasAudio, false);
  });

  await ok('scene detection finds a hard visual cut locally', async () => {
    const { ffmpeg } = runner.resolveBinaries();
    const source = path.join(MEDIA, 'scene-cut.mp4');
    if (!fs.existsSync(source)) {
      execFileSync(ffmpeg, [
        '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1:r=30',
        '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1:r=30',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source,
      ], { stdio: 'ignore' });
    }
    const cuts = await runner.sceneDetect(source, { start: 0, end: 2, threshold: 0.2 });
    assert.ok(cuts.some((cut) => Math.abs(cut - 1) < 0.15), 'expected a cut near 1s, got ' + cuts.join(', '));
  });

  await ok('single clip trimmed exports (~2s)', async () => {
    const a = await probedClip('a.mp4', 0.5, 2.5); // 2s
    await exportAndCheck({ clips: [a], settings: {} }, 2, 'single');
  });

  await ok('hard-cut concat of 3 clips (~10s)', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    const b = await probedClip('b.mp4', 0, 4);
    const c = await probedClip('c.mp4', 0, 3);
    await exportAndCheck({ clips: [a, b, c], settings: { transition: 0 } }, 10, 'concat3');
  });

  await ok('duplicated main clip exports as two consecutive edited copies', async () => {
    const a = await probedClip('a.mp4', 0, 2, { color: { contrast: 1.15 }, animationIn: { style: 'fade', duration: 0.3 } });
    const copied = Object.assign({}, a, { transitionToNext: { style: 'none', duration: 0 } });
    await exportAndCheck({ clips: [a, copied], settings: {} }, 4, 'duplicatedMainClip');
  });

  await ok('cross-dissolve of 3 clips subtracts overlaps (~8s)', async () => {
    // 3+4+3 = 10, minus 2 overlaps * 1s = 8
    const a = await probedClip('a.mp4', 0, 3);
    const b = await probedClip('b.mp4', 0, 4);
    const c = await probedClip('c.mp4', 0, 3);
    await exportAndCheck({ clips: [a, b, c], settings: { transition: 1 } }, 8, 'xfade3');
  });

  await ok('silent clip gets synthesized audio, mux still valid', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    const s = await probedClip('silent.mp4', 0, 3);
    await exportAndCheck({ clips: [a, s], settings: { transition: 0 } }, 6, 'withsilent');
  });

  await ok('muted main clip keeps video duration with silent output audio', async () => {
    const a = await probedClip('a.mp4', 0, 3, { muted: true });
    await exportAndCheck({ clips: [a], settings: {} }, 3, 'mutedMainClip');
  });

  await ok('background music mix exports and matches video length', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    const b = await probedClip('b.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a, b],
        bgm: { path: path.join(MEDIA, 'music.m4a') }, // 2s music, must loop to 6s
        settings: { transition: 0, originalVolume: 0.7, bgmVolume: 0.4 },
      },
      6,
      'bgm'
    );
  });

  await ok('background music source offset and fades export', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      { clips: [a], bgm: { path: path.join(MEDIA, 'music.m4a'), trimStart: 0.3, fadeIn: 0.4, fadeOut: 0.5 }, settings: {} },
      3,
      'bgmFadeOffset'
    );
  });

  await ok('BGM ducking and loudness-normalized mix export', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    const b = await probedClip('b.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a, b],
        bgm: { path: path.join(MEDIA, 'music.m4a') },
        settings: { transition: 0, originalVolume: 0.8, bgmVolume: 0.4, bgmDuck: true, bgmDuckAmount: 0.45, loudnessNormalize: true },
      },
      6,
      'duckNormalize'
    );
  });

  await ok('independent audio clip supports placement, fades and looping', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    const b = await probedClip('b.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a, b],
        audioTracks: [
          { path: path.join(MEDIA, 'music.m4a'), start: 0.5, end: 3.5, trimStart: 0.2, volume: 0.7, fadeIn: 0.2, fadeOut: 0.3 },
          { path: path.join(MEDIA, 'music.m4a'), start: 4, end: 6, volume: 0.2, loop: true },
        ],
        settings: { transition: 0 },
      },
      6,
      'audioTracks'
    );
  });

  await ok('independent audio local mute ranges export without changing duration', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      { clips: [a], audioTracks: [{ path: path.join(MEDIA, 'music.m4a'), start: 0, end: 3, muteRanges: [{ start: 0.8, end: 1.8 }] }], settings: {} },
      3,
      'audioMuteRange'
    );
  });

  await ok('voice track pitch, denoise and enhancement export', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        audioTracks: [{ path: path.join(MEDIA, 'music.m4a'), start: 0, end: 3, speed: 1, pitch: 2, denoise: true, voiceEnhance: true, volume: 0.7 }],
        settings: {},
      },
      3,
      'voiceProcessing'
    );
  });

  // ---- CapCut-aligned feature coverage ----

  await ok('per-clip 2x speed halves duration', async () => {
    const a = await probedClip('a.mp4', 0, 4, { speed: 2 }); // 4s -> 2s
    await exportAndCheck({ clips: [a], settings: {} }, 2, 'speed2x');
  });

  await ok('per-clip 0.5x speed doubles duration', async () => {
    const a = await probedClip('a.mp4', 0, 1.5, { speed: 0.5 }); // 1.5s -> 3s
    await exportAndCheck({ clips: [a], settings: {} }, 3, 'speedHalf');
  });

  await ok('speed-curve pieces export as one continuous retimed clip', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    const curve = [
      Object.assign({}, a, { trimStart: 0, trimEnd: 1, speed: 1, transitionToNext: { style: 'none', duration: 0 } }),
      Object.assign({}, a, { trimStart: 1, trimEnd: 2, speed: 2, transitionToNext: { style: 'none', duration: 0 } }),
      Object.assign({}, a, { trimStart: 2, trimEnd: 3, speed: 1 }),
    ];
    await exportAndCheck({ clips: curve, settings: {} }, 2.5, 'speedCurvePieces');
  });

  await ok('reverse renders and preserves duration', async () => {
    const a = await probedClip('a.mp4', 0, 2, { reverse: true });
    await exportAndCheck({ clips: [a], settings: {} }, 2, 'reverse');
  });

  await ok('reversed clip split in visible order exports continuously', async () => {
    const source = await probedClip('a.mp4', 0, 3, { reverse: true });
    const timeline = require('../src/timeline-utils');
    const split = timeline.splitClipAtSourceTime(source, 1, 77);
    assert.ok(split);
    assert.deepStrictEqual([split.left.trimStart, split.left.trimEnd], [1, 3]);
    assert.deepStrictEqual([split.right.trimStart, split.right.trimEnd], [0, 1]);
    await exportAndCheck({ clips: [split.left, split.right], settings: {} }, 3, 'reverseSplitVisibleOrder');
  });

  await ok('clip original audio gain and fades export', async () => {
    const a = await probedClip('a.mp4', 0, 2, { volume: 0.6, fadeIn: 0.3, fadeOut: 0.4 });
    await exportAndCheck({ clips: [a], settings: {} }, 2, 'clipAudioFade');
  });

  await ok('clip crop mirror and rotation export at canvas dimensions', async () => {
    const a = await probedClip('a.mp4', 0, 2, {
      crop: { left: 0.08, right: 0.04, top: 0.02, bottom: 0.03 }, mirrorX: true, rotation: 15,
    });
    const meta = await exportAndCheck({ clips: [a], settings: {} }, 2, 'clipGeometry');
    assert.strictEqual(meta.width, 1280);
    assert.strictEqual(meta.height, 720);
  });

  await ok('clip zoom and pan export at canvas dimensions', async () => {
    const a = await probedClip('a.mp4', 0, 2, { transformScale: 1.35, transformX: 35, transformY: -20 });
    const meta = await exportAndCheck({ clips: [a], settings: {} }, 2, 'clipTransform');
    assert.strictEqual(meta.width, 1280);
    assert.strictEqual(meta.height, 720);
  });

  await ok('per-gap wipe transition + color grade', async () => {
    const a = await probedClip('a.mp4', 0, 3, {
      color: { brightness: 0.05, contrast: 1.2, saturation: 1.4, temperature: 40 },
      transitionToNext: { style: 'wipeleft', duration: 1 },
    });
    const b = await probedClip('b.mp4', 0, 3);
    await exportAndCheck({ clips: [a, b], settings: {} }, 5, 'wipeColor'); // 3+3-1
  });

  await ok('named clip effect exports through the FFmpeg graph', async () => {
    const a = await probedClip('a.mp4', 0, 2, { effect: 'vintage' });
    await exportAndCheck({ clips: [a], settings: {} }, 2, 'vintageEffect');
  });

  await ok('vignette and grain finishing effects export with a named preset', async () => {
    const a = await probedClip('a.mp4', 0, 2, { effect: 'vintage', vignette: 0.5, grain: 0.4 });
    await exportAndCheck({ clips: [a], settings: {} }, 2, 'vignetteGrain');
  });

  await ok('vertical 9:16 canvas with blurred background fill', async () => {
    const a = await probedClip('a.mp4', 0, 2, { fillMode: 'blur' });
    const meta = await exportAndCheck(
      { clips: [a], settings: { width: 720, height: 1280 } },
      2,
      'vertical'
    );
    assert.strictEqual(meta.width, 720);
    assert.strictEqual(meta.height, 1280);
  });

  await ok('custom canvas background color exports through pad geometry', async () => {
    const a = await probedClip('a.mp4', 0, 1, { rotation: 10 });
    await exportAndCheck({ clips: [a], settings: { backgroundColor: '#123456' } }, 1, 'canvasColor');
  });

  await ok('custom 1080p portrait frame rate exports at requested dimensions', async () => {
    const a = await probedClip('a.mp4', 0, 1);
    const meta = await exportAndCheck(
      { clips: [a], settings: { width: 1080, height: 1920, fps: 24 } },
      1,
      'portrait1080p24'
    );
    assert.strictEqual(meta.width, 1080);
    assert.strictEqual(meta.height, 1920);
  });

  await ok('ken-burns zoom motion renders', async () => {
    const a = await probedClip('a.mp4', 0, 2, { motion: 'zoomIn' });
    await exportAndCheck({ clips: [a], settings: {} }, 2, 'kenburns');
  });

  await ok('clip entry and exit animations render without changing duration', async () => {
    const a = await probedClip('a.mp4', 0, 3, {
      animationIn: { style: 'slideLeft', duration: 0.5 },
      animationOut: { style: 'fade', duration: 0.7 },
    });
    const meta = await exportAndCheck({ clips: [a], settings: {} }, 3, 'clipAnimations');
    assert.strictEqual(meta.width, 1280);
    assert.strictEqual(meta.height, 720);
  });

  await ok('main clip opacity composites over the selected canvas background', async () => {
    const a = await probedClip('a.mp4', 0, 2, { opacity: 0.4 });
    const meta = await exportAndCheck({ clips: [a], settings: { backgroundColor: '#123456' } }, 2, 'clipOpacity');
    assert.strictEqual(meta.width, 1280);
    assert.strictEqual(meta.height, 720);
  });

  await ok('main clip transform keyframes animate scale position and opacity', async () => {
    const a = await probedClip('a.mp4', 0, 3, {
      transformKeyframes: [
        { time: 0, x: 0, y: 0, scale: 1, opacity: 1, curve: 'easeInOut' },
        { time: 2, x: 40, y: -25, scale: 1.35, opacity: 0.45, curve: 'linear' },
      ],
    });
    const meta = await exportAndCheck({ clips: [a], settings: { backgroundColor: '#123456' } }, 3, 'clipTransformKeyframes');
    assert.strictEqual(meta.width, 1280);
    assert.strictEqual(meta.height, 720);
  });

  await ok('one-pass stabilization renders with preserved duration', async () => {
    const a = await probedClip('a.mp4', 0, 2, { stabilize: 'strong' });
    await exportAndCheck({ clips: [a], settings: {} }, 2, 'stabilize');
  });

  await ok('image overlay (PiP) with move composes over video', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        overlays: [{ path: path.join(MEDIA, 'logo.png'), kind: 'image', start: 0.5, end: 2.5, x: 20, y: 20, scale: 0.25, fadeDuration: 0.3, move: { toX: 300, toY: 150 } }],
        settings: {},
      },
      3,
      'overlay'
    );
  });

  await ok('processed overlay with crop, mask, key and blend exports', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        overlays: [{
          path: path.join(MEDIA, 'logo.png'), kind: 'image', start: 0.2, end: 2.8, x: 40, y: 40, scale: 0.35,
          mirrorX: true, crop: { left: 0.05, right: 0.05, top: 0, bottom: 0 }, mask: 'ellipse',
          chromaKey: { enabled: true, color: '#00ff00', similarity: 0.2, blend: 0.1 }, blendMode: 'screen',
        }],
        settings: {},
      },
      3,
      'processedOverlay'
    );
  });

  await ok('renderer overlay mapping preserves advanced processing through export', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    const mapped = overlayExport.toExportOverlay({
      path: path.join(MEDIA, 'logo.png'), kind: 'image', start: 0.2, end: 2.8,
      x: 30, y: 35, scale: 0.32, opacity: 0.8, fade: 0.2,
      mirrorX: true, crop: { left: 0.08, right: 0.04, top: 0.03, bottom: 0.06 },
      mask: 'rounded', maskFeather: 0.08,
      chromaKey: { enabled: true, color: '#00ff00', similarity: 0.2, blend: 0.05 },
      blendMode: 'screen',
    }, { scaleX: 1, scaleY: 1 });
    await exportAndCheck({ clips: [a], overlays: [mapped], settings: {} }, 3, 'mappedAdvancedOverlay');
  });

  await ok('rounded inverted feathered mask overlay exports', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        overlays: [{ path: path.join(MEDIA, 'logo.png'), kind: 'image', start: 0.2, end: 2.8, x: 50, y: 40, scale: 0.35, mask: 'rounded', maskInvert: true, maskFeather: 0.12 }],
        settings: {},
      },
      3,
      'advancedMask'
    );
  });

  await ok('keyframed overlay with eased position, scale and opacity renders', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        overlays: [{
          path: path.join(MEDIA, 'logo.png'), kind: 'image', start: 0.25, end: 2.75, x: 20, y: 20, scale: 0.2, opacity: 1,
          keyframes: [
            { time: 0.25, x: 20, y: 20, scale: 0.2, opacity: 0, curve: 'easeIn' },
            { time: 1.5, x: 260, y: 90, scale: 0.45, opacity: 1, curve: 'easeOut' },
            { time: 2.75, x: 80, y: 160, scale: 0.25, opacity: 0.4, curve: 'linear' },
          ],
        }],
        settings: {},
      },
      3,
      'keyframedOverlay'
    );
  });

  await ok('video overlay loops to fill its configured interval', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        // fixture is 2s; the 2.5s window forces one partial loop.
        overlays: [{ path: path.join(MEDIA, 'overlay.mp4'), kind: 'video', start: 0.25, end: 2.75, x: 30, y: 30, scale: 0.3 }],
        settings: {},
      },
      3,
      'videoOverlay'
    );
  });

  await ok('cover-fit B-roll video layer is source-trimmed and stays silent', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        brolls: [{
          path: path.join(MEDIA, 'overlay.mp4'), kind: 'video', start: 0.5, end: 2.5, trimStart: 0.25,
          loop: true, fit: 'cover', x: 0, y: 0, scale: 1, opacity: 0.75, fadeDuration: 0.2,
        }],
        settings: {},
      },
      3,
      'broll'
    );
  });

  await ok('burned subtitles via texts array', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        texts: [{ text: 'Hello MiniClip', start: 0, end: 3, position: 'bottom', fade: 0.3 }],
        settings: { width: 640, height: 360, fontName: 'Sans' },
      },
      3,
      'subtitle'
    );
  });

  await ok('semi-transparent styled subtitle burns through ASS', async () => {
    const a = await probedClip('a.mp4', 0, 2);
    await exportAndCheck(
      { clips: [a], texts: [{ text: 'Styled', start: 0, end: 2, position: 'bottom', fontSize: 48, fontFamily: 'serif', bold: true, italic: true, alpha: 0.5 }], settings: {} },
      2,
      'styledSubtitle'
    );
  });

  await ok('subtitle outline shadow and spacing burn through ASS', async () => {
    const a = await probedClip('a.mp4', 0, 2);
    await exportAndCheck(
      { clips: [a], texts: [{ text: 'Styled', start: 0, end: 2, fontSize: 48, outline: 4, shadow: 2, spacing: 1.5 }], settings: {} },
      2,
      'styledSubtitleOutline'
    );
  });

  await ok('freely positioned subtitle burns through ASS coordinates', async () => {
    const a = await probedClip('a.mp4', 0, 2);
    await exportAndCheck(
      { clips: [a], texts: [{ text: 'Free', start: 0, end: 2, fontSize: 48, xPercent: 20, yPercent: 25 }], settings: {} },
      2,
      'freeSubtitle'
    );
  });

  await ok('bilingual burned captions render as two lines', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        texts: [{ text: '你好\nHello', start: 0, end: 2, position: 'bottom', fontSize: 42 }],
        settings: { width: 640, height: 360, fontName: 'Sans' },
      },
      3,
      'bilingualCaption'
    );
  });

  await ok('karaoke captions render through libass', async () => {
    const a = await probedClip('a.mp4', 0, 3);
    await exportAndCheck(
      {
        clips: [a],
        texts: [{ text: 'Karaoke', start: 0, end: 2, position: 'bottom', fontSize: 48, primaryColor: '#ffffff', karaoke: true, karaokeHighlightColor: '#ffd54a' }],
        settings: { width: 640, height: 360, fontName: 'Sans' },
      },
      3,
      'karaokeCaption'
    );
  });

  await ok('everything at once (speed+color+transition+overlay+subtitle+bgm+9:16)', async () => {
    const a = await probedClip('a.mp4', 0, 3, {
      speed: 1.5,
      color: { brightness: 0.02, contrast: 1.1, saturation: 1.2, temperature: -20 },
      transitionToNext: { style: 'dissolve', duration: 0.5 },
      fillMode: 'blur',
    });
    const b = await probedClip('b.mp4', 0, 3, { motion: 'zoomOut', fillMode: 'blur' });
    // a: 3/1.5 = 2s ; b: 3s ; minus 0.5 overlap = 4.5s
    await exportAndCheck(
      {
        clips: [a, b],
        overlays: [{ path: path.join(MEDIA, 'logo.png'), kind: 'image', start: 0, end: 2, x: 10, y: 10, scale: 0.2 }],
        texts: [{ text: 'combo', start: 0, end: 2, position: 'top', fade: 0.2 }],
        bgm: { path: path.join(MEDIA, 'music.m4a') },
        settings: { width: 720, height: 1280, fontName: 'Sans', originalVolume: 0.8, bgmVolume: 0.3 },
      },
      4.5,
      'combo'
    );
  });

  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
