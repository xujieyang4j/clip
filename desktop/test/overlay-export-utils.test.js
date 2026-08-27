'use strict';

const assert = require('assert');
const overlayExport = require('../src/overlay-export-utils');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('overlay-export-utils:');

ok('preserves every advanced overlay processing field for export', () => {
  const source = {
    path: '/media/logo.png', kind: 'image', start: 1, end: 4,
    x: 20, y: 30, scale: 0.35, rotation: 12, opacity: 0.7, fade: 0.4,
    move: { toX: 100, toY: 120 }, mirrorX: true, mirrorY: true,
    crop: { left: 0.1, right: 0.2, top: 0.05, bottom: 0.15 },
    mask: 'rounded', maskInvert: true, maskFeather: 0.12,
    chromaKey: { enabled: true, color: '#00aa11', similarity: 0.23, blend: 0.08 },
    blendMode: 'screen',
  };
  const result = overlayExport.toExportOverlay(source, {
    scaleX: 2, scaleY: 3,
    keyframes: [{ time: 1, x: 20, y: 30, scale: 0.35, opacity: 0.7, rotation: 12, curve: 'linear' }],
  });
  assert.strictEqual(result.x, 40);
  assert.strictEqual(result.y, 90);
  assert.deepStrictEqual(result.move, { toX: 200, toY: 360 });
  assert.deepStrictEqual(result.keyframes.map((frame) => [frame.x, frame.y]), [[40, 90]]);
  assert.strictEqual(result.mirrorX, true);
  assert.strictEqual(result.mirrorY, true);
  assert.deepStrictEqual(result.crop, source.crop);
  assert.strictEqual(result.mask, 'rounded');
  assert.strictEqual(result.maskInvert, true);
  assert.strictEqual(result.maskFeather, 0.12);
  assert.deepStrictEqual(result.chromaKey, source.chromaKey);
  assert.strictEqual(result.blendMode, 'screen');
});

ok('supplies safe defaults for old overlay records', () => {
  const result = overlayExport.toExportOverlay({ path: 'a.png', x: 2, y: 3 }, { scaleX: 1, scaleY: 1 });
  assert.deepStrictEqual(result.crop, { left: 0, right: 0, top: 0, bottom: 0 });
  assert.deepStrictEqual(result.chromaKey, { enabled: false, color: '#00ff00', similarity: 0.1, blend: 0 });
  assert.strictEqual(result.mask, 'none');
  assert.strictEqual(result.blendMode, 'normal');
  assert.strictEqual(result.keyframes, undefined);
});

console.log(String(passed) + ' passed');
