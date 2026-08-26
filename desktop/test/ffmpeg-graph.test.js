'use strict';

/**
 * Unit tests for the pure filter-graph builder. Runs on plain Node (no deps):
 *   node desktop/test/ffmpeg-graph.test.js
 * Exits non-zero on the first failed assertion.
 */

const assert = require('assert');
const g = require('../src/ffmpeg-graph');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  \u2713', name);
}

const clip = (path, start, end, extra = {}) =>
  Object.assign({ path, trimStart: start, trimEnd: end, hasAudio: true }, extra);

console.log('ffmpeg-graph:');

ok('clipDuration never negative', () => {
  assert.strictEqual(g.clipDuration(clip('a', 2, 5)), 3);
  assert.strictEqual(g.clipDuration(clip('a', 5, 2)), 0);
});

ok('clipSpeed clamps to 0.25..4', () => {
  assert.strictEqual(g.clipSpeed({ speed: 0 }), 1);
  assert.strictEqual(g.clipSpeed({ speed: 10 }), 4);
  assert.strictEqual(g.clipSpeed({ speed: 0.1 }), 0.25);
  assert.strictEqual(g.clipSpeed({ speed: 2 }), 2);
});

ok('effectiveClipDuration divides by speed', () => {
  assert.strictEqual(g.effectiveClipDuration(clip('a', 0, 4, { speed: 2 })), 2);
  assert.strictEqual(g.effectiveClipDuration(clip('a', 0, 4, { speed: 0.5 })), 8);
});

ok('atempoFactors decompose into [0.5,2] range', () => {
  assert.deepStrictEqual(g.atempoFactors(1), []);
  assert.deepStrictEqual(g.atempoFactors(4), [2, 2]);
  assert.deepStrictEqual(g.atempoFactors(0.25), [0.5, 0.5]);
  const f = g.atempoFactors(3);
  assert.ok(f.every((x) => x >= 0.5 && x <= 2));
  assert.ok(Math.abs(f.reduce((a, b) => a * b, 1) - 3) < 1e-6);
});

ok('totalDuration accounts for speed and overlaps', () => {
  const clips = [clip('a', 0, 4), clip('b', 0, 4), clip('c', 0, 4)];
  assert.strictEqual(g.totalDuration(clips, 1), 10);
  assert.strictEqual(g.totalDuration(clips, 0), 12);
});

ok('single clip passes through to vout/aout', () => {
  const { filter } = g.buildFilterComplex({ clips: [clip('a', 1, 3)] });
  assert.ok(filter.includes('[v0]null[vseq]'));
  assert.ok(filter.includes('[vseq]null[vout]'));
  assert.ok(filter.includes('[aseq]volume='));
});

ok('multi clip hard-cut concats video and audio separately', () => {
  const clips = [clip('a', 0, 2), clip('b', 0, 2)];
  const { filter } = g.buildFilterComplex({ clips, settings: { transition: 0 } });
  assert.ok(filter.includes('[v0][v1]concat=n=2:v=1:a=0[vseq]'));
  assert.ok(filter.includes('[a0][a1]concat=n=2:v=0:a=1[aseq]'));
});

ok('global transition emits xfade + acrossfade', () => {
  const clips = [clip('a', 0, 4), clip('b', 0, 4), clip('c', 0, 4)];
  const { filter } = g.buildFilterComplex({ clips, settings: { transition: 1 } });
  assert.ok(filter.includes('xfade=transition=fade:duration=1:offset=3'));
  assert.ok(filter.includes('acrossfade=d=1'));
  assert.ok(filter.includes('[vseq]null[vout]'));
});

ok('xfade offsets accumulate correctly', () => {
  // clips 4,6,8 with T=1 => offsets 3 then 8
  const clips = [clip('a', 0, 4), clip('b', 0, 6), clip('c', 0, 8)];
  const { filter } = g.buildFilterComplex({ clips, settings: { transition: 1 } });
  assert.ok(filter.includes('offset=3['), 'first offset 3');
  assert.ok(filter.includes('offset=8['), 'second offset 8');
});

ok('per-gap transition styles are honored', () => {
  const clips = [
    clip('a', 0, 4, { transitionToNext: { style: 'wipeleft', duration: 0.5 } }),
    clip('b', 0, 4, { transitionToNext: { style: 'cut' } }),
    clip('c', 0, 4),
  ];
  const { filter } = g.buildFilterComplex({ clips });
  assert.ok(filter.includes('xfade=transition=wipeleft:duration=0.5'));
  // second gap is a hard cut -> concat, not xfade
  assert.ok(filter.includes('concat=n=2:v=1:a=0'));
});

ok('speed adds setpts + atempo', () => {
  const clips = [clip('a', 0, 4, { speed: 2 })];
  const { filter } = g.buildFilterComplex({ clips });
  assert.ok(filter.includes('setpts=0.5*PTS'));
  assert.ok(filter.includes('atempo=2'));
});

ok('reverse adds reverse + areverse', () => {
  const clips = [clip('a', 0, 4, { reverse: true })];
  const { filter } = g.buildFilterComplex({ clips });
  assert.ok(filter.includes(',reverse,'));
  assert.ok(filter.includes(',areverse,'));
});

ok('clip original audio supports gain and post-speed fades', () => {
  const clips = [clip('a', 0, 4, { speed: 2, volume: 0.6, fadeIn: 0.4, fadeOut: 0.5 })];
  const { filter } = g.buildFilterComplex({ clips });
  assert.ok(filter.includes('atempo=2,volume=0.6,afade=t=in:st=0:d=0.4,afade=t=out:st=1.5:d=0.5'));
});

ok('muted main clip synthesizes silence while keeping timing valid', () => {
  const { filter, silentInputs } = g.buildFilterComplex({ clips: [clip('a', 0, 4, { muted: true })] });
  assert.ok(!filter.includes('[0:a]atrim='));
  assert.deepStrictEqual(silentInputs, [{ forClip: 0, duration: 4 }]);
});

ok('color grade adds eq and colortemperature', () => {
  const clips = [clip('a', 0, 4, { color: { brightness: 0.1, contrast: 1.2, saturation: 1.5, temperature: 50 } })];
  const { filter } = g.buildFilterComplex({ clips });
  assert.ok(filter.includes('eq=brightness=0.1:contrast=1.2:saturation=1.5'));
  assert.ok(filter.includes('colortemperature=temperature='));
});

ok('advanced clip grade adds hue gamma curves and LUT', () => {
  const clips = [clip('a', 0, 4, { color: { hue: 30, gamma: 1.2, curve: 'contrast', lutPath: '/tmp/look.cube' } })];
  const { filter } = g.buildFilterComplex({ clips });
  assert.ok(filter.includes('gamma=1.2'));
  assert.ok(filter.includes('hue=h=30'));
  assert.ok(filter.includes('curves=all='));
  assert.ok(filter.includes('lut3d=file='));
});

ok('named clip effects compile to deterministic FFmpeg filters', () => {
  const mono = g.buildFilterComplex({ clips: [clip('a', 0, 2, { effect: 'mono' })] }).filter;
  const vintage = g.buildFilterComplex({ clips: [clip('a', 0, 2, { effect: 'vintage' })] }).filter;
  const soft = g.buildFilterComplex({ clips: [clip('a', 0, 2, { effect: 'soft' })] }).filter;
  const sharpen = g.buildFilterComplex({ clips: [clip('a', 0, 2, { effect: 'sharpen' })] }).filter;
  assert.ok(mono.includes('hue=s=0'));
  assert.ok(vintage.includes('hue=s=0.72'));
  assert.ok(soft.includes('gblur=sigma=1.2'));
  assert.ok(sharpen.includes('unsharp=5:5:0.8:5:5:0'));
});

ok('vignette and grain combine with named clip effects', () => {
  const { filter } = g.buildFilterComplex({ clips: [clip('a', 0, 2, { effect: 'vintage', vignette: 0.5, grain: 0.4 })] });
  assert.ok(filter.includes('hue=s=0.72'));
  assert.ok(filter.includes('vignette=angle=0.75:eval=init'));
  assert.ok(filter.includes('noise=alls=24:allf=t+u'));
});

ok('blur fill mode builds split/gblur/overlay background', () => {
  const clips = [clip('a', 0, 4, { fillMode: 'blur' })];
  const { filter } = g.buildFilterComplex({ clips });
  assert.ok(filter.includes('split[c0bg][c0fg]'));
  assert.ok(filter.includes('gblur=sigma=20'));
  assert.ok(filter.includes('overlay=(W-w)/2:(H-h)/2'));
});

ok('uses a validated canvas background color for pad and rotation regions', () => {
  const { filter } = g.buildFilterComplex({
    clips: [clip('a', 0, 2, { rotation: 10 })],
    settings: { backgroundColor: '#123456' },
  });
  assert.ok(filter.includes('color=0x123456'));
  assert.strictEqual(g.ffmpegColor('#abcdef'), '0xABCDEF');
  assert.strictEqual(g.ffmpegColor('invalid'), '0x000000');
});

ok('clip geometry compiles crop mirrors and rotation before effects', () => {
  const clips = [clip('a', 0, 4, {
    crop: { left: 0.1, right: 0.05, top: 0.02, bottom: 0.03 },
    mirrorX: true, mirrorY: true, rotation: 15,
  })];
  const { filter } = g.buildFilterComplex({ clips });
  assert.ok(filter.includes("crop=w='iw*(1-0.15)':h='ih*(1-0.05)':x='iw*0.1':y='ih*0.02'"));
  assert.ok(filter.includes(',hflip,vflip,'));
  assert.ok(filter.includes('rotate=15*PI/180:ow=rotw(iw):oh=roth(ih):c=0x000000'));
});

ok('clip framing transform handles zoom, pan and scale-down canvas exposure', () => {
  const zoom = g.buildFilterComplex({ clips: [clip('a', 0, 2, { transformScale: 1.5, transformX: 50, transformY: -50 })] }).filter;
  const down = g.buildFilterComplex({ clips: [clip('a', 0, 2, { transformScale: 0.7, transformX: 50, transformY: -50 })], settings: { backgroundColor: '#123456' } }).filter;
  const pan = g.buildFilterComplex({ clips: [clip('a', 0, 2, { transformX: 50 })] }).filter;
  assert.ok(zoom.includes('scale=1920:1080,crop=1280:720'));
  assert.ok(down.includes('scale=896:504,pad=1280:720'));
  assert.ok(down.includes('color=0x123456'));
  assert.ok(pan.includes('pad=3840:2160'));
});

ok('ken-burns motion adds zoompan', () => {
  const clips = [clip('a', 0, 4, { motion: 'zoomIn' })];
  const { filter } = g.buildFilterComplex({ clips });
  assert.ok(filter.includes('zoompan=z='));
});

ok('clip animations compile fade and bounded directional slide filters', () => {
  const fade = g.buildFilterComplex({
    clips: [clip('a', 0, 4, { animationIn: { style: 'fade', duration: 0.8 }, animationOut: { style: 'fade', duration: 1 } })],
  }).filter;
  const slide = g.buildFilterComplex({
    clips: [clip('a', 0, 4, { animationIn: { style: 'slideLeft', duration: 1 }, animationOut: { style: 'slideUp', duration: 1 } })],
  }).filter;
  const bounded = g.clipAnimation({ animationIn: { style: 'fade', duration: 9 } }, 'animationIn', 3);
  assert.ok(fade.includes('fade=t=in:st=0:d=0.8:color=0x000000'));
  assert.ok(fade.includes('fade=t=out:st=3:d=1:color=0x000000'));
  assert.ok(slide.includes('pad=w=iw*3:h=ih*3'));
  assert.ok(slide.includes("crop=w=iw/3:h=ih/3:x='"));
  assert.deepStrictEqual(bounded, { style: 'fade', duration: 1.5 });
});

ok('main clip opacity composites against the selected canvas background', () => {
  const { filter } = g.buildFilterComplex({
    clips: [clip('a', 0, 2, { opacity: 0.35 })],
    settings: { backgroundColor: '#123456' },
  });
  assert.ok(filter.includes('colorchannelmixer=aa=0.35'));
  assert.ok(filter.includes('color=c=0x123456:s=1280x720:d=2'));
  assert.ok(filter.includes('overlay=0:0:format=auto'));
});

ok('main clip transform keyframes compile scale position and opacity on local time', () => {
  const { filter } = g.buildFilterComplex({
    clips: [clip('a', 0, 3, {
      transformKeyframes: [
        { time: 0, x: 0, y: 0, scale: 1, opacity: 1, curve: 'easeIn' },
        { time: 2, x: 50, y: -25, scale: 1.4, opacity: 0.35, curve: 'linear' },
      ],
    })],
  });
  assert.ok(filter.includes("scale=w='trunc(iw*(if(lt(t,0)"));
  assert.ok(filter.includes("overlay=x='(W-w)/2+abs(W-w)*(if(lt(t,0)"));
  assert.ok(filter.includes("a='alpha(X,Y)*(if(lt(T,0)"));
});

ok('clip stabilization uses bounded one-pass deshake presets', () => {
  const basic = g.buildFilterComplex({ clips: [clip('a', 0, 4, { stabilize: 'basic' })] }).filter;
  const strong = g.buildFilterComplex({ clips: [clip('a', 0, 4, { stabilize: 'strong' })] }).filter;
  const off = g.buildFilterComplex({ clips: [clip('a', 0, 4, { stabilize: 'off' })] }).filter;
  assert.ok(basic.includes('deshake=rx=16:ry=16:edge=mirror'));
  assert.ok(strong.includes('deshake=rx=32:ry=32:blocksize=16:contrast=100:edge=mirror'));
  assert.ok(!off.includes('deshake='));
});

ok('subtitles filter injected when assPath set', () => {
  const clips = [clip('a', 0, 4)];
  const { filter } = g.buildFilterComplex({ clips, settings: { assPath: '/tmp/x.ass', fontsDir: '/tmp/fonts' } });
  assert.ok(filter.includes('subtitles=filename='));
  assert.ok(filter.includes('fontsdir='));
});

ok('image overlay loops input and composes with overlay filter', () => {
  const clips = [clip('a', 0, 5)];
  const spec = {
    clips,
    overlays: [{ path: 'logo.png', kind: 'image', start: 1, end: 4, x: 20, y: 20, scale: 0.3 }],
    output: 'o.mp4',
  };
  const { args, filter } = g.buildFFmpegArgs(spec);
  assert.ok(filter.includes('overlay=x='));
  assert.ok(filter.includes("enable='between(t,1,4)'"));
  // image overlay must be a looped input: -loop 1 -t <end> -i logo.png
  const idx = args.indexOf('logo.png');
  assert.ok(idx > 0 && args[idx - 1] === '-i' && args[idx - 5] === '-loop');
});

ok('main-timeline image clip is looped for its configured duration', () => {
  const spec = { clips: [clip('still.png', 0, 3, { kind: 'image', hasAudio: false })], output: 'o.mp4' };
  const { args, filter } = g.buildFFmpegArgs(spec);
  const index = args.indexOf('still.png');
  assert.ok(index > 0 && args[index - 1] === '-i');
  assert.deepStrictEqual(args.slice(index - 7, index), ['-loop', '1', '-framerate', '30', '-t', '3', '-i']);
  assert.ok(args.includes('-framerate'));
  assert.ok(filter.includes('[1:a]atrim=duration=3'));
});

ok('overlay move produces interpolated x/y expression', () => {
  const clips = [clip('a', 0, 5)];
  const { filter } = g.buildFilterComplex({
    clips,
    overlays: [{ path: 'p.png', kind: 'image', start: 0, end: 5, x: 0, y: 0, move: { toX: 100, toY: 50 } }],
  });
  assert.ok(/overlay=x='0\+\(100\)\*/.test(filter));
});

ok('keyframes compile position, scale and opacity curves', () => {
  const clips = [clip('a', 0, 5)];
  const { filter } = g.buildFilterComplex({
    clips,
    overlays: [{
      path: 'p.png', kind: 'image', start: 0, end: 5, x: 0, y: 0, scale: 0.2, opacity: 1,
      keyframes: [
        { time: 0, x: 0, y: 0, scale: 0.2, opacity: 0, curve: 'easeIn' },
        { time: 2, x: 100, y: 50, scale: 0.5, opacity: 1, curve: 'easeOut' },
        { time: 5, x: 200, y: 100, scale: 0.3, opacity: 0.4, curve: 'linear' },
      ],
    }],
  });
  assert.ok(filter.includes("scale=w='1280*(if("), 'scale uses a per-frame keyframe expression');
  assert.ok(filter.includes('eval=frame'));
  assert.ok(filter.includes('geq=lum='), 'opacity uses an animated alpha expression');
  assert.ok(filter.includes("overlay=x='if(lt(t,0)"), 'x keyframes are evaluated on output time');
  assert.ok(filter.includes("y='if(lt(t,0)"), 'y keyframes are evaluated on output time');
});

ok('static and keyframed rotation compile through rotate filter', () => {
  const clips = [clip('a', 0, 5)];
  const { filter } = g.buildFilterComplex({
    clips,
    overlays: [
      { path: 'a.png', kind: 'image', start: 0, end: 2, x: 0, y: 0, rotation: 45 },
      { path: 'b.png', kind: 'image', start: 2, end: 5, x: 0, y: 0, keyframes: [
        { time: 2, x: 0, y: 0, scale: 0.4, opacity: 1, rotation: 0, curve: 'linear' },
        { time: 5, x: 0, y: 0, scale: 0.4, opacity: 1, rotation: 90, curve: 'linear' },
      ] },
    ],
  });
  assert.ok(filter.includes('rotate=45*PI/180'));
  assert.ok(filter.includes("rotate='(if(lt(t,0)"));
});

ok('custom bezier keyframes compile y control points into FFmpeg expression', () => {
  const clips = [clip('a', 0, 3)];
  const { filter } = g.buildFilterComplex({
    clips,
    overlays: [{ path: 'p.png', kind: 'image', start: 0, end: 3, x: 0, y: 0, keyframes: [
      { time: 0, x: 0, y: 0, scale: 0.4, opacity: 1, rotation: 0, curve: 'bezier', bezier: { x1: 0.2, y1: 0.8, x2: 0.8, y2: 0.2 } },
      { time: 3, x: 100, y: 0, scale: 0.4, opacity: 1, rotation: 0, curve: 'linear' },
    ] }],
  });
  assert.ok(filter.includes('*0.8+3*'));
  assert.ok(filter.includes('*0.2+('));
});

ok('video overlay is looped at input and trimmed to its visible duration', () => {
  const clips = [clip('a', 0, 5)];
  const { args, filter } = g.buildFFmpegArgs({
    clips,
    overlays: [{ path: 'pip.mp4', kind: 'video', start: 1, end: 4 }],
    output: 'o.mp4',
  });
  const idx = args.indexOf('pip.mp4');
  assert.ok(idx > 0 && args[idx - 2] === '-1' && args[idx - 3] === '-stream_loop');
  assert.ok(filter.includes('trim=start=0:duration=3'));
});

ok('B-roll is cover-fit, source-trimmed, and composed before normal overlays', () => {
  const clips = [clip('a', 0, 5)];
  const { args, filter } = g.buildFFmpegArgs({
    clips, output: 'o.mp4',
    brolls: [{ path: 'broll.mp4', kind: 'video', start: 1, end: 4, trimStart: 0.5, loop: false, fit: 'cover', x: 0, y: 0, scale: 1, opacity: 0.8 }],
    overlays: [{ path: 'logo.png', kind: 'image', start: 1, end: 4, x: 10, y: 10, scale: 0.2 }],
  });
  assert.ok(filter.includes('trim=start=0.5:duration=3'));
  assert.ok(filter.includes('scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720'));
  assert.ok(filter.indexOf('[vseq][ov0]overlay') < filter.indexOf('[vov0][ov1]overlay'));
  const idx = args.indexOf('broll.mp4');
  assert.ok(idx > 0 && args[idx - 1] === '-i' && args[idx - 2] !== '-1', 'non-loop B-roll is not demux-looped');
});

ok('overlay image processing compiles crop flips mask chromakey and blend', () => {
  const clips = [clip('a', 0, 4)];
  const { filter } = g.buildFilterComplex({
    clips,
    overlays: [{ path: 'green.png', kind: 'image', start: 0, end: 3, x: 0, y: 0, scale: 0.3, mirrorX: true, mirrorY: true, crop: { left: 0.1, right: 0.1, top: 0.05, bottom: 0.05 }, mask: 'ellipse', chromaKey: { enabled: true, color: '#00ff00', similarity: 0.2, blend: 0.1 }, blendMode: 'screen' }],
  });
  assert.ok(filter.includes('crop=w='));
  assert.ok(filter.includes(',hflip,vflip'));
  assert.ok(filter.includes('chromakey=#00ff00:0.2:0.1'));
  assert.ok(filter.includes('geq=lum='));
  assert.ok(filter.includes('blend=all_mode=screen'));
});

ok('advanced masks compile rounded invert and feathered alpha expressions', () => {
  const clips = [clip('a', 0, 3)];
  const { filter } = g.buildFilterComplex({
    clips,
    overlays: [{ path: 'mask.png', kind: 'image', start: 0, end: 2, x: 0, y: 0, mask: 'rounded', maskInvert: true, maskFeather: 0.15 }],
  });
  assert.ok(filter.includes('max(abs('));
  assert.ok(filter.includes('clip((1-('));
  assert.ok(filter.includes('1-('));
});

ok('bgm adds looped input, volume, amix', () => {
  const clips = [clip('a', 0, 5)];
  const out = g.buildFFmpegArgs({
    clips,
    bgm: { path: 'music.mp3' },
    output: 'out.mp4',
    settings: { originalVolume: 0.8, bgmVolume: 0.3 },
  });
  assert.ok(out.filter.includes('volume=0.3[bgmraw]'));
  assert.ok(out.filter.includes('volume=0.8[amain]'));
  assert.ok(out.filter.includes('[amain][bgmraw]amix=inputs=2'));
  assert.ok(out.args.includes('-stream_loop'));
});

ok('BGM supports source offset and timeline fades', () => {
  const clips = [clip('a', 0, 4)];
  const out = g.buildFFmpegArgs({
    clips, bgm: { path: 'music.mp3', trimStart: 1.2, fadeIn: 0.5, fadeOut: 0.8 }, output: 'out.mp4',
  });
  assert.ok(out.filter.includes('atrim=start=1.2:duration=4'));
  assert.ok(out.filter.includes('afade=t=in:st=0:d=0.5'));
  assert.ok(out.filter.includes('afade=t=out:st=3.2:d=0.8'));
});

ok('BGM ducking sidechains original audio and final loudness normalizes output', () => {
  const clips = [clip('a', 0, 5)];
  const out = g.buildFFmpegArgs({
    clips, bgm: { path: 'music.mp3' }, output: 'out.mp4',
    settings: { originalVolume: 0.8, bgmVolume: 0.3, bgmDuck: true, bgmDuckAmount: 0.5, loudnessNormalize: true },
  });
  assert.ok(out.filter.includes('[amain]asplit=2[amainmix][aduckside]'));
  assert.ok(out.filter.includes('[bgmraw][aduckside]sidechaincompress='));
  assert.ok(out.filter.includes('ratio=10.5'));
  assert.ok(out.filter.includes('loudnorm=I=-14:LRA=11:TP=-1.5[aout]'));
  assert.ok(out.filter.includes('[amainmix][bgm]amix=inputs=2'));
});

ok('no bgm still applies original volume', () => {
  const clips = [clip('a', 0, 5)];
  const out = g.buildFFmpegArgs({ clips, output: 'out.mp4', settings: { originalVolume: 0.5 } });
  assert.ok(out.filter.includes('volume=0.5[amain]'));
  assert.ok(out.filter.includes('[amain]anull[amixed]'));
  assert.ok(out.filter.includes('[amixed]anull[aout]'));
  assert.ok(!out.filter.includes('amix=inputs'));
  assert.ok(!out.args.includes('-stream_loop'));
});

ok('independent audio tracks are trimmed, delayed, faded and mixed', () => {
  const clips = [clip('a', 0, 6)];
  const out = g.buildFFmpegArgs({
    clips, output: 'out.mp4',
    audioTracks: [
      { path: 'voice.wav', start: 1.25, end: 4.25, trimStart: 0.5, volume: 0.7, fadeIn: 0.2, fadeOut: 0.4 },
      { path: 'loop.mp3', start: 0, end: 6, volume: 0.3, loop: true },
    ],
  });
  assert.ok(out.filter.includes('[1:a]atrim=start=0.5:duration=3'));
  assert.ok(out.filter.includes('volume=0.7,afade=t=in:st=0:d=0.2'));
  assert.ok(out.filter.includes('afade=t=out:st=2.6:d=0.4'));
  assert.ok(out.filter.includes('adelay=1250:all=1[atrack0]'));
  assert.ok(out.filter.includes('amix=inputs=3'));
  const voice = out.args.indexOf('voice.wav');
  const loop = out.args.indexOf('loop.mp3');
  assert.ok(voice > 0 && out.args[voice - 1] === '-i');
  assert.ok(loop > voice && out.args[loop - 1] === '-i' && out.args[loop - 2] === '-1');
});

ok('independent audio mute ranges compile a frame-evaluated zero-gain expression', () => {
  const out = g.buildFFmpegArgs({
    clips: [clip('a', 0, 4)],
    audioTracks: [{ path: 'voice.wav', start: 0, end: 4, muteRanges: [{ start: 1, end: 2 }, { start: 2.5, end: 3 }] }],
    output: 'out.mp4',
  });
  assert.ok(out.filter.includes("volume='if(gt(between(t,1,2)+between(t,2.5,3),0),0,1)':eval=frame"));
  assert.deepStrictEqual(g.normaliseMuteRanges([{ start: 2, end: 3 }, { start: 1, end: 2.2 }], 4), [{ start: 1, end: 3 }]);
});

ok('audio track voice processing compiles pitch, denoise and enhancement chain', () => {
  const clips = [clip('a', 0, 5)];
  const out = g.buildFFmpegArgs({
    clips, output: 'out.mp4',
    audioTracks: [{ path: 'voice.wav', start: 0, end: 4, speed: 1.25, pitch: 3, denoise: true, voiceEnhance: true }],
  });
  assert.ok(out.filter.includes('atempo=1.25'));
  assert.ok(out.filter.includes('rubberband=pitch='));
  assert.ok(out.filter.includes('afftdn=nr=12:nf=-35'));
  assert.ok(out.filter.includes('dynaudnorm=f=150:g=7:p=0.9'));
});

ok('silent clip synthesizes anullsrc of effective length', () => {
  const clips = [clip('a', 0, 2, { hasAudio: true }), clip('b', 0, 4, { hasAudio: false, speed: 2 })];
  const res = g.buildFilterComplex({ clips, settings: { transition: 0 } });
  assert.strictEqual(res.silentInputs.length, 1);
  assert.strictEqual(res.silentInputs[0].forClip, 1);
  // effective duration = 4 / 2 = 2
  assert.strictEqual(res.silentInputs[0].duration, 2);
  assert.ok(res.filter.includes('[2:a]atrim=duration=2'));
});

ok('inputs are laid in documented order (clips, silence, bgm, tracks, overlays)', () => {
  const clips = [clip('a.mp4', 0, 2, { hasAudio: true }), clip('b.mp4', 0, 2, { hasAudio: false })];
  const { args } = g.buildFFmpegArgs({
    clips,
    bgm: { path: 'm.mp3' },
    audioTracks: [{ path: 'voice.wav', start: 0, end: 2 }],
    overlays: [{ path: 'ov.png', kind: 'image', start: 0, end: 2 }],
    output: 'o.mp4',
  });
  const iPositions = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '-i') iPositions.push(args[i + 1]);
  assert.deepStrictEqual(iPositions.slice(0, 2), ['a.mp4', 'b.mp4']);
  assert.ok(iPositions.some((x) => x.startsWith('anullsrc')));
  assert.ok(iPositions.includes('m.mp3'));
  assert.ok(iPositions.includes('voice.wav'));
  assert.strictEqual(iPositions[iPositions.length - 1], 'ov.png');
});

ok('output path and codecs present', () => {
  const clips = [clip('a', 0, 2)];
  const { args } = g.buildFFmpegArgs({ clips, output: '/tmp/final.mp4' });
  assert.strictEqual(args[args.length - 1], '/tmp/final.mp4');
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('+faststart'));
});

ok('custom output dimensions and frame rate flow through the video graph', () => {
  const { filter } = g.buildFilterComplex({
    clips: [clip('a', 0, 2)],
    settings: { width: 2160, height: 3840, fps: 60 },
  });
  assert.ok(filter.includes('scale=2160:3840:force_original_aspect_ratio=decrease'));
  assert.ok(filter.includes('fps=60'));
});

ok('escapeFilterPath escapes colon and backslash', () => {
  assert.strictEqual(g.escapeFilterPath('C:\\a\\b.ass'), 'C\\:/a/b.ass');
});

ok('throws on empty clips / missing output', () => {
  assert.throws(() => g.buildFilterComplex({ clips: [] }));
  assert.throws(() => g.buildFFmpegArgs({ clips: [clip('a', 0, 1)] }));
});

console.log(`\n${passed} passed`);
