'use strict';

/** Unit tests for whisper-runner's pure helpers (no model / addon needed). */

const assert = require('assert');
const w = require('../src/whisper-runner');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  \u2713', name);
}

console.log('whisper-runner (pure helpers):');

ok('buildPcmExtractArgs asks for 16k mono f32le on stdout', () => {
  const a = w.buildPcmExtractArgs('/tmp/x.mp4');
  assert.ok(a.includes('-ar') && a[a.indexOf('-ar') + 1] === '16000');
  assert.ok(a.includes('-ac') && a[a.indexOf('-ac') + 1] === '1');
  assert.ok(a.includes('f32le'));
  assert.strictEqual(a[a.length - 1], 'pipe:1');
  assert.ok(a.includes('/tmp/x.mp4'));
});

ok('buildPcmExtractArgs optionally extracts only a trimmed range', () => {
  const a = w.buildPcmExtractArgs('/tmp/x.mp4', { start: 10, end: 14.5 });
  assert.strictEqual(a[a.indexOf('-ss') + 1], '10');
  assert.strictEqual(a[a.indexOf('-t') + 1], '4.5');
});

ok('buildPcmExtractArgs ignores an invalid range', () => {
  const a = w.buildPcmExtractArgs('/tmp/x.mp4', { start: 5, end: 3 });
  assert.strictEqual(a.includes('-t'), false);
});

ok('decodePcm reads f32le buffer into Float32Array', () => {
  const src = Float32Array.from([0, 0.5, -0.5, 1]);
  const buf = Buffer.from(src.buffer.slice(0));
  const out = w.decodePcm(buf);
  assert.strictEqual(out.length, 4);
  assert.ok(Math.abs(out[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(out[2] + 0.5) < 1e-6);
});

ok('decodePcm tolerates trailing bytes (non-multiple of 4)', () => {
  const src = Float32Array.from([1, 2]);
  const buf = Buffer.concat([Buffer.from(src.buffer.slice(0)), Buffer.from([0xaa, 0xbb])]);
  const out = w.decodePcm(buf);
  assert.strictEqual(out.length, 2);
});

ok('segmentsToOverlays converts ms->s and trims text', () => {
  const segs = [
    { from: 0, to: 1500, text: '  你好 ' },
    { from: 1500, to: 3000, text: 'world' },
  ];
  const ov = w.segmentsToOverlays(segs);
  assert.strictEqual(ov.length, 2);
  assert.deepStrictEqual(
    { text: ov[0].text, start: ov[0].start, end: ov[0].end, position: ov[0].position },
    { text: '你好', start: 0, end: 1.5, position: 'bottom' }
  );
  assert.strictEqual(ov[1].start, 1.5);
  assert.strictEqual(ov[1].end, 3);
});

ok('segmentsToOverlays applies timeline offset', () => {
  const ov = w.segmentsToOverlays([{ from: 0, to: 1000, text: 'x' }], { offset: 5 });
  assert.strictEqual(ov[0].start, 5);
  assert.strictEqual(ov[0].end, 6);
});

ok('tokenTimingsToWords preserves real token timestamp groups', () => {
  const words = w.tokenTimingsToWords([
    { text: ' hello', from: 100, to: 400 },
    { text: ' world', from: 450, to: 800 },
  ]);
  assert.deepStrictEqual(words, [
    { text: ' hello', start: 0.1, end: 0.4 },
    { text: ' world', start: 0.45, end: 0.8 },
  ]);
});

ok('offsetSegments stitches chunk timestamps in milliseconds', () => {
  const out = w.offsetSegments([{ from: 0, to: 1500, text: 'x' }], 60);
  assert.deepStrictEqual(out[0], { from: 60000, to: 61500, text: 'x' });
});

ok('segmentsToOverlays drops empty text and enforces min duration', () => {
  const ov = w.segmentsToOverlays([
    { from: 0, to: 0, text: 'a' },      // zero-length -> min dur
    { from: 100, to: 200, text: '   ' } // blank -> dropped
  ]);
  assert.strictEqual(ov.length, 1);
  assert.ok(ov[0].end - ov[0].start >= 0.4 - 1e-9);
});

ok('status reports engine/model availability without throwing', () => {
  const s = w.status();
  assert.ok(typeof s.engineInstalled === 'boolean');
  assert.ok(typeof s.modelsDir === 'string');
});

ok('findModel ignores a truncated model file', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclip-model-test-'));
  fs.writeFileSync(path.join(dir, 'ggml-tiny.bin'), Buffer.alloc(1024));
  assert.strictEqual(w.findModel('ggml-invalid.bin', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed`);
