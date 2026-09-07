'use strict';

const assert = require('assert');
const cache = require('../src/cache-utils');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('cache-utils:');

ok('creates stable cache filenames with the requested extension', () => {
  const key = '/projects/shared/path/video-a.mp4:123:456';
  const first = cache.cacheFileName(key, '.jpg');
  assert.strictEqual(first, cache.cacheFileName(key, '.jpg'));
  assert.match(first, /^[a-f0-9]{64}\.jpg$/);
});

ok('keeps similar media paths collision-free', () => {
  const prefix = '/projects/shared/very-long-directory-name/';
  const first = cache.cacheFileName(prefix + 'video-a.mp4:123:456', '.mp4');
  const second = cache.cacheFileName(prefix + 'video-b.mp4:123:456', '.mp4');
  assert.notStrictEqual(first, second);
});

console.log('\n' + passed + ' passed');
