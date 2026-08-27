'use strict';

/**
 * Pure timeline timing helpers shared by the browser renderer and Node tests.
 * UMD-style export keeps the renderer sandboxed (no require needed).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MiniClipTimeline = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const rawDuration = (clip) => Math.max(0, Number(clip.trimEnd) - Number(clip.trimStart));
  const speedOf = (clip) => Math.min(4, Math.max(0.25, Number(clip.speed) || 1));
  const effectiveDuration = (clip) => rawDuration(clip) / speedOf(clip);

  /** Map trimmed-source recognition times to the final timeline. */
  function mapSourceSubtitlesToClip(items, clip, timelineBase) {
    const out = [];
    const speed = speedOf(clip);
    const duration = rawDuration(clip);
    for (const item of items || []) {
      // Whisper was run against trimStart..trimEnd, so timestamps are local.
      const srcStart = Math.max(0, Number(item.start) || 0);
      const srcEnd = Math.min(duration, Number(item.end) || 0);
      if (!(srcEnd > srcStart)) continue;
      let localStart, localEnd;
      if (clip.reverse) {
        localStart = (duration - srcEnd) / speed;
        localEnd = (duration - srcStart) / speed;
      } else {
        localStart = srcStart / speed;
        localEnd = srcEnd / speed;
      }
      const words = (Array.isArray(item.words) ? item.words : []).map((word) => {
        const wordStart = Math.max(0, Math.min(duration, Number(word.start) || 0));
        const wordEnd = Math.max(wordStart, Math.min(duration, Number(word.end) || 0));
        if (!(wordEnd > wordStart)) return null;
        if (clip.reverse) {
          return Object.assign({}, word, {
            start: timelineBase + (duration - wordEnd) / speed,
            end: timelineBase + (duration - wordStart) / speed,
          });
        }
        return Object.assign({}, word, {
          start: timelineBase + wordStart / speed,
          end: timelineBase + wordEnd / speed,
        });
      }).filter(Boolean).sort((a, b) => a.start - b.start);
      out.push(Object.assign({}, item, {
        start: timelineBase + localStart,
        end: timelineBase + localEnd,
        words,
      }));
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Monotonic mapping from sequential preview time onto shorter export time. */
  function previewToExportTime(previewSeconds, previewTotal, exportTotal) {
    if (!(previewTotal > 0) || !(exportTotal >= 0)) return 0;
    return Math.max(0, Math.min(exportTotal, previewSeconds * exportTotal / previewTotal));
  }

  /** Inverse of previewToExportTime, used when the editor seeks by timeline time. */
  function exportToPreviewTime(exportSeconds, previewTotal, exportTotal) {
    if (!(exportTotal > 0) || !(previewTotal >= 0)) return 0;
    return Math.max(0, Math.min(previewTotal, exportSeconds * previewTotal / exportTotal));
  }

  /** Lay clips out on an output timeline. Each gap is the overlap after clip i. */
  function layoutClips(clips, gapDurations) {
    const out = [];
    let start = 0;
    const list = Array.isArray(clips) ? clips : [];
    const gaps = Array.isArray(gapDurations) ? gapDurations : [];
    list.forEach((clip, index) => {
      const duration = effectiveDuration(clip);
      out.push({ index, clip, start, end: start + duration, duration });
      start += duration - Math.max(0, Number(gaps[index]) || 0);
    });
    return { items: out, total: Math.max(0, start) };
  }

  /** Find the clip containing an output-timeline time; prefer a requested ID in overlaps. */
  function locateTimelineTime(layout, seconds, preferredId) {
    const t = Math.max(0, Number(seconds) || 0);
    const items = layout && Array.isArray(layout.items) ? layout.items : [];
    const matches = items.filter((item) => t >= item.start - 0.000001 && t <= item.end + 0.000001);
    if (!matches.length) return null;
    return matches.find((item) => item.clip && item.clip.id === preferredId) || matches[0];
  }

  /** List unique main-timeline cut points, including the start and final end. */
  function editPoints(layout) {
    const items = layout && Array.isArray(layout.items) ? layout.items : [];
    const values = [0, Number(layout && layout.total) || 0];
    items.forEach((item) => values.push(Number(item.start) || 0, Number(item.end) || 0));
    return values.filter(Number.isFinite).sort((a, b) => a - b).filter((value, index, list) =>
      index === 0 || Math.abs(value - list[index - 1]) > 0.000001
    );
  }

  /** Find the neighbouring cut point before or after a timeline time. */
  function adjacentEditPoint(layout, time, direction, epsilon = 0.001) {
    const at = Math.max(0, Number(time) || 0);
    const gap = Math.max(0, Number(epsilon) || 0);
    const points = editPoints(layout);
    if (Number(direction) < 0) {
      for (let index = points.length - 1; index >= 0; index--) {
        if (points[index] < at - gap) return points[index];
      }
      return null;
    }
    return points.find((point) => point > at + gap) ?? null;
  }

  /** Locate a time in the non-overlapping browser-preview sequence. */
  function locateSequentialTime(clips, seconds) {
    const list = Array.isArray(clips) ? clips : [];
    let cursor = 0;
    const t = Math.max(0, Number(seconds) || 0);
    for (let index = 0; index < list.length; index++) {
      const duration = effectiveDuration(list[index]);
      if (t <= cursor + duration || index === list.length - 1) {
        return { index, clip: list[index], local: Math.max(0, Math.min(duration, t - cursor)), start: cursor, duration };
      }
      cursor += duration;
    }
    return null;
  }

  /** Choose readable ruler increments, guaranteeing roughly minPixels between labels. */
  function rulerStep(pixelsPerSecond, minPixels = 64) {
    const pps = Math.max(1, Number(pixelsPerSecond) || 1);
    const choices = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return choices.find((seconds) => seconds * pps >= minPixels) || choices[choices.length - 1];
  }

  function rulerTicks(total, pixelsPerSecond, minPixels) {
    const end = Math.max(0, Number(total) || 0);
    const step = rulerStep(pixelsPerSecond, minPixels);
    const ticks = [];
    for (let t = 0; t <= end + step * 0.001; t += step) ticks.push(Math.min(end, Math.round(t * 1e6) / 1e6));
    if (!ticks.length || ticks[ticks.length - 1] !== end) ticks.push(end);
    return { step, ticks };
  }

  /** Format seconds as an editor-friendly H:MM:SS.s or M:SS.s timecode. */
  function formatTimecode(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor(value / 60) % 60;
    const remainder = (value % 60).toFixed(1).padStart(4, '0');
    return hours ? String(hours) + ':' + String(minutes).padStart(2, '0') + ':' + remainder : String(minutes) + ':' + remainder;
  }

  /** Parse seconds or colon-separated H:MM:SS.s input; returns null on invalid input. */
  function parseTimecode(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return null;
    const parts = text.split(':');
    if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
    let total = 0;
    for (const part of parts) total = total * 60 + Number(part);
    return Number.isFinite(total) ? total : null;
  }

  /** Clamp a generic timeline item to a usable duration and optional project end. */
  function timedRange(start, end, minDuration = 0.05, maxTime = Infinity) {
    const min = Math.max(0.001, Number(minDuration) || 0.05);
    const max = Number.isFinite(Number(maxTime)) ? Math.max(min, Number(maxTime)) : Infinity;
    let s = Math.max(0, Number(start) || 0);
    let e = Number(end);
    if (!(e > s)) e = s + min;
    if (e - s < min) e = s + min;
    if (e > max) { e = max; s = Math.max(0, e - min); }
    return { start: s, end: e };
  }

  /** Move a timed item while preserving its duration and staying in range. */
  function moveTimedRange(item, delta, maxTime = Infinity) {
    const current = timedRange(item && item.start, item && item.end, 0.05, maxTime);
    const duration = current.end - current.start;
    const maxStart = Number.isFinite(Number(maxTime)) ? Math.max(0, Number(maxTime) - duration) : Infinity;
    const start = Math.max(0, Math.min(maxStart, current.start + (Number(delta) || 0)));
    return { start, end: start + duration };
  }

  /** Resize a timed item at its leading or trailing edge. */
  function resizeTimedRange(item, edge, delta, minDuration = 0.05, maxTime = Infinity) {
    const current = timedRange(item && item.start, item && item.end, minDuration, maxTime);
    const d = Number(delta) || 0;
    if (edge === 'start') {
      return timedRange(Math.min(current.end - minDuration, current.start + d), current.end, minDuration, maxTime);
    }
    return timedRange(current.start, Math.max(current.start + minDuration, current.end + d), minDuration, maxTime);
  }

  /** Greedy row packing for overlapping text, overlays or audio clips. */
  function packTimedItems(items, gap = 0) {
    const rows = [];
    const packed = [];
    const list = (Array.isArray(items) ? items : []).slice().sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
    for (const item of list) {
      const range = timedRange(item && item.start, item && item.end);
      let row = rows.findIndex((lastEnd) => lastEnd <= range.start);
      if (row < 0) { row = rows.length; rows.push(-Infinity); }
      rows[row] = range.end + Math.max(0, Number(gap) || 0);
      packed.push({ item, row, start: range.start, end: range.end });
    }
    return { items: packed, rows: rows.length };
  }

  /** Return the nearest magnetic guide inside a threshold, otherwise unchanged. */
  function snapTime(value, guides, threshold = 0.12) {
    const original = Math.max(0, Number(value) || 0);
    const limit = Math.max(0, Number(threshold) || 0);
    let best = original;
    let distance = limit + Number.EPSILON;
    for (const guide of Array.isArray(guides) ? guides : []) {
      const candidate = Number(guide);
      const delta = Math.abs(candidate - original);
      if (Number.isFinite(candidate) && delta <= limit && delta < distance) {
        best = candidate; distance = delta;
      }
    }
    return best;
  }

  /** Return timeline markers ordered by time, without mutating editor state. */
  function sortedMarkers(markers) {
    return (Array.isArray(markers) ? markers : []).filter((marker) =>
      marker && Number.isFinite(Number(marker.time))
    ).slice().sort((a, b) => {
      const byTime = Number(a.time) - Number(b.time);
      return byTime || (Number(a.id) || 0) - (Number(b.id) || 0);
    });
  }

  /** Find the closest marker strictly before or after a timeline position. */
  function adjacentMarker(markers, time, direction, epsilon = 0.001) {
    const at = Math.max(0, Number(time) || 0);
    const gap = Math.max(0, Number(epsilon) || 0);
    const list = sortedMarkers(markers);
    if (Number(direction) < 0) {
      for (let index = list.length - 1; index >= 0; index--) {
        if (Number(list[index].time) < at - gap) return list[index];
      }
      return null;
    }
    return list.find((marker) => Number(marker.time) > at + gap) || null;
  }

  /**
   * Trim a clip from a visible timeline edge. The pointer delta is expressed
   * in final-output seconds, while trim points remain in source seconds.
   */
  function trimClipByOutputDelta(clip, edge, outputDelta, minSourceDuration = 0.1) {
    if (!clip || typeof clip !== 'object') return null;
    const sourceDuration = Math.max(0, Number(clip.sourceDuration) || 0);
    const oldStart = Math.max(0, Math.min(sourceDuration, Number(clip.trimStart) || 0));
    const oldEnd = Math.max(oldStart, Math.min(sourceDuration, Number(clip.trimEnd) || sourceDuration));
    const minimum = Math.max(0.001, Math.min(oldEnd - oldStart || 0.001, Number(minSourceDuration) || 0.1));
    const sourceDelta = (Number(outputDelta) || 0) * speedOf(clip);
    if (clip.reverse) {
      if (edge === 'start') {
        return { trimStart: oldStart, trimEnd: Math.min(sourceDuration, Math.max(oldStart + minimum, oldEnd - sourceDelta)) };
      }
      if (edge === 'end') {
        return { trimStart: Math.max(0, Math.min(oldEnd - minimum, oldStart - sourceDelta)), trimEnd: oldEnd };
      }
      return { trimStart: oldStart, trimEnd: oldEnd };
    }
    if (edge === 'start') {
      return { trimStart: Math.max(0, Math.min(oldEnd - minimum, oldStart + sourceDelta)), trimEnd: oldEnd };
    }
    if (edge === 'end') {
      return { trimStart: oldStart, trimEnd: Math.min(sourceDuration, Math.max(oldStart + minimum, oldEnd + sourceDelta)) };
    }
    return { trimStart: oldStart, trimEnd: oldEnd };
  }

  /** Convert a visible clip-local output offset back to a source timestamp. */
  function sourceTimeAtClipOutputOffset(clip, outputOffset) {
    const start = Math.max(0, Number(clip && clip.trimStart) || 0);
    const end = Math.max(start, Number(clip && clip.trimEnd) || start);
    const local = Math.max(0, Math.min(effectiveDuration(clip || {}), Number(outputOffset) || 0));
    const source = (clip && clip.reverse)
      ? end - local * speedOf(clip)
      : start + local * speedOf(clip);
    return Math.max(start, Math.min(end, source));
  }

  /** Split a regular timeline item at a final-output timeline timestamp. */
  function splitTimedItem(item, time, nextId, minDuration = 0.05) {
    if (!item || typeof item !== 'object') return null;
    const range = timedRange(item.start, item.end, minDuration);
    const at = Number(time);
    if (!(at > range.start + minDuration && at < range.end - minDuration)) return null;
    return {
      left: Object.assign({}, item, { end: at }),
      right: Object.assign({}, item, { id: nextId, start: at }),
    };
  }

  function mergeRanges(ranges) {
    const out = [];
    for (const range of (Array.isArray(ranges) ? ranges : []).slice().sort((a, b) => a.start - b.start)) {
      if (!(range.end > range.start)) continue;
      const last = out[out.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else out.push({ start: range.start, end: range.end });
    }
    return out;
  }

  /** Source silence intervals -> clip-local output intervals after speed/reverse. */
  function silenceToClipLocalRanges(clip, silences, minDuration = 0.25) {
    const trimStart = Number(clip && clip.trimStart) || 0;
    const trimEnd = Number(clip && clip.trimEnd) || trimStart;
    const speed = speedOf(clip || {});
    const out = [];
    for (const silence of silences || []) {
      const sourceStart = Math.max(trimStart, Number(silence && silence.start) || 0);
      const sourceEnd = Math.min(trimEnd, Number(silence && silence.end) || 0);
      if (!(sourceEnd - sourceStart >= minDuration)) continue;
      if (clip && clip.reverse) {
        out.push({ start: (trimEnd - sourceEnd) / speed, end: (trimEnd - sourceStart) / speed });
      } else {
        out.push({ start: (sourceStart - trimStart) / speed, end: (sourceEnd - trimStart) / speed });
      }
    }
    return mergeRanges(out);
  }

  /** Remove selected output-time intervals from a timestamp (ripple mapping). */
  function rippleTime(time, removed) {
    let t = Math.max(0, Number(time) || 0);
    let offset = 0;
    for (const range of mergeRanges(removed)) {
      if (t >= range.end) offset += range.end - range.start;
      else if (t > range.start) return range.start - offset;
      else break;
    }
    return t - offset;
  }

  /**
   * Pure split helper used by UI tests and future timeline controls. Transition
   * metadata follows the right side, preserving the original outgoing gap.
   */
  function splitClipAtSourceTime(clip, sourceTime, nextId) {
    if (!clip || typeof clip !== 'object') return null;
    const start = Number(clip.trimStart) || 0;
    const end = Number(clip.trimEnd) || 0;
    const at = Number(sourceTime);
    if (!(at > start + 0.05 && at < end - 0.05)) return null;
    // Entry animation belongs to the original first visible frame; exit
    // animation and the outgoing transition belong to its final visible frame.
    // Reversed media reaches high source timestamps first, so its two source
    // ranges need to be returned in opposite source order.
    const firstRange = clip.reverse ? { trimStart: at, trimEnd: end } : { trimStart: start, trimEnd: at };
    const secondRange = clip.reverse ? { trimStart: start, trimEnd: at } : { trimStart: at, trimEnd: end };
    const left = Object.assign({}, clip, firstRange, {
      animationOut: { style: 'none', duration: 0 },
      transitionToNext: { style: 'none', duration: 0 },
    });
    const right = Object.assign({}, clip, secondRange, {
      id: nextId,
      animationIn: { style: 'none', duration: 0 },
      transitionToNext: Object.assign({}, clip.transitionToNext || { style: 'none', duration: 0 }),
    });
    return { left, right };
  }

  /**
   * Convert one clip into consecutive source ranges with distinct speeds. This
   * powers the editor's non-destructive-in-history speed-curve presets: the
   * result is ordinary clips, so export, undo, transitions and audio stay on
   * the same proven code paths. For reversed media the source ranges are also
   * reversed, while the supplied speed order remains the visible play order.
   */
  function splitClipBySpeedCurve(clip, speeds, nextIds) {
    if (!clip || typeof clip !== 'object' || !Array.isArray(speeds) || speeds.length < 2) return null;
    const start = Number(clip.trimStart) || 0;
    const end = Number(clip.trimEnd) || 0;
    const duration = end - start;
    if (!(duration > 0.1)) return null;
    const values = speeds.map((speed) => Math.min(4, Math.max(0.25, Number(speed) || 1)));
    const ids = Array.isArray(nextIds) ? nextIds : [];
    if (ids.length < values.length - 1) return null;

    const sourcePieces = values.map((speed, index) => {
      const sourceStart = start + duration * index / values.length;
      const sourceEnd = start + duration * (index + 1) / values.length;
      // On a reversed clip, visible first is the final source range. Pair its
      // requested visible speed with that range before reversing the list.
      const sourceSpeed = clip.reverse ? values[values.length - 1 - index] : speed;
      return Object.assign({}, clip, {
        trimStart: sourceStart, trimEnd: sourceEnd, speed: sourceSpeed,
        crop: Object.assign({}, clip.crop || {}),
        color: Object.assign({}, clip.color || {}),
        animationIn: Object.assign({}, clip.animationIn || { style: 'none', duration: 0 }),
        animationOut: Object.assign({}, clip.animationOut || { style: 'none', duration: 0 }),
        transitionToNext: Object.assign({}, clip.transitionToNext || { style: 'none', duration: 0 }),
      });
    });
    const visible = clip.reverse ? sourcePieces.reverse() : sourcePieces;
    const originalIn = Object.assign({}, clip.animationIn || { style: 'none', duration: 0 });
    const originalOut = Object.assign({}, clip.animationOut || { style: 'none', duration: 0 });
    const originalTransition = Object.assign({}, clip.transitionToNext || { style: 'none', duration: 0 });

    visible.forEach((piece, index) => {
      piece.id = index === 0 ? clip.id : nextIds[index - 1];
      piece.animationIn = index === 0 ? Object.assign({}, originalIn) : { style: 'none', duration: 0 };
      piece.animationOut = index === visible.length - 1 ? Object.assign({}, originalOut) : { style: 'none', duration: 0 };
      piece.transitionToNext = index === visible.length - 1 ? Object.assign({}, originalTransition) : { style: 'none', duration: 0 };
    });
    return visible;
  }

  /** Clone one main clip for insertion immediately after itself. */
  function duplicateClipAfter(clip, nextId) {
    if (!clip || typeof clip !== 'object') return null;
    const duplicate = JSON.parse(JSON.stringify(clip));
    duplicate.id = nextId;
    duplicate.transitionToNext = Object.assign({}, clip.transitionToNext || { style: 'none', duration: 0 });
    const original = Object.assign({}, clip, { transitionToNext: { style: 'none', duration: 0 } });
    return { original, duplicate };
  }

  /** Map an output-timeline time through a speed-curve preset. */
  function mapSpeedCurveTimelineTime(time, originalStart, sourceDuration, originalSpeed, speeds) {
    const duration = Math.max(0.0001, Number(sourceDuration) || 0.0001);
    const speed = speedOf({ speed: originalSpeed });
    const values = (Array.isArray(speeds) ? speeds : []).map((value) => speedOf({ speed: value }));
    if (!values.length) return Math.max(0, Number(time) || 0);
    const localOld = Math.max(0, Math.min(duration / speed, Number(time) - originalStart));
    const sourceOffset = Math.min(duration, localOld * speed);
    const partDuration = duration / values.length;
    const part = Math.min(values.length - 1, Math.floor(sourceOffset / partDuration));
    let mapped = 0;
    for (let index = 0; index < part; index++) mapped += partDuration / values[index];
    mapped += (sourceOffset - part * partDuration) / values[part];
    return Math.max(0, Number(originalStart) || 0) + mapped;
  }

  return {
    rawDuration, speedOf, effectiveDuration, mapSourceSubtitlesToClip,
    previewToExportTime, exportToPreviewTime, layoutClips, locateTimelineTime, editPoints, adjacentEditPoint, locateSequentialTime,
    rulerStep, rulerTicks, formatTimecode, parseTimecode, timedRange, moveTimedRange, resizeTimedRange, packTimedItems, snapTime, sortedMarkers, adjacentMarker, trimClipByOutputDelta, sourceTimeAtClipOutputOffset, splitTimedItem,
    mergeRanges, silenceToClipLocalRanges, rippleTime, splitClipAtSourceTime, splitClipBySpeedCurve, duplicateClipAfter, mapSpeedCurveTimelineTime,
  };
});
