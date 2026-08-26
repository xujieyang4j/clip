'use strict';

const assert = require('assert');
const transform = require('../src/clip-transform-utils');
let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('clip-transform-utils:');

ok('normalises local keyframes against effective clip duration', () => {
  const clip = { trimStart: 0, trimEnd: 8, speed: 2, transformScale: 1.2, opacity: 0.7, transformKeyframes: [{ time: -2, x: -999, scale: 3 }, { time: 99, y: 999, opacity: -1 }] };
  const frames = transform.normalise(clip);
  assert.deepStrictEqual(frames.map((frame) => [frame.time, frame.x, frame.y, frame.scale, frame.opacity]), [[0, -100, 0, 2, 0.7], [4, 0, 100, 1.2, 0]]);
});

ok('interpolates position scale and opacity with local time', () => {
  const clip = { trimStart: 0, trimEnd: 4, speed: 1, transformKeyframes: [
    { time: 0, x: 0, y: 0, scale: 1, opacity: 1, curve: 'linear' },
    { time: 2, x: 50, y: -20, scale: 1.5, opacity: 0.4, curve: 'linear' },
  ] };
  assert.deepStrictEqual(transform.valuesAt(clip, 1), { x: 25, y: -10, scale: 1.25, opacity: 0.7 });
});

console.log('\n' + passed + ' passed');
