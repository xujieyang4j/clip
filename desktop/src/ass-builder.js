'use strict';

/**
 * Pure builder for an ASS (Advanced SubStation Alpha) subtitle file.
 *
 * Zero dependencies / no filesystem, so it's unit-testable. FFmpeg's `subtitles`
 * filter (libass) burns the result into the video. ASS is used instead of
 * drawtext because this bundled ffmpeg has libass but NOT drawtext, and ASS
 * gives us styling (font, size, colour, outline), positioning, fade in/out
 * (\fad) and simple linear movement (\move) for free.
 *
 * Colours are given as CSS "#RRGGBB"; ASS wants "&HAABBGGRR" (alpha then BGR,
 * alpha 00 = opaque).
 */

/** Two-digit uppercase hex. */
function hex2(n) {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return v.toString(16).toUpperCase().padStart(2, '0');
}

/** "#RRGGBB" (or "RRGGBB") -> ASS "&HAABBGGRR". alpha 0..1 (1=opaque). */
function assColor(css, alpha = 1) {
  const m = String(css || '#FFFFFF').replace('#', '');
  const r = parseInt(m.slice(0, 2) || 'FF', 16);
  const g = parseInt(m.slice(2, 4) || 'FF', 16);
  const b = parseInt(m.slice(4, 6) || 'FF', 16);
  const a = Math.round((1 - Math.max(0, Math.min(1, alpha))) * 255); // ASS: 00 opaque
  return `&H${hex2(a)}${hex2(b)}${hex2(g)}${hex2(r)}`;
}

/** seconds -> "H:MM:SS.cc" (centiseconds), the ASS time format. */
function assTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const csFixed = cs === 100 ? 99 : cs; // guard rounding to 100
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(csFixed).padStart(2, '0')}`;
}

/** Escape text for an ASS Dialogue line (newlines -> \N, strip braces). */
function escapeText(t) {
  return String(t == null ? '' : t)
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N');
}

function escapeKaraokeText(t, totalCentiseconds) {
  const chunks = String(t == null ? '' : t).replace(/[{}]/g, '').split(/\r?\n/);
  const chars = [];
  chunks.forEach((chunk, index) => {
    if (index) chars.push(null);
    chars.push(...Array.from(chunk));
  });
  const visible = chars.filter((ch) => ch != null).length || 1;
  let remaining = Math.max(1, Math.round(totalCentiseconds));
  let visibleLeft = visible;
  return chars.map((ch) => {
    if (ch == null) return '\\N';
    const duration = Math.max(1, Math.round(remaining / visibleLeft));
    remaining -= duration; visibleLeft--;
    return '{\\kf' + duration + '}' + ch;
  }).join('');
}

function escapeTimedHighlightText(t, words, startSeconds, endSeconds, baseColor, highlightColor) {
  const chars = Array.from(String(t == null ? '' : t));
  const list = Array.isArray(words) ? words.filter((word) => word && word.text && Number(word.end) > Number(word.start)) : [];
  if (!chars.length || !list.length) return null;
  const output = [];
  let cursor = 0;
  const base = assColor(baseColor);
  const hi = assColor(highlightColor);
  for (const word of list) {
    const tokenChars = Array.from(String(word.text));
    for (const tokenChar of tokenChars) {
      while (cursor < chars.length && /\s/.test(chars[cursor]) && !/\s/.test(tokenChar)) {
        output.push(chars[cursor] === '\n' ? '\\N' : chars[cursor]);
        cursor++;
      }
      if (cursor >= chars.length || chars[cursor] !== tokenChar) return null;
      const from = Math.max(0, Math.round((Number(word.start) - Number(startSeconds)) * 1000));
      const to = Math.max(from, Math.min(Math.round((Number(endSeconds) - Number(startSeconds)) * 1000), Math.round((Number(word.end) - Number(startSeconds)) * 1000)));
      output.push('{\\c' + base + '\\t(' + from + ',' + to + ',\\c' + hi + ')}' + tokenChar);
      cursor++;
    }
  }
  while (cursor < chars.length) {
    output.push(chars[cursor] === '\n' ? '\\N' : chars[cursor]);
    cursor++;
  }
  return output.join('');
}

/**
 * Alignment maps a friendly position to an ASS numpad alignment (1..9):
 *   7 8 9   (top)
 *   4 5 6   (middle)
 *   1 2 3   (bottom)
 */
const ALIGN = {
  'top-left': 7, top: 8, 'top-right': 9,
  left: 4, center: 5, right: 6,
  'bottom-left': 1, bottom: 2, 'bottom-right': 3,
};

const DEFAULTS = {
  width: 1280,
  height: 720,
  // Generic sans lets libass/fontconfig choose the bundled CJK font when one
  // is present, and a sensible system fallback otherwise.
  fontName: 'sans-serif',
  fontSize: 48,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  outline: 2,
  shadow: 0,
  marginV: 48,
  marginL: 40,
  marginR: 40,
};

/**
 * Build the full .ass document.
 *
 * @param {object} opts
 * @param {number} opts.width, opts.height   render size (match the video)
 * @param {Array}  opts.items  [{ text, start, end, position?, fontSize?, fontFamily?, bold?, italic?,
 *                                primaryColor?, outlineColor?, alpha?,
 *                                fade?, karaoke?, karaokeHighlightColor?,
 *                                move?:{fromX,fromY,toX,toY} }]
 * @param {string} [opts.fontName]
 * @returns {string} ass file contents
 */
function buildAss(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const items = Array.isArray(o.items) ? o.items : [];

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${o.fontName},${o.fontSize},${assColor(o.primaryColor)},&H000000FF,${assColor(o.outlineColor)},&H64000000,0,0,0,0,100,100,0,0,1,${o.outline},${o.shadow},2,${o.marginL},${o.marginR},${o.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = items.map((it) => {
    const start = assTime(it.start);
    const end = assTime(Number(it.end) > Number(it.start) ? it.end : Number(it.start) + 2);

    // Inline override tags: alignment, per-item font size/colour, fade, move.
    const tags = [];
    const align = ALIGN[it.position] || 2;
    tags.push(`\\an${align}`);
    if (it.xPercent != null || it.yPercent != null) {
      const x = Math.round(Math.max(0, Math.min(100, Number(it.xPercent == null ? 50 : it.xPercent))) / 100 * o.width);
      const y = Math.round(Math.max(0, Math.min(100, Number(it.yPercent == null ? 50 : it.yPercent))) / 100 * o.height);
      tags.push(`\\pos(${x},${y})`);
    }
    if (it.fontSize) tags.push(`\\fs${Math.round(it.fontSize)}`);
    if (it.fontFamily) tags.push('\\fn' + String(it.fontFamily).replace(/[^a-z0-9 -]/gi, ''));
    if (it.bold) tags.push('\\b1');
    if (it.italic) tags.push('\\i1');
    if (it.outline != null) tags.push('\\bord' + Math.max(0, Number(it.outline) || 0));
    if (it.shadow != null) tags.push('\\shad' + Math.max(0, Number(it.shadow) || 0));
    if (it.spacing != null) tags.push('\\fsp' + Number(it.spacing || 0));
    if (it.primaryColor) tags.push(`\\c${assColor(it.primaryColor)}`);
    if (it.outlineColor) tags.push(`\\3c${assColor(it.outlineColor)}`);
    if (it.alpha != null) tags.push(`\\alpha&H${assColor('#000000', it.alpha).slice(2, 4)}&`);
    if (it.fade && Number(it.fade) > 0) {
      const ms = Math.round(Number(it.fade) * 1000);
      tags.push(`\\fad(${ms},${ms})`);
    }
    if (it.move && (it.move.toX != null || it.move.toY != null)) {
      const fromX = Math.round(it.move.fromX != null ? it.move.fromX : it.move.toX);
      const fromY = Math.round(it.move.fromY != null ? it.move.fromY : it.move.toY);
      const toX = Math.round(it.move.toX != null ? it.move.toX : fromX);
      const toY = Math.round(it.move.toY != null ? it.move.toY : fromY);
      tags.push(`\\move(${fromX},${fromY},${toX},${toY})`);
    }
    if (it.karaoke) {
      tags.push(`\\c${assColor(it.karaokeHighlightColor || '#FFD54A')}`);
      tags.push(`\\2c${assColor(it.primaryColor || o.primaryColor)}`);
    }
    const prefix = tags.length ? `{${tags.join('')}}` : '';
    const rawDuration = Math.max(0.01, Number(it.end) - Number(it.start));
    const timed = it.karaoke && escapeTimedHighlightText(
      it.text, it.words, it.start, it.end, it.primaryColor || o.primaryColor, it.karaokeHighlightColor || '#FFD54A'
    );
    const body = it.karaoke ? (timed || escapeKaraokeText(it.text, rawDuration * 100)) : escapeText(it.text);
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${prefix}${body}`;
  });

  return header.concat(events).join('\n') + '\n';
}

module.exports = { buildAss, assColor, assTime, escapeText, escapeKaraokeText, escapeTimedHighlightText, ALIGN, DEFAULTS };
