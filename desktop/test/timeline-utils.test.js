'use strict';

const assert = require('assert');
const t = require('../src/timeline-utils');
let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('timeline-utils:');

ok('maps local trimmed subtitles through 2x speed', () => {
  const clip = { trimStart: 10, trimEnd: 20, speed: 2, reverse: false };
  const out = t.mapSourceSubtitlesToClip([{ text: 'x', start: 2, end: 4 }], clip, 5);
  assert.deepStrictEqual({ start: out[0].start, end: out[0].end }, { start: 6, end: 7 });
});

ok('returns final timeline timestamps only once for a later clip', () => {
  const clip = { trimStart: 0, trimEnd: 8, speed: 2, reverse: false };
  const out = t.mapSourceSubtitlesToClip([{ text: 'x', start: 2, end: 4 }], clip, 9);
  assert.deepStrictEqual({ start: out[0].start, end: out[0].end }, { start: 10, end: 11 });
});

ok('maps and reorders subtitles for reverse clips', () => {
  const clip = { trimStart: 10, trimEnd: 20, speed: 1, reverse: true };
  const out = t.mapSourceSubtitlesToClip([
    { text: 'early', start: 1, end: 2 },
    { text: 'late', start: 7, end: 9 },
  ], clip, 3);
  assert.strictEqual(out[0].text, 'late');
  assert.deepStrictEqual({ start: out[0].start, end: out[0].end }, { start: 4, end: 6 });
  assert.deepStrictEqual({ start: out[1].start, end: out[1].end }, { start: 11, end: 12 });
});

ok('clips subtitle ranges to retained duration', () => {
  const clip = { trimStart: 0, trimEnd: 3, speed: 1 };
  const out = t.mapSourceSubtitlesToClip([
    { text: 'kept', start: 2, end: 5 },
    { text: 'dropped', start: 4, end: 5 },
  ], clip, 0);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].end, 3);
});

ok('preview time scales monotonically to export duration', () => {
  assert.strictEqual(t.previewToExportTime(0, 8, 7), 0);
  assert.strictEqual(t.previewToExportTime(4, 8, 7), 3.5);
  assert.strictEqual(t.previewToExportTime(8, 8, 7), 7);
});

ok('maps export time back onto the sequential preview clock', () => {
  assert.strictEqual(t.exportToPreviewTime(0, 8, 7), 0);
  assert.strictEqual(t.exportToPreviewTime(3.5, 8, 7), 4);
  assert.strictEqual(t.exportToPreviewTime(7, 8, 7), 8);
});

ok('lays clips on output seconds with transition overlaps', () => {
  const clips = [
    { trimStart: 0, trimEnd: 4, speed: 1 },
    { trimStart: 0, trimEnd: 6, speed: 2 },
    { trimStart: 0, trimEnd: 2, speed: 1 },
  ];
  const layout = t.layoutClips(clips, [1, 0, 0]);
  assert.deepStrictEqual(layout.items.map((item) => [item.start, item.duration, item.end]), [
    [0, 4, 4], [3, 3, 6], [6, 2, 8],
  ]);
  assert.strictEqual(layout.total, 8);
});

ok('locates a time on the sequential browser preview timeline', () => {
  const clips = [{ trimStart: 0, trimEnd: 2 }, { trimStart: 0, trimEnd: 3 }];
  const where = t.locateSequentialTime(clips, 2.5);
  assert.strictEqual(where.index, 1);
  assert.strictEqual(where.local, 0.5);
});

ok('chooses ruler steps based on visible pixel density', () => {
  assert.strictEqual(t.rulerStep(80), 1);
  assert.strictEqual(t.rulerStep(20), 5);
  const ticks = t.rulerTicks(5.2, 80);
  assert.strictEqual(ticks.step, 1);
  assert.strictEqual(ticks.ticks[ticks.ticks.length - 1], 5.2);
});

ok('moves and resizes timed timeline items with duration guards', () => {
  const item = { start: 1, end: 3 };
  assert.deepStrictEqual(t.moveTimedRange(item, -5, 10), { start: 0, end: 2 });
  assert.deepStrictEqual(t.moveTimedRange(item, 9, 10), { start: 8, end: 10 });
  assert.deepStrictEqual(t.resizeTimedRange(item, 'start', 5, 0.1), { start: 2.9, end: 3 });
  assert.deepStrictEqual(t.resizeTimedRange(item, 'end', -5, 0.1), { start: 1, end: 1.1 });
});

ok('packs overlapping timed items onto the minimum number of rows', () => {
  const packed = t.packTimedItems([
    { id: 'a', start: 0, end: 2 },
    { id: 'b', start: 1, end: 3 },
    { id: 'c', start: 2, end: 4 },
    { id: 'd', start: 4, end: 5 },
  ]);
  assert.strictEqual(packed.rows, 2);
  assert.deepStrictEqual(packed.items.map((entry) => [entry.item.id, entry.row]), [['a', 0], ['b', 1], ['c', 0], ['d', 0]]);
});

ok('snaps timeline times only when a guide is inside threshold', () => {
  assert.strictEqual(t.snapTime(1.04, [0, 1, 2], 0.05), 1);
  assert.strictEqual(t.snapTime(1.08, [0, 1, 2], 0.05), 1.08);
  assert.strictEqual(t.snapTime(0.02, [0, 1], 0.05), 0);
});

ok('splits generic timed item at a valid output timeline point', () => {
  const item = { id: 1, start: 1, end: 5, name: 'voice' };
  const result = t.splitTimedItem(item, 3, 2);
  assert.deepStrictEqual(result.left, { id: 1, start: 1, end: 3, name: 'voice' });
  assert.deepStrictEqual(result.right, { id: 2, start: 3, end: 5, name: 'voice' });
  assert.strictEqual(t.splitTimedItem(item, 1.02, 2), null);
});

ok('maps source silences into forward and reverse clip-local output ranges', () => {
  const forward = t.silenceToClipLocalRanges({ trimStart: 10, trimEnd: 20, speed: 2 }, [{ start: 12, end: 16 }], 0.2);
  assert.deepStrictEqual(forward, [{ start: 1, end: 3 }]);
  const reverse = t.silenceToClipLocalRanges({ trimStart: 10, trimEnd: 20, speed: 2, reverse: true }, [{ start: 12, end: 16 }], 0.2);
  assert.deepStrictEqual(reverse, [{ start: 2, end: 4 }]);
});

ok('ripples timestamps across removed intervals', () => {
  const removed = [{ start: 2, end: 3 }, { start: 5, end: 6 }];
  assert.strictEqual(t.rippleTime(1, removed), 1);
  assert.strictEqual(t.rippleTime(2.5, removed), 2);
  assert.strictEqual(t.rippleTime(4, removed), 3);
  assert.strictEqual(t.rippleTime(7, removed), 5);
});

ok('splits a clip and moves its outgoing transition to the right half', () => {
  const clip = {
    id: 3, trimStart: 1, trimEnd: 9, speed: 2,
    animationIn: { style: 'slideLeft', duration: 0.4 },
    animationOut: { style: 'fade', duration: 0.6 },
    transitionToNext: { style: 'fade', duration: 0.5 },
  };
  const result = t.splitClipAtSourceTime(clip, 4, 4);
  assert.ok(result);
  assert.strictEqual(result.left.trimStart, 1);
  assert.strictEqual(result.left.trimEnd, 4);
  assert.strictEqual(result.left.transitionToNext.style, 'none');
  assert.deepStrictEqual(result.left.animationIn, { style: 'slideLeft', duration: 0.4 });
  assert.deepStrictEqual(result.left.animationOut, { style: 'none', duration: 0 });
  assert.strictEqual(result.right.id, 4);
  assert.strictEqual(result.right.trimStart, 4);
  assert.strictEqual(result.right.trimEnd, 9);
  assert.deepStrictEqual(result.right.animationIn, { style: 'none', duration: 0 });
  assert.deepStrictEqual(result.right.animationOut, { style: 'fade', duration: 0.6 });
  assert.deepStrictEqual(result.right.transitionToNext, { style: 'fade', duration: 0.5 });
});

ok('refuses a split at either trim edge', () => {
  const clip = { trimStart: 1, trimEnd: 3 };
  assert.strictEqual(t.splitClipAtSourceTime(clip, 1, 2), null);
  assert.strictEqual(t.splitClipAtSourceTime(clip, 3, 2), null);
});

ok('turns a clip into speed-curve pieces while retaining only outer animation and transition', () => {
  const clip = {
    id: 3, trimStart: 0, trimEnd: 9, speed: 1, reverse: false,
    animationIn: { style: 'fade', duration: 0.4 },
    animationOut: { style: 'slideRight', duration: 0.5 },
    transitionToNext: { style: 'fade', duration: 0.6 },
  };
  const pieces = t.splitClipBySpeedCurve(clip, [1, 2, 0.5], [4, 5]);
  assert.ok(pieces);
  assert.deepStrictEqual(pieces.map((piece) => [piece.trimStart, piece.trimEnd, piece.speed]), [[0, 3, 1], [3, 6, 2], [6, 9, 0.5]]);
  assert.strictEqual(pieces[0].animationIn.style, 'fade');
  assert.strictEqual(pieces[0].animationOut.style, 'none');
  assert.strictEqual(pieces[1].animationIn.style, 'none');
  assert.strictEqual(pieces[1].animationOut.style, 'none');
  assert.strictEqual(pieces[2].animationOut.style, 'slideRight');
  assert.strictEqual(pieces[2].transitionToNext.style, 'fade');

  const reversed = t.splitClipBySpeedCurve(Object.assign({}, clip, { reverse: true }), [1, 2, 0.5], [4, 5]);
  assert.deepStrictEqual(reversed.map((piece) => [piece.trimStart, piece.trimEnd, piece.speed]), [[6, 9, 1], [3, 6, 2], [0, 3, 0.5]]);
});

ok('maps timeline positions through speed-curve presets for normal and pre-sped clips', () => {
  assert.strictEqual(t.mapSpeedCurveTimelineTime(0, 0, 9, 1, [1, 2, 0.5]), 0);
  assert.strictEqual(t.mapSpeedCurveTimelineTime(3, 0, 9, 1, [1, 2, 0.5]), 3);
  assert.strictEqual(t.mapSpeedCurveTimelineTime(6, 0, 9, 1, [1, 2, 0.5]), 4.5);
  assert.strictEqual(t.mapSpeedCurveTimelineTime(9, 0, 9, 1, [1, 2, 0.5]), 10.5);
  assert.strictEqual(t.mapSpeedCurveTimelineTime(1.5, 0, 9, 2, [1, 2, 0.5]), 3);
});

ok('duplicates a clip after itself and transfers its outgoing transition', () => {
  const clip = { id: 1, path: 'a.mp4', trimStart: 0, trimEnd: 3, speed: 2, color: { contrast: 1.2 }, transitionToNext: { style: 'fade', duration: 0.5 } };
  const result = t.duplicateClipAfter(clip, 2);
  assert.ok(result);
  assert.strictEqual(result.original.id, 1);
  assert.deepStrictEqual(result.original.transitionToNext, { style: 'none', duration: 0 });
  assert.strictEqual(result.duplicate.id, 2);
  assert.deepStrictEqual(result.duplicate.transitionToNext, { style: 'fade', duration: 0.5 });
  assert.notStrictEqual(result.duplicate.color, clip.color);
});

console.log(`\n${passed} passed`);
