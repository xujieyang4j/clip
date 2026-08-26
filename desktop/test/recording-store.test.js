'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const recordings = require('../src/recording-store');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('recording-store:');

ok('maps supported browser recording MIME types to safe extensions', () => {
  assert.strictEqual(recordings.extensionForMime('audio/webm;codecs=opus'), '.webm');
  assert.strictEqual(recordings.extensionForMime('audio/ogg'), '.ogg');
  assert.throws(() => recordings.extensionForMime('audio/mp4'));
});

ok('writes an opaque recording with a unique local asset name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclip-recording-'));
  try {
    const first = recordings.saveRecording(dir, new Uint8Array([1, 2, 3]), 'audio/webm', 123);
    const second = recordings.saveRecording(dir, Buffer.from([4]), 'audio/webm', 123);
    const third = recordings.saveRecording(dir, { type: 'Buffer', data: [5] }, 'audio/ogg', 123);
    assert.ok(first.endsWith('.webm'));
    assert.notStrictEqual(first, second);
    assert.deepStrictEqual([...fs.readFileSync(first)], [1, 2, 3]);
    assert.ok(third.endsWith('.ogg'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

ok('rejects empty and invalid recording payloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclip-recording-'));
  try {
    assert.throws(() => recordings.saveRecording(dir, new Uint8Array(), 'audio/webm'));
    assert.throws(() => recordings.saveRecording(dir, 'not bytes', 'audio/webm'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('\n' + passed + ' passed');
