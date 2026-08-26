'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/project-store');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('project-store:');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclip-project-'));
const file = path.join(dir, 'edit.miniclip');
const state = { clips: [], texts: [], overlays: [], bgm: null, originalVolume: 1, bgmVolume: 0.5, aspect: '16:9', fillMode: 'pad' };

ok('writes and reads a .miniclip document', () => {
  assert.strictEqual(store.writeProject(file, state), file);
  const loaded = store.readProject(file);
  assert.strictEqual(loaded.path, file);
  assert.strictEqual(loaded.state.aspect, '16:9');
});

ok('refuses non-project extensions', () => {
  assert.throws(() => store.writeProject(path.join(dir, 'edit.json'), state));
  assert.throws(() => store.readProject(path.join(dir, 'edit.json')));
});

ok('recovery parse failures are non-fatal', () => {
  const recovery = path.join(dir, 'recovery.miniclip');
  fs.writeFileSync(recovery, 'not json');
  assert.strictEqual(store.readRecovery(recovery), null);
});

ok('packages referenced media and reopens their relative paths', () => {
  const sources = path.join(dir, 'sources');
  const destination = path.join(dir, 'deliverables');
  fs.mkdirSync(sources);
  const video = path.join(sources, 'clip.mp4');
  const lut = path.join(sources, 'look.cube');
  const image = path.join(sources, 'logo.png');
  const audio = path.join(sources, 'voice.wav');
  const music = path.join(sources, 'music.mp3');
  [video, lut, image, audio, music].forEach((source) => fs.writeFileSync(source, path.basename(source)));

  const result = store.packageProject(destination, {
    clips: [{ id: 1, path: video, name: 'clip.mp4', sourceDuration: 5, trimStart: 0, trimEnd: 5, color: { lutPath: lut } }],
    texts: [],
    overlays: [{ id: 2, path: image, name: 'logo.png', kind: 'image', start: 0, end: 2 }],
    brolls: [], videoTracks: [], audioTracks: [{ id: 3, path: audio, name: 'voice.wav', start: 0, end: 2 }],
    bgm: { path: music, name: 'music.mp3' },
  }, 'Portable');

  assert.strictEqual(result.mediaCount, 5);
  assert.ok(fs.existsSync(result.projectPath));
  assert.strictEqual(fs.readFileSync(path.join(result.root, 'media', 'clip.mp4'), 'utf8'), 'clip.mp4');
  const raw = JSON.parse(fs.readFileSync(result.projectPath, 'utf8'));
  assert.strictEqual(raw.state.clips[0].path, path.join('media', 'clip.mp4'));
  assert.strictEqual(raw.state.clips[0].color.lutPath, path.join('media', 'look.cube'));

  const reopened = store.readProject(result.projectPath);
  assert.strictEqual(reopened.state.clips[0].path, path.join(result.root, 'media', 'clip.mp4'));
  assert.strictEqual(reopened.state.clips[0].color.lutPath, path.join(result.root, 'media', 'look.cube'));
  assert.strictEqual(reopened.state.overlays[0].path, path.join(result.root, 'media', 'logo.png'));
  assert.strictEqual(reopened.state.audioTracks[0].path, path.join(result.root, 'media', 'voice.wav'));
  assert.strictEqual(reopened.state.bgm.path, path.join(result.root, 'media', 'music.mp3'));
});

ok('creates a distinct package folder instead of overwriting an existing package', () => {
  const source = path.join(dir, 'another.mp4');
  fs.writeFileSync(source, 'another');
  const destination = path.join(dir, 'repeat-deliverables');
  const state = { clips: [{ id: 1, path: source, sourceDuration: 1, trimStart: 0, trimEnd: 1 }], texts: [], overlays: [], brolls: [], audioTracks: [] };
  const first = store.packageProject(destination, state, 'Repeat');
  const second = store.packageProject(destination, state, 'Repeat');
  assert.ok(first.root.endsWith(path.join('repeat-deliverables', 'Repeat')));
  assert.ok(second.root.endsWith(path.join('repeat-deliverables', 'Repeat-2')));
  assert.strictEqual(fs.readFileSync(path.join(first.root, 'media', 'another.mp4'), 'utf8'), 'another');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + passed + ' passed');
