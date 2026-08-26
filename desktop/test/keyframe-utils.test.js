'use strict';

const assert = require('assert');
const k = require('../src/keyframe-utils');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('keyframe-utils:');

ok('normalises and sorts bounded keyframes', () => {
  const frames = k.normaliseKeyframes({
    start: 1, end: 3, x: 10, y: 20, scale: 0.4, opacity: 1,
    keyframes: [
      { time: 99, x: 30 },
      { time: -1, y: 40, scale: 4, opacity: -1, curve: 'bogus' },
    ],
  });
  assert.strictEqual(frames.length, 2);
  assert.deepStrictEqual(frames[0], { time: 1, x: 10, y: 40, scale: 1, opacity: 0, rotation: 0, curve: 'linear', bezier: null });
  assert.deepStrictEqual(frames[1], { time: 3, x: 30, y: 20, scale: 0.4, opacity: 1, rotation: 0, curve: 'linear', bezier: null });
});

ok('evaluates linear interpolation for every visual property', () => {
  const frames = [
    { time: 0, x: 0, y: 10, scale: 0.2, opacity: 0, rotation: 0, curve: 'linear' },
    { time: 2, x: 100, y: 50, scale: 0.6, opacity: 1, rotation: 90, curve: 'linear' },
  ];
  const v = k.evaluateKeyframes(frames, 1, {});
  assert.deepStrictEqual(v, { x: 50, y: 30, scale: 0.4, opacity: 0.5, rotation: 45 });
});

ok('easing curves have expected midpoint behaviour', () => {
  assert.strictEqual(k.easedProgress(0.5, 'linear'), 0.5);
  assert.ok(k.easedProgress(0.5, 'easeIn') < 0.5);
  assert.ok(k.easedProgress(0.5, 'easeOut') > 0.5);
  assert.strictEqual(k.easedProgress(0.5, 'easeInOut'), 0.5);
});

ok('custom cubic bezier evaluates with its own control points', () => {
  const p = k.cubicBezierProgress(0.5, { x1: 0.4, y1: 0, x2: 0.6, y2: 1 });
  assert.ok(p > 0.45 && p < 0.55);
  const frames = [
    { time: 0, x: 0, y: 0, scale: 0.4, opacity: 1, rotation: 0, curve: 'bezier', bezier: { x1: 0.4, y1: 0, x2: 0.6, y2: 1 } },
    { time: 1, x: 100, y: 0, scale: 0.4, opacity: 1, rotation: 0, curve: 'linear' },
  ];
  const value = k.evaluateKeyframes(frames, 0.5, {});
  assert.ok(value.x > 45 && value.x < 55);
});

ok('legacy move is readable as two linear keyframes', () => {
  const frames = k.normaliseKeyframes({
    start: 2, end: 5, x: 10, y: 20, scale: 0.5, opacity: 1,
    move: { toX: 70, toY: 80 },
  });
  assert.strictEqual(frames.length, 2);
  assert.deepStrictEqual(frames.map((f) => [f.time, f.x, f.y]), [[2, 10, 20], [5, 70, 80]]);
});

console.log(`\n${passed} passed`);
