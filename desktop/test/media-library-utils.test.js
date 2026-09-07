'use strict';

const assert = require('assert');
const mediaLibrary = require('../src/media-library-utils');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('media-library-utils:');

ok('normalizes asset keys and strips transient fields', () => {
  assert.strictEqual(mediaLibrary.assetKey('C:\\media\\clip.mp4'), 'c:/media/clip.mp4');
  assert.strictEqual(mediaLibrary.assetKey('c:\\MEDIA\\CLIP.mp4'), 'c:/media/clip.mp4');
  const cleaned = mediaLibrary.cleanAsset({
    id: '7',
    path: ' /tmp/a.mp4 ',
    url: 'file:///tmp/a.mp4',
    name: 'a.mp4',
    kind: 'video',
    duration: 12.5,
    hasAudio: 1,
    width: 1920,
    height: 1080,
  }, 3);
  assert.deepStrictEqual(cleaned, {
    id: 7,
    path: '/tmp/a.mp4',
    name: 'a.mp4',
    kind: 'video',
    duration: 12.5,
    hasAudio: true,
    width: 1920,
    height: 1080,
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cleaned, 'url'), false);
});

ok('deduplicates by path and reuses existing ids', () => {
  const merged = mediaLibrary.addOrReuseAssets([
    { id: 4, path: '/tmp/clip.mp4', name: 'clip.mp4', kind: 'video', duration: 5, hasAudio: true, width: 1280, height: 720 },
  ], [
    { id: 99, path: '/tmp/clip.mp4', name: 'dup.mp4', kind: 'video', duration: 8, hasAudio: false, width: 10, height: 10 },
    { path: '/tmp/logo.png', kind: 'image', width: 320, height: 180 },
  ], 10);
  assert.strictEqual(merged.added, 1);
  assert.strictEqual(merged.reused, 1);
  assert.strictEqual(merged.nextId, 11);
  assert.deepStrictEqual(merged.assets, [
    { id: 4, path: '/tmp/clip.mp4', name: 'clip.mp4', kind: 'video', duration: 5, hasAudio: true, width: 1280, height: 720 },
    { id: 10, path: '/tmp/logo.png', name: 'logo.png', kind: 'image', duration: 0, hasAudio: false, width: 320, height: 180 },
  ]);
});

ok('preserves audio assets and filters or sorts the visible library', () => {
  const assets = [
    mediaLibrary.cleanAsset({ id: 1, path: '/tmp/z.mp4', name: 'Zebra 10.mp4', kind: 'video', duration: 5 }, 1),
    mediaLibrary.cleanAsset({ id: 2, path: '/tmp/voice.wav', name: 'Voice.wav', kind: 'audio', duration: 12, hasAudio: true }, 2),
    mediaLibrary.cleanAsset({ id: 3, path: '/tmp/zebra-2.png', name: 'zebra 2.png', kind: 'image', duration: 3 }, 3),
  ];
  assert.strictEqual(assets[1].kind, 'audio');
  assert.deepStrictEqual(mediaLibrary.visibleAssets(assets, { query: 'zebra', sort: 'name' }).map((asset) => asset.id), [3, 1]);
  assert.deepStrictEqual(mediaLibrary.visibleAssets(assets, { kind: 'audio' }).map((asset) => asset.id), [2]);
  assert.deepStrictEqual(mediaLibrary.visibleAssets(assets, { sort: 'duration' }).map((asset) => asset.id), [2, 1, 3]);
  assert.strictEqual(mediaLibrary.cleanAsset({ path: '/tmp/legacy.wav', kind: 'video' }, 9).kind, 'audio');
  assert.strictEqual(mediaLibrary.cleanAsset({ path: '/tmp/legacy.jpg', kind: 'bad' }, 10).kind, 'image');
});

console.log('\n' + passed + ' passed');
