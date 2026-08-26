'use strict';

const keyframes = require('./keyframe-utils');
const clipTransforms = require('./clip-transform-utils');

/**
 * Pure FFmpeg filter-graph builder for MiniClip desktop.
 *
 * Zero dependencies on Electron or the filesystem, so it can be unit-tested in
 * isolation. Given a timeline spec it produces the ffmpeg `argv` (everything
 * after the binary path) that renders the final mp4.
 *
 * Feature coverage (CapCut-aligned subset that FFmpeg can do losslessly):
 *   - per-clip trim
 *   - per-clip speed 0.25–4x (video setpts + audio atempo chain) and reverse
 *   - per-clip color grade (eq brightness/contrast/saturation + colortemperature)
 *   - per-clip ken-burns motion (zoompan zoom in / out) and deshake repair
 *   - per-clip visual in/out animations (fade and four-direction slide)
 *   - per-GAP transitions (each boundary can be a hard cut or an xfade style;
 *     audio uses acrossfade to stay in lockstep)
 *   - output aspect canvas + fill mode (black pad OR blurred background)
 *   - media overlays / picture-in-picture / stickers (image or video), with
 *     position, scale, opacity, fade, and simple linear move
 *   - burned-in subtitles/titles via libass (an .ass file built elsewhere)
 *   - looping background music and independently placed audio clips mixed
 *     against the original audio
 *
 * All timing math threads "effective" durations (trimmed / speed) so totals and
 * xfade offsets stay correct when clips are sped up or slowed down.
 */

/** Round to 6 decimals, avoid "-0" and scientific notation. */
function num(x) {
  const r = Math.round((Number(x) + Number.EPSILON) * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

/** Raw trimmed duration of a clip (before speed), never negative. */
function clipDuration(clip) {
  return Math.max(0, Number(clip.trimEnd) - Number(clip.trimStart));
}

/** Clamp speed to the supported range. */
function clipSpeed(clip) {
  const s = Number(clip && clip.speed);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(4, Math.max(0.25, s));
}

/** Duration the clip actually occupies on the timeline (after speed). */
function effectiveClipDuration(clip) {
  return clipDuration(clip) / clipSpeed(clip);
}

/**
 * Decompose a speed factor into a chain of atempo values, each within the
 * filter's safe [0.5, 2.0] range (e.g. 4x -> [2,2], 0.25x -> [0.5,0.5]).
 */
function atempoFactors(speed) {
  let s = speed;
  const out = [];
  if (Math.abs(s - 1) < 1e-9) return out;
  while (s > 2 + 1e-9) { out.push(2); s /= 2; }
  while (s < 0.5 - 1e-9) { out.push(0.5); s /= 0.5; }
  out.push(Math.round(s * 1e6) / 1e6);
  return out;
}

/**
 * Legacy helpers kept for the simple global-transition case and older tests.
 * New per-gap logic lives in buildFilterComplex.
 */
function clampTransition(clips, requested) {
  const t = Math.max(0, Number(requested) || 0);
  if (t <= 0 || clips.length < 2) return 0;
  const shortest = Math.min(...clips.map(effectiveClipDuration));
  const clamped = Math.min(t, shortest / 2);
  return clamped > 0.02 ? clamped : 0;
}

function totalDuration(clips, transition) {
  const sum = clips.reduce((acc, c) => acc + effectiveClipDuration(c), 0);
  const t = transition > 0 ? transition * (clips.length - 1) : 0;
  return Math.max(0, sum - t);
}

const DEFAULTS = {
  width: 1280,
  height: 720,
  fps: 30,
  sampleRate: 44100,
  originalVolume: 1.0,
  bgmVolume: 0.5,
  bgmDuck: false,
  bgmDuckAmount: 0.35, // 0.1 gentle .. 0.8 strong
  loudnessNormalize: false,
  transition: 0,          // global fallback transition duration (fade)
  transitionStyle: 'fade',
  fillMode: 'pad',        // 'pad' (black bars) | 'blur' (blurred background)
  backgroundColor: '#000000',
  crf: 20,
  preset: 'medium',
  audioBitrate: '192k',
};

/** Known xfade style names we expose in the UI (all built into ffmpeg xfade). */
const XFADE_STYLES = [
  'fade', 'fadeblack', 'fadewhite', 'dissolve',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'smoothleft', 'smoothright', 'circleopen', 'circleclose',
  'radial', 'pixelize', 'hlslice', 'diagtl',
];

/** Visual animation styles shared by the clip inspector and project format. */
const CLIP_ANIMATION_STYLES = ['none', 'fade', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'];

/** Resolve a bounded visual animation without changing the clip duration. */
function clipAnimation(clip, key, effectiveDuration) {
  const source = clip && clip[key] && typeof clip[key] === 'object' ? clip[key] : {};
  const style = CLIP_ANIMATION_STYLES.includes(source.style) ? source.style : 'none';
  const max = Math.min(2, Math.max(0, Number(effectiveDuration) || 0) / 2);
  const duration = Math.min(max, Math.max(0, Number(source.duration) || 0));
  return { style, duration: style === 'none' || duration <= 0.02 ? 0 : duration };
}

/** Resolve the transition for the gap after clip index i. */
function gapTransition(clips, i, settings) {
  const clip = clips[i];
  let style = settings.transitionStyle || 'fade';
  let duration = 0;
  if (clip && clip.transitionToNext && typeof clip.transitionToNext === 'object') {
    style = clip.transitionToNext.style || style;
    duration = Number(clip.transitionToNext.duration) || 0;
  } else if (settings.transition > 0) {
    // Global fallback: same fade on every gap.
    duration = settings.transition;
  }
  if (style === 'none' || style === 'cut') duration = 0;
  if (!XFADE_STYLES.includes(style)) style = 'fade';
  // Clamp so both neighbours keep a solo region.
  const bound = Math.min(effectiveClipDuration(clips[i]), effectiveClipDuration(clips[i + 1])) / 2;
  duration = Math.min(duration, bound);
  return { style, duration: duration > 0.02 ? duration : 0 };
}

/** Escape a filesystem path for use inside a filtergraph string value. */
function escapeFilterPath(p) {
  // Forward slashes work on every platform for libass; then escape the
  // drive-letter colon and any quote. The whole value is wrapped in single
  // quotes by the caller and passed as one argv element (no shell involved).
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** CSS #RRGGBB -> FFmpeg-safe 0xRRGGBB. */
function ffmpegColor(value, fallback = '0x000000') {
  const match = String(value || '').match(/^#?([0-9a-f]{6})$/i);
  return match ? '0x' + match[1].toUpperCase() : fallback;
}

/**
 * Apply visual entry/exit animation after a clip has been normalized to the
 * canvas. Slide animations keep a stable WxH result via temporary 3× padding
 * and a local-time crop, preserving compatibility with xfade and overlays.
 */
function applyClipAnimations(cur, clip, effectiveDuration, background) {
  const incoming = clipAnimation(clip, 'animationIn', effectiveDuration);
  const outgoing = clipAnimation(clip, 'animationOut', effectiveDuration);

  if (incoming.style === 'fade') cur += `,fade=t=in:st=0:d=${num(incoming.duration)}:color=${background}`;
  if (outgoing.style === 'fade') {
    cur += `,fade=t=out:st=${num(Math.max(0, effectiveDuration - outgoing.duration))}:d=${num(outgoing.duration)}:color=${background}`;
  }

  const isSlide = (style) => /^slide/.test(style);
  if (!isSlide(incoming.style) && !isSlide(outgoing.style)) return cur;

  const inProgress = incoming.duration > 0 ? `clip(t/${num(incoming.duration)},0,1)` : '1';
  const outProgress = outgoing.duration > 0
    ? `clip((t-${num(Math.max(0, effectiveDuration - outgoing.duration))})/${num(outgoing.duration)},0,1)`
    : '0';
  const dx = [];
  const dy = [];
  // slideLeft moves content left: it enters from right and leaves at left.
  if (incoming.style === 'slideLeft') dx.push(`iw/3*(1-${inProgress})`);
  if (incoming.style === 'slideRight') dx.push(`-iw/3*(1-${inProgress})`);
  if (incoming.style === 'slideUp') dy.push(`ih/3*(1-${inProgress})`);
  if (incoming.style === 'slideDown') dy.push(`-ih/3*(1-${inProgress})`);
  if (outgoing.style === 'slideLeft') dx.push(`-iw/3*${outProgress}`);
  if (outgoing.style === 'slideRight') dx.push(`iw/3*${outProgress}`);
  if (outgoing.style === 'slideUp') dy.push(`-ih/3*${outProgress}`);
  if (outgoing.style === 'slideDown') dy.push(`ih/3*${outProgress}`);

  const x = dx.length ? `iw/3-(${dx.join('+')})` : 'iw/3';
  const y = dy.length ? `ih/3-(${dy.join('+')})` : 'ih/3';
  return `${cur},pad=w=iw*3:h=ih*3:x=iw:y=ih:color=${background},crop=w=iw/3:h=ih/3:x='${x}':y='${y}'`;
}

/**
 * Build the per-clip normalized VIDEO chain, ending in label [v{i}].
 * Applies: trim, reverse, geometry (fill mode) to the WxH canvas, optional
 * deshake repair, color grade, speed (setpts), fps, and Ken-Burns motion.
 */
function buildClipVideo(i, clip, settings) {
  const W = settings.width, H = settings.height, F = settings.fps;
  const d = clipDuration(clip);
  const ts = Number(clip.trimStart) || 0;
  const te = ts + d;
  const speed = clipSpeed(clip);
  const fill = clip.fillMode || settings.fillMode;
  const background = ffmpegColor(settings.backgroundColor);
  const stmts = [];
  const transformFrames = Array.isArray(clip.transformKeyframes) && clip.transformKeyframes.length
    ? clipTransforms.normalise(clip)
    : [];
  const animatedTransform = transformFrames.length > 0;

  // 1) trim + zero the timestamps; optional reverse.
  let cur = `[${i}:v]trim=start=${num(ts)}:end=${num(te)},setpts=PTS-STARTPTS`;
  if (clip.reverse) cur += `,reverse,setpts=PTS-STARTPTS`;

  // 2) source geometry then fill the canvas.
  const crop = clip.crop || {};
  const left = Math.max(0, Math.min(0.45, Number(crop.left) || 0));
  const right = Math.max(0, Math.min(0.45, Number(crop.right) || 0));
  const top = Math.max(0, Math.min(0.45, Number(crop.top) || 0));
  const bottom = Math.max(0, Math.min(0.45, Number(crop.bottom) || 0));
  if (left || right || top || bottom) {
    cur += `,crop=w='iw*(1-${num(left + right)})':h='ih*(1-${num(top + bottom)})':x='iw*${num(left)}':y='ih*${num(top)}'`;
  }
  if (clip.mirrorX) cur += ',hflip';
  if (clip.mirrorY) cur += ',vflip';
  if (fill === 'blur') {
    // background = cover + blur, foreground = contain, centered overlay.
    stmts.push(`${cur}[c${i}pre]`);
    stmts.push(
      `[c${i}pre]split[c${i}bg][c${i}fg]`
    );
    stmts.push(
      `[c${i}bg]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},gblur=sigma=20[c${i}bgb]`
    );
    stmts.push(
      `[c${i}fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[c${i}fgs]`
    );
    cur = `[c${i}bgb][c${i}fgs]overlay=(W-w)/2:(H-h)/2`;
  } else {
    cur +=
      `,scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${background}`;
  }
  cur += `,setsar=1`;
  const rotation = Number(clip.rotation) || 0;
  if (rotation !== 0) cur += `,rotate=${num(rotation)}*PI/180:ow=rotw(iw):oh=roth(ih):c=${background}`;
  // Rotation grows the frame, so normalize it back to the selected canvas.
  if (rotation !== 0) cur += `,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${background}`;
  // Per-clip framing transform after geometry: scale around the canvas center
  // and translate in canvas-relative percentages. A transparent pad exposes
  // the selected canvas background when the image is scaled down.
  const transformScale = Math.max(0.5, Math.min(2, Number(clip.transformScale) || 1));
  const transformX = Math.max(-100, Math.min(100, Number(clip.transformX) || 0));
  const transformY = Math.max(-100, Math.min(100, Number(clip.transformY) || 0));
  if (!animatedTransform && (transformScale !== 1 || transformX !== 0 || transformY !== 0)) {
    const scaledW = Math.max(2, Math.round(W * transformScale));
    const scaledH = Math.max(2, Math.round(H * transformScale));
    if (transformScale > 1) {
      const maxX = Math.max(0, scaledW - W), maxY = Math.max(0, scaledH - H);
      const cropX = Math.max(0, Math.min(maxX, Math.round(maxX / 2 - transformX / 100 * maxX / 2)));
      const cropY = Math.max(0, Math.min(maxY, Math.round(maxY / 2 - transformY / 100 * maxY / 2)));
      cur += `,scale=${scaledW}:${scaledH},crop=${W}:${H}:${cropX}:${cropY}`;
    } else if (transformScale === 1) {
      // At 100%, moving the clip is still meaningful: leave the exposed side
      // transparent/filled by the canvas background instead of silently doing
      // nothing. Work on a 3× canvas, then crop the centered viewport.
      const padX = Math.round(W + transformX / 100 * W);
      const padY = Math.round(H + transformY / 100 * H);
      cur += `,scale=${W}:${H},pad=${W * 3}:${H * 3}:${padX}:${padY}:color=${background},crop=${W}:${H}:${W}:${H}`;
    } else {
      const maxX = Math.max(0, W - scaledW), maxY = Math.max(0, H - scaledH);
      const padX = Math.max(0, Math.min(maxX, Math.round(maxX / 2 + transformX / 100 * maxX / 2)));
      const padY = Math.max(0, Math.min(maxY, Math.round(maxY / 2 + transformY / 100 * maxY / 2)));
      cur += `,scale=${scaledW}:${scaledH},pad=${W}:${H}:${padX}:${padY}:color=${background}`;
    }
  }

  // 3) Lightweight one-pass stabilization. It runs after normalising the
  // canvas, so its search radius is predictable across source resolutions.
  // Mirrored edges avoid black borders introduced by corrective movement.
  // FFmpeg's deshake accepts radii in multiples of 16.
  if (clip.stabilize === 'basic') cur += ',deshake=rx=16:ry=16:edge=mirror';
  if (clip.stabilize === 'strong') cur += ',deshake=rx=32:ry=32:blocksize=16:contrast=100:edge=mirror';

  // 4) color grade.
  const c = clip.color || {};
  const b = Number(c.brightness) || 0;         // -1..1
  const con = c.contrast == null ? 1 : Number(c.contrast);   // 0..2
  const sat = c.saturation == null ? 1 : Number(c.saturation); // 0..3
  const gamma = c.gamma == null ? 1 : Number(c.gamma);
  if (b !== 0 || con !== 1 || sat !== 1 || gamma !== 1) {
    cur += `,eq=brightness=${num(b)}:contrast=${num(con)}:saturation=${num(sat)}:gamma=${num(gamma)}`;
  }
  const temp = Number(c.temperature) || 0;     // -100(warm)..100(cool)
  if (temp !== 0) {
    // Map -100..100 around a 6500K neutral. Higher K = cooler.
    const kelvin = Math.max(1000, Math.min(40000, 6500 + (temp / 100) * 3000));
    cur += `,colortemperature=temperature=${num(kelvin)}`;
  }
  const hue = Number(c.hue) || 0;
  if (hue !== 0) cur += `,hue=h=${num(hue)}`;
  if (c.curve === 'lift') cur += ",curves=all='0/0 0.5/0.6 1/1'";
  if (c.curve === 'contrast') cur += ",curves=all='0/0 0.25/0.16 0.75/0.84 1/1'";
  if (c.lutPath) cur += `,lut3d=file='${escapeFilterPath(c.lutPath)}'`;
  // Purposeful, small local effect set. Effects are deterministic FFmpeg
  // filters, so they remain portable in project files and export reliably.
  if (clip.effect === 'mono') cur += ',hue=s=0,eq=contrast=1.15:gamma=1.04';
  if (clip.effect === 'vintage') cur += ",curves=all='0/0.04 0.25/0.19 0.75/0.81 1/0.93',hue=s=0.72";
  if (clip.effect === 'soft') cur += ',gblur=sigma=1.2';
  if (clip.effect === 'sharpen') cur += ',unsharp=5:5:0.8:5:5:0';
  // Parameterized finishing effects can be combined with any named preset.
  const vignette = Math.max(0, Math.min(1, Number(clip.vignette) || 0));
  const grain = Math.max(0, Math.min(1, Number(clip.grain) || 0));
  if (vignette > 0) cur += `,vignette=angle=${num(0.15 + vignette * 1.2)}:eval=init`;
  if (grain > 0) {
    const amount = Math.max(1, Math.round(8 + grain * 40));
    cur += `,noise=alls=${amount}:allf=t+u`;
  }

  // 5) speed (video), then constant fps.
  if (Math.abs(speed - 1) > 1e-9) cur += `,setpts=${num(1 / speed)}*PTS`;
  cur += `,fps=${F}`;

  // Dynamic main-clip transform keyframes use local post-speed time. Render a
  // scaled RGBA foreground over a same-size canvas background, then retain a
  // stable WxH stream for the downstream animation/transition chain.
  if (animatedTransform) {
    const initial = clipTransforms.valuesAt(clip, 0);
    const scaleChanges = keyframePropertyChanges(transformFrames, 'scale');
    const xChanges = keyframePropertyChanges(transformFrames, 'x');
    const yChanges = keyframePropertyChanges(transformFrames, 'y');
    const opacityChanges = keyframePropertyChanges(transformFrames, 'opacity');
    const scaleExpr = scaleChanges ? keyframeExpression(transformFrames, 'scale') : num(initial.scale);
    const xExpr = xChanges ? keyframeExpression(transformFrames, 'x') : num(initial.x);
    const yExpr = yChanges ? keyframeExpression(transformFrames, 'y') : num(initial.y);
    const opacityExpr = opacityChanges ? keyframeExpression(transformFrames, 'opacity').replace(/\bt\b/g, 'T') : num(initial.opacity);
    const duration = effectiveClipDuration(clip);
    let foreground = `[c${i}tf]`;
    stmts.push(`${cur},format=rgba,scale=w='trunc(iw*(${scaleExpr})/2)*2':h='trunc(ih*(${scaleExpr})/2)*2':eval=frame[c${i}tf]`);
    if (opacityChanges) {
      stmts.push(`${foreground}format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(${opacityExpr})',format=rgba[c${i}tfa]`);
      foreground = `[c${i}tfa]`;
    } else if (initial.opacity < 1) {
      stmts.push(`${foreground}colorchannelmixer=aa=${opacityExpr}[c${i}tfa]`);
      foreground = `[c${i}tfa]`;
    }
    stmts.push(`color=c=${background}:s=${W}x${H}:d=${num(duration)},format=rgba[c${i}tfbg]`);
    cur = `[c${i}tfbg]${foreground}overlay=x='(W-w)/2+abs(W-w)*(${xExpr})/200':y='(H-h)/2+abs(H-h)*(${yExpr})/200':format=auto`;
  }

  // 6) optional ken-burns motion (reliable d=1 zoompan, 1 in : 1 out).
  const motion = clip.motion || 'none';
  if (motion === 'zoomIn' || motion === 'zoomOut') {
    const effDur = effectiveClipDuration(clip);
    const frames = Math.max(1, Math.round(effDur * F));
    const range = 0.25; // zoom span
    const step = range / frames;
    const zExpr = motion === 'zoomIn'
      ? `min(zoom+${num(step)},${num(1 + range)})`
      : `if(eq(on,0),${num(1 + range)},max(zoom-${num(step)},1))`;
    cur +=
      `,zoompan=z='${zExpr}':d=1:` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${F}`;
  }

  // 7) Visual entry / exit animation. It affects picture only: clip audio
  // retains its own fades and remains in sync with this unchanged duration.
  cur = applyClipAnimations(cur, clip, effectiveClipDuration(clip), background);

  // 8) Composite a partly transparent main clip onto the canvas background.
  // H.264 output has no alpha, so this is a real background reveal rather than
  // a transient alpha channel that would disappear in the encoded file.
  const opacity = Math.max(0, Math.min(1, Number(clip.opacity == null ? 1 : clip.opacity)));
  if (!animatedTransform && opacity < 1) {
    const duration = effectiveClipDuration(clip);
    stmts.push(`${cur},format=rgba,colorchannelmixer=aa=${num(opacity)}[c${i}opacity]`);
    stmts.push(`color=c=${background}:s=${W}x${H}:d=${num(duration)},format=rgba[c${i}opacitybg]`);
    cur = `[c${i}opacitybg][c${i}opacity]overlay=0:0:format=auto`;
  }

  cur += `,format=yuv420p[v${i}]`;
  stmts.push(cur);
  return stmts;
}

/** Build the per-clip normalized AUDIO chain, ending in label [a{i}]. */
function buildClipAudio(i, clip, settings, allocSilentIndex) {
  const SR = settings.sampleRate;
  const d = clipDuration(clip);
  const ts = Number(clip.trimStart) || 0;
  const te = ts + d;
  const speed = clipSpeed(clip);
  const stmts = [];

  if (clip.hasAudio && clip.kind !== 'image' && !clip.muted) {
    let cur = `[${i}:a]atrim=start=${num(ts)}:end=${num(te)},asetpts=PTS-STARTPTS`;
    if (clip.reverse) cur += `,areverse`;
    for (const f of atempoFactors(speed)) cur += `,atempo=${num(f)}`;
    const volume = clip.volume == null ? 1 : Math.max(0, Math.min(2, Number(clip.volume)));
    const effectiveDuration = clipDuration(clip) / speed;
    const fadeIn = Math.min(effectiveDuration, Math.max(0, Number(clip.fadeIn) || 0));
    const fadeOut = Math.min(effectiveDuration, Math.max(0, Number(clip.fadeOut) || 0));
    if (volume !== 1) cur += `,volume=${num(volume)}`;
    if (fadeIn > 0) cur += `,afade=t=in:st=0:d=${num(fadeIn)}`;
    if (fadeOut > 0) cur += `,afade=t=out:st=${num(Math.max(0, effectiveDuration - fadeOut))}:d=${num(fadeOut)}`;
    cur += `,aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo[a${i}]`;
    stmts.push(cur);
    return { stmts, silent: null };
  }
  // No audio track: synthesize silence of the effective (post-speed) length.
  const silentIdx = allocSilentIndex();
  const effDur = effectiveClipDuration(clip);
  stmts.push(
    `[${silentIdx}:a]atrim=duration=${num(effDur)},asetpts=PTS-STARTPTS,` +
      `aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo[a${i}]`
  );
  return { stmts, silent: { forClip: i, duration: effDur } };
}

/**
 * Build a single media-overlay chain producing [ov{k}], then compose it over
 * [baseLabel] producing [outLabel]. Returns the composing statement(s).
 */
/** Build a compact FFmpeg expression for a keyframed property.
 *
 * `curve` belongs to the frame at the left of a segment, matching the editor
 * model. `timeShift` lets scale/alpha run on the overlay input's local clock
 * while the final overlay compositor runs on the global output clock.
 */
function keyframeExpression(frames, prop, timeShift = 0) {
  const value = (frame) => num(frame[prop]);
  const time = (frame) => num(frame.time - timeShift);
  if (frames.length <= 1) return value(frames[0]);

  let expr = value(frames[frames.length - 1]);
  for (let i = frames.length - 2; i >= 0; i--) {
    const from = frames[i];
    const to = frames[i + 1];
    const fromTime = time(from);
    const toTime = time(to);
    const span = Math.max(0.000001, to.time - from.time);
    const p = `(t-${fromTime})/${num(span)}`;
    let eased = p;
    if (from.curve === 'easeIn') eased = `(${p})*(${p})`;
    else if (from.curve === 'easeOut') eased = `(${p})*(2-(${p}))`;
    else if (from.curve === 'easeInOut') eased = `(${p})*(${p})*(3-2*(${p}))`;
    else if (from.curve === 'bezier') {
      const b = from.bezier || { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
      eased = `3*(1-(${p}))*(1-(${p}))*(${p})*${num(b.y1)}+3*(1-(${p}))*(${p})*(${p})*${num(b.y2)}+(${p})*(${p})*(${p})`;
    }
    const segment = `${value(from)}+(${num(to[prop] - from[prop])})*(${eased})`;
    // Before the left keyframe, hold its value. Between this and the next
    // keyframe, interpolate. The expression already built handles later time.
    expr = `if(lt(t,${fromTime}),${value(from)},if(lt(t,${toTime}),${segment},${expr}))`;
  }
  return expr;
}

function keyframePropertyChanges(frames, prop) {
  return frames.some((frame) => Math.abs(frame[prop] - frames[0][prop]) > 1e-9);
}

function normaliseMuteRanges(value, duration) {
  const max = Math.max(0, Number(duration) || 0);
  const list = (Array.isArray(value) ? value : []).map((range) => {
    const start = Math.max(0, Math.min(max, Number(range && range.start) || 0));
    const end = Math.max(start, Math.min(max, Number(range && range.end) || 0));
    return { start, end };
  }).filter((range) => range.end > range.start);
  list.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of list) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 0.001) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

function muteVolumeExpression(ranges) {
  const list = normaliseMuteRanges(ranges, Infinity);
  if (!list.length) return '';
  const conditions = list.map((range) => `between(t,${num(range.start)},${num(range.end)})`).join('+');
  return `if(gt(${conditions},0),0,1)`;
}

function buildOverlay(k, ov, inputIndex, settings, baseLabel, outLabel) {
  const W = settings.width, H = settings.height;
  const start = Math.max(0, Number(ov.start) || 0);
  const end = Number(ov.end) > start ? Number(ov.end) : start + 3;
  const scale = Math.max(0.02, Math.min(1, Number(ov.scale) || 0.4));
  const w = Math.round(W * scale);
  const opacity = ov.opacity == null ? 1 : Math.max(0, Math.min(1, Number(ov.opacity)));
  const fade = Math.max(0, Number(ov.fadeDuration) || 0);
  const dur = Math.max(0.0001, end - start);
  const sourceStart = Math.max(0, Number(ov.trimStart) || 0);
  const frames = Array.isArray(ov.keyframes) && ov.keyframes.length
    ? keyframes.normaliseKeyframes(ov)
    : [];
  const animated = frames.length > 0;
  const values = animated ? keyframes.evaluateKeyframes(frames, start, ov) : null;
  const scaleChanges = animated && keyframePropertyChanges(frames, 'scale');
  const opacityChanges = animated && keyframePropertyChanges(frames, 'opacity');
  const rotationChanges = animated && keyframePropertyChanges(frames, 'rotation');
  const xChanges = animated && keyframePropertyChanges(frames, 'x');
  const yChanges = animated && keyframePropertyChanges(frames, 'y');

  const stmts = [];
  let cur = `[${inputIndex}:v]trim=start=${num(sourceStart)}:duration=${num(dur)},setpts=PTS-STARTPTS`;
  const crop = ov.crop || {};
  const left = Math.max(0, Math.min(0.45, Number(crop.left) || 0));
  const right = Math.max(0, Math.min(0.45, Number(crop.right) || 0));
  const top = Math.max(0, Math.min(0.45, Number(crop.top) || 0));
  const bottom = Math.max(0, Math.min(0.45, Number(crop.bottom) || 0));
  if (left || right || top || bottom) {
    cur += `,crop=w='iw*(1-${num(left + right)})':h='ih*(1-${num(top + bottom)})':x='iw*${num(left)}':y='ih*${num(top)}'`;
  }
  if (ov.mirrorX) cur += ',hflip';
  if (ov.mirrorY) cur += ',vflip';
  if (scaleChanges) {
    // The input clock is 0 at the overlay start, so shift global key times.
    const scaleExpr = keyframeExpression(frames, 'scale', start);
    cur += `,scale=w='${W}*(${scaleExpr})':h=-1:eval=frame`;
  } else if (ov.fit === 'cover' && !animated) {
    const coverScale = Math.max(0.02, Math.min(2, Number(ov.scale) || 1));
    const coverW = Math.max(2, Math.round(W * coverScale));
    const coverH = Math.max(2, Math.round(H * coverScale));
    cur += `,scale=${coverW}:${coverH}:force_original_aspect_ratio=increase,crop=${coverW}:${coverH}`;
  } else {
    const fixedScale = animated ? values.scale : scale;
    cur += `,scale=${Math.round(W * fixedScale)}:-1`;
  }
  const fixedRotation = animated ? values.rotation : (Number(ov.rotation) || 0);
  if (rotationChanges) {
    const rotationExpr = keyframeExpression(frames, 'rotation', start);
    cur += `,rotate='(${rotationExpr})*PI/180':ow=rotw(iw):oh=roth(ih):c=none`;
  } else if (fixedRotation !== 0) {
    cur += `,rotate=${num(fixedRotation)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`;
  }
  cur += ',format=yuva420p';
  if (ov.chromaKey && ov.chromaKey.enabled) {
    const key = String(ov.chromaKey.color || '#00ff00');
    const similarity = Math.max(0.01, Math.min(1, Number(ov.chromaKey.similarity) || 0.1));
    const blend = Math.max(0, Math.min(1, Number(ov.chromaKey.blend) || 0));
    cur += `,chromakey=${key}:${num(similarity)}:${num(blend)}`;
  }
  if (ov.mask === 'ellipse' || ov.mask === 'rounded') {
    const feather = Math.max(0, Math.min(0.25, Number(ov.maskFeather) || 0));
    const invert = !!ov.maskInvert;
    let shape;
    if (ov.mask === 'ellipse') {
      shape = `sqrt(((X-W/2)/(W/2))*((X-W/2)/(W/2))+((Y-H/2)/(H/2))*((Y-H/2)/(H/2)))`;
    } else {
      shape = `max(abs((X-W/2)/(W/2)),abs((Y-H/2)/(H/2)))`;
    }
    let alphaExpr;
    if (feather > 0) {
      const soft = `clip((1-(${shape}))/${num(feather)},0,1)`;
      alphaExpr = invert ? `alpha(X,Y)*(1-(${soft}))` : `alpha(X,Y)*(${soft})`;
    } else {
      alphaExpr = invert ? `if(gt(${shape},1),alpha(X,Y),0)` : `if(lte(${shape},1),alpha(X,Y),0)`;
    }
    cur += `,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${alphaExpr}'`;
  }
  if (opacityChanges) {
    // geq exposes the local frame timestamp as T and preserves source alpha,
    // unlike colorchannelmixer which only accepts a constant alpha value.
    const alphaExpr = keyframeExpression(frames, 'opacity', start).replace(/\bt\b/g, 'T');
    cur += `,format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(${alphaExpr})',format=yuva420p`;
  } else {
    const fixedOpacity = animated ? values.opacity : opacity;
    if (fixedOpacity < 1) cur += `,colorchannelmixer=aa=${num(fixedOpacity)}`;
  }
  if (fade > 0) {
    cur += `,fade=t=in:st=0:d=${num(fade)}:alpha=1`;
    cur += `,fade=t=out:st=${num(Math.max(0, dur - fade))}:d=${num(fade)}:alpha=1`;
  }
  // Position, with optional linear move.
  let xExpr = String(Math.round(Number(ov.x) || 0));
  let yExpr = String(Math.round(Number(ov.y) || 0));
  if (animated) {
    xExpr = xChanges ? keyframeExpression(frames, 'x') : num(values.x);
    yExpr = yChanges ? keyframeExpression(frames, 'y') : num(values.y);
  } else if (ov.move && (ov.move.toX != null || ov.move.toY != null)) {
    const x0 = Number(ov.x) || 0, y0 = Number(ov.y) || 0;
    const x1 = ov.move.toX == null ? x0 : Number(ov.move.toX);
    const y1 = ov.move.toY == null ? y0 : Number(ov.move.toY);
    const prog = `(t-${num(start)})/${num(dur)}`;
    xExpr = `${num(x0)}+(${num(x1 - x0)})*${prog}`;
    yExpr = `${num(y0)}+(${num(y1 - y0)})*${prog}`;
  }
  const useBlend = ov.blendMode && ov.blendMode !== 'normal' && !xChanges && !yChanges && !ov.move && !opacityChanges;
  cur += `,setpts=PTS-STARTPTS+${num(start)}/TB[ov${k}${useBlend ? 'raw' : ''}]`;
  stmts.push(cur);
  if (useBlend) {
    const px = Math.round(Number(xExpr) || 0);
    const py = Math.round(Number(yExpr) || 0);
    stmts.push(`[ov${k}raw]pad=${W}:${H}:${px}:${py}:color=black@0[ov${k}]`);
    const blend = ov.blendMode === 'addition' ? 'addition' : ov.blendMode;
    stmts.push(`${baseLabel}[ov${k}]blend=all_mode=${blend}:all_opacity=${num(opacity)}:enable='between(t,${num(start)},${num(end)})'[${outLabel}]`);
  } else {
    stmts.push(
      `${baseLabel}[ov${k}]overlay=x='${xExpr}':y='${yExpr}':` +
        `enable='between(t,${num(start)},${num(end)})':eof_action=pass:repeatlast=0[${outLabel}]`
    );
  }
  return stmts;
}

/**
 * Assemble the whole filter graph.
 * Returns { filter, silentInputs, bgmInputIndex, overlayInputs, total }.
 */
function buildFilterComplex(spec) {
  const settings = Object.assign({}, DEFAULTS, spec.settings || {});
  const clips = spec.clips || [];
  if (clips.length === 0) throw new Error('至少需要一个片段');

  const parts = [];
  const silentInputs = [];
  let nextExtraIndex = clips.length;
  const allocSilentIndex = () => nextExtraIndex++;

  // --- per-clip normalized streams ---
  clips.forEach((clip, i) => {
    for (const s of buildClipVideo(i, clip, settings)) parts.push(s);
    const { stmts, silent } = buildClipAudio(i, clip, settings, allocSilentIndex);
    for (const s of stmts) parts.push(s);
    if (silent) silentInputs.push(silent);
  });

  // --- chain clips with per-gap transitions (xfade/acrossfade or hard cut) ---
  let vLast, aLast, total;
  if (clips.length === 1) {
    parts.push(`[v0]null[vseq]`);
    parts.push(`[a0]anull[aseq]`);
    vLast = 'vseq';
    aLast = 'aseq';
    total = effectiveClipDuration(clips[0]);
  } else {
    let vAcc = 'v0', aAcc = 'a0';
    let accDur = effectiveClipDuration(clips[0]);
    for (let i = 1; i < clips.length; i++) {
      const gap = gapTransition(clips, i - 1, settings);
      const vOut = i === clips.length - 1 ? 'vseq' : `vc${i}`;
      const aOut = i === clips.length - 1 ? 'aseq' : `ac${i}`;
      if (gap.duration > 0) {
        const offset = accDur - gap.duration;
        parts.push(
          `[${vAcc}][v${i}]xfade=transition=${gap.style}:` +
            `duration=${num(gap.duration)}:offset=${num(offset)}[${vOut}]`
        );
        parts.push(
          `[${aAcc}][a${i}]acrossfade=d=${num(gap.duration)}:c1=tri:c2=tri[${aOut}]`
        );
        accDur = accDur + effectiveClipDuration(clips[i]) - gap.duration;
      } else {
        parts.push(`[${vAcc}][v${i}]concat=n=2:v=1:a=0[${vOut}]`);
        parts.push(`[${aAcc}][a${i}]concat=n=2:v=0:a=1[${aOut}]`);
        accDur = accDur + effectiveClipDuration(clips[i]);
      }
      vAcc = vOut;
      aAcc = aOut;
    }
    vLast = 'vseq';
    aLast = 'aseq';
    total = accDur;
  }

  // --- media overlays (PiP / stickers), composed in order ---
  // Input-index allocation MUST match the argv order in buildFFmpegArgs:
  //   clips (0..N-1) -> silent lavfi -> bgm -> audio tracks -> overlays.
  // Reserve audio inputs before allocating overlay indices so graph labels and
  // argv input ordering always agree.
  const bgm = spec.bgm || null;
  let bgmInputIndex = -1;
  if (bgm && bgm.path) bgmInputIndex = nextExtraIndex++;

  const audioTracks = Array.isArray(spec.audioTracks) ? spec.audioTracks : [];
  const audioTrackInputs = [];
  audioTracks.forEach((track, k) => {
    const start = Math.max(0, Number(track.start) || 0);
    const requestedEnd = Number(track.end);
    const end = requestedEnd > start ? requestedEnd : total;
    const inputIndex = nextExtraIndex++;
    audioTrackInputs.push({
      path: track.path,
      start,
      end: Math.max(start + 0.001, end),
      trimStart: Math.max(0, Number(track.trimStart) || 0),
      speed: Math.min(4, Math.max(0.25, Number(track.speed) || 1)),
      reverse: !!track.reverse,
      pitch: Math.max(-12, Math.min(12, Number(track.pitch) || 0)),
      denoise: !!track.denoise,
      voiceEnhance: !!track.voiceEnhance,
      loop: !!track.loop,
      volume: track.volume == null ? 1 : Math.max(0, Math.min(2, Number(track.volume))),
      fadeIn: Math.max(0, Number(track.fadeIn) || 0),
      fadeOut: Math.max(0, Number(track.fadeOut) || 0),
      muteRanges: normaliseMuteRanges(track.muteRanges, Math.max(0.001, end - start)),
      inputIndex,
      index: k,
    });
  });

  // B-roll is composed before normal overlay assets, so text/PiP/stickers stay
  // on top. Both share the same transform/animation compiler.
  const overlays = (Array.isArray(spec.brolls) ? spec.brolls : [])
    .concat(Array.isArray(spec.overlays) ? spec.overlays : []);
  const overlayInputs = [];
  overlays.forEach((ov, k) => {
    const inputIndex = nextExtraIndex++;
    overlayInputs.push({
      path: ov.path,
      kind: ov.kind === 'video' ? 'video' : 'image',
      loop: ov.loop !== false,
      trimStart: Math.max(0, Number(ov.trimStart) || 0),
      fit: ov.fit || '',
      start: Math.max(0, Number(ov.start) || 0),
      end: Number(ov.end) > 0 ? Number(ov.end) : total,
      duration: Math.max(0.001, (Number(ov.end) > 0 ? Number(ov.end) : total) - Math.max(0, Number(ov.start) || 0)),
    });
    const outLabel = `vov${k}`;
    for (const s of buildOverlay(k, ov, inputIndex, settings, `[${vLast}]`, outLabel)) {
      parts.push(s);
    }
    vLast = outLabel;
  });

  // --- burned subtitles/titles (libass) ---
  if (settings.assPath) {
    let sub = `subtitles=filename='${escapeFilterPath(settings.assPath)}'`;
    if (settings.fontsDir) sub += `:fontsdir='${escapeFilterPath(settings.fontsDir)}'`;
    sub += `:original_size=${settings.width}x${settings.height}`;
    parts.push(`[${vLast}]${sub}[vsub]`);
    vLast = 'vsub';
  }

  // Final video passthrough label.
  parts.push(`[${vLast}]null[vout]`);

  // --- audio: original level, looping BGM and independently placed tracks ---
  // The original sequence is the sidechain input for BGM ducking. This keeps
  // music out of the way of speech without altering the original soundtrack.
  parts.push('[' + aLast + ']volume=' + num(settings.originalVolume) + '[amain]');
  let mainMixLabel = 'amain';
  const mixInputs = [];
  if (bgmInputIndex >= 0) {
    const bgmTrimStart = Math.max(0, Number(bgm.trimStart) || 0);
    const bgmFadeIn = Math.min(total, Math.max(0, Number(bgm.fadeIn) || 0));
    const bgmFadeOut = Math.min(total, Math.max(0, Number(bgm.fadeOut) || 0));
    let bgmChain =
      `[${bgmInputIndex}:a]atrim=start=${num(bgmTrimStart)}:duration=${num(total)},asetpts=PTS-STARTPTS,` +
      `aformat=sample_fmts=fltp:sample_rates=${settings.sampleRate}:channel_layouts=stereo,` +
      `volume=${num(settings.bgmVolume)}`;
    if (bgmFadeIn > 0) bgmChain += `,afade=t=in:st=0:d=${num(bgmFadeIn)}`;
    if (bgmFadeOut > 0) bgmChain += `,afade=t=out:st=${num(Math.max(0, total - bgmFadeOut))}:d=${num(bgmFadeOut)}`;
    parts.push(
      bgmChain + '[bgmraw]'
    );
    if (settings.bgmDuck) {
      const amount = Math.max(0.1, Math.min(0.8, Number(settings.bgmDuckAmount) || 0.35));
      const ratio = 1 + amount * 19;
      parts.push('[amain]asplit=2[amainmix][aduckside]');
      parts.push('[bgmraw][aduckside]sidechaincompress=threshold=0.04:ratio=' + num(ratio) + ':attack=20:release=450:makeup=1[bgm]');
      mainMixLabel = 'amainmix';
      mixInputs.push(mainMixLabel, 'bgm');
    } else {
      mixInputs.push(mainMixLabel, 'bgmraw');
    }
  } else {
    mixInputs.push(mainMixLabel);
  }
  audioTrackInputs.forEach((track) => {
    const duration = Math.max(0.001, track.end - track.start);
    const fadeIn = Math.min(duration, track.fadeIn);
    const fadeOut = Math.min(duration, track.fadeOut);
    let chain =
      '[' + track.inputIndex + ':a]atrim=start=' + num(track.trimStart) + ':duration=' + num(duration * track.speed) + ',' +
      'asetpts=PTS-STARTPTS';
    if (track.reverse) chain += ',areverse';
    for (const factor of atempoFactors(track.speed)) chain += ',atempo=' + num(factor);
    if (track.pitch !== 0) {
      const pitchRatio = Math.pow(2, track.pitch / 12);
      chain += ',rubberband=pitch=' + num(pitchRatio);
    }
    if (track.denoise) chain += ',afftdn=nr=12:nf=-35';
    if (track.voiceEnhance) chain += ',dynaudnorm=f=150:g=7:p=0.9';
    chain += ',' +
      'aformat=sample_fmts=fltp:sample_rates=' + settings.sampleRate + ':channel_layouts=stereo,' +
      'volume=' + num(track.volume);
    const muteExpr = muteVolumeExpression(track.muteRanges);
    if (muteExpr) chain += ",volume='" + muteExpr + "':eval=frame";
    if (fadeIn > 0) chain += ',afade=t=in:st=0:d=' + num(fadeIn);
    if (fadeOut > 0) chain += ',afade=t=out:st=' + num(Math.max(0, duration - fadeOut)) + ':d=' + num(fadeOut);
    chain += ',adelay=' + Math.round(track.start * 1000) + ':all=1[atrack' + track.index + ']';
    parts.push(chain);
    mixInputs.push('atrack' + track.index);
  });
  let audioMixedLabel;
  if (mixInputs.length === 1) {
    audioMixedLabel = 'amixed';
    parts.push('[' + mixInputs[0] + ']anull[' + audioMixedLabel + ']');
  } else {
    audioMixedLabel = 'amixed';
    parts.push('[' + mixInputs.join('][') + ']amix=inputs=' + mixInputs.length + ':duration=first:dropout_transition=0:normalize=0[' + audioMixedLabel + ']');
  }
  if (settings.loudnessNormalize) {
    parts.push('[' + audioMixedLabel + ']loudnorm=I=-14:LRA=11:TP=-1.5[aout]');
  } else {
    parts.push('[' + audioMixedLabel + ']anull[aout]');
  }

  return {
    filter: parts.join(';'),
    silentInputs,
    bgmInputIndex,
    audioTrackInputs,
    overlayInputs,
    total,
  };
}

/**
 * Build the full ffmpeg argv.
 *
 * @param {object} spec
 * @param {Array}  spec.clips     [{ path, kind?, trimStart, trimEnd, hasAudio, speed?, reverse?, volume?, fadeIn?, fadeOut?, opacity?, crop?, mirrorX?, mirrorY?, rotation?, transformScale?, transformX?, transformY?, transformKeyframes?, stabilize?, color?, motion?, vignette?, grain?, animationIn?, animationOut?, fillMode?, transitionToNext? }]
 * @param {object} [spec.bgm]     { path, trimStart?, fadeIn?, fadeOut? } | null
 * @param {Array}  [spec.audioTracks] [{ path, start, end, trimStart?, volume?, fadeIn?, fadeOut?, muteRanges?, loop? }]
 * @param {Array}  [spec.brolls] [{ path, start, end, trimStart?, loop?, fit?, x, y, scale, opacity, fadeDuration? }]
 * @param {Array}  [spec.overlays] [{ path, kind, start, end, x, y, scale, opacity, fadeDuration, move, keyframes? }]
 * @param {string} spec.output    output .mp4 path
 * @param {object} [spec.settings]
 */
function buildFFmpegArgs(spec) {
  const settings = Object.assign({}, DEFAULTS, spec.settings || {});
  const clips = spec.clips || [];
  const bgm = spec.bgm || null;
  if (!spec.output) throw new Error('缺少输出路径');

  const graph = buildFilterComplex({
    clips,
    bgm,
    audioTracks: spec.audioTracks,
    brolls: spec.brolls,
    overlays: spec.overlays,
    settings,
  });

  const args = ['-y'];

  // 1) clip files, in timeline order (indices 0..N-1)
  for (const clip of clips) {
    if (clip.kind === 'image') {
      args.push('-loop', '1', '-framerate', String(settings.fps), '-t', num(clipDuration(clip)), '-i', clip.path);
    } else {
      args.push('-i', clip.path);
    }
  }

  // 2) one silent lavfi source per clip that lacks an audio track
  for (const s of graph.silentInputs) {
    args.push(
      '-f', 'lavfi',
      '-t', num(s.duration),
      '-i', `anullsrc=channel_layout=stereo:sample_rate=${settings.sampleRate}`
    );
  }

  // 3) background music, looped at the demux level (trimmed in-graph)
  if (bgm && bgm.path) {
    args.push('-stream_loop', '-1', '-i', bgm.path);
  }

  // 4) independently placed audio tracks (only looped tracks use demux loop)
  for (const track of graph.audioTrackInputs) {
    if (track.loop) args.push('-stream_loop', '-1');
    args.push('-i', track.path);
  }

  // 5) overlay inputs (images looped for their visible span; videos as-is)
  for (const ov of graph.overlayInputs) {
    if (ov.kind === 'image') {
      args.push('-loop', '1', '-t', num(ov.duration), '-i', ov.path);
    } else if (ov.loop) {
      // Match preview semantics: a short PiP video loops until its configured
      // overlay interval ends. The graph trims the loop to exactly that span.
      args.push('-stream_loop', '-1', '-i', ov.path);
    } else {
      args.push('-i', ov.path);
    }
  }

  args.push(
    '-filter_complex', graph.filter,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', String(settings.crf),
    '-preset', settings.preset,
    '-c:a', 'aac',
    '-b:a', settings.audioBitrate,
    '-movflags', '+faststart',
    '-t', num(graph.total),
    spec.output
  );

  return { args, filter: graph.filter, total: graph.total };
}

module.exports = {
  num,
  clipDuration,
  clipSpeed,
  effectiveClipDuration,
  atempoFactors,
  clampTransition,
  totalDuration,
  gapTransition,
  escapeFilterPath,
  ffmpegColor,
  clipAnimation,
  applyClipAnimations,
  keyframeExpression,
  keyframePropertyChanges,
  normaliseMuteRanges,
  muteVolumeExpression,
  buildFilterComplex,
  buildFFmpegArgs,
  XFADE_STYLES,
  CLIP_ANIMATION_STYLES,
  DEFAULTS,
};
