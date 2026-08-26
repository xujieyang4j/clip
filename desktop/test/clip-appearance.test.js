'use strict';

const assert = require('assert');
const appearance = require('../src/clip-appearance');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('clip-appearance:');

ok('captures only visual and processing properties', () => {
  const source = {
    id: 1, path: '/a.mp4', trimStart: 2, trimEnd: 7, speed: 2, volume: 0.4, fadeIn: 1, transitionToNext: { style: 'fade', duration: 1 },
    fillMode: 'blur', crop: { left: 0.1, right: 0.2, top: 0.3, bottom: 0.4 }, mirrorX: true, rotation: 15, opacity: 0.6, transformScale: 1.2, transformX: 20, transformY: -10,
    color: { brightness: 0.1, contrast: 1.2, saturation: 1.3, temperature: -20, hue: 30, gamma: 1.1, curve: 'lift', lutPath: '/look.cube' },
    effect: 'vintage', vignette: 0.35, grain: 0.6, motion: 'zoomIn', stabilize: 'strong', animationIn: { style: 'slideLeft', duration: 0.4 }, animationOut: { style: 'fade', duration: 0.8 },
  };
  const copied = appearance.capture(source);
  assert.strictEqual(copied.fillMode, 'blur');
  assert.strictEqual(copied.crop.left, 0.1);
  assert.strictEqual(copied.opacity, 0.6);
  assert.strictEqual(copied.color.lutPath, '/look.cube');
  assert.strictEqual(copied.animationIn.style, 'slideLeft');
  assert.strictEqual(copied.vignette, 0.35);
  assert.strictEqual(copied.grain, 0.6);
  assert.ok(!Object.prototype.hasOwnProperty.call(copied, 'path'));
  assert.ok(!Object.prototype.hasOwnProperty.call(copied, 'speed'));
  assert.ok(!Object.prototype.hasOwnProperty.call(copied, 'transitionToNext'));
});

ok('applies a deep-normalized appearance without touching edit structure', () => {
  const source = appearance.capture({ fillMode: 'pad', crop: { left: 0.2 }, opacity: 0.5, color: { contrast: 1.5 }, vignette: 0.4, grain: 0.25, animationOut: { style: 'slideDown', duration: 0.7 } });
  const target = {
    id: 2, path: '/b.mp4', trimStart: 1, trimEnd: 9, speed: 0.5, volume: 0.8, fadeIn: 0.3, transitionToNext: { style: 'wipeleft', duration: 0.4 },
    crop: { left: 0 }, color: {},
  };
  appearance.apply(target, source);
  assert.strictEqual(target.path, '/b.mp4');
  assert.strictEqual(target.trimStart, 1);
  assert.strictEqual(target.trimEnd, 9);
  assert.strictEqual(target.speed, 0.5);
  assert.strictEqual(target.volume, 0.8);
  assert.deepStrictEqual(target.transitionToNext, { style: 'wipeleft', duration: 0.4 });
  assert.strictEqual(target.fillMode, 'pad');
  assert.strictEqual(target.crop.left, 0.2);
  assert.strictEqual(target.opacity, 0.5);
  assert.strictEqual(target.color.contrast, 1.5);
  assert.strictEqual(target.animationOut.style, 'slideDown');
  assert.strictEqual(target.vignette, 0.4);
  assert.strictEqual(target.grain, 0.25);
  source.crop.left = 0.4;
  assert.strictEqual(target.crop.left, 0.2);
});

console.log('\n' + passed + ' passed');
